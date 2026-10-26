-- Faz COMM.1A — staff commission by service. NOT payroll, NOT a ledger, NOT a payment: it only answers "how much commission
-- does each person earn from the services they actually performed", in a way an Owner can check line by line.
--
-- =====================================================================
-- DECISIONS (written down because the numbers depend on them)
-- =====================================================================
-- BASIS: COMPLETED SERVICE VALUE, never money collected. Payments belong to a checkout, not to a person (FIN.1A has no per-person
--   collection), so a collection-based commission cannot be attributed honestly; cash / card / transfer, partial payment and
--   voided payments do not change a commission at all. COLLECTION_BASED_COMMISSION = DEFERRED.
-- WHAT COUNTS: one row per appointment ITEM of an appointment with status 'completed' whose scheduled start falls in the
--   tenant-local day range. Cancelled, no-show, confirmed, scheduled and future appointments never count. An item is counted once;
--   a multi-service appointment pays each person only for THEIR OWN item(s).
-- WHO: the person who performed the item: the checkout snapshot's actual performer when a checkout exists, else
--   coalesce(actual_staff_member_id, staff_member_id) (the same attribution as the FIN.2A daily overview).
-- VALUE: the item's charged unit_price when a (non-voided) checkout exists (an edited item price IS respected), else the booking
--   price snapshot.
-- DISCOUNT: a SALE-LEVEL discount is NOT allocated to items and does NOT reduce commission (commission is on the pre-discount
--   item value). Inventing a proportional split would silently decide who bears the discount; that choice belongs to the Owner
--   and is a P1 option. Every detail row says whether its checkout carried a sale discount, so the Owner can see it.
-- ROUNDING: each item's commission is rounded to the currency's minor unit (2 decimals, half away from zero, PostgreSQL numeric
--   round) and the totals are the SUM of those rounded item amounts, so the detail rows always add up to the total exactly. No
--   floating point anywhere (numeric only).
-- FIXED: the fixed amount is paid once per completed item (not per appointment, not per payment); a zero-valued item still earns
--   a fixed amount (the Owner set it for that service).
-- NO RULE / 'none': commission 0, no error; a person with completed work but no rule still appears once with commission 0.
-- RULES ARE EFFECTIVE-DATED: a rule row applies from its effective_from (a tenant-local date). The rule used for an item is the
--   latest row with effective_from <= the item's local date, so changing a rate today never silently rewrites last month. Setting a
--   rule for a staff+service on a date that already has one replaces that row; nothing else is ever updated or deleted.
-- ACCESS: reading totals/details/rules needs finance.view, changing a rule needs finance.manage (the Owner by default). No new
--   permission. A self-view for Personel is DEFERRED: it needs an explicit product decision (it reveals values and rates).
-- PRIVACY: no customer data of any kind, no ids except the staff and service ids the Owner needs to configure rules.
-- SQLSTATE: CM001 not signed in, CM002 not allowed, CM003 not found, CM004 invalid input.

begin;

create table public.staff_commission_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  staff_member_id uuid not null,
  service_id uuid not null references public.services (id),
  kind text not null check (kind in ('none', 'percentage', 'fixed')),
  percentage numeric(5, 2),
  fixed_amount numeric(10, 2),
  effective_from date not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  constraint staff_commission_rules_staff_fk foreign key (staff_member_id, tenant_id) references public.staff_members (id, tenant_id),
  constraint staff_commission_rules_value_shape check (
    (kind = 'none' and percentage is null and fixed_amount is null)
    or (kind = 'percentage' and percentage is not null and percentage between 0 and 100 and fixed_amount is null)
    or (kind = 'fixed' and fixed_amount is not null and fixed_amount between 0 and 999999.99 and percentage is null)
  ),
  constraint staff_commission_rules_date_range check (effective_from between date '2000-01-01' and date '2100-12-31'),
  constraint staff_commission_rules_one_per_day unique (tenant_id, staff_member_id, service_id, effective_from)
);

comment on table public.staff_commission_rules is
  'Faz COMM.1A. Effective-dated commission rule per staff member and service: none / percentage of the completed item value / fixed amount per completed item. Written only through public.set_commission_rule; read only through the finance.view RPCs. No rule row = no commission.';

create index staff_commission_rules_lookup_idx on public.staff_commission_rules (tenant_id, staff_member_id, service_id, effective_from desc);

