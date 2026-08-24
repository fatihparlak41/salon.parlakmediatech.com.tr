-- Faz 2G.2B — customer self-service reschedule (Option B: move every
-- item by one uniform delta, nothing else changes), plus the mandatory
-- pre-refactor finding from section 1 of the architecture review:
--
-- ===================================================================
-- SNAPSHOT INVARIANT — CONFIRMED PRE-EXISTING BUG, FIXED HERE
-- ===================================================================
-- private.validate_and_insert_appointment_item (20260822090000, the
-- current true body) always writes duration_minutes/price from the
-- LIVE public.services row it just looked up:
--   values (..., v_service.duration_minutes, v_service.price, ...)
-- create_appointment/create_guest_booking calling this for a BRAND NEW
-- item is correct — a new booking should get current pricing. But
-- private.reschedule_appointment (staff) deletes every existing item
-- and re-inserts through this SAME function for EVERY item, including
-- ones whose service/staff genuinely did not change — meaning ANY staff
-- reschedule today silently reprices/redurations the appointment to
-- whatever the service catalog currently says, even when nothing about
-- the booked service was touched. Confirmed by reading the function
-- body directly, not inferred: there is no snapshot-preservation logic
-- anywhere in the reschedule path today.
--
-- Fix: validate_and_insert_appointment_item now reads OPTIONAL
-- duration_minutes/price keys off the item jsonb itself — present means
-- "preserve this exact snapshot", absent (the only case
-- create_appointment/create_guest_booking ever produce, since they never
-- set these keys) means "use the service's current live price/duration",
-- byte-for-byte the existing behavior for every pre-existing caller.
-- Same signature, CREATE OR REPLACE, no grant changes.
--
-- The two reschedule callers decide, per item, whether to pass a
-- snapshot: staff reschedule carries the OLD duration/price forward only
-- when the new item's service_id matches what was there before at the
-- same sequence (a genuine service swap correctly gets fresh pricing);
-- customer reschedule NEVER changes service/staff, so every item always
-- carries its snapshot forward unconditionally.
--
-- ===================================================================
-- SHARED REPLACE CORE
-- ===================================================================
-- private.replace_appointment_items(...) is the delete-all/validate/
-- reinsert/recompute-header-range mechanics extracted verbatim from
-- reschedule_appointment's existing body — one authoritative engine,
-- used by staff reschedule_appointment AND the new customer
-- reschedule_my_appointment. A failure on ANY item raises (propagating
-- the caller's AP0nn code unchanged) and aborts the whole function-call
-- transaction — Postgres rolls back the DELETE along with every partial
-- INSERT, so the original items are never left partially replaced.
--
-- ===================================================================
-- ROW-LOCK HARDENING (sections 4-6)
-- ===================================================================
-- reschedule_appointment and update_appointment_status both currently
-- read the appointment header with a plain SELECT, decide, then UPDATE
-- — no lock. Both now SELECT ... FOR UPDATE first (matching
-- cancel_my_appointment's existing 2G.2A pattern) so every appointment-
-- level mutation in this system — staff reschedule, staff status
-- change, customer cancel, customer reschedule — serializes on the same
-- appointment header row. Business logic, permission checks, and AP0nn
-- codes are otherwise byte-for-byte unchanged.

-- =====================================================================
-- validate_and_insert_appointment_item — snapshot-preservation fix.
-- =====================================================================
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
  v_duration integer;
  v_price numeric;
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
  -- Faz 2G.2B: explicit duration_minutes/price on the item jsonb means
  -- "preserve this exact snapshot" — omitted (create_appointment,
  -- create_guest_booking, and any reschedule item whose service
  -- genuinely changed) means "use the service's current live values",
  -- exactly the pre-existing behavior.
  v_duration := coalesce((p_item ->> 'duration_minutes')::integer, v_service.duration_minutes);
  v_price := coalesce((p_item ->> 'price')::numeric, v_service.price);
  v_end := v_start + (v_duration || ' minutes')::interval;

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
      v_start, v_end, v_duration, v_price, p_sequence
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

-- =====================================================================
-- Shared replace core — new. delete-all/validate/reinsert/recompute-
-- range, extracted verbatim from reschedule_appointment's own existing
-- loop. Callers are responsible for locking the appointment header and
-- deciding per-item snapshot preservation BEFORE calling this — this
-- function trusts p_items completely, exactly like
-- validate_and_insert_appointment_item already trusts its own caller.
-- =====================================================================
create function private.replace_appointment_items(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_appointment_id uuid,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_item_result private.appointment_item_result;
  v_min_start timestamptz;
  v_max_end timestamptz;
  v_sequence integer := 0;
begin
  delete from public.appointment_items where appointment_id = p_appointment_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_sequence := v_sequence + 1;
    v_item_result := private.validate_and_insert_appointment_item(
      p_tenant_id, p_branch_id, p_appointment_id, v_item,
      coalesce((v_item ->> 'sequence')::integer, v_sequence)
    );
    v_min_start := least(coalesce(v_min_start, v_item_result.scheduled_start_at), v_item_result.scheduled_start_at);
    v_max_end := greatest(coalesce(v_max_end, v_item_result.scheduled_end_at), v_item_result.scheduled_end_at);
  end loop;

  update public.appointments
  set scheduled_start_at = v_min_start, scheduled_end_at = v_max_end
  where id = p_appointment_id;
end;
$$;

revoke execute on function private.replace_appointment_items(uuid, uuid, uuid, jsonb) from public;

-- =====================================================================
-- reschedule_appointment (staff) — same signature, CREATE OR REPLACE.
-- Adds: FOR UPDATE row lock (section 5), snapshot-preserving merge
-- against the locked row's current items (matched by sequence +
-- unchanged service_id), delegates the mechanical work to
-- replace_appointment_items. AP001/AP002/AP005/AP013/AP014 unchanged.
-- =====================================================================
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
  v_before jsonb;
  v_merged_items jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AP001';
  end if;

  select tenant_id, branch_id, status into v_tenant_id, v_branch_id, v_status
  from public.appointments
  where id = p_appointment_id
  for update;

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
    'scheduled_start_at', scheduled_start_at, 'sequence', sequence,
    'duration_minutes', duration_minutes, 'price', price
  )), '[]'::jsonb) into v_before
  from public.appointment_items
  where appointment_id = p_appointment_id;

  -- Snapshot-preserving merge: an incoming item whose service_id matches
  -- the OLD item at the same sequence carries that old item's
  -- duration_minutes/price forward explicitly; anything else (a new
  -- item, or a deliberate service swap) is left as the caller sent it,
  -- so validate_and_insert_appointment_item falls back to current
  -- catalog pricing for it — a real edit, not just a time move.
  select coalesce(jsonb_agg(
    case
      when old_item.elem is not null and (old_item.elem ->> 'service_id') = (new_item.elem ->> 'service_id')
        then new_item.elem || jsonb_build_object('duration_minutes', old_item.elem -> 'duration_minutes', 'price', old_item.elem -> 'price')
      else new_item.elem
    end
  ), '[]'::jsonb) into v_merged_items
  from jsonb_array_elements(p_items) as new_item(elem)
  left join jsonb_array_elements(v_before) as old_item(elem)
    on (old_item.elem ->> 'sequence')::integer = (new_item.elem ->> 'sequence')::integer;

  perform private.replace_appointment_items(v_tenant_id, v_branch_id, p_appointment_id, v_merged_items);

  perform private.log_audit_event(
    v_tenant_id, 'appointment.rescheduled', 'appointment', p_appointment_id,
    jsonb_build_object('items', v_before), jsonb_build_object('items', p_items)
  );
