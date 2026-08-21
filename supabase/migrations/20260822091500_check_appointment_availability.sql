-- Phase 2D — advisory, read-side availability check.
--
-- The operator needs useful feedback BEFORE pressing Save (product goal
-- #7), but the create/reschedule RPCs' own exclusion-constraint-backed
-- insert remains the sole authoritative, race-condition-safe check —
-- this function is advisory only, exactly like staff_is_available's own
-- doc comment already says about itself. A TOCTOU gap between this call
-- and the actual save is expected and fine: the real insert re-validates
-- everything fresh and is what actually prevents a double-booking.
--
-- SECURITY DEFINER + an explicit has_permission() check, not SECURITY
-- INVOKER — calling private.staff_is_available from an INVOKER function
-- would fail the same way search_customers did in Phase 2C (authenticated
-- has no USAGE on the private schema; that restriction applies to a
-- function's own nested calls even when it doesn't apply to the same
-- helper referenced from an RLS policy). No anon grant — public booking's
-- own, separately-designed availability boundary is Phase 2F's job, not
-- this authenticated-only endpoint widened later.
--
-- Reuses the exact AP0nn vocabulary from 20260822090000 as the `reason`
-- column instead of a second, parallel set of strings — one taxonomy,
-- one client-side mapping table (lib/modules/appointments/error-codes.ts)
-- covers both the advisory read path and the authoritative write path.
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
    select 1 from public.appointment_items
    where staff_member_id = v_staff_member.id
      and appointment_status not in ('cancelled', 'no_show')
      and tstzrange(scheduled_start_at, scheduled_end_at) && tstzrange(p_scheduled_start_at, v_end)
  ) then
    return query select false, 'AP012'::text, v_end;
    return;
  end if;

  return query select true, null::text, v_end;
end;
$$;

comment on function public.check_appointment_availability(uuid, uuid, uuid, uuid, timestamptz) is
  'Advisory only — the create_appointment/reschedule_appointment exclusion-constraint-backed insert is the sole race-condition-safe authority. reason reuses the AP0nn codes from 20260822090000. appointments.view required. No anon access; Phase 2F public booking needs its own separately-designed availability boundary, not this endpoint widened.';

revoke execute on function public.check_appointment_availability(uuid, uuid, uuid, uuid, timestamptz) from public;
grant execute on function public.check_appointment_availability(uuid, uuid, uuid, uuid, timestamptz) to authenticated;
