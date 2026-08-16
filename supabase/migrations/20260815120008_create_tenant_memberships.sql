create table public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  user_id uuid not null references auth.users (id),
  role_id uuid not null references public.roles (id),
  status text not null default 'active'
    check (status in ('invited', 'active', 'suspended')),
  invited_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.tenant_memberships is
  'User <-> tenant <-> role. Deliberately NOT named "memberships" — that name is reserved for a future customer loyalty/membership product to avoid a collision (see architecture report section Q). This table is the sole source private.current_tenant_ids() reads from.';

create index tenant_memberships_user_id_idx on public.tenant_memberships (user_id)
  where deleted_at is null;
create index tenant_memberships_tenant_id_idx on public.tenant_memberships (tenant_id)
  where deleted_at is null;
-- Partial: a removed (soft-deleted) member can be re-invited later without
-- fighting a stale unique constraint.
create unique index tenant_memberships_tenant_user_idx
  on public.tenant_memberships (tenant_id, user_id)
  where deleted_at is null;

create trigger set_updated_at
  before update on public.tenant_memberships
  for each row execute function public.set_updated_at();

alter table public.tenant_memberships enable row level security;
-- Policy added in 20260815120016_rls_policies_identity.sql. The very first
-- membership for a brand-new tenant is created by
-- private.create_tenant_with_owner() (SECURITY DEFINER, bypasses this grant
-- intentionally) because the creating user has no membership yet to check
-- has_permission() against — later invites go through the normal grant+policy.

grant select, insert, update on public.tenant_memberships to authenticated;
