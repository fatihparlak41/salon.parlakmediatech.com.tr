-- Faz SAAS.1B — Super Admin READ model (platform operators only). Additive: new functions, no table, no column, no policy change.
--
-- WHY
-- The platform operator (Parlak Mediatech) could only see a bare tenant list and flip a tenant's status. An operations console needs, per
-- salon: who the Owner is and how to reach them, whether setup is finished, whether public booking works, how much the salon is used and
-- when it was last active, and which salons need attention. All of that lives in tenant-internal tables that platform_admin deliberately
-- does NOT read through RLS (Faz 1.5, 20260816090004: "a future support-access feature is the correct way to widen this, not an ambient
-- bypass"). So the widening is done here, narrowly: FOUR SECURITY DEFINER read functions, each starting with an explicit platform-admin
-- check, returning aggregates and operational facts only.
--
-- WHAT IT IS NOT
--  * No write path of any kind (no suspend, no delete, no impersonation, no membership or role change, no e-mail).
--  * No second readiness definition: readiness is ALWAYS private.onboarding_status() (LAUNCH.1C), whose own header says no other may exist.
--  * No customer personal data: customers are only COUNTED. Never returned: customer names, phones, e-mails, notes, appointment content,
--    treatment photos, finance amounts, or audit before/after payloads.
--
-- AUTHORIZATION MODEL (decision recorded in SAAS-1B-SUPER-ADMIN.md)
--  The platform identity is the EXISTING public.platform_admins row (user_id + role + is_active), separate from tenant_memberships, checked by
--  the EXISTING private.is_platform_admin() (auth.uid() against an active row). It is not user-editable metadata, not raw_user_meta_data and not
--  an e-mail constant in the frontend. private.admin_require() wraps it with an authentication check and one fixed error message.
--
-- SECURITY REVIEW (dedicated; SECURITY DEFINER functions that read auth.users and every tenant)
--  1. Gate: every function (private and public) begins with private.admin_require(); a salon Owner, any tenant member, another tenant's
--     user and an anonymous caller are all refused ('platform admin required' / 'authentication required'); anon has no EXECUTE at all.
--  2. Privilege: private.* functions are revoked from EVERY API role (they run only as the definer, called by the public wrappers);
--     public wrappers are executable by `authenticated` only (revoked from PUBLIC, anon and service_role first).
--  3. search_path is empty and every object is schema-qualified; all functions are STABLE and write nothing.
--  4. Disclosure: Owner e-mail and phone (the operator must be able to contact the salon) and member names/roles; nothing about customers.
--  5. Inputs: the filter, sort and paging arguments are validated against fixed lists; the search term is matched with position(), never
--     interpolated and never used as a pattern, so wildcard characters have no special meaning.
--
-- LIFECYCLE (derived, nothing stored): suspended / canceled come from tenants.status (an explicit platform decision that, today, also stops
-- public booking: the public booking functions require status in ('trial','active')); otherwise setup (profile/services/staff/hours/mapping not
-- all done, from the canonical steps), inactive (setup done, nothing happened for 30 days), active.
--
-- ROLLBACK: drop function public.admin_dashboard_summary(), public.admin_list_tenants(text,text,text,integer,integer),
--   public.admin_tenant_detail(uuid), public.admin_tenant_audit(uuid,integer), private.admin_dashboard_summary(), private.admin_list_tenants(text,text,text,integer,integer),
--   private.admin_tenant_detail(uuid), private.admin_tenant_audit(uuid,integer), private.admin_tenant_rows(uuid), private.admin_require();

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The guard
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.admin_require()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not private.is_platform_admin() then
    raise exception 'platform admin required';
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. The set-based core: one row per (non-deleted) tenant, every metric from ONE aggregate pass (no per-tenant round trips).
--    p_tenant_id restricts every CTE early, so the detail page pays only for its own tenant.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.admin_tenant_rows(p_tenant_id uuid default null)
returns table (
  tenant_id uuid,
  name text,
  slug text,
  account_status text,
  timezone text,
  currency text,
  created_at timestamptz,
  trial_ends_at timestamptz,
  owner_count integer,
  owners jsonb,
  staff_count integer,
  member_count integer,
  service_count integer,
  direct_service_count integer,
  inquiry_service_count integer,
  customer_count integer,
  appointment_count integer,
  appointments_today integer,
  appointments_7d integer,
  photo_count integer,
  commission_rule_count integer,
  pending_invites integer,
  oldest_pending_invite_at timestamptz,
  last_activity_at timestamptz,
  owners_never_signed_in boolean,
  subscription_status text,
  readiness jsonb,
  booking_enabled boolean,
  setup_complete boolean,
  engine_ready boolean,
  lifecycle text,
  health jsonb,
  health_level text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.admin_require();

  return query
  with t as (
    select x.id, x.name, x.slug, x.status, x.timezone, x.currency, x.created_at, x.trial_ends_at
    from public.tenants x
    where x.deleted_at is null and (p_tenant_id is null or x.id = p_tenant_id)
  ),
  owner_members as (
    -- "Owner" = an active or suspended membership whose live role carries permissions.manage_unrestricted (the same definition the
    -- last-unrestricted-holder invariant uses); never a role NAME.
    select tm.tenant_id, tm.id as membership_id, tm.user_id, tm.status, tm.created_at as since
    from public.tenant_memberships tm
    join t on t.id = tm.tenant_id
    join public.roles r on r.id = tm.role_id and r.tenant_id = tm.tenant_id and r.deleted_at is null
    where tm.deleted_at is null and tm.status in ('active', 'suspended')
      and exists (
        select 1 from public.role_permissions rp
        join public.permissions p on p.id = rp.permission_id
        where rp.role_id = r.id and p.key = 'permissions.manage_unrestricted'
      )
  ),
  owner_info as (
    select om.tenant_id,
           (count(*) filter (where om.status = 'active'))::integer as active_owners,
           jsonb_agg(
             jsonb_build_object(
               'name', nullif(btrim(pr.full_name), ''),
               'email', lower(u.email),
               'phone', nullif(btrim(pr.phone), ''),
               'status', om.status,
               'lastSignInAt', u.last_sign_in_at,
               'staffLinked', exists (
                 select 1 from public.staff_members sm
                 where sm.tenant_membership_id = om.membership_id and sm.deleted_at is null
               )
             )
             order by om.since, om.membership_id
           ) as owners,
           coalesce(bool_and(u.last_sign_in_at is null) filter (where om.status = 'active'), false) as never_signed_in,
           max(u.last_sign_in_at) as last_owner_sign_in
    from owner_members om
    left join public.profiles pr on pr.id = om.user_id
    left join auth.users u on u.id = om.user_id
    group by om.tenant_id
  ),
  staff_c as (
    select sm.tenant_id, count(*)::integer as n
    from public.staff_members sm join t on t.id = sm.tenant_id
    where sm.status = 'active' and sm.deleted_at is null
    group by sm.tenant_id
  ),
  member_c as (
    select tm.tenant_id, count(*)::integer as n
    from public.tenant_memberships tm join t on t.id = tm.tenant_id
    where tm.deleted_at is null and tm.status in ('active', 'suspended')
    group by tm.tenant_id
  ),
  service_c as (
    select s.tenant_id,
           count(*)::integer as n,
           (count(*) filter (where s.booking_mode = 'direct'))::integer as direct_n,
           (count(*) filter (where s.booking_mode = 'inquiry'))::integer as inquiry_n
    from public.services s join t on t.id = s.tenant_id
    where s.status = 'active' and s.deleted_at is null
    group by s.tenant_id
  ),
  customer_c as (
    select c.tenant_id, count(*)::integer as n
    from public.customers c join t on t.id = c.tenant_id
    where c.deleted_at is null
    group by c.tenant_id
  ),
  appointment_c as (
    select a.tenant_id,
           count(*)::integer as n,
           (count(*) filter (
             where a.status not in ('cancelled', 'no_show')
               and (a.scheduled_start_at at time zone t.timezone)::date = (now() at time zone t.timezone)::date
           ))::integer as today_n,
           (count(*) filter (
             where a.status not in ('cancelled', 'no_show')
               and a.scheduled_start_at >= now() - interval '7 days' and a.scheduled_start_at < now()
           ))::integer as week_n
    from public.appointments a join t on t.id = a.tenant_id
    group by a.tenant_id
  ),
  photo_c as (
    select m.tenant_id, count(*)::integer as n
    from public.treatment_media m join t on t.id = m.tenant_id
    where m.confirmed_at is not null
    group by m.tenant_id
  ),
  commission_c as (
    select r.tenant_id, count(*)::integer as n
    from public.staff_commission_rules r join t on t.id = r.tenant_id
    group by r.tenant_id
  ),
  invite_c as (
    select i.tenant_id, count(*)::integer as n, min(i.created_at) as oldest
    from public.team_invitations i join t on t.id = i.tenant_id
    where i.status = 'pending' and i.expires_at > now()
    group by i.tenant_id
  ),
  activity_c as (
    -- tenant-level audit events (appointments, customers, services, staff, settings, invitations ... all write one); read as a TIME only
    select l.tenant_id, max(l.created_at) as last_at
    from public.audit_logs l join t on t.id = l.tenant_id
    group by l.tenant_id
  ),
  -- MATERIALIZED on purpose: without it the planner pulls this subquery up and re-evaluates the readiness function once per column that
  -- reads it (measured: about nine times per salon). Materialized, the canonical function runs exactly once per salon.
  base as materialized (
    select t.id, t.name, t.slug, t.status, t.timezone, t.currency, t.created_at, t.trial_ends_at,
           coalesce(oi.active_owners, 0) as owner_count,
           coalesce(oi.owners, '[]'::jsonb) as owners,
           coalesce(sc.n, 0) as staff_count,
           coalesce(mc.n, 0) as member_count,
           coalesce(svc.n, 0) as service_count,
           coalesce(svc.direct_n, 0) as direct_service_count,
           coalesce(svc.inquiry_n, 0) as inquiry_service_count,
           coalesce(cc.n, 0) as customer_count,
           coalesce(ac.n, 0) as appointment_count,
           coalesce(ac.today_n, 0) as appointments_today,
           coalesce(ac.week_n, 0) as appointments_7d,
           coalesce(pc.n, 0) as photo_count,
           coalesce(cmc.n, 0) as commission_rule_count,
           coalesce(ic.n, 0) as pending_invites,
           ic.oldest as oldest_pending_invite_at,
           greatest(act.last_at, oi.last_owner_sign_in) as last_activity_at,
           coalesce(oi.never_signed_in, false) as owners_never_signed_in,
           (select sub.status from public.subscriptions sub where sub.tenant_id = t.id) as subscription_status,
           ready.r as readiness
    from t
    left join owner_info oi on oi.tenant_id = t.id
    left join staff_c sc on sc.tenant_id = t.id
    left join member_c mc on mc.tenant_id = t.id
    left join service_c svc on svc.tenant_id = t.id
    left join customer_c cc on cc.tenant_id = t.id
    left join appointment_c ac on ac.tenant_id = t.id
    left join photo_c pc on pc.tenant_id = t.id
    left join commission_c cmc on cmc.tenant_id = t.id
    left join invite_c ic on ic.tenant_id = t.id
    left join activity_c act on act.tenant_id = t.id
    -- the ONE readiness definition (LAUNCH.1C). Nothing about readiness is re-derived in this file except which of its steps count as "setup".
    cross join lateral (select private.onboarding_status(t.id) as r) ready
  ),
  derived as (
    select b.*,
           coalesce((b.readiness ->> 'onlineBookingEnabled')::boolean, false) as booking_enabled,
           coalesce((b.readiness ->> 'bookingEngineReady')::boolean, false) as engine_ready,
           coalesce((
             select bool_and((s ->> 'done')::boolean)
             from jsonb_array_elements(b.readiness -> 'steps') s
             where s ->> 'key' in ('profile', 'services', 'staff', 'hours', 'mapping')
           ), false) as setup_complete
    from base b
  ),
  life as (
    select d.*,
           case
             when d.status = 'canceled' then 'canceled'
             when d.status = 'suspended' then 'suspended'
             when not d.setup_complete then 'setup'
             when coalesce(d.last_activity_at, d.created_at) < now() - interval '30 days' then 'inactive'
             else 'active'
           end as lifecycle
    from derived d
  ),
  sig as (
    -- Health signals. Only real operational problems are CRITICAL: nobody can manage the salon, or customers are sent to a booking page that
    -- cannot work. Everything else is a warning (stalled/quiet) or information (new, no bookings yet, booking switched off, ending trial).
    select l.*,
           array_remove(array[
             case when l.status in ('trial', 'active') and l.owner_count = 0 then 'critical:no_owner' end,
             case when l.status in ('trial', 'active') and l.booking_enabled and not l.engine_ready then 'critical:booking_broken' end,
             case when l.status in ('trial', 'active') and not l.setup_complete and l.created_at < now() - interval '3 days' then 'warning:setup_stalled' end,
             case when l.status in ('trial', 'active') and l.owner_count > 0 and l.owners_never_signed_in and l.created_at < now() - interval '1 day' then 'warning:owner_never_signed_in' end,
             case when l.lifecycle = 'inactive' then 'warning:no_recent_activity' end,
             case when l.pending_invites > 0 and l.oldest_pending_invite_at < now() - interval '7 days' then 'warning:invite_pending' end,
             case when l.status in ('trial', 'active') and not l.setup_complete and l.created_at >= now() - interval '3 days' then 'info:new_salon' end,
             case when l.status in ('trial', 'active') and l.setup_complete and l.appointment_count = 0 then 'info:no_appointments_yet' end,
             case when l.status in ('trial', 'active') and l.setup_complete and not l.booking_enabled then 'info:booking_off' end,
             case when l.status = 'trial' and l.trial_ends_at is not null and l.trial_ends_at < now() + interval '7 days' then 'info:trial_ending' end,
             case when l.status in ('suspended', 'canceled') then 'info:' || l.status end
           ], null) as sigs
    from life l
  )
  select s.id, s.name, s.slug, s.status, s.timezone, s.currency, s.created_at, s.trial_ends_at,
         s.owner_count, s.owners, s.staff_count, s.member_count, s.service_count, s.direct_service_count, s.inquiry_service_count,
         s.customer_count, s.appointment_count, s.appointments_today, s.appointments_7d, s.photo_count, s.commission_rule_count,
         s.pending_invites, s.oldest_pending_invite_at, s.last_activity_at, s.owners_never_signed_in, s.subscription_status,
         s.readiness, s.booking_enabled, s.setup_complete, s.engine_ready, s.lifecycle,
         coalesce((
           select jsonb_agg(jsonb_build_object('severity', split_part(e, ':', 1), 'code', split_part(e, ':', 2))
                            order by case split_part(e, ':', 1) when 'critical' then 0 when 'warning' then 1 else 2 end, e)
           from unnest(s.sigs) e
         ), '[]'::jsonb) as health,
         case
           when exists (select 1 from unnest(s.sigs) e where e like 'critical:%') then 'critical'
           when exists (select 1 from unnest(s.sigs) e where e like 'warning:%') then 'warning'
           when exists (select 1 from unnest(s.sigs) e where e like 'info:%') then 'info'
           else 'ok'
         end as health_level
  from sig s;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Dashboard summary (operational counts + the two short lists)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.admin_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  perform private.admin_require();

  with r as (select * from private.admin_tenant_rows(null)),
  people as (
    select count(distinct tm.user_id)::integer as users_total
    from public.tenant_memberships tm
    join public.tenants t on t.id = tm.tenant_id and t.deleted_at is null
    where tm.deleted_at is null and tm.status = 'active'
  ),
  owners as (
    select count(distinct tm.user_id)::integer as owners_total
    from public.tenant_memberships tm
    join public.tenants t on t.id = tm.tenant_id and t.deleted_at is null
    join public.roles ro on ro.id = tm.role_id and ro.tenant_id = tm.tenant_id and ro.deleted_at is null
    where tm.deleted_at is null and tm.status = 'active'
      and exists (
        select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
        where rp.role_id = ro.id and p.key = 'permissions.manage_unrestricted'
      )
  )
  select jsonb_build_object(
    'salonsTotal', (select count(*) from r),
    'lifecycle', jsonb_build_object(
      'active', (select count(*) from r where lifecycle = 'active'),
      'setup', (select count(*) from r where lifecycle = 'setup'),
      'inactive', (select count(*) from r where lifecycle = 'inactive'),
      'suspended', (select count(*) from r where lifecycle = 'suspended'),
      'canceled', (select count(*) from r where lifecycle = 'canceled')
    ),
    'bookingActive', (select count(*) from r where booking_enabled and account_status in ('trial', 'active')),
    'ownersTotal', (select owners_total from owners),
    'usersTotal', (select users_total from people),
    'staffTotal', (select coalesce(sum(staff_count), 0) from r),
    'appointmentsToday', (select coalesce(sum(appointments_today), 0) from r),
    'appointments7d', (select coalesce(sum(appointments_7d), 0) from r),
    'health', jsonb_build_object(
      'critical', (select count(*) from r where health_level = 'critical'),
      'warning', (select count(*) from r where health_level = 'warning')
    ),
    'recentlyCreated', coalesce((
      select jsonb_agg(jsonb_build_object('tenantId', x.tenant_id, 'name', x.name, 'slug', x.slug, 'createdAt', x.created_at, 'lifecycle', x.lifecycle) order by x.created_at desc)
      from (select * from r order by created_at desc limit 5) x
    ), '[]'::jsonb),
    'needsAttention', coalesce((
      select jsonb_agg(jsonb_build_object('tenantId', x.tenant_id, 'name', x.name, 'slug', x.slug, 'healthLevel', x.health_level, 'health', x.health)
                       order by case x.health_level when 'critical' then 0 else 1 end, x.created_at desc)
      from (select * from r where health_level in ('critical', 'warning') order by case health_level when 'critical' then 0 else 1 end, created_at desc limit 10) x
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. The salon list (search + one filter + sort + paging, all validated; total_count for the pager)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.admin_list_tenants(
  p_search text default null,
  p_filter text default 'all',
  p_sort text default 'created_desc',
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  tenant_id uuid,
  name text,
  slug text,
  account_status text,
  lifecycle text,
  setup_complete boolean,
  booking_enabled boolean,
  primary_owner_name text,
  primary_owner_email text,
  owner_count integer,
  staff_count integer,
  service_count integer,
  customer_count integer,
  appointment_count integer,
  created_at timestamptz,
  last_activity_at timestamptz,
  health_level text,
  health jsonb,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_filter text := coalesce(nullif(btrim(p_filter), ''), 'all');
  v_sort text := coalesce(nullif(btrim(p_sort), ''), 'created_desc');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_q text := lower(btrim(coalesce(p_search, '')));
begin
  perform private.admin_require();

  if v_filter not in ('all', 'active', 'setup', 'inactive', 'suspended', 'booking_on', 'booking_off', 'new', 'quiet', 'attention') then
    raise exception 'invalid filter';
  end if;
  if v_sort not in ('created_desc', 'created_asc', 'name_asc', 'activity_desc', 'attention_desc') then
    raise exception 'invalid sort';
  end if;
  if char_length(v_q) > 100 then
    v_q := left(v_q, 100);
  end if;

  return query
  with r as (select * from private.admin_tenant_rows(null)),
  f as (
    select r.*
    from r
    where (
        v_filter = 'all'
        or (v_filter = 'active' and r.lifecycle = 'active')
        or (v_filter = 'setup' and r.lifecycle = 'setup')
        or (v_filter = 'inactive' and r.lifecycle = 'inactive')
        or (v_filter = 'suspended' and r.lifecycle in ('suspended', 'canceled'))
        or (v_filter = 'booking_on' and r.booking_enabled)
        or (v_filter = 'booking_off' and not r.booking_enabled)
        or (v_filter = 'new' and r.created_at >= now() - interval '14 days')
        or (v_filter = 'quiet' and r.account_status in ('trial', 'active') and coalesce(r.last_activity_at, r.created_at) < now() - interval '14 days')
        or (v_filter = 'attention' and r.health_level in ('critical', 'warning'))
      )
      and (
        v_q = ''
        or position(v_q in lower(r.name)) > 0
        or position(v_q in lower(r.slug)) > 0
        or exists (
          select 1 from jsonb_array_elements(r.owners) o
          where position(v_q in lower(coalesce(o ->> 'email', ''))) > 0
             or position(v_q in lower(coalesce(o ->> 'name', ''))) > 0
        )
      )
  )
  select f.tenant_id, f.name, f.slug, f.account_status, f.lifecycle, f.setup_complete, f.booking_enabled,
         (f.owners -> 0 ->> 'name'), (f.owners -> 0 ->> 'email'),
         f.owner_count, f.staff_count, f.service_count, f.customer_count, f.appointment_count,
         f.created_at, f.last_activity_at, f.health_level, f.health,
         count(*) over () as total_count
  from f
  order by
    case when v_sort = 'attention_desc' then case f.health_level when 'critical' then 0 when 'warning' then 1 when 'info' then 2 else 3 end end asc nulls last,
    case when v_sort = 'created_asc' then f.created_at end asc,
    case when v_sort = 'name_asc' then lower(f.name) end asc,
    case when v_sort = 'activity_desc' then coalesce(f.last_activity_at, f.created_at) end desc,
    case when v_sort in ('created_desc', 'attention_desc') then f.created_at end desc,
    f.tenant_id
  limit v_limit offset v_offset;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. One salon in detail (jsonb: overview, owner/members, usage, booking, system)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.admin_tenant_detail(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_row record;
  v_members jsonb;
begin
  perform private.admin_require();

  select * into v_row from private.admin_tenant_rows(p_tenant_id) limit 1;
  if not found then
    raise exception 'tenant not found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'membershipId', tm.id,
           'displayName', nullif(btrim(pr.full_name), ''),
           'email', lower(u.email),
           'roleName', ro.name,
           'isOwner', exists (
             select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
             where rp.role_id = ro.id and p.key = 'permissions.manage_unrestricted'
           ),
           'status', tm.status,
           'linkedStaffName', (
             select sm.full_name from public.staff_members sm
             where sm.tenant_membership_id = tm.id and sm.deleted_at is null limit 1
           ),
           'lastSignInAt', u.last_sign_in_at,
           'since', tm.created_at
         ) order by tm.created_at, tm.id), '[]'::jsonb)
  into v_members
  from public.tenant_memberships tm
  join public.roles ro on ro.id = tm.role_id and ro.tenant_id = tm.tenant_id
  left join public.profiles pr on pr.id = tm.user_id
  left join auth.users u on u.id = tm.user_id
  where tm.tenant_id = p_tenant_id and tm.deleted_at is null and tm.status in ('active', 'suspended');

  return jsonb_build_object(
    'overview', jsonb_build_object(
      'tenantId', v_row.tenant_id,
      'name', v_row.name,
      'slug', v_row.slug,
      'accountStatus', v_row.account_status,
      'lifecycle', v_row.lifecycle,
      'timezone', v_row.timezone,
      'currency', v_row.currency,
      'createdAt', v_row.created_at,
      'trialEndsAt', v_row.trial_ends_at,
      'bookingPath', '/book/' || v_row.slug,
      'setupComplete', v_row.setup_complete,
      'readyForBooking', coalesce((v_row.readiness ->> 'ready')::boolean, false),
      'steps', v_row.readiness -> 'steps',
      'blockers', v_row.readiness -> 'blockers',
      'profileMissing', v_row.readiness -> 'profile' -> 'missing',
      'subscriptionStatus', v_row.subscription_status
    ),
    'owners', v_row.owners,
    'members', v_members,
    'usage', jsonb_build_object(
      'staff', v_row.staff_count,
      'members', v_row.member_count,
      'services', v_row.service_count,
      'customers', v_row.customer_count,
      'appointments', v_row.appointment_count,
      'appointmentsToday', v_row.appointments_today,
      'appointments7d', v_row.appointments_7d,
      'treatmentPhotos', v_row.photo_count,
      'commissionRules', v_row.commission_rule_count,
      'pendingInvitations', v_row.pending_invites
    ),
    'booking', jsonb_build_object(
      'publicBookingEnabled', v_row.booking_enabled,
      'bookingEngineReady', v_row.engine_ready,
      'engineBlockers', v_row.readiness -> 'bookingEngineBlockers',
      'staffWithHours', v_row.readiness -> 'counts' -> 'staffWithHours',
      'activeStaff', v_row.readiness -> 'counts' -> 'staff',
      'bookablePaths', v_row.readiness -> 'counts' -> 'bookablePaths',
      'directBookableServices', v_row.direct_service_count,
      'inquiryServices', v_row.inquiry_service_count,
      'firstAvailableSlotAt', v_row.readiness -> 'firstAvailableSlotAt'
    ),
    'system', jsonb_build_object(
      'lastActivityAt', v_row.last_activity_at,
      'ownersNeverSignedIn', v_row.owners_never_signed_in,
      'oldestPendingInvitationAt', v_row.oldest_pending_invite_at,
      'healthLevel', v_row.health_level,
      'health', v_row.health
    )
  );
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Administrative history of one salon: WHEN / WHAT / which kind of actor. Never the before/after payloads, ip or user agent.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.admin_tenant_audit(p_tenant_id uuid, p_limit integer default 50)
returns table (
  occurred_at timestamptz,
  action text,
  entity_type text,
  actor_type text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  perform private.admin_require();

  if not exists (select 1 from public.tenants t where t.id = p_tenant_id and t.deleted_at is null) then
    raise exception 'tenant not found';
  end if;

  return query
  select l.created_at, l.action, l.entity_type, l.actor_type
  from public.audit_logs l
  where l.tenant_id = p_tenant_id
  order by l.created_at desc, l.id
  limit v_limit;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Public wrappers (SECURITY DEFINER because private has no usage for `authenticated`) and grants
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_dashboard_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$ select private.admin_dashboard_summary(); $$;

create or replace function public.admin_list_tenants(
  p_search text default null,
  p_filter text default 'all',
  p_sort text default 'created_desc',
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  tenant_id uuid,
  name text,
  slug text,
  account_status text,
  lifecycle text,
  setup_complete boolean,
  booking_enabled boolean,
  primary_owner_name text,
  primary_owner_email text,
  owner_count integer,
  staff_count integer,
  service_count integer,
  customer_count integer,
  appointment_count integer,
  created_at timestamptz,
  last_activity_at timestamptz,
  health_level text,
  health jsonb,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$ select * from private.admin_list_tenants(p_search, p_filter, p_sort, p_limit, p_offset); $$;

create or replace function public.admin_tenant_detail(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$ select private.admin_tenant_detail(p_tenant_id); $$;

create or replace function public.admin_tenant_audit(p_tenant_id uuid, p_limit integer default 50)
returns table (occurred_at timestamptz, action text, entity_type text, actor_type text)
language sql
stable
security definer
set search_path = ''
as $$ select * from private.admin_tenant_audit(p_tenant_id, p_limit); $$;

comment on function public.admin_dashboard_summary() is
  'Faz SAAS.1B. Platform admins only. Operational counts of the whole platform plus two short lists. No customer data.';
comment on function public.admin_list_tenants(text, text, text, integer, integer) is
  'Faz SAAS.1B. Platform admins only. One row per salon with Owner, lifecycle, setup, booking, counts, last activity and health; search by salon name, slug, Owner name or e-mail; fixed filter and sort lists; paged. Customers are only counted.';
comment on function public.admin_tenant_detail(uuid) is
  'Faz SAAS.1B. Platform admins only. Overview, Owners and members, usage counts, booking readiness and health of one salon. Readiness comes from private.onboarding_status (the single definition).';
comment on function public.admin_tenant_audit(uuid, integer) is
  'Faz SAAS.1B. Platform admins only. When / what / actor kind of a salon''s audit events; never the before/after payloads.';

revoke all on function private.admin_require() from public, anon, authenticated, service_role;
revoke all on function private.admin_tenant_rows(uuid) from public, anon, authenticated, service_role;
revoke all on function private.admin_dashboard_summary() from public, anon, authenticated, service_role;
revoke all on function private.admin_list_tenants(text, text, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.admin_tenant_detail(uuid) from public, anon, authenticated, service_role;
revoke all on function private.admin_tenant_audit(uuid, integer) from public, anon, authenticated, service_role;

revoke all on function public.admin_dashboard_summary() from public, anon, authenticated, service_role;
revoke all on function public.admin_list_tenants(text, text, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_tenant_detail(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_tenant_audit(uuid, integer) from public, anon, authenticated, service_role;

grant execute on function public.admin_dashboard_summary() to authenticated;
grant execute on function public.admin_list_tenants(text, text, text, integer, integer) to authenticated;
grant execute on function public.admin_tenant_detail(uuid) to authenticated;
grant execute on function public.admin_tenant_audit(uuid, integer) to authenticated;
