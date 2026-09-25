-- Faz SAAS.1E.1 (part 9) — a member can read their OWN membership, not the
-- whole tenant's access graph.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- tenant_memberships_select_member let EVERY active member read EVERY
-- membership row of the tenant: user id, role id, status, who invited whom,
-- when — including suspended members and removed (soft-deleted) rows. Combined
-- with the staff <-> login link that was the salon's whole access graph in one
-- select, for a Personel or Resepsiyon who has no business with it.
--
-- New rule (one policy, one place):
--
--   a member may read
--     * their own ACTIVE membership rows (that is the "access context" the app
--       resolves on every request: which tenants, which role), and
--     * every membership row of a tenant in which they hold staff.manage —
--       the Team and Personnel-management screens (Salon Sahibi, Yönetici).
--
-- No one else sees anything: a suspended or removed member has never been able
-- to read anything, and still cannot. Application audit (every direct read of
-- this table): lib/auth/session.ts (own rows, two places), the dashboard's own
-- membership lookup (own row), lib/modules/staff/queries.ts
-- getAvailableMemberships (staff.manage screens) and lib/modules/team/queries.ts
-- getTeamMembers (Team page, staff.manage). None of them needs more.
--
-- No policy of another table references tenant_memberships (they all go
-- through the SECURITY DEFINER helpers private.is_tenant_member /
-- private.has_permission, which read the table with their owner's rights), so
-- nothing else is affected. Writes are unchanged: authenticated has no
-- INSERT/UPDATE/DELETE grant here (RPC only, since SAAS.1B / SAAS.1E.0).

drop policy if exists tenant_memberships_select_member on public.tenant_memberships;

create policy tenant_memberships_select_scoped on public.tenant_memberships
  for select
  to authenticated
  using (
    (user_id = auth.uid() and status = 'active' and deleted_at is null)
    or private.has_permission(tenant_id, 'staff.manage')
  );
