-- Faz FIN.1C.1 (M1) - Permission keys for the personnel ledger (staff finance).
--
-- Two new keys, finance.staff_view (read) and finance.staff_manage (write), guard the personnel period ledger that the
-- next migration creates. Salary and advance data is more sensitive than the expense ledger, so the keys are NOT
-- inherited from finance.view / finance.manage: they exist only in the SALON_OWNER template (which equals the whole
-- permission catalog). The Yonetici, Resepsiyon and Personel templates are untouched and can be granted either key
-- deliberately later through the existing role editor.
--
-- Procedure: supabase/migrations/README.md, "Changing a role template or the permission catalog". The sync at the end
-- adds the two keys to every PRISTINE Owner role in every tenant (one role.template_synced audit row per changed role).
-- Roles an Owner customized (customized_at set) and custom roles are never touched.
--
-- This migration contains nothing else: no table, no function, no grant.

begin;

insert into public.permissions (key, name, category, description) values
  ('finance.staff_view', 'Personel giderlerini görüntüle', 'finance', null),
  ('finance.staff_manage', 'Personel gideri işlemi yap', 'finance', null)
on conflict (key) do update set name = excluded.name, category = excluded.category, description = excluded.description;

insert into public.role_template_permissions (role_template_id, permission_id)
select rt.id, p.id
from public.role_templates rt
cross join public.permissions p
where rt.key = 'SALON_OWNER' and p.key in ('finance.staff_view', 'finance.staff_manage')
on conflict do nothing;

select * from private.sync_pristine_default_roles();

commit;
