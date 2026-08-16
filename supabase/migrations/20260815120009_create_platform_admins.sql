create table public.platform_admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id),
  role text not null default 'support'
    check (role in ('owner', 'support')),
  is_active boolean not null default true,
  granted_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.platform_admins is
  'Parlak Mediatech staff. Deliberately independent of tenant_memberships/roles — a platform admin is never "a member with a special role" of any tenant (see architecture report sections C and E). role=owner can manage other platform_admins rows; role=support cannot.';

create trigger set_updated_at
  before update on public.platform_admins
  for each row execute function public.set_updated_at();

alter table public.platform_admins enable row level security;
-- Policy added in 20260815120017_rls_policies_platform.sql.

grant select, insert, update on public.platform_admins to authenticated;
