-- Phase 2A: recurring weekly availability + date-specific exceptions.
-- weekday uses Postgres's own EXTRACT(DOW) convention (0=Sunday..
-- 6=Saturday) so RPC logic can compare directly without translating a
-- Turkish/localized day name anywhere near the database.

insert into public.permissions (key, name, category, description) values
  ('schedules.view', 'Çalışma programlarını görüntüle', 'schedules', null),
  ('schedules.manage', 'Çalışma programlarını yönet', 'schedules', null)
on conflict (key) do update set
  name = excluded.name,
  category = excluded.category,
  description = excluded.description;

insert into public.role_template_permissions (role_template_id, permission_id)
select rt.id, p.id
from public.role_templates rt
cross join public.permissions p
where (rt.key = 'SALON_OWNER' and p.key in ('schedules.view', 'schedules.manage'))
   or (rt.key = 'SALON_MANAGER' and p.key in ('schedules.view', 'schedules.manage'))
   or (rt.key = 'RECEPTIONIST' and p.key = 'schedules.view')
   or (rt.key = 'STYLIST' and p.key = 'schedules.view')
on conflict do nothing;

create table public.staff_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  staff_member_id uuid not null references public.staff_members (id) on delete cascade,
  branch_id uuid references public.branches (id),
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint staff_schedules_time_order check (end_time > start_time)
);

comment on table public.staff_schedules is
  'Recurring weekly working hours. weekday: 0=Sunday..6=Saturday (matches Postgres EXTRACT(DOW)). Overlapping rows for the same staff+weekday are not constrained at this level — a data-quality concern for the tenant to fix, not a booking-safety one; the booking-safety invariant lives on appointment_items (20260819_create_appointments).';

create index staff_schedules_staff_member_id_idx on public.staff_schedules (staff_member_id) where deleted_at is null;
create index staff_schedules_tenant_id_idx on public.staff_schedules (tenant_id) where deleted_at is null;

create trigger set_updated_at
  before update on public.staff_schedules
  for each row execute function public.set_updated_at();

alter table public.staff_schedules enable row level security;

create policy "staff_schedules_select_member" on public.staff_schedules
for select to authenticated
using (private.is_tenant_member(tenant_id));

create policy "staff_schedules_insert_schedules_manage" on public.staff_schedules
for insert to authenticated
with check (private.has_permission(tenant_id, 'schedules.manage'));

create policy "staff_schedules_update_schedules_manage" on public.staff_schedules
for update to authenticated
using (private.has_permission(tenant_id, 'schedules.manage'))
with check (private.has_permission(tenant_id, 'schedules.manage'));

grant select, insert, update on public.staff_schedules to authenticated;

create table public.staff_schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  staff_member_id uuid not null references public.staff_members (id) on delete cascade,
  exception_date date not null,
  type text not null check (type in ('unavailable', 'custom_hours')),
  start_time time,
  end_time time,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint staff_schedule_exceptions_hours_shape check (
    (type = 'unavailable' and start_time is null and end_time is null)
    or (type = 'custom_hours' and start_time is not null and end_time is not null and end_time > start_time)
  )
);

comment on table public.staff_schedule_exceptions is
  'Date-specific override: a day off/leave (type=unavailable) or different-than-usual hours (type=custom_hours) for one staff member on one date. Checked before the recurring staff_schedules row in the availability RPCs.';

create index staff_schedule_exceptions_staff_date_idx
  on public.staff_schedule_exceptions (staff_member_id, exception_date)
  where deleted_at is null;
create index staff_schedule_exceptions_tenant_id_idx
  on public.staff_schedule_exceptions (tenant_id) where deleted_at is null;
create unique index staff_schedule_exceptions_unique_per_date
  on public.staff_schedule_exceptions (staff_member_id, exception_date)
  where deleted_at is null;

create trigger set_updated_at
  before update on public.staff_schedule_exceptions
  for each row execute function public.set_updated_at();

alter table public.staff_schedule_exceptions enable row level security;

create policy "staff_schedule_exceptions_select_member" on public.staff_schedule_exceptions
for select to authenticated
using (private.is_tenant_member(tenant_id));

create policy "staff_schedule_exceptions_insert_schedules_manage" on public.staff_schedule_exceptions
for insert to authenticated
with check (private.has_permission(tenant_id, 'schedules.manage'));

create policy "staff_schedule_exceptions_update_schedules_manage" on public.staff_schedule_exceptions
for update to authenticated
using (private.has_permission(tenant_id, 'schedules.manage'))
with check (private.has_permission(tenant_id, 'schedules.manage'));

grant select, insert, update on public.staff_schedule_exceptions to authenticated;
