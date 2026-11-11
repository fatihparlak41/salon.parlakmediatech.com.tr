-- SAAS.1C.1 (3/3) - billing read model: derived access state, usage, limits, entitlement, the salon's own safe summary, Super Admin billing reads.
-- READ ONLY and ENFORCEMENT-FREE: no function here writes, and none is wired into any write path or into public booking. The access state is
-- COMPUTED AND SHOWN; whether it would ever restrict anything is decided later behind the release gate `billing_enforcement` (OFF).
--
-- Pattern (as in SAAS.1B): private core functions, executable by NO api role; thin public SECURITY DEFINER wrappers, executable by
-- `authenticated` only; every wrapper starts with an explicit auth.uid() + role check; search_path = '' everywhere; explicit revokes then grants.
--   * public.get_my_billing_summary(tenant)    : a salon Owner / Yönetici (settings.manage or staff.manage) reads THEIR OWN safe summary
--   * public.admin_billing_dashboard / admin_billing_list / admin_tenant_billing : platform administrators only (private.admin_require)
-- Never returned: provider ids, price overrides, event bodies to tenants, customer data, e-mail addresses.
--
-- Access-state truth table (first match wins; `now` = the evaluation instant):
--   tenant deleted                                   -> blocked  tenant_deleted
--   tenant.status suspended / canceled               -> blocked  suspended_by_platform / tenant_canceled
--   no subscription row                              -> full     no_subscription               (fail-open)
--   billing_mode pilot|internal|complimentary + status active -> full  pilot|internal|complimentary   (never expires)
--   status trialing, trial not started               -> full     trial_not_started
--   status trialing, now <  trial_ends_at            -> full     trial_active  (trialEnding = true in the last 7 days)
--   status trialing, now <  grace_ends_at            -> grace    trial_expired_grace
--   status trialing, otherwise                       -> read_only trial_expired
--   status active, no period end                     -> full     active
--   status active, now <= period end                 -> full     active | cancel_scheduled (cancel_at_period_end)
--   status active, now <  period end + 14 days       -> grace    renewal_overdue  (cancel_at_period_end -> read_only period_ended_canceled)
--   status active, otherwise                         -> read_only renewal_overdue_expired
--   status past_due: now < coalesce(grace_ends_at, period end + 14 d) -> grace past_due, else read_only past_due_expired
--   status canceled: before period end -> full cancel_scheduled; else read_only canceled
--   status expired                                   -> read_only expired
--
-- ROLLBACK: drop function public.get_my_billing_summary(uuid), public.admin_billing_dashboard(), public.admin_billing_list(text, text),
--   public.admin_tenant_billing(uuid), then the private functions created here (tenant_billing_summary, tenant_effective_online_booking,
--   tenant_entitlement, tenant_limit_status, tenant_limit, tenant_usage, tenant_access_state, tenant_access_state_at, billing_enforcement_enabled).

create or replace function private.billing_enforcement_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((select g.enabled from private.release_gates g where g.key = 'billing_enforcement'), false);
$function$;

