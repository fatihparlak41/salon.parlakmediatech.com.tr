-- LAUNCH.1C — guided onboarding: ONE deterministic readiness read model and the bulk write RPCs the wizard needs.
--
-- Design rules
--  * No new table, no new state machine. "Which step is done" is DERIVED from the data every time
--    (private.onboarding_status); nothing is stored, so it can never drift and an existing, fully configured
--    salon is simply "ready" without ever having seen the wizard.
--  * Every write reuses the existing tables and their existing permission keys (settings.manage, services.manage,
--    staff.manage, schedules.manage). All RPCs are SECURITY DEFINER with search_path '', tenant-scoped through
--    private.has_permission(p_tenant_id, ...), authenticated-only (explicit revokes from every API role first).
--    No service_role path, no table grant widened.
--  * Writes are atomic (one function = one transaction), idempotent on retry (names already present are skipped, the
--    same request twice changes nothing) and serialised per tenant with a transaction advisory lock.
--  * Error codes: OB010 not signed in, OB011 not allowed, OB012 invalid input, OB004 salon not active.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Readiness read model (the single source of truth).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.onboarding_status(p_tenant_id uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_tenant record;
  v_branch_phone text;
  v_branch_count integer;
  v_services integer;
  v_staff integer;
  v_staff_with_hours integer;
  v_paths integer;
  v_online boolean;
  v_has_appointments boolean;
  v_profile_missing text[] := array[]::text[];
  v_blockers text[] := array[]::text[];
  v_tz_ok boolean;
  v_now_local timestamp;
  v_found_slot timestamptz;
  v_path record;
  v_row record;
  v_day integer;
  v_date date;
  v_min integer;
  v_end_min integer;
  v_dur integer;
  v_start_utc timestamptz;
  v_end_utc timestamptz;
  v_cand timestamp;
  v_active boolean;
begin
  select t.id, t.name, t.slug, t.status, t.timezone, t.currency, t.deleted_at
  into v_tenant
  from public.tenants t
  where t.id = p_tenant_id;

  if not found then
    return null;
  end if;

  v_active := v_tenant.deleted_at is null and v_tenant.status in ('trial', 'active');

  select count(*) into v_branch_count
  from public.branches b where b.tenant_id = p_tenant_id and b.deleted_at is null;

  select b.phone into v_branch_phone
  from public.branches b
  where b.tenant_id = p_tenant_id and b.deleted_at is null
  order by b.is_primary desc, b.created_at
  limit 1;

  select exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tenant.timezone) into v_tz_ok;

  if v_tenant.name is null or char_length(btrim(v_tenant.name)) = 0 then
    v_profile_missing := array_append(v_profile_missing, 'name'::text);
  end if;
  if not v_tz_ok then
    v_profile_missing := array_append(v_profile_missing, 'timezone'::text);
  end if;
  if v_tenant.currency is null or char_length(btrim(v_tenant.currency)) = 0 then
    v_profile_missing := array_append(v_profile_missing, 'currency'::text);
  end if;
  if v_branch_count = 0 then
    v_profile_missing := array_append(v_profile_missing, 'branch'::text);
  end if;
  if v_branch_phone is null or char_length(btrim(v_branch_phone)) = 0 then
    v_profile_missing := array_append(v_profile_missing, 'phone'::text);
  end if;

  -- services that can actually be offered: active, not deleted, linked to a live branch
  select count(distinct s.id) into v_services
  from public.services s
  join public.service_branches sb on sb.service_id = s.id
  join public.branches b on b.id = sb.branch_id and b.tenant_id = p_tenant_id and b.deleted_at is null
  where s.tenant_id = p_tenant_id and s.status = 'active' and s.deleted_at is null;

  select count(*) into v_staff
  from public.staff_members sm
  where sm.tenant_id = p_tenant_id and sm.status = 'active' and sm.deleted_at is null;

  select count(*) into v_staff_with_hours
  from public.staff_members sm
  where sm.tenant_id = p_tenant_id and sm.status = 'active' and sm.deleted_at is null
    and exists (
      select 1 from public.staff_schedules ss
      where ss.staff_member_id = sm.id and ss.tenant_id = p_tenant_id and ss.deleted_at is null
    );

  -- (active staff, active service, branch) triples that satisfy EVERY booking-time association rule
  select count(*) into v_paths
  from public.staff_members sm
  join public.staff_branches sbr on sbr.staff_member_id = sm.id
  join public.staff_services ss on ss.staff_member_id = sm.id
  join public.services s on s.id = ss.service_id and s.tenant_id = p_tenant_id
  join public.service_branches sb on sb.service_id = s.id and sb.branch_id = sbr.branch_id
  join public.branches b on b.id = sbr.branch_id and b.tenant_id = p_tenant_id and b.deleted_at is null
  where sm.tenant_id = p_tenant_id and sm.status = 'active' and sm.deleted_at is null
    and s.status = 'active' and s.deleted_at is null;

  v_online := private.has_feature(p_tenant_id, 'online_booking');

  select exists (select 1 from public.appointments a where a.tenant_id = p_tenant_id) into v_has_appointments;

  -- Real-slot probe: only when every structural requirement holds. Uses the same predicate the public slot picker
  -- uses (private.staff_is_available) plus the same capacity clause, so a "ready" answer means a customer really
  -- could pick a time, not merely that rows exist.
  if v_active and v_paths > 0 and v_staff_with_hours > 0 then
    v_now_local := now() at time zone v_tenant.timezone;
    <<probe>>
    for v_path in
      select distinct on (sm.id) sm.id as staff_id, sm.concurrent_capacity as capacity, sbr.branch_id, s.duration_minutes
      from public.staff_members sm
      join public.staff_branches sbr on sbr.staff_member_id = sm.id
      join public.staff_services ss on ss.staff_member_id = sm.id
      join public.services s on s.id = ss.service_id and s.tenant_id = p_tenant_id
      join public.service_branches sb on sb.service_id = s.id and sb.branch_id = sbr.branch_id
      join public.branches b on b.id = sbr.branch_id and b.tenant_id = p_tenant_id and b.deleted_at is null
      where sm.tenant_id = p_tenant_id and sm.status = 'active' and sm.deleted_at is null
        and s.status = 'active' and s.deleted_at is null
      order by sm.id, s.duration_minutes, s.id
      limit 8
    loop
      v_dur := v_path.duration_minutes;
      for v_day in 0 .. 13 loop
        v_date := v_now_local::date + v_day;
        for v_row in
          select ss2.start_time, ss2.end_time
          from public.staff_schedules ss2
          where ss2.staff_member_id = v_path.staff_id and ss2.tenant_id = p_tenant_id and ss2.deleted_at is null
            and ss2.weekday = extract(dow from v_date)
            and (ss2.branch_id is null or ss2.branch_id = v_path.branch_id)
          order by ss2.start_time
        loop
          v_min := (extract(epoch from v_row.start_time) / 60)::integer;
          v_end_min := (extract(epoch from v_row.end_time) / 60)::integer;
          while v_min + v_dur <= v_end_min loop
            v_cand := v_date::timestamp + (v_min || ' minutes')::interval;
            if v_cand > v_now_local then
              v_start_utc := v_cand at time zone v_tenant.timezone;
              v_end_utc := v_start_utc + (v_dur || ' minutes')::interval;
              if private.staff_is_available(p_tenant_id, v_path.branch_id, v_path.staff_id, v_start_utc, v_end_utc)
                 and (
                   select count(*) from public.appointment_items ai
                   where ai.staff_member_id = v_path.staff_id
                     and ai.appointment_status not in ('cancelled', 'no_show')
                     and tstzrange(ai.scheduled_start_at, ai.scheduled_end_at) && tstzrange(v_start_utc, v_end_utc)
                 ) < v_path.capacity
              then
                v_found_slot := v_start_utc;
                exit probe;
              end if;
            end if;
            v_min := v_min + 15;
          end loop;
        end loop;
      end loop;
    end loop;
  end if;

  -- blockers, in a fixed order
  if not v_active then
    v_blockers := array_append(v_blockers, 'tenant_inactive'::text);
  end if;
  if array_length(v_profile_missing, 1) is not null then
    v_blockers := array_append(v_blockers, 'salon_profile_missing'::text);
  end if;
  if v_staff_with_hours = 0 then
    v_blockers := array_append(v_blockers, 'no_working_hours'::text);
  end if;
  if v_services = 0 then
    v_blockers := array_append(v_blockers, 'no_services'::text);
  end if;
  if v_staff = 0 then
    v_blockers := array_append(v_blockers, 'no_staff'::text);
  end if;
  if v_paths = 0 then
    v_blockers := array_append(v_blockers, 'no_bookable_staff'::text);
  end if;
  if not v_online then
    v_blockers := array_append(v_blockers, 'public_booking_disabled'::text);
  end if;
  if v_active and v_paths > 0 and v_staff_with_hours > 0 and v_found_slot is null then
    v_blockers := array_append(v_blockers, 'no_available_slot'::text);
  end if;

  return jsonb_build_object(
    'ready', array_length(v_blockers, 1) is null,
    'blockers', to_jsonb(v_blockers),
    'tenantSlug', v_tenant.slug,
    'profile', jsonb_build_object(
      'name', v_tenant.name,
      'timezone', v_tenant.timezone,
      'currency', v_tenant.currency,
      'phone', v_branch_phone,
      'missing', to_jsonb(v_profile_missing)
    ),
    'counts', jsonb_build_object(
      'services', v_services,
      'staff', v_staff,
      'staffWithHours', v_staff_with_hours,
      'bookablePaths', v_paths
    ),
    'onlineBookingEnabled', v_online,
    'hasAppointments', v_has_appointments,
    'firstAvailableSlotAt', v_found_slot,
    'steps', jsonb_build_array(
      jsonb_build_object('key', 'profile', 'done', array_length(v_profile_missing, 1) is null),
      jsonb_build_object('key', 'services', 'done', v_services > 0),
      jsonb_build_object('key', 'staff', 'done', v_staff > 0),
      jsonb_build_object('key', 'hours', 'done', v_staff_with_hours > 0),
      jsonb_build_object('key', 'mapping', 'done', v_paths > 0),
      jsonb_build_object('key', 'booking', 'done', v_online),
      jsonb_build_object('key', 'ready', 'done', array_length(v_blockers, 1) is null)
    )
  );
