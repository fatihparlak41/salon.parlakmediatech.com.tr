-- Faz NOTIF.2B.1 — event contract hardening. Corrective, forward-only —
-- 20260909100000 is NOT edited; every change here is either an ALTER on
-- top of it or a CREATE OR REPLACE of a function it already defined,
-- with an unchanged signature.
--
-- =====================================================================
-- FRESH AUDIT (before deciding anything, per the phase's own
-- instruction not to assume cascade is harmless)
-- =====================================================================
--
-- Can appointments currently be hard-deleted anywhere? YES — exactly
-- three call sites, all inside private.create_guest_booking's own
-- item-insertion failure recovery (`delete from public.appointments
-- where id = v_appointment_id` immediately before re-raising as
-- BK004/BK005/etc — see 20260909100000 lines ~545/579/586, unchanged
-- since 20260822150500). No other production code path — RPC, trigger,
-- or otherwise — hard-deletes an appointment anywhere in this project;
-- confirmed by grepping every migration and lib/app source for
-- "delete from public.appointments" / "delete from appointments". Every
-- one of those three call sites deletes a JUST-INSERTED header row
-- earlier in the SAME transaction, before private.enqueue_notification_
-- event is ever reached later in that same function body, and every one
-- immediately re-raises (rolling the whole transaction back regardless)
-- — so today, no notification_events row for that appointment can
-- possibly exist yet. That is a coincidence of today's call-site
-- ordering, not a property of the FK contract itself, and the phase is
-- right not to let it stand in for one: nothing stops a future caller
-- (an admin tool, a GDPR-erasure feature, a bug) from hard-deleting an
-- OLDER appointment that already has committed events.
--
-- Is there a production tenant hard-delete? NO — grepped the same way;
-- tenants are exactly as permanent as appointments in production (only
-- tests/helpers.ts's cleanupTenants ever hard-deletes one). Tenant
-- teardown in tests remains fully manageable either way: cleanupTenants
-- already explicitly deletes notification_events by tenant_id BEFORE
-- appointment_items/appointments (added in 20260909100000's own
-- helpers.ts change) — a NO ACTION appointment_id FK changes nothing
-- about that order, since the referencing rows are already gone by the
-- time appointments itself is deleted.
--
-- Existing FK/delete convention for this exact shape (a durable record
-- ABOUT an appointment, not the appointment's own constituent rows):
-- public.booking_account_claims.appointment_id already references
-- appointments with NO delete clause at all (implicit NO ACTION) — see
-- 20260824120000. appointment_items.appointment_id is CASCADE, but that
-- is architecturally different (an appointment's own child rows, not an
-- external historical record) and is not the right precedent here.
--
-- DECISION (candidate A): appointment_id → NO ACTION, matching
-- booking_account_claims' own already-established precedent exactly —
-- not inventing a new convention. A hard delete of an appointment that
-- still has notification_events rows now fails loudly instead of
-- silently erasing which business events occurred. Candidate B
-- (nullable + SET NULL) was rejected: nulling the reference would ALSO
-- destroy traceability (a future worker/analyst could no longer tell
-- which appointment an old event was about), which is a worse outcome
-- for "event immutability and delivery durability" than simply
-- preventing the delete — and this project's own architecture already
-- treats appointments as effectively permanent (status='cancelled' is
-- the historical record, never deleted-and-gone), so NO ACTION does not
-- newly constrain anything real. Candidate C (no FK, enqueue-time
-- validation only) was rejected: it would silently allow a LATER
-- deletion to leave notification_events.appointment_id dangling with no
-- detection at all — strictly worse than NO ACTION for integrity.
alter table public.notification_events drop constraint notification_events_appointment_id_fkey;
alter table public.notification_events add constraint notification_events_appointment_id_fkey
  foreign key (appointment_id) references public.appointments (id);

comment on column public.notification_events.appointment_id is
  'NO ACTION (not CASCADE — corrected in Faz NOTIF.2B.1): a hard delete of an appointment that still has notification_events rows fails loudly rather than silently erasing historical business-event facts. Matches the existing public.booking_account_claims.appointment_id precedent for this same "durable record about an appointment" shape.';

-- =====================================================================
-- SCHEMA_VERSION — explicit payload-schema version, scoped per
-- event_type. Every currently-emitted event is version 1. A future
-- payload change for some event_type must bump this explicitly; it must
-- never be inferred from created_at or from event_data's own shape.
-- =====================================================================
alter table public.notification_events add column schema_version integer not null default 1 check (schema_version > 0);

-- =====================================================================
-- V1 EVENT CONTRACT DOCUMENTATION — part of the durable consumer
-- contract, not incidental commentary. Supersedes 20260909100000's own
-- (looser) event_data column comment for appointment.rescheduled, which
-- described two incompatible shapes — unified below.
-- =====================================================================
comment on table public.notification_events is
  'Faz NOTIF.2B/NOTIF.2B.1 — append-only business-event outbox. Records WHAT happened to an appointment (never WHO should be notified — that is resolved later, at send time, against then-current membership/permission/preference/subscription state). Insert-only: no UPDATE/DELETE grant to any role, no update trigger, by design. Written only via private.enqueue_notification_event, itself only called from inside the six trusted appointment-mutation RPCs — no direct table grant, no public wrapper. See the event_type column comment for the exact V1 payload contract per event.';

comment on column public.notification_events.event_type is
  'One of the 4 locked V1 business events. Each has its own event_data contract at schema_version 1 (see the schema_version column comment for what governs future changes):

  appointment.created — event_data = {} (empty; a future worker derives everything else — service, booked staff, source, customer-communication eligibility — from an authorized read of current DB state).

  appointment.cancelled — event_data = {} (empty, same reasoning — nothing is lost after cancellation that cannot be re-read).

  appointment.rescheduled — event_data = {"before": ItemSnapshot[], "after": ItemSnapshot[]}, where ItemSnapshot = {"sequence": integer, "staffMemberId": uuid, "scheduledStartAt": ISO-8601 timestamptz}. ONE canonical item-level shape regardless of whether a staff member (private.reschedule_appointment) or a customer (private.reschedule_my_appointment) caused it — Faz NOTIF.2B.1 unified these; NOTIF.2B originally shipped two incompatible shapes (an item-level one for staff, a flat previousStartAt/newStartAt one for customers). A customer reschedule still shifts every item by one uniform delta, but emits the identical two-key {before, after} contract — duplicating a few tiny scheduling fields is preferable to two consumer contracts for the same event_type.

  appointment.staff_reassigned — event_data = {"previousStaffMemberIds": uuid[], "newStaffMemberIds": uuid[]}: a deduplicated, deterministically-ordered (ascending by uuid value) symmetric set difference of BOOKED staff_member_id (public.appointment_items.staff_member_id) — never actual_staff_member_id, which is a completed-service-performance-only column populated solely by private.complete_appointment and otherwise untouched by this contract. Only emitted by private.reschedule_appointment (staff); private.reschedule_my_appointment (customer) can never change staff, so it never emits this event_type.

  See supabase/migrations/20260909100000_notification_event_outbox.sql and this migration for the enforcing code.';

comment on column public.notification_events.schema_version is
  'Explicit payload-schema version for event_data, scoped per event_type — currently 1 for every event_type listed on the event_type column comment. A future, incompatible payload change for some event_type must bump this explicitly on newly-emitted rows; a consumer must branch on (event_type, schema_version) together, never infer version from created_at or from event_data''s own shape.';

-- =====================================================================
-- reschedule_appointment (staff/internal) — UNCHANGED signature and
-- UNCHANGED appointment.rescheduled shape (it already emitted the
-- canonical item-level {before, after} contract in 20260909100000).
-- The ONLY change: the two staff-id arrays that become
-- appointment.staff_reassigned's event_data are now built with an
-- explicit `order by v` inside each array_agg — array_agg(DISTINCT ...)
-- with no ORDER BY has no guaranteed, stable element order in Postgres,
-- which the "STAFF_REASSIGNED CONTRACT" review in this phase correctly
-- flagged as a real determinism gap (identical logical diffs could
-- otherwise serialize as different payloads/break stable test
-- assertions) — fixed by sorting ascending on the uuid value itself, the
-- simplest deterministic order available for a set with no other
-- meaningful ordering. v_before_staff_ids/v_after_staff_ids themselves
-- are untouched (they are intermediate EXCEPT-operation inputs, never
-- serialized into event_data, so their own order was never observable).
-- Every other line is byte-for-byte identical to 20260909100000.
-- =====================================================================
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
  v_before jsonb;
  v_merged_items jsonb;
  v_notif_before jsonb;
  v_notif_after jsonb;
  v_before_times jsonb;
  v_after_times jsonb;
  v_before_staff_ids uuid[];
  v_after_staff_ids uuid[];
  v_new_staff_ids uuid[];
  v_lost_staff_ids uuid[];
  v_time_changed boolean;
  v_staff_changed boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AP001';
  end if;

  select tenant_id, branch_id, status into v_tenant_id, v_branch_id, v_status
  from public.appointments
  where id = p_appointment_id
  for update;

  if v_tenant_id is null then
    raise exception 'appointment not found' using errcode = 'AP013';
  end if;

  if v_status in ('completed', 'cancelled') then
    raise exception 'cannot reschedule a % appointment', v_status using errcode = 'AP014';
  end if;

  if not private.has_permission(v_tenant_id, 'appointments.update') then
    raise exception 'appointments.update required' using errcode = 'AP002';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'at least one appointment item is required' using errcode = 'AP005';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'service_id', service_id, 'staff_member_id', staff_member_id,
    'scheduled_start_at', scheduled_start_at, 'sequence', sequence,
    'duration_minutes', duration_minutes, 'price', price
  )), '[]'::jsonb) into v_before
  from public.appointment_items
  where appointment_id = p_appointment_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sequence', (elem ->> 'sequence')::integer,
    'staffMemberId', (elem ->> 'staff_member_id')::uuid,
    'scheduledStartAt', (elem ->> 'scheduled_start_at')::timestamptz
  ) order by (elem ->> 'sequence')::integer), '[]'::jsonb)
  into v_notif_before
  from jsonb_array_elements(v_before) as elem;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sequence', (elem ->> 'sequence')::integer,
    'scheduledStartAt', (elem ->> 'scheduled_start_at')::timestamptz
  ) order by (elem ->> 'sequence')::integer), '[]'::jsonb)
  into v_before_times
  from jsonb_array_elements(v_before) as elem;

  select coalesce(array_agg(distinct (elem ->> 'staff_member_id')::uuid), '{}')
  into v_before_staff_ids
  from jsonb_array_elements(v_before) as elem;

  select coalesce(jsonb_agg(
    case
      when old_item.elem is not null and (old_item.elem ->> 'service_id') = (new_item.elem ->> 'service_id')
        then (new_item.elem - 'duration_minutes' - 'price')
             || jsonb_build_object('duration_minutes', old_item.elem -> 'duration_minutes', 'price', old_item.elem -> 'price')
      else (new_item.elem - 'duration_minutes' - 'price')
    end
  ), '[]'::jsonb) into v_merged_items
  from jsonb_array_elements(p_items) as new_item(elem)
  left join jsonb_array_elements(v_before) as old_item(elem)
    on (old_item.elem ->> 'sequence')::integer = (new_item.elem ->> 'sequence')::integer;

  perform private.replace_appointment_items(v_tenant_id, v_branch_id, p_appointment_id, v_merged_items);

  perform private.log_audit_event(
    v_tenant_id, 'appointment.rescheduled', 'appointment', p_appointment_id,
    jsonb_build_object('items', v_before), jsonb_build_object('items', p_items)
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'sequence', sequence,
    'staffMemberId', staff_member_id,
    'scheduledStartAt', scheduled_start_at
  ) order by sequence), '[]'::jsonb)
  into v_notif_after
  from public.appointment_items
  where appointment_id = p_appointment_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sequence', sequence,
    'scheduledStartAt', scheduled_start_at
  ) order by sequence), '[]'::jsonb)
  into v_after_times
  from public.appointment_items
  where appointment_id = p_appointment_id;

  select coalesce(array_agg(distinct staff_member_id), '{}')
  into v_after_staff_ids
  from public.appointment_items
  where appointment_id = p_appointment_id;

  select coalesce(array_agg(v order by v), '{}') into v_new_staff_ids
  from (select unnest(v_after_staff_ids) except select unnest(v_before_staff_ids)) as t(v);

  select coalesce(array_agg(v order by v), '{}') into v_lost_staff_ids
  from (select unnest(v_before_staff_ids) except select unnest(v_after_staff_ids)) as t(v);

  v_time_changed := v_before_times <> v_after_times;
  v_staff_changed := array_length(v_new_staff_ids, 1) > 0 or array_length(v_lost_staff_ids, 1) > 0;

  if v_time_changed then
    perform private.enqueue_notification_event(
      p_appointment_id, 'appointment.rescheduled', auth.uid(),
      jsonb_build_object('before', v_notif_before, 'after', v_notif_after)
    );
  end if;

  if v_staff_changed then
    perform private.enqueue_notification_event(
      p_appointment_id, 'appointment.staff_reassigned', auth.uid(),
      jsonb_build_object(
        'previousStaffMemberIds', to_jsonb(v_lost_staff_ids),
        'newStaffMemberIds', to_jsonb(v_new_staff_ids)
      )
    );
  end if;
