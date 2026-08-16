-- Bug found by the cross-tenant isolation test suite (Faz 1): the public.*
-- wrappers from 20260815120019 were `security invoker`, so calling them via
-- RPC executed their body as the CALLING role (authenticated) — which has
-- no USAGE on the `private` schema (revoked in 20260815120014). Every RPC
-- call failed with "permission denied for schema private", and the same
-- bug silently broke onboarding (public.create_tenant relies on this).
--
-- Fix: `security definer` so the inner private.* call runs as the
-- function owner (has full schema access), not the caller. Safe — these
-- wrappers still only ever forward to the same already-audited private.*
-- functions with the caller's own arguments; no new trust boundary opens.
-- (RLS policies that reference private.* directly were never affected —
-- see this migration's companion note in the Faz 1 report.)

create or replace function public.has_permission(p_tenant_id uuid, p_permission_key text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select private.has_permission(p_tenant_id, p_permission_key);
$$;

create or replace function public.has_feature(p_tenant_id uuid, p_feature_key text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select private.has_feature(p_tenant_id, p_feature_key);
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select private.is_platform_admin();
$$;

create or replace function public.create_tenant(p_name text, p_slug text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.create_tenant_with_owner(p_name, p_slug);
$$;
