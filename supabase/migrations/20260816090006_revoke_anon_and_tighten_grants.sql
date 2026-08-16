-- Faz 1.5 security audit finding: every table in `public` had full CRUD
-- (select/insert/update/delete/truncate/references/trigger) granted to
-- BOTH `anon` and `authenticated`, and several functions had `anon`
-- execute — none of this came from any migration in this project. It's
-- Supabase's own project-bootstrap default privileges, applied directly to
-- the `anon`/`authenticated` roles (not via the `PUBLIC` pseudo-role), so
-- every earlier `revoke ... from public` in this project's migrations
-- (20260815120005, 20260815120014, 20260815120019, 20260816090005) never
-- touched it — REVOKE FROM PUBLIC does not remove a grant made directly to
-- a named role.
--
-- RLS was never bypassed by this — every table has RLS enabled with
-- deny-by-default policies (verified via security_audit_rls_status(), and
-- by the cross-tenant isolation test suite passing throughout), so a wide
-- table grant with no matching policy still returns zero rows. But it's a
-- real "gereksiz grants" finding: no defense-in-depth if a future policy
-- is ever written too permissively, and `anon` should not be able to
-- attempt writes on any of these tables at all before Faz 2's public
-- booking feature exists (and even then, only through narrow RPCs per the
-- architecture report, never direct table grants).
--
-- Every table: revoke everything from anon and authenticated, then
-- re-grant exactly what that table's own creation migration intended.
-- `anon` ends up with zero grants on every table below — nothing in the
-- app is anon-facing yet.

revoke all on public.tenants from anon, authenticated;
grant select, update on public.tenants to authenticated;

revoke all on public.profiles from anon, authenticated;
grant select, update on public.profiles to authenticated;

revoke all on public.branches from anon, authenticated;
grant select, insert, update on public.branches to authenticated;

revoke all on public.permissions from anon, authenticated;
grant select on public.permissions to authenticated;

revoke all on public.role_templates from anon, authenticated;
grant select on public.role_templates to authenticated;

revoke all on public.role_template_permissions from anon, authenticated;
grant select on public.role_template_permissions to authenticated;

revoke all on public.roles from anon, authenticated;
grant select, update on public.roles to authenticated;

revoke all on public.role_permissions from anon, authenticated;
grant select on public.role_permissions to authenticated;

revoke all on public.tenant_memberships from anon, authenticated;
grant select, insert on public.tenant_memberships to authenticated;
grant update (status) on public.tenant_memberships to authenticated;

revoke all on public.platform_admins from anon, authenticated;
grant select, insert, update on public.platform_admins to authenticated;

revoke all on public.plans from anon, authenticated;
grant select, insert, update on public.plans to authenticated;

revoke all on public.features from anon, authenticated;
grant select, insert, update on public.features to authenticated;

revoke all on public.plan_features from anon, authenticated;
grant select, insert, delete on public.plan_features to authenticated;

revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;

revoke all on public.tenant_features from anon, authenticated;
grant select on public.tenant_features to authenticated;

revoke all on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;

-- Functions: same issue — `anon` had EXECUTE on every public.* wrapper
-- and on the two trigger functions. Trigger functions (set_updated_at,
-- handle_new_user) are invoked by the trigger mechanism itself, not by a
-- direct call from the DML-issuing role, so they need no EXECUTE grant to
-- anon/authenticated at all — only postgres/service_role (the definer)
-- needs it, and that's implicit via ownership. RPC wrappers need
-- authenticated (that's the whole point) but never anon — nothing here is
-- a public-facing endpoint yet.

revoke execute on function public.set_updated_at() from anon, authenticated;
revoke execute on function public.handle_new_user() from anon, authenticated;

revoke execute on function public.has_permission(uuid, text) from anon;
revoke execute on function public.has_feature(uuid, text) from anon;
revoke execute on function public.is_platform_admin() from anon;
revoke execute on function public.create_tenant(text, text) from anon;
revoke execute on function public.create_role(uuid, text, text, text[]) from anon;
revoke execute on function public.update_role_permissions(uuid, text[]) from anon;
revoke execute on function public.update_membership_role(uuid, uuid) from anon;

revoke execute on function public.security_audit_functions() from anon, authenticated;
revoke execute on function public.security_audit_function_grants() from anon, authenticated;
revoke execute on function public.security_audit_table_grants() from anon, authenticated;
revoke execute on function public.security_audit_rls_status() from anon, authenticated;

-- Belt-and-suspenders for Faz 2+: stop new tables/functions from
-- inheriting anon/authenticated grants automatically, in case this
-- project's migration role happens to match whatever role Supabase's
-- bootstrap used. Not guaranteed to cover it (ALTER DEFAULT PRIVILEGES is
-- scoped to the role that runs it) — the real fix is that every future
-- `..._create_*.sql` migration must keep explicitly granting only what's
-- needed, same as every migration so far. See
-- supabase/migrations/README.md "Lessons".
alter default privileges in schema public revoke all on tables from anon, authenticated;
