-- Faz NOTIF.1A (part 2 of 2) — the wiring: (a) capture the address typed
-- for a public booking, inside the booking transaction, and (b) enqueue
-- exactly one confirmation job when a public booking is confirmed for the
-- first time. Depends on 20260928100000_customer_notification_outbox_
-- foundation.sql. Both pieces are inert for any tenant without an ENABLED
-- activation row (the default for every tenant), so applying this
-- migration changes nothing observable until a tenant is deliberately
-- activated.
--
-- =====================================================================
-- WHY THESE TWO HOOK POINTS, AND WHY NOT REDEFINE THE BIG FUNCTIONS
-- =====================================================================
--
-- * Snapshot capture hooks the thin PUBLIC wrapper of create_guest_booking
--   (a one-statement SQL function), not private.create_guest_booking
--   (~300 lines, redefined a dozen times, and whose production text cannot
--   be diffed from a developer machine). The wrapper is the only entry
--   point (booking_gateway has EXECUTE on it alone), it already receives
--   the address and the name, and the private function has already
--   returned the confirmation — so the appointment id is known and the
--   whole thing is still ONE transaction: the booking and its snapshot
--   commit or roll back together. The private function is not touched.
--
-- * The enqueue is an AFTER UPDATE OF status trigger on appointments
--   (there is already one, sync_appointment_item_status), not a new
--   branch inside private.update_appointment_status, for the same reason.
--   The WHEN clause restricts it to old = 'scheduled', new = 'confirmed',
--   source = 'public_booking'; the RPC's own FOR UPDATE row lock makes a
--   concurrent second confirm see old = 'confirmed', and the outbox's
--   UNIQUE key is the backstop behind that.
--
-- * Neither hook can break its host operation. The capture step and the
--   enqueue step each run their real work inside an EXCEPTION block: if
--   anything at all goes wrong (a constraint, a missing table, a bug),
--   the booking is still created and the appointment is still confirmed —
--   the customer simply gets no email. A confirmation that blocks on
--   email plumbing is exactly what must never happen.

-- =====================================================================
-- 1. Booking-time recipient snapshot
-- =====================================================================