create or replace function private.tenant_access_state_at(p_tenant_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_t record;
  v_s record;
  v_mode text;
  v_reason text;
  v_days integer;
  v_ending boolean := false;
  v_renew_grace timestamptz;
begin
  select t.status, t.deleted_at into v_t from public.tenants t where t.id = p_tenant_id;
  if not found then
    return null;
  end if;

  select s.status, s.billing_mode, s.trial_started_at, s.trial_ends_at, s.grace_ends_at, s.current_period_end, s.cancel_at_period_end, p.key as plan_key
    into v_s
    from public.subscriptions s join public.plans p on p.id = s.plan_id
   where s.tenant_id = p_tenant_id;

  if v_t.deleted_at is not null then
    v_mode := 'blocked'; v_reason := 'tenant_deleted';
  elsif v_t.status = 'suspended' then
    v_mode := 'blocked'; v_reason := 'suspended_by_platform';
  elsif v_t.status = 'canceled' then
    v_mode := 'blocked'; v_reason := 'tenant_canceled';
  elsif v_s.status is null then
    v_mode := 'full'; v_reason := 'no_subscription';
  elsif v_s.billing_mode <> 'paid' and v_s.status = 'active' then
    v_mode := 'full'; v_reason := v_s.billing_mode;
  elsif v_s.status = 'trialing' then
    if v_s.trial_started_at is null then
      v_mode := 'full'; v_reason := 'trial_not_started';
    elsif p_now < v_s.trial_ends_at then
      v_mode := 'full'; v_reason := 'trial_active';
      v_days := ceil(extract(epoch from (v_s.trial_ends_at - p_now)) / 86400)::integer;
      v_ending := v_s.trial_ends_at - p_now <= interval '7 days';
    elsif p_now < v_s.grace_ends_at then
      v_mode := 'grace'; v_reason := 'trial_expired_grace';
      v_days := ceil(extract(epoch from (v_s.grace_ends_at - p_now)) / 86400)::integer;
    else
      v_mode := 'read_only'; v_reason := 'trial_expired';
    end if;
  elsif v_s.status = 'active' then
    if v_s.current_period_end is null then
      v_mode := 'full'; v_reason := 'active';
    elsif p_now <= v_s.current_period_end then
      v_mode := 'full'; v_reason := case when v_s.cancel_at_period_end then 'cancel_scheduled' else 'active' end;
    elsif v_s.cancel_at_period_end then
      v_mode := 'read_only'; v_reason := 'period_ended_canceled';
    else
      v_renew_grace := v_s.current_period_end + interval '336 hours';
      if p_now < v_renew_grace then
        v_mode := 'grace'; v_reason := 'renewal_overdue';
        v_days := ceil(extract(epoch from (v_renew_grace - p_now)) / 86400)::integer;
      else
        v_mode := 'read_only'; v_reason := 'renewal_overdue_expired';
      end if;
    end if;
  elsif v_s.status = 'past_due' then
    v_renew_grace := coalesce(v_s.grace_ends_at, v_s.current_period_end + interval '336 hours');
    if v_renew_grace is null or p_now < v_renew_grace then
      v_mode := 'grace'; v_reason := 'past_due';
      if v_renew_grace is not null then
        v_days := ceil(extract(epoch from (v_renew_grace - p_now)) / 86400)::integer;
      end if;
    else
      v_mode := 'read_only'; v_reason := 'past_due_expired';
    end if;
  elsif v_s.status = 'canceled' then
    if v_s.current_period_end is not null and p_now < v_s.current_period_end then
      v_mode := 'full'; v_reason := 'cancel_scheduled';
    else
      v_mode := 'read_only'; v_reason := 'canceled';
    end if;
  else
    v_mode := 'read_only'; v_reason := 'expired';
  end if;

  return jsonb_build_object(
    'mode', v_mode,
    'reason', v_reason,
    'daysRemaining', v_days,
    'trialEnding', v_ending,
    'status', v_s.status,
    'billingMode', v_s.billing_mode,
    'planKey', v_s.plan_key,
    'trialStartedAt', v_s.trial_started_at,
    'trialEndsAt', v_s.trial_ends_at,
    'graceEndsAt', v_s.grace_ends_at,
    'cancelAtPeriodEnd', coalesce(v_s.cancel_at_period_end, false),
    'currentPeriodEnd', v_s.current_period_end,
    'enforcementEnabled', private.billing_enforcement_enabled()
  );
end;
$function$;

create or replace function private.tenant_access_state(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.tenant_access_state_at(p_tenant_id, now());
$function$;

create or replace function private.tenant_usage(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'activeStaff', (select count(*) from public.staff_members x where x.tenant_id = p_tenant_id and x.status = 'active' and x.deleted_at is null),
    'branches', (select count(*) from public.branches x where x.tenant_id = p_tenant_id and x.deleted_at is null),
    'services', (select count(*) from public.services x where x.tenant_id = p_tenant_id and x.deleted_at is null),
    'customers', (select count(*) from public.customers x where x.tenant_id = p_tenant_id),
    'activeMembers', (select count(*) from public.tenant_memberships x where x.tenant_id = p_tenant_id and x.status = 'active'),
    'appointmentsTotal', (select count(*) from public.appointments x where x.tenant_id = p_tenant_id),
    'appointmentsCreated30d', (select count(*) from public.appointments x where x.tenant_id = p_tenant_id and x.created_at >= now() - interval '30 days'),
    'treatmentPhotos', (select count(*) from public.treatment_media x where x.tenant_id = p_tenant_id),
    'treatmentPhotoBytes', (select coalesce(sum(x.size_bytes), 0) from public.treatment_media x where x.tenant_id = p_tenant_id),
    'emailsSent30d', (select count(*) from private.customer_notification_jobs x where x.tenant_id = p_tenant_id and x.status = 'sent' and x.sent_at >= now() - interval '30 days')
  );
$function$;

create or replace function private.tenant_limit(p_tenant_id uuid, p_limit_key text)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select pl.limit_value
    from public.subscriptions s
    join public.plan_limits pl on pl.plan_id = s.plan_id and pl.limit_key = p_limit_key
   where s.tenant_id = p_tenant_id;
$function$;

create or replace function private.tenant_limit_status(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with u as (select private.tenant_usage(p_tenant_id) as j),
  rows as (
    select pl.limit_key, pl.limit_value, pl.enforcement,
           case pl.limit_key
             when 'max_active_staff' then (u.j ->> 'activeStaff')::integer
             when 'max_branches' then (u.j ->> 'branches')::integer
           end as used
      from public.subscriptions s
      join public.plan_limits pl on pl.plan_id = s.plan_id
      cross join u
     where s.tenant_id = p_tenant_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', r.limit_key,
           'used', r.used,
           'limit', r.limit_value,
           'enforcement', r.enforcement,
           'state', case when r.used > r.limit_value then 'over' when r.used = r.limit_value then 'at_limit' else 'ok' end
         ) order by r.limit_key), '[]'::jsonb)
    from rows r;
$function$;

-- Entitlement = the module exists AND (a platform override says so, else the plan includes it). It does NOT include the salon's own switch
-- and it does not look at the access state: that combination is tenant_effective_online_booking below.
create or replace function private.tenant_entitlement(p_tenant_id uuid, p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select f.is_available
              and coalesce(
                    (select o.enabled from public.tenant_entitlement_overrides o where o.tenant_id = p_tenant_id and o.feature_id = f.id),
                    exists (select 1 from public.subscriptions s join public.plan_features pf on pf.plan_id = s.plan_id
                             where s.tenant_id = p_tenant_id and pf.feature_id = f.id)
                  )
       from public.features f where f.key = p_feature_key),
    false);
