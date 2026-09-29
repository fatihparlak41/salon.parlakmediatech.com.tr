-- Faz NOTIF.1A (part 1 of 2) — customer appointment-confirmation EMAIL:
-- the durable outbox, the booking-time recipient snapshot, the per-tenant
-- activation switch and the worker RPCs. INERT BY CONSTRUCTION: nothing in
-- this file changes the behavior of any existing function, trigger,
-- policy or grant. The wiring (booking-time snapshot capture + the
-- scheduled -> confirmed enqueue trigger) is a separate migration
-- (20260928100100_customer_confirmation_email_wiring.sql), so the two
-- steps can be applied, verified and — if needed — reverted separately.
--
-- =====================================================================
-- AUDIT FINDINGS THIS MIGRATION IS BUILT FROM (read in full, not assumed)
-- =====================================================================
--
-- 1. The only way an appointment ever goes scheduled -> confirmed is
--    private.update_appointment_status (verified against the live DEV
--    catalog: it is the only function that both writes appointments and
--    mentions 'confirmed'). It locks the appointment row FOR UPDATE, so
--    two concurrent confirms serialize, and the second one sees
--    old = 'confirmed'.
--
-- 2. Staff-created appointments carry source = 'internal'; the public
--    booking flow (private.create_guest_booking) is the only writer of
--    source = 'public_booking'. appointments.source has no CHECK.
--
-- 3. There is NO booking-time email snapshot today. create_guest_booking
--    writes the supplied email onto customers.email only when it CREATES a
--    customer row; a returning customer is matched by (phone, name) and
--    keeps whatever email that row already had — the address typed for
--    THIS booking is dropped. The only other copy is the claim snapshot,
--    which exists only for opted-in verified claims. So the recipient MUST
--    be captured separately, at booking time (private.appointment_
--    booking_contacts below), never read back from customers.email.
--
-- 4. The Web Push outbox (notification_events -> notification_deliveries
--    -> notification_delivery_targets) is membership/device shaped, gated
--    by a GLOBAL singleton (notification_delivery_activation), and its
--    event payloads are visible to staff. It is not reused: a customer
--    email needs an appointment-scoped recipient, a per-tenant activation
--    and PII that no staff role can read. The two systems share nothing
--    but the cron-auth helper and the lease/fencing PATTERN.
--
-- 5. appointments (id, tenant_id) is UNIQUE, so every new table can carry
--    a composite tenant-safe FK to it — a cross-tenant row is
--    structurally impossible, not merely application-checked.
--
-- 6. branches.location_url already exists (Faz 2I.2F, validated as http(s)
--    at write time in lib/modules/branches). No new location column is
--    added; the email layer re-validates it as HTTPS-only at render time.
--
-- =====================================================================
-- DESIGN
-- =====================================================================
--
-- * Everything lives in the `private` schema (no anon/authenticated/
--   service_role USAGE), with RLS enabled and every table privilege
--   revoked as a second, independent lock. The Node worker reaches the
--   data only through four service_role-only public.* wrapper RPCs.
--
-- * private.customer_notification_jobs is the outbox. UNIQUE
--   (appointment_id, notification_type, channel) is the DB-enforced
--   idempotency: a double click, a concurrent confirm, a status flip and
--   a worker retry can all happen and there is still at most ONE
--   confirmation job (and therefore at most one email) per appointment.
--
-- * Statuses: pending, processing, sent, retry, failed, uncertain, skipped.
--     retry     = the provider provably did NOT accept the message and
--                 the failure is transient -> bounded backoff, max 5
--                 attempts.
--     failed    = terminal; retrying cannot help (permanent rejection,
--                 or attempts exhausted).
--     uncertain = terminal; the message MAY have been accepted (the
--                 connection died after the payload was sent, or the
--                 worker died mid-send). NEVER retried automatically — a
--                 blind retry would risk a duplicate customer email.
--     skipped   = terminal; deliberately not sent (no recipient, the
--                 appointment is no longer confirmed, it already started,
--                 the booking predates activation, ...).
--
-- * Send-start marker (send_started_at). A worker calls
--   begin_customer_notification_send immediately before the SMTP call. A
--   lease that expires WITHOUT that marker is a pre-send crash (safe to
--   re-claim); a lease that expires WITH it is ambiguous and becomes
--   'uncertain'. That is what makes "lease expiry recovery" safe.
--
-- * Activation is per tenant AND per (type, channel), with a watermark:
--   only bookings created at/after activated_at are ever emailed, and
--   the recipient snapshot is only captured while the tenant is active —
--   so deploying code, or activating a tenant, can never email a
--   historical appointment, and a tenant that never activates never has
--   an address copied at all (minimal PII). enabled = false is the kill
--   switch (claiming stops immediately, pending jobs stay queued).
--
-- * Retention: purge_customer_notification_data deletes recipient
--   snapshots once the job is terminal (or the appointment ended) and the
--   retention window has passed. Jobs themselves hold no PII and stay.

