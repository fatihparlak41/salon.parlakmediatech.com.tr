-- Phase 2D.1 — reschedule-preview self-conflict fix.
--
-- public.check_appointment_availability (20260822091500, fixed for the
-- ambiguous-column bug in 20260822093000) checks a staff member's
-- appointment_items for any overlap — including the very item(s)
-- belonging to the appointment currently being rescheduled, since those
-- rows are still in the table until reschedule_appointment actually
-- commits. Every reschedule preview therefore always reported AP012
-- against its own unchanged slot. Acceptable as a known limitation in
-- Phase 2D; not acceptable going into the Phase 2E calendar UX.
--
-- Adds an OPTIONAL p_exclude_appointment_id — when supplied, overlap
-- rows belonging to that appointment are ignored for this advisory
-- check only. The caller-supplied id is never trusted blindly: it is
-- looked up scoped to p_tenant_id, and if it does not resolve (wrong
-- tenant, forged, deleted, random uuid), it is silently treated as "no
-- exclusion" rather than raising — a bad exclusion id should degrade to
-- a normal availability check, not fail the whole preview or, worse,
-- suppress a real conflict. appointments.view is still required first,
-- unchanged position. This is advisory only, same as the rest of this
-- function: the exclusion constraint backing create_appointment/
-- reschedule_appointment's actual insert is untouched and remains the
-- sole race-condition-safe authority — this migration does not touch
-- private.create_appointment, private.reschedule_appointment, or
-- private.validate_and_insert_appointment_item.
--
-- Adding a parameter changes the function's argument list, so
-- CREATE OR REPLACE would create a second, ambiguous overload rather
-- than replace the existing one — explicitly drop the old 5-arg
-- signature first, matching this codebase's established signature-
-- change convention (fresh grants required; ACLs do not carry over
-- across a dropped/recreated signature).
drop function if exists public.check_appointment_availability(uuid, uuid, uuid, uuid, timestamptz);

create function public.check_appointment_availability(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_staff_member_id uuid,
  p_service_id uuid,
  p_scheduled_start_at timestamptz,
  p_exclude_appointment_id uuid default null
)
returns table (
  is_available boolean,
  reason text,
  scheduled_end_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_service record;
  v_staff_member record;
  v_end timestamptz;
  v_verified_exclude_id uuid;
begin
  if not private.has_permission(p_tenant_id, 'appointments.view') then
    raise exception 'appointments.view required' using errcode = 'AP002';
  end if;

  if p_exclude_appointment_id is not null then
    select id into v_verified_exclude_id
    from public.appointments
    where id = p_exclude_appointment_id and tenant_id = p_tenant_id;
    -- Not found (wrong tenant / forged / deleted) -> v_verified_exclude_id
    -- stays null -> the overlap check below excludes nothing extra.
  end if;

  select * into v_service
  from public.services
  where id = p_service_id and tenant_id = p_tenant_id and status = 'active' and deleted_at is null;
  if not found then
    return query select false, 'AP006'::text, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.service_branches where service_id = v_service.id and branch_id = p_branch_id
  ) then
    return query select false, 'AP007'::text, null::timestamptz;
    return;
  end if;

  select * into v_staff_member
  from public.staff_members
  where id = p_staff_member_id and tenant_id = p_tenant_id and status = 'active' and deleted_at is null;
  if not found then
    return query select false, 'AP008'::text, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.staff_branches where staff_member_id = v_staff_member.id and branch_id = p_branch_id
  ) then
    return query select false, 'AP009'::text, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.staff_services where staff_member_id = v_staff_member.id and service_id = v_service.id
  ) then
    return query select false, 'AP010'::text, null::timestamptz;
    return;
  end if;

  v_end := p_scheduled_start_at + (v_service.duration_minutes || ' minutes')::interval;

  if not private.staff_is_available(p_tenant_id, p_branch_id, v_staff_member.id, p_scheduled_start_at, v_end) then
    return query select false, 'AP011'::text, v_end;
    return;
  end if;

  -- staff_is_available deliberately only checks working hours/exceptions,
  -- never a conflicting appointment (see its own comment) — the
  -- exclusion constraint is what actually enforces that at insert time.
  -- This mirrors that same check here, advisory only. Items belonging to
  -- v_verified_exclude_id (the appointment currently being rescheduled,
  -- once tenant-verified above) are ignored; every other appointment
  -- still blocks the slot normally.
  if exists (
    select 1 from public.appointment_items ai
    where ai.staff_member_id = v_staff_member.id
      and ai.appointment_status not in ('cancelled', 'no_show')
      and (v_verified_exclude_id is null or ai.appointment_id != v_verified_exclude_id)
      and tstzrange(ai.scheduled_start_at, ai.scheduled_end_at) && tstzrange(p_scheduled_start_at, v_end)
  ) then
    return query select false, 'AP012'::text, v_end;
    return;
  end if;

  return query select true, null::text, v_end;
end;
$$;

comment on function public.check_appointment_availability(uuid, uuid, uuid, uuid, timestamptz, uuid) is
  'Advisory only — the create_appointment/reschedule_appointment exclusion-constraint-backed insert is the sole race-condition-safe authority. reason reuses the AP0nn codes from 20260822090000. appointments.view required. p_exclude_appointment_id (optional, tenant-verified, silently ignored if invalid) lets a reschedule preview ignore its own current slot. No anon access; Phase 2F public booking needs its own separately-designed availability boundary, not this endpoint widened.';

revoke execute on function public.check_appointment_availability(uuid, uuid, uuid, uuid, timestamptz, uuid) from public;
grant execute on function public.check_appointment_availability(uuid, uuid, uuid, uuid, timestamptz, uuid) to authenticated;
