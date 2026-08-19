-- Phase 2A.1 review — multi-branch model.
--
-- WHAT THE OLD SCHEMA COULD NOT REPRESENT: staff_members.branch_id and
-- services.branch_id were single nullable FKs (NULL = every branch,
-- non-NULL = exactly one). A staff member working an arbitrary SUBSET of
-- branches (e.g. Lefkoşa + Girne, not Mağusa) — an ordinary pattern for a
-- multi-branch salon chain, not an edge case — had no representation:
-- picking one branch_id excludes the others; leaving it NULL wrongly
-- includes Mağusa too. Same gap for a service offered at some but not all
-- branches.
--
-- WORSE, NEITHER COLUMN WAS EVER ENFORCED: neither
-- validate_and_insert_appointment_item nor staff_is_available (20260819052733)
-- ever read staff_members.branch_id or services.branch_id — every
-- appointment test fixture in tests/phase2-appointments.test.ts already
-- created staff/services with no branch_id at all and every booking test
-- passed regardless of which branch_id the appointment itself used
-- (20260819052514's "a branch reference from another tenant is rejected"
-- test only checks the branch belongs to the tenant, never that the
-- staff/service is actually assigned there). The column was decorative:
-- stored, never read by the one code path that matters for booking
-- safety. staff_is_available also never filtered staff_schedules by
-- branch_id at all (that column DOES already support one schedule row
-- per branch, unlike staff_members/services), so a staff member scheduled
-- Monday 9-18 at Branch A already read as "available" for a Branch B
-- appointment at the same time — a real scheduling-correctness gap, not
-- hypothetical, present since 20260819052514/052733 regardless of this
-- migration's schema choice.
--
-- MIGRATION COST NOW VS LATER: zero real tenant data exists (DEV
-- fixtures only), no UI reads either column (Phase 2B has not started —
-- confirmed via a grep across app/ and lib/ turning up zero references).
-- After a Staff/Services UI ships against the single-branch-or-null
-- shape, correcting this would mean UI rework plus a lossy backfill —
-- "branch_id was NULL, meaning all branches" cannot be un-collapsed into
-- which specific subset a tenant actually intended without asking every
-- one of them. Now is unambiguously cheaper.
--
-- DECISION: normalize to staff_branches/service_branches join tables
-- (same shape as staff_services), drop the two decorative columns, and
-- — this is the part that actually matters, a join table nobody checks is
-- exactly as decorative as a column nobody checks — make branch
-- assignment genuinely load-bearing: validate_and_insert_appointment_item
-- now requires a staff_branches/service_branches row for the
-- appointment's branch, and staff_is_available now requires a
-- staff_schedules row whose branch_id is NULL (applies everywhere the
-- staff member is otherwise assigned) or matches the requested branch.
--
-- A staff member or service with zero rows in the new join table is
-- bookable at NO branch until explicitly assigned — not "every branch" —
-- deliberately matching this project's standing rule against silently
-- broad-by-default access (the exact class of bug Faz 1.5/1.9 spent two
-- phases removing at the grant level; repeating "empty means everywhere"
-- at the data level would be the same mistake in a new place). Phase 2B's
-- staff/service UI is expected to default-select the tenant's primary
-- branch when a tenant has exactly one (the common case), so this has no
-- practical friction for single-branch tenants.

