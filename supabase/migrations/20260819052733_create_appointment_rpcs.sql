-- Phase 2A: the only paths that create, reschedule, or change the status
-- of an appointment. Same shape as the permission-ceiling RPCs
-- (20260816090003): private.* does the real work (plpgsql, security
-- definer, search_path=''), a thin public.* wrapper is the only
-- client-callable surface, both revoked from PUBLIC and granted only to
-- authenticated.

-- Working-hours check: exceptions (staff_schedule_exceptions) win over
-- the recurring weekly schedule (staff_schedules) for their date. All
-- comparison happens in the tenant's own timezone — appointments are
-- stored as UTC timestamptz, but "is this staff member working" is a
-- tenant-local-calendar question. An item that would cross midnight in
-- tenant-local time is rejected outright — no salon service legitimately
-- spans two calendar days.
create or replace function private.staff_is_available(
  p_tenant_id uuid,
  p_staff_member_id uuid,
  p_scheduled_start_at timestamptz,
  p_scheduled_end_at timestamptz
)
returns boolean
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_tz text;
  v_local_date date;
  v_local_start time;
  v_local_end time;
  v_weekday smallint;
  v_exception record;
begin
  select timezone into v_tz from public.tenants where id = p_tenant_id;
  if v_tz is null then
    return false;
  end if;

  v_local_date := (p_scheduled_start_at at time zone v_tz)::date;
  v_local_start := (p_scheduled_start_at at time zone v_tz)::time;
  v_local_end := (p_scheduled_end_at at time zone v_tz)::time;

  if (p_scheduled_end_at at time zone v_tz)::date <> v_local_date then
    return false;
  end if;

  v_weekday := extract(dow from p_scheduled_start_at at time zone v_tz);

  select * into v_exception
  from public.staff_schedule_exceptions
  where staff_member_id = p_staff_member_id
    and exception_date = v_local_date
    and deleted_at is null;

  if found then
    if v_exception.type = 'unavailable' then
      return false;
    end if;
    return v_local_start >= v_exception.start_time and v_local_end <= v_exception.end_time;
  end if;

  return exists (
    select 1
    from public.staff_schedules
    where staff_member_id = p_staff_member_id
      and weekday = v_weekday
      and deleted_at is null
      and v_local_start >= start_time
      and v_local_end <= end_time
  );
end;
$$;

comment on function private.staff_is_available(uuid, uuid, timestamptz, timestamptz) is
  'Working-hours check only — does NOT check for a conflicting appointment. That is enforced separately (and unconditionally, race-condition-safe) by appointment_items_no_staff_overlap. This function answers "is this staff member scheduled to work then", not "is this exact slot free".';

-- Shared per-item validation + insert used by both create_appointment and
-- reschedule_appointment, so the eligibility/working-hours/conflict
-- checks exist in exactly one place.
create type private.appointment_item_result as (
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz
);

