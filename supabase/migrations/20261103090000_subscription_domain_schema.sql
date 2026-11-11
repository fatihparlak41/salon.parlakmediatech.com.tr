-- SAAS.1C.1 (1/3) - subscription domain schema. ADDITIVE and enforcement-free: nothing here refuses any user action.
--
-- Builds on the dormant skeleton from 20260815120010..12 (plans, features, plan_features, subscriptions, tenant_features): PROD has 0
-- subscription rows, no price, and only has_feature('online_booking') is ever consulted. This file:
--   * hardens `subscriptions` (billing_mode, trial_started_at, grace_ends_at, cancel_at_period_end, status 'expired', consistency checks);
--   * adds `plan_limits`, `subscription_events` (append-only, platform-only) and `tenant_entitlement_overrides` (platform-owned, so the
--     salon's own switch in `tenant_features` is never reused as an entitlement);
--   * adds `features.is_available` (modules that do not exist are never grantable) and the two launch plans `salon` / `salon_plus`
--     (PRICES STAY NULL: the 1,190 / 1,890 TRY figures are commercial hypotheses, not data); the legacy starter / professional / business
--     rows are kept, deactivated;
--   * closes tenant read access to `subscriptions` (provider_* ids were readable by a salon owner); tenants read a safe RPC summary instead;
--   * registers the release gate `billing_enforcement` = OFF.
-- Security: every new table has RLS ENABLED and NO policy and NO grant to anon / authenticated / service_role (deny by default); the
-- application reaches them only through SECURITY DEFINER functions of the 3rd migration. No user_metadata, no service key in the browser.
--
-- ROLLBACK (data-free: nothing existing is dropped by this file; the new objects can be removed in this order):
--   drop table public.subscription_events, public.tenant_entitlement_overrides, public.plan_limits;
--   alter table public.subscriptions drop constraint subscriptions_trial_dates_consistent, drop constraint subscriptions_nonpaid_no_trial,
--     drop constraint subscriptions_billing_mode_check, drop column billing_mode, drop column trial_started_at, drop column grace_ends_at,
--     drop column cancel_at_period_end; (then restore subscriptions_status_check without 'expired' and `grant select on public.subscriptions to authenticated`)
--   alter table public.features drop column is_available; delete from public.plans where key in ('salon','salon_plus') (after their plan_features);
--   update public.plans set is_active = true where key in ('starter','professional','business'); delete from private.release_gates where key = 'billing_enforcement';

-- ---------------------------------------------------------------------------------------------------------------
-- 1. subscriptions hardening
-- ---------------------------------------------------------------------------------------------------------------
alter table public.subscriptions
  add column billing_mode text not null default 'paid',
  add column trial_started_at timestamptz,
  add column grace_ends_at timestamptz,
  add column cancel_at_period_end boolean not null default false;

alter table public.subscriptions
  add constraint subscriptions_billing_mode_check
    check (billing_mode in ('paid', 'complimentary', 'internal', 'pilot'));

alter table public.subscriptions drop constraint subscriptions_status_check;
alter table public.subscriptions
  add constraint subscriptions_status_check
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'expired'));

-- A trial is either not started (both NULL) or fully dated; pilot / internal / complimentary accounts never carry a trial.
alter table public.subscriptions
  add constraint subscriptions_trial_dates_consistent
    check (
      (trial_started_at is null) = (trial_ends_at is null)
      and (trial_started_at is null or trial_ends_at > trial_started_at)
      and (grace_ends_at is null or trial_ends_at is null or grace_ends_at >= trial_ends_at)
    ),
  add constraint subscriptions_nonpaid_no_trial
    check (billing_mode = 'paid' or (trial_started_at is null and trial_ends_at is null));

comment on column public.subscriptions.billing_mode is
  'paid = a normal customer who will pay; complimentary = free by decision; internal = the operator''s own / demo / test salon; pilot = founding or pilot salon on a manual arrangement. Only paid carries a trial.';
