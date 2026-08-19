-- Phase 2A: tenant-scoped customer records. Reuses customers.view/create/
-- update — already seeded forward-looking in 20260815120005, already
-- distributed to role templates (RECEPTIONIST, STYLIST get view;
-- RECEPTIONIST gets create/update; SALON_OWNER/MANAGER get everything).
-- No new permission needed.

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  full_name text not null check (char_length(full_name) between 1 and 200),
  phone text,
  email text,
  notes text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.customers is
  'Tenant-scoped customer/CRM-lite record. Deliberately minimal for Phase 2 — no loyalty/marketing fields yet (see Phase 2 scope notes).';

create index customers_tenant_id_idx on public.customers (tenant_id) where deleted_at is null;
create index customers_tenant_phone_idx on public.customers (tenant_id, phone) where deleted_at is null;

create trigger set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

alter table public.customers enable row level security;

create policy "customers_select_customers_view" on public.customers
for select to authenticated
using (private.has_permission(tenant_id, 'customers.view'));

create policy "customers_insert_customers_create" on public.customers
for insert to authenticated
with check (private.has_permission(tenant_id, 'customers.create'));

create policy "customers_update_customers_update" on public.customers
for update to authenticated
using (private.has_permission(tenant_id, 'customers.update'))
with check (private.has_permission(tenant_id, 'customers.update'));

grant select, insert, update on public.customers to authenticated;
