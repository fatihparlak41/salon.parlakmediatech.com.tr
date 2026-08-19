-- Phase 2A: which staff can perform which services. Pure join table, same
-- shape as role_permissions (20260815120007) — no redundant tenant_id
-- column; RLS proves both sides share a tenant via the join itself.

create table public.staff_services (
  staff_member_id uuid not null references public.staff_members (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (staff_member_id, service_id)
);

comment on table public.staff_services is
  'Eligibility: staff_member_id may be assigned service_id on an appointment item. Enforced (not just a UI hint) by create_appointment/reschedule_appointment.';

create index staff_services_service_id_idx on public.staff_services (service_id);

alter table public.staff_services enable row level security;

create policy "staff_services_select_member" on public.staff_services
for select to authenticated
using (
  exists (
    select 1 from public.staff_members sm
    where sm.id = staff_services.staff_member_id
      and private.is_tenant_member(sm.tenant_id)
  )
);

-- staff.manage, not services.manage: this is "what is this employee
-- qualified to do", a staff-management decision. A services.manage-only
-- holder (no staff.manage) edits the catalog but not who performs what.
create policy "staff_services_insert_staff_manage" on public.staff_services
for insert to authenticated
with check (
  exists (
    select 1 from public.staff_members sm
    join public.services s on s.tenant_id = sm.tenant_id
    where sm.id = staff_services.staff_member_id
      and s.id = staff_services.service_id
      and private.has_permission(sm.tenant_id, 'staff.manage')
  )
);

create policy "staff_services_delete_staff_manage" on public.staff_services
for delete to authenticated
using (
  exists (
    select 1 from public.staff_members sm
    where sm.id = staff_services.staff_member_id
      and private.has_permission(sm.tenant_id, 'staff.manage')
  )
);

grant select, insert, delete on public.staff_services to authenticated;