alter table public.staff_commission_rules enable row level security;
revoke all on public.staff_commission_rules from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- the ONE calculation: one row per completed item in the range, with its rule and its commission
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.commission_items(p_tenant_id uuid, p_from date, p_to date)
 returns table (
   local_date date, staff_id uuid, service_id uuid, service_name text, appointment_id uuid,
   service_value numeric, rule_kind text, rule_percentage numeric, rule_fixed numeric, commission numeric, sale_discount boolean
 )
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tz text;
  v_lo timestamptz;
  v_hi timestamptz;
begin
  select t.timezone into v_tz from public.tenants t where t.id = p_tenant_id;
  v_lo := p_from::timestamp at time zone v_tz;
  v_hi := (p_to + 1)::timestamp at time zone v_tz;

  return query
  with items as materialized (
    select (ap.scheduled_start_at at time zone v_tz)::date as d,
           coalesce(asi.actual_staff_member_id, ai.actual_staff_member_id, ai.staff_member_id) as staff_id,
           ai.service_id as service_id,
           sv.name as service_name,
           ap.id as appointment_id,
           case when asi.id is not null then asi.unit_price else ai.price end as value,
           (s.id is not null and s.discount_amount > 0) as sale_discount
    from public.appointments ap
    join public.appointment_items ai on ai.appointment_id = ap.id and ai.tenant_id = p_tenant_id
    join public.services sv on sv.id = ai.service_id and sv.tenant_id = p_tenant_id
    left join public.appointment_sales s on s.appointment_id = ap.id and s.tenant_id = p_tenant_id and s.status <> 'voided'
    left join public.appointment_sale_items asi on asi.appointment_item_id = ai.id and asi.sale_id = s.id and asi.tenant_id = p_tenant_id
    where ap.tenant_id = p_tenant_id
      and ap.status = 'completed'
      and ap.scheduled_start_at >= v_lo and ap.scheduled_start_at < v_hi
  )
  select i.d, i.staff_id, i.service_id, i.service_name, i.appointment_id, i.value,
         coalesce(r.kind, 'none'), r.percentage, r.fixed_amount,
         case coalesce(r.kind, 'none')
           when 'percentage' then round(i.value * r.percentage / 100, 2)
           when 'fixed' then r.fixed_amount
           else 0::numeric
         end,
         i.sale_discount
  from items i
  left join lateral (
    select cr.kind, cr.percentage, cr.fixed_amount
    from public.staff_commission_rules cr
    where cr.tenant_id = p_tenant_id and cr.staff_member_id = i.staff_id and cr.service_id = i.service_id and cr.effective_from <= i.d
    order by cr.effective_from desc
    limit 1
  ) r on true;
end;
$function$;

revoke all on function private.commission_items(uuid, date, date) from public, anon, authenticated, service_role;

create or replace function private.commission_gate(p_tenant_id uuid, p_permission text)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tz text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'CM001';
  end if;
  if not private.has_permission(p_tenant_id, p_permission) then
    raise exception 'not allowed' using errcode = 'CM002';
  end if;
  select t.timezone into v_tz from public.tenants t where t.id = p_tenant_id and t.deleted_at is null;
  if v_tz is null then
    raise exception 'not allowed' using errcode = 'CM002';
  end if;
  return v_tz;
end;
$function$;

revoke all on function private.commission_gate(uuid, text) from public, anon, authenticated, service_role;

-- the range: default today (tenant-local); at most 366 days; from <= to
create or replace function private.commission_range(p_tz text, p_from date, p_to date)
 returns date[]
 language plpgsql
 stable
 set search_path to ''
as $function$
declare
  v_today date := (now() at time zone p_tz)::date;
  v_from date := coalesce(p_from, coalesce(p_to, v_today));
  v_to date := coalesce(p_to, coalesce(p_from, v_today));
begin
  if v_from > v_to or v_to - v_from > 365
     or v_from not between date '2000-01-01' and date '2100-12-31' or v_to not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'invalid range' using errcode = 'CM004';
  end if;
  return array[v_from, v_to];
end;
$function$;

revoke all on function private.commission_range(text, date, date) from public, anon, authenticated, service_role;

create or replace function private.staff_commission_summary(p_tenant_id uuid, p_from date, p_to date)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.commission_gate(p_tenant_id, 'finance.view');
  v_range date[] := private.commission_range(v_tz, p_from, p_to);
