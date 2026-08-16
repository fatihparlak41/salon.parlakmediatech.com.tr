-- Faz 1.5: the Faz 1 policies gave platform_admin a blanket
-- `or private.is_platform_admin()` bypass on several tenant-owned tables.
-- That's broader than intended — the report said "platform admin
-- cross-tenant access" but the actual product scope for Faz 1 is: tenant
-- list, tenant status, subscription/feature info. Branches, roles,
-- role_permissions and tenant_memberships are tenant-internal operational
-- structure, not platform administration. A future support-access feature
-- (time-boxed, justified, audited — not an ambient bypass) is the correct
-- way to widen this later; narrowing now instead of leaving the bypass in
-- place "for later" is the point of this migration.
--
-- Left unchanged (still legitimately in scope): tenants (list + status),
-- subscriptions, tenant_features, platform_admins (self-referential).

drop policy if exists "branches_select_member" on public.branches;
create policy "branches_select_member" on public.branches
for select to authenticated
using (private.is_tenant_member(tenant_id));

drop policy if exists "branches_update_settings_manage" on public.branches;
create policy "branches_update_settings_manage" on public.branches
for update to authenticated
using (private.has_permission(tenant_id, 'settings.manage'))
with check (private.has_permission(tenant_id, 'settings.manage'));

drop policy if exists "roles_select_member" on public.roles;
create policy "roles_select_member" on public.roles
for select to authenticated
using (private.is_tenant_member(tenant_id));

drop policy if exists "roles_update_staff_manage" on public.roles;
create policy "roles_update_staff_manage" on public.roles
for update to authenticated
using (private.has_permission(tenant_id, 'staff.manage'))
with check (private.has_permission(tenant_id, 'staff.manage'));

drop policy if exists "role_permissions_select_member" on public.role_permissions;
create policy "role_permissions_select_member" on public.role_permissions
for select to authenticated
using (
  exists (
    select 1 from public.roles r
    where r.id = role_permissions.role_id
      and private.is_tenant_member(r.tenant_id)
  )
);

drop policy if exists "tenant_memberships_select_member" on public.tenant_memberships;
create policy "tenant_memberships_select_member" on public.tenant_memberships
for select to authenticated
using (private.is_tenant_member(tenant_id));

drop policy if exists "tenant_memberships_update_staff_manage" on public.tenant_memberships;
create policy "tenant_memberships_update_staff_manage" on public.tenant_memberships
for update to authenticated
using (private.has_permission(tenant_id, 'staff.manage') and user_id <> auth.uid())
with check (private.has_permission(tenant_id, 'staff.manage') and user_id <> auth.uid());

-- audit_logs: platform_admin sees platform-level events (tenant_id null —
-- their own actions: plan changes, tenant status changes, etc.) but not a
-- specific tenant's operational audit trail just by being a platform
-- admin. Tenant-level rows still need staff.manage on that tenant, same
-- as any tenant member.
drop policy if exists "audit_logs_select_tenant" on public.audit_logs;
create policy "audit_logs_select_scoped" on public.audit_logs
for select to authenticated
using (
  (tenant_id is null and private.is_platform_admin())
  or (tenant_id is not null and private.has_permission(tenant_id, 'staff.manage'))
);
