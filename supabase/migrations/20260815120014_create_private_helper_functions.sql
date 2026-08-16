-- private is not in the exposed API schema list (supabase/config.toml
-- api.schemas = ["public", "graphql_public"]), so nothing here is reachable
-- via PostgREST directly — only through RLS policies and RPC calls that
-- reference these functions from `public`.
create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

-- Every function below is SECURITY DEFINER with `set search_path = ''`, so
-- every table reference is fully schema-qualified (public.foo, auth.users).
-- Without the pinned search_path, a caller-controlled search_path could
-- shadow "public.tenant_memberships" with an attacker table and hijack the
-- function's privileged execution — this is the standard Postgres
-- SECURITY DEFINER search_path attack, not a hypothetical one.

create or replace function private.current_tenant_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
  select tenant_id
  from public.tenant_memberships
  where user_id = auth.uid()
    and status = 'active'
    and deleted_at is null;
$$;

comment on function private.current_tenant_ids() is
  'Tenant ids the current session user actively belongs to. Reads fresh on every call (no JWT claim caching) so a revoked membership takes effect on the next request, not after token expiry — see architecture report section B.';

create or replace function private.is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships
    where tenant_id = p_tenant_id
      and user_id = auth.uid()
      and status = 'active'
      and deleted_at is null
  );
$$;

create or replace function private.has_permission(p_tenant_id uuid, p_permission_key text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    join public.role_permissions rp on rp.role_id = tm.role_id
    join public.permissions p on p.id = rp.permission_id
    where tm.tenant_id = p_tenant_id
      and tm.user_id = auth.uid()
      and tm.status = 'active'
      and tm.deleted_at is null
      and p.key = p_permission_key
  );
$$;

comment on function private.has_permission(uuid, text) is
  'Single source of truth for permission checks — used from RLS policies AND from application code via RPC, so "what the UI shows" and "what the DB allows" can never drift. Checks the permission key, never a role name.';

create or replace function private.is_platform_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_admins
    where user_id = auth.uid()
      and is_active = true
  );
$$;

comment on function private.is_platform_admin() is
  'Deliberately reads platform_admins only — never tenant_memberships/roles. A tenant owner is never a platform admin by virtue of owning a tenant.';

create or replace function private.is_platform_owner()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_admins
    where user_id = auth.uid()
      and is_active = true
      and role = 'owner'
  );
$$;

comment on function private.is_platform_owner() is
  'Stricter than is_platform_admin(): only role=owner may manage other platform_admins rows. role=support passes is_platform_admin() but not this.';

create or replace function private.has_feature(p_tenant_id uuid, p_feature_key text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
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
    ),
    false
  );
$$;

comment on function private.has_feature(uuid, text) is
  'tenant_features override wins if present (even when it disables a feature the plan includes); otherwise falls back to the active plan''s plan_features; otherwise false.';

create or replace function private.log_audit_event(
  p_tenant_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb default null,
  p_after jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_actor_type text;
begin
  v_actor_type := case when private.is_platform_admin() then 'platform_admin' else 'user' end;

  insert into public.audit_logs (
    tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, before, after
  )
  values (
    p_tenant_id, auth.uid(), v_actor_type, p_action, p_entity_type, p_entity_id, p_before, p_after
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function private.log_audit_event(uuid, text, text, uuid, jsonb, jsonb) is
  'Only path that can write to audit_logs — actor_user_id is set from auth.uid() internally, never from a caller-supplied parameter, so it cannot be spoofed.';

revoke execute on all functions in schema private from public;
grant execute on function private.current_tenant_ids() to authenticated;
grant execute on function private.is_tenant_member(uuid) to authenticated;
grant execute on function private.has_permission(uuid, text) to authenticated;
grant execute on function private.is_platform_admin() to authenticated;
grant execute on function private.is_platform_owner() to authenticated;
grant execute on function private.has_feature(uuid, text) to authenticated;
grant execute on function private.log_audit_event(uuid, text, text, uuid, jsonb, jsonb) to authenticated;
