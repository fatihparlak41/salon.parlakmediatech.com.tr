create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  category text not null,
  created_at timestamptz not null default now()
);

comment on table public.permissions is
  'Global permission catalog. Seeded here and only here — application code must never branch on role names, only on these keys (see CLAUDE.md).';

alter table public.permissions enable row level security;
-- Policy added in 20260815120015_rls_policies_catalog.sql.

grant select on public.permissions to authenticated;
-- No write grant: catalog changes only ship via migration.

insert into public.permissions (key, name, category, description) values
  ('appointments.view', 'Randevuları görüntüle', 'appointments', null),
  ('appointments.create', 'Randevu oluştur', 'appointments', null),
  ('appointments.update', 'Randevu güncelle', 'appointments', null),
  ('appointments.cancel', 'Randevu iptal et', 'appointments', null),
  ('customers.view', 'Müşterileri görüntüle', 'customers', null),
  ('customers.create', 'Müşteri oluştur', 'customers', null),
  ('customers.update', 'Müşteri güncelle', 'customers', null),
  ('finance.view', 'Finansal verileri görüntüle', 'finance', null),
  ('finance.manage', 'Finansal işlem yap', 'finance', null),
  ('inventory.view', 'Stok durumunu görüntüle', 'inventory', null),
  ('inventory.manage', 'Stok yönet', 'inventory', null),
  ('staff.view', 'Personeli görüntüle', 'staff', null),
  ('staff.manage', 'Personel/rol yönet', 'staff', null),
  ('reports.basic', 'Temel raporları görüntüle', 'reports', null),
  ('reports.financial', 'Finansal raporları görüntüle', 'reports', null),
  ('reports.staff', 'Personel raporlarını görüntüle', 'reports', null),
  ('settings.manage', 'Salon ayarlarını yönet', 'settings', null)
on conflict (key) do update set
  name = excluded.name,
  category = excluded.category,
  description = excluded.description;