$function$;

-- PREPARED for the later enforcement phase, NOT wired into public booking in 1C.1: the salon's own switch AND the platform entitlement.
-- While the release gate is OFF it is exactly the salon's own switch (today's behaviour), whatever the subscription says.
create or replace function private.tenant_effective_online_booking(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.has_feature(p_tenant_id, 'online_booking')
         and (
           not private.billing_enforcement_enabled()
           or (
             private.tenant_entitlement(p_tenant_id, 'online_booking')
             and (private.tenant_access_state(p_tenant_id) ->> 'mode') in ('full', 'grace')
           )
         );
$function$;

create or replace function private.tenant_billing_summary(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'planKey', p.key,
    'planName', p.name,
    'accessState', private.tenant_access_state(p_tenant_id),
    'usage', private.tenant_usage(p_tenant_id),
    'limits', private.tenant_limit_status(p_tenant_id)
  )
  from public.subscriptions s join public.plans p on p.id = s.plan_id
  where s.tenant_id = p_tenant_id;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- Super Admin reads (platform administrators only)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.admin_billing_rows()
returns table (
  tenant_id uuid, name text, slug text, tenant_status text, plan_key text, billing_mode text, sub_status text,
  access_mode text, access_reason text, days_remaining integer, trial_ending boolean, trial_ends_at timestamptz,
  grace_ends_at timestamptz, over_limit boolean, at_limit boolean, ready_trial_not_started boolean
)
language sql
stable
security definer
set search_path = ''
as $function$
  with base as (
    select t.id, t.name, t.slug, t.status as tenant_status, p.key as plan_key, s.billing_mode, s.status as sub_status,
           s.trial_ends_at, s.grace_ends_at, s.trial_started_at,
           private.tenant_access_state(t.id) as acc,
           private.tenant_limit_status(t.id) as lim
      from public.tenants t
      left join public.subscriptions s on s.tenant_id = t.id
      left join public.plans p on p.id = s.plan_id
     where t.deleted_at is null
  )
  select b.id, b.name, b.slug, b.tenant_status, b.plan_key, b.billing_mode, b.sub_status,
         b.acc ->> 'mode', b.acc ->> 'reason', (b.acc ->> 'daysRemaining')::integer, coalesce((b.acc ->> 'trialEnding')::boolean, false),
         b.trial_ends_at, b.grace_ends_at,
         exists (select 1 from jsonb_array_elements(b.lim) e where e ->> 'state' = 'over'),
         -- only a SOFT limit being reached is worth a flag: every salon has exactly one branch, which is the hard design limit of 1 and always 'at_limit'
         exists (select 1 from jsonb_array_elements(b.lim) e where e ->> 'state' = 'at_limit' and e ->> 'enforcement' = 'soft'),
         case when b.sub_status = 'trialing' and b.billing_mode = 'paid' and b.trial_started_at is null
              then coalesce((private.onboarding_status(b.id) ->> 'ready')::boolean, false)
              else false end
    from base b
   order by b.name;
$function$;

create or replace function private.admin_billing_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_res jsonb;
begin
  perform private.admin_require();
  select jsonb_build_object(
    'total', count(*),
    'trialNotStarted', count(*) filter (where access_reason = 'trial_not_started'),
    'trialActive', count(*) filter (where access_reason = 'trial_active'),
    'trialEnding', count(*) filter (where trial_ending),
    'grace', count(*) filter (where access_mode = 'grace'),
    'readOnly', count(*) filter (where access_mode = 'read_only'),
    'blocked', count(*) filter (where access_mode = 'blocked'),
    'paidActive', count(*) filter (where billing_mode = 'paid' and sub_status = 'active'),
    'pilot', count(*) filter (where billing_mode = 'pilot'),
    'complimentary', count(*) filter (where billing_mode = 'complimentary'),
    'internal', count(*) filter (where billing_mode = 'internal'),
    'noSubscription', count(*) filter (where plan_key is null),
    'overLimit', count(*) filter (where over_limit),
    'readyTrialNotStarted', count(*) filter (where ready_trial_not_started),
    'enforcementEnabled', private.billing_enforcement_enabled()
  ) into v_res
  from private.admin_billing_rows();
  return v_res;
end;
$function$;

create or replace function private.admin_billing_list(p_filter text, p_search text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_filter text := coalesce(nullif(btrim(p_filter), ''), 'all');
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_res jsonb;
begin
  perform private.admin_require();
  if v_filter not in ('all', 'trial', 'trial_ending', 'grace', 'read_only', 'paid', 'pilot', 'internal', 'over_limit', 'ready_not_started') then
    raise exception 'invalid filter';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'tenantId', r.tenant_id, 'name', r.name, 'slug', r.slug, 'tenantStatus', r.tenant_status,
           'planKey', r.plan_key, 'billingMode', r.billing_mode, 'status', r.sub_status,
           'accessMode', r.access_mode, 'accessReason', r.access_reason, 'daysRemaining', r.days_remaining,
           'trialEnding', r.trial_ending, 'trialEndsAt', r.trial_ends_at, 'graceEndsAt', r.grace_ends_at,
           'overLimit', r.over_limit, 'atLimit', r.at_limit, 'readyTrialNotStarted', r.ready_trial_not_started
         ) order by r.name), '[]'::jsonb) into v_res
    from private.admin_billing_rows() r
   where (v_search is null or r.name ilike '%' || v_search || '%' or r.slug ilike '%' || v_search || '%')
     and case v_filter
           when 'all' then true
           when 'trial' then r.sub_status = 'trialing'
           when 'trial_ending' then r.trial_ending
           when 'grace' then r.access_mode = 'grace'
           when 'read_only' then r.access_mode = 'read_only'
           when 'paid' then r.billing_mode = 'paid'
           when 'pilot' then r.billing_mode = 'pilot'
           when 'internal' then r.billing_mode = 'internal'
           when 'over_limit' then r.over_limit
           when 'ready_not_started' then r.ready_trial_not_started
         end;
  return v_res;
