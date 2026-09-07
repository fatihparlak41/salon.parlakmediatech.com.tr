-- Faz 5A.3A — Personnel Performance summary RPC. The first (and, in this
-- batch, only) narrow SECURITY DEFINER reporting endpoint over
-- private.appointment_item_performance (Faz 5A.1A). No table, column,
-- index, view, or RLS policy change — this migration is exactly one new
-- function pair.
--
-- Scope is deliberately v1-minimal: totals + per-staff comparison +
-- service mix. No utilization (Faz 5A.3B), no trend series (deferred to
-- Faz 5A.4), no financial figures whatsoever.
--
-- =====================================================================
-- WHY effective_performer_id, READ FROM THE VIEW, NEVER RE-DERIVED
-- =====================================================================
-- effective_performer_id = coalesce(actual_staff_member_id,
-- staff_member_id) already lives in exactly one place —
-- private.appointment_item_performance — specifically so no report query
-- can ever reimplement a second, quietly-different COALESCE. Every query
-- below reads that column directly; none of them touch
-- appointment_items.staff_member_id/actual_staff_member_id themselves.
--
-- =====================================================================
-- WHY TOTALS ARE COMPUTED INDEPENDENTLY, NEVER SUMMED FROM STAFF ROWS
-- =====================================================================
-- completedAppointments and every customer-count metric are genuinely
-- non-additive across staff: one multi-staff appointment, or one
-- customer served by two different staff in the same reporting window,
-- legitimately appears under more than one performer. Summing the staff
-- array would double-count exactly those real, correct cases. Totals are
-- therefore computed directly against the filtered dataset as its own
-- independent query, in both the private function's two `with` blocks
-- below — never derived from the `staff` array's own numbers.
--
-- =====================================================================
-- WHY CANCELLED/NO-SHOW ARE APPOINTMENT COUNTS, NOT ITEM COUNTS
-- =====================================================================
-- A cancelled or no-show appointment carrying three service items is one
-- cancelled appointment, not three — count(distinct appointment_id),
-- never count(*) over appointment_items, for these two metrics
-- specifically (every other completed-item metric is correctly an item
-- count). effective_performer_id naturally resolves to the booked staff
-- for these rows (actual_staff_member_id is only ever populated at
-- completion time, so it is always null on a cancelled/no_show row) —
-- no special-case column is needed for that fallback, the view's own
-- coalesce already does it.
--
-- =====================================================================
-- WHY "FIRST EVER" IS TENANT-WIDE, NEVER FILTERED
-- =====================================================================
-- A customer's first-ever completed visit is a fact about their
-- relationship with the TENANT, not about whichever branch/staff/service
-- the current report happens to be scoped to. The `first_ever` CTE in
-- both blocks below is deliberately built from an UNFILTERED (tenant-id
-- only) scan; only the "served in this report" population is filtered
-- by p_branch_id/p_staff_ids/p_service_ids.
create function private.get_staff_performance_summary(
  p_tenant_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_branch_id uuid default null,
  p_staff_ids uuid[] default null,
  p_service_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_totals jsonb;
  v_staff jsonb;
  v_service_mix jsonb;
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

  -- ---------------------------------------------------------------
  -- totals — independent of the staff array (see header comment).
  -- ---------------------------------------------------------------
  with filtered as (
    select *
    from private.appointment_item_performance
    where tenant_id = p_tenant_id
      and scheduled_start_at >= p_start_at
      and scheduled_start_at < p_end_at
      and (p_branch_id is null or branch_id = p_branch_id)
      and (coalesce(cardinality(p_staff_ids), 0) = 0 or effective_performer_id = any(p_staff_ids))
      and (coalesce(cardinality(p_service_ids), 0) = 0 or service_id = any(p_service_ids))
  ),
  first_ever as (
    select customer_id, min(scheduled_start_at) as first_completed_at
    from private.appointment_item_performance
    where tenant_id = p_tenant_id and appointment_status = 'completed'
    group by customer_id
  ),
  served_totals as (
    select distinct customer_id from filtered where appointment_status = 'completed'
  )
  select jsonb_build_object(
    'completedServiceItems', (select count(*) from filtered where appointment_status = 'completed'),
    'completedAppointments', (select count(distinct appointment_id) from filtered where appointment_status = 'completed'),
    'uniqueCustomers', (select count(*) from served_totals),
    'newCustomers', (
      select count(*) from served_totals st
      join first_ever fe on fe.customer_id = st.customer_id
      where fe.first_completed_at >= p_start_at
    ),
    'returningCustomers', (
      select count(*) from served_totals st
      join first_ever fe on fe.customer_id = st.customer_id
      where fe.first_completed_at < p_start_at
    ),
    'completedMinutes', (select coalesce(sum(duration_minutes), 0) from filtered where appointment_status = 'completed'),
    'cancelledAppointments', (select count(distinct appointment_id) from filtered where appointment_status = 'cancelled'),
    'noShowAppointments', (select count(distinct appointment_id) from filtered where appointment_status = 'no_show')
  ) into v_totals;

  -- ---------------------------------------------------------------
  -- staff[] — grouped by effective_performer_id. Deliberately
  -- non-additive with totals above.
  -- ---------------------------------------------------------------
  with filtered as (
    select *
    from private.appointment_item_performance
    where tenant_id = p_tenant_id
      and scheduled_start_at >= p_start_at
      and scheduled_start_at < p_end_at
      and (p_branch_id is null or branch_id = p_branch_id)
      and (coalesce(cardinality(p_staff_ids), 0) = 0 or effective_performer_id = any(p_staff_ids))
      and (coalesce(cardinality(p_service_ids), 0) = 0 or service_id = any(p_service_ids))
  ),
  first_ever as (
    select customer_id, min(scheduled_start_at) as first_completed_at
    from private.appointment_item_performance
    where tenant_id = p_tenant_id and appointment_status = 'completed'
    group by customer_id
  ),
  -- Distinct (performer, customer) pairs first — no fan-out — then
  -- joined 1:1 to first_ever (also one row per customer), so the
  -- subsequent GROUP BY below can never double-count a customer.
  served_by_staff as (
    select distinct effective_performer_id, customer_id
    from filtered
    where appointment_status = 'completed'
  ),
  served_by_staff_classified as (
    select sbs.effective_performer_id, sbs.customer_id, fe.first_completed_at
    from served_by_staff sbs
    join first_ever fe on fe.customer_id = sbs.customer_id
  ),
  customer_metrics_by_staff as (
    select
      effective_performer_id,
      count(*) as unique_customers,
      count(*) filter (where first_completed_at >= p_start_at) as new_customers,
      count(*) filter (where first_completed_at < p_start_at) as returning_customers
    from served_by_staff_classified
    group by effective_performer_id
  ),
  item_metrics_by_staff as (
    select
      effective_performer_id,
      max(effective_performer_name) as staff_name,
      count(*) filter (where appointment_status = 'completed') as completed_service_items,
      count(distinct appointment_id) filter (where appointment_status = 'completed') as completed_appointments,
      coalesce(sum(duration_minutes) filter (where appointment_status = 'completed'), 0) as completed_minutes,
      count(distinct appointment_id) filter (where appointment_status = 'cancelled') as cancelled_appointments,
      count(distinct appointment_id) filter (where appointment_status = 'no_show') as no_show_appointments
    from filtered
    group by effective_performer_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'staffId', i.effective_performer_id,
    'staffName', i.staff_name,
    'completedServiceItems', i.completed_service_items,
    'completedAppointments', i.completed_appointments,
    'uniqueCustomers', coalesce(c.unique_customers, 0),
    'newCustomers', coalesce(c.new_customers, 0),
    'returningCustomers', coalesce(c.returning_customers, 0),
    'completedMinutes', i.completed_minutes,
    'cancelledAppointments', i.cancelled_appointments,
    'noShowAppointments', i.no_show_appointments
  ) order by i.staff_name), '[]'::jsonb) into v_staff
  from item_metrics_by_staff i
  left join customer_metrics_by_staff c on c.effective_performer_id = i.effective_performer_id;

  -- ---------------------------------------------------------------
  -- serviceMix[] — grouped by (effective_performer_id, service_id).
  -- Completed items only. Service identity exposed unmerged
  -- (name/category as separate raw fields) — no bucketing decision
  -- baked in here. No price, no financial field of any kind.
  -- ---------------------------------------------------------------
  with filtered as (
    select *
    from private.appointment_item_performance
    where tenant_id = p_tenant_id
      and scheduled_start_at >= p_start_at
      and scheduled_start_at < p_end_at
      and (p_branch_id is null or branch_id = p_branch_id)
      and (coalesce(cardinality(p_staff_ids), 0) = 0 or effective_performer_id = any(p_staff_ids))
      and (coalesce(cardinality(p_service_ids), 0) = 0 or service_id = any(p_service_ids))
      and appointment_status = 'completed'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'staffId', effective_performer_id,
    'staffName', staff_name,
    'serviceId', service_id,
    'serviceName', service_name,
    'serviceCategory', service_category,
    'completedCount', completed_count
  ) order by staff_name, service_name), '[]'::jsonb) into v_service_mix
  from (
    select
      effective_performer_id,
      max(effective_performer_name) as staff_name,
      service_id,
      max(service_name) as service_name,
      max(service_category) as service_category,
      count(*) as completed_count
    from filtered
    group by effective_performer_id, service_id
  ) service_mix;

  return jsonb_build_object('totals', v_totals, 'staff', v_staff, 'serviceMix', v_service_mix);
