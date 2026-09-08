-- Faz 5A.3E — hotfix for a real PROD defect surfaced by the first
-- authenticated report smoke on Gökhan İlhan Hair Studio: every staff
-- member's Doluluk rendered "—" (capacityMinutes=0) despite each having
-- 6 real weekly schedule rows, because every one of those rows is
-- branch-specific (branch_id NOT NULL) and the tenant-wide (no branch
-- filter) report was silently excluding all of them.
--
-- =====================================================================
-- ROOT CAUSE
-- =====================================================================
-- 20260907090000's raw_slots CTE matched recurring schedule rows with:
--
--   and (ss.branch_id is null or ss.branch_id = p_branch_id)
--
-- When the UI applies no branch filter, p_branch_id is NULL. SQL's
-- three-valued logic makes "ss.branch_id = NULL" evaluate to NULL (never
-- TRUE) for every row regardless of what ss.branch_id actually is, so
-- the whole OR collapses to exactly "ss.branch_id is null" — silently
-- dropping every branch-specific row from a tenant-wide report. This is
-- NOT the same predicate shape used everywhere else in this same
-- function: current_roster, historical_activity, and utilized_by_staff
-- all correctly lead with "p_branch_id is null or ...", short-circuiting
-- to "match everything" before ever comparing branch_id at all. Only
-- this one recurring-schedule join omitted that leading clause — a
-- single-point authoring mistake, confirmed (by re-reading the entire
-- function line by line for this hotfix) to appear nowhere else in it.
--
-- Every existing automated test that exercised a tenant-wide report used
-- a NULL-branch schedule row (which happens to satisfy the buggy
-- predicate by coincidence, since "ss.branch_id is null" alone is still
-- true for those rows); the one test using a branch-specific row always
-- paired it with an explicit, matching branch filter. No fixture ever
-- combined "branch-specific schedule" with "no branch filter" — exactly
-- the combination the real PROD tenant's data hits, since its staff
-- schedules were entered through the ordinary staff-management UI, which
-- assigns a specific branch by default. This migration's own regression
-- tests (see tests/personnel-performance-utilization.test.ts) close that
-- exact gap.
--
-- =====================================================================
-- FIX
-- =====================================================================
-- Corrected predicate:
--
--   and (p_branch_id is null or ss.branch_id is null or ss.branch_id = p_branch_id)
--
-- Tenant-wide (p_branch_id IS NULL): matches every qualifying schedule
-- row for the population, NULL-branch and branch-specific alike — the
-- first clause alone already makes this true, short-circuiting before
-- ss.branch_id is examined at all.
-- Branch-filtered (p_branch_id IS NOT NULL): unchanged from before —
-- matches a NULL-branch row (applies everywhere the staff is assigned)
-- or a row whose branch_id equals the filter. p_branch_id has already
-- been proven to belong to p_tenant_id by this same function's own
-- up-front tenant-safety guard before this predicate is ever reached, so
-- widening it to also match on "p_branch_id is null" introduces no new
-- foreign-tenant exposure — that guard is untouched by this migration.
--
-- Nothing else changes: signature, SECURITY DEFINER, search_path='',
-- existing grants, RP001-RP004, the tenant-safety guard, service-filter
-- exclusion, effective_end_at semantics, roster/history population,
-- interval UNION-not-SUM, exception replace-semantics, and current
-- concurrent_capacity behavior are all byte-identical to 20260907090000 —
-- this migration is exactly one CREATE OR REPLACE of
-- private.get_staff_utilization, differing from the original by this one
-- corrected line. 20260907090000 itself is not edited (immutable, per
-- this project's standing convention) and public.get_staff_utilization /
-- private.tenant_day_bounds_utc need no change at all, so neither is
-- replaced here.
create or replace function private.get_staff_utilization(
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

  -- Tenant-safety guard — see 20260907090000's header comment. Never
  -- falls back to "no filter"; a foreign/nonexistent branch id returns
  -- the empty result. Unchanged by this hotfix.
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
      -- Faz 5A.3E fix: leading "p_branch_id is null or" restored so a
      -- tenant-wide report (p_branch_id NULL) matches every qualifying
      -- row regardless of its own branch_id, instead of collapsing to
      -- "ss.branch_id is null" via SQL's three-valued "x = NULL" logic.
      and (p_branch_id is null or ss.branch_id is null or ss.branch_id = p_branch_id)
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
  'Faz 5A.3B, corrected Faz 5A.3E — staff utilization: scheduled/capacity/utilized minutes and a ratio (utilizedMinutes/capacityMinutes, null when capacityMinutes=0, never capped above 1.0). No service filter — see 20260907090000''s header comment for why. utilization is a raw ratio, not a x100 percentage — see lib/modules/reports/queries.ts. Faz 5A.3E fixed a tenant-wide report incorrectly excluding branch-specific schedule rows — see this migration''s own header comment.';
