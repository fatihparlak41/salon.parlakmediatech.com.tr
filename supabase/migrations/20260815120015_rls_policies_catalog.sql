-- Global catalogs: readable by any signed-in user. permissions,
-- role_templates and role_template_permissions have no write policy at all
-- (catalog changes only ship via migration). plans/features/plan_features
-- are writable by platform_admin only (the paid-plan catalog).

create policy "permissions_select_all" on public.permissions
for select to authenticated
using (true);

create policy "role_templates_select_all" on public.role_templates
for select to authenticated
using (true);

create policy "role_template_permissions_select_all" on public.role_template_permissions
for select to authenticated
using (true);

create policy "plans_select_all" on public.plans
for select to authenticated
using (true);

create policy "plans_insert_platform_admin" on public.plans
for insert to authenticated
with check (private.is_platform_admin());

create policy "plans_update_platform_admin" on public.plans
for update to authenticated
using (private.is_platform_admin())
with check (private.is_platform_admin());

create policy "features_select_all" on public.features
for select to authenticated
using (true);

create policy "features_insert_platform_admin" on public.features
for insert to authenticated
with check (private.is_platform_admin());

create policy "features_update_platform_admin" on public.features
for update to authenticated
using (private.is_platform_admin())
with check (private.is_platform_admin());

create policy "plan_features_select_all" on public.plan_features
for select to authenticated
using (true);

create policy "plan_features_insert_platform_admin" on public.plan_features
for insert to authenticated
with check (private.is_platform_admin());

create policy "plan_features_delete_platform_admin" on public.plan_features
for delete to authenticated
using (private.is_platform_admin());
