-- Faz SAAS.1E.1 (part 10) — the full audit log, and the tenant's billing rows,
-- are read by unrestricted holders only.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- 1. audit_logs. audit_logs_select_scoped let every staff.manage holder — in
--    practice every Yönetici — read the ENTIRE tenant audit log. That log is
--    the record of everything, and it records rows WHOLE: the staff audit
--    trigger stores to_jsonb(old/new) (e-mail, phone, login link), customer
--    and invitation events carry names and e-mail addresses, and role /
--    permission / membership events describe the Owner. A Yönetici manages the
--    team; that does not make them the auditor of the Owner.
--
--    Until a dedicated, granular audit permission exists, reading the tenant's
--    audit log requires permissions.manage_unrestricted — the same permission
--    the SAAS.1E.0 authority model already treats as "the owner". No new
--    permission is introduced. Platform-level rows (tenant_id IS NULL) stay
--    readable by platform admins exactly as before.
--
--    Nothing in the application reads audit_logs (audit rows are only WRITTEN,
--    by SECURITY DEFINER functions, which this does not touch); append-only
--    semantics are unchanged (authenticated has SELECT only, no write grant).
--
-- 2. subscriptions and tenant_features. Any member of a salon could read the
--    tenant's subscription row — including the billing provider's customer and
--    subscription identifiers — and the platform's internal note on each
--    feature flag. No application code reads either table directly (feature
--    checks go through SECURITY DEFINER functions and RPCs). They are owner /
--    platform-admin data: unrestricted holders and platform admins keep read
--    access, nobody else has it.

drop policy if exists audit_logs_select_scoped on public.audit_logs;

create policy audit_logs_select_scoped on public.audit_logs
  for select
  to authenticated
  using (
    ((tenant_id is null) and private.is_platform_admin())
    or ((tenant_id is not null) and private.has_permission(tenant_id, 'permissions.manage_unrestricted'))
  );

drop policy if exists subscriptions_select_member on public.subscriptions;

create policy subscriptions_select_unrestricted on public.subscriptions
  for select
  to authenticated
  using (
    private.has_permission(tenant_id, 'permissions.manage_unrestricted')
    or private.is_platform_admin()
  );

drop policy if exists tenant_features_select_member on public.tenant_features;

create policy tenant_features_select_unrestricted on public.tenant_features
  for select
  to authenticated
  using (
    private.has_permission(tenant_id, 'permissions.manage_unrestricted')
    or private.is_platform_admin()
  );
