-- Faz FIN.2A — Daily Owner overview: ONE canonical read model for "how did today go" (appointments, completed work, sales
-- value, money collected, expenses, cash difference, outstanding, per-person work).
--
-- This is operational visibility, not accounting. It adds ONE read function (+ its public wrapper) and nothing else: no
-- table, no column, no trigger, no index, no grant on an existing object, no data. FIN.1A (appointment_sales,
-- appointment_sale_items, payments) and FIN.1B.1 (expenses, expense_payments) are only READ, through SECURITY DEFINER.
--
-- =====================================================================
-- TERMS (they are different numbers on purpose)
-- =====================================================================
--  * Tamamlanan islem tutari  (services.completedAmount)  VALUE of work finished in the day. For a completed appointment
--    that has a checkout (appointment_sales) it is the charged total_amount (after the sale-level discount); for one
--    without a checkout it is the booking-time price snapshot (appointment_items.price) and it is counted separately
--    (completedWithoutCheckout / withoutCheckoutAmount) so it can be explained. It is NOT money received.
--  * Tahsilat  (payments.*)  money actually received: posted payments whose paid_at falls in the tenant-local day, split
--    by their own method. A payment recorded for an old appointment counts on the day it was RECEIVED.
--  * Bekleyen tahsilat  (outstanding)  only from canonical checkouts: total_amount minus posted payments of every
--    non-voided sale, as of now. Completed appointments with no checkout are NOT guessed to be unpaid.
--  * Gider  (expenses.accrued*)  obligations dated in the day (expense_date), cancelled ones excluded; and
--    Odenen gider (expenses.paidOut*)  money actually paid out: posted expense_payments in the day, split by method.
--  * Gunluk nakit farki  (cash.difference)  posted CASH payments received minus posted CASH expense payments made in the
--    day. Both sides carry a method in the schema, so this is supported; card/transfer/other never enter it.
--    It is not profit: no obligations, no payroll, no tax, no cost of goods.
--
-- =====================================================================
-- DAY BOUNDARIES
-- =====================================================================
-- "Bugun" is the tenant-local calendar day: [day 00:00, next day 00:00) in tenants.timezone, so a day is 23, 24 or 25
-- hours across a DST change. An appointment belongs to the day its scheduled_start_at falls in (appointments carry no
-- completion timestamp, so "completed today" = completed AND scheduled today). The server's UTC date is never used.
--
-- =====================================================================
-- STAFF
-- =====================================================================
-- Attribution is per ITEM, never per appointment: the person is the checkout snapshot's actual performer when a checkout
-- exists, else coalesce(actual_staff_member_id, staff_member_id) of the appointment item; the amount is that item's
-- charged unit_price (checkout) or booking price. The sale-level discount is NOT allocated to people (inventing a split
-- would be false precision); it is reported once (services.discountTotal) so that
-- sum(staff.serviceAmount) - discountTotal = services.completedAmount for appointments with a checkout.
--
-- =====================================================================
-- SCOPE, ACCESS, PRIVACY
-- =====================================================================
-- Tenant-wide (finance has no branch context in the application; rows carry a branch but there is no "current branch").
-- Requires finance.view of THAT tenant (the Owner by default; other roles only if explicitly granted). Output is
-- aggregate: staff display names only, no customer data, no notes, no user/customer/appointment ids.
-- SQLSTATE: FN001 not signed in, FN002 not allowed, FN004 invalid date.

