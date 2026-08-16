create table public.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  key text,
  name text not null check (char_length(name) between 1 and 100),
  description text,
  is_system_default boolean not null default false,
  cloned_from_template_id uuid references public.role_templates (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.roles is
  'Tenant-owned roles, cloned from role_templates at onboarding (private.create_tenant_with_owner, 20260815120018). Editing one tenant''s role never affects another — see architecture report section D.';

create index roles_tenant_id_idx on public.roles (tenant_id) where deleted_at is null;
-- Partial: a soft-deleted role's name becomes reusable within the tenant.
create unique index roles_tenant_id_name_idx on public.roles (tenant_id, name)
  where deleted_at is null;

create trigger set_updated_at
  before update on public.roles
  for each row execute function public.set_updated_at();

alter table public.roles enable row level security;
-- Policy added in 20260815120016_rls_policies_identity.sql.

grant select, insert, update on public.roles to authenticated;

create table public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

alter table public.role_permissions enable row level security;
-- Policy added in 20260815120016_rls_policies_identity.sql.

grant select, insert, delete on public.role_permissions to authenticated;