end;
$$;

comment on function private.get_staff_performance_summary(uuid, timestamptz, timestamptz, uuid, uuid[], uuid[]) is
  'Faz 5A.3A — the sole v1 personnel-performance reporting query. Reads private.appointment_item_performance only, filters tenant_id explicitly on every internal query (this view carries no RLS of its own), and never relies on a base-table grant. NULL or empty-array p_staff_ids/p_service_ids means "no filter" — see the has_permission/RP00n checks above for the actual authorization boundary.';

revoke execute on function private.get_staff_performance_summary(uuid, timestamptz, timestamptz, uuid, uuid[], uuid[]) from public;

create function public.get_staff_performance_summary(
  p_tenant_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_branch_id uuid default null,
  p_staff_ids uuid[] default null,
  p_service_ids uuid[] default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.get_staff_performance_summary(p_tenant_id, p_start_at, p_end_at, p_branch_id, p_staff_ids, p_service_ids);
$$;

revoke execute on function public.get_staff_performance_summary(uuid, timestamptz, timestamptz, uuid, uuid[], uuid[]) from public;
revoke execute on function public.get_staff_performance_summary(uuid, timestamptz, timestamptz, uuid, uuid[], uuid[]) from anon;
grant execute on function public.get_staff_performance_summary(uuid, timestamptz, timestamptz, uuid, uuid[], uuid[]) to authenticated;