end;
$$;

-- =====================================================================
-- update_appointment_status (staff) — same signature, CREATE OR
-- REPLACE. Adds FOR UPDATE (section 6). Every other check/permission/
-- AP0nn code unchanged.
-- =====================================================================
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
  where id = p_appointment_id
  for update;

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

-- =====================================================================
-- reschedule_my_appointment — customer-facing mutation. auth.uid()-only
-- ownership (ALL active links), row-locked, policy/status/cutoff gated
-- against the LOCKED CURRENT start (never the requested new one — a
-- customer must not bypass the cutoff by picking a far-future target).
-- Branch/service/staff/sequence untouched; every item shifts by one
-- uniform delta and carries its duration/price snapshot forward
-- unconditionally (service/staff never change here, unlike staff
-- reschedule). AP008-AP012 from the shared replace core are translated
-- to the single customer-safe AC008 — never a raw AP code.
-- =====================================================================
create function private.reschedule_my_appointment(
  p_appointment_id uuid,
  p_new_start_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment record;
  v_tenant record;
  v_new_items jsonb;
  v_delta interval;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AC001';
  end if;

  select a.id, a.tenant_id, a.branch_id, a.customer_id, a.status, a.scheduled_start_at
  into v_appointment
  from public.appointments a
  where a.id = p_appointment_id
  for update;

  if not found then
    raise exception 'appointment not manageable' using errcode = 'AC003';
  end if;

  if not exists (
    select 1 from public.customer_account_links cal
    where cal.user_id = auth.uid()
      and cal.deleted_at is null
      and cal.customer_id = v_appointment.customer_id
  ) then
    raise exception 'appointment not manageable' using errcode = 'AC003';
  end if;

  if v_appointment.status not in ('scheduled', 'confirmed') then
    raise exception 'appointment not manageable' using errcode = 'AC003';
  end if;

  select customer_reschedule_enabled, customer_reschedule_cutoff_minutes
  into v_tenant
  from public.tenants
  where id = v_appointment.tenant_id;

  if not v_tenant.customer_reschedule_enabled then
    raise exception 'reschedule disabled' using errcode = 'AC006';
  end if;

  -- Cutoff is evaluated against the CURRENT locked start — a customer
  -- inside the cutoff window cannot escape it by requesting a far-future
  -- target instead.
  if now() > v_appointment.scheduled_start_at - (v_tenant.customer_reschedule_cutoff_minutes || ' minutes')::interval then
    raise exception 'reschedule cutoff passed' using errcode = 'AC007';
  end if;

  if p_new_start_at <= now() then
    raise exception 'requested slot unavailable' using errcode = 'AC008';
  end if;

  -- Mirrors get_public_availability_slots's own 30-day horizon literal
  -- (20260822150500) — same documented reasoning, not a shared function
  -- to query, deliberately duplicated the same way that migration's own
  -- comment explains.
  if p_new_start_at > now() + interval '30 days' then
    raise exception 'requested slot unavailable' using errcode = 'AC008';
  end if;

  v_delta := p_new_start_at - v_appointment.scheduled_start_at;

  select coalesce(jsonb_agg(jsonb_build_object(
    'service_id', service_id, 'staff_member_id', staff_member_id,
    'scheduled_start_at', scheduled_start_at + v_delta, 'sequence', sequence,
    'duration_minutes', duration_minutes, 'price', price
  )), '[]'::jsonb) into v_new_items
  from public.appointment_items
  where appointment_id = p_appointment_id;

  begin
    perform private.replace_appointment_items(v_appointment.tenant_id, v_appointment.branch_id, p_appointment_id, v_new_items);
  exception
    when others then
      if sqlstate in ('AP008', 'AP009', 'AP010', 'AP011', 'AP012') then
        raise exception 'requested slot unavailable' using errcode = 'AC008';
      else
        raise;
      end if;
  end;

  perform private.log_audit_event(
    v_appointment.tenant_id, 'appointment.rescheduled', 'appointment', p_appointment_id,
    jsonb_build_object('scheduledStartAt', v_appointment.scheduled_start_at),
    jsonb_build_object('scheduledStartAt', p_new_start_at)
  );

  return jsonb_build_object('appointmentId', p_appointment_id, 'scheduledStartAt', p_new_start_at);
end;
$$;

revoke execute on function private.reschedule_my_appointment(uuid, timestamptz) from public;

create function public.reschedule_my_appointment(
  p_appointment_id uuid,
  p_new_start_at timestamptz
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.reschedule_my_appointment(p_appointment_id, p_new_start_at);
$$;

revoke execute on function public.reschedule_my_appointment(uuid, timestamptz) from public;
revoke execute on function public.reschedule_my_appointment(uuid, timestamptz) from anon;
grant execute on function public.reschedule_my_appointment(uuid, timestamptz) to authenticated;

-- =====================================================================
-- get_my_reschedule_slots — advisory read boundary. Never raises (same
-- "no distinguishing side channel" rule as the public booking read
-- functions): any reason the appointment isn't currently
-- reschedule-eligible (not owned, wrong status, policy disabled, cutoff
-- already passed) resolves to an empty array, same as an invalid date.
-- Every one of the target appointment's CURRENT items is shifted by the
-- same candidate delta and independently revalidated — a candidate is
-- only offered when EVERY item would still be legally bookable at the
-- shifted time (section 13). The target's OWN current items are
-- excluded from the overlap check (section 14) since they will be
-- replaced, not left in place; every other appointment still blocks
-- normally. This is advisory only — the actual reschedule_my_appointment
-- call revalidates atomically and is the only authoritative decision
-- (section 15).
-- =====================================================================
create function private.get_my_reschedule_slots(
  p_appointment_id uuid,
  p_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_appointment record;
  v_tenant record;
  v_tz text;
  v_today date;
  v_horizon date;
  v_now_local timestamp;
  v_candidate_local_ts timestamp;
  v_candidate_start_utc timestamptz;
  v_delta interval;
  v_item record;
  v_shifted_start timestamptz;
  v_shifted_end timestamptz;
  v_candidate_valid boolean;
  v_result jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    return '[]'::jsonb;
  end if;

  select a.id, a.tenant_id, a.branch_id, a.customer_id, a.status, a.scheduled_start_at
  into v_appointment
  from public.appointments a
  where a.id = p_appointment_id;

  if not found then
    return '[]'::jsonb;
  end if;

  if not exists (
    select 1 from public.customer_account_links cal
    where cal.user_id = auth.uid() and cal.deleted_at is null and cal.customer_id = v_appointment.customer_id
  ) then
    return '[]'::jsonb;
  end if;

  if v_appointment.status not in ('scheduled', 'confirmed') then
    return '[]'::jsonb;
  end if;

  select customer_reschedule_enabled, customer_reschedule_cutoff_minutes, timezone
  into v_tenant
  from public.tenants
  where id = v_appointment.tenant_id;

  if not v_tenant.customer_reschedule_enabled then
    return '[]'::jsonb;
  end if;

  if now() > v_appointment.scheduled_start_at - (v_tenant.customer_reschedule_cutoff_minutes || ' minutes')::interval then
    return '[]'::jsonb;
  end if;

  v_tz := v_tenant.timezone;
  v_now_local := now() at time zone v_tz;
  v_today := v_now_local::date;
  v_horizon := v_today + 30;

  if p_date < v_today or p_date > v_horizon then
    return '[]'::jsonb;
  end if;

  v_candidate_local_ts := p_date::timestamp;
  while v_candidate_local_ts::date = p_date loop
    if v_candidate_local_ts > v_now_local then
      v_candidate_start_utc := v_candidate_local_ts at time zone v_tz;
      v_delta := v_candidate_start_utc - v_appointment.scheduled_start_at;
      v_candidate_valid := true;

      for v_item in
        select ai.staff_member_id, ai.service_id, ai.scheduled_start_at, ai.duration_minutes
        from public.appointment_items ai
        where ai.appointment_id = p_appointment_id
      loop
        v_shifted_start := v_item.scheduled_start_at + v_delta;
        v_shifted_end := v_shifted_start + (v_item.duration_minutes || ' minutes')::interval;

        if not (
          exists (
            select 1 from public.staff_members sm
            where sm.id = v_item.staff_member_id and sm.status = 'active' and sm.deleted_at is null
          )
          and exists (
            select 1 from public.staff_branches sb
            where sb.staff_member_id = v_item.staff_member_id and sb.branch_id = v_appointment.branch_id
          )
          and exists (
            select 1 from public.services s
            where s.id = v_item.service_id and s.status = 'active' and s.deleted_at is null
          )
          and exists (
            select 1 from public.service_branches svb
            where svb.service_id = v_item.service_id and svb.branch_id = v_appointment.branch_id
          )
          and exists (
            select 1 from public.staff_services ss
            where ss.staff_member_id = v_item.staff_member_id and ss.service_id = v_item.service_id
          )
          and private.staff_is_available(v_appointment.tenant_id, v_appointment.branch_id, v_item.staff_member_id, v_shifted_start, v_shifted_end)
          and not exists (
            select 1 from public.appointment_items ai2
            where ai2.staff_member_id = v_item.staff_member_id
              and ai2.appointment_id <> p_appointment_id
              and ai2.appointment_status not in ('cancelled', 'no_show')
              and tstzrange(ai2.scheduled_start_at, ai2.scheduled_end_at) && tstzrange(v_shifted_start, v_shifted_end)
          )
        ) then
          v_candidate_valid := false;
          exit;
        end if;
      end loop;

      if v_candidate_valid then
        v_result := v_result || to_jsonb(to_char(v_candidate_local_ts, 'HH24:MI'));
      end if;
    end if;

    v_candidate_local_ts := v_candidate_local_ts + interval '15 minutes';
  end loop;

  return v_result;
end;
$$;

revoke execute on function private.get_my_reschedule_slots(uuid, date) from public;

create function public.get_my_reschedule_slots(
  p_appointment_id uuid,
  p_date date
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_my_reschedule_slots(p_appointment_id, p_date);
$$;

revoke execute on function public.get_my_reschedule_slots(uuid, date) from public;
revoke execute on function public.get_my_reschedule_slots(uuid, date) from anon;
grant execute on function public.get_my_reschedule_slots(uuid, date) to authenticated;
