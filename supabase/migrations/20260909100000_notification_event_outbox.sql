-- Faz NOTIF.2B — transactional notification-event/outbox foundation.
--
-- Goal: when an appointment lifecycle mutation succeeds, the SAME
-- Postgres transaction also records that a notification-worthy business
-- event occurred. NO delivery, NO recipient resolution, NO push/email —
-- those are explicitly future phases. This migration only makes the
-- appointment transaction durably record WHAT HAPPENED; a later delivery
-- phase decides WHO currently receives it (evaluated at send time against
-- current membership/permission/preference/subscription state, never
-- resolved here).
--
-- =====================================================================
-- SCHEMA DESIGN DECISIONS (freshly derived, not the phase's own
-- suggested placeholder shape — see the Faz NOTIF.2B report for full
-- reasoning; summarized here for anyone reading this file directly)
-- =====================================================================
--
-- 1. NO status/attempts/next_attempt_at. Those are PER-RECIPIENT delivery
--    concerns (a push to staff member A might retry while staff member
--    B's email already succeeded) — they belong on a future, separate
--    delivery-attempts table, not on this business-event table. Adding
--    them here now, unused, would misrepresent what this table is for.
--
-- 2. NO processed_at either, and deliberately no mutable column of any
--    kind. "Future delivery worker may later mark processing state
--    elsewhere" (the phase's own words) reads as a direct instruction:
--    keep this table 100% insert-only, forever — a future outbox-drain
--    cursor belongs in its own small state table (e.g. a last-processed
--    watermark keyed by id/created_at), never as a column mutated on
--    these rows. This makes "no UPDATE/DELETE surface, even for a future
--    worker" true by construction, not by convention alone.
--
-- 3. actor_user_id references auth.users ON DELETE SET NULL, not the
--    audit_logs precedent (NO ACTION). We already discovered in Faz
--    NOTIF.2A.2 that audit_logs.actor_user_id's NO ACTION FK makes
--    deleting a user who ever performed an audited action fail unless
--    the audit rows are deleted first — a real, previously-hit bug class.
--    A historical notification event should not, by itself, ever block
--    deleting an auth account: the event fact (what happened, to which
--    appointment, of which type) remains permanently true and useful
--    even once we no longer know who caused it, so ON DELETE SET NULL
--    (preserve the row, clear the pointer) is strictly safer than NO
--    ACTION and strictly more informative than never storing an FK at
--    all (option B) — it keeps referential integrity while the user
--    exists, and degrades gracefully instead of blocking or dangling.
--
-- 4. tenant_id + appointment_id are both plain FKs, matching
--    appointment_items' own established precedent for this exact shape
--    (a tenant-scoped child row of an appointment) — appointments has no
--    UNIQUE(tenant_id, id) to hang a composite FK off in the first place,
--    and appointment_items itself doesn't use one either, relying
--    instead on the trusted RPC layer to keep the two consistent. This
--    migration goes one step further than that precedent: the new
--    private.enqueue_notification_event below does not even accept a
--    caller-supplied tenant_id — it derives tenant_id itself from the
--    appointment row every single call, which is strictly stronger than
--    a composite FK (a composite FK only validates that SOME existing
--    pair matches; deriving fresh makes a mismatched pair structurally
--    impossible to construct in the first place, for every past and
--    future caller, not just ones a reviewer happened to write
--    correctly).
--
-- 5. appointment_id is ON DELETE CASCADE, matching appointment_items'
--    own precedent for the identical relationship. Appointments are
--    never hard-deleted in production (status='cancelled' is the
--    permanent record — see 20260819052514's own comment), so this only
--    ever fires for test-fixture teardown, where it means
--    tests/helpers.ts needs no bespoke notification_events delete at all
--    for appointment-scoped cleanup. tenant_id itself is left as a plain
--    FK with no delete action (matching every other tenant-scoped table
--    in this project); cleanupTenants is still updated below to delete
--    notification_events by tenant_id explicitly and early, matching
--    this file's own established convention of never relying on a
--    cascade alone for tenant-level teardown.
--
-- 6. No dedupe/idempotency key beyond the row's own generated id. A
--    Monday reschedule and a Tuesday reschedule of the same appointment
--    are both legitimate, separate appointment.rescheduled events — any
--    key derived from (appointment_id, event_type) would incorrectly
--    collapse them. The generated uuid id is the correct, sufficient
--    idempotency anchor for a future delivery worker (mirroring how
--    audit_logs also just uses its own generated id).

-- =====================================================================
-- 1. public.notification_events — append-only business event log.
-- =====================================================================
create table public.notification_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  event_type text not null check (event_type in (
    'appointment.created',
    'appointment.cancelled',
    'appointment.rescheduled',
    'appointment.staff_reassigned'
  )),
  -- Actor of THIS mutation (auth.uid() at the moment it happened) — never
  -- appointments.created_by, never the booked/actual staff member, never
  -- derived after the fact. NULL for anonymous public booking (Faz
  -- NOTIF.2B Step 9). See note 3 above for the ON DELETE behavior.
  actor_user_id uuid references auth.users (id) on delete set null,
  -- Minimal non-PII facts a future delivery worker cannot re-derive from
  -- an authorized read of current DB state (e.g. which staff lost an
  -- appointment on reassignment). Never customer name/phone/email/notes/
  -- health data, never a full appointment snapshot, never a service name
  -- — see Faz NOTIF.2B Step 4/report for the exact shape per event_type.
  event_data jsonb not null default '{}'::jsonb check (jsonb_typeof(event_data) = 'object'),
  created_at timestamptz not null default now()
);

comment on table public.notification_events is
  'Faz NOTIF.2B — append-only business-event outbox. Records WHAT happened to an appointment (never WHO should be notified — that is resolved later, at send time, against then-current membership/permission/preference/subscription state). Insert-only: no UPDATE/DELETE grant to any role, no update trigger, by design — see the table''s own migration header for why. Written only via private.enqueue_notification_event, itself only called from inside the six trusted appointment-mutation RPCs — no direct table grant, no public wrapper.';

comment on column public.notification_events.actor_user_id is
  'auth.uid() of whoever caused this specific event; NULL for anonymous guest booking. ON DELETE SET NULL: a historical event must never block deleting an auth account.';

comment on column public.notification_events.event_data is
  'Minimal non-PII facts, shape depends on event_type. Empty {} for appointment.created/appointment.cancelled. See migration header / Faz NOTIF.2B report for appointment.rescheduled and appointment.staff_reassigned shapes.';

-- Likely future worker access patterns only (Faz NOTIF.2B Step 13) — this
-- table starts empty and tiny; not over-indexed.
create index notification_events_tenant_id_idx on public.notification_events (tenant_id);
create index notification_events_appointment_id_idx on public.notification_events (appointment_id);
create index notification_events_created_at_idx on public.notification_events (created_at);

alter table public.notification_events enable row level security;
-- Deliberately zero policies: no browser role (authenticated or anon) can
-- see or touch this table at all, at any RLS level — matching
-- push_subscriptions/notification_preferences' own established Faz
-- NOTIF.2A convention. Combined with the zero grants below, this is a
-- second, independent layer (RLS-with-no-policies AND no privilege) on
-- top of what a grant-only design would already provide.

revoke all on public.notification_events from public, anon, authenticated;
-- No grant statement follows for either role — this table has zero
-- browser-reachable privilege of any kind (not even SELECT), unlike
-- audit_logs' own SELECT-only grant: a notification event is not
-- something any tenant user needs to read directly today, and granting
-- SELECT now for no concrete reader would be speculative privilege this
-- phase does not need.

-- =====================================================================
-- 2. private.enqueue_notification_event — the ONLY way to write a row.
-- =====================================================================
-- SECURITY DEFINER is genuinely required: the six calling mutation
-- functions run as their own definer identity when they reach this call,
-- and the calling *browser* role (authenticated, or booking_gateway for
-- guest booking) must never be able to invoke this function directly —
-- see the revoke below. tenant_id is deliberately NOT a parameter: it is
-- derived from the appointment row on every call, so no caller (present
-- or future) can construct a cross-tenant event even by mistake — a
-- stronger guarantee than validating a caller-supplied tenant_id against
-- a composite FK would give (see schema note 4 above).
create function private.enqueue_notification_event(
  p_appointment_id uuid,
  p_event_type text,
  p_actor_user_id uuid,
  p_event_data jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_id uuid;
begin
  if p_event_type not in (
    'appointment.created',
    'appointment.cancelled',
    'appointment.rescheduled',
    'appointment.staff_reassigned'
  ) then
    raise exception 'invalid notification event type: %', p_event_type using errcode = 'NE001';
  end if;

  select tenant_id into v_tenant_id
  from public.appointments
  where id = p_appointment_id;

  if v_tenant_id is null then
    raise exception 'appointment not found for notification event' using errcode = 'NE002';
  end if;

  if p_event_data is null or jsonb_typeof(p_event_data) <> 'object' then
    raise exception 'event_data must be a jsonb object' using errcode = 'NE003';
  end if;

  insert into public.notification_events (
    tenant_id, appointment_id, event_type, actor_user_id, event_data
  )
  values (
    v_tenant_id, p_appointment_id, p_event_type, p_actor_user_id, p_event_data
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function private.enqueue_notification_event(uuid, text, uuid, jsonb) is
  'Faz NOTIF.2B — sole write path for public.notification_events. tenant_id is derived from the appointment row, never a caller-supplied parameter. No PUBLIC/authenticated/anon execute, no public.* wrapper — only the six trusted appointment-mutation functions below may call it, from inside their own SECURITY DEFINER transaction, so a rollback there rolls this back too.';

-- Deliberately NO grant to authenticated/anon/public follows — unlike
-- private.log_audit_event (which IS granted to authenticated, since it
-- cannot be used to spoof an actor and audit noise is a lower-risk
-- concern), this phase explicitly requires browser users must never be
-- able to fabricate a notification event, since a future delivery worker
-- will eventually act on these rows. The six mutation functions below
-- call this as their own SECURITY DEFINER owner, which already has
-- implicit execute rights on a function it owns — exactly the same
-- pattern private.replace_appointment_items already relies on (zero
-- grants, called only from sibling SECURITY DEFINER functions).
revoke execute on function private.enqueue_notification_event(uuid, text, uuid, jsonb) from public;

-- =====================================================================
-- 3. create_appointment (internal/staff) — emit appointment.created.
--    Signature UNCHANGED — CREATE OR REPLACE preserves existing grants.
--    Body otherwise byte-for-byte identical to 20260822090000; only the
--    new enqueue call is added, after the existing audit log, before
--    the existing return.
-- =====================================================================
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
    raise exception 'authentication required' using errcode = 'AP001';
  end if;

  if not private.has_permission(p_tenant_id, 'appointments.create') then
    raise exception 'appointments.create required' using errcode = 'AP002';
  end if;

  if not exists (
    select 1 from public.branches
    where id = p_branch_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'branch not found in this tenant' using errcode = 'AP003';
  end if;

  if not exists (
    select 1 from public.customers
    where id = p_customer_id and tenant_id = p_tenant_id and deleted_at is null
  ) then
    raise exception 'customer not found in this tenant' using errcode = 'AP004';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'at least one appointment item is required' using errcode = 'AP005';
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
    raise exception 'one or more services not found or inactive in this tenant' using errcode = 'AP006';
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

  -- Faz NOTIF.2B — actor is the creating auth user, never suppressed
  -- merely because they are a salon user: a future delivery phase is
  -- what decides to exclude the actor from their own push recipients,
  -- not this insert.
  perform private.enqueue_notification_event(
    v_appointment_id, 'appointment.created', auth.uid(), '{}'::jsonb
  );

  return v_appointment_id;
end;
$$;

-- =====================================================================
-- 4. create_guest_booking (public/anonymous) — emit appointment.created,
--    actor_user_id NULL. Signature UNCHANGED (still 11 args) — CREATE OR
--    REPLACE preserves existing grants (booking_gateway only; NO new
--    grant added anywhere in this migration — the enqueue call below
--    runs inside this function's own SECURITY DEFINER body, invisible to
--    booking_gateway's own grant set). Body otherwise byte-for-byte
--    identical to 20260824140000; only the new enqueue call is added,
--    after the existing audit log, before the existing return.
-- =====================================================================
create or replace function private.create_guest_booking(
  p_tenant_slug text,
  p_branch_id uuid,
  p_service_id uuid,
  p_scheduled_start_at timestamptz,
  p_customer_full_name text,
  p_customer_phone text,
  p_staff_member_id uuid default null,
  p_customer_email text default null,
  p_idempotency_key uuid default null,
  p_customer_account_user_id uuid default null,
  p_claim_secret_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant record;
  v_branch record;
  v_service record;
  v_existing_appt record;
  v_customer_id uuid;
  v_phone_norm text;
  v_full_name_trimmed text;
  v_email_norm text;
  v_fingerprint text;
  v_appointment_id uuid;
  v_placeholder_end_at timestamptz;
  v_item_result private.appointment_item_result;
  v_resolved_staff_id uuid;
  v_staff_candidate record;
  v_primary_customer_id uuid;
  v_claim_ref uuid;
begin
  select t.id, t.timezone into v_tenant
  from public.tenants t
  where t.slug = p_tenant_slug and t.deleted_at is null and t.status in ('trial', 'active')
    and private.has_feature(t.id, 'online_booking');
  if not found then
    raise exception 'booking unavailable' using errcode = 'BK001';
  end if;

  select b.id, b.name into v_branch
  from public.branches b
  where b.id = p_branch_id and b.tenant_id = v_tenant.id and b.deleted_at is null;
  if not found then
    raise exception 'invalid branch' using errcode = 'BK002';
  end if;

  select s.id, s.name, s.duration_minutes into v_service
  from public.services s
  where s.id = p_service_id and s.tenant_id = v_tenant.id and s.status = 'active' and s.deleted_at is null
    and exists (select 1 from public.service_branches sb where sb.service_id = s.id and sb.branch_id = p_branch_id);
  if not found then
    raise exception 'invalid service' using errcode = 'BK003';
  end if;

  if p_scheduled_start_at < now() then
    raise exception 'slot no longer available' using errcode = 'BK005';
  end if;

  v_phone_norm := private.normalize_phone(p_customer_phone);
  v_full_name_trimmed := btrim(coalesce(p_customer_full_name, ''));

  if char_length(v_full_name_trimmed) = 0 then
    raise exception 'invalid contact details' using errcode = 'BK006';
  end if;

  if v_phone_norm is null
     or v_phone_norm !~ '^\+?[0-9]+$'
     or char_length(regexp_replace(v_phone_norm, '[^0-9]', '', 'g')) < 7
     or char_length(regexp_replace(v_phone_norm, '[^0-9]', '', 'g')) > 15
  then
    raise exception 'invalid contact details' using errcode = 'BK006';
  end if;

  if p_customer_email is not null and btrim(p_customer_email) <> '' then
    v_email_norm := private.normalize_email(p_customer_email);
    if v_email_norm is null or v_email_norm !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'invalid contact details' using errcode = 'BK006';
    end if;
  end if;

  v_fingerprint := private.canonical_booking_fingerprint(
    v_tenant.id, p_branch_id, p_service_id, p_staff_member_id, p_scheduled_start_at,
    p_customer_full_name, p_customer_phone, p_customer_email, p_customer_account_user_id
  );

  if p_idempotency_key is not null then
    select a.id, a.idempotency_fingerprint, a.customer_id into v_existing_appt
    from public.appointments a
    where a.tenant_id = v_tenant.id and a.idempotency_key = p_idempotency_key;

    if found then
      if v_existing_appt.idempotency_fingerprint = v_fingerprint then
        if p_claim_secret_hash is not null and p_customer_account_user_id is null then
          v_claim_ref := private.upsert_booking_claim(
            v_tenant.id, v_existing_appt.customer_id, v_existing_appt.id, p_customer_email, p_claim_secret_hash
          );
        end if;
        return private.public_booking_confirmation(v_existing_appt.id)
          || jsonb_build_object('claimIssued', v_claim_ref is not null, 'claimRef', v_claim_ref);
      else
        raise exception 'booking already submitted' using errcode = 'BK007';
      end if;
    end if;
  end if;

  if p_customer_account_user_id is not null then
    perform pg_advisory_xact_lock(
      hashtext('customer_account_link'),
      hashtext(v_tenant.id::text || '|' || p_customer_account_user_id::text)
    );

    select cal.customer_id into v_primary_customer_id
    from public.customer_account_links cal
    where cal.tenant_id = v_tenant.id
      and cal.user_id = p_customer_account_user_id
      and cal.deleted_at is null
      and cal.is_primary = true;

    if v_primary_customer_id is not null then
      v_customer_id := v_primary_customer_id;
    else
      select c.id into v_customer_id
      from public.customers c
      where c.tenant_id = v_tenant.id
        and c.status = 'active'
        and c.phone_normalized = v_phone_norm
        and lower(btrim(c.full_name)) = lower(v_full_name_trimmed)
        and not exists (
          select 1 from public.customer_account_links cal2
          where cal2.customer_id = c.id and cal2.deleted_at is null
        )
      limit 1;

      if v_customer_id is null then
        insert into public.customers (tenant_id, full_name, phone, email, status, created_by)
        values (v_tenant.id, v_full_name_trimmed, p_customer_phone, p_customer_email, 'active', null)
        returning id into v_customer_id;
      end if;

      begin
        insert into public.customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
        values (p_customer_account_user_id, v_tenant.id, v_customer_id, 'future_booking', true);
      exception
        when unique_violation then
          insert into public.customers (tenant_id, full_name, phone, email, status, created_by)
          values (v_tenant.id, v_full_name_trimmed, p_customer_phone, p_customer_email, 'active', null)
          returning id into v_customer_id;
          insert into public.customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
          values (p_customer_account_user_id, v_tenant.id, v_customer_id, 'future_booking', true);
      end;
    end if;
  else
    select c.id into v_customer_id
    from public.customers c
    where c.tenant_id = v_tenant.id
      and c.status = 'active'
      and c.phone_normalized = v_phone_norm
      and lower(btrim(c.full_name)) = lower(v_full_name_trimmed)
    limit 1;

    if v_customer_id is not null and p_claim_secret_hash is not null then
      if exists (select 1 from public.appointments a where a.customer_id = v_customer_id)
         or exists (select 1 from public.customer_account_links cal where cal.customer_id = v_customer_id and cal.deleted_at is null)
      then
        v_customer_id := null;
      end if;
    end if;

    if v_customer_id is null then
      insert into public.customers (tenant_id, full_name, phone, email, status, created_by)
      values (v_tenant.id, v_full_name_trimmed, p_customer_phone, p_customer_email, 'active', null)
      returning id into v_customer_id;
    end if;
  end if;

  v_placeholder_end_at := p_scheduled_start_at + (v_service.duration_minutes || ' minutes')::interval;

  insert into public.appointments (
    tenant_id, branch_id, customer_id, source, scheduled_start_at, scheduled_end_at, created_by,
    idempotency_key, idempotency_fingerprint
  )
  values (
    v_tenant.id, p_branch_id, v_customer_id, 'public_booking', p_scheduled_start_at, v_placeholder_end_at, null,
    p_idempotency_key, (case when p_idempotency_key is not null then v_fingerprint else null end)
  )
  returning id into v_appointment_id;

  if p_staff_member_id is not null then
    begin
      v_item_result := private.validate_and_insert_appointment_item(
        v_tenant.id, p_branch_id, v_appointment_id,
        jsonb_build_object(
          'service_id', p_service_id, 'staff_member_id', p_staff_member_id,
          'scheduled_start_at', p_scheduled_start_at
        ),
        1
      );
      v_resolved_staff_id := p_staff_member_id;
    exception
      when others then
        delete from public.appointments where id = v_appointment_id;
        if sqlstate in ('AP008', 'AP009', 'AP010') then
          raise exception 'staff unavailable' using errcode = 'BK004';
        elsif sqlstate in ('AP011', 'AP012') then
          raise exception 'slot no longer available' using errcode = 'BK005';
        else
          raise;
        end if;
    end;
  else
    for v_staff_candidate in
      select sm.id
      from public.staff_members sm
      join public.staff_branches sbr on sbr.staff_member_id = sm.id and sbr.branch_id = p_branch_id
      join public.staff_services ss on ss.staff_member_id = sm.id and ss.service_id = p_service_id
      where sm.tenant_id = v_tenant.id and sm.status = 'active' and sm.deleted_at is null
      order by sm.display_order, sm.id
    loop
      begin
        v_item_result := private.validate_and_insert_appointment_item(
          v_tenant.id, p_branch_id, v_appointment_id,
          jsonb_build_object(
            'service_id', p_service_id, 'staff_member_id', v_staff_candidate.id,
            'scheduled_start_at', p_scheduled_start_at
          ),
          1
        );
        v_resolved_staff_id := v_staff_candidate.id;
        exit;
      exception
        when others then
          if sqlstate in ('AP011', 'AP012') then
            continue;
          else
            delete from public.appointments where id = v_appointment_id;
            raise;
          end if;
      end;
    end loop;

    if v_resolved_staff_id is null then
      delete from public.appointments where id = v_appointment_id;
      raise exception 'slot no longer available' using errcode = 'BK005';
    end if;
  end if;

  update public.appointments
  set scheduled_start_at = v_item_result.scheduled_start_at, scheduled_end_at = v_item_result.scheduled_end_at
  where id = v_appointment_id;

  if p_claim_secret_hash is not null and p_customer_account_user_id is null then
    v_claim_ref := private.upsert_booking_claim(
      v_tenant.id, v_customer_id, v_appointment_id, p_customer_email, p_claim_secret_hash
    );
  end if;

  perform private.log_audit_event(
    v_tenant.id, 'appointment.created', 'appointment', v_appointment_id,
    null, jsonb_build_object('customer_id', v_customer_id, 'source', 'public_booking')
  );

  -- Faz NOTIF.2B — actor_user_id NULL: this path is anonymous (or, for
  -- account-linked guest booking, still not an authenticated staff
  -- actor) — matches this function's own pre-existing created_by = null
  -- convention above, followed literally rather than substituting
  -- auth.uid() (which would also happen to be null under the
  -- booking_gateway role, but an explicit null is clearer and does not
  -- depend on that role's exact connection/JWT context).
  perform private.enqueue_notification_event(
    v_appointment_id, 'appointment.created', null, '{}'::jsonb
  );

  return private.public_booking_confirmation(v_appointment_id)
    || jsonb_build_object('claimIssued', v_claim_ref is not null, 'claimRef', v_claim_ref);
end;
$$;

-- =====================================================================
-- 5. update_appointment_status (internal/staff) — emit
--    appointment.cancelled ONLY when the transition actually becomes
--    'cancelled'. Signature UNCHANGED. Body otherwise byte-for-byte
--    identical to 20260905150000 (the live version — 'completed' is
--    already rejected there with AP017, so this function structurally
--    can never reach 'completed', matching Step 3's "no
--    completion/performance event in Notification V1"). The terminal-
--    state guard a few lines above (v_old_status in ('completed',
--    'cancelled') raises AP014) already makes a second cancellation of
--    an already-cancelled appointment impossible to reach this point —
--    so no extra duplicate-guard is needed beyond the existing
--    p_new_status = 'cancelled' check mirrored from the audit log call.
-- =====================================================================
create or replace function private.update_appointment_status(
  p_appointment_id uuid,
  p_new_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_old_status text;
  v_required_permission text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AP001';
  end if;

  if p_new_status = 'completed' then
    raise exception 'completed status must be set via complete_appointment' using errcode = 'AP017';
  end if;

  if p_new_status not in ('confirmed', 'in_progress', 'cancelled', 'no_show') then
    raise exception 'invalid target status: %', p_new_status using errcode = 'AP015';
  end if;

  select tenant_id, status into v_tenant_id, v_old_status
  from public.appointments
  where id = p_appointment_id
  for update;

  if v_tenant_id is null then
    raise exception 'appointment not found' using errcode = 'AP013';
  end if;

  if v_old_status in ('completed', 'cancelled') then
    raise exception 'cannot change status of a % appointment', v_old_status using errcode = 'AP014';
  end if;

  v_required_permission := case
    when p_new_status = 'cancelled' then 'appointments.cancel'
    else 'appointments.update'
  end;

  if not private.has_permission(v_tenant_id, v_required_permission) then
    raise exception '% required', v_required_permission using errcode = 'AP002';
  end if;

  update public.appointments
  set status = p_new_status
  where id = p_appointment_id;

  perform private.log_audit_event(
    v_tenant_id,
    case when p_new_status = 'cancelled' then 'appointment.cancelled' else 'appointment.status_changed' end,
    'appointment', p_appointment_id,
    jsonb_build_object('status', v_old_status),
    jsonb_build_object('status', p_new_status)
  );

  if p_new_status = 'cancelled' then
    perform private.enqueue_notification_event(
      p_appointment_id, 'appointment.cancelled', auth.uid(), '{}'::jsonb
    );
  end if;
end;
$$;

-- =====================================================================
-- 6. cancel_my_appointment (customer) — emit appointment.cancelled.
--    Signature UNCHANGED. Body otherwise byte-for-byte identical to
--    20260823201517; the same terminal-state guard (status not in
--    ('scheduled','confirmed') raises AC003) already makes a second
--    cancellation of an already-cancelled appointment impossible to
--    reach this point.
-- =====================================================================
create or replace function private.cancel_my_appointment(p_appointment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment record;
  v_tenant record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AC001';
  end if;

  select a.id, a.tenant_id, a.customer_id, a.status, a.scheduled_start_at
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

  select customer_cancellation_enabled, customer_cancellation_cutoff_minutes
  into v_tenant
  from public.tenants
  where id = v_appointment.tenant_id;

  if not v_tenant.customer_cancellation_enabled then
    raise exception 'cancellation disabled' using errcode = 'AC004';
  end if;

  if now() > v_appointment.scheduled_start_at - (v_tenant.customer_cancellation_cutoff_minutes || ' minutes')::interval then
    raise exception 'cancellation cutoff passed' using errcode = 'AC005';
  end if;

  update public.appointments
  set status = 'cancelled'
  where id = p_appointment_id;

  perform private.log_audit_event(
    v_appointment.tenant_id, 'appointment.cancelled', 'appointment', p_appointment_id,
    jsonb_build_object('status', v_appointment.status),
    jsonb_build_object('status', 'cancelled')
  );

  -- Faz NOTIF.2B — customer auth user IS the actor here even though they
  -- hold no tenant_membership; useful later for actor exclusion/audit
  -- semantics (Step 9's explicit instruction).
  perform private.enqueue_notification_event(
    p_appointment_id, 'appointment.cancelled', auth.uid(), '{}'::jsonb
  );

  return jsonb_build_object('appointmentId', p_appointment_id, 'status', 'cancelled');
end;
$$;

-- =====================================================================
-- 7. reschedule_appointment (internal/staff) — emit appointment.
--    rescheduled if any item's time changed, appointment.
--    staff_reassigned if the booked-staff SET changed, both in the same
--    transaction if both are true, neither if neither is. Uses booked
--    staff_member_id (appointment_items), never actual_staff_member_id
--    (a completed-service-performance-only column populated solely by
--    complete_appointment — never touched by this function). Signature
--    UNCHANGED. Body otherwise byte-for-byte identical to 20260824055133
--    (the live, snapshot-trust-boundary-fixed version); only the new
--    diff/emit logic is added, after the existing audit log.
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

  -- Faz NOTIF.2B — booked-staff-id and scheduled_start_at BEFORE the
  -- change, keyed by sequence, derived from the same v_before capture
  -- above (not a second query) — used only for the notification diff
  -- below, independent of the audit log's own before/after shape.
  select coalesce(jsonb_agg(jsonb_build_object(
    'sequence', (elem ->> 'sequence')::integer,
    'staffMemberId', (elem ->> 'staff_member_id')::uuid,
    'scheduledStartAt', (elem ->> 'scheduled_start_at')::timestamptz
  ) order by (elem ->> 'sequence')::integer), '[]'::jsonb)
  into v_notif_before
  from jsonb_array_elements(v_before) as elem;

  -- Faz NOTIF.2B — staff-independent time-only projection, used ONLY to
  -- decide v_time_changed below. v_notif_before/v_notif_after (above/
  -- below) intentionally also carry staffMemberId, since that is part
  -- of the correct event_data payload shape — but comparing THOSE full
  -- objects for "did time change" is wrong: a staff-only reassignment
  -- with the identical scheduledStartAt would then also spuriously
  -- compare unequal (because staffMemberId differs) and wrongly fire
  -- appointment.rescheduled too. Caught by this migration's own test 16
  -- ("staff-only reassignment") during Faz NOTIF.2B's fresh test run —
  -- fixed here before ever being reported as working.
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

  -- Faz NOTIF.2B — re-read the AFTER state fresh from the table rather
  -- than trusting p_items/v_merged_items verbatim: replace_appointment_
  -- items is the actual source of truth for what got persisted
  -- (sequence assignment, validated staff/service), so diffing against
  -- its real output is safer than assuming the caller's payload shape.
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

  select coalesce(array_agg(v), '{}') into v_new_staff_ids
  from (select unnest(v_after_staff_ids) except select unnest(v_before_staff_ids)) as t(v);

  select coalesce(array_agg(v), '{}') into v_lost_staff_ids
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
-- 8. reschedule_my_appointment (customer) — emit appointment.rescheduled
--    only when the time actually changes; this function can never
--    change staff (confirmed fresh: every item shifts by one uniform
--    delta, staff_member_id/service_id/sequence copied verbatim from the
--    current row — see the unchanged v_new_items build below), so no
--    staff_reassigned path exists here. Signature UNCHANGED. Body
--    otherwise byte-for-byte identical to 20260823205200; only the new
--    no-op guard + enqueue call is added, after the existing audit log.
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

  -- Faz NOTIF.2B — appointment-level before/after is the correct MINIMUM
  -- shape here specifically (unlike staff-side reschedule): every item
  -- shifts by the identical v_delta, so a single before/after start
  -- fully determines every item's shift — an item-level array would be
  -- pure duplication of the same fact. Guarded against a no-op request
  -- (p_new_start_at equal to the current start): nothing upstream
  -- rejects that as an error, so without this check a customer
  -- resubmitting the same time would fabricate a spurious "rescheduled"
  -- event.
  if p_new_start_at <> v_appointment.scheduled_start_at then
    perform private.enqueue_notification_event(
      p_appointment_id, 'appointment.rescheduled', auth.uid(),
      jsonb_build_object(
        'previousStartAt', v_appointment.scheduled_start_at,
        'newStartAt', p_new_start_at
      )
    );
  end if;

  return jsonb_build_object('appointmentId', p_appointment_id, 'scheduledStartAt', p_new_start_at);
end;
$$;
