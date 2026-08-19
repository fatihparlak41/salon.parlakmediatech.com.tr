-- Phase 2A: appointment header + items. appointments.*/customers already
-- exist as permissions (20260815120005) and are already distributed to
-- role templates — no new permission keys here.
--
-- Deliberately NO deleted_at on either table: a cancelled appointment
-- keeps its row (status='cancelled') as the historical/audit record —
-- see supabase/migrations/README.md "Phase 2". NO direct insert/update
-- grant either: every mutation (create/reschedule/cancel/complete) goes
-- through the RPCs in the next migration, because each one has a
-- business invariant (conflict checking, working-hours validation,
-- price/duration snapshotting, audit logging) that a plain RLS
-- with-check can't express — same reasoning as roles/permissions being
-- RPC-gated instead of directly writable (20260816090002/090003).

create extension if not exists btree_gist;

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  branch_id uuid not null references public.branches (id),
  customer_id uuid not null references public.customers (id),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show')),
  notes text,
  source text,
  -- Cached from MIN/MAX(appointment_items.scheduled_*_at) — written only
  -- by the RPCs below, never directly. Exists so a calendar range query
  -- doesn't need to join+aggregate appointment_items on every render.
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_time_order check (scheduled_end_at > scheduled_start_at)
);

comment on table public.appointments is
  'Appointment header. One customer visit, one or more appointment_items. No deleted_at — cancellation is status=''cancelled'', the row is the permanent record. Written only via create_appointment/reschedule_appointment/update_appointment_status (private schema) — no direct table grant.';

create index appointments_tenant_id_idx on public.appointments (tenant_id);
create index appointments_branch_scheduled_idx on public.appointments (branch_id, scheduled_start_at);
create index appointments_customer_id_idx on public.appointments (customer_id);

create trigger set_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

alter table public.appointments enable row level security;

create policy "appointments_select_appointments_view" on public.appointments
for select to authenticated
using (private.has_permission(tenant_id, 'appointments.view'));

grant select on public.appointments to authenticated;

create table public.appointment_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  service_id uuid not null references public.services (id),
  staff_member_id uuid not null references public.staff_members (id),
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  -- Snapshots — taken from services.duration_minutes/price at booking
  -- time. Never re-read from services for an existing item; a later
  -- price/duration change on the service must not alter history.
  duration_minutes integer not null check (duration_minutes > 0),
  price numeric(10, 2) not null check (price >= 0),
  sequence integer not null,
  -- Denormalized from the parent appointments.status — an exclusion
  -- constraint's predicate can only see columns on the constrained table
  -- itself, not a joined row, so this is what
  -- appointment_items_no_staff_overlap below actually tests. Kept
  -- correct by the two triggers immediately after this table, never set
  -- directly by callers.
  appointment_status text not null default 'scheduled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_items_time_order check (scheduled_end_at > scheduled_start_at)
);

comment on table public.appointment_items is
  'One service + one staff member + one time slot within an appointment. The exclusion constraint below is the actual double-booking guard — enforced by Postgres itself under concurrent transactions, not by application-level locking. A cancelled/no_show appointment''s items are excluded from the constraint so cancelling genuinely frees the slot.';

-- BEFORE INSERT: always pull the parent's true current status, ignoring
-- whatever the default/caller would otherwise leave — matters for
-- reschedule_appointment adding a new item to an appointment that's
-- already past 'scheduled' (e.g. 'confirmed'), which must not silently
-- read back as 'scheduled' and dodge the overlap check's WHERE clause.
create or replace function private.set_appointment_item_status_from_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select status into new.appointment_status
  from public.appointments
  where id = new.appointment_id;
  return new;
end;
$$;

create trigger set_appointment_item_status_from_parent
  before insert on public.appointment_items
  for each row execute function private.set_appointment_item_status_from_parent();

-- AFTER UPDATE: propagate a status change (most importantly
-- cancel/no_show) down to every existing item, so a cancelled
-- appointment's items drop out of the overlap check's WHERE clause and
-- the slot becomes genuinely bookable again.
create or replace function private.sync_appointment_item_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.appointment_items
  set appointment_status = new.status
  where appointment_id = new.id;
  return new;
end;
$$;

comment on function private.sync_appointment_item_status() is
  'Keeps appointment_items.appointment_status mirrored from appointments.status, so the appointment_items_no_staff_overlap exclusion constraint (which cannot see the parent row) can exempt cancelled/no_show items from the overlap check.';

create trigger sync_appointment_item_status
  after update of status on public.appointments
  for each row execute function private.sync_appointment_item_status();

alter table public.appointment_items
  add constraint appointment_items_no_staff_overlap
  exclude using gist (
    staff_member_id with =,
    tstzrange(scheduled_start_at, scheduled_end_at) with &&
  )
  where (appointment_status not in ('cancelled', 'no_show'));

create unique index appointment_items_appointment_sequence_idx
  on public.appointment_items (appointment_id, sequence);
create index appointment_items_appointment_id_idx on public.appointment_items (appointment_id);
create index appointment_items_tenant_id_idx on public.appointment_items (tenant_id);
-- Redundant with the exclusion constraint's own index for the overlap
-- check itself, but this one serves plain "what does staff X have on
-- date Y" lookups the constraint's GiST index isn't shaped for.
create index appointment_items_staff_scheduled_idx
  on public.appointment_items (staff_member_id, scheduled_start_at, scheduled_end_at);

create trigger set_updated_at
  before update on public.appointment_items
  for each row execute function public.set_updated_at();

alter table public.appointment_items enable row level security;

create policy "appointment_items_select_appointments_view" on public.appointment_items
for select to authenticated
using (private.has_permission(tenant_id, 'appointments.view'));

grant select on public.appointment_items to authenticated;
