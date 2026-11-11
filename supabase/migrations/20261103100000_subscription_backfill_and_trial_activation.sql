-- SAAS.1C.1 (2/3) - existing-tenant backfill, subscription creation on tenant create, trial activation on first onboarding completion.
-- Enforcement is OFF (release gate `billing_enforcement`), so nothing here can refuse a user action; the rows only describe state.
--
-- Backfill rule (idempotent: a tenant that already has a subscription is never touched; deleted tenants are skipped = fail-open):
--   * the operator's own internal salon (slug fatih-parlak)             -> plan salon, billing_mode internal, status active, NO dates
--   * every other tenant that has real business data (staff, services,
--     customers or appointments)                                        -> plan salon, billing_mode pilot,    status active, NO dates (never expires)
--   * a tenant with none of that (an abandoned sign-up)                 -> plan salon, billing_mode paid,     status trialing, trial NOT started (NULL dates)
-- `tenants.status`, `tenant_features` and every business table are untouched.
--
-- Trial activation (the Owner's rule): creating a tenant inserts a subscription row in the SAME transaction but starts no trial; the trial
-- (30 days, then 14 days grace, in exact hours so DST cannot move it) starts atomically, once, the first time guided onboarding reports
-- `ready` through one of its RPCs or through the online-booking switch. Re-running onboarding never resets it (a row with a start date is
-- never touched again; pilot / internal / complimentary rows never start a trial). Direct table edits outside these RPCs do not start the
-- trial; Super Admin shows such a salon ("ready but trial not started") so it can never be silently free forever.
--
-- ROLLBACK: restore the previous bodies of create_tenant_with_owner, set_online_booking_enabled and the five onboarding RPCs from the
-- migration chain (they differ only by one added line each), then
--   delete from public.subscription_events where event_type in ('created','backfilled','trial_started');  -- needs: alter table ... disable trigger subscription_events_append_only
--   delete from public.subscriptions;  drop function private.onboarding_finish(uuid), private.billing_start_trial(uuid),
--   private.billing_create_default_subscription(uuid), private.billing_backfill_existing_tenants(), private.billing_log_event(uuid,uuid,text,text,text,uuid,uuid,text,jsonb);

create or replace function private.billing_log_event(
  p_tenant_id uuid,
  p_subscription_id uuid,
  p_type text,
  p_from_status text,
  p_to_status text,
  p_from_plan uuid,
  p_to_plan uuid,
  p_reason text,
  p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.subscription_events (tenant_id, subscription_id, event_type, from_status, to_status, from_plan_id, to_plan_id, actor_user_id, reason, metadata)
  values (p_tenant_id, p_subscription_id, p_type, p_from_status, p_to_status, p_from_plan, p_to_plan, auth.uid(), p_reason, coalesce(p_metadata, '{}'::jsonb));
end;
$function$;

create or replace function private.billing_create_default_subscription(p_tenant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan uuid;
  v_id uuid;
begin
  select id into v_plan from public.plans where key = 'salon';
  if v_plan is null then
    -- fail-open: a missing catalogue row must never break tenant creation (a tenant without a subscription simply has full access)
    raise warning 'billing: plan "salon" is missing; no subscription created for tenant %', p_tenant_id;
    return null;
  end if;
  insert into public.subscriptions (tenant_id, plan_id, status, billing_mode)
  values (p_tenant_id, v_plan, 'trialing', 'paid')
  on conflict (tenant_id) do nothing
  returning id into v_id;
  if v_id is not null then
    perform private.billing_log_event(p_tenant_id, v_id, 'created', null, 'trialing', null, v_plan, null, jsonb_build_object('trial', 'not_started'));
  end if;
  return v_id;
end;
$function$;

create or replace function private.billing_start_trial(p_tenant_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sub public.subscriptions%rowtype;
  v_start timestamptz := now();
  v_ends timestamptz;
begin
  select * into v_sub from public.subscriptions where tenant_id = p_tenant_id for update;
  if not found then
    return false;
  end if;
  if v_sub.billing_mode <> 'paid' or v_sub.status <> 'trialing' or v_sub.trial_started_at is not null then
    return false;
  end if;
  v_ends := v_start + interval '720 hours';
  update public.subscriptions
     set trial_started_at = v_start,
         trial_ends_at = v_ends,
         grace_ends_at = v_ends + interval '336 hours'
   where id = v_sub.id and trial_started_at is null;
  perform private.billing_log_event(p_tenant_id, v_sub.id, 'trial_started', 'trialing', 'trialing', null, null, 'guided onboarding completed',
    jsonb_build_object('trialDays', 30, 'graceDays', 14));
  return true;
end;
$function$;

-- Returns exactly what private.onboarding_status returns (so every RPC response is unchanged) and, the first time the salon is ready,
-- starts the trial in the same transaction.
create or replace function private.onboarding_finish(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status jsonb := private.onboarding_status(p_tenant_id);
begin
  if v_status is not null and coalesce((v_status ->> 'ready')::boolean, false) then
    perform private.billing_start_trial(p_tenant_id);
  end if;
  return v_status;
end;
$function$;

create or replace function private.billing_backfill_existing_tenants()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan uuid;
  v_n integer := 0;
  v_id uuid;
  r record;
  v_mode text;
  v_status text;
  v_rule text;
begin
  select id into v_plan from public.plans where key = 'salon';
  if v_plan is null then
    raise exception 'plan "salon" is missing';
  end if;
  for r in
    select t.id, t.slug,
           (exists (select 1 from public.staff_members x where x.tenant_id = t.id)
            or exists (select 1 from public.services x where x.tenant_id = t.id)
            or exists (select 1 from public.customers x where x.tenant_id = t.id)
            or exists (select 1 from public.appointments x where x.tenant_id = t.id)) as has_data
    from public.tenants t
    where t.deleted_at is null
      and not exists (select 1 from public.subscriptions s where s.tenant_id = t.id)
    order by t.created_at
  loop
    if r.slug = 'fatih-parlak' then
      v_mode := 'internal'; v_status := 'active'; v_rule := 'operator_internal_salon';
    elsif r.has_data then
      v_mode := 'pilot'; v_status := 'active'; v_rule := 'has_business_data';
    else
      v_mode := 'paid'; v_status := 'trialing'; v_rule := 'abandoned_signup_trial_not_started';
    end if;
    insert into public.subscriptions (tenant_id, plan_id, status, billing_mode)
    values (r.id, v_plan, v_status, v_mode)
    returning id into v_id;
    perform private.billing_log_event(r.id, v_id, 'backfilled', null, v_status, null, v_plan, null,
      jsonb_build_object('billingMode', v_mode, 'rule', v_rule));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$function$;

revoke all on function private.billing_log_event(uuid, uuid, text, text, text, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.billing_create_default_subscription(uuid) from public, anon, authenticated, service_role;
revoke all on function private.billing_start_trial(uuid) from public, anon, authenticated, service_role;
revoke all on function private.onboarding_finish(uuid) from public, anon, authenticated, service_role;
revoke all on function private.billing_backfill_existing_tenants() from public, anon, authenticated, service_role;

select private.billing_backfill_existing_tenants();


-- ---------------------------------------------------------------------------------------------------------------
-- Hooks. Each body below is the CURRENT body (as built by the migration chain) with exactly one added/changed line.
-- ---------------------------------------------------------------------------------------------------------------

-- create_tenant_with_owner: + subscription row
CREATE OR REPLACE FUNCTION private.create_tenant_with_owner(p_name text, p_slug text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_owner_role_id uuid;
  -- Mirrors lib/tenancy/reserved-slugs.ts RESERVED_SLUGS — the TS list is
  -- authoritative for onboarding UX/messaging, this is the non-bypassable
  -- backstop. Keep both in sync if either changes.
  v_reserved_slugs text[] := array[
    'app', 'book', 'super-admin', 'api', 'admin', 'auth', 'login', 'logout',
    'signup', 'sign-up', 'sign-in', 'register', 'onboarding', 'dashboard',
    'settings', 'billing', 'docs', 'help', 'support', 'status', 'pricing',
    'about', 'contact', 'legal', 'privacy', 'terms', 'www', 'mail', 'ftp',
    'static', 'public', 'assets', 'favicon.ico', 'robots.txt',
    'sitemap.xml', 'manifest.json', '_next', '_vercel',
    'tr', 'en', 'ru', 'de', 'fr', 'es', 'ar'
  ];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_name is null or char_length(trim(p_name)) = 0 then
    raise exception 'name is required';
  end if;

  if p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_slug) not between 3 and 63 then
    raise exception 'invalid slug format';
  end if;

  if p_slug = any (v_reserved_slugs) then
    raise exception 'slug "%" is reserved', p_slug;
  end if;

  insert into public.tenants (name, slug, created_by)
  values (trim(p_name), p_slug, auth.uid())
  returning id into v_tenant_id;

  -- Faz 2I.2C: every tenant needs at least one branch for staff/service
  -- eligibility and appointments to function at all (see migration
  -- header). Same transaction as the tenant itself, so this is atomic —
  -- a tenant row can never exist without its default branch.
  insert into public.branches (tenant_id, name, is_primary)
  values (v_tenant_id, 'Merkez Şube', true);

  -- Faz SAAS.1E.1: every tenant is born with the four primary default roles
  -- (Salon Sahibi, Yönetici, Resepsiyon, Personel), provisioned by role KEY
  -- from the role templates — same transaction as the tenant, so a tenant
  -- can never exist without them. The creator receives SALON_OWNER.
  perform private.provision_default_roles(v_tenant_id);

  select r.id into v_owner_role_id
  from public.roles r
  where r.tenant_id = v_tenant_id and r.key = 'SALON_OWNER' and r.deleted_at is null;

  if v_owner_role_id is null then
    raise exception 'SALON_OWNER role could not be provisioned — seed data problem, not a user error';
  end if;

  insert into public.tenant_memberships (tenant_id, user_id, role_id, status)
  values (v_tenant_id, auth.uid(), v_owner_role_id, 'active');

  -- SAAS.1C.1: the subscription row (trial NOT started) is created in the same transaction as the tenant
  perform private.billing_create_default_subscription(v_tenant_id);

  perform private.log_audit_event(
    v_tenant_id,
    'tenant.created',
    'tenant',
    v_tenant_id,
    null,
    jsonb_build_object('name', p_name, 'slug', p_slug)
  );

  return v_tenant_id;
end;
$function$;

-- public_update_salon_profile: private.onboarding_status -> private.onboarding_finish (same result, starts the trial once)
CREATE OR REPLACE FUNCTION public.update_salon_profile(p_tenant_id uuid, p_name text, p_timezone text, p_currency text, p_phone text, p_address text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_before record;
  v_branch_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_phone text := private.normalize_phone(p_phone);
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
begin
  perform private.onboarding_require(p_tenant_id, array['settings.manage'], true);

  if char_length(v_name) not between 1 and 200 then
    raise exception 'invalid name' using errcode = 'OB012';
  end if;
  if v_currency not in ('TRY', 'EUR', 'USD', 'GBP') then
    raise exception 'invalid currency' using errcode = 'OB012';
  end if;
  if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
    raise exception 'invalid timezone' using errcode = 'OB012';
  end if;
  if v_phone is null or char_length(v_phone) not between 7 and 20 then
    raise exception 'invalid phone' using errcode = 'OB012';
  end if;
  if v_address is not null and char_length(v_address) > 500 then
    raise exception 'invalid address' using errcode = 'OB012';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':onboarding:profile', 0));

  select t.name, t.timezone, t.currency into v_before from public.tenants t where t.id = p_tenant_id;

  update public.tenants
  set name = v_name, timezone = p_timezone, currency = v_currency
  where id = p_tenant_id;

  select b.id into v_branch_id
  from public.branches b
  where b.tenant_id = p_tenant_id and b.deleted_at is null
  order by b.is_primary desc, b.created_at
  limit 1;

  if v_branch_id is not null then
    update public.branches
    set phone = v_phone, address = v_address
    where id = v_branch_id and tenant_id = p_tenant_id;
  end if;

  perform private.log_audit_event(
    p_tenant_id,
    'onboarding.profile_updated',
    'tenants',
    p_tenant_id,
    jsonb_build_object('name', v_before.name, 'timezone', v_before.timezone, 'currency', v_before.currency),
    jsonb_build_object('name', v_name, 'timezone', p_timezone, 'currency', v_currency)
  );

  return private.onboarding_finish(p_tenant_id);
end;
$function$;

-- public_onboarding_add_services: private.onboarding_status -> private.onboarding_finish (same result, starts the trial once)
CREATE OR REPLACE FUNCTION public.onboarding_add_services(p_tenant_id uuid, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_item jsonb;
  v_name text;
  v_category text;
  v_duration integer;
  v_price numeric;
  v_service_id uuid;
  v_created integer := 0;
  v_skipped integer := 0;
  v_order integer;
  v_seen text[] := array[]::text[];
begin
  perform private.onboarding_require(p_tenant_id, array['services.manage'], true);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'between 1 and 50 services are required' using errcode = 'OB012';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':onboarding:services', 0));

  select coalesce(max(s.display_order), 0) into v_order
  from public.services s where s.tenant_id = p_tenant_id and s.deleted_at is null;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'invalid item' using errcode = 'OB012';
    end if;
    v_name := btrim(coalesce(v_item->>'name', ''));
    v_category := nullif(btrim(coalesce(v_item->>'category', '')), '');
    if char_length(v_name) not between 1 and 200 then
      raise exception 'invalid service name' using errcode = 'OB012';
    end if;
    if v_category is not null and char_length(v_category) > 100 then
      raise exception 'invalid category' using errcode = 'OB012';
    end if;
    if (v_item->>'durationMinutes') is null or (v_item->>'durationMinutes') !~ '^[0-9]{1,4}$' then
      raise exception 'invalid duration' using errcode = 'OB012';
    end if;
    v_duration := (v_item->>'durationMinutes')::integer;
    if v_duration not between 5 and 1440 then
      raise exception 'invalid duration' using errcode = 'OB012';
    end if;
    if (v_item->>'price') is null or (v_item->>'price') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$' then
      raise exception 'invalid price' using errcode = 'OB012';
    end if;
    v_price := (v_item->>'price')::numeric;

    -- idempotent: a service with the same name (case-insensitive) already in the catalog, or repeated in this very
    -- request, is skipped rather than duplicated
    if lower(v_name) = any (v_seen)
       or exists (
         select 1 from public.services s
         where s.tenant_id = p_tenant_id and s.deleted_at is null and lower(s.name) = lower(v_name)
       ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_seen := array_append(v_seen, lower(v_name));

    v_order := v_order + 1;
    insert into public.services (tenant_id, name, category, duration_minutes, price, display_order, created_by)
    values (p_tenant_id, v_name, v_category, v_duration, v_price, v_order, auth.uid())
    returning id into v_service_id;

    insert into public.service_branches (service_id, branch_id)
    select v_service_id, b.id
    from public.branches b
    where b.tenant_id = p_tenant_id and b.deleted_at is null;

    v_created := v_created + 1;
  end loop;

  if v_created > 0 then
    perform private.log_audit_event(
      p_tenant_id,
      'onboarding.services_added',
      'services',
      p_tenant_id,
      null,
      jsonb_build_object('created', v_created, 'skipped', v_skipped)
    );
  end if;

  return jsonb_build_object('created', v_created, 'skipped', v_skipped, 'status', private.onboarding_finish(p_tenant_id));
end;
$function$;

-- public_onboarding_add_staff: private.onboarding_status -> private.onboarding_finish (same result, starts the trial once)
CREATE OR REPLACE FUNCTION public.onboarding_add_staff(p_tenant_id uuid, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_item jsonb;
  v_name text;
  v_phone text;
  v_staff_id uuid;
  v_created integer := 0;
  v_skipped integer := 0;
  v_order integer;
  v_seen text[] := array[]::text[];
begin
  perform private.onboarding_require(p_tenant_id, array['staff.manage'], true);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'between 1 and 30 staff members are required' using errcode = 'OB012';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':onboarding:staff', 0));

  select coalesce(max(sm.display_order), 0) into v_order
  from public.staff_members sm where sm.tenant_id = p_tenant_id and sm.deleted_at is null;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'invalid item' using errcode = 'OB012';
    end if;
    v_name := btrim(coalesce(v_item->>'fullName', ''));
    if char_length(v_name) not between 1 and 200 then
      raise exception 'invalid staff name' using errcode = 'OB012';
    end if;
    v_phone := private.normalize_phone(v_item->>'phone');
    if v_phone is not null and char_length(v_phone) not between 7 and 20 then
      raise exception 'invalid phone' using errcode = 'OB012';
    end if;

    if lower(v_name) = any (v_seen)
       or exists (
         select 1 from public.staff_members sm
         where sm.tenant_id = p_tenant_id and sm.deleted_at is null and lower(sm.full_name) = lower(v_name)
       ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_seen := v_seen || lower(v_name);

    v_order := v_order + 1;
    -- a roster record only: no login, no invitation (the person is not linked to any account)
    insert into public.staff_members (tenant_id, full_name, phone, display_order, created_by)
    values (p_tenant_id, v_name, v_phone, v_order, auth.uid())
    returning id into v_staff_id;

    insert into public.staff_branches (staff_member_id, branch_id)
    select v_staff_id, b.id
    from public.branches b
    where b.tenant_id = p_tenant_id and b.deleted_at is null;

    v_created := v_created + 1;
  end loop;

  if v_created > 0 then
    perform private.log_audit_event(
      p_tenant_id,
      'onboarding.staff_added',
      'staff_members',
      p_tenant_id,
      null,
      jsonb_build_object('created', v_created, 'skipped', v_skipped)
    );
  end if;

  return jsonb_build_object('created', v_created, 'skipped', v_skipped, 'status', private.onboarding_finish(p_tenant_id));
end;
$function$;

-- public_onboarding_apply_weekly_hours: private.onboarding_status -> private.onboarding_finish (same result, starts the trial once)
CREATE OR REPLACE FUNCTION public.onboarding_apply_weekly_hours(p_tenant_id uuid, p_staff_ids uuid[], p_days jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_day jsonb;
  v_other jsonb;
  v_weekday integer;
  v_start time;
  v_end time;
  v_staff uuid;
  v_applied integer := 0;
begin
  perform private.onboarding_require(p_tenant_id, array['staff.manage', 'schedules.manage'], true);

  if p_staff_ids is null or array_length(p_staff_ids, 1) is null or array_length(p_staff_ids, 1) > 100 then
    raise exception 'staff list is required' using errcode = 'OB012';
  end if;
  if p_days is null or jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) > 28 then
    raise exception 'invalid hours' using errcode = 'OB012';
  end if;

  -- every listed person must belong to THIS salon
  if exists (
    select 1 from unnest(p_staff_ids) as x(id)
    where not exists (
      select 1 from public.staff_members sm
      where sm.id = x.id and sm.tenant_id = p_tenant_id and sm.deleted_at is null
    )
  ) then
    raise exception 'unknown staff member' using errcode = 'OB012';
  end if;

  -- validate the template, including overlaps inside one weekday
  for v_day in select * from jsonb_array_elements(p_days) loop
    if jsonb_typeof(v_day) <> 'object' or (v_day->>'weekday') is null or (v_day->>'weekday') !~ '^[0-6]$' then
      raise exception 'invalid weekday' using errcode = 'OB012';
    end if;
    begin
      v_start := (v_day->>'start')::time;
      v_end := (v_day->>'end')::time;
    exception when others then
      raise exception 'invalid time' using errcode = 'OB012';
    end;
    if v_start is null or v_end is null or v_end <= v_start then
      raise exception 'end must be after start' using errcode = 'OB012';
    end if;
    for v_other in select * from jsonb_array_elements(p_days) loop
      if v_other is distinct from v_day
         and (v_other->>'weekday') = (v_day->>'weekday')
         and (v_other->>'start')::time < v_end
         and (v_other->>'end')::time > v_start then
        raise exception 'overlapping hours' using errcode = 'OB012';
      end if;
    end loop;
  end loop;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':onboarding:hours', 0));

  update public.staff_schedules
  set deleted_at = now()
  where tenant_id = p_tenant_id and staff_member_id = any (p_staff_ids) and deleted_at is null;

  foreach v_staff in array (select array_agg(distinct x) from unnest(p_staff_ids) as x) loop
    for v_day in select * from jsonb_array_elements(p_days) loop
      v_weekday := (v_day->>'weekday')::integer;
      insert into public.staff_schedules (tenant_id, staff_member_id, branch_id, weekday, start_time, end_time)
      values (p_tenant_id, v_staff, null, v_weekday, (v_day->>'start')::time, (v_day->>'end')::time);
    end loop;
    v_applied := v_applied + 1;
  end loop;

  perform private.log_audit_event(
    p_tenant_id,
    'onboarding.hours_applied',
    'staff_schedules',
    p_tenant_id,
    null,
    jsonb_build_object('staffCount', v_applied, 'rowsPerStaff', jsonb_array_length(p_days))
  );

  return private.onboarding_finish(p_tenant_id);
end;
$function$;

-- public_onboarding_set_staff_services: private.onboarding_status -> private.onboarding_finish (same result, starts the trial once)
CREATE OR REPLACE FUNCTION public.onboarding_set_staff_services(p_tenant_id uuid, p_assignments jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_a jsonb;
  v_staff uuid;
  v_ids uuid[];
  v_count integer := 0;
begin
  perform private.onboarding_require(p_tenant_id, array['staff.manage'], true);

  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_assignments) not between 1 and 100 then
    raise exception 'invalid assignments' using errcode = 'OB012';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':onboarding:mapping', 0));

  for v_a in select * from jsonb_array_elements(p_assignments) loop
    if jsonb_typeof(v_a) <> 'object' or jsonb_typeof(v_a->'serviceIds') is distinct from 'array' then
      raise exception 'invalid assignment' using errcode = 'OB012';
    end if;
    begin
      v_staff := (v_a->>'staffId')::uuid;
      select coalesce(array_agg(distinct x::uuid), array[]::uuid[]) into v_ids
      from jsonb_array_elements_text(v_a->'serviceIds') as t(x);
    exception when others then
      raise exception 'invalid identifier' using errcode = 'OB012';
    end;

    if not exists (
      select 1 from public.staff_members sm
      where sm.id = v_staff and sm.tenant_id = p_tenant_id and sm.deleted_at is null
    ) then
      raise exception 'unknown staff member' using errcode = 'OB012';
    end if;
    if exists (
      select 1 from unnest(v_ids) as x(id)
      where not exists (
        select 1 from public.services s where s.id = x.id and s.tenant_id = p_tenant_id and s.deleted_at is null
      )
    ) then
      raise exception 'unknown service' using errcode = 'OB012';
    end if;

    delete from public.staff_services where staff_member_id = v_staff;
    insert into public.staff_services (staff_member_id, service_id)
    select v_staff, x from unnest(v_ids) as x;
    v_count := v_count + 1;
  end loop;

  perform private.log_audit_event(
    p_tenant_id,
    'onboarding.staff_services_set',
    'staff_services',
    p_tenant_id,
    null,
    jsonb_build_object('staffCount', v_count)
  );

  return private.onboarding_finish(p_tenant_id);
end;
$function$;

-- private.set_online_booking_enabled: + trial activation when enabling completes onboarding
CREATE OR REPLACE FUNCTION private.set_online_booking_enabled(p_tenant_id uuid, p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_feature_id uuid;
  v_old_enabled boolean;
  v_tenant_feature_id uuid;
begin
  if not private.has_permission(p_tenant_id, 'settings.manage') then
    raise exception 'settings.manage required';
  end if;

  select id into v_feature_id from public.features where key = 'online_booking';
  if v_feature_id is null then
    raise exception 'online_booking feature is missing from the catalog — seed data problem, not a user error';
  end if;

  select tf.id, tf.enabled into v_tenant_feature_id, v_old_enabled
  from public.tenant_features tf
  where tf.tenant_id = p_tenant_id and tf.feature_id = v_feature_id;

  insert into public.tenant_features (tenant_id, feature_id, enabled, granted_by)
  values (p_tenant_id, v_feature_id, p_enabled, auth.uid())
  on conflict (tenant_id, feature_id)
  do update set enabled = excluded.enabled, granted_by = excluded.granted_by;

  perform private.log_audit_event(
    p_tenant_id,
    'settings.online_booking_changed',
    'tenant_features',
    coalesce(v_tenant_feature_id, p_tenant_id),
    jsonb_build_object('enabled', v_old_enabled),
    jsonb_build_object('enabled', p_enabled)
  );

  -- SAAS.1C.1: enabling the switch can be the step that completes onboarding
  if p_enabled then
    perform private.onboarding_finish(p_tenant_id);
  end if;

  return p_enabled;
end;
$function$;
