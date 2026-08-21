-- Phase 2D — bug fix, found by tests/phase2d-appointments-flow.test.ts.
--
-- public.check_appointment_availability (20260822091500) declares
-- `returns table (is_available boolean, reason text, scheduled_end_at
-- timestamptz)` — in PL/pgSQL those output columns become implicit
-- variables in the function body. Its own overlap-check subquery selects
-- from public.appointment_items with no table alias, and that table also
-- has a scheduled_end_at column — so `scheduled_end_at` inside
-- tstzrange(scheduled_start_at, scheduled_end_at) is ambiguous between
-- the OUT parameter and the table column. Postgres rejected every call
-- that reached this subquery with 42702 "column reference
-- \"scheduled_end_at\" is ambiguous" (scheduled_start_at is not an OUT
-- parameter name, so it alone never triggered this).
--
-- Fix: alias the table and qualify every column in that subquery. No
-- other logic, message, or order change. Does not edit 20260822091500
-- (already applied) — same signature, so CREATE OR REPLACE preserves the
-- existing grants (no anon; authenticated only) without a re-grant.
create or replace function public.check_appointment_availability(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_staff_member_id uuid,
  p_service_id uuid,
  p_scheduled_start_at timestamptz
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
begin
  if not private.has_permission(p_tenant_id, 'appointments.view') then
    raise exception 'appointments.view required' using errcode = 'AP002';
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
  -- This mirrors that same check here, advisory only.
  if exists (
    select 1 from public.appointment_items ai
    where ai.staff_member_id = v_staff_member.id
      and ai.appointment_status not in ('cancelled', 'no_show')
      and tstzrange(ai.scheduled_start_at, ai.scheduled_end_at) && tstzrange(p_scheduled_start_at, v_end)
  ) then
    return query select false, 'AP012'::text, v_end;
    return;
  end if;

  return query select true, null::text, v_end;
end;
$$;
