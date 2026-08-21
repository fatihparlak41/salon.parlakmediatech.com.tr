-- Phase 2D — error mapping domain gap, closed forward.
--
-- Every business-rule rejection in create_appointment/reschedule_appointment/
-- validate_and_insert_appointment_item/update_appointment_status
-- (20260819052733, 20260819060500, 20260819062000) uses a plain
-- `raise exception 'text'` with no explicit ERRCODE — all 15 distinct
-- failure modes therefore arrive at the client as the same generic
-- SQLSTATE P0001, distinguishable only by parsing free-text English
-- messages (some with interpolated names, making exact matching
-- impossible without regex). Phase 2D's UI genuinely needs to tell an
-- operator SPECIFICALLY why a save failed (occupied slot vs. wrong
-- branch vs. permission vs. terminal-status edit), which a single opaque
-- code cannot support safely.
--
-- This adds `using errcode = 'APnnn'` to each existing raise — the
-- message text, validation order, and all business logic are byte-for-
-- byte unchanged; this is not the appointment engine being rewritten,
-- only its existing failures being made machine-distinguishable.
-- Verified directly against DEV beforehand that a custom, non-standard
-- SQLSTATE (outside Postgres's own reserved classes — 'AP' does not
-- collide with any built-in class) round-trips correctly to
-- error.code on the client, the same way '23505'/'23P01'/'42501' already
-- do elsewhere in this codebase.
--
-- Code catalog (see lib/modules/appointments/error-codes.ts for the
-- application-side Turkish mapping):
--   AP001 authentication required
--   AP002 permission denied (appointments.create/update/cancel)
--   AP003 branch not found in this tenant
--   AP004 customer not found in this tenant
--   AP005 at least one appointment item is required
--   AP006 service not found or inactive
--   AP007 service not offered at this branch
--   AP008 staff member not found or inactive
--   AP009 staff member does not work at this branch
--   AP010 staff member not eligible for this service
--   AP011 staff member not available at the requested time
--   AP012 overlapping booking (race-condition guard)
--   AP013 appointment not found
--   AP014 appointment is in a terminal state (completed/cancelled)
--   AP015 invalid target status requested
--
-- Do not edit 20260819052733/20260819060500/20260819062000 — already
-- applied; this corrects forward, same signatures, no grant changes
-- needed (CREATE OR REPLACE with an identical signature preserves ACLs).

