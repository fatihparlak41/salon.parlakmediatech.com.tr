-- Faz 1.9 DEV<->PROD parity check found DEV granting service_role things
-- PROD never had: EXECUTE on 14 public.* functions and full DML on all
-- 16 public tables. Direct empirical tests confirmed the gap is real
-- (`SET ROLE service_role; SELECT ...` -> 42501 permission denied on
-- PROD for both a function call and a plain table SELECT), not
-- cosmetic: rolbypassrls does not substitute for a base GRANT.
--
-- Root cause, found via pg_default_acl comparison: DEV carries a
-- `FOR ROLE postgres` default-privilege rule — predating every
-- migration in this repo (grepped all 29 prior files for a
-- GRANT-flavored `ALTER DEFAULT PRIVILEGES`; only REVOKEs exist) —
-- that auto-grants EXECUTE on functions to anon/authenticated/
-- service_role, and full DML on tables to service_role. PROD (a fresh
-- bootstrap) never had it. That means DEV's "every future function
-- needs an explicit grant" intent (20260816090005's own comment) was
-- never actually enforced at the database level: a new function
-- created on DEV without a manual revoke would silently reopen
-- anon/authenticated access. This migration closes that for good,
-- targeting PROD's own (stricter, already-correct) behavior rather
-- than inventing a new posture.
--
-- Decision (see chat, 2026-08-17): least-privilege / explicit
-- whitelist for service_role, no broad admin-by-default assumption.
-- createAdminClient() (lib/supabase/admin.ts) has zero callers in
-- application code today, so it gets nothing here. The narrow grants
-- in part C exist solely because tests/helpers.ts's fixture
-- setup/teardown — used by every test file, not just this one — calls
-- PostgREST through the service-role client for cross-tenant fixture
-- creation a signed-in user's own RLS-scoped client cannot do. Every
-- grant below was derived by reading each `admin.from(...)` /
-- `admin.rpc(...)` call site, not assumed.

-- =====================================================================
-- Part A — future objects: normalize FOR ROLE postgres defaults in
-- `public` so nothing created from here on inherits broad access.
-- ALTER DEFAULT PRIVILEGES never touches existing objects; see Part B.
-- =====================================================================

-- Functions: 20260816090005 only revoked EXECUTE from PUBLIC, which
-- never touched DEV's named-role (anon/authenticated/service_role)
-- default — that's the actual gap. Fixes it for all three at once.
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;

-- Tables: 20260816090006 already closed this for anon/authenticated
-- (`revoke all on tables from anon, authenticated`); service_role was
-- never touched. Scoped to SELECT/INSERT/UPDATE/DELETE only —
-- MAINTAIN/REFERENCES/TRIGGER/TRUNCATE are PROD's own existing default
-- for service_role (schema-maintenance privileges, not data access)
-- and are left as-is; this migration targets PROD's current posture,
-- not a stricter one invented here.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from service_role;

-- Sequences: no prior migration has touched this. Matches PROD's
-- target exactly (nobody but the owner gets a sequence default
-- there) — revoking UPDATE too, not just USAGE/SELECT, since a future
-- SERIAL/IDENTITY sequence left at the default would otherwise let
-- anon/authenticated call setval() and directly rewrite the counter.
alter default privileges for role postgres in schema public
  revoke select, update, usage on sequences from anon, authenticated, service_role;

-- =====================================================================
-- Part B — existing objects: strip service_role's inherited over-grant
-- from every table/function that predates this migration. anon and
-- authenticated are untouched here — their existing grants are already
-- the intentional whitelist asserted by
-- tests/security-grants-regression.test.ts, confirmed passing before
-- this migration was written.
-- =====================================================================

revoke select, insert, update, delete on all tables in schema public from service_role;
revoke execute on all functions in schema public from service_role;

-- =====================================================================
-- Part C — new audit function: makes Part A's fix independently
-- verifiable, and stands as the standing regression check that Part A
-- doesn't silently regress. `pg_default_acl` is where the entire
-- DEV/PROD divergence this migration fixes was actually found and
-- proven — this exposes exactly that view, scoped to the one thing
-- that matters: does `postgres` currently leave any FOR-ROLE default
-- that hands anon/authenticated/service_role something in public or
-- private. A clean environment returns zero rows.
-- =====================================================================

create or replace function public.security_audit_default_privileges()
returns table (
  for_role text,
  schema_name text,
  object_type text,
  grantee text,
  privilege_type text
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    pg_get_userbyid(d.defaclrole)::text,
    n.nspname::text,
    d.defaclobjtype::text,
    (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end)::text,
    a.privilege_type
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) as a
  where n.nspname in ('public', 'private')
    and pg_get_userbyid(d.defaclrole) = 'postgres'
    and (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end)
      in ('anon', 'authenticated', 'service_role')
  order by n.nspname, d.defaclobjtype, a.grantee, a.privilege_type;
$$;

revoke execute on function public.security_audit_default_privileges() from public, anon, authenticated;

-- =====================================================================
-- Part D — service_role's proven whitelist. Every line here traces to
-- a specific tests/helpers.ts call site (fixture setup/teardown used
-- by every test file), not to an application code path. If a real
-- runtime need for createAdminClient() appears later (a webhook, a
-- background job), extend this list explicitly for that need — do not
-- widen it back to "service_role is admin, grant everything".
-- =====================================================================

-- tenants: insert (createTestTenant) + select via RETURNING on that
-- same insert + delete (cleanupTenants).
grant select, insert, delete on public.tenants to service_role;

-- role_templates: select only (createTestTenant looks up SALON_OWNER).
grant select on public.role_templates to service_role;

-- roles: insert + select via RETURNING (createTestTenant,
-- createRoleForTenant) + select/delete in cleanupTenants.
grant select, insert, delete on public.roles to service_role;

-- role_template_permissions: select only (createTestTenant clones the
-- template's permission set).
grant select on public.role_template_permissions to service_role;

-- role_permissions: insert (createTestTenant, createRoleForTenant) +
-- delete (cleanupTenants).
grant insert, delete on public.role_permissions to service_role;

-- tenant_memberships: insert + select via RETURNING (createTestTenant,
-- addMembership) + delete (cleanupTenants).
grant select, insert, delete on public.tenant_memberships to service_role;

-- permissions: select only (createRoleForTenant looks up permission
-- keys).
grant select on public.permissions to service_role;

-- audit_logs, branches: delete only (cleanupTenants fixture teardown;
-- both tables are populated via triggers/authenticated-role inserts in
-- normal test flow, never via the admin client).
grant delete on public.audit_logs to service_role;
grant delete on public.branches to service_role;

-- platform_admins: delete only (cleanupPlatformAdmins fixture
-- teardown).
grant delete on public.platform_admins to service_role;

-- The 5 security_audit_*() functions: called exclusively via
-- `admin.rpc(...)` from tests/security-grants-regression.test.ts —
-- confirmed by grepping every admin.rpc(...) call site in tests/.
-- Nothing else in this whitelist calls a public.* RPC via
-- service_role; create_tenant, has_permission, etc. are exercised
-- through a signed-in user's own client elsewhere and rely on
-- authenticated's grant, not this one.
grant execute on function public.security_audit_table_grants() to service_role;
grant execute on function public.security_audit_function_grants() to service_role;
grant execute on function public.security_audit_functions() to service_role;
grant execute on function public.security_audit_rls_status() to service_role;
grant execute on function public.security_audit_column_grants() to service_role;
grant execute on function public.security_audit_default_privileges() to service_role;
