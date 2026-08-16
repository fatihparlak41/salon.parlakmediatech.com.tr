-- tenants: member (any role) can read; settings.manage can update. No
-- insert/delete policy — creation goes through
-- private.create_tenant_with_owner() (20260815120018), hard-delete is a
-- manual super-admin/service_role operation, never a product button.

create policy "tenants_select_member" on public.tenants
for select to authenticated
using (
  id in (select private.current_tenant_ids())
  or private.is_platform_admin()
);

create policy "tenants_update_settings_manage" on public.tenants
for update to authenticated
using (
  private.has_permission(id, 'settings.manage')
  or private.is_platform_admin()
)
with check (
  private.has_permission(id, 'settings.manage')
  or private.is_platform_admin()
);

-- profiles: everyone manages only their own row. Cross-tenant staff
-- visibility (seeing a colleague's name) is deferred to Faz 2 when a real
-- staff-list UI needs it.

create policy "profiles_select_own" on public.profiles
for select to authenticated
using (id = auth.uid());

create policy "profiles_update_own" on public.profiles
for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

-- branches: member reads; settings.manage writes.

create policy "branches_select_member" on public.branches
for select to authenticated
using (
  private.is_tenant_member(tenant_id)
  or private.is_platform_admin()
);

create policy "branches_insert_settings_manage" on public.branches
for insert to authenticated
with check (private.has_permission(tenant_id, 'settings.manage'));

create policy "branches_update_settings_manage" on public.branches
for update to authenticated
using (
  private.has_permission(tenant_id, 'settings.manage')
  or private.is_platform_admin()
)
with check (
  private.has_permission(tenant_id, 'settings.manage')
  or private.is_platform_admin()
);

-- roles / role_permissions: member reads; staff.manage writes. Note: this
-- lets a tenant customize its cloned roles freely without affecting any
-- other tenant (see 20260815120007 comment).

create policy "roles_select_member" on public.roles
for select to authenticated
using (
  private.is_tenant_member(tenant_id)
  or private.is_platform_admin()
);

create policy "roles_insert_staff_manage" on public.roles
for insert to authenticated
with check (private.has_permission(tenant_id, 'staff.manage'));

create policy "roles_update_staff_manage" on public.roles
for update to authenticated
using (
  private.has_permission(tenant_id, 'staff.manage')
  or private.is_platform_admin()
)
with check (
  private.has_permission(tenant_id, 'staff.manage')
  or private.is_platform_admin()
);

create policy "role_permissions_select_member" on public.role_permissions
for select to authenticated
using (
  exists (
    select 1 from public.roles r
    where r.id = role_permissions.role_id
      and (private.is_tenant_member(r.tenant_id) or private.is_platform_admin())
  )
);

create policy "role_permissions_insert_staff_manage" on public.role_permissions
for insert to authenticated
with check (
  exists (
    select 1 from public.roles r
    where r.id = role_permissions.role_id
      and private.has_permission(r.tenant_id, 'staff.manage')
  )
);

create policy "role_permissions_delete_staff_manage" on public.role_permissions
for delete to authenticated
using (
  exists (
    select 1 from public.roles r
    where r.id = role_permissions.role_id
      and private.has_permission(r.tenant_id, 'staff.manage')
  )
);

-- tenant_memberships: member reads; staff.manage writes for INVITING
-- others (the first/owner membership is created by
-- private.create_tenant_with_owner(), bypassing this). A staff.manage
-- holder can update anyone's membership EXCEPT their own — closes the most
-- direct self-escalation path (a colluding pair of admins swapping roles
-- for each other is a separate, harder problem — see Faz 1 report "open
-- risks").

create policy "tenant_memberships_select_member" on public.tenant_memberships
for select to authenticated
using (
  private.is_tenant_member(tenant_id)
  or private.is_platform_admin()
);

create policy "tenant_memberships_insert_staff_manage" on public.tenant_memberships
for insert to authenticated
with check (private.has_permission(tenant_id, 'staff.manage'));

create policy "tenant_memberships_update_staff_manage" on public.tenant_memberships
for update to authenticated
using (
  (private.has_permission(tenant_id, 'staff.manage') and user_id <> auth.uid())
  or private.is_platform_admin()
)
with check (
  (private.has_permission(tenant_id, 'staff.manage') and user_id <> auth.uid())
  or private.is_platform_admin()
);