-- =====================================================================
-- 1. Tables
-- =====================================================================

create table private.customer_notification_activation (
  tenant_id uuid not null,
  notification_type text not null,
  channel text not null,
  enabled boolean not null default true,
  activated_at timestamptz not null default now(),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_notification_activation_pkey
    primary key (tenant_id, notification_type, channel),
  constraint customer_notification_activation_type_check
    check (notification_type in ('appointment_confirmation')),
  constraint customer_notification_activation_channel_check
    check (channel in ('email')),
  constraint customer_notification_activation_tenant_fkey
    foreign key (tenant_id) references public.tenants (id) on delete cascade
);

comment on table private.customer_notification_activation is
  'Faz NOTIF.1A — per-tenant, per-(type, channel) activation of a customer notification. No row = OFF (the default for every tenant, including every existing one). activated_at is a WATERMARK: only bookings created at or after it are emailed. enabled = false is the kill switch. Populated only by private.activate_customer_confirmation_email (operator SQL), never by application code.';

create table private.appointment_booking_contacts (
  appointment_id uuid primary key,
  tenant_id uuid not null,
  recipient_email text not null,
  greeting_name text,
  created_at timestamptz not null default now(),

  constraint appointment_booking_contacts_email_check
    check (char_length(recipient_email) between 3 and 254),
  constraint appointment_booking_contacts_name_check
    check (greeting_name is null or char_length(greeting_name) between 1 and 60),
  constraint appointment_booking_contacts_appointment_same_tenant
    foreign key (appointment_id, tenant_id)
    references public.appointments (id, tenant_id) on delete cascade
);

comment on table private.appointment_booking_contacts is
  'Faz NOTIF.1A — the address the customer typed for THIS booking (normalized), plus the first name to greet them with, captured once inside the booking transaction and NEVER updated (trigger below). Deliberately separate from customers.email, which is neither booking-scoped nor immutable. Not readable by any staff role, not part of any public booking response, not part of any notification event payload: private schema, RLS on, zero grants, reachable only through the service_role worker RPCs. Captured only while the tenant''s activation is enabled. Purged by purge_customer_notification_data.';

