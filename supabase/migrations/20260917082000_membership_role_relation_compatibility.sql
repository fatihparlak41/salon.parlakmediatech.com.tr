-- Faz SAAS.1C.1R2 — membership/role relation backward-compatibility.
--
-- 20260917081000 added tenant_memberships_role_same_tenant, a composite
-- (role_id, tenant_id) -> roles(id, tenant_id) FK, alongside the
-- pre-existing plain tenant_memberships_role_id_fkey (role_id) ->
-- roles(id). That correctly enforces same-tenant integrity, but gives
-- PostgREST TWO relationship paths between tenant_memberships and
-- roles, which makes any unhinted `roles(name)` embed ambiguous
-- (PGRST201, confirmed live before this migration: a real signed-in
-- client's unhinted select failed with "Multiple Choices" while
-- roles!tenant_memberships_role_id_fkey(name) succeeded). The
-- application was updated to the explicit-hint form in SAAS.1C.1R.
--
-- The problem that creates: once the composite FK reaches PROD, rolling
-- Vercel back to the immediately-previous production application (which
-- still uses the unhinted embed) would break on live PROD data — a
-- schema that makes application rollback unsafe. We need a schema
-- compatible with BOTH the current explicit-hint application AND the
-- previous production application's unhinted embed, simultaneously.
--
-- Fix: drop the composite FK entirely (back to exactly one
-- tenant_memberships -> roles relationship, restoring unhinted-embed
-- compatibility) and replace its integrity guarantee with a plain
-- BEFORE trigger instead of a second FK. A trigger contributes zero
-- additional PostgREST-visible foreign-key relationships (PostgREST's
-- relationship discovery is FK-constraint-based only), so it protects
-- the same invariant — a membership must never reference a role
-- belonging to a different tenant — without reintroducing the
-- ambiguity. Unlike the last-unrestricted-holder invariant's deferred
-- constraint triggers (PART 1 of 20260917080000), this check has no
-- multi-row/concurrency race to guard against: it's a single-row point
-- lookup ("does NEW.role_id currently belong to NEW.tenant_id") with no
-- aggregate state to race on, so a plain immediate BEFORE trigger is
-- the correct, simpler mechanism — it rejects the write outright via
-- RAISE, exactly like a real FK would, before the row is ever stored.
--
-- Fires on INSERT and on UPDATE OF role_id, tenant_id only — an update
-- to any other column (e.g. the existing authenticated-reachable
-- column-level status UPDATE) never touches this trigger at all.

-- ---------------------------------------------------------------------
-- 1. Trigger function
-- ---------------------------------------------------------------------

create or replace function private.assert_tenant_membership_role_same_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.roles
    where roles.id = new.role_id and roles.tenant_id = new.tenant_id
  ) then
    raise exception 'membership_role_tenant_mismatch';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. PUBLIC execute revoked explicitly — see 20260917080000's own
--    grants section for why this can't be left to a project-wide
--    default: CREATE FUNCTION grants EXECUTE to PUBLIC unless revoked.
--    No authenticated grant either — this is trigger-invoked only, same
--    as the two enforce_unrestricted_holder_on_*_change functions.
-- ---------------------------------------------------------------------

revoke execute on function private.assert_tenant_membership_role_same_tenant() from public;

-- ---------------------------------------------------------------------
-- 3. Trigger — created BEFORE the composite FK is dropped below, so DEV
--    is never left without same-tenant enforcement at any point in this
--    migration.
-- ---------------------------------------------------------------------

create trigger tenant_memberships_role_same_tenant_guard
  before insert or update of role_id, tenant_id on public.tenant_memberships
  for each row
  execute function private.assert_tenant_membership_role_same_tenant();

-- ---------------------------------------------------------------------
-- 4. Drop the composite FK — back to exactly one tenant_memberships ->
--    roles relationship (tenant_memberships_role_id_fkey, unrenamed),
--    restoring PostgREST embed compatibility with both the current
--    explicit-hint application and the previous unhinted one.
-- ---------------------------------------------------------------------

alter table public.tenant_memberships drop constraint tenant_memberships_role_same_tenant;