begin
  return (
    with c as materialized (select * from private.commission_items(p_tenant_id, v_range[1], v_range[2])),
    per as (
      select c.staff_id, count(*) as items, count(distinct c.appointment_id) as appts,
             sum(c.service_value) as value, sum(c.commission) as commission
      from c group by c.staff_id
    )
    select jsonb_build_object(
      'from', v_range[1], 'to', v_range[2], 'timezone', v_tz,
      'currency', (select t.currency from public.tenants t where t.id = p_tenant_id),
      'basis', 'completed_service_value',
      'staff', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'staffId', per.staff_id, 'displayName', sm.full_name,
                 'completedServices', per.items, 'completedAppointments', per.appts,
                 'serviceAmount', per.value, 'commissionAmount', per.commission
               ) order by per.commission desc, sm.full_name)
        from per join public.staff_members sm on sm.id = per.staff_id and sm.tenant_id = p_tenant_id
      ), '[]'::jsonb),
      'totals', (select jsonb_build_object(
                   'completedServices', coalesce(sum(per.items), 0), 'serviceAmount', coalesce(sum(per.value), 0),
                   'commissionAmount', coalesce(sum(per.commission), 0)) from per)
    )
  );
end;
$function$;

create or replace function private.staff_commission_detail(p_tenant_id uuid, p_staff_id uuid, p_from date, p_to date, p_limit integer)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.commission_gate(p_tenant_id, 'finance.view');
  v_range date[] := private.commission_range(v_tz, p_from, p_to);
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if not exists (select 1 from public.staff_members sm where sm.id = p_staff_id and sm.tenant_id = p_tenant_id) then
    raise exception 'not found' using errcode = 'CM003';
  end if;
  return (
    with c as materialized (
      select * from private.commission_items(p_tenant_id, v_range[1], v_range[2]) i where i.staff_id = p_staff_id
    ),
    lim as (select * from c order by c.local_date desc, c.service_name, c.appointment_id limit v_limit)
    select jsonb_build_object(
      'from', v_range[1], 'to', v_range[2],
      'currency', (select t.currency from public.tenants t where t.id = p_tenant_id),
      'displayName', (select sm.full_name from public.staff_members sm where sm.id = p_staff_id and sm.tenant_id = p_tenant_id),
      'total', (select jsonb_build_object('serviceAmount', coalesce(sum(c.service_value), 0), 'commissionAmount', coalesce(sum(c.commission), 0), 'rows', count(*)) from c),
      'hasMore', (select count(*) from c) > v_limit,
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'date', l.local_date, 'service', l.service_name, 'serviceValue', l.service_value,
                 'rule', jsonb_build_object('kind', l.rule_kind, 'percentage', l.rule_percentage, 'fixedAmount', l.rule_fixed),
                 'commission', l.commission, 'saleDiscount', l.sale_discount
               ) order by l.local_date desc, l.service_name, l.appointment_id)
        from lim l), '[]'::jsonb)
    )
  );
end;
$function$;

-- the rules in force TODAY (tenant-local), for the configuration screen; also every staff member and service of the salon
create or replace function private.list_commission_rules(p_tenant_id uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.commission_gate(p_tenant_id, 'finance.view');
  v_today date := (now() at time zone v_tz)::date;
begin
  return jsonb_build_object(
    'today', v_today,
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object(
               'staffId', cr.staff_member_id, 'staffName', sm.full_name, 'serviceId', cr.service_id, 'serviceName', sv.name,
               'kind', cr.kind, 'percentage', cr.percentage, 'fixedAmount', cr.fixed_amount, 'effectiveFrom', cr.effective_from
             ) order by sm.full_name, sv.name)
      from (
        select distinct on (r.staff_member_id, r.service_id) r.*
        from public.staff_commission_rules r
        where r.tenant_id = p_tenant_id and r.effective_from <= v_today
        order by r.staff_member_id, r.service_id, r.effective_from desc
      ) cr
      join public.staff_members sm on sm.id = cr.staff_member_id and sm.tenant_id = p_tenant_id
      join public.services sv on sv.id = cr.service_id and sv.tenant_id = p_tenant_id
      where cr.kind <> 'none'
    ), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', sm.id, 'name', sm.full_name) order by sm.full_name)
                       from public.staff_members sm where sm.tenant_id = p_tenant_id and sm.deleted_at is null and sm.status = 'active'), '[]'::jsonb),
    'services', coalesce((select jsonb_agg(jsonb_build_object('id', sv.id, 'name', sv.name) order by sv.name)
                          from public.services sv where sv.tenant_id = p_tenant_id and sv.deleted_at is null and sv.status = 'active'), '[]'::jsonb)
  );
end;
$function$;