end;
$$;

-- =====================================================================
-- reschedule_my_appointment (customer) — UNCHANGED signature, UNCHANGED
-- validation/policy/cutoff logic. ONLY change: appointment.rescheduled's
-- event_data now uses the SAME canonical item-level {before, after}
-- shape as reschedule_appointment above, instead of NOTIF.2B's flat
-- {previousStartAt, newStartAt}. before is read fresh BEFORE
-- replace_appointment_items runs; after is read fresh from the table
-- AFTER it completes (matching reschedule_appointment's own "trust the
-- persisted row, not the caller's intent" discipline) — never derived
-- from v_new_items, which is this function's OWN pre-computed intent,
-- not yet-confirmed persisted fact. Still guards the no-op case (a
-- customer resubmitting the identical start time) exactly as before.
-- =====================================================================
create or replace function private.reschedule_my_appointment(
  p_appointment_id uuid,
  p_new_start_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment record;
  v_tenant record;
  v_new_items jsonb;
  v_delta interval;
  v_notif_before jsonb;
  v_notif_after jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AC001';
  end if;

  select a.id, a.tenant_id, a.branch_id, a.customer_id, a.status, a.scheduled_start_at
  into v_appointment
  from public.appointments a
  where a.id = p_appointment_id
  for update;

  if not found then
    raise exception 'appointment not manageable' using errcode = 'AC003';
  end if;

  if not exists (
    select 1 from public.customer_account_links cal
    where cal.user_id = auth.uid()
      and cal.deleted_at is null
      and cal.customer_id = v_appointment.customer_id
  ) then
    raise exception 'appointment not manageable' using errcode = 'AC003';
  end if;

  if v_appointment.status not in ('scheduled', 'confirmed') then
    raise exception 'appointment not manageable' using errcode = 'AC003';
  end if;

  select customer_reschedule_enabled, customer_reschedule_cutoff_minutes
  into v_tenant
  from public.tenants
  where id = v_appointment.tenant_id;

  if not v_tenant.customer_reschedule_enabled then
    raise exception 'reschedule disabled' using errcode = 'AC006';
  end if;

  if now() > v_appointment.scheduled_start_at - (v_tenant.customer_reschedule_cutoff_minutes || ' minutes')::interval then
    raise exception 'reschedule cutoff passed' using errcode = 'AC007';
  end if;

  if p_new_start_at <= now() then
    raise exception 'requested slot unavailable' using errcode = 'AC008';
  end if;

  if p_new_start_at > now() + interval '30 days' then
    raise exception 'requested slot unavailable' using errcode = 'AC008';
  end if;

  v_delta := p_new_start_at - v_appointment.scheduled_start_at;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sequence', sequence, 'staffMemberId', staff_member_id, 'scheduledStartAt', scheduled_start_at
  ) order by sequence), '[]'::jsonb)
  into v_notif_before
  from public.appointment_items
  where appointment_id = p_appointment_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'service_id', service_id, 'staff_member_id', staff_member_id,
    'scheduled_start_at', scheduled_start_at + v_delta, 'sequence', sequence,
    'duration_minutes', duration_minutes, 'price', price
  )), '[]'::jsonb) into v_new_items
  from public.appointment_items
  where appointment_id = p_appointment_id;

  begin
    perform private.replace_appointment_items(v_appointment.tenant_id, v_appointment.branch_id, p_appointment_id, v_new_items);
  exception
    when others then
      if sqlstate in ('AP008', 'AP009', 'AP010', 'AP011', 'AP012') then
        raise exception 'requested slot unavailable' using errcode = 'AC008';
      else
        raise;
      end if;
  end;

  perform private.log_audit_event(
    v_appointment.tenant_id, 'appointment.rescheduled', 'appointment', p_appointment_id,
    jsonb_build_object('scheduledStartAt', v_appointment.scheduled_start_at),
    jsonb_build_object('scheduledStartAt', p_new_start_at)
  );

  if p_new_start_at <> v_appointment.scheduled_start_at then
    select coalesce(jsonb_agg(jsonb_build_object(
      'sequence', sequence, 'staffMemberId', staff_member_id, 'scheduledStartAt', scheduled_start_at
    ) order by sequence), '[]'::jsonb)
    into v_notif_after
    from public.appointment_items
    where appointment_id = p_appointment_id;

    perform private.enqueue_notification_event(
      p_appointment_id, 'appointment.rescheduled', auth.uid(),
      jsonb_build_object('before', v_notif_before, 'after', v_notif_after)
    );
  end if;

  return jsonb_build_object('appointmentId', p_appointment_id, 'scheduledStartAt', p_new_start_at);
end;
$$;
