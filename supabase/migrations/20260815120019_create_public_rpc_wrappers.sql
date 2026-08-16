-- PostgREST only exposes RPC for functions in the schemas listed in
-- supabase/config.toml (api.schemas = ["public", "graphql_public"]) —
-- `private` is intentionally not in that list, so application code cannot
-- call private.has_permission() etc. directly. These thin public wrappers
-- are what app code (lib/auth/session.ts) actually calls; private.* stays
-- the single source of truth used directly inside RLS policies.

create or replace function public.has_permission(p_tenant_id uuid, p_permission_key text)
returns boolean
language sql
security invoker
stable
set search_path = ''
as $$
  select private.has_permission(p_tenant_id, p_permission_key);
$$;

create or replace function public.has_feature(p_tenant_id uuid, p_feature_key text)
returns boolean
language sql
security invoker
stable
set search_path = ''
as $$
  select private.has_feature(p_tenant_id, p_feature_key);
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
security invoker
stable
set search_path = ''
as $$
  select private.is_platform_admin();
$$;

create or replace function public.create_tenant(p_name text, p_slug text)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  select private.create_tenant_with_owner(p_name, p_slug);
$$;

revoke execute on function public.has_permission(uuid, text) from public;
revoke execute on function public.has_feature(uuid, text) from public;
revoke execute on function public.is_platform_admin() from public;
revoke execute on function public.create_tenant(text, text) from public;

grant execute on function public.has_permission(uuid, text) to authenticated;
grant execute on function public.has_feature(uuid, text) to authenticated;
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.create_tenant(text, text) to authenticated;