comment on column public.subscriptions.trial_started_at is
  'NULL until guided onboarding first completes (private.billing_start_trial); never reset afterwards.';
comment on column public.subscriptions.grace_ends_at is
  'Stored at trial start (trial_ends_at + 14 days) so a later change of the default does not move an existing salon''s date.';

-- The salon's members must not read this table directly any more (provider_customer_id / provider_subscription_id were readable by an owner
-- through the unrestricted-holder select policy). Salon members read private.tenant_billing_summary through a SECURITY DEFINER wrapper;
-- platform administrators read through the admin_* wrappers. No write grant exists (and none is added).
revoke select on public.subscriptions from authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. features: is_available, plus the keys of the modules that really exist
-- ---------------------------------------------------------------------------------------------------------------
alter table public.features add column is_available boolean not null default true;
comment on column public.features.is_available is
  'false = the module does not exist in the product yet; it can never be granted by a plan or an override.';

insert into public.features (key, name, category) values
  ('customer_notifications', 'Müşteri Bildirimleri (e-posta)', 'marketing'),
  ('treatment_history', 'İşlem Geçmişi ve Fotoğraflar', 'operations'),
  ('customer_import', 'Müşteri İçe Aktarma', 'operations')
on conflict (key) do nothing;

update public.features set is_available = false
where key in ('inventory', 'color_formulas', 'whatsapp', 'loyalty', 'packages', 'memberships', 'multi_branch');

-- ---------------------------------------------------------------------------------------------------------------
-- 3. plans: launch plans (prices NULL on purpose) and legacy plans kept, deactivated
-- ---------------------------------------------------------------------------------------------------------------
update public.plans set is_active = false where key in ('starter', 'professional', 'business');

insert into public.plans (key, name, description, price_monthly, price_yearly, currency, is_active, sort_order) values
  ('salon', 'Salon', 'Tek şubeli salon: tüm mevcut modüller, 5 aktif personele kadar.', null, null, 'TRY', true, 10),
  ('salon_plus', 'Salon Plus', 'Tek şubeli salon: tüm mevcut modüller, 12 aktif personele kadar.', null, null, 'TRY', true, 11)
on conflict (key) do nothing;

insert into public.plan_features (plan_id, feature_id)
select p.id, f.id
from public.plans p
cross join public.features f
where p.key in ('salon', 'salon_plus') and f.is_available
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. plan_limits (catalogue data; soft = warn + signal, hard = a design constraint; NO enforcement in 1C.1)
-- ---------------------------------------------------------------------------------------------------------------
create table public.plan_limits (
  plan_id uuid not null references public.plans (id) on delete cascade,
  limit_key text not null check (limit_key in ('max_active_staff', 'max_branches')),
  limit_value integer not null check (limit_value >= 0),
  enforcement text not null check (enforcement in ('soft', 'hard')),
  primary key (plan_id, limit_key)
);
alter table public.plan_limits enable row level security;
revoke all on public.plan_limits from public, anon, authenticated, service_role;
comment on table public.plan_limits is
  'Only commercially meaningful limits exist: active staff (soft: warn, never block) and branches (hard: one). Deliberately NO appointments/month, customers or services limits.';

insert into public.plan_limits (plan_id, limit_key, limit_value, enforcement)
select p.id, v.k, v.val, v.e
from public.plans p
join (values
  ('salon', 'max_active_staff', 5, 'soft'),
  ('salon', 'max_branches', 1, 'hard'),
  ('salon_plus', 'max_active_staff', 12, 'soft'),
  ('salon_plus', 'max_branches', 1, 'hard')
) as v(plan_key, k, val, e) on v.plan_key = p.key;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. subscription_events: append-only history, platform-only
-- ---------------------------------------------------------------------------------------------------------------
create table public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  subscription_id uuid references public.subscriptions (id),
  event_type text not null check (event_type in ('created', 'backfilled', 'trial_started', 'status_changed', 'plan_changed', 'billing_mode_changed', 'override_changed', 'note')),
  from_status text,
  to_status text,
  from_plan_id uuid references public.plans (id),
  to_plan_id uuid references public.plans (id),
  actor_user_id uuid,
  reason text check (reason is null or char_length(reason) <= 500),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index subscription_events_tenant_created_idx on public.subscription_events (tenant_id, created_at desc);
