create table public.branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null check (char_length(name) between 1 and 200),
  address text,
  phone text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.branches is
  'Şube. Multi-branch UI does not exist yet (Faz 2+) but the column is reserved from Faz 1 so later tables (staff, inventory, appointments) can carry branch_id from day one.';

create index branches_tenant_id_idx on public.branches (tenant_id) where deleted_at is null;

create trigger set_updated_at
  before update on public.branches
  for each row execute function public.set_updated_at();

alter table public.branches enable row level security;
-- Policy added in 20260815120016_rls_policies_identity.sql.

grant select, insert, update on public.branches to authenticated;
