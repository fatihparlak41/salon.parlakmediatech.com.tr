create table public.role_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

comment on table public.role_templates is
  'Global role presets. Cloned into a tenant''s own public.roles row at onboarding time — never referenced directly, so editing a tenant''s cloned role never affects another tenant or the template itself.';

create table public.role_template_permissions (
  role_template_id uuid not null references public.role_templates (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  primary key (role_template_id, permission_id)
);

alter table public.role_templates enable row level security;
alter table public.role_template_permissions enable row level security;
-- Policies added in 20260815120015_rls_policies_catalog.sql.

grant select on public.role_templates to authenticated;
grant select on public.role_template_permissions to authenticated;

insert into public.role_templates (key, name, description) values
  ('SALON_OWNER', 'Salon Sahibi', 'Tam yetki'),
  ('SALON_MANAGER', 'Salon Müdürü', 'settings.manage dışında tam yetki'),
  ('RECEPTIONIST', 'Resepsiyonist', 'Randevu ve müşteri yönetimi'),
  ('STYLIST', 'Kuaför', 'Kendi randevuları ve müşteri görüntüleme'),
  ('CASHIER', 'Kasiyer', 'Ödeme ve tahsilat'),
  ('STOCK_MANAGER', 'Stok Sorumlusu', 'Stok yönetimi'),
  ('ACCOUNTANT', 'Muhasebeci', 'Finansal yönetim ve raporlama')
on conflict (key) do update set
  name = excluded.name,
  description = excluded.description;

-- Starting permission sets — tenant-editable after cloning, not fixed.
insert into public.role_template_permissions (role_template_id, permission_id)
select rt.id, p.id
from public.role_templates rt
cross join public.permissions p
where (rt.key = 'SALON_OWNER')
   or (rt.key = 'SALON_MANAGER' and p.key <> 'settings.manage')
   or (rt.key = 'RECEPTIONIST' and p.key in (
        'appointments.view', 'appointments.create', 'appointments.update',
        'appointments.cancel', 'customers.view', 'customers.create',
        'customers.update', 'reports.basic'
      ))
   or (rt.key = 'STYLIST' and p.key in (
        'appointments.view', 'appointments.update', 'customers.view'
      ))
   or (rt.key = 'CASHIER' and p.key in (
        'appointments.view', 'finance.view', 'finance.manage', 'reports.basic'
      ))
   or (rt.key = 'STOCK_MANAGER' and p.key in (
        'inventory.view', 'inventory.manage', 'reports.basic'
      ))
   or (rt.key = 'ACCOUNTANT' and p.key in (
        'finance.view', 'finance.manage', 'reports.financial', 'reports.basic'
      ))
on conflict do nothing;