alter table public.subscription_events enable row level security;
revoke all on public.subscription_events from public, anon, authenticated, service_role;

create or replace function private.subscription_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'subscription_events is append-only';
end;
$function$;
revoke all on function private.subscription_events_append_only() from public, anon, authenticated, service_role;
create trigger subscription_events_append_only
  before update or delete on public.subscription_events
  for each row execute function private.subscription_events_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- 6. tenant_entitlement_overrides: platform-owned; the salon's own switch stays in tenant_features
-- ---------------------------------------------------------------------------------------------------------------
create table public.tenant_entitlement_overrides (
  tenant_id uuid not null references public.tenants (id),
  feature_id uuid not null references public.features (id),
  enabled boolean not null,
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  granted_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, feature_id)
);
alter table public.tenant_entitlement_overrides enable row level security;
revoke all on public.tenant_entitlement_overrides from public, anon, authenticated, service_role;
create trigger set_updated_at
  before update on public.tenant_entitlement_overrides
  for each row execute function public.set_updated_at();
comment on table public.tenant_entitlement_overrides is
  'Platform-granted entitlement exceptions (written only by future audited platform-owner RPCs). Never a tenant switch: tenant_features keeps the salon''s own on/off settings.';

-- ---------------------------------------------------------------------------------------------------------------
-- 7. release gate: billing enforcement stays OFF in 1C.1 (consulted by the read model; nothing refuses anything)
-- ---------------------------------------------------------------------------------------------------------------
insert into private.release_gates (key, enabled) values ('billing_enforcement', false) on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 8. has_feature('online_booking') must stay the SALON'S OWN SWITCH
-- ---------------------------------------------------------------------------------------------------------------
-- private.has_feature falls back to the subscription's plan_features when a salon has no tenant_features row. That fallback was dead code
-- (0 subscriptions) until this release; once every tenant has a subscription on a plan that INCLUDES online_booking it would silently turn the
-- public booking page ON for every salon that never switched it on (and for every new sign-up). The salon's switch is the only truth for
-- online_booking; the plan entitlement lives in private.tenant_entitlement and is combined with the switch only later, behind the release
-- gate. Every other feature key keeps the previous behaviour unchanged. (Only the one added predicate differs from the previous body.)
create or replace function private.has_feature(p_tenant_id uuid, p_feature_key text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select coalesce(
    (
      select tf.enabled
      from public.tenant_features tf
      join public.features f on f.id = tf.feature_id
      where tf.tenant_id = p_tenant_id
        and f.key = p_feature_key
    ),
    (
      select true
      from public.subscriptions s
      join public.plan_features pf on pf.plan_id = s.plan_id
      join public.features f on f.id = pf.feature_id
      where s.tenant_id = p_tenant_id
        and f.key = p_feature_key
        and f.key <> 'online_booking'
    ),
    false
  );
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- 9. the plan catalogue is not writable through the Data API any more
-- ---------------------------------------------------------------------------------------------------------------
-- plans / features / plan_features carried INSERT / UPDATE grants for `authenticated` (guarded only by a platform-owner policy). The
-- application never uses them; commercial data must change only through migrations or, later, audited platform-owner RPCs. Reads stay.
revoke insert, update on public.plans from authenticated;
revoke insert, update on public.features from authenticated;
revoke insert, delete on public.plan_features from authenticated;
-- ROLLBACK for this section: grant insert, update on public.plans to authenticated; grant insert, update on public.features to authenticated; grant insert, delete on public.plan_features to authenticated;