create or replace function private.daily_owner_overview(p_tenant_id uuid, p_date date default null)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tz text;
  v_currency text;
  v_day date;
  v_lo timestamptz;
  v_hi timestamptz;
  v_appt jsonb;
  v_services jsonb;
  v_payments jsonb;
  v_outstanding jsonb;
  v_expenses jsonb;
  v_cash jsonb;
  v_staff jsonb;
  v_staff_total numeric;
  v_mixed boolean;
  v_cash_in numeric;
  v_cash_out numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if not private.has_permission(p_tenant_id, 'finance.view') then
    raise exception 'finance.view required' using errcode = 'FN002';
  end if;

  select t.timezone, t.currency into v_tz, v_currency from public.tenants t where t.id = p_tenant_id;
  if v_tz is null then
    raise exception 'finance.view required' using errcode = 'FN002';
  end if;

  v_day := coalesce(p_date, (now() at time zone v_tz)::date);
  if v_day not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'invalid date' using errcode = 'FN004';
  end if;
  v_lo := v_day::timestamp at time zone v_tz;
  v_hi := (v_day + 1)::timestamp at time zone v_tz;

  -- appointments that start in the local day, by their canonical status
  select jsonb_build_object(
    'total', count(*),
    'scheduled', count(*) filter (where a.status = 'scheduled'),
    'confirmed', count(*) filter (where a.status = 'confirmed'),
    'inProgress', count(*) filter (where a.status = 'in_progress'),
    'completed', count(*) filter (where a.status = 'completed'),
    'cancelled', count(*) filter (where a.status = 'cancelled'),
    'noShow', count(*) filter (where a.status = 'no_show')
  ) into v_appt
  from public.appointments a
  where a.tenant_id = p_tenant_id and a.scheduled_start_at >= v_lo and a.scheduled_start_at < v_hi;

  -- value of completed work: the charged total where a checkout exists, else the booking price snapshot
  with done as (
    select a.id as appointment_id, s.id as sale_id, s.total_amount, s.discount_amount,
           (select coalesce(sum(ai.price), 0) from public.appointment_items ai
             where ai.appointment_id = a.id and ai.tenant_id = p_tenant_id) as list_amount
    from public.appointments a
    left join public.appointment_sales s
      on s.appointment_id = a.id and s.tenant_id = p_tenant_id and s.status <> 'voided'
    where a.tenant_id = p_tenant_id and a.status = 'completed'
      and a.scheduled_start_at >= v_lo and a.scheduled_start_at < v_hi
  )
  select jsonb_build_object(
    'completedAmount', coalesce(sum(case when d.sale_id is not null then d.total_amount else d.list_amount end), 0),
    'completedWithCheckout', count(*) filter (where d.sale_id is not null),
    'completedWithoutCheckout', count(*) filter (where d.sale_id is null),
    'withoutCheckoutAmount', coalesce(sum(d.list_amount) filter (where d.sale_id is null), 0),
    'discountTotal', coalesce(sum(d.discount_amount) filter (where d.sale_id is not null), 0)
  ) into v_services
  from done d;

  -- money received in the local day (by when it was received), per its own method
  select jsonb_build_object(
    'totalCollected', coalesce(sum(p.amount), 0),
    'count', count(*),
    'cash', coalesce(sum(p.amount) filter (where p.method = 'cash'), 0),
    'card', coalesce(sum(p.amount) filter (where p.method = 'card'), 0),
    'bankTransfer', coalesce(sum(p.amount) filter (where p.method = 'bank_transfer'), 0),
    'other', coalesce(sum(p.amount) filter (where p.method = 'other'), 0)
  ) into v_payments
  from public.payments p
  where p.tenant_id = p_tenant_id and p.status = 'posted' and p.paid_at >= v_lo and p.paid_at < v_hi;

  -- payments cancelled (voided) in the local day: informational, they never count as collected
  v_payments := v_payments || (
    select jsonb_build_object('voidedCount', count(*), 'voidedAmount', coalesce(sum(p.amount), 0))
    from public.payments p
    where p.tenant_id = p_tenant_id and p.status = 'voided' and p.voided_at >= v_lo and p.voided_at < v_hi
  );

  -- outstanding, only from canonical checkouts (non-voided sales), as of now
  with sale_balance as (
    select s.id, s.appointment_id, s.total_amount - coalesce((
             select sum(p.amount) from public.payments p where p.appointment_sale_id = s.id and p.status = 'posted'
           ), 0) as balance
    from public.appointment_sales s
    where s.tenant_id = p_tenant_id and s.status <> 'voided'
  )
  select jsonb_build_object(
    'supported', true,
    'amount', coalesce(sum(b.balance) filter (where b.balance > 0), 0),
    'count', count(*) filter (where b.balance > 0),
    'todayAmount', coalesce(sum(b.balance) filter (where b.balance > 0 and exists (
        select 1 from public.appointments a
        where a.id = b.appointment_id and a.tenant_id = p_tenant_id
          and a.scheduled_start_at >= v_lo and a.scheduled_start_at < v_hi)), 0)
  ) into v_outstanding
  from sale_balance b;

  -- expenses: obligations dated in the day, and money actually paid out in the day
  select jsonb_build_object(
    'accruedTotal', coalesce(sum(e.amount), 0),
    'accruedCount', count(*)
  ) into v_expenses
  from public.expenses e
  where e.tenant_id = p_tenant_id and e.status <> 'cancelled' and e.expense_date = v_day;

  v_expenses := v_expenses || (
    select jsonb_build_object(
      'paidOutTotal', coalesce(sum(ep.amount), 0),
      'paidOutCount', count(*),
      'paidOutCash', coalesce(sum(ep.amount) filter (where ep.method = 'cash'), 0),
      'paidOutCard', coalesce(sum(ep.amount) filter (where ep.method = 'card'), 0),
      'paidOutBankTransfer', coalesce(sum(ep.amount) filter (where ep.method = 'bank_transfer'), 0),
      'paidOutOther', coalesce(sum(ep.amount) filter (where ep.method = 'other'), 0)
    )
    from public.expense_payments ep
    where ep.tenant_id = p_tenant_id and ep.status = 'posted' and ep.paid_at >= v_lo and ep.paid_at < v_hi
  );

  -- daily cash difference: cash received minus cash paid out, both from rows that carry their own method
  v_cash_in := (v_payments ->> 'cash')::numeric;
  v_cash_out := (v_expenses ->> 'paidOutCash')::numeric;
  v_cash := jsonb_build_object(
    'supported', true,
    'cashCollected', v_cash_in,
    'cashPaidOut', v_cash_out,
    'difference', v_cash_in - v_cash_out
  );

  -- per person, per ITEM (never the whole appointment value to everyone)
  with items as (
    select ai.appointment_id,
           case when asi.id is not null then asi.actual_staff_member_id else null end as sale_staff,
           coalesce(ai.actual_staff_member_id, ai.staff_member_id) as booked_staff,
           case when asi.id is not null then asi.unit_price else ai.price end as amount
    from public.appointments a
    join public.appointment_items ai on ai.appointment_id = a.id and ai.tenant_id = p_tenant_id
    left join public.appointment_sales s
      on s.appointment_id = a.id and s.tenant_id = p_tenant_id and s.status <> 'voided'
    left join public.appointment_sale_items asi
      on asi.appointment_item_id = ai.id and asi.sale_id = s.id and asi.tenant_id = p_tenant_id
    where a.tenant_id = p_tenant_id and a.status = 'completed'
      and a.scheduled_start_at >= v_lo and a.scheduled_start_at < v_hi
  ),
  per_staff as (
    select coalesce(i.sale_staff, i.booked_staff) as staff_id,
           count(distinct i.appointment_id) as appts,
           count(*) as items,
           sum(i.amount) as amount
    from items i
    group by coalesce(i.sale_staff, i.booked_staff)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'displayName', sm.full_name,
           'completedAppointments', ps.appts,
           'completedItems', ps.items,
           'serviceAmount', ps.amount
         ) order by ps.amount desc, sm.full_name), '[]'::jsonb),
         coalesce(sum(ps.amount), 0)
    into v_staff, v_staff_total
  from per_staff ps
  join public.staff_members sm on sm.id = ps.staff_id and sm.tenant_id = p_tenant_id;

  -- any contributing record in another currency than the tenant's current one?
  select exists (
           select 1 from public.expenses e
           where e.tenant_id = p_tenant_id and e.status <> 'cancelled' and e.expense_date = v_day and e.currency <> v_currency
         ) or exists (
           select 1 from public.appointment_sales s
           where s.tenant_id = p_tenant_id and s.status <> 'voided' and s.currency <> v_currency
         )
    into v_mixed;

  return jsonb_build_object(
    'date', v_day,
    'timezone', v_tz,
    'currency', v_currency,
    'currencyMixed', v_mixed,
    'scope', 'tenant',
    'appointments', v_appt,
    'services', v_services,
    'payments', v_payments,
    'outstanding', v_outstanding,
    'expenses', v_expenses,
    'cash', v_cash,
    'staff', v_staff,
    'staffServiceAmountTotal', v_staff_total,
    'unsupported', jsonb_build_array('refunds', 'personnelPayments', 'profit')
  );
end;
$function$;

revoke all on function private.daily_owner_overview(uuid, date) from public, anon, authenticated, service_role;

create or replace function public.get_daily_owner_overview(p_tenant_id uuid, p_date date default null)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select private.daily_owner_overview(p_tenant_id, p_date);
$function$;

revoke all on function public.get_daily_owner_overview(uuid, date) from public, anon, authenticated, service_role;
grant execute on function public.get_daily_owner_overview(uuid, date) to authenticated;