end;
$function$;

create or replace function private.admin_tenant_billing(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_res jsonb;
begin
  perform private.admin_require();
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id and t.deleted_at is null) then
    return null;
  end if;
  select jsonb_build_object(
    'tenantId', t.id,
    'subscriptionPresent', s.id is not null,
    'planKey', p.key,
    'planName', p.name,
    'planPriceMonthly', p.price_monthly,
    'accessState', private.tenant_access_state(t.id),
    'usage', private.tenant_usage(t.id),
    'limits', private.tenant_limit_status(t.id),
    'readyTrialNotStarted', case when s.status = 'trialing' and s.billing_mode = 'paid' and s.trial_started_at is null
                                 then coalesce((private.onboarding_status(t.id) ->> 'ready')::boolean, false)
                                 else false end,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('at', e.created_at, 'type', e.event_type, 'fromStatus', e.from_status, 'toStatus', e.to_status, 'reason', e.reason) order by e.created_at desc)
        from (select * from public.subscription_events x where x.tenant_id = t.id order by x.created_at desc limit 20) e
    ), '[]'::jsonb)
  ) into v_res
  from public.tenants t
  left join public.subscriptions s on s.tenant_id = t.id
  left join public.plans p on p.id = s.plan_id
  where t.id = p_tenant_id;
  return v_res;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- Wrappers (public schema, SECURITY DEFINER, authenticated only)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.admin_billing_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.admin_billing_dashboard();
