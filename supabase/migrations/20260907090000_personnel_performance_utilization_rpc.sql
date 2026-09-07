-- Faz 5A.3B — Personnel Performance utilization RPC. Second and, in this
-- batch, final reporting endpoint over private.appointment_item_performance
-- (Faz 5A.1A) plus the scheduling tables (staff_schedules,
-- staff_schedule_exceptions, staff_branches, staff_members). No table,
-- column, index, view, or RLS policy change — this migration is exactly
-- one new internal helper plus one new function pair.
--
-- This migration encodes several corrections the fresh Faz 5A.3 audit's
-- first pass got wrong or left too permissive. Each is called out below
-- at the point it matters; do not "simplify" any of them without re-
-- reading why they're here.

-- =========================================================================
-- private.tenant_day_bounds_utc — one tenant-local calendar date as a
-- half-open UTC range. Internal only, never exposed publicly. Mirrors the
-- conversion private.staff_is_available already does inline (date + time
-- AT TIME ZONE tz) and lib/modules/appointments/timezone.ts's
-- getTenantDayRangeUtc does in JS for the application layer — this is the
-- same idea, natively in SQL, for use inside a day-expansion loop.
-- =========================================================================
create function private.tenant_day_bounds_utc(p_tenant_id uuid, p_local_date date)
returns tstzrange
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_tz text;
begin
  select timezone into v_tz from public.tenants where id = p_tenant_id;
  if v_tz is null then
    return null;
  end if;

  return tstzrange(
    (p_local_date::timestamp) at time zone v_tz,
    ((p_local_date + 1)::timestamp) at time zone v_tz
  );
end;
$$;

comment on function private.tenant_day_bounds_utc(uuid, date) is
  'Faz 5A.3B — [local_date 00:00, local_date+1 00:00) in tenant.timezone, converted to a UTC tstzrange. Internal helper only. Given a defensive-only null-tenant guard: real callers always reach this after their own has_permission check already proved the tenant exists.';

revoke execute on function private.tenant_day_bounds_utc(uuid, date) from public;

