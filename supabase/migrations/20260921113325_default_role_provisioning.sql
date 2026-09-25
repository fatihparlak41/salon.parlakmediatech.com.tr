-- Faz SAAS.1E.1 (part 3) — deterministic default-role provisioning, template
-- drift management, and the durable customization marker.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- Parts 1 and 2 defined the four primary roles as reference data and made a
-- role's KEY a real identity. This part is the machinery:
--
--   private.provision_default_roles(tenant)
--       creates whichever of the four primary roles a tenant is MISSING.
--       DB-authoritative and idempotent; keyed by role key, never by display
--       name; race-safe (per-tenant advisory lock + the live-key unique
--       index); never modifies an existing role, never overwrites an
--       owner-created custom role.
--
--   private.sync_pristine_default_roles(tenant?, remove_extra?, template_key?)
--       propagates a TEMPLATE change to PRISTINE system-default roles only.
--       Default = additive (missing keys are added, nothing is ever removed);
--       removing extra keys (a template tightening, e.g. taking a key away
--       from Personel) needs remove_extra = true and should be scoped to the
--       one template with template_key. Customized roles are never touched.
--
--   private.role_template_drift(tenant?)
--       read-only report of every live system-default role against its
--       template: in_sync | customized_in_sync | customized_drift |
--       pristine_missing | pristine_extra.
--
--   create_tenant_with_owner now provisions all four roles; the creator still
--   receives SALON_OWNER, inside the same transaction as before.
--   update_role_permissions flips the customization marker when it changes a
--   system-default role's permission set (everything else in it is the
--   20260921092226 definition, unchanged).
--
-- =====================================================================
-- SOFT-DELETED STANDARD ROLES: RECREATED, NEVER RESTORED
-- =====================================================================
--
-- If a tenant's live role for a key is missing because it was soft-deleted,
-- provisioning creates a NEW role (new id) and leaves the deleted one deleted.
-- Restoring the old row would silently give every member still attached to it
-- their permissions back — the deleted role grants nothing precisely so that
-- deletion is a safe, final act — and would resurrect something an owner
-- removed on purpose. The audit row records replaced_deleted_role_id, and the
-- deleted role's name is free again (the name index is live-only). Members on
-- the deleted role stay there, with no permissions, until an owner re-assigns
-- them through update_membership_role.
--
-- =====================================================================
-- DISPLAY-NAME COLLISIONS
-- =====================================================================
--
-- Identity is the key, so a custom role that happens to be called "Yönetici"
-- neither blocks nor is touched by provisioning: the provisioned role takes
-- the deterministic name "Yönetici (varsayılan)" (then "… (varsayılan 3)"
-- and so on). Names are cosmetic.
--
-- =====================================================================
-- AUTHORIZATION AND AUDIT
-- =====================================================================
--
-- All four functions live in the private schema with no client EXECUTE: they
-- are called by create_tenant_with_owner (definer), by the backfill migration
-- and by operators. Every role they create or change writes an audit row
-- (role.provisioned / role.template_synced) with actor_type 'system' when
-- there is no signed-in user (migrations, operators) and 'user' /
-- 'platform_admin' otherwise.
--
-- WHEN A MIGRATION CHANGES A TEMPLATE OR ADDS A PERMISSION KEY it must end
-- with select * from private.sync_pristine_default_roles(); (see
-- supabase/migrations/README.md) — otherwise every existing tenant's pristine
-- roles drift, exactly as one production tenant's Salon Sahibi did (19 of 23).

-- =====================================================================
-- helper: a template's permission keys, sorted
-- =====================================================================

create or replace function private.template_permission_keys(p_template_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct p.key order by p.key), array[]::text[])
  from public.role_template_permissions rtp
  join public.permissions p on p.id = rtp.permission_id
  where rtp.role_template_id = p_template_id;
$$;

-- =====================================================================
-- provision_default_roles
-- =====================================================================

