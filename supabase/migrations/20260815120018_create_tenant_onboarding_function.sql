-- The only path that creates a tenant. Runs as SECURITY DEFINER because the
-- calling user has no tenant_membership yet — there is nothing for a normal
-- has_permission()-style RLS policy to check ("who may create the very
-- first membership of a tenant that doesn't exist yet" is a bootstrapping
-- problem, not a permission-check problem). All four inserts happen in one
-- transaction: if any step fails, the whole tenant creation rolls back.
create or replace function private.create_tenant_with_owner(
  p_name text,
  p_slug text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_owner_template_id uuid;
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

  select id into v_owner_template_id
  from public.role_templates
  where key = 'SALON_OWNER';

  if v_owner_template_id is null then
    raise exception 'SALON_OWNER role template is missing — seed data problem, not a user error';
  end if;

  insert into public.roles (tenant_id, key, name, description, is_system_default, cloned_from_template_id)
  select v_tenant_id, rt.key, rt.name, rt.description, true, rt.id
  from public.role_templates rt
  where rt.id = v_owner_template_id
  returning id into v_owner_role_id;

  insert into public.role_permissions (role_id, permission_id)
  select v_owner_role_id, rtp.permission_id
  from public.role_template_permissions rtp
  where rtp.role_template_id = v_owner_template_id;

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
$$;

comment on function private.create_tenant_with_owner(text, text) is
  'Onboarding: creates the tenant, clones SALON_OWNER (role + permissions) for it, and makes the calling user its owner — atomically. This is the ONLY way a tenant gets created; there is no direct insert policy on public.tenants.';

revoke execute on function private.create_tenant_with_owner(text, text) from public;
grant execute on function private.create_tenant_with_owner(text, text) to authenticated;