end;
$function$;

revoke all on function private.onboarding_status(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Shared gate for the onboarding RPCs.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.onboarding_require(p_tenant_id uuid, p_permissions text[], p_write boolean)
 returns void
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_key text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'OB010';
  end if;

  if p_write then
    -- every listed permission is required
    foreach v_key in array p_permissions loop
      if not private.has_permission(p_tenant_id, v_key) then
        raise exception 'not allowed' using errcode = 'OB011';
      end if;
    end loop;
    if not exists (
      select 1 from public.tenants t
      where t.id = p_tenant_id and t.deleted_at is null and t.status in ('trial', 'active')
    ) then
      raise exception 'salon is not active' using errcode = 'OB004';
    end if;
  else
    -- reading the status needs ANY of the listed permissions
    foreach v_key in array p_permissions loop
      if private.has_permission(p_tenant_id, v_key) then
        return;
      end if;
    end loop;
    raise exception 'not allowed' using errcode = 'OB011';
  end if;
end;
$function$;

revoke all on function private.onboarding_require(uuid, text[], boolean) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Authenticated RPCs.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.get_onboarding_status(p_tenant_id uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
begin
  perform private.onboarding_require(p_tenant_id, array['settings.manage', 'services.manage', 'staff.manage'], false);
  return private.onboarding_status(p_tenant_id);
end;
$function$;

create or replace function public.update_salon_profile(
  p_tenant_id uuid,
  p_name text,
  p_timezone text,
  p_currency text,
  p_phone text,
  p_address text
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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

  return private.onboarding_status(p_tenant_id);
end;
$function$;

create or replace function public.onboarding_add_services(p_tenant_id uuid, p_items jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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

  return jsonb_build_object('created', v_created, 'skipped', v_skipped, 'status', private.onboarding_status(p_tenant_id));
end;
$function$;

create or replace function public.onboarding_add_staff(p_tenant_id uuid, p_items jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
    -- a roster record only: no login, no invitation (tenant_membership_id stays null)
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

  return jsonb_build_object('created', v_created, 'skipped', v_skipped, 'status', private.onboarding_status(p_tenant_id));
end;
$function$;

-- Weekly hours for several staff members at once. p_days is the template: [{weekday, start, end}, ...]; several
-- rows on one weekday express a break; a weekday that does not appear is a closed day. The staff list is explicit
-- (the wizard offers only people who have no hours yet unless the Owner chooses otherwise), and each listed staff
-- member's previous hours are soft-deleted exactly like the existing per-person editor does.
create or replace function public.onboarding_apply_weekly_hours(p_tenant_id uuid, p_staff_ids uuid[], p_days jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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

  return private.onboarding_status(p_tenant_id);
end;
$function$;

-- The staff x service matrix in one call: p_assignments = [{staffId, serviceIds:[...]}]. For every staff member that
-- appears, the set of services becomes exactly the listed ones (an empty list clears it).
create or replace function public.onboarding_set_staff_services(p_tenant_id uuid, p_assignments jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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

  return private.onboarding_status(p_tenant_id);
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Grants: authenticated only.
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public.get_onboarding_status(uuid) from public, anon, authenticated, service_role;
revoke all on function public.update_salon_profile(uuid, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.onboarding_add_services(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.onboarding_add_staff(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.onboarding_apply_weekly_hours(uuid, uuid[], jsonb) from public, anon, authenticated, service_role;
revoke all on function public.onboarding_set_staff_services(uuid, jsonb) from public, anon, authenticated, service_role;

grant execute on function public.get_onboarding_status(uuid) to authenticated;
grant execute on function public.update_salon_profile(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.onboarding_add_services(uuid, jsonb) to authenticated;
grant execute on function public.onboarding_add_staff(uuid, jsonb) to authenticated;
grant execute on function public.onboarding_apply_weekly_hours(uuid, uuid[], jsonb) to authenticated;
grant execute on function public.onboarding_set_staff_services(uuid, jsonb) to authenticated;
