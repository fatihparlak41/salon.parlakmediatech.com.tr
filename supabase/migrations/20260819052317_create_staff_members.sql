-- Phase 2A: salon employee, deliberately separate from tenant_memberships.
-- A staff member is a business/operational entity (someone who performs
-- services) — they may or may not ever log into SalonOS. Optional link to
-- a login identity is via tenant_membership_id, not auth.users directly,
-- so the link is inherently tenant-scoped and reuses the composite FK
-- trick below rather than a trigger to guarantee it can't point at a
-- membership belonging to a different tenant.

-- Enables the composite FK from staff_members below. Redundant with the
-- existing PK on id alone (id is already globally unique) but Postgres
-- requires the referenced columns to have a unique constraint of their
-- own shape to be an FK target.
alter table public.tenant_memberships
  add constraint tenant_memberships_id_tenant_id_key unique (id, tenant_id);

create table public.staff_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  branch_id uuid references public.branches (id),
  tenant_membership_id uuid references public.tenant_memberships (id),
  full_name text not null check (char_length(full_name) between 1 and 200),
  email text,
  phone text,
  color text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  display_order integer not null default 0,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- Guarantees tenant_membership_id (when set) belongs to the SAME tenant
  -- as this staff row — declaratively, no trigger needed. See
  -- tenant_memberships_id_tenant_id_key above.
  constraint staff_members_membership_same_tenant
    foreign key (tenant_membership_id, tenant_id)
    references public.tenant_memberships (id, tenant_id)
);

comment on table public.staff_members is
  'Salon employee/business entity — NOT the same as tenant_memberships (login+role). tenant_membership_id is optional: most stylists never need a SalonOS login. See supabase/migrations/README.md "Phase 2".';

create index staff_members_tenant_id_idx on public.staff_members (tenant_id) where deleted_at is null;
create index staff_members_branch_id_idx on public.staff_members (branch_id) where deleted_at is null;
-- A tenant_membership can back at most one staff record — prevents two
-- staff rows silently sharing one login identity within a tenant.
create unique index staff_members_tenant_membership_id_idx
  on public.staff_members (tenant_membership_id)
  where deleted_at is null and tenant_membership_id is not null;

create trigger set_updated_at
  before update on public.staff_members
  for each row execute function public.set_updated_at();

alter table public.staff_members enable row level security;

-- Every tenant member can see the staff list (needed to assign staff to
-- an appointment item regardless of which permission granted them
-- appointments.create) — same "member reads, permission writes" shape as
-- branches/roles (20260815120016). No platform_admin bypass: staff is
-- tenant-internal operational structure, narrowed out of platform_admin's
-- scope in 20260816090004 for the same category of table.
create policy "staff_members_select_member" on public.staff_members
for select to authenticated
using (private.is_tenant_member(tenant_id));

create policy "staff_members_insert_staff_manage" on public.staff_members
for insert to authenticated
with check (private.has_permission(tenant_id, 'staff.manage'));

create policy "staff_members_update_staff_manage" on public.staff_members
for update to authenticated
using (private.has_permission(tenant_id, 'staff.manage'))
with check (private.has_permission(tenant_id, 'staff.manage'));

grant select, insert, update on public.staff_members to authenticated;
