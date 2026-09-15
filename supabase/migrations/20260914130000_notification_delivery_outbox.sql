-- Faz NOTIF.2E.1 — durable recipient-resolution + delivery-outbox
-- foundation. This migration ONLY materializes WHO should receive a
-- push for a given notification_events row, into a new durable table.
-- It does NOT send anything: no push_subscriptions read, no web-push
-- call, no worker, no cron, no webhook. That is NOTIF.2E.2/2E.3.
--
-- =====================================================================
-- FRESH AUDIT FINDINGS THIS MIGRATION IS BUILT FROM (not assumed)
-- =====================================================================
-- private.has_permission(p_tenant_id, p_permission_key) — confirmed via
-- pg_get_functiondef — derives eligibility from
-- tenant_memberships.status = 'active' and deleted_at is null, joined
-- through role_permissions/permissions, keyed on auth.uid(). This
-- migration's own recipient query replicates that exact predicate shape
-- but against an explicit tenant_membership_id (there is no session
-- here) — see private.materialize_notification_deliveries below.
--
-- Permission catalog (confirmed via direct query): appointments.view is
-- granted to CASHIER, RECEPTIONIST, SALON_MANAGER, SALON_OWNER, STYLIST.
-- appointments.create (and, identically, appointments.cancel) is
-- granted to exactly RECEPTIONIST, SALON_MANAGER, SALON_OWNER — a strict
-- subset. That is the existing, narrow permission this migration uses
-- for "salon-wide appointment administrator": every role holding it
-- already also holds appointments.view (today's catalog), and it
-- precisely excludes CASHIER (view-only, for payment reconciliation —
-- role description "Ödeme ve tahsilat") and STYLIST (view+update only,
-- own-appointments scope — role description "Kendi randevuları ve
-- müşteri görüntüleme"). No new role or permission is introduced;
-- appointments.view is still independently re-checked as the universal
-- gate on every candidate, per this phase's own "assignment alone must
-- not bypass appointments.view" rule — a future catalog change that
-- decouples create/cancel from view does not silently break this.
--
-- notification_events.event_data V1 contract (confirmed via
-- 20260909110000's own column comment, the actual durable consumer
-- contract):
--   appointment.created        -> {} (empty)
--   appointment.cancelled      -> {} (empty)
--   appointment.rescheduled    -> {"before": ItemSnapshot[], "after": ItemSnapshot[]}
--                                  ItemSnapshot = {"sequence", "staffMemberId", "scheduledStartAt"}
--   appointment.staff_reassigned -> {"previousStaffMemberIds": uuid[], "newStaffMemberIds": uuid[]}
-- staff_reassigned is only ever emitted by private.reschedule_appointment
-- (staff-side); private.reschedule_my_appointment (customer-side) can
-- never change staff. Both events can be emitted in the same
-- transaction for one reschedule call if both time and staff changed.
--
-- Because created/cancelled carry an EMPTY event_data, "assigned staff"
-- for those two event types can only be resolved from CURRENT
-- appointment_items.staff_member_id — there is no snapshot. For
-- rescheduled/staff_reassigned, this migration deliberately reads the
-- event's OWN before/after snapshot arrays, never live appointment_items
-- state, per this phase's explicit "use the snapshot, do not depend on
-- only the appointment's current state for the old staff" rule — by the
-- time materialization runs, a later mutation could already have
-- changed live state again.
--
-- staff_members.tenant_membership_id is nullable (confirmed) — a staff
-- row with no linked membership is a name on the calendar only, never a
-- push recipient (this phase's own explicit rule).
--
-- =====================================================================
-- WHY notification_events GETS ONE NEW ADDITIVE CONSTRAINT
-- =====================================================================
-- notification_events remains otherwise completely untouched — no
-- column, no data, no existing constraint is altered. Adding
-- UNIQUE(id, tenant_id) is purely additive (id alone is already the PK,
-- so every existing row already satisfies this trivially) and exists
-- for exactly one reason: it lets notification_deliveries reference
-- (notification_event_id, tenant_id) together as a genuine composite
-- tenant-safe FK, the same pattern already established for
-- staff_members_membership_same_tenant / appointment_items_actual_
-- staff_same_tenant (20260822...) — matching tenant_memberships' own
-- UNIQUE(id, tenant_id), same column order, for the identical reason.
alter table public.notification_events
  add constraint notification_events_id_tenant_id_key unique (id, tenant_id);

comment on constraint notification_events_id_tenant_id_key on public.notification_events is
  'Faz NOTIF.2E.1 — purely additive (id alone is already the PK). Exists only so notification_deliveries can carry a genuine composite tenant-safe FK to this table, matching the staff_members_membership_same_tenant precedent. Does not change notification_events'' own immutability or existing contract in any way.';

-- =====================================================================
-- notification_deliveries — the durable, idempotent delivery outbox.
-- Infrastructure data: no browser role ever reads or writes this table,
-- in this phase or any future one that keeps today's architecture
-- (server-only/service_role processing, same posture as
-- push_subscriptions and notification_events themselves).
-- =====================================================================
create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  notification_event_id uuid not null,
  tenant_membership_id uuid not null,
  channel text not null default 'web_push',
  status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 100),
  last_error_message text check (last_error_message is null or char_length(last_error_message) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_deliveries_channel_check check (channel = 'web_push'),
  constraint notification_deliveries_status_check
    check (status in ('pending', 'processing', 'retry', 'sent', 'failed', 'skipped')),
  constraint notification_deliveries_attempt_count_check check (attempt_count >= 0),

  -- Idempotent materialization: at most one delivery row per
  -- (event, membership, channel) — this is the entire duplicate-
  -- prevention mechanism, enforced by Postgres itself, not application
  -- logic alone.
  constraint notification_deliveries_dedup_key
    unique (notification_event_id, tenant_membership_id, channel),

  constraint notification_deliveries_tenant_id_fkey
    foreign key (tenant_id) references public.tenants (id),

  -- Plain + composite, matching the staff_members_membership_same_tenant /
  -- appointment_items_actual_staff_same_tenant precedent exactly: the
  -- composite pair is what actually prevents this row's own tenant_id
  -- from ever disagreeing with the event/membership it points at.
  constraint notification_deliveries_event_id_fkey
    foreign key (notification_event_id) references public.notification_events (id),
  constraint notification_deliveries_event_same_tenant
    foreign key (notification_event_id, tenant_id) references public.notification_events (id, tenant_id),

  constraint notification_deliveries_tenant_membership_id_fkey
    foreign key (tenant_membership_id) references public.tenant_memberships (id),
  constraint notification_deliveries_membership_same_tenant
    foreign key (tenant_membership_id, tenant_id) references public.tenant_memberships (id, tenant_id)
);

comment on table public.notification_deliveries is
  'Faz NOTIF.2E.1 — durable, idempotent per-membership delivery outbox materialized from notification_events. Channel V1 is web_push only. NOT populated or processed automatically by anything yet (no worker, cron, webhook, or trigger exists) — rows are created only by an explicit call to public.materialize_notification_deliveries, and nothing in this phase ever reads push_subscriptions or sends a push. Infrastructure data: RLS enabled with zero policies, zero grants to anon/authenticated — service_role/server-only processing only, same posture as push_subscriptions. Never stores endpoint/p256dh/auth_key or any other subscription material.';

comment on column public.notification_deliveries.status is
  'pending (materialized, not yet attempted) -> processing (a future worker has claimed it, e.g. via locked_at) -> sent | retry (transient failure, will be attempted again) | failed (exhausted retries) | skipped (e.g. no active subscription at send time). This phase only ever inserts pending rows; no code anywhere yet transitions a row out of pending.';

comment on column public.notification_deliveries.next_attempt_at is
  'Defaults to now() — a future worker''s own claim query (e.g. status in (''pending'',''retry'') and next_attempt_at <= now()) is not implemented in this phase.';

create index notification_deliveries_pending_idx
  on public.notification_deliveries (status, next_attempt_at)
  where status in ('pending', 'retry');

create index notification_deliveries_event_idx
  on public.notification_deliveries (notification_event_id);

create trigger set_updated_at
  before update on public.notification_deliveries
  for each row execute function public.set_updated_at();

alter table public.notification_deliveries enable row level security;
-- No policy is added — RLS enabled with zero policies denies every
-- command to every role except the table owner, and there is no grant
-- below for authenticated/anon to even attempt one. Same double-lock as
-- push_subscriptions/notification_events.

-- =====================================================================
-- private.materialize_notification_deliveries — the actual recipient-
-- resolution logic. SECURITY DEFINER so it can read role_permissions/
-- permissions/tenant_memberships regardless of caller (there is no
-- session at all when this eventually runs from a service-role-only
-- caller); reachable only through the public.* wrapper below, which is
-- the only thing service_role is ever granted.
-- =====================================================================
create function private.materialize_notification_deliveries(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event record;
  v_preference_column text;
  v_created_count integer := 0;
  v_after jsonb;
  v_reassigned_ids jsonb;
begin
  select id, tenant_id, appointment_id, event_type, actor_user_id, event_data, schema_version
  into v_event
  from public.notification_events
  where id = p_event_id;

  -- Unknown event id: safe no-op, not an error — matches this phase's
  -- own "ignores unknown/unsupported ... safely" rule extended to a
  -- caller passing a bad id, not just a bad event_type.
  if v_event.id is null then
    return jsonb_build_object('created', 0, 'reason', 'event_not_found');
  end if;

  -- Unsupported event_type or a future schema_version this function
  -- was never written against: safe no-op. A consumer must branch on
  -- (event_type, schema_version) together (20260909110000's own
  -- contract comment) — this is that branch, at its boundary.
  if v_event.event_type not in (
       'appointment.created', 'appointment.cancelled',
       'appointment.rescheduled', 'appointment.staff_reassigned'
     )
     or v_event.schema_version <> 1
  then
    return jsonb_build_object('created', 0, 'reason', 'unsupported_event_type_or_schema_version');
  end if;

  v_preference_column := case v_event.event_type
    when 'appointment.created' then 'new_appointment'
    when 'appointment.cancelled' then 'cancellation'
    when 'appointment.rescheduled' then 'reschedule'
    when 'appointment.staff_reassigned' then 'assignment_change'
  end;

  -- Defensive against a malformed/missing snapshot key: fall back to an
  -- empty array rather than let jsonb_array_elements raise on a
  -- non-array value. enqueue_notification_event only validates
  -- event_data is a JSON object, not each event_type's nested shape.
  v_after := case when jsonb_typeof(v_event.event_data->'after') = 'array'
                  then v_event.event_data->'after' else '[]'::jsonb end;
  v_reassigned_ids :=
    (case when jsonb_typeof(v_event.event_data->'previousStaffMemberIds') = 'array'
          then v_event.event_data->'previousStaffMemberIds' else '[]'::jsonb end)
    ||
    (case when jsonb_typeof(v_event.event_data->'newStaffMemberIds') = 'array'
          then v_event.event_data->'newStaffMemberIds' else '[]'::jsonb end);

  with candidate_memberships as (
    -- 1. Salon-wide appointment administrators — see this migration's
    --    header for why appointments.create is the chosen existing
    --    permission.
    select tm.id as tenant_membership_id
    from public.tenant_memberships tm
    join public.role_permissions rp on rp.role_id = tm.role_id
    join public.permissions perm on perm.id = rp.permission_id
    where tm.tenant_id = v_event.tenant_id
      and perm.key = 'appointments.create'

    union

    -- 2a. Assigned staff for created/cancelled — event_data is {} for
    --     both, so this is necessarily CURRENT appointment_items state.
    --     tenant_id is re-checked on both sides of the join, not
    --     assumed from the appointment_items->staff_members FK alone —
    --     the same defense-in-depth this migration applies everywhere
    --     an id could theoretically cross a tenant boundary.
    select sm.tenant_membership_id
    from public.appointment_items ai
    join public.staff_members sm
      on sm.id = ai.staff_member_id and sm.tenant_id = v_event.tenant_id
    where v_event.event_type in ('appointment.created', 'appointment.cancelled')
      and ai.appointment_id = v_event.appointment_id
      and ai.tenant_id = v_event.tenant_id
      and sm.tenant_membership_id is not null

    union

    -- 2b. Assigned staff for rescheduled — the event's own "after"
    --     snapshot, never live appointment_items (historical
    --     correctness; see this migration's header).
    select sm.tenant_membership_id
    from jsonb_array_elements(v_after) as item
    join public.staff_members sm
      on sm.id = (item->>'staffMemberId')::uuid and sm.tenant_id = v_event.tenant_id
    where v_event.event_type = 'appointment.rescheduled'
      and sm.tenant_membership_id is not null

    union

    -- 2c. Assigned staff for staff_reassigned — BOTH previously and
    --     newly assigned staff, from the event's own before/after
    --     id-array snapshot (Step 4's explicit "notify both" rule).
    select sm.tenant_membership_id
    from jsonb_array_elements_text(v_reassigned_ids) as staff_id
    join public.staff_members sm
      on sm.id = staff_id::uuid and sm.tenant_id = v_event.tenant_id
    where v_event.event_type = 'appointment.staff_reassigned'
      and sm.tenant_membership_id is not null
  ),
  eligible_memberships as (
    -- The universal gate, re-applied to EVERY candidate regardless of
    -- which group produced it — assignment alone never bypasses
    -- appointments.view, exactly per this phase's own rule.
    select distinct cm.tenant_membership_id
    from candidate_memberships cm
    join public.tenant_memberships tm on tm.id = cm.tenant_membership_id
    join public.role_permissions rp on rp.role_id = tm.role_id
    join public.permissions perm on perm.id = rp.permission_id
    left join public.notification_preferences np on np.tenant_membership_id = tm.id
    where tm.tenant_id = v_event.tenant_id
      and tm.status = 'active'
      and tm.deleted_at is null
      and perm.key = 'appointments.view'
      -- Actor exclusion: never notify whoever performed the action.
      -- Public-booking events have actor_user_id null, so this never
      -- excludes anyone for those.
      and (v_event.actor_user_id is null or tm.user_id <> v_event.actor_user_id)
      -- No preference row yet reads as all-true, matching
      -- get_my_notification_preferences' own no-row-yet convention
      -- (20260908090000) exactly — never a silent opt-out by omission.
      and coalesce(
        case v_preference_column
          when 'new_appointment' then np.new_appointment
          when 'cancellation' then np.cancellation
          when 'reschedule' then np.reschedule
          when 'assignment_change' then np.assignment_change
        end,
        true
      )
  )
  insert into public.notification_deliveries (tenant_id, notification_event_id, tenant_membership_id, channel, status)
  select v_event.tenant_id, v_event.id, em.tenant_membership_id, 'web_push', 'pending'
  from eligible_memberships em
  on conflict (notification_event_id, tenant_membership_id, channel) do nothing;

  get diagnostics v_created_count = row_count;

  return jsonb_build_object('created', v_created_count, 'eventType', v_event.event_type);
end;
$$;

comment on function private.materialize_notification_deliveries(uuid) is
  'Faz NOTIF.2E.1. Resolves eligible recipient memberships for one notification_events row and inserts pending notification_deliveries rows, idempotently (ON CONFLICT DO NOTHING on the (event, membership, channel) dedup key). Never reads push_subscriptions, never sends anything. Unknown event id or unsupported event_type/schema_version is a safe no-op, never an error.';

revoke execute on function private.materialize_notification_deliveries(uuid) from public;

create function public.materialize_notification_deliveries(p_event_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.materialize_notification_deliveries(p_event_id);
$$;

comment on function public.materialize_notification_deliveries(uuid) is
  'Faz NOTIF.2E.1. service_role-only. Not callable by anon or authenticated — recipient resolution reads role/permission/preference data across an entire tenant''s memberships, which is not the calling browser session''s own data to enumerate, the same reasoning that keeps push_subscriptions'' own material server-only (see 20260914121000). Call only from trusted server-side code after an appointment-mutation transaction commits.';

revoke execute on function public.materialize_notification_deliveries(uuid) from public;
revoke execute on function public.materialize_notification_deliveries(uuid) from anon;
revoke execute on function public.materialize_notification_deliveries(uuid) from authenticated;
grant execute on function public.materialize_notification_deliveries(uuid) to service_role;
