-- Faz LAUNCH.1B — customer appointment notifications: the full lifecycle
-- (confirmation, change, cancellation, 24 h reminder) on the EXISTING NOTIF.1A/1B
-- outbox, plus owner-controlled per-salon switches.
--
-- =====================================================================
-- WHAT EXISTED (read in full, not assumed)
-- =====================================================================
-- * private.customer_notification_jobs — the durable outbox. One job per
--   (appointment, type, channel) by UNIQUE key; lease + fencing token;
--   send_started_at "uncertain" safeguard; bounded retry (1/5/15/60 min);
--   statuses pending/processing/sent/retry/failed/uncertain/skipped.
-- * private.customer_notification_activation — per tenant and (type, channel),
--   a watermark (activated_at) and a kill switch (enabled). No row = OFF. It was
--   only writable by operator SQL, and only for 'appointment_confirmation'.
-- * private.appointment_booking_contacts — the immutable booking-time recipient
--   snapshot, captured for PUBLIC bookings only.
-- * The only enqueue hook was the scheduled -> confirmed trigger, public
--   bookings only. The worker is run by a Vercel cron every minute.
--
-- =====================================================================
-- WHAT THIS ADDS (and what it deliberately does not)
-- =====================================================================
-- No parallel system: the same tables, the same worker RPCs, the same lease and
-- retry machinery.
--
--  1. Four notification types: appointment_confirmation, appointment_update,
--     appointment_cancellation, appointment_reminder_24h. The activation table and
--     the jobs table accept all four.
--  2. The dedupe key gains dedupe_revision: confirmation and cancellation stay at
--     revision 0 (at most one each per appointment, as before); an update gets the
--     next revision per change; a reminder's revision is the appointment start
--     (epoch seconds), so there is at most ONE reminder per appointment per start
--     time, and a rescheduled appointment gets a fresh one. target_start_at records
--     the start a job was created for, so a stale job can be recognised.
--  3. Owner controls: settings.manage (Owner-only in the locked default roles; no
--     new permission) can read and set the four switches, and read a PII-free delivery
--     health summary, through three authenticated RPCs. Every change is audited.
--     Default stays OFF for every tenant: nobody is emailed until the Owner opts in.
--  4. Enqueue is trigger-based, like NOTIF.1A, and can never fail the host operation:
--       - confirmation: first scheduled -> confirmed, ANY source (was public only);
--       - cancellation: status becomes cancelled;
--       - update: start/end/branch change, or appointment_items change (service,
--         staff, time, duration), but ONLY for a confirmed appointment whose
--         confirmation the customer already received (so a booking being built never
--         produces an "update"); changes made while an update job is still pending
--         are COALESCED into it (90 s debounce) and the job always reads the latest
--         appointment state when it is claimed;
--       - reminder: PULL-based. private.materialize_customer_reminders() runs at the
--         start of every claim and creates the reminder job when the appointment is
--         confirmed, has a recipient, its reminder moment (start - 24 h) has arrived
--         and is no more than 3 hours old, and the last schedule change happened
--         BEFORE that moment. Hence: an appointment booked or moved less than 24 h
--         before its start never gets a "tomorrow" reminder, a missed window (outage)
--         is skipped instead of sent late, and turning the switch on later reminds only
--         appointments that are still ahead.
--  5. Staff-created (internal) appointments now also capture a recipient snapshot
--     (the customer record's e-mail at creation time, immutable afterwards), but only
--     while the tenant has at least one switch ON.
--  6. Claim-time re-validation for every type, against CURRENT state in the claiming
--     transaction: switch still ON for that type (a disabled tenant's queued jobs are
--     simply not handed out), tenant active, recipient present and well-formed,
--     appointment in the state the type requires (confirmed for confirmation, update
--     and reminder; cancelled for cancellation), still in the future, reminder start
--     equals the start it was created for, reminder inside its window, no job older
--     than 48 h except reminders (which have their own window).
--  7. Retention: a recipient snapshot now lives until the appointment ended
--     more than the retention window ago AND no job is still active (a reminder for a
--     far-future booking must still find its recipient).
--
-- Not changed: SMTP, the transport, the lease/retry machinery, the Web Push staff
-- system, any appointment RPC body.

-- =====================================================================
-- 1. Types and the revisioned dedupe key
-- =====================================================================
alter table private.customer_notification_activation
  drop constraint customer_notification_activation_type_check;
alter table private.customer_notification_activation
  add constraint customer_notification_activation_type_check
  check (notification_type in (
    'appointment_confirmation', 'appointment_update', 'appointment_cancellation', 'appointment_reminder_24h'
  ));

alter table private.customer_notification_jobs
  drop constraint customer_notification_jobs_type_check;
alter table private.customer_notification_jobs
  add constraint customer_notification_jobs_type_check
  check (notification_type in (
    'appointment_confirmation', 'appointment_update', 'appointment_cancellation', 'appointment_reminder_24h'
  ));

alter table private.customer_notification_jobs
  add column dedupe_revision bigint not null default 0,
  add column target_start_at timestamptz;

comment on column private.customer_notification_jobs.dedupe_revision is
  'Faz LAUNCH.1B. Part of the dedupe key. 0 for confirmation and cancellation; the next integer per change for an update; the appointment start in epoch seconds for a reminder (one reminder per appointment per start time).';
comment on column private.customer_notification_jobs.target_start_at is
  'Faz LAUNCH.1B. The appointment start this job was created for (reminders: required). A reminder whose appointment has since moved is skipped as stale.';

alter table private.customer_notification_jobs
  drop constraint customer_notification_jobs_dedup_key;
alter table private.customer_notification_jobs
  add constraint customer_notification_jobs_dedup_key
  unique (appointment_id, notification_type, channel, dedupe_revision);

alter table private.customer_notification_jobs
  add constraint customer_notification_jobs_reminder_has_target
  check (notification_type <> 'appointment_reminder_24h' or target_start_at is not null);

-- =====================================================================
-- 2. The schedule anchor: when did the appointment's start last change?
-- =====================================================================
create table private.appointment_schedule_anchor (
  appointment_id uuid primary key,
  tenant_id uuid not null,
  start_at timestamptz not null,
  set_at timestamptz not null default now(),

  constraint appointment_schedule_anchor_appointment_same_tenant
    foreign key (appointment_id, tenant_id)
    references public.appointments (id, tenant_id) on delete cascade
);

comment on table private.appointment_schedule_anchor is
  'Faz LAUNCH.1B. One row per appointment: the current start and WHEN it was set (creation or the last reschedule). The reminder rule "never remind an appointment that was booked or moved less than 24 h before its start" compares set_at with start - 24 h. No PII. Private schema, RLS on, no grants.';

alter table private.appointment_schedule_anchor enable row level security;
revoke all on table private.appointment_schedule_anchor from public, anon, authenticated, service_role;

create function private.track_appointment_schedule_anchor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into private.appointment_schedule_anchor (appointment_id, tenant_id, start_at, set_at)
    values (new.id, new.tenant_id, new.scheduled_start_at, now())
    on conflict (appointment_id) do update
      set start_at = excluded.start_at,
          set_at = excluded.set_at
      where private.appointment_schedule_anchor.start_at is distinct from excluded.start_at;
  exception
    when others then
      raise warning 'appointment schedule anchor skipped (sqlstate %)', sqlstate;
  end;
  return null;
end;
$$;

revoke execute on function private.track_appointment_schedule_anchor() from public;

create trigger track_appointment_schedule_anchor
  after insert or update of scheduled_start_at on public.appointments
  for each row
  execute function private.track_appointment_schedule_anchor();

-- =====================================================================
-- 3. Recipient snapshot capture (public bookings: generalised; internal: new)
-- =====================================================================

-- Is ANY customer-notification switch ON for the tenant, and since when (the earliest
-- activation among the enabled ones)? null = none enabled.
create function private.customer_notifications_active_since(p_tenant_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select min(act.activated_at)
  from private.customer_notification_activation act
  where act.tenant_id = p_tenant_id
    and act.channel = 'email'
    and act.enabled;
$$;

revoke execute on function private.customer_notifications_active_since(uuid) from public;

create or replace function private.capture_booking_contact_from_confirmation(
  p_confirmation jsonb,
  p_customer_email text,
  p_customer_full_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment_id uuid;
  v_email text;
  v_first_name text;
  v_tenant_id uuid;
  v_created_at timestamptz;
  v_active_since timestamptz;
begin
  begin
    v_email := private.normalize_email(p_customer_email);
    if v_email is null or not private.is_deliverable_email_shape(v_email) then
      return p_confirmation;
    end if;

    v_appointment_id := nullif(p_confirmation ->> 'appointmentReference', '')::uuid;
    if v_appointment_id is null then
      return p_confirmation;
    end if;

    select a.tenant_id, a.created_at into v_tenant_id, v_created_at
    from public.appointments a
    where a.id = v_appointment_id
      and a.source = 'public_booking'
      and a.status = 'scheduled';
    if v_tenant_id is null then
      return p_confirmation;
    end if;

    -- Faz LAUNCH.1B: ANY enabled switch (not only the confirmation), and the booking
    -- must be at/after the earliest activation, so a replayed old idempotency key
    -- cannot back-fill an address for a booking that predates it.
    v_active_since := private.customer_notifications_active_since(v_tenant_id);
    if v_active_since is null or v_created_at < v_active_since then
      return p_confirmation;
    end if;

    v_first_name := nullif(
      left(split_part(regexp_replace(btrim(coalesce(p_customer_full_name, '')), '\s+', ' ', 'g'), ' ', 1), 60),
      ''
    );

    insert into private.appointment_booking_contacts (appointment_id, tenant_id, recipient_email, greeting_name)
    values (v_appointment_id, v_tenant_id, v_email, v_first_name)
    on conflict (appointment_id) do nothing;
  exception
    when others then
      raise warning 'customer contact snapshot skipped (sqlstate %)', sqlstate;
  end;

  return p_confirmation;
end;
$$;

-- Internal (staff-created) appointments: snapshot the customer record's e-mail at
-- creation, immutable afterwards, only while a switch is ON, never failing the insert.
create function private.capture_internal_appointment_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_since timestamptz;
  v_email text;
  v_name text;
begin
  begin
    v_active_since := private.customer_notifications_active_since(new.tenant_id);
    if v_active_since is null or new.created_at < v_active_since then
      return null;
    end if;

    select c.email_normalized, c.full_name into v_email, v_name
    from public.customers c
    where c.id = new.customer_id
      and c.tenant_id = new.tenant_id
      and c.deleted_at is null;

    if v_email is null or not private.is_deliverable_email_shape(v_email) then
      return null;
    end if;

    insert into private.appointment_booking_contacts (appointment_id, tenant_id, recipient_email, greeting_name)
    values (
      new.id,
      new.tenant_id,
      v_email,
      nullif(left(split_part(regexp_replace(btrim(coalesce(v_name, '')), '\s+', ' ', 'g'), ' ', 1), 60), '')
    )
    on conflict (appointment_id) do nothing;
  exception
    when others then
      raise warning 'internal appointment contact snapshot skipped (sqlstate %)', sqlstate;
  end;
  return null;
end;
$$;

revoke execute on function private.capture_internal_appointment_contact() from public;

create trigger capture_internal_appointment_contact
  after insert on public.appointments
  for each row
  when (new.source is distinct from 'public_booking')
  execute function private.capture_internal_appointment_contact();

-- =====================================================================
-- 4. Enqueue: confirmation (any source), cancellation, update
-- =====================================================================
create or replace function private.enqueue_customer_confirmation_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activated_at timestamptz;
  v_status text;
  v_skip_reason text;
begin
  begin
    select act.activated_at into v_activated_at
    from private.customer_notification_activation act
    where act.tenant_id = new.tenant_id
      and act.notification_type = 'appointment_confirmation'
      and act.channel = 'email'
      and act.enabled;

    if v_activated_at is null then
      return null;
    end if;

    if new.created_at < v_activated_at then
      v_status := 'skipped';
      v_skip_reason := 'predates_activation';
    elsif not exists (
      select 1 from private.appointment_booking_contacts c
      where c.appointment_id = new.id and c.tenant_id = new.tenant_id
    ) then
      v_status := 'skipped';
      v_skip_reason := 'no_recipient';
    else
      v_status := 'pending';
    end if;

    insert into private.customer_notification_jobs (
      tenant_id, appointment_id, notification_type, channel, status, skip_reason, dedupe_revision
    )
    values (
      new.tenant_id, new.id, 'appointment_confirmation', 'email', v_status, v_skip_reason, 0
    )
    on conflict (appointment_id, notification_type, channel, dedupe_revision) do nothing;
  exception
    when others then
      raise warning 'customer confirmation enqueue skipped (sqlstate %)', sqlstate;
  end;

  return null;
end;
$$;

-- The WHEN clause loses its source restriction: a confirmation is the first move into
-- 'confirmed', whoever created the appointment.
drop trigger enqueue_customer_confirmation_email on public.appointments;
create trigger enqueue_customer_confirmation_email
  after update of status on public.appointments
  for each row
  when (old.status = 'scheduled' and new.status = 'confirmed')
  execute function private.enqueue_customer_confirmation_email();

create function private.enqueue_customer_cancellation_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activated_at timestamptz;
  v_status text;
  v_skip_reason text;
begin
  begin
    select act.activated_at into v_activated_at
    from private.customer_notification_activation act
    where act.tenant_id = new.tenant_id
      and act.notification_type = 'appointment_cancellation'
      and act.channel = 'email'
      and act.enabled;

    if v_activated_at is null then
      return null;
    end if;

    if new.created_at < v_activated_at then
      v_status := 'skipped';
      v_skip_reason := 'predates_activation';
    elsif not exists (
      select 1 from private.appointment_booking_contacts c
      where c.appointment_id = new.id and c.tenant_id = new.tenant_id
    ) then
      v_status := 'skipped';
      v_skip_reason := 'no_recipient';
    else
      v_status := 'pending';
    end if;

    insert into private.customer_notification_jobs (
      tenant_id, appointment_id, notification_type, channel, status, skip_reason, dedupe_revision, target_start_at
    )
    values (
      new.tenant_id, new.id, 'appointment_cancellation', 'email', v_status, v_skip_reason, 0, new.scheduled_start_at
    )
    on conflict (appointment_id, notification_type, channel, dedupe_revision) do nothing;
  exception
    when others then
      raise warning 'customer cancellation enqueue skipped (sqlstate %)', sqlstate;
  end;

  return null;
end;
$$;

revoke execute on function private.enqueue_customer_cancellation_email() from public;

create trigger enqueue_customer_cancellation_email
  after update of status on public.appointments
  for each row
  when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function private.enqueue_customer_cancellation_email();

-- The shared update enqueue. Idempotent and coalescing; called from two trigger
-- functions below (appointment header, appointment items).
create function private.enqueue_customer_update_email(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_status text;
  v_start timestamptz;
  v_enabled boolean;
  v_rows integer;
  v_revision bigint;
begin
  begin
    select a.tenant_id, a.status, a.scheduled_start_at
    into v_tenant_id, v_status, v_start
    from public.appointments a
    where a.id = p_appointment_id;

    if v_tenant_id is null or v_status is distinct from 'confirmed' then
      return;
    end if;

    select true into v_enabled
    from private.customer_notification_activation act
    where act.tenant_id = v_tenant_id
      and act.notification_type = 'appointment_update'
      and act.channel = 'email'
      and act.enabled;
    if v_enabled is null then
      return;
    end if;

    -- The customer must already have been told about this appointment: an "update"
    -- is only meaningful against a confirmation they received (or may have received).
    if not exists (
      select 1 from private.customer_notification_jobs j
      where j.appointment_id = p_appointment_id
        and j.notification_type = 'appointment_confirmation'
        and j.channel = 'email'
        and j.status in ('sent', 'processing', 'uncertain')
    ) then
      return;
    end if;

    if not exists (
      select 1 from private.appointment_booking_contacts c
      where c.appointment_id = p_appointment_id and c.tenant_id = v_tenant_id
    ) then
      return;
    end if;

    -- Coalesce: a change while an update is still waiting only moves its send time
    -- (it reads the latest state when claimed anyway).
    update private.customer_notification_jobs j
    set next_attempt_at = now() + interval '90 seconds',
        target_start_at = v_start
    where j.appointment_id = p_appointment_id
      and j.notification_type = 'appointment_update'
      and j.channel = 'email'
      and j.status in ('pending', 'retry');
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      return;
    end if;

    select coalesce(max(j.dedupe_revision), 0) + 1 into v_revision
    from private.customer_notification_jobs j
    where j.appointment_id = p_appointment_id
      and j.notification_type = 'appointment_update'
      and j.channel = 'email';

    insert into private.customer_notification_jobs (
      tenant_id, appointment_id, notification_type, channel, status, dedupe_revision, target_start_at, next_attempt_at
    )
    values (
      v_tenant_id, p_appointment_id, 'appointment_update', 'email', 'pending', v_revision, v_start,
      now() + interval '90 seconds'
    )
    on conflict (appointment_id, notification_type, channel, dedupe_revision) do nothing;
  exception
    when others then
      raise warning 'customer update enqueue skipped (sqlstate %)', sqlstate;
  end;
end;
$$;

revoke execute on function private.enqueue_customer_update_email(uuid) from public;

create function private.trg_customer_update_from_appointment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_customer_update_email(new.id);
  return null;
end;
$$;

revoke execute on function private.trg_customer_update_from_appointment() from public;

create trigger enqueue_customer_update_from_appointment
  after update of scheduled_start_at, scheduled_end_at, branch_id on public.appointments
  for each row
  when (
    old.scheduled_start_at is distinct from new.scheduled_start_at
    or old.scheduled_end_at is distinct from new.scheduled_end_at
    or old.branch_id is distinct from new.branch_id
  )
  execute function private.trg_customer_update_from_appointment();

create function private.trg_customer_update_from_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.enqueue_customer_update_email(old.appointment_id);
  else
    perform private.enqueue_customer_update_email(new.appointment_id);
  end if;
  return null;
end;
$$;

revoke execute on function private.trg_customer_update_from_item() from public;

create trigger enqueue_customer_update_from_item
  after insert or delete or update of service_id, staff_member_id, scheduled_start_at, duration_minutes
  on public.appointment_items
  for each row
  execute function private.trg_customer_update_from_item();

-- =====================================================================
-- 5. Reminders: pull-based materialisation
-- =====================================================================
create function private.materialize_customer_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  begin
    with due as (
      select a.id, a.tenant_id, a.scheduled_start_at
      from private.customer_notification_activation act
      join public.appointments a on a.tenant_id = act.tenant_id
      where act.notification_type = 'appointment_reminder_24h'
        and act.channel = 'email'
        and act.enabled
        and a.status = 'confirmed'
        and a.scheduled_start_at > now()
        -- the reminder moment (start - 24 h) has arrived and is at most 3 hours old
        and a.scheduled_start_at - interval '24 hours' <= now()
        and now() <= a.scheduled_start_at - interval '24 hours' + interval '3 hours'
        and exists (
          select 1 from private.appointment_booking_contacts c
          where c.appointment_id = a.id and c.tenant_id = a.tenant_id
        )
        -- booked or moved AFTER the reminder moment => no "tomorrow" reminder
        and coalesce(
              (select s.set_at from private.appointment_schedule_anchor s where s.appointment_id = a.id),
              a.updated_at
            ) <= a.scheduled_start_at - interval '24 hours'
      order by a.scheduled_start_at
      limit 500
    )
    insert into private.customer_notification_jobs (
      tenant_id, appointment_id, notification_type, channel, status, dedupe_revision, target_start_at
    )
    select d.tenant_id, d.id, 'appointment_reminder_24h', 'email', 'pending',
           extract(epoch from d.scheduled_start_at)::bigint, d.scheduled_start_at
    from due d
    on conflict (appointment_id, notification_type, channel, dedupe_revision) do nothing;
    get diagnostics v_count = row_count;
  exception
    when others then
      raise warning 'customer reminder materialisation skipped (sqlstate %)', sqlstate;
      v_count := 0;
  end;
  return v_count;
end;
$$;

revoke execute on function private.materialize_customer_reminders() from public;

comment on function private.materialize_customer_reminders() is
  'Faz LAUNCH.1B. Creates the 24 h reminder job (one per appointment per start time) for confirmed appointments with a recipient whose reminder moment (start - 24 h) arrived within the last 3 hours and that were booked or moved before that moment, for tenants whose reminder switch is ON. Called at the start of every claim. Never raises.';

-- =====================================================================
-- 6. Claim: all four types, re-validated against CURRENT state
-- =====================================================================
create or replace function private.claim_customer_notification_jobs(
  p_batch_size integer default 5,
  p_lease_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_tenants integer;
  v_lease interval;
  v_row record;
  v_ctx record;
  v_contact record;
  v_services text[];
  v_staff text[];
  v_found boolean;
  v_skip text;
  v_jobs jsonb := '[]'::jsonb;
begin
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 50 then
    raise exception 'p_batch_size must be between 1 and 50' using errcode = 'CN001';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'p_lease_seconds must be between 30 and 3600' using errcode = 'CN001';
  end if;
  v_lease := make_interval(secs => p_lease_seconds);

  select count(*) into v_active_tenants
  from private.customer_notification_activation a
  where a.enabled
    and a.channel = 'email';

  -- Fail closed: no switch ON anywhere = nothing to do, nothing is touched.
  if v_active_tenants = 0 then
    return jsonb_build_object('activeTenantCount', 0, 'jobs', '[]'::jsonb);
  end if;

  perform private.materialize_customer_reminders();

  update private.customer_notification_jobs j
  set status = 'uncertain',
      locked_at = null,
      lock_token = null,
      last_error_class = 'worker_interrupted'
  where j.status = 'processing'
    and j.send_started_at is not null
    and j.locked_at <= now() - v_lease;

  for v_row in
    with candidates as (
      select j.id
      from private.customer_notification_jobs j
      where j.channel = 'email'
        and (
          (j.status in ('pending', 'retry') and j.next_attempt_at <= now())
          or (j.status = 'processing' and j.send_started_at is null and j.locked_at <= now() - v_lease)
        )
        and exists (
          select 1
          from private.customer_notification_activation a
          where a.tenant_id = j.tenant_id
            and a.notification_type = j.notification_type
            and a.channel = j.channel
            and a.enabled
        )
      order by j.next_attempt_at, j.created_at
      limit p_batch_size
      for update of j skip locked
    )
    update private.customer_notification_jobs j
    set status = 'processing',
        locked_at = now(),
        lock_token = gen_random_uuid()
    from candidates c
    where j.id = c.id
    returning j.id, j.lock_token, j.tenant_id, j.appointment_id, j.attempt_count,
              j.notification_type, j.target_start_at, j.created_at
  loop
    v_skip := null;

    select t.name as salon_name, t.slug as tenant_slug, t.timezone as tenant_timezone,
           t.status as tenant_status, t.deleted_at as tenant_deleted_at,
           a.status as appointment_status, a.scheduled_start_at,
           b.location_url, b.phone as branch_phone
    into v_ctx
    from public.appointments a
    join public.tenants t on t.id = a.tenant_id
    join public.branches b on b.id = a.branch_id and b.tenant_id = a.tenant_id
    where a.id = v_row.appointment_id
      and a.tenant_id = v_row.tenant_id;
    v_found := found;

    select c.recipient_email, c.greeting_name
    into v_contact
    from private.appointment_booking_contacts c
    where c.appointment_id = v_row.appointment_id
      and c.tenant_id = v_row.tenant_id;

    select coalesce(array_agg(s.name order by ai.sequence, ai.id), '{}')
    into v_services
    from public.appointment_items ai
    join public.services s on s.id = ai.service_id and s.tenant_id = ai.tenant_id
    where ai.appointment_id = v_row.appointment_id
      and ai.tenant_id = v_row.tenant_id;

    select coalesce(array_agg(n.full_name order by n.first_seq), '{}')
    into v_staff
    from (
      select sm.full_name, min(ai.sequence) as first_seq
      from public.appointment_items ai
      join public.staff_members sm on sm.id = ai.staff_member_id and sm.tenant_id = ai.tenant_id
      where ai.appointment_id = v_row.appointment_id
        and ai.tenant_id = v_row.tenant_id
      group by sm.full_name
    ) n;

    if not v_found then
      v_skip := 'appointment_missing';
    elsif v_ctx.tenant_deleted_at is not null or v_ctx.tenant_status not in ('trial', 'active') then
      v_skip := 'tenant_inactive';
    elsif v_row.notification_type = 'appointment_cancellation' and v_ctx.appointment_status <> 'cancelled' then
      v_skip := 'appointment_not_cancelled';
    elsif v_row.notification_type <> 'appointment_cancellation' and v_ctx.appointment_status <> 'confirmed' then
      v_skip := 'appointment_not_confirmed';
    elsif v_ctx.scheduled_start_at <= now() then
      v_skip := 'appointment_started';
    elsif v_row.notification_type = 'appointment_reminder_24h' and v_row.target_start_at is distinct from v_ctx.scheduled_start_at then
      v_skip := 'rescheduled';
    elsif v_row.notification_type = 'appointment_reminder_24h'
          and now() > v_ctx.scheduled_start_at - interval '24 hours' + interval '3 hours' then
      v_skip := 'reminder_window_missed';
    elsif v_row.notification_type <> 'appointment_reminder_24h' and v_row.created_at < now() - interval '48 hours' then
      v_skip := 'stale';
    elsif v_contact.recipient_email is null then
      v_skip := 'no_recipient';
    elsif not private.is_deliverable_email_shape(v_contact.recipient_email) then
      v_skip := 'invalid_recipient';
    elsif coalesce(array_length(v_services, 1), 0) = 0 then
      v_skip := 'no_services';
    end if;

    if v_skip is not null then
      update private.customer_notification_jobs
      set status = 'skipped',
          skip_reason = v_skip,
          locked_at = null,
          lock_token = null
      where id = v_row.id;
      continue;
    end if;

    v_jobs := v_jobs || jsonb_build_array(jsonb_build_object(
      'jobId', v_row.id,
      'lockToken', v_row.lock_token,
      'attemptCount', v_row.attempt_count,
      'notificationType', v_row.notification_type,
      'recipientEmail', v_contact.recipient_email,
      'greetingName', v_contact.greeting_name,
      'salonName', v_ctx.salon_name,
      'tenantSlug', v_ctx.tenant_slug,
      'tenantTimezone', v_ctx.tenant_timezone,
      'appointmentStartAt', v_ctx.scheduled_start_at,
      'serviceNames', to_jsonb(v_services),
      'staffNames', to_jsonb(v_staff),
      'contactPhone', v_ctx.branch_phone,
      'locationUrl', v_ctx.location_url
    ));
  end loop;

  return jsonb_build_object('activeTenantCount', v_active_tenants, 'jobs', v_jobs);
end;
$$;

-- =====================================================================
-- 7. Retention of the recipient snapshot
-- =====================================================================
create or replace function private.purge_customer_notification_data(
  p_retention_days integer default 30,
  p_batch_size integer default 200
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_retention_days is null or p_retention_days < 1 or p_retention_days > 3650 then
    raise exception 'p_retention_days must be between 1 and 3650' using errcode = 'CN001';
  end if;
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 500 then
    raise exception 'p_batch_size must be between 1 and 500' using errcode = 'CN001';
  end if;

  -- A snapshot is needed until the appointment is over (a reminder for a far-future
  -- booking must still find its recipient). It goes once the appointment ended more
  -- than the window ago and no job is still active for it.
  with doomed as (
    select c.appointment_id
    from private.appointment_booking_contacts c
    join public.appointments a on a.id = c.appointment_id
    where a.scheduled_end_at < now() - make_interval(days => p_retention_days)
      and not exists (
        select 1 from private.customer_notification_jobs j
        where j.appointment_id = c.appointment_id
          and j.status in ('pending', 'processing', 'retry')
      )
    order by c.created_at
    limit p_batch_size
    for update of c skip locked
  )
  delete from private.appointment_booking_contacts c
  using doomed d
  where c.appointment_id = d.appointment_id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- =====================================================================
-- 8. Owner controls (settings.manage; audited; authenticated only)
-- =====================================================================
create function private.get_customer_notification_settings(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'CN010';
  end if;
  if p_tenant_id is null or not private.has_permission(p_tenant_id, 'settings.manage') then
    raise exception 'settings.manage required' using errcode = 'CN011';
  end if;

  return jsonb_build_object(
    'appointment_confirmation', exists (
      select 1 from private.customer_notification_activation a
      where a.tenant_id = p_tenant_id and a.notification_type = 'appointment_confirmation' and a.channel = 'email' and a.enabled),
    'appointment_update', exists (
      select 1 from private.customer_notification_activation a
      where a.tenant_id = p_tenant_id and a.notification_type = 'appointment_update' and a.channel = 'email' and a.enabled),
    'appointment_cancellation', exists (
      select 1 from private.customer_notification_activation a
      where a.tenant_id = p_tenant_id and a.notification_type = 'appointment_cancellation' and a.channel = 'email' and a.enabled),
    'appointment_reminder_24h', exists (
      select 1 from private.customer_notification_activation a
      where a.tenant_id = p_tenant_id and a.notification_type = 'appointment_reminder_24h' and a.channel = 'email' and a.enabled)
  );
end;
$$;

revoke execute on function private.get_customer_notification_settings(uuid) from public;

create function private.set_customer_notification_setting(
  p_tenant_id uuid,
  p_notification_type text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'CN010';
  end if;
  if p_tenant_id is null or not private.has_permission(p_tenant_id, 'settings.manage') then
    raise exception 'settings.manage required' using errcode = 'CN011';
  end if;
  if p_notification_type is null or p_notification_type not in (
    'appointment_confirmation', 'appointment_update', 'appointment_cancellation', 'appointment_reminder_24h'
  ) then
    raise exception 'invalid notification type' using errcode = 'CN012';
  end if;
  if p_enabled is null then
    raise exception 'enabled is required' using errcode = 'CN012';
  end if;
  if not exists (
    select 1 from public.tenants t where t.id = p_tenant_id and t.deleted_at is null and t.status in ('trial', 'active')
  ) then
    raise exception 'tenant not found or not active' using errcode = 'CN004';
  end if;

  select a.enabled into v_old
  from private.customer_notification_activation a
  where a.tenant_id = p_tenant_id and a.notification_type = p_notification_type and a.channel = 'email'
  for update;

  if p_enabled then
    -- Idempotent: turning ON something already ON keeps the watermark. Turning it
    -- back ON after OFF moves the watermark to now, so appointments created while it
    -- was off are never mailed retroactively.
    insert into private.customer_notification_activation (tenant_id, notification_type, channel, enabled, activated_at)
    values (p_tenant_id, p_notification_type, 'email', true, now())
    on conflict (tenant_id, notification_type, channel) do update
      set activated_at = case when private.customer_notification_activation.enabled
                              then private.customer_notification_activation.activated_at else now() end,
          enabled = true,
          disabled_at = null;
  else
    update private.customer_notification_activation
    set enabled = false,
        disabled_at = now()
    where tenant_id = p_tenant_id and notification_type = p_notification_type and channel = 'email' and enabled;
  end if;

  if coalesce(v_old, false) is distinct from p_enabled then
    perform private.log_audit_event(
      p_tenant_id,
      'settings.customer_notification_changed',
      'customer_notification_setting',
      p_tenant_id,
      jsonb_build_object('type', p_notification_type, 'enabled', coalesce(v_old, false)),
      jsonb_build_object('type', p_notification_type, 'enabled', p_enabled)
    );
  end if;

  return jsonb_build_object('type', p_notification_type, 'enabled', p_enabled);
end;
$$;

revoke execute on function private.set_customer_notification_setting(uuid, text, boolean) from public;

-- PII-free delivery health for the owner: what happened to the last 14 days of jobs.
create function private.get_customer_notification_health(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'CN010';
  end if;
  if p_tenant_id is null or not private.has_permission(p_tenant_id, 'settings.manage') then
    raise exception 'settings.manage required' using errcode = 'CN011';
  end if;

  select jsonb_build_object(
    'windowDays', 14,
    'sent', count(*) filter (where j.status = 'sent'),
    'failed', count(*) filter (where j.status = 'failed'),
    'uncertain', count(*) filter (where j.status = 'uncertain'),
    'waiting', count(*) filter (where j.status in ('pending', 'processing', 'retry')),
    'skippedNoRecipient', count(*) filter (where j.status = 'skipped' and j.skip_reason in ('no_recipient', 'invalid_recipient'))
  )
  into v_result
  from private.customer_notification_jobs j
  where j.tenant_id = p_tenant_id
    and j.created_at >= now() - interval '14 days';

  return v_result;
end;
$$;

revoke execute on function private.get_customer_notification_health(uuid) from public;

create function public.get_customer_notification_settings(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_customer_notification_settings(p_tenant_id);
$$;

create function public.set_customer_notification_setting(
  p_tenant_id uuid,
  p_notification_type text,
  p_enabled boolean
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.set_customer_notification_setting(p_tenant_id, p_notification_type, p_enabled);
$$;

create function public.get_customer_notification_health(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_customer_notification_health(p_tenant_id);
$$;

revoke execute on function public.get_customer_notification_settings(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.set_customer_notification_setting(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke execute on function public.get_customer_notification_health(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_customer_notification_settings(uuid) to authenticated;
grant execute on function public.set_customer_notification_setting(uuid, text, boolean) to authenticated;
grant execute on function public.get_customer_notification_health(uuid) to authenticated;

comment on function public.set_customer_notification_setting(uuid, text, boolean) is
  'Faz LAUNCH.1B. settings.manage only (Owner); audited; idempotent. Turning a type ON sets the activation watermark (appointments created before it are never mailed for that type).';
