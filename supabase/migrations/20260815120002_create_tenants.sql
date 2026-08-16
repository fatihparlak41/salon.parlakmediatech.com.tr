create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  slug text not null,
  status text not null default 'trial'
    check (status in ('trial', 'active', 'suspended', 'canceled')),
  timezone text not null default 'Europe/Istanbul',
  currency text not null default 'TRY',
  trial_ends_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint tenants_slug_format check (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 63
  )
);

comment on table public.tenants is
  'Root tenant (salon) record. Every tenant-owned table carries tenant_id referencing this.';

-- Partial (not a plain UNIQUE column constraint) so a soft-deleted tenant's
-- slug becomes reusable — a global constraint would keep it locked forever.
create unique index tenants_slug_idx on public.tenants (slug) where deleted_at is null;
create index tenants_status_idx on public.tenants (status) where deleted_at is null;

create trigger set_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

alter table public.tenants enable row level security;

-- No policies yet (added in 20260815120016_rls_policies_identity.sql, once
-- the private.* helper functions exist). RLS-enabled-with-no-policy means
-- deny-all for anon/authenticated in the meantime — safe by construction.

grant select, update on public.tenants to authenticated;
-- No direct insert grant: tenant creation goes through
-- private.create_tenant_with_owner() (20260815120018), which is
-- SECURITY DEFINER and bypasses this grant intentionally.