create table public.staff_branches (
  staff_member_id uuid not null references public.staff_members (id) on delete cascade,
  branch_id uuid not null references public.branches (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (staff_member_id, branch_id)
);

comment on table public.staff_branches is
  'Which branches a staff member is assigned to work at. Empty = not bookable at any branch yet, not "every branch" — see supabase/migrations/README.md "Phase 2A.1". Enforced by validate_and_insert_appointment_item, not just a UI hint.';

create index staff_branches_branch_id_idx on public.staff_branches (branch_id);

alter table public.staff_branches enable row level security;

create policy "staff_branches_select_member" on public.staff_branches
for select to authenticated
using (
  exists (
    select 1 from public.staff_members sm
    where sm.id = staff_branches.staff_member_id
      and private.is_tenant_member(sm.tenant_id)
  )
);

-- staff.manage, matching staff_services (20260819052413): "which branches
-- can this employee work at" is a staff-management decision.
create policy "staff_branches_insert_staff_manage" on public.staff_branches
for insert to authenticated
with check (
  exists (
    select 1 from public.staff_members sm
    join public.branches b on b.tenant_id = sm.tenant_id
    where sm.id = staff_branches.staff_member_id
      and b.id = staff_branches.branch_id
      and private.has_permission(sm.tenant_id, 'staff.manage')
  )
);

create policy "staff_branches_delete_staff_manage" on public.staff_branches
for delete to authenticated
using (
  exists (
    select 1 from public.staff_members sm
    where sm.id = staff_branches.staff_member_id
      and private.has_permission(sm.tenant_id, 'staff.manage')
  )
);

grant select, insert, delete on public.staff_branches to authenticated;

create table public.service_branches (
  service_id uuid not null references public.services (id) on delete cascade,
  branch_id uuid not null references public.branches (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (service_id, branch_id)
);

comment on table public.service_branches is
  'Which branches offer a service. Empty = not offered anywhere yet, not "every branch" — see staff_branches above for the same reasoning. Enforced by validate_and_insert_appointment_item, not just a UI hint.';

create index service_branches_branch_id_idx on public.service_branches (branch_id);

alter table public.service_branches enable row level security;

create policy "service_branches_select_member" on public.service_branches
for select to authenticated
using (
  exists (
    select 1 from public.services s
    where s.id = service_branches.service_id
      and private.is_tenant_member(s.tenant_id)
  )
);

-- services.manage, matching services' own write policy: which branches
-- carry a service is a catalog-management decision.
create policy "service_branches_insert_services_manage" on public.service_branches
for insert to authenticated
with check (
  exists (
    select 1 from public.services s
    join public.branches b on b.tenant_id = s.tenant_id
    where s.id = service_branches.service_id
      and b.id = service_branches.branch_id
      and private.has_permission(s.tenant_id, 'services.manage')
  )
);

create policy "service_branches_delete_services_manage" on public.service_branches
for delete to authenticated
using (
  exists (
    select 1 from public.services s
    where s.id = service_branches.service_id
      and private.has_permission(s.tenant_id, 'services.manage')
  )
);

grant select, insert, delete on public.service_branches to authenticated;

drop index if exists public.staff_members_branch_id_idx;
alter table public.staff_members drop column branch_id;

drop index if exists public.services_branch_id_idx;
alter table public.services drop column branch_id;

-- Adding p_branch_id changes these two functions' argument signatures —
-- Postgres identifies a function by name+argument types, so CREATE OR
-- REPLACE with a different argument list creates a SECOND, separate
-- function rather than replacing the first. Drop the old signature
-- explicitly so no orphaned, unused 4-argument version is left behind.
drop function if exists private.staff_is_available(uuid, uuid, timestamptz, timestamptz);

-- p_branch_id added, checked only against staff_schedules (recurring —
-- already had its own branch_id column, just never filtered on it).
-- staff_schedule_exceptions has no branch_id and none is added: a day off
-- or custom hours is a property of the person that day, not the
-- location — a real but narrow case (different exception per branch on
-- the same date) that Phase 2 does not need to model.
create or replace function private.staff_is_available(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_staff_member_id uuid,
  p_scheduled_start_at timestamptz,
  p_scheduled_end_at timestamptz
)
returns boolean
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_tz text;
  v_local_date date;
  v_local_start time;
  v_local_end time;
  v_weekday smallint;
  v_exception record;
begin
  select timezone into v_tz from public.tenants where id = p_tenant_id;
  if v_tz is null then
    return false;
  end if;

  v_local_date := (p_scheduled_start_at at time zone v_tz)::date;
  v_local_start := (p_scheduled_start_at at time zone v_tz)::time;
  v_local_end := (p_scheduled_end_at at time zone v_tz)::time;

  if (p_scheduled_end_at at time zone v_tz)::date <> v_local_date then
    return false;
  end if;

  v_weekday := extract(dow from p_scheduled_start_at at time zone v_tz);

  select * into v_exception
  from public.staff_schedule_exceptions
  where staff_member_id = p_staff_member_id
    and exception_date = v_local_date
    and deleted_at is null;

  if found then
    if v_exception.type = 'unavailable' then
      return false;
    end if;
    return v_local_start >= v_exception.start_time and v_local_end <= v_exception.end_time;
  end if;

  return exists (
    select 1
    from public.staff_schedules
    where staff_member_id = p_staff_member_id
      and weekday = v_weekday
      and deleted_at is null
      and (branch_id is null or branch_id = p_branch_id)
      and v_local_start >= start_time
      and v_local_end <= end_time
  );
end;
$$;

comment on function private.staff_is_available(uuid, uuid, uuid, timestamptz, timestamptz) is
  'Working-hours check only — does NOT check for a conflicting appointment (that is appointment_items_no_staff_overlap) or branch assignment (that is staff_branches, checked by validate_and_insert_appointment_item before this is ever called). A staff_schedules row with branch_id NULL applies at every branch the staff member is assigned to via staff_branches; a row with a specific branch_id applies only there.';

drop function if exists private.validate_and_insert_appointment_item(uuid, uuid, jsonb, integer);

create or replace function private.validate_and_insert_appointment_item(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_appointment_id uuid,
  p_item jsonb,
  p_sequence integer
)
returns private.appointment_item_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service record;
  v_staff_member record;
  v_start timestamptz;
  v_end timestamptz;
  v_result private.appointment_item_result;
begin
  select * into v_service
  from public.services
  where id = (p_item ->> 'service_id')::uuid
    and tenant_id = p_tenant_id
    and status = 'active'
    and deleted_at is null;

  if not found then
    raise exception 'service not found or inactive in this tenant';
  end if;

  if not exists (
    select 1 from public.service_branches
    where service_id = v_service.id and branch_id = p_branch_id
  ) then
    raise exception 'service "%" is not offered at this branch', v_service.name;
  end if;

  select * into v_staff_member
  from public.staff_members
  where id = (p_item ->> 'staff_member_id')::uuid
    and tenant_id = p_tenant_id
    and status = 'active'
    and deleted_at is null;

  if not found then
    raise exception 'staff member not found or inactive in this tenant';
  end if;

  if not exists (
    select 1 from public.staff_branches
    where staff_member_id = v_staff_member.id and branch_id = p_branch_id
  ) then
    raise exception 'staff member "%" does not work at this branch', v_staff_member.full_name;
  end if;

  if not exists (
    select 1 from public.staff_services
    where staff_member_id = v_staff_member.id and service_id = v_service.id
  ) then
    raise exception 'staff member "%" is not eligible for service "%"', v_staff_member.full_name, v_service.name;
  end if;

  v_start := (p_item ->> 'scheduled_start_at')::timestamptz;
  v_end := v_start + (v_service.duration_minutes || ' minutes')::interval;

  if not private.staff_is_available(p_tenant_id, p_branch_id, v_staff_member.id, v_start, v_end) then
    raise exception 'staff member "%" is not working at the requested time', v_staff_member.full_name;
  end if;

  begin
    insert into public.appointment_items (
      tenant_id, appointment_id, service_id, staff_member_id,
      scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence
    )
    values (
      p_tenant_id, p_appointment_id, v_service.id, v_staff_member.id,
      v_start, v_end, v_service.duration_minutes, v_service.price, p_sequence
    );
  exception
    when exclusion_violation then
      raise exception 'staff member "%" was just booked for an overlapping time by another request', v_staff_member.full_name;
  end;

  v_result.scheduled_start_at := v_start;
  v_result.scheduled_end_at := v_end;
  return v_result;
end;
$$;

-- create_appointment's own signature is unchanged (p_branch_id was
-- already a parameter — it's the appointment's own branch); only the
-- internal call site threading it into validate_and_insert_appointment_item
-- changes. Full body reproduced from 20260819060500 (immutable once
-- applied) with that one call updated.
create or replace function private.create_appointment(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_notes text default null,
  p_source text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment_id uuid;
  v_item jsonb;
  v_item_result private.appointment_item_result;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_min_start timestamptz;
  v_max_end timestamptz;
  v_sequence integer := 0;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not private.has_permission(p_tenant_id, 'appointments.create') then
    raise exception 'appointments.create required';
  end if;

  if not exists (
    select 1 from public.branches
    where id = p_branch_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'branch not found in this tenant';
  end if;

  if not exists (
    select 1 from public.customers
    where id = p_customer_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'customer not found in this tenant';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'at least one appointment item is required';
  end if;

  select
    min((item ->> 'scheduled_start_at')::timestamptz),
    max((item ->> 'scheduled_start_at')::timestamptz + (s.duration_minutes || ' minutes')::interval)
  into v_range_start, v_range_end
  from jsonb_array_elements(p_items) as item
  left join public.services s
    on s.id = (item ->> 'service_id')::uuid
    and s.tenant_id = p_tenant_id
    and s.status = 'active'
    and s.deleted_at is null;

  if v_range_start is null or v_range_end is null then
    raise exception 'one or more services not found or inactive in this tenant';
  end if;

  insert into public.appointments (
    tenant_id, branch_id, customer_id, notes, source,
    scheduled_start_at, scheduled_end_at, created_by
  )
  values (
    p_tenant_id, p_branch_id, p_customer_id, p_notes, p_source,
    v_range_start, v_range_end, auth.uid()
  )
  returning id into v_appointment_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_sequence := v_sequence + 1;
    v_item_result := private.validate_and_insert_appointment_item(
      p_tenant_id, p_branch_id, v_appointment_id, v_item,
      coalesce((v_item ->> 'sequence')::integer, v_sequence)
    );
    v_min_start := least(coalesce(v_min_start, v_item_result.scheduled_start_at), v_item_result.scheduled_start_at);
    v_max_end := greatest(coalesce(v_max_end, v_item_result.scheduled_end_at), v_item_result.scheduled_end_at);
  end loop;

  update public.appointments
  set scheduled_start_at = v_min_start, scheduled_end_at = v_max_end
  where id = v_appointment_id;

  perform private.log_audit_event(
    p_tenant_id, 'appointment.created', 'appointment', v_appointment_id,
    null, jsonb_build_object('customer_id', p_customer_id, 'items', p_items)
  );

  return v_appointment_id;
end;
$$;

-- reschedule_appointment's signature is also unchanged; it now reads the
-- appointment's own branch_id (already stored on the row it looks up)
-- and threads it through the same way create_appointment does.
create or replace function private.reschedule_appointment(
  p_appointment_id uuid,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_branch_id uuid;
  v_status text;
  v_item jsonb;
  v_item_result private.appointment_item_result;
  v_min_start timestamptz;
  v_max_end timestamptz;
  v_sequence integer := 0;
  v_before jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select tenant_id, branch_id, status into v_tenant_id, v_branch_id, v_status
  from public.appointments
  where id = p_appointment_id;

  if v_tenant_id is null then
    raise exception 'appointment not found';
  end if;

  if v_status in ('completed', 'cancelled') then
    raise exception 'cannot reschedule a % appointment', v_status;
  end if;

  if not private.has_permission(v_tenant_id, 'appointments.update') then
    raise exception 'appointments.update required';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'at least one appointment item is required';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'service_id', service_id, 'staff_member_id', staff_member_id,
    'scheduled_start_at', scheduled_start_at, 'sequence', sequence
  )), '[]'::jsonb) into v_before
  from public.appointment_items
  where appointment_id = p_appointment_id;

  delete from public.appointment_items where appointment_id = p_appointment_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_sequence := v_sequence + 1;
    v_item_result := private.validate_and_insert_appointment_item(
      v_tenant_id, v_branch_id, p_appointment_id, v_item,
      coalesce((v_item ->> 'sequence')::integer, v_sequence)
    );
    v_min_start := least(coalesce(v_min_start, v_item_result.scheduled_start_at), v_item_result.scheduled_start_at);
    v_max_end := greatest(coalesce(v_max_end, v_item_result.scheduled_end_at), v_item_result.scheduled_end_at);
  end loop;

  update public.appointments
  set scheduled_start_at = v_min_start, scheduled_end_at = v_max_end
  where id = p_appointment_id;

  perform private.log_audit_event(
    v_tenant_id, 'appointment.rescheduled', 'appointment', p_appointment_id,
    jsonb_build_object('items', v_before), jsonb_build_object('items', p_items)
  );
end;
$$;

revoke execute on function private.staff_is_available(uuid, uuid, uuid, timestamptz, timestamptz) from public;
revoke execute on function private.validate_and_insert_appointment_item(uuid, uuid, uuid, jsonb, integer) from public;