-- Takes the confirmation jsonb the private function returned, captures the
-- snapshot as a side effect and hands the SAME jsonb straight back, so the
-- wrapper's result is byte-for-byte what it was before this migration.
create function private.capture_booking_contact_from_confirmation(
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
  v_activated_at timestamptz;
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

    -- Only a public booking that is still waiting for confirmation, and
    -- only while the tenant's activation is ENABLED and the booking was
    -- created at/after the activation watermark. (A replay of an old
    -- idempotency key after activation therefore cannot back-fill an
    -- address for a booking that predates it.)
    select a.tenant_id, a.created_at into v_tenant_id, v_created_at
    from public.appointments a
    where a.id = v_appointment_id
      and a.source = 'public_booking'
      and a.status = 'scheduled';
    if v_tenant_id is null then
      return p_confirmation;
    end if;

    select act.activated_at into v_activated_at
    from private.customer_notification_activation act
    where act.tenant_id = v_tenant_id
      and act.notification_type = 'appointment_confirmation'
      and act.channel = 'email'
      and act.enabled;
    if v_activated_at is null or v_created_at < v_activated_at then
      return p_confirmation;
    end if;

    -- First whitespace-separated token of the name typed for THIS booking.
    v_first_name := nullif(
      left(split_part(regexp_replace(btrim(coalesce(p_customer_full_name, '')), '\s+', ' ', 'g'), ' ', 1), 60),
      ''
    );

    insert into private.appointment_booking_contacts (appointment_id, tenant_id, recipient_email, greeting_name)
    values (v_appointment_id, v_tenant_id, v_email, v_first_name)
    on conflict (appointment_id) do nothing;
  exception
    when others then
      -- Never fail a booking over an email snapshot. SQLSTATE only: no
      -- address, no name, no message text reaches the log.
      raise warning 'customer contact snapshot skipped (sqlstate %)', sqlstate;
  end;

  return p_confirmation;
end;
$$;

comment on function private.capture_booking_contact_from_confirmation(jsonb, text, text) is
  'Faz NOTIF.1A. Pass-through: returns p_confirmation unchanged after best-effort capturing the booking-time recipient (normalized email + first name) into private.appointment_booking_contacts. Inert unless the appointment''s tenant has the confirmation email ENABLED and the booking was created at/after the activation watermark. Never raises: any failure is swallowed (the booking must not depend on this).';

revoke execute on function private.capture_booking_contact_from_confirmation(jsonb, text, text) from public;

-- DRIFT GUARD. The next statement REPLACES the public wrapper's body, and
-- this project has been bitten before by a production function whose text
-- differed from the repository's (see supabase/migrations/README.md). So
-- refuse to overwrite anything but the plain one-statement pass-through
-- this migration was written against (whitespace-insensitive), or a wrapper
-- that is already wired (a re-run). If production's wrapper is anything
-- else, this raises, the transaction rolls back, and nothing changes.
-- (Compared with ALL whitespace removed, so formatting differences alone
-- can never trip it.)
do $$
declare
  v_body text;
begin
  select regexp_replace(p.prosrc, '\s+', '', 'g')
  into v_body
  from pg_proc p
  where p.oid = 'public.create_guest_booking(text,uuid,uuid,timestamptz,text,text,uuid,text,uuid,uuid,text)'::regprocedure;

  if v_body is null then
    raise exception 'public.create_guest_booking is missing';
  end if;

  if v_body not like '%capture_booking_contact_from_confirmation%'
     and v_body <> 'selectprivate.create_guest_booking(p_tenant_slug,p_branch_id,p_service_id,p_scheduled_start_at,p_customer_full_name,p_customer_phone,p_staff_member_id,p_customer_email,p_idempotency_key,p_customer_account_user_id,p_claim_secret_hash);'
  then
    raise exception 'public.create_guest_booking is not the expected plain pass-through wrapper (production drift?) - refusing to replace it';
  end if;
end
$$;

-- The public wrapper: identical signature, language, security mode,
-- search_path and ACL (booking_gateway only) as before; only the body
-- changes, to route the private function's result through the capture.
create or replace function public.create_guest_booking(
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
language sql
security definer
set search_path = ''
as $$
  select private.capture_booking_contact_from_confirmation(
    private.create_guest_booking(
      p_tenant_slug, p_branch_id, p_service_id, p_scheduled_start_at,
      p_customer_full_name, p_customer_phone, p_staff_member_id, p_customer_email, p_idempotency_key,
      p_customer_account_user_id, p_claim_secret_hash
    ),
    p_customer_email,
    p_customer_full_name
  );
$$;

-- =====================================================================
-- 2. Enqueue on the first scheduled -> confirmed of a public booking
-- =====================================================================
create function private.enqueue_customer_confirmation_email()
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

    -- Feature not active for this tenant: no job, no trace.
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
      tenant_id, appointment_id, notification_type, channel, status, skip_reason
    )
    values (
      new.tenant_id, new.id, 'appointment_confirmation', 'email', v_status, v_skip_reason
    )
    on conflict (appointment_id, notification_type, channel) do nothing;
  exception
    when others then
      -- Never fail an approval over the outbox. SQLSTATE only.
      raise warning 'customer confirmation enqueue skipped (sqlstate %)', sqlstate;
  end;

  return null;
end;
$$;

comment on function private.enqueue_customer_confirmation_email() is
  'Faz NOTIF.1A. AFTER UPDATE OF status trigger function. Records ONE confirmation job the first time a public_booking appointment goes scheduled -> confirmed, for a tenant with the confirmation email ENABLED: pending when a booking-time recipient exists, skipped (no_recipient / predates_activation) otherwise. Idempotent (ON CONFLICT DO NOTHING on the dedup key). Sends nothing and never raises: an outbox problem must not fail an approval.';

revoke execute on function private.enqueue_customer_confirmation_email() from public;

create trigger enqueue_customer_confirmation_email
  after update of status on public.appointments
  for each row
  when (old.status = 'scheduled' and new.status = 'confirmed' and new.source = 'public_booking')
  execute function private.enqueue_customer_confirmation_email();