create or replace function private.create_appointment(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_notes text default null,
  p_source text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment_id uuid;
  v_item jsonb;
  v_item_result private.appointment_item_result;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_min_start timestamptz;
  v_max_end timestamptz;
  v_sequence integer := 0;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AP001';
  end if;

  if not private.has_permission(p_tenant_id, 'appointments.create') then
    raise exception 'appointments.create required' using errcode = 'AP002';
  end if;

  if not exists (
    select 1 from public.branches
    where id = p_branch_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'branch not found in this tenant' using errcode = 'AP003';
  end if;

  if not exists (
    select 1 from public.customers
    where id = p_customer_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'customer not found in this tenant' using errcode = 'AP004';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'at least one appointment item is required' using errcode = 'AP005';
  end if;

  select
    min((item ->> 'scheduled_start_at')::timestamptz),
    max((item ->> 'scheduled_start_at')::timestamptz + (s.duration_minutes || ' minutes')::interval)
  into v_range_start, v_range_end
  from jsonb_array_elements(p_items) as item
  left join public.services s
    on s.id = (item ->> 'service_id')::uuid
    and s.tenant_id = p_tenant_id
    and s.status = 'active'
    and s.deleted_at is null;

  if v_range_start is null or v_range_end is null then
    raise exception 'one or more services not found or inactive in this tenant' using errcode = 'AP006';
  end if;

  insert into public.appointments (
    tenant_id, branch_id, customer_id, notes, source,
    scheduled_start_at, scheduled_end_at, created_by
  )
  values (
    p_tenant_id, p_branch_id, p_customer_id, p_notes, p_source,
    v_range_start, v_range_end, auth.uid()
  )
  returning id into v_appointment_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_sequence := v_sequence + 1;
    v_item_result := private.validate_and_insert_appointment_item(
      p_tenant_id, p_branch_id, v_appointment_id, v_item,
      coalesce((v_item ->> 'sequence')::integer, v_sequence)
    );
    v_min_start := least(coalesce(v_min_start, v_item_result.scheduled_start_at), v_item_result.scheduled_start_at);
    v_max_end := greatest(coalesce(v_max_end, v_item_result.scheduled_end_at), v_item_result.scheduled_end_at);
  end loop;

  update public.appointments
  set scheduled_start_at = v_min_start, scheduled_end_at = v_max_end
  where id = v_appointment_id;

  perform private.log_audit_event(
    p_tenant_id, 'appointment.created', 'appointment', v_appointment_id,
    null, jsonb_build_object('customer_id', p_customer_id, 'items', p_items)
  );

  return v_appointment_id;
end;
$$;

create or replace function private.validate_and_insert_appointment_item(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_appointment_id uuid,
  p_item jsonb,
  p_sequence integer
)
returns private.appointment_item_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service record;
  v_staff_member record;
  v_start timestamptz;
  v_end timestamptz;
  v_result private.appointment_item_result;
begin
  select * into v_service
  from public.services
  where id = (p_item ->> 'service_id')::uuid
    and tenant_id = p_tenant_id
    and status = 'active'
    and deleted_at is null;

  if not found then
    raise exception 'service not found or inactive in this tenant' using errcode = 'AP006';
  end if;

  if not exists (
    select 1 from public.service_branches
    where service_id = v_service.id and branch_id = p_branch_id
  ) then
    raise exception 'service "%" is not offered at this branch', v_service.name using errcode = 'AP007';
  end if;

  select * into v_staff_member
  from public.staff_members
  where id = (p_item ->> 'staff_member_id')::uuid
    and tenant_id = p_tenant_id
    and status = 'active'
    and deleted_at is null;

  if not found then
    raise exception 'staff member not found or inactive in this tenant' using errcode = 'AP008';
  end if;

  if not exists (
    select 1 from public.staff_branches
    where staff_member_id = v_staff_member.id and branch_id = p_branch_id
  ) then
    raise exception 'staff member "%" does not work at this branch', v_staff_member.full_name using errcode = 'AP009';
  end if;

  if not exists (
    select 1 from public.staff_services
    where staff_member_id = v_staff_member.id and service_id = v_service.id
  ) then
    raise exception 'staff member "%" is not eligible for service "%"', v_staff_member.full_name, v_service.name using errcode = 'AP010';
  end if;

  v_start := (p_item ->> 'scheduled_start_at')::timestamptz;
  v_end := v_start + (v_service.duration_minutes || ' minutes')::interval;

  if not private.staff_is_available(p_tenant_id, p_branch_id, v_staff_member.id, v_start, v_end) then
    raise exception 'staff member "%" is not working at the requested time', v_staff_member.full_name using errcode = 'AP011';
  end if;

  begin
    insert into public.appointment_items (
      tenant_id, appointment_id, service_id, staff_member_id,
      scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence
    )
    values (
      p_tenant_id, p_appointment_id, v_service.id, v_staff_member.id,
      v_start, v_end, v_service.duration_minutes, v_service.price, p_sequence
    );
  exception
    when exclusion_violation then
      raise exception 'staff member "%" was just booked for an overlapping time by another request', v_staff_member.full_name using errcode = 'AP012';
  end;

  v_result.scheduled_start_at := v_start;
  v_result.scheduled_end_at := v_end;
  return v_result;
end;
$$;

create or replace function private.reschedule_appointment(
  p_appointment_id uuid,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_branch_id uuid;
  v_status text;
  v_item jsonb;
  v_item_result private.appointment_item_result;
  v_min_start timestamptz;
  v_max_end timestamptz;
  v_sequence integer := 0;
  v_before jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AP001';
  end if;

  select tenant_id, branch_id, status into v_tenant_id, v_branch_id, v_status
  from public.appointments
  where id = p_appointment_id;

  if v_tenant_id is null then
    raise exception 'appointment not found' using errcode = 'AP013';
  end if;

  if v_status in ('completed', 'cancelled') then
    raise exception 'cannot reschedule a % appointment', v_status using errcode = 'AP014';
  end if;

  if not private.has_permission(v_tenant_id, 'appointments.update') then
    raise exception 'appointments.update required' using errcode = 'AP002';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'at least one appointment item is required' using errcode = 'AP005';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'service_id', service_id, 'staff_member_id', staff_member_id,
    'scheduled_start_at', scheduled_start_at, 'sequence', sequence
  )), '[]'::jsonb) into v_before
  from public.appointment_items
  where appointment_id = p_appointment_id;

  delete from public.appointment_items where appointment_id = p_appointment_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_sequence := v_sequence + 1;
    v_item_result := private.validate_and_insert_appointment_item(
      v_tenant_id, v_branch_id, p_appointment_id, v_item,
      coalesce((v_item ->> 'sequence')::integer, v_sequence)
    );
    v_min_start := least(coalesce(v_min_start, v_item_result.scheduled_start_at), v_item_result.scheduled_start_at);
    v_max_end := greatest(coalesce(v_max_end, v_item_result.scheduled_end_at), v_item_result.scheduled_end_at);
  end loop;

  update public.appointments
  set scheduled_start_at = v_min_start, scheduled_end_at = v_max_end
  where id = p_appointment_id;

  perform private.log_audit_event(
    v_tenant_id, 'appointment.rescheduled', 'appointment', p_appointment_id,
    jsonb_build_object('items', v_before), jsonb_build_object('items', p_items)
  );
end;
$$;

create or replace function private.update_appointment_status(
  p_appointment_id uuid,
  p_new_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_old_status text;
  v_required_permission text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AP001';
  end if;

  if p_new_status not in ('confirmed', 'in_progress', 'completed', 'cancelled', 'no_show') then
    raise exception 'invalid target status: %', p_new_status using errcode = 'AP015';
  end if;

  select tenant_id, status into v_tenant_id, v_old_status
  from public.appointments
  where id = p_appointment_id;

  if v_tenant_id is null then
    raise exception 'appointment not found' using errcode = 'AP013';
  end if;

  if v_old_status in ('completed', 'cancelled') then
    raise exception 'cannot change status of a % appointment', v_old_status using errcode = 'AP014';
  end if;

  v_required_permission := case
    when p_new_status = 'cancelled' then 'appointments.cancel'
    else 'appointments.update'
  end;

  if not private.has_permission(v_tenant_id, v_required_permission) then
    raise exception '% required', v_required_permission using errcode = 'AP002';
  end if;

  update public.appointments
  set status = p_new_status
  where id = p_appointment_id;

  perform private.log_audit_event(
    v_tenant_id,
    case when p_new_status = 'cancelled' then 'appointment.cancelled' else 'appointment.status_changed' end,
    'appointment', p_appointment_id,
    jsonb_build_object('status', v_old_status),
    jsonb_build_object('status', p_new_status)
  );
end;
$$;