create or replace function private.validate_and_insert_appointment_item(
  p_tenant_id uuid,
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
    raise exception 'service not found or inactive in this tenant';
  end if;

  select * into v_staff_member
  from public.staff_members
  where id = (p_item ->> 'staff_member_id')::uuid
    and tenant_id = p_tenant_id
    and status = 'active'
    and deleted_at is null;

  if not found then
    raise exception 'staff member not found or inactive in this tenant';
  end if;

  if not exists (
    select 1 from public.staff_services
    where staff_member_id = v_staff_member.id and service_id = v_service.id
  ) then
    raise exception 'staff member "%" is not eligible for service "%"', v_staff_member.full_name, v_service.name;
  end if;

  v_start := (p_item ->> 'scheduled_start_at')::timestamptz;
  v_end := v_start + (v_service.duration_minutes || ' minutes')::interval;

  if not private.staff_is_available(p_tenant_id, v_staff_member.id, v_start, v_end) then
    raise exception 'staff member "%" is not working at the requested time', v_staff_member.full_name;
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
      -- The actual race-condition guard: two concurrent requests can
      -- both pass staff_is_available (a plain read) and then both try to
      -- insert — Postgres allows exactly one of the two INSERTs to
      -- succeed. This turns that raw constraint error into a clean,
      -- expected-shape exception instead of leaking a Postgres
      -- constraint name to the caller.
      raise exception 'staff member "%" was just booked for an overlapping time by another request', v_staff_member.full_name;
  end;

  v_result.scheduled_start_at := v_start;
  v_result.scheduled_end_at := v_end;
  return v_result;
end;
$$;

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
  v_min_start timestamptz;
  v_max_end timestamptz;
  v_sequence integer := 0;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not private.has_permission(p_tenant_id, 'appointments.create') then
    raise exception 'appointments.create required';
  end if;

  if not exists (
    select 1 from public.branches
    where id = p_branch_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'branch not found in this tenant';
  end if;

  if not exists (
    select 1 from public.customers
    where id = p_customer_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'customer not found in this tenant';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'at least one appointment item is required';
  end if;

  -- Placeholder times, corrected below once every item is known —
  -- nothing reads this row until this function returns (no grant lets a
  -- client see a half-built appointment mid-transaction anyway).
  insert into public.appointments (
    tenant_id, branch_id, customer_id, notes, source,
    scheduled_start_at, scheduled_end_at, created_by
  )
  values (
    p_tenant_id, p_branch_id, p_customer_id, p_notes, p_source,
    now(), now(), auth.uid()
  )
  returning id into v_appointment_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_sequence := v_sequence + 1;
    v_item_result := private.validate_and_insert_appointment_item(
      p_tenant_id, v_appointment_id, v_item,
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

comment on function private.create_appointment(uuid, uuid, uuid, jsonb, text, text) is
  'p_items: jsonb array of {service_id, staff_member_id, scheduled_start_at, sequence?}. Validates tenant/branch/customer/eligibility/working-hours per item; the actual no-double-booking guarantee is appointment_items_no_staff_overlap (an exclusion constraint), not this function''s own logic.';

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
  v_status text;
  v_item jsonb;
  v_item_result private.appointment_item_result;
  v_min_start timestamptz;
  v_max_end timestamptz;
  v_sequence integer := 0;
  v_before jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select tenant_id, status into v_tenant_id, v_status
  from public.appointments
  where id = p_appointment_id;

  if v_tenant_id is null then
    raise exception 'appointment not found';
  end if;

  if v_status in ('completed', 'cancelled') then
    raise exception 'cannot reschedule a % appointment', v_status;
  end if;

  if not private.has_permission(v_tenant_id, 'appointments.update') then
    raise exception 'appointments.update required';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'at least one appointment item is required';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'service_id', service_id, 'staff_member_id', staff_member_id,
    'scheduled_start_at', scheduled_start_at, 'sequence', sequence
  )), '[]'::jsonb) into v_before
  from public.appointment_items
  where appointment_id = p_appointment_id;

  -- Full replace, same semantics as update_role_permissions
  -- (20260816090003) — the caller always sends the complete desired item
  -- list, not a diff. Cascade-free delete: appointment_items has no
  -- children of its own.
  delete from public.appointment_items where appointment_id = p_appointment_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_sequence := v_sequence + 1;
    v_item_result := private.validate_and_insert_appointment_item(
      v_tenant_id, p_appointment_id, v_item,
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
    raise exception 'authentication required';
  end if;

  if p_new_status not in ('confirmed', 'in_progress', 'completed', 'cancelled', 'no_show') then
    raise exception 'invalid target status: %', p_new_status;
  end if;

  select tenant_id, status into v_tenant_id, v_old_status
  from public.appointments
  where id = p_appointment_id;

  if v_tenant_id is null then
    raise exception 'appointment not found';
  end if;

  if v_old_status in ('completed', 'cancelled') then
    raise exception 'cannot change status of a % appointment', v_old_status;
  end if;

  v_required_permission := case
    when p_new_status = 'cancelled' then 'appointments.cancel'
    else 'appointments.update'
  end;

  if not private.has_permission(v_tenant_id, v_required_permission) then
    raise exception '% required', v_required_permission;
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

comment on function private.update_appointment_status(uuid, text) is
  'Status-only transition (confirm/start/complete/cancel/no_show) — cancelling here is what actually frees the staff slot, via the sync_appointment_item_status trigger updating appointment_items.appointment_status, which the overlap exclusion constraint reads.';

revoke execute on function private.staff_is_available(uuid, uuid, timestamptz, timestamptz) from public;
revoke execute on function private.validate_and_insert_appointment_item(uuid, uuid, jsonb, integer) from public;
revoke execute on function private.create_appointment(uuid, uuid, uuid, jsonb, text, text) from public;
revoke execute on function private.reschedule_appointment(uuid, jsonb) from public;
revoke execute on function private.update_appointment_status(uuid, text) from public;

create or replace function public.create_appointment(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_notes text default null,
  p_source text default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.create_appointment(p_tenant_id, p_branch_id, p_customer_id, p_items, p_notes, p_source);
$$;

create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_items jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.reschedule_appointment(p_appointment_id, p_items);
$$;

create or replace function public.update_appointment_status(
  p_appointment_id uuid,
  p_new_status text
)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.update_appointment_status(p_appointment_id, p_new_status);
$$;

revoke execute on function public.create_appointment(uuid, uuid, uuid, jsonb, text, text) from public;
revoke execute on function public.reschedule_appointment(uuid, jsonb) from public;
revoke execute on function public.update_appointment_status(uuid, text) from public;

grant execute on function public.create_appointment(uuid, uuid, uuid, jsonb, text, text) to authenticated;
grant execute on function public.reschedule_appointment(uuid, jsonb) to authenticated;
grant execute on function public.update_appointment_status(uuid, text) to authenticated;