-- =========================================================================
-- private.get_staff_utilization
-- =========================================================================
-- WHY effective_end_at CLIPS TO now() (product correction over the audit)
-- -------------------------------------------------------------------------
-- Future scheduled capacity must never depress a CURRENT utilization
-- figure, and "today" must count only its already-elapsed capacity — a
-- weekly report pulled Wednesday must not show a fully-booked Mon-Wed
-- stylist as 40% occupied just because Thu-Sun haven't happened yet. One
-- clip of the window's END boundary (v_effective_end_at := least(p_end_at,
-- now())) handles both at once: a purely historical range is untouched
-- (p_end_at already < now()), a range extending into the future has its
-- future days excluded entirely (the day-expansion series below never
-- generates a date past v_effective_end_at), and today is naturally
-- elapsed-only, because its own schedule interval gets clipped to "now" by
-- the same intersection logic used for every other day, not by a separate
-- special case.
--
-- WHY THE NUMERATOR IS AN INTERSECTION, NOT full duration_minutes
-- -------------------------------------------------------------------------
-- Faz 5A.3A's completedMinutes sums the FULL planned duration_minutes of
-- every completed item whose scheduled_start_at falls in range — correct
-- for that metric's own contract. utilizedMinutes is a DIFFERENT metric
-- with a different name on purpose: the controlled Faz 5A PROD acceptance
-- test proved an appointment item CAN be marked completed before its own
-- scheduled_start_at has actually arrived (nothing in complete_appointment
-- checks now() >= scheduled_start_at). Utilization must not credit minutes
-- that have not actually elapsed, so utilizedMinutes for a completed item
-- is the overlap-duration between [scheduled_start_at, scheduled_end_at)
-- and the EFFECTIVE report interval [p_start_at, v_effective_end_at) —
-- zero if there is no overlap (a future-scheduled-but-already-completed
-- item contributes nothing until its own start_at is reached), a partial
-- amount if only part of the item has elapsed, and the full duration if
-- the item is entirely inside the effective interval. This is genuinely
-- additive across overlapping completed items for a capacity>1 staff
-- member (two customers really were served in parallel = 2x real elapsed
-- minutes) — a deliberate contrast with the UNION-not-SUM rule below,
-- which dedupes redundant SCHEDULE bookkeeping, not real worked time.
--
-- WHY POPULATION IS ROSTER + HISTORY, NEVER SCHEDULE-DRIVEN
-- -------------------------------------------------------------------------
-- (rejected an earlier audit draft that would have driven population from
-- staff_schedules rows). An active staff member with literally no
-- schedule configured must still appear with scheduledMinutes=0,
-- capacityMinutes=0, utilization=null — hiding them would hide exactly
-- the understaffed/unconfigured case this report exists to surface. An
-- INACTIVE staff member must still appear for a past period where they
-- genuinely worked (real history), but must not clutter a report solely
-- because a stale staff_schedules row happens to still exist with zero
-- actual activity in range. Population is therefore the union of:
--   (A) every currently active staff_members row for this tenant
--       (branch-filtered via a CURRENT staff_branches association), and
--   (B) every effective_performer_id with a completed appointment item
--       overlapping the EFFECTIVE report interval (branch-filtered via
--       that APPOINTMENT's own historical branch_id, deliberately never
--       via current staff_branches — an inactive stylist's history must
--       not be erased just because their branch assignment later
--       changed or was removed).
-- (B)'s overlap predicate is deliberately identical to the numerator's
-- own, so a staff member is never added to the population by a row that
-- would not actually contribute anything to utilizedMinutes.
--
-- WHY p_branch_id IS VALIDATED AGAINST p_tenant_id BEFORE ANY OTHER QUERY
-- -------------------------------------------------------------------------
-- staff_schedules rows are matched with "(branch_id IS NULL OR branch_id =
-- p_branch_id)" (see below) — and IS NULL matches regardless of what
-- p_branch_id actually is. A p_branch_id belonging to a DIFFERENT tenant
-- (or no tenant at all) must not be able to pull in this tenant's own
-- NULL-branch schedule rows through that escape hatch. p_branch_id is
-- therefore proven to belong to p_tenant_id up front, before it is used
-- in any predicate; a branch that fails that proof returns the same empty
-- result as "a real branch with zero staff" — never an error, so the
-- response never distinguishes "wrong tenant" from "no data" for a
-- caller who otherwise has legitimate reports.staff access.
--
-- WHY scheduledMinutes IS A UNION OF INTERVALS, NEVER A SUM
-- -------------------------------------------------------------------------
-- staff_schedules has no overlap constraint (by design — see its own
-- table comment), and private.staff_is_available treats "is there at
-- least one matching row" as a plain boolean EXISTS: two overlapping or
-- duplicate rows for the same weekday grant zero additional bookable
-- capacity over one row covering the same window. Only concurrent_capacity
-- (a single staff-wide integer, entirely independent of schedule row
-- count) ever multiplies real simultaneous capacity. scheduledMinutes must
-- therefore be the duration of the UNION of each staff member's qualifying
-- wall-clock intervals in range, never the sum of the raw rows — summing
-- would double-count wall-clock time the booking model never actually
-- doubled. Implemented with native multirange support (range_agg / unnest,
-- PostgreSQL 14+; confirmed available on this project's PG17). This same
-- UNION-not-SUM rule is *also* the entire fix for the tenant-wide
-- NULL-branch-times-N-assigned-branches problem below: once dedup is by
-- wall-clock interval instead of by row, branch-assignment count can never
-- act as a multiplier.
--
-- WHY A NULL-branch SCHEDULE ROW CONTRIBUTES ONCE TENANT-WIDE, FULLY TO
-- EACH BRANCH WHEN FILTERED
-- -------------------------------------------------------------------------
-- private.staff_is_available's own comment: "A staff_schedules row with
-- branch_id NULL applies at every branch the staff member is assigned to
-- via staff_branches." A NULL-branch 08:00-17:00 row for a staff member
-- assigned to branches A and B contributes 9 hours tenant-wide (branch
-- assignment count is never a multiplier — see above), the same 9 hours
-- again in full when the report is filtered to branch A alone, and the
-- same 9 hours again in full when filtered to branch B alone. This
-- overlap between two separately-filtered branch reports is intentional,
-- not a bug: it mirrors the booking engine's own real ambiguity (the
-- schedule row never pre-commits which specific branch those hours will
-- actually be worked at on a given day; only concurrent_capacity limits
-- how much they can really be booked for).
create function private.get_staff_utilization(
  p_tenant_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_branch_id uuid default null,
  p_staff_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_effective_end_at timestamptz;
  v_empty_result jsonb;
  v_totals jsonb;
  v_staff jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'RP001';
  end if;

  if not private.has_permission(p_tenant_id, 'reports.staff') then
    raise exception 'reports.staff required' using errcode = 'RP002';
  end if;

  if p_start_at is null or p_end_at is null then
    raise exception 'start_at and end_at are required' using errcode = 'RP003';
  end if;

  if p_start_at >= p_end_at then
    raise exception 'start_at must be before end_at' using errcode = 'RP004';
  end if;

  v_empty_result := jsonb_build_object(
    'totals', jsonb_build_object(
      'scheduledMinutes', 0, 'capacityMinutes', 0, 'utilizedMinutes', 0, 'utilization', null
    ),
    'staff', '[]'::jsonb
  );

  -- Tenant-safety guard — see header comment. Never falls back to "no
  -- filter"; a foreign/nonexistent branch id returns the empty result.
  if p_branch_id is not null and not exists (
    select 1 from public.branches where id = p_branch_id and tenant_id = p_tenant_id
  ) then
    return v_empty_result;
  end if;

  select timezone into v_tz from public.tenants where id = p_tenant_id;
  if v_tz is null then
    return v_empty_result;
  end if;

  v_effective_end_at := least(p_end_at, now());

  if v_effective_end_at <= p_start_at then
    return v_empty_result;
  end if;

  with
  current_roster as (
    select sm.id as staff_id, sm.full_name as staff_name, sm.concurrent_capacity
    from public.staff_members sm
    where sm.tenant_id = p_tenant_id
      and sm.status = 'active'
      and sm.deleted_at is null
      and (
        p_branch_id is null
        or exists (
          select 1 from public.staff_branches sb
          where sb.staff_member_id = sm.id and sb.branch_id = p_branch_id
        )
      )
  ),
  historical_activity as (
    select distinct aip.effective_performer_id as staff_id
    from private.appointment_item_performance aip
    where aip.tenant_id = p_tenant_id
      and aip.appointment_status = 'completed'
      and aip.scheduled_start_at < v_effective_end_at
      and aip.scheduled_end_at > p_start_at
      and (p_branch_id is null or aip.branch_id = p_branch_id)
  ),
  historical_roster as (
    select sm.id as staff_id, sm.full_name as staff_name, sm.concurrent_capacity
    from historical_activity ha
    join public.staff_members sm on sm.id = ha.staff_id and sm.tenant_id = p_tenant_id
  ),
  population as (
    select staff_id, staff_name, concurrent_capacity from current_roster
    union
    select staff_id, staff_name, concurrent_capacity from historical_roster
  ),
  population_filtered as (
    select * from population
    where coalesce(cardinality(p_staff_ids), 0) = 0 or staff_id = any(p_staff_ids)
  ),
  local_dates as (
    select generate_series(
      (p_start_at at time zone v_tz)::date::timestamp,
      (v_effective_end_at at time zone v_tz)::date::timestamp,
      interval '1 day'
    )::date as local_date
  ),
  exception_days as (
    select staff_member_id, exception_date, type, start_time, end_time
    from public.staff_schedule_exceptions
    where tenant_id = p_tenant_id
      and deleted_at is null
      and exception_date in (select local_date from local_dates)
  ),
  -- Every raw wall-clock slot a population staff member could possibly be
  -- scheduled for across the candidate local dates: custom_hours
  -- exceptions replace the day entirely (unavailable contributes nothing,
  -- so it simply has no branch here), recurring staff_schedules rows only
  -- for dates carrying no exception row of either type.
  raw_slots as (
    select pf.staff_id,
      tstzrange(
        (ed.exception_date + ed.start_time) at time zone v_tz,
        (ed.exception_date + ed.end_time) at time zone v_tz
      ) as slot_range
    from population_filtered pf
    join exception_days ed
      on ed.staff_member_id = pf.staff_id and ed.type = 'custom_hours'

    union all

    select pf.staff_id,
      tstzrange(
        (ld.local_date + ss.start_time) at time zone v_tz,
        (ld.local_date + ss.end_time) at time zone v_tz
      ) as slot_range
    from population_filtered pf
    cross join local_dates ld
    join public.staff_schedules ss
      on ss.staff_member_id = pf.staff_id
      and ss.tenant_id = p_tenant_id
      and ss.deleted_at is null
      and ss.weekday = extract(dow from ld.local_date)
      and (ss.branch_id is null or ss.branch_id = p_branch_id)
    where not exists (
      select 1 from exception_days ed2
      where ed2.staff_member_id = pf.staff_id and ed2.exception_date = ld.local_date
    )
  ),
  clipped_slots as (
    select staff_id, (slot_range * tstzrange(p_start_at, v_effective_end_at)) as clipped_range
    from raw_slots
    where slot_range && tstzrange(p_start_at, v_effective_end_at)
  ),
  merged_per_staff as (
    select staff_id, range_agg(clipped_range) as merged
    from clipped_slots
    group by staff_id
  ),
  scheduled_by_staff as (
    select m.staff_id,
      sum(extract(epoch from (upper(r) - lower(r))) / 60.0) as scheduled_minutes
    from merged_per_staff m
    cross join lateral unnest(m.merged) as r
    group by m.staff_id
  ),
  utilized_by_staff as (
    select aip.effective_performer_id as staff_id,
      sum(
        greatest(0,
          extract(epoch from (
            least(aip.scheduled_end_at, v_effective_end_at) - greatest(aip.scheduled_start_at, p_start_at)
          )) / 60.0
        )
      ) as utilized_minutes
    from private.appointment_item_performance aip
    where aip.tenant_id = p_tenant_id
      and aip.appointment_status = 'completed'
      and aip.scheduled_start_at < v_effective_end_at
      and aip.scheduled_end_at > p_start_at
      and (p_branch_id is null or aip.branch_id = p_branch_id)
    group by aip.effective_performer_id
  ),
  staff_rows as (
    select
      pf.staff_id,
      pf.staff_name,
      pf.concurrent_capacity,
      coalesce(sb.scheduled_minutes, 0) as scheduled_minutes,
      coalesce(sb.scheduled_minutes, 0) * pf.concurrent_capacity as capacity_minutes,
      coalesce(ub.utilized_minutes, 0) as utilized_minutes
    from population_filtered pf
    left join scheduled_by_staff sb on sb.staff_id = pf.staff_id
    left join utilized_by_staff ub on ub.staff_id = pf.staff_id
  )
  select
    jsonb_build_object(
      'scheduledMinutes', coalesce(sum(scheduled_minutes), 0),
      'capacityMinutes', coalesce(sum(capacity_minutes), 0),
      'utilizedMinutes', coalesce(sum(utilized_minutes), 0),
      'utilization', case when coalesce(sum(capacity_minutes), 0) = 0 then null
        else sum(utilized_minutes) / sum(capacity_minutes) end
    ),
    coalesce(jsonb_agg(jsonb_build_object(
      'staffId', staff_id,
      'staffName', staff_name,
      'concurrentCapacity', concurrent_capacity,
      'scheduledMinutes', scheduled_minutes,
      'capacityMinutes', capacity_minutes,
      'utilizedMinutes', utilized_minutes,
      'utilization', case when capacity_minutes = 0 then null else utilized_minutes / capacity_minutes end
    ) order by staff_name), '[]'::jsonb)
  into v_totals, v_staff
  from staff_rows;

  return jsonb_build_object('totals', v_totals, 'staff', v_staff);
end;
$$;

comment on function private.get_staff_utilization(uuid, timestamptz, timestamptz, uuid, uuid[]) is
  'Faz 5A.3B — staff utilization: scheduled/capacity/utilized minutes and a ratio (utilizedMinutes/capacityMinutes, null when capacityMinutes=0, never capped above 1.0). No service filter — see migration header for why. utilization is a raw ratio, not a x100 percentage — see lib/modules/reports/queries.ts.';

revoke execute on function private.get_staff_utilization(uuid, timestamptz, timestamptz, uuid, uuid[]) from public;

create function public.get_staff_utilization(
  p_tenant_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_branch_id uuid default null,
  p_staff_ids uuid[] default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.get_staff_utilization(p_tenant_id, p_start_at, p_end_at, p_branch_id, p_staff_ids);
$$;

revoke execute on function public.get_staff_utilization(uuid, timestamptz, timestamptz, uuid, uuid[]) from public;
revoke execute on function public.get_staff_utilization(uuid, timestamptz, timestamptz, uuid, uuid[]) from anon;
grant execute on function public.get_staff_utilization(uuid, timestamptz, timestamptz, uuid, uuid[]) to authenticated;