create table private.customer_notification_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  appointment_id uuid not null,
  notification_type text not null,
  channel text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_token uuid,
  send_started_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error_class text,
  skip_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_notification_jobs_type_check
    check (notification_type in ('appointment_confirmation')),
  constraint customer_notification_jobs_channel_check
    check (channel in ('email')),
  constraint customer_notification_jobs_status_check
    check (status in ('pending', 'processing', 'sent', 'retry', 'failed', 'uncertain', 'skipped')),
  constraint customer_notification_jobs_attempt_count_check
    check (attempt_count >= 0),
  constraint customer_notification_jobs_error_class_check
    check (last_error_class is null or char_length(last_error_class) <= 60),
  constraint customer_notification_jobs_skip_reason_check
    check (skip_reason is null or char_length(skip_reason) <= 60),
  constraint customer_notification_jobs_message_id_check
    check (provider_message_id is null or char_length(provider_message_id) <= 300),
  constraint customer_notification_jobs_skipped_has_reason
    check (status <> 'skipped' or skip_reason is not null),
  constraint customer_notification_jobs_sent_has_timestamp
    check (status <> 'sent' or sent_at is not null),

  -- DB-enforced idempotency: at most one job per appointment per
  -- (type, channel), whatever races or retries happen above it.
  constraint customer_notification_jobs_dedup_key
    unique (appointment_id, notification_type, channel),

  constraint customer_notification_jobs_tenant_fkey
    foreign key (tenant_id) references public.tenants (id),
  constraint customer_notification_jobs_appointment_same_tenant
    foreign key (appointment_id, tenant_id)
    references public.appointments (id, tenant_id) on delete cascade
);

comment on table private.customer_notification_jobs is
  'Faz NOTIF.1A — the durable customer-notification outbox (today: appointment_confirmation over email). One row per (appointment, type, channel), enforced by customer_notification_jobs_dedup_key. Holds no customer PII (the recipient lives in appointment_booking_contacts). Written only by the enqueue trigger and the worker RPCs; never by the browser.';

comment on column private.customer_notification_jobs.locked_at is
  'Lease start (not a boolean lock). A processing job whose lease has expired is re-claimable ONLY if send_started_at is null; otherwise it becomes uncertain.';
comment on column private.customer_notification_jobs.lock_token is
  'Fencing token, reissued on every claim. Results and the send-start marker are only applied when the token still matches, so a stale worker can never overwrite a newer attempt.';
comment on column private.customer_notification_jobs.send_started_at is
  'Set immediately before the SMTP call (begin_customer_notification_send). Present + no recorded result = the outcome is unknown -> uncertain, never a blind retry.';

create index customer_notification_jobs_claim_idx
  on private.customer_notification_jobs (next_attempt_at)
  where status in ('pending', 'retry');

create index customer_notification_jobs_lease_idx
  on private.customer_notification_jobs (locked_at)
  where status = 'processing';

create trigger set_updated_at
  before update on private.customer_notification_jobs
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on private.customer_notification_activation
  for each row execute function public.set_updated_at();

-- The booking-time snapshot is immutable: whoever wrote it wrote it once.
create function private.reject_customer_contact_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'appointment_booking_contacts rows are immutable' using errcode = 'CN003';
end;
$$;

revoke execute on function private.reject_customer_contact_update() from public;

create trigger appointment_booking_contacts_immutable
  before update on private.appointment_booking_contacts
  for each row execute function private.reject_customer_contact_update();

-- Double lock: RLS on with no policy AND every table privilege revoked.
alter table private.customer_notification_activation enable row level security;
alter table private.appointment_booking_contacts enable row level security;
alter table private.customer_notification_jobs enable row level security;

revoke all on table private.customer_notification_activation from public, anon, authenticated, service_role;
revoke all on table private.appointment_booking_contacts from public, anon, authenticated, service_role;
revoke all on table private.customer_notification_jobs from public, anon, authenticated, service_role;

