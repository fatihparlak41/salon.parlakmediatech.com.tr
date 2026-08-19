-- Phase 2A: service catalog. New permission keys — services.* didn't
-- exist before Phase 2 (appointments.*/customers.*/staff.* were already
-- seeded forward-looking in 20260815120005).

insert into public.permissions (key, name, category, description) values
  ('services.view', 'Hizmetleri görüntüle', 'services', null),
  ('services.manage', 'Hizmet kataloğunu yönet', 'services', null)
on conflict (key) do update set
  name = excluded.name,
  category = excluded.category,
  description = excluded.description;

insert into public.role_template_permissions (role_template_id, permission_id)
select rt.id, p.id
from public.role_templates rt
cross join public.permissions p
where (rt.key = 'SALON_OWNER' and p.key in ('services.view', 'services.manage'))
   or (rt.key = 'SALON_MANAGER' and p.key in ('services.view', 'services.manage'))
   or (rt.key = 'RECEPTIONIST' and p.key = 'services.view')
   or (rt.key = 'STYLIST' and p.key = 'services.view')
   or (rt.key = 'CASHIER' and p.key = 'services.view')
on conflict do nothing;

create table public.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  branch_id uuid references public.branches (id),
  category text,
  name text not null check (char_length(name) between 1 and 200),
  description text,
  duration_minutes integer not null check (duration_minutes > 0),
  price numeric(10, 2) not null check (price >= 0),
  status text not null default 'active' check (status in ('active', 'inactive')),
  display_order integer not null default 0,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.services is
  'Service catalog. branch_id null = available at every branch. Price/duration are copied into appointment_items at booking time — this table''s current values are never read after the fact for an existing appointment.';

create index services_tenant_id_idx on public.services (tenant_id) where deleted_at is null;
create index services_branch_id_idx on public.services (branch_id) where deleted_at is null;
create index services_tenant_category_idx on public.services (tenant_id, category) where deleted_at is null;

create trigger set_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

alter table public.services enable row level security;

create policy "services_select_member" on public.services
for select to authenticated
using (private.is_tenant_member(tenant_id));

create policy "services_insert_services_manage" on public.services
for insert to authenticated
with check (private.has_permission(tenant_id, 'services.manage'));

create policy "services_update_services_manage" on public.services
for update to authenticated
using (private.has_permission(tenant_id, 'services.manage'))
with check (private.has_permission(tenant_id, 'services.manage'));

grant select, insert, update on public.services to authenticated;