$function$;

create or replace function public.admin_billing_list(p_filter text, p_search text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.admin_billing_list(p_filter, p_search);
$function$;

create or replace function public.admin_tenant_billing(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.admin_tenant_billing(p_tenant_id);
$function$;

-- The salon's own read-only summary. Owner / Yönetici only (settings.manage or staff.manage); a non-member gets NULL-safe refusal.
create or replace function public.get_my_billing_summary(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (private.has_permission(p_tenant_id, 'settings.manage') or private.has_permission(p_tenant_id, 'staff.manage')) then
    raise exception 'not allowed';
  end if;
  return private.tenant_billing_summary(p_tenant_id);
end;
$function$;

revoke all on function private.billing_enforcement_enabled() from public, anon, authenticated, service_role;
revoke all on function private.tenant_access_state_at(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.tenant_access_state(uuid) from public, anon, authenticated, service_role;
revoke all on function private.tenant_usage(uuid) from public, anon, authenticated, service_role;
revoke all on function private.tenant_limit(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.tenant_limit_status(uuid) from public, anon, authenticated, service_role;
revoke all on function private.tenant_entitlement(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.tenant_effective_online_booking(uuid) from public, anon, authenticated, service_role;
revoke all on function private.tenant_billing_summary(uuid) from public, anon, authenticated, service_role;
revoke all on function private.admin_billing_rows() from public, anon, authenticated, service_role;
revoke all on function private.admin_billing_dashboard() from public, anon, authenticated, service_role;
revoke all on function private.admin_billing_list(text, text) from public, anon, authenticated, service_role;
revoke all on function private.admin_tenant_billing(uuid) from public, anon, authenticated, service_role;

revoke all on function public.admin_billing_dashboard() from public, anon, authenticated, service_role;
revoke all on function public.admin_billing_list(text, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_tenant_billing(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_billing_summary(uuid) from public, anon, authenticated, service_role;

grant execute on function public.admin_billing_dashboard() to authenticated;
grant execute on function public.admin_billing_list(text, text) to authenticated;
grant execute on function public.admin_tenant_billing(uuid) to authenticated;
grant execute on function public.get_my_billing_summary(uuid) to authenticated;