create or replace function private.set_commission_rule(
  p_tenant_id uuid, p_staff_id uuid, p_service_id uuid, p_kind text, p_value numeric, p_effective_from date
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_tz text := private.commission_gate(p_tenant_id, 'finance.manage');
  v_from date := coalesce(p_effective_from, (now() at time zone v_tz)::date);
  v_pct numeric(5, 2);
  v_fix numeric(10, 2);
begin
  if p_kind not in ('none', 'percentage', 'fixed') then
    raise exception 'invalid kind' using errcode = 'CM004';
  end if;
  if v_from not between date '2000-01-01' and ((now() at time zone v_tz)::date + 366) then
    raise exception 'invalid date' using errcode = 'CM004';
  end if;
  if not exists (select 1 from public.staff_members sm where sm.id = p_staff_id and sm.tenant_id = p_tenant_id and sm.deleted_at is null) then
    raise exception 'unknown staff' using errcode = 'CM003';
  end if;
  if not exists (select 1 from public.services sv where sv.id = p_service_id and sv.tenant_id = p_tenant_id and sv.deleted_at is null) then
    raise exception 'unknown service' using errcode = 'CM003';
  end if;
  if p_kind = 'percentage' then
    if p_value is null or p_value < 0 or p_value > 100 or p_value <> round(p_value, 2) then
      raise exception 'invalid percentage' using errcode = 'CM004';
    end if;
    v_pct := p_value;
  elsif p_kind = 'fixed' then
    if p_value is null or p_value < 0 or p_value > 999999.99 or p_value <> round(p_value, 2) then
      raise exception 'invalid amount' using errcode = 'CM004';
    end if;
    v_fix := p_value;
  elsif p_value is not null then
    raise exception 'none takes no value' using errcode = 'CM004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':commission', 0));

  insert into public.staff_commission_rules (tenant_id, staff_member_id, service_id, kind, percentage, fixed_amount, effective_from, created_by)
  values (p_tenant_id, p_staff_id, p_service_id, p_kind, v_pct, v_fix, v_from, auth.uid())
  on conflict (tenant_id, staff_member_id, service_id, effective_from)
  do update set kind = excluded.kind, percentage = excluded.percentage, fixed_amount = excluded.fixed_amount, created_by = excluded.created_by, created_at = now();

  perform private.log_audit_event(
    p_tenant_id, 'commission.rule_set', 'staff_commission_rules', p_tenant_id, null,
    jsonb_build_object('kind', p_kind, 'percentage', v_pct, 'fixedAmount', v_fix, 'effectiveFrom', v_from)
  );

  return jsonb_build_object('kind', p_kind, 'percentage', v_pct, 'fixedAmount', v_fix, 'effectiveFrom', v_from);
end;
$function$;

revoke all on function private.staff_commission_summary(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function private.staff_commission_detail(uuid, uuid, date, date, integer) from public, anon, authenticated, service_role;
revoke all on function private.list_commission_rules(uuid) from public, anon, authenticated, service_role;
revoke all on function private.set_commission_rule(uuid, uuid, uuid, text, numeric, date) from public, anon, authenticated, service_role;

create or replace function public.get_staff_commission(p_tenant_id uuid, p_from date default null, p_to date default null)
 returns jsonb language sql stable security definer set search_path to ''
as $function$ select private.staff_commission_summary(p_tenant_id, p_from, p_to); $function$;

create or replace function public.get_staff_commission_detail(p_tenant_id uuid, p_staff_id uuid, p_from date default null, p_to date default null, p_limit integer default 200)
 returns jsonb language sql stable security definer set search_path to ''
as $function$ select private.staff_commission_detail(p_tenant_id, p_staff_id, p_from, p_to, p_limit); $function$;

create or replace function public.list_commission_rules(p_tenant_id uuid)
 returns jsonb language sql stable security definer set search_path to ''
as $function$ select private.list_commission_rules(p_tenant_id); $function$;

create or replace function public.set_commission_rule(p_tenant_id uuid, p_staff_id uuid, p_service_id uuid, p_kind text, p_value numeric default null, p_effective_from date default null)
 returns jsonb language sql security definer set search_path to ''
as $function$ select private.set_commission_rule(p_tenant_id, p_staff_id, p_service_id, p_kind, p_value, p_effective_from); $function$;

revoke all on function public.get_staff_commission(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.get_staff_commission_detail(uuid, uuid, date, date, integer) from public, anon, authenticated, service_role;
revoke all on function public.list_commission_rules(uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_commission_rule(uuid, uuid, uuid, text, numeric, date) from public, anon, authenticated, service_role;
grant execute on function public.get_staff_commission(uuid, date, date) to authenticated;
grant execute on function public.get_staff_commission_detail(uuid, uuid, date, date, integer) to authenticated;
grant execute on function public.list_commission_rules(uuid) to authenticated;
grant execute on function public.set_commission_rule(uuid, uuid, uuid, text, numeric, date) to authenticated;

commit;