create or replace function private.provision_default_roles(p_tenant_id uuid)
returns table(provisioned_role_id uuid, provisioned_role_key text, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template record;
  v_existing_id uuid;
  v_deleted_id uuid;
  v_new_id uuid;
  v_name text;
  v_attempt integer;
  v_keys text[];
  v_actor_type text;
begin
  if p_tenant_id is null or not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'tenant_not_found';
  end if;

  if not exists (select 1 from public.role_templates rt where rt.provision_by_default) then
    raise exception 'default role templates are missing — seed data problem, not a user error';
  end if;

  -- One provisioning / sync per tenant at a time (tenant creation, backfill,
  -- a future repair action). Transaction-scoped; released at commit.
  perform pg_advisory_xact_lock(hashtextextended('provision_default_roles:' || p_tenant_id::text, 0));

  v_actor_type := case
    when auth.uid() is null then 'system'
    when private.is_platform_admin() then 'platform_admin'
    else 'user'
  end;

  for v_template in
    select rt.id, rt.key, rt.name, rt.description
    from public.role_templates rt
    where rt.provision_by_default
    order by rt.display_order, rt.key
  loop
    select r.id into v_existing_id
    from public.roles r
    where r.tenant_id = p_tenant_id and r.key = v_template.key and r.deleted_at is null;

    if v_existing_id is not null then
      provisioned_role_id := v_existing_id;
      provisioned_role_key := v_template.key;
      outcome := 'exists';
      return next;
      continue;
    end if;

    -- A soft-deleted predecessor is never restored (see the header); it is
    -- only remembered in the audit row.
    select r.id into v_deleted_id
    from public.roles r
    where r.tenant_id = p_tenant_id and r.key = v_template.key and r.deleted_at is not null
    order by r.deleted_at desc, r.id
    limit 1;

    v_name := v_template.name;
    v_attempt := 1;
    while exists (
      select 1 from public.roles r
      where r.tenant_id = p_tenant_id and r.name = v_name and r.deleted_at is null
    ) loop
      v_attempt := v_attempt + 1;
      if v_attempt > 50 then
        raise exception 'no free display name for default role %', v_template.key;
      end if;
      v_name := v_template.name || case when v_attempt = 2 then ' (varsayılan)' else ' (varsayılan ' || v_attempt::text || ')' end;
    end loop;

    v_new_id := null;
    insert into public.roles (tenant_id, key, name, description, is_system_default, cloned_from_template_id)
    values (p_tenant_id, v_template.key, v_name, v_template.description, true, v_template.id)
    on conflict (tenant_id, key) where key is not null and deleted_at is null do nothing
    returning id into v_new_id;

    if v_new_id is null then
      -- Lost a race the advisory lock should have prevented; report what won.
      select r.id into v_existing_id
      from public.roles r
      where r.tenant_id = p_tenant_id and r.key = v_template.key and r.deleted_at is null;
      provisioned_role_id := v_existing_id;
      provisioned_role_key := v_template.key;
      outcome := 'exists';
      return next;
      continue;
    end if;

    insert into public.role_permissions (role_id, permission_id)
    select v_new_id, rtp.permission_id
    from public.role_template_permissions rtp
    where rtp.role_template_id = v_template.id;

    v_keys := private.template_permission_keys(v_template.id);

    insert into public.audit_logs (tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, before, after)
    values (
      p_tenant_id, auth.uid(), v_actor_type, 'role.provisioned', 'role', v_new_id,
      null,
      jsonb_build_object(
        'key', v_template.key,
        'name', v_name,
        'template_id', v_template.id,
        'permissions', to_jsonb(v_keys),
        'replaced_deleted_role_id', v_deleted_id
      )
    );

    provisioned_role_id := v_new_id;
    provisioned_role_key := v_template.key;
    outcome := 'created';
    return next;
  end loop;
end;
$$;

-- =====================================================================
-- sync_pristine_default_roles
-- =====================================================================

create or replace function private.sync_pristine_default_roles(
  p_tenant_id uuid default null,
  p_remove_extra boolean default false,
  p_template_key text default null
)
returns table(synced_tenant_id uuid, synced_role_id uuid, synced_role_key text, added_keys text[], removed_keys text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role record;
  v_template_keys text[];
  v_role_keys text[];
  v_added text[];
  v_removed text[];
  v_actor_type text;
begin
  v_actor_type := case
    when auth.uid() is null then 'system'
    when private.is_platform_admin() then 'platform_admin'
    else 'user'
  end;

  for v_role in
    select r.id, r.tenant_id, r.key, t.id as template_id
    from public.roles r
    join public.role_templates t on t.key = r.key
    where r.deleted_at is null
      and r.is_system_default
      and r.customized_at is null
      and (p_tenant_id is null or r.tenant_id = p_tenant_id)
      and (p_template_key is null or r.key = p_template_key)
    order by r.tenant_id, r.key
  loop
    perform pg_advisory_xact_lock(hashtextextended('provision_default_roles:' || v_role.tenant_id::text, 0));

    -- Re-check under the lock: a role customized (or deleted) since the
    -- cursor was opened is left alone.
    if exists (
      select 1 from public.roles r
      where r.id = v_role.id and (r.customized_at is not null or r.deleted_at is not null)
    ) then
      continue;
    end if;

    v_template_keys := private.template_permission_keys(v_role.template_id);
    v_role_keys := private.role_permission_keys(v_role.id);

    v_added := array(select unnest(v_template_keys) except select unnest(v_role_keys) order by 1);
    v_removed := case
      when p_remove_extra then array(select unnest(v_role_keys) except select unnest(v_template_keys) order by 1)
      else array[]::text[]
    end;

    if cardinality(v_added) = 0 and cardinality(v_removed) = 0 then
      continue;
    end if;

    if cardinality(v_removed) > 0 then
      delete from public.role_permissions rp
      where rp.role_id = v_role.id
        and rp.permission_id in (select p.id from public.permissions p where p.key = any (v_removed));
    end if;

    if cardinality(v_added) > 0 then
      insert into public.role_permissions (role_id, permission_id)
      select v_role.id, p.id from public.permissions p where p.key = any (v_added)
      on conflict do nothing;
    end if;

    insert into public.audit_logs (tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, before, after)
    values (
      v_role.tenant_id, auth.uid(), v_actor_type, 'role.template_synced', 'role', v_role.id,
      jsonb_build_object('permissions', to_jsonb(v_role_keys)),
      jsonb_build_object(
        'permissions', to_jsonb(private.role_permission_keys(v_role.id)),
        'added', to_jsonb(v_added),
        'removed', to_jsonb(v_removed),
        'remove_extra', p_remove_extra
      )
    );

    synced_tenant_id := v_role.tenant_id;
    synced_role_id := v_role.id;
    synced_role_key := v_role.key;
    added_keys := v_added;
    removed_keys := v_removed;
    return next;
  end loop;
end;
$$;

-- =====================================================================
-- role_template_drift (read-only)
-- =====================================================================

create or replace function private.role_template_drift(p_tenant_id uuid default null)
returns table(
  drift_tenant_id uuid,
  drift_role_id uuid,
  drift_role_key text,
  is_customized boolean,
  drift_state text,
  missing_keys text[],
  extra_keys text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with d as (
    select r.tenant_id as tid, r.id as rid, r.key as rkey, (r.customized_at is not null) as customized,
           private.template_permission_keys(t.id) as tkeys,
           private.role_permission_keys(r.id) as rkeys
    from public.roles r
    join public.role_templates t on t.key = r.key
    where r.deleted_at is null
      and r.is_system_default
      and (p_tenant_id is null or r.tenant_id = p_tenant_id)
  ), x as (
    select d.*,
           array(select unnest(d.tkeys) except select unnest(d.rkeys) order by 1) as miss,
           array(select unnest(d.rkeys) except select unnest(d.tkeys) order by 1) as extra
    from d
  )
  select
    x.tid, x.rid, x.rkey, x.customized,
    case
      when cardinality(x.miss) = 0 and cardinality(x.extra) = 0 then
        case when x.customized then 'customized_in_sync' else 'in_sync' end
      when x.customized then 'customized_drift'
      when cardinality(x.miss) > 0 then 'pristine_missing'
      else 'pristine_extra'
    end,
    x.miss,
    x.extra
  from x
  order by x.tid, x.rkey;
$$;

-- =====================================================================
-- create_tenant_with_owner — provisions all four roles
-- =====================================================================
--
-- The live PROD definition with exactly one
-- change: the "clone SALON_OWNER" block is replaced by
-- provision_default_roles + a lookup of the SALON_OWNER role by key.

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

-- =====================================================================
-- update_role_permissions — flips the customization marker
-- =====================================================================
--
-- The PROD definition (20260921092226) with exactly three changes: the role
-- lock now also reads is_system_default, the resulting set is computed, and
-- a changed system-default role gets customized_at. Authority checks, error
-- messages, locking, audit payload and the last-holder assertion are
-- unchanged.

CREATE OR REPLACE FUNCTION private.update_role_permissions(p_role_id uuid, p_permission_keys text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_decision text;
  v_is_system_default boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select tenant_id into v_tenant_id
  from public.roles
  where id = p_role_id and deleted_at is null;

  if v_tenant_id is null then
    raise exception 'role not found';
  end if;

  perform private.lock_tenant_for_management(v_tenant_id, 'role not found', 'staff.manage required');

  select is_system_default into v_is_system_default
  from public.roles
  where id = p_role_id and tenant_id = v_tenant_id and deleted_at is null
  for update;

  if not found then
    raise exception 'role not found';
  end if;

  if not private.is_tenant_member(v_tenant_id) then
    raise exception 'role not found';
  end if;

  if not private.has_permission(v_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  -- Authority over the role's CURRENT permissions (never its name).
  v_decision := private.role_edit_decision(v_tenant_id, p_role_id);
  if v_decision <> 'ok' then
    raise exception '%', v_decision;
  end if;

  -- Grant ceiling on the NEW set — unchanged rule, unchanged message.
  if not private.caller_can_grant_permissions(v_tenant_id, p_permission_keys) then
    raise exception 'cannot grant a permission you do not hold';
  end if;

  -- Faz SAAS.1E.0 (part 5): a caller below "unrestricted" may only shape the
  -- role into a set STRICTLY below their own authority — never a peer.
  if not private.has_permission(v_tenant_id, 'permissions.manage_unrestricted')
     and not private.is_strict_subset(p_permission_keys, private.caller_permission_keys(v_tenant_id)) then
    raise exception 'insufficient_authority';
  end if;

  select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb) into v_before
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = p_role_id;

  delete from public.role_permissions where role_id = p_role_id;

  insert into public.role_permissions (role_id, permission_id)
  select p_role_id, p.id
  from public.permissions p
  where p.key = any (coalesce(p_permission_keys, array[]::text[]));

  select coalesce(jsonb_agg(p.key order by p.key), '[]'::jsonb) into v_after
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = p_role_id;

  -- Faz SAAS.1E.1: a system-default role whose permission set actually
  -- changed is no longer the template's — flip the durable drift marker.
  -- It is never cleared automatically, so template syncs stop touching this
  -- role and any difference from the template is only reported.
  if v_is_system_default and v_after is distinct from v_before then
    update public.roles
    set customized_at = coalesce(customized_at, now())
    where id = p_role_id;
  end if;

  perform private.log_audit_event(
    v_tenant_id, 'role.permissions_updated', 'role', p_role_id,
    jsonb_build_object('permissions', v_before),
    jsonb_build_object('permissions', p_permission_keys)
  );

  perform private.assert_tenant_has_unrestricted_holder(v_tenant_id);
end;
$function$;

-- =====================================================================
-- grants: nothing here is callable by a client
-- =====================================================================

revoke execute on function private.template_permission_keys(uuid) from public;
revoke execute on function private.provision_default_roles(uuid) from public;
revoke execute on function private.sync_pristine_default_roles(uuid, boolean, text) from public;
revoke execute on function private.role_template_drift(uuid) from public;

