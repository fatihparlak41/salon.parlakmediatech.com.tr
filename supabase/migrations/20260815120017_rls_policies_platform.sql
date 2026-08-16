-- platform_admins: only platform admins can see this table at all.
-- role=owner manages membership (grant/revoke); role=support cannot.

create policy "platform_admins_select_admin" on public.platform_admins
for select to authenticated
using (private.is_platform_admin());

create policy "platform_admins_insert_owner" on public.platform_admins
for insert to authenticated
with check (private.is_platform_owner());

create policy "platform_admins_update_owner" on public.platform_admins
for update to authenticated
using (private.is_platform_owner())
with check (private.is_platform_owner());

-- subscriptions / tenant_features: tenant members can read their own
-- tenant's billing/feature state; only platform_admin writes (no
-- self-serve plan changes yet — that needs a payment provider first).

create policy "subscriptions_select_member" on public.subscriptions
for select to authenticated
using (
  private.is_tenant_member(tenant_id)
  or private.is_platform_admin()
);

create policy "subscriptions_insert_platform_admin" on public.subscriptions
for insert to authenticated
with check (private.is_platform_admin());

create policy "subscriptions_update_platform_admin" on public.subscriptions
for update to authenticated
using (private.is_platform_admin())
with check (private.is_platform_admin());

create policy "tenant_features_select_member" on public.tenant_features
for select to authenticated
using (
  private.is_tenant_member(tenant_id)
  or private.is_platform_admin()
);

create policy "tenant_features_insert_platform_admin" on public.tenant_features
for insert to authenticated
with check (private.is_platform_admin());

create policy "tenant_features_update_platform_admin" on public.tenant_features
for update to authenticated
using (private.is_platform_admin())
with check (private.is_platform_admin());

-- audit_logs: read-only via RLS for everyone (no update/delete policy
-- exists for any role — see 20260815120013). Tenant-level events need
-- staff.manage (matches "SALON_OWNER/SALON_MANAGER can see the audit
-- trail" from the architecture report — both templates hold staff.manage).
-- Platform-level events (tenant_id is null) are platform_admin-only.

create policy "audit_logs_select_tenant" on public.audit_logs
for select to authenticated
using (
  (tenant_id is not null and private.has_permission(tenant_id, 'staff.manage'))
  or private.is_platform_admin()
);