-- =====================================================================
-- 2. Shape check shared by the capture step and the claim-time recheck.
--    Mirrors the check private.create_guest_booking already applies
--    (BK006) so an address that could be stored is an address that can
--    be sent to.
-- =====================================================================
create function private.is_deliverable_email_shape(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_email is not null
    and char_length(p_email) between 3 and 254
    and p_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
$$;

revoke execute on function private.is_deliverable_email_shape(text) from public;

-- =====================================================================
-- 3. Worker RPCs. private.* holds the logic; the public.* wrappers exist
--    only so the service-role Supabase client can call them, and are
--    granted to service_role ALONE.
-- =====================================================================

-- 3a. Claim + eligibility recheck + payload assembly, in ONE transaction:
--     the only way to close the gap between "was eligible when queued"
--     and "about to be sent" without a race.
create function private.claim_customer_notification_jobs(
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
    and a.notification_type = 'appointment_confirmation'
    and a.channel = 'email';

  -- Fail closed: no active tenant anywhere = nothing to do, and nothing
  -- is touched (not even the reaper below).
  if v_active_tenants = 0 then
    return jsonb_build_object('activeTenantCount', 0, 'jobs', '[]'::jsonb);
  end if;

  -- A lease that expired AFTER the send began is ambiguous: the SMTP
  -- server may or may not have accepted the message. Never retried.
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
      where j.notification_type = 'appointment_confirmation'
        and j.channel = 'email'
        and (
          (j.status in ('pending', 'retry') and j.next_attempt_at <= now())
          -- a claimed-but-never-started job whose worker vanished: nothing
          -- was sent, so it is safe to hand out again.
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
    returning j.id, j.lock_token, j.tenant_id, j.appointment_id, j.attempt_count
  loop
    v_skip := null;

    select t.name as salon_name, t.timezone as tenant_timezone, t.status as tenant_status,
           t.deleted_at as tenant_deleted_at, a.status as appointment_status,
           a.scheduled_start_at, b.location_url
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

    if not v_found then
      v_skip := 'appointment_missing';
    elsif v_ctx.tenant_deleted_at is not null or v_ctx.tenant_status not in ('trial', 'active') then
      v_skip := 'tenant_inactive';
    elsif v_ctx.appointment_status <> 'confirmed' then
      v_skip := 'appointment_not_confirmed';
    elsif v_ctx.scheduled_start_at <= now() then
      v_skip := 'appointment_started';
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
      'recipientEmail', v_contact.recipient_email,
      'greetingName', v_contact.greeting_name,
      'salonName', v_ctx.salon_name,
      'tenantTimezone', v_ctx.tenant_timezone,
      'appointmentStartAt', v_ctx.scheduled_start_at,
      'serviceNames', to_jsonb(v_services),
      'locationUrl', v_ctx.location_url
    ));
  end loop;

  return jsonb_build_object('activeTenantCount', v_active_tenants, 'jobs', v_jobs);
end;
$$;

comment on function private.claim_customer_notification_jobs(integer, integer) is
  'Faz NOTIF.1A. Fails closed (no jobs) unless at least one tenant has the confirmation email ENABLED; only jobs of an enabled tenant are ever handed out. Claims up to p_batch_size due jobs with FOR UPDATE SKIP LOCKED (two concurrent workers never get the same job), reissues a fencing lock_token, and re-checks eligibility against CURRENT state in the same transaction (tenant active, appointment still confirmed and still in the future, recipient present and well-formed, services present) — an ineligible job is marked skipped and never returned. Returns the recipient address and everything the template needs; service_role only, never reachable from a browser. A processing job whose lease expired after send_started_at was set is marked uncertain, not retried.';

revoke execute on function private.claim_customer_notification_jobs(integer, integer) from public;

create function public.claim_customer_notification_jobs(
  p_batch_size integer default 5,
  p_lease_seconds integer default 180
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.claim_customer_notification_jobs(p_batch_size, p_lease_seconds);
$$;

comment on function public.claim_customer_notification_jobs(integer, integer) is
  'Faz NOTIF.1A. service_role only — returns customer contact data for the server-side worker.';

revoke execute on function public.claim_customer_notification_jobs(integer, integer) from public;
revoke execute on function public.claim_customer_notification_jobs(integer, integer) from anon;
revoke execute on function public.claim_customer_notification_jobs(integer, integer) from authenticated;
grant execute on function public.claim_customer_notification_jobs(integer, integer) to service_role;

-- 3b. Send-start marker. Returns false when the lease was lost (another
--     worker re-claimed the job): the caller must then NOT send.
create function private.begin_customer_notification_send(p_job_id uuid, p_lock_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update private.customer_notification_jobs
  set send_started_at = now(),
      attempt_count = attempt_count + 1
  where id = p_job_id
    and lock_token = p_lock_token
    and status = 'processing'
    and send_started_at is null
  returning id into v_id;

  return v_id is not null;
end;
$$;

comment on function private.begin_customer_notification_send(uuid, uuid) is
  'Faz NOTIF.1A. Stamps send_started_at and counts the attempt, only while the caller still holds the lease (lock_token matches, status processing, no send already begun). Called immediately before the SMTP call; false means "do not send".';

revoke execute on function private.begin_customer_notification_send(uuid, uuid) from public;

create function public.begin_customer_notification_send(p_job_id uuid, p_lock_token uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private.begin_customer_notification_send(p_job_id, p_lock_token);
$$;

comment on function public.begin_customer_notification_send(uuid, uuid) is
  'Faz NOTIF.1A. service_role only.';

revoke execute on function public.begin_customer_notification_send(uuid, uuid) from public;
revoke execute on function public.begin_customer_notification_send(uuid, uuid) from anon;
revoke execute on function public.begin_customer_notification_send(uuid, uuid) from authenticated;
grant execute on function public.begin_customer_notification_send(uuid, uuid) to service_role;

-- 3c. Result recording. Fenced by lock_token. Error text is never stored
--     verbatim: only a short lowercase classification.
create function private.record_customer_notification_result(
  p_job_id uuid,
  p_lock_token uuid,
  p_disposition text,
  p_error_class text default null,
  p_provider_message_id text default null,
  p_skip_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job record;
  v_new_status text;
  v_next_attempt_at timestamptz;
  v_backoff_minutes integer;
  v_error_class text;
begin
  if p_disposition is null or p_disposition not in ('sent', 'retry', 'failed', 'uncertain', 'skipped') then
    raise exception 'invalid disposition' using errcode = 'CN002';
  end if;

  select id, attempt_count
  into v_job
  from private.customer_notification_jobs
  where id = p_job_id
    and lock_token = p_lock_token
    and status = 'processing'
  for update;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'lock_token_mismatch_or_not_found');
  end if;

  v_error_class := case
    when p_error_class is null then null
    when p_error_class ~ '^[a-z][a-z0-9_]{0,59}$' then p_error_class
    else 'unknown'
  end;

  if p_disposition = 'retry' then
    -- attempt_count already includes the attempt that just failed.
    -- 1 -> +1m, 2 -> +5m, 3 -> +15m, 4 -> +60m, a 5th failure is final.
    v_backoff_minutes := case v_job.attempt_count
      when 1 then 1
      when 2 then 5
      when 3 then 15
      when 4 then 60
      else null
    end;
    if v_backoff_minutes is null then
      v_new_status := 'failed';
    else
      v_new_status := 'retry';
      v_next_attempt_at := now() + make_interval(mins => v_backoff_minutes);
    end if;
  else
    v_new_status := p_disposition;
  end if;

  update private.customer_notification_jobs
  set status = v_new_status,
      next_attempt_at = coalesce(v_next_attempt_at, next_attempt_at),
      locked_at = null,
      lock_token = null,
      send_started_at = case when v_new_status = 'retry' then null else send_started_at end,
      sent_at = case when v_new_status = 'sent' then now() else sent_at end,
      provider_message_id = case
        when v_new_status = 'sent' then left(nullif(btrim(coalesce(p_provider_message_id, '')), ''), 300)
        else provider_message_id
      end,
      last_error_class = case when v_new_status = 'sent' then null else v_error_class end,
      skip_reason = case
        when v_new_status = 'skipped' then coalesce(
          case when p_skip_reason ~ '^[a-z][a-z0-9_]{0,59}$' then p_skip_reason end,
          'skipped'
        )
        else skip_reason
      end
  where id = p_job_id;

  return jsonb_build_object('applied', true, 'status', v_new_status);
end;
$$;

comment on function private.record_customer_notification_result(uuid, uuid, text, text, text, text) is
  'Faz NOTIF.1A. Applies a send outcome only while the caller still holds the lease. Dispositions: sent | retry (bounded backoff 1/5/15/60 minutes, a 5th failed attempt becomes failed) | failed | uncertain | skipped. Clears the lease. Stores only short lowercase classifications, never provider text, addresses or message bodies.';

revoke execute on function private.record_customer_notification_result(uuid, uuid, text, text, text, text) from public;

create function public.record_customer_notification_result(
  p_job_id uuid,
  p_lock_token uuid,
  p_disposition text,
  p_error_class text default null,
  p_provider_message_id text default null,
  p_skip_reason text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.record_customer_notification_result(
    p_job_id, p_lock_token, p_disposition, p_error_class, p_provider_message_id, p_skip_reason
  );
$$;

comment on function public.record_customer_notification_result(uuid, uuid, text, text, text, text) is
  'Faz NOTIF.1A. service_role only.';

revoke execute on function public.record_customer_notification_result(uuid, uuid, text, text, text, text) from public;
revoke execute on function public.record_customer_notification_result(uuid, uuid, text, text, text, text) from anon;
revoke execute on function public.record_customer_notification_result(uuid, uuid, text, text, text, text) from authenticated;
grant execute on function public.record_customer_notification_result(uuid, uuid, text, text, text, text) to service_role;

-- 3d. Retention of the recipient snapshot.
create function private.purge_customer_notification_data(
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

  with doomed as (
    select c.appointment_id
    from private.appointment_booking_contacts c
    join public.appointments a on a.id = c.appointment_id
    left join private.customer_notification_jobs j
      on j.appointment_id = c.appointment_id
     and j.notification_type = 'appointment_confirmation'
     and j.channel = 'email'
    where (
        -- the appointment is long over and no send is still possible
        a.scheduled_end_at < now() - make_interval(days => p_retention_days)
        and (j.id is null or j.status in ('sent', 'failed', 'uncertain', 'skipped'))
      )
      or (
        -- the job reached a final state a while ago
        j.status in ('sent', 'failed', 'uncertain', 'skipped')
        and j.updated_at < now() - make_interval(days => p_retention_days)
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

comment on function private.purge_customer_notification_data(integer, integer) is
  'Faz NOTIF.1A. Deletes booking-time recipient snapshots that can no longer be used: the job is terminal (sent/failed/uncertain/skipped) for longer than the retention window, or the appointment ended longer ago than the window and no send is still pending. Bounded per call. Never touches a snapshot whose job is still pending/processing/retry while the appointment is upcoming.';

revoke execute on function private.purge_customer_notification_data(integer, integer) from public;

create function public.purge_customer_notification_data(
  p_retention_days integer default 30,
  p_batch_size integer default 200
)
returns integer
language sql
security definer
set search_path = ''
as $$
  select private.purge_customer_notification_data(p_retention_days, p_batch_size);
$$;

comment on function public.purge_customer_notification_data(integer, integer) is
  'Faz NOTIF.1A. service_role only.';

revoke execute on function public.purge_customer_notification_data(integer, integer) from public;
revoke execute on function public.purge_customer_notification_data(integer, integer) from anon;
revoke execute on function public.purge_customer_notification_data(integer, integer) from authenticated;
grant execute on function public.purge_customer_notification_data(integer, integer) to service_role;

-- =====================================================================
-- 4. Operator functions — run from the Supabase SQL editor (postgres).
--    No grant to any application role: application code can never turn
--    the feature on for a tenant.
-- =====================================================================

-- Idempotent: activating an already-enabled tenant does NOT move the
-- watermark (that would silently demote earlier post-activation bookings
-- to "predates activation"). Re-enabling a disabled tenant does move it
-- to now, so bookings made while it was off are never emailed.
create function private.activate_customer_confirmation_email(p_tenant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_activated_at timestamptz;
begin
  select t.id into v_tenant_id
  from public.tenants t
  where t.slug = p_tenant_slug
    and t.deleted_at is null
    and t.status in ('trial', 'active');

  if v_tenant_id is null then
    raise exception 'tenant not found or not active' using errcode = 'CN004';
  end if;

  insert into private.customer_notification_activation (tenant_id, notification_type, channel, enabled, activated_at)
  values (v_tenant_id, 'appointment_confirmation', 'email', true, now())
  on conflict (tenant_id, notification_type, channel) do update
    set activated_at = case
          when private.customer_notification_activation.enabled then private.customer_notification_activation.activated_at
          else now()
        end,
        enabled = true,
        disabled_at = null
  returning activated_at into v_activated_at;

  return jsonb_build_object('tenantSlug', p_tenant_slug, 'enabled', true, 'activatedAt', v_activated_at);
end;
$$;

comment on function private.activate_customer_confirmation_email(text) is
  'Faz NOTIF.1A. Operator-only (no grants). Enables the appointment-confirmation EMAIL for one tenant. Bookings created from this moment on are captured and emailed when confirmed; earlier bookings never are.';

revoke execute on function private.activate_customer_confirmation_email(text) from public;

create function private.deactivate_customer_confirmation_email(p_tenant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_changed integer;
begin
  select t.id into v_tenant_id from public.tenants t where t.slug = p_tenant_slug;
  if v_tenant_id is null then
    raise exception 'tenant not found' using errcode = 'CN004';
  end if;

  update private.customer_notification_activation
  set enabled = false,
      disabled_at = now()
  where tenant_id = v_tenant_id
    and notification_type = 'appointment_confirmation'
    and channel = 'email'
    and enabled;
  get diagnostics v_changed = row_count;

  return jsonb_build_object('tenantSlug', p_tenant_slug, 'enabled', false, 'changed', v_changed > 0);
end;
$$;

comment on function private.deactivate_customer_confirmation_email(text) is
  'Faz NOTIF.1A. Operator-only (no grants). The kill switch: claiming stops on the next worker run and no new recipient snapshot is captured; queued jobs stay queued (they are re-checked, and skipped if stale, when re-enabled).';

revoke execute on function private.deactivate_customer_confirmation_email(text) from public;

-- Read-only, PII-free status for the operator: activation state plus job
-- counts by status.
create function private.customer_confirmation_email_status(p_tenant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_activation record;
  v_activation_found boolean;
  v_counts jsonb;
begin
  select t.id into v_tenant_id from public.tenants t where t.slug = p_tenant_slug;
  if v_tenant_id is null then
    raise exception 'tenant not found' using errcode = 'CN004';
  end if;

  select a.enabled, a.activated_at, a.disabled_at
  into v_activation
  from private.customer_notification_activation a
  where a.tenant_id = v_tenant_id
    and a.notification_type = 'appointment_confirmation'
    and a.channel = 'email';
  -- (a composite IS NOT NULL is false as soon as ANY field is null, and
  -- disabled_at usually is — so the row's existence is read from FOUND.)
  v_activation_found := found;

  select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
  into v_counts
  from (
    select j.status, count(*) as n
    from private.customer_notification_jobs j
    where j.tenant_id = v_tenant_id
    group by j.status
  ) s;

  return jsonb_build_object(
    'tenantSlug', p_tenant_slug,
    'activationRowExists', v_activation_found,
    'enabled', coalesce(v_activation.enabled, false),
    'activatedAt', v_activation.activated_at,
    'disabledAt', v_activation.disabled_at,
    'jobsByStatus', v_counts
  );
end;
$$;

comment on function private.customer_confirmation_email_status(text) is
  'Faz NOTIF.1A. Operator-only, read-only, PII-free: activation state and job counts by status for one tenant.';

revoke execute on function private.customer_confirmation_email_status(text) from public;
