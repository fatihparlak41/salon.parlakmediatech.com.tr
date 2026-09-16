-- Faz NOTIF.2F.1 — durable, server-only, event-time DISPLAY snapshot for
-- rich push copy. Deliberately a SEPARATE table from notification_events,
-- not a new event_data key (NOTIF.2F's own proposal, rejected by product
-- review) — notification_events has held zero customer PII since Faz
-- NOTIF.2B by explicit invariant ("Never customer name/phone/email/
-- notes/health data" — still literally that table's own comment) and
-- this phase does not touch that invariant. customer_name is the first
-- piece of customer PII this schema has ever stored, and it lives here,
-- in a table whose single purpose is documented as PII-adjacent display
-- data with its own tighter retention story (see this migration's final
-- report for the proposed — not yet implemented — 30-day purge design).
--
-- =====================================================================
-- FRESH AUDIT — the exact 6 RPCs that create notification_events today
-- =====================================================================
-- Confirmed by re-reading every migration that has ever touched the
-- write path (20260909100000, 20260909110000, 20260914140000,
-- 20260914150000): private.enqueue_notification_event is the SOLE write
-- path, called from exactly 6 SECURITY DEFINER functions and nowhere
-- else — private.create_appointment, private.create_guest_booking,
-- private.update_appointment_status (cancelled branch only),
-- private.cancel_my_appointment, private.reschedule_appointment,
-- private.reschedule_my_appointment. Every one of the 6 is CREATE OR
-- REPLACEd below with an UNCHANGED signature, adding only the
-- display-field computation and an extended enqueue_notification_event
-- call; no other line in any of them changes.
--
-- =====================================================================
-- WHY THE CAPTURE LIVES INSIDE enqueue_notification_event ITSELF, NOT
-- REPEATED 6 TIMES
-- =====================================================================
-- enqueue_notification_event already runs inside the SAME transaction as
-- every one of the 6 callers (it is a nested function call inside their
-- own already-open transaction, not a separate round trip) — extending
-- IT to also insert the display-snapshot row, atomically, right after
-- the notification_events row, is both the minimal change and the only
-- way to structurally guarantee "same transaction, every time" rather
-- than trusting 6 separate call sites to each remember to do it.
--
-- WHY THIS ONE FUNCTION IS DROP + CREATE, NOT CREATE OR REPLACE (the one
-- deliberate deviation from this project's own "signature unchanged"
-- convention, and only for this function): CREATE OR REPLACE FUNCTION
-- cannot add parameters to an existing function — Postgres identifies a
-- function by name PLUS its argument type list, so a call with a longer
-- argument list is a genuinely different overload, not a replacement of
-- the 4-arg original. Silently leaving the old 4-arg version in place
-- (dead, unreachable once every caller passes 8 args, but still present
-- in the schema forever) is exactly the kind of orphaned-cruft this
-- project's own reviews have caught and corrected elsewhere. This
-- function is private, has no public wrapper, and is called from exactly
-- the 6 functions updated later in this same file (confirmed by the
-- fresh audit above) — none of the "keep the signature stable, browser
-- code depends on it" reasoning that applies to create_appointment et al
-- applies here, so a clean drop + recreate is the correct, minimal fix.
--
-- =====================================================================
-- WHY appointment_id/customer_id ARE NOT STORED
-- =====================================================================
-- This phase's own instruction: "Prefer not to store customer_id or
-- appointment_id at all." event_id already links 1:1 back to
-- notification_events, which itself already carries appointment_id — a
-- future consumer that legitimately needs to correlate a display
-- snapshot to an appointment can join through notification_events, one
-- hop away, rather than this table duplicating a pointer it doesn't need
-- for its own single purpose (rendering push copy for one claimed
-- target). customer_id specifically is never captured because nothing
-- downstream of this table ever needs to re-resolve the customer —
-- customer_name is already the resolved, final display value.
--
-- =====================================================================
-- IMMUTABILITY — same mechanism as notification_events itself, not a
-- trigger
-- =====================================================================
-- RLS enabled, zero policies, zero grants to anon/authenticated, and —
-- unlike notification_deliveries/notification_delivery_targets, which
-- service_role legitimately reads/writes directly through their own
-- RPCs — zero grant to service_role either: every access to this table,
-- read or write, happens exclusively inside a SECURITY DEFINER function
-- body (enqueue_notification_event writes it; claim_notification_
-- delivery_targets, extended below, is the only reader). No UPDATE
-- statement against this table exists anywhere in this migration: insert
-- -only is enforced by "nothing has a grant to do anything else", the
-- same mechanism (not a trigger) notification_events' own comment
-- documents for itself.
--
-- =====================================================================
-- RETENTION — proposed, NOT implemented in this migration
-- =====================================================================
-- Freshly checked before deciding anything: grepped every migration for
-- pg_cron/retention/cleanup/purge — no bounded worker-cleanup or
-- scheduled-deletion pattern exists anywhere in this codebase today
-- (every "cleanup" hit is tests/helpers.ts's own fixture teardown, an
-- unrelated concern). Per this phase's own explicit instruction ("do not
-- implement an unrelated cron/cleanup subsystem blindly... otherwise
-- report the exact minimal cleanup design before implementing retention
-- deletion"), no deletion code is added here. Proposed V1 design for a
-- future, separately-reviewed phase (mirroring how NOTIF.2E.3's cron
-- trigger was reviewed separately from NOTIF.2E.2's worker core):
--
--   create function private.purge_expired_notification_display_snapshots(
--     p_batch_size integer default 500
--   ) returns integer language sql security definer set search_path = ''
--   as $purge$
--     with victims as (
--       select event_id from public.notification_event_display_snapshots
--       where created_at < now() - interval '30 days'
--       order by created_at
--       limit p_batch_size
--       for update skip locked
--     )
--     delete from public.notification_event_display_snapshots
--     where event_id in (select event_id from victims)
--     returning 1;
--   $purge$;
--
-- service_role-only (same posture as claim_notification_delivery_
-- targets), bounded + SKIP LOCKED (same batching discipline as claim_
-- notification_delivery_targets), and deliberately NOT wired to any
-- cron/schedule/route in this migration — activating it is its own
-- decision requiring its own review, exactly like NOTIF.2E.3 was split
-- from NOTIF.2E.2. created_at_idx below already supports this scan.
create table public.notification_event_display_snapshots (
  event_id uuid primary key references public.notification_events (id),
  tenant_id uuid not null references public.tenants (id),
  customer_name text,
  service_names text[] not null default '{}',
  appointment_start_at timestamptz,
  tenant_timezone text not null,
  created_at timestamptz not null default now(),

  -- Tenant-safe composite FK, matching notification_event_
  -- materializations' own established precedent exactly (both hang off
  -- notification_events_id_tenant_id_key, added 20260914130000).
  constraint notification_event_display_snapshots_event_same_tenant
    foreign key (event_id, tenant_id) references public.notification_events (id, tenant_id)
);

comment on table public.notification_event_display_snapshots is
  'Faz NOTIF.2F.1 — event-time display facts for rich push copy, deliberately separate from notification_events (which remains zero-PII). One row per notification_event, written in the SAME transaction as the event itself, inside private.enqueue_notification_event. Never updated after insert. Contains ONLY customer_name/service_names/appointment_start_at/tenant_timezone as they existed at that instant — never phone, email, notes, health data, endpoint, p256dh, auth key, customer id, or appointment id. A missing row (older events, or any event predating this migration) is a normal, valid, permanent state — never backfilled. See this migration''s own header for the full retention proposal (not yet implemented).';

comment on column public.notification_event_display_snapshots.customer_name is
  'Trimmed customers.full_name at event time, or NULL if genuinely unavailable. Never phone or email. A later rename of the same customer never changes this row.';

comment on column public.notification_event_display_snapshots.service_names is
  'Ordered by the appointment''s own stable appointment_items.sequence, not concatenated in SQL — application code formats the summary. Empty array, never NULL, when unavailable.';

comment on column public.notification_event_display_snapshots.appointment_start_at is
  'The single canonical appointment start to display: appointments.scheduled_start_at (already the MIN across items, kept in sync by every mutation path — confirmed by reading private.replace_appointment_items, not assumed) at event time for created/cancelled/staff_reassigned; the NEW start for rescheduled. NULL only if genuinely unavailable — the payload builder treats a NULL here as "no usable snapshot" and falls back to the fully generic copy.';

comment on column public.notification_event_display_snapshots.tenant_timezone is
  'tenants.timezone at event time, captured so a delayed delivery of an old queued event renders in the timezone that was authoritative when the event happened, never the tenant''s current/future timezone.';

create index notification_event_display_snapshots_tenant_id_idx
  on public.notification_event_display_snapshots (tenant_id);
-- Supports the proposed (not yet implemented) 30-day retention scan —
-- see this migration's own header.
create index notification_event_display_snapshots_created_at_idx
  on public.notification_event_display_snapshots (created_at);

alter table public.notification_event_display_snapshots enable row level security;
-- Zero policies, zero grants below (including to service_role — see this
-- migration's own header for why) — same double-lock as every other
-- notification_* infrastructure table.

-- =====================================================================
-- private.enqueue_notification_event — DROP + CREATE (see header above
-- for why this is the one exception to "CREATE OR REPLACE, signature
-- unchanged"). Body unchanged except for the new snapshot insert at the
-- end, guarded on p_tenant_timezone being supplied (the one NOT NULL
-- snapshot column with no sensible default) so the function stays
-- defensively correct even though all 6 real call sites always supply
-- it.
-- =====================================================================
drop function private.enqueue_notification_event(uuid, text, uuid, jsonb);

create function private.enqueue_notification_event(
  p_appointment_id uuid,
  p_event_type text,
  p_actor_user_id uuid,
  p_event_data jsonb default '{}'::jsonb,
  p_customer_name text default null,
  p_service_names text[] default null,
  p_appointment_start_at timestamptz default null,
  p_tenant_timezone text default null
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

  -- Faz NOTIF.2F.1 — same transaction, same function invocation, as the
  -- insert immediately above. p_tenant_timezone is the signal that a
  -- real caller supplied display data at all (every one of the 6 trusted
  -- callers below always does); a future caller that omits it simply
  -- gets no display snapshot row — the same valid "missing snapshot"
  -- state already required for every pre-2F.1 historical event.
  if p_tenant_timezone is not null then
    insert into public.notification_event_display_snapshots (
      event_id, tenant_id, customer_name, service_names, appointment_start_at, tenant_timezone
    )
    values (
      v_id, v_tenant_id, p_customer_name, coalesce(p_service_names, '{}'), p_appointment_start_at, p_tenant_timezone
    );
  end if;

  return v_id;
end;
$$;

comment on function private.enqueue_notification_event(uuid, text, uuid, jsonb, text, text[], timestamptz, text) is
  'Faz NOTIF.2B, extended Faz NOTIF.2F.1. Sole write path for both public.notification_events and public.notification_event_display_snapshots — both inserted in this one call, same transaction as the caller''s own appointment mutation. tenant_id is derived from the appointment row, never a caller-supplied parameter. No PUBLIC/authenticated/anon execute, no public.* wrapper — only the six trusted appointment-mutation functions below may call it.';

revoke execute on function private.enqueue_notification_event(uuid, text, uuid, jsonb, text, text[], timestamptz, text) from public;

-- =====================================================================
-- create_appointment (internal/staff) — signature UNCHANGED. Adds the
-- event-time display capture: customer name (from the already-validated
-- p_customer_id), service names (ordered by the just-inserted items'
-- own sequence), appointment start (v_min_start — the same value about
-- to be written to appointments.scheduled_start_at 3 lines above the
-- existing audit-log call), tenant timezone (freshly looked up — this
-- function never previously needed it).
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
  v_staff_ids jsonb;
  v_customer_name text;
  v_service_names text[];
  v_tenant_timezone text;
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

  -- Faz NOTIF.2E.1A — event-time booked-staff snapshot, sorted +
  -- deduplicated, from the items just inserted above in THIS SAME
  -- transaction — never re-read later, so it can never reflect a
  -- staff change that happens after this point.
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb)
  into v_staff_ids
  from (select distinct staff_member_id as id from public.appointment_items where appointment_id = v_appointment_id) t;

  -- Faz NOTIF.2F.1 — event-time display snapshot: customer name (already
  -- validated as belonging to this tenant above), service names ordered
  -- by the just-inserted items' own sequence, appointment start
  -- (v_min_start — the exact value just written to appointments.
  -- scheduled_start_at), tenant timezone at this instant.
  select full_name into v_customer_name from public.customers where id = p_customer_id;
  v_customer_name := nullif(btrim(coalesce(v_customer_name, '')), '');

  select coalesce(array_agg(s.name order by ai.sequence), '{}')
  into v_service_names
  from public.appointment_items ai
  join public.services s on s.id = ai.service_id
  where ai.appointment_id = v_appointment_id;

  select timezone into v_tenant_timezone from public.tenants where id = p_tenant_id;

  -- Faz NOTIF.2B — actor is the creating auth user, never suppressed
  -- merely because they are a salon user: a future delivery phase is
  -- what decides to exclude the actor from their own push recipients,
  -- not this insert.
  perform private.enqueue_notification_event(
    v_appointment_id, 'appointment.created', auth.uid(),
    jsonb_build_object('staffMemberIds', v_staff_ids),
    v_customer_name, v_service_names, v_min_start, v_tenant_timezone
  );

  return v_appointment_id;
end;
$$;

comment on function private.create_appointment(uuid, uuid, uuid, jsonb, text, text) is
  'Faz NOTIF.2E.1A + Faz NOTIF.2F.1 — appointment.created carries {"staffMemberIds": uuid[]} in event_data, plus a separate event-time display snapshot (customer name, ordered service names, appointment start, tenant timezone) in notification_event_display_snapshots. schema_version stays 1 — see the 2E.1A migration''s own header for why.';

-- =====================================================================
-- create_guest_booking (public/anonymous) — signature UNCHANGED. Every
-- display value needed is ALREADY in scope: v_full_name_trimmed (the
-- customer name), v_service.name (exactly one service on a guest
-- booking), v_item_result.scheduled_start_at (the resolved, persisted
-- start — matching the "trust the persisted row" discipline already
-- established in this function's own reschedule siblings), v_tenant.
-- timezone (selected by this function's very first query). No new
-- lookups required.
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

  -- Faz NOTIF.2E.1A — event-time booked-staff snapshot (the ONE
  -- intentional change from the 20260909100000 original above): a
  -- guest booking always resolves exactly one staff member
  -- (v_resolved_staff_id, guaranteed non-null past the BK005 check).
  --
  -- Faz NOTIF.2F.1 — event-time display snapshot, entirely from values
  -- already in scope: v_full_name_trimmed, array[v_service.name] (a
  -- guest booking always has exactly one service), v_item_result.
  -- scheduled_start_at (the resolved, persisted start — matching the
  -- "trust the persisted row" discipline used throughout this file),
  -- v_tenant.timezone.
  --
  -- Faz NOTIF.2B — actor_user_id NULL: this path is anonymous (or, for
  -- account-linked guest booking, still not an authenticated staff
  -- actor) — matches this function's own pre-existing created_by = null
  -- convention above, followed literally rather than substituting
  -- auth.uid() (which would also happen to be null under the
  -- booking_gateway role, but an explicit null is clearer and does not
  -- depend on that role's exact connection/JWT context).
  perform private.enqueue_notification_event(
    v_appointment_id, 'appointment.created', null,
    jsonb_build_object('staffMemberIds', jsonb_build_array(v_resolved_staff_id)),
    v_full_name_trimmed, array[v_service.name], v_item_result.scheduled_start_at, v_tenant.timezone
  );

  return private.public_booking_confirmation(v_appointment_id)
    || jsonb_build_object('claimIssued', v_claim_ref is not null, 'claimRef', v_claim_ref);
end;
$$;

comment on function private.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid, text) is
  'Faz NOTIF.2E.1A + Faz NOTIF.2F.1, consolidated. appointment.created carries {"staffMemberIds": [uuid]} in event_data, plus a display snapshot (customer name, single-element service names, resolved appointment start, tenant timezone) — every value already in scope, no new query added.';

-- =====================================================================
-- update_appointment_status (internal/staff) — signature UNCHANGED. The
-- cancelled branch now also captures customer_id/scheduled_start_at from
-- the row it already locks, then the display snapshot from those plus a
-- fresh customer/tenant lookup.
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
  v_staff_ids jsonb;
  v_customer_id uuid;
  v_scheduled_start_at timestamptz;
  v_customer_name text;
  v_service_names text[];
  v_tenant_timezone text;
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

  select tenant_id, status, customer_id, scheduled_start_at
  into v_tenant_id, v_old_status, v_customer_id, v_scheduled_start_at
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
    -- Faz NOTIF.2E.1A — event-time booked-staff snapshot, captured from
    -- appointment_items BEFORE this row could ever be reassigned again
    -- (a cancelled appointment cannot be rescheduled — AP014 above
    -- blocks any further status/item change on it), sorted + deduplicated.
    select coalesce(jsonb_agg(id order by id), '[]'::jsonb)
    into v_staff_ids
    from (select distinct staff_member_id as id from public.appointment_items where appointment_id = p_appointment_id) t;

    -- Faz NOTIF.2F.1 — event-time display snapshot: the services on the
    -- appointment at the moment of cancellation (this function never
    -- mutates appointment_items, so "current" IS "at cancellation"), the
    -- start that was cancelled (already captured above, pre-mutation —
    -- this function never changes scheduled_start_at either), customer
    -- name and tenant timezone freshly looked up.
    select full_name into v_customer_name from public.customers where id = v_customer_id;
    v_customer_name := nullif(btrim(coalesce(v_customer_name, '')), '');

    select coalesce(array_agg(s.name order by ai.sequence), '{}')
    into v_service_names
    from public.appointment_items ai
    join public.services s on s.id = ai.service_id
    where ai.appointment_id = p_appointment_id;

    select timezone into v_tenant_timezone from public.tenants where id = v_tenant_id;

    perform private.enqueue_notification_event(
      p_appointment_id, 'appointment.cancelled', auth.uid(),
      jsonb_build_object('staffMemberIds', v_staff_ids),
      v_customer_name, v_service_names, v_scheduled_start_at, v_tenant_timezone
    );
  end if;
end;
$$;

comment on function private.update_appointment_status(uuid, text) is
  'Faz NOTIF.2E.1A + Faz NOTIF.2F.1 — appointment.cancelled carries {"staffMemberIds": uuid[]} in event_data, plus a display snapshot of the customer/services/start as they stood at the moment of cancellation (this function never mutates appointment_items or scheduled_start_at, so "current" and "at cancellation" are the same state).';

-- =====================================================================
-- cancel_my_appointment (customer-facing) — signature UNCHANGED. Already
-- selects customer_id and scheduled_start_at into v_appointment — same
-- snapshot addition as update_appointment_status' own cancelled branch.
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
  v_staff_ids jsonb;
  v_customer_name text;
  v_service_names text[];
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

  select customer_cancellation_enabled, customer_cancellation_cutoff_minutes, timezone
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

  -- Faz NOTIF.2E.1A — same event-time snapshot as update_appointment_
  -- status' own cancelled branch.
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb)
  into v_staff_ids
  from (select distinct staff_member_id as id from public.appointment_items where appointment_id = p_appointment_id) t;

  -- Faz NOTIF.2F.1 — event-time display snapshot: v_appointment.
  -- customer_id/scheduled_start_at were already captured pre-mutation
  -- above; only customer_name needs a fresh lookup. v_tenant.timezone
  -- now comes from the broadened select just above (this function
  -- previously only needed the two cancellation-policy columns).
  select full_name into v_customer_name from public.customers where id = v_appointment.customer_id;
  v_customer_name := nullif(btrim(coalesce(v_customer_name, '')), '');

  select coalesce(array_agg(s.name order by ai.sequence), '{}')
  into v_service_names
  from public.appointment_items ai
  join public.services s on s.id = ai.service_id
  where ai.appointment_id = p_appointment_id;

  -- Faz NOTIF.2B — customer auth user IS the actor here even though they
  -- hold no tenant_membership; useful later for actor exclusion/audit
  -- semantics (Step 9's explicit instruction).
  perform private.enqueue_notification_event(
    p_appointment_id, 'appointment.cancelled', auth.uid(),
    jsonb_build_object('staffMemberIds', v_staff_ids),
    v_customer_name, v_service_names, v_appointment.scheduled_start_at, v_tenant.timezone
  );

  return jsonb_build_object('appointmentId', p_appointment_id, 'status', 'cancelled');
end;
$$;

comment on function private.cancel_my_appointment(uuid) is
  'Faz NOTIF.2E.1A + Faz NOTIF.2F.1 — appointment.cancelled carries {"staffMemberIds": uuid[]} in event_data, plus a display snapshot of the customer/services/start as they stood at the moment of cancellation.';

-- =====================================================================
-- reschedule_appointment (staff/internal) — signature UNCHANGED. Adds
-- customer_id to the initial locked-row select, then a display snapshot
-- shared by BOTH rescheduled and staff_reassigned when both fire in the
-- same call: customer name, service names and appointment start read
-- FRESH from appointment_items/appointments AFTER replace_appointment_
-- items runs (which itself already updates appointments.
-- scheduled_start_at — confirmed by reading that function, not assumed),
-- matching this function's own pre-existing "trust the persisted row"
-- discipline for v_notif_after below.
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
  v_customer_id uuid;
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
  v_customer_name text;
  v_service_names text[];
  v_new_appointment_start_at timestamptz;
  v_tenant_timezone text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AP001';
  end if;

  select tenant_id, branch_id, status, customer_id into v_tenant_id, v_branch_id, v_status, v_customer_id
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

  select coalesce(array_agg(v order by v), '{}') into v_new_staff_ids
  from (select unnest(v_after_staff_ids) except select unnest(v_before_staff_ids)) as t(v);

  select coalesce(array_agg(v order by v), '{}') into v_lost_staff_ids
  from (select unnest(v_before_staff_ids) except select unnest(v_after_staff_ids)) as t(v);

  v_time_changed := v_before_times <> v_after_times;
  v_staff_changed := array_length(v_new_staff_ids, 1) > 0 or array_length(v_lost_staff_ids, 1) > 0;

  -- Faz NOTIF.2F.1 — one shared display snapshot for whichever of the
  -- two events below actually fire: service names + appointment start
  -- read fresh from appointment_items/appointments AFTER replace_
  -- appointment_items (the NEW state, correct for both "rescheduled:
  -- NEW start" and "staff_reassigned: current start after reassignment"
  -- per this phase's own spec), customer name from the tenant-validated
  -- customer_id captured before the replace call, tenant timezone at
  -- this instant.
  if v_time_changed or v_staff_changed then
    select full_name into v_customer_name from public.customers where id = v_customer_id;
    v_customer_name := nullif(btrim(coalesce(v_customer_name, '')), '');

    select coalesce(array_agg(s.name order by ai.sequence), '{}')
    into v_service_names
    from public.appointment_items ai
    join public.services s on s.id = ai.service_id
    where ai.appointment_id = p_appointment_id;

    select scheduled_start_at into v_new_appointment_start_at
    from public.appointments where id = p_appointment_id;

    select timezone into v_tenant_timezone from public.tenants where id = v_tenant_id;
  end if;

  if v_time_changed then
    perform private.enqueue_notification_event(
      p_appointment_id, 'appointment.rescheduled', auth.uid(),
      jsonb_build_object('before', v_notif_before, 'after', v_notif_after),
      v_customer_name, v_service_names, v_new_appointment_start_at, v_tenant_timezone
    );
  end if;

  if v_staff_changed then
    perform private.enqueue_notification_event(
      p_appointment_id, 'appointment.staff_reassigned', auth.uid(),
      jsonb_build_object(
        'previousStaffMemberIds', to_jsonb(v_lost_staff_ids),
        'newStaffMemberIds', to_jsonb(v_new_staff_ids)
      ),
      v_customer_name, v_service_names, v_new_appointment_start_at, v_tenant_timezone
    );
  end if;
end;
$$;

comment on function private.reschedule_appointment(uuid, jsonb) is
  'Faz NOTIF.2B.1 + Faz NOTIF.2F.1 — emits appointment.rescheduled and/or appointment.staff_reassigned depending on what actually changed, each now also carrying a display snapshot (customer name, ordered service names, the NEW appointment start, tenant timezone) computed once and shared by both when both fire, read fresh from the table AFTER replace_appointment_items so it reflects the persisted NEW state, never the caller''s raw input.';

-- =====================================================================
-- reschedule_my_appointment (customer) — signature UNCHANGED. Already
-- has v_appointment.customer_id; broadens the existing v_tenant select
-- to also capture timezone. Staff can never change on this path (every
-- item shifts by the same delta — confirmed by this function's own
-- pre-existing body, unchanged here), so only appointment.rescheduled is
-- ever emitted, matching its existing no-op guard.
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
  v_customer_name text;
  v_service_names text[];
  v_new_appointment_start_at timestamptz;
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

  select customer_reschedule_enabled, customer_reschedule_cutoff_minutes, timezone
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

    -- Faz NOTIF.2F.1 — display snapshot: customer name from the
    -- already-owned customer_id, service names + appointment start read
    -- fresh from the table AFTER replace_appointment_items (services
    -- never change on this path, but reading fresh matches the same
    -- "trust the persisted row" discipline as v_notif_after above),
    -- tenant timezone from the broadened v_tenant select.
    select full_name into v_customer_name from public.customers where id = v_appointment.customer_id;
    v_customer_name := nullif(btrim(coalesce(v_customer_name, '')), '');

    select coalesce(array_agg(s.name order by ai.sequence), '{}')
    into v_service_names
    from public.appointment_items ai
    join public.services s on s.id = ai.service_id
    where ai.appointment_id = p_appointment_id;

    select scheduled_start_at into v_new_appointment_start_at
    from public.appointments where id = p_appointment_id;

    perform private.enqueue_notification_event(
      p_appointment_id, 'appointment.rescheduled', auth.uid(),
      jsonb_build_object('before', v_notif_before, 'after', v_notif_after),
      v_customer_name, v_service_names, v_new_appointment_start_at, v_tenant.timezone
    );
  end if;

  return jsonb_build_object('appointmentId', p_appointment_id, 'scheduledStartAt', p_new_start_at);
end;
$$;

comment on function private.reschedule_my_appointment(uuid, timestamptz) is
  'Faz NOTIF.2B.1 + Faz NOTIF.2F.1 — emits appointment.rescheduled only when the time actually changes (guarded, matching the pre-existing no-op check), now also carrying a display snapshot (customer name, ordered service names, the NEW appointment start, tenant timezone) read fresh from the table after replace_appointment_items.';

-- =====================================================================
-- claim_notification_delivery_targets — signature and return TYPE
-- UNCHANGED (still returns jsonb; only the shape of what's inside each
-- array element gains 4 new nullable keys). Built on the CURRENT,
-- NOTIF.2E.2A-hardened body (20260915080000 — freshly re-read for this
-- migration, not assumed from the earlier 2E.2 original): every one of
-- its three eligibility checks (recipient_no_longer_eligible,
-- event_predates_activation, subscription_inactive) is preserved
-- byte-for-byte. LEFT JOINs the new snapshot table by event id; a target
-- for an event with no snapshot row (any pre-2F.1 historical event)
-- simply gets four nulls, which the Node payload builder treats as
-- "fall back to the generic copy" — no new eligibility/retry/lease
-- logic, no live join to customers/services/appointments (the whole
-- point of the snapshot table).
-- =====================================================================
create or replace function private.claim_notification_delivery_targets(
  p_batch_size integer default 25,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activated_at timestamptz;
  v_row record;
  v_is_eligible boolean;
  v_ineligible_code text;
  v_ineligible_message text;
  v_event_type text;
  v_event_created_at timestamptz;
  v_tenant_slug text;
  v_subscription_revoked boolean;
  v_endpoint text;
  v_p256dh text;
  v_auth_key text;
  v_customer_name text;
  v_service_names text[];
  v_appointment_start_at timestamptz;
  v_tenant_timezone text;
  v_result jsonb := '[]'::jsonb;
begin
  select activated_at into v_activated_at from public.notification_delivery_activation where id = 1;

  if v_activated_at is null then
    return '[]'::jsonb;
  end if;

  if p_batch_size is null or p_batch_size <= 0 or p_batch_size > 200 then
    raise exception 'p_batch_size must be between 1 and 200' using errcode = 'WK001';
  end if;
  if p_lease_seconds is null or p_lease_seconds <= 0 or p_lease_seconds > 3600 then
    raise exception 'p_lease_seconds must be between 1 and 3600' using errcode = 'WK001';
  end if;

  for v_row in
    with candidates as (
      select t.id
      from public.notification_delivery_targets t
      where t.status in ('pending', 'retry')
        and t.next_attempt_at <= now()
        and (t.locked_at is null or t.locked_at <= now() - (p_lease_seconds || ' seconds')::interval)
      order by t.next_attempt_at
      limit p_batch_size
      for update skip locked
    )
    update public.notification_delivery_targets t
    set status = 'processing',
        locked_at = now(),
        lock_token = gen_random_uuid()
    from candidates c
    where t.id = c.id
    returning t.id as target_id, t.lock_token, t.tenant_id, t.notification_delivery_id,
              t.tenant_membership_id, t.push_subscription_id, t.attempt_count
  loop
    v_ineligible_code := null;
    v_ineligible_message := null;

    -- Step 7 (Faz NOTIF.2E.2) — recipient eligibility, re-checked against
    -- CURRENT state; also carries the event's own created_at (Faz
    -- NOTIF.2E.2A). Faz NOTIF.2F.1 adds only the LEFT JOIN to the display
    -- snapshot table and its 4 columns — every eligibility predicate
    -- below is unchanged from 2E.2A.
    select ne.event_type, ne.created_at, tn.slug,
      tm.status = 'active'
      and tm.deleted_at is null
      and tm.tenant_id = v_row.tenant_id
      and exists (
        select 1 from public.role_permissions rp
        join public.permissions perm on perm.id = rp.permission_id
        where rp.role_id = tm.role_id and perm.key = 'appointments.view'
      )
      and coalesce(
        case ne.event_type
          when 'appointment.created' then np.new_appointment
          when 'appointment.cancelled' then np.cancellation
          when 'appointment.rescheduled' then np.reschedule
          when 'appointment.staff_reassigned' then np.assignment_change
        end,
        true
      ),
      s.customer_name, s.service_names, s.appointment_start_at, s.tenant_timezone
    into v_event_type, v_event_created_at, v_tenant_slug, v_is_eligible,
      v_customer_name, v_service_names, v_appointment_start_at, v_tenant_timezone
    from public.tenant_memberships tm
    join public.notification_deliveries nd on nd.id = v_row.notification_delivery_id
    join public.notification_events ne on ne.id = nd.notification_event_id
    join public.tenants tn on tn.id = v_row.tenant_id
    left join public.notification_preferences np on np.tenant_membership_id = tm.id
    left join public.notification_event_display_snapshots s on s.event_id = ne.id
    where tm.id = v_row.tenant_membership_id;

    -- Faz NOTIF.2E.2A Bug 2's fix — the exact subscription's OWN current
    -- revoked_at, re-read now, not trusted from prepare time.
    select ps.revoked_at is not null, ps.endpoint, ps.p256dh, ps.auth_key
    into v_subscription_revoked, v_endpoint, v_p256dh, v_auth_key
    from public.push_subscriptions ps
    where ps.id = v_row.push_subscription_id;

    if not coalesce(v_is_eligible, false) then
      v_ineligible_code := 'recipient_no_longer_eligible';
      v_ineligible_message := 'recipient no longer eligible at send time';
    elsif v_event_created_at < v_activated_at then
      v_ineligible_code := 'event_predates_activation';
      v_ineligible_message := 'underlying event predates the activation watermark';
    elsif coalesce(v_subscription_revoked, true) then
      -- coalesce(...,true): a subscription row that no longer exists at
      -- all (structurally near-impossible given the composite FK, but
      -- never assumed) is treated the same as revoked, never as
      -- eligible — fail closed, not fail open.
      v_ineligible_code := 'subscription_inactive';
      v_ineligible_message := 'push subscription is no longer active';
    end if;

    if v_ineligible_code is not null then
      update public.notification_delivery_targets
      set status = 'skipped',
          locked_at = null,
          lock_token = null,
          last_error_code = v_ineligible_code,
          last_error_message = v_ineligible_message
      where id = v_row.target_id;

      perform private.finalize_notification_delivery_status(v_row.notification_delivery_id);
      continue;
    end if;

    -- Only reached once eligibility + activation + subscription are all
    -- confirmed current — endpoint/p256dh/authKey (and, Faz NOTIF.2F.1,
    -- the display fields) are never placed into the returned jsonb for a
    -- target that failed any check above.
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'targetId', v_row.target_id,
      'lockToken', v_row.lock_token,
      'tenantId', v_row.tenant_id,
      'tenantSlug', v_tenant_slug,
      'notificationDeliveryId', v_row.notification_delivery_id,
      'pushSubscriptionId', v_row.push_subscription_id,
      'attemptCount', v_row.attempt_count,
      'eventType', v_event_type,
      'endpoint', v_endpoint,
      'p256dh', v_p256dh,
      'authKey', v_auth_key,
      'customerName', v_customer_name,
      'serviceNames', v_service_names,
      'appointmentStartAt', v_appointment_start_at,
      'tenantTimezone', v_tenant_timezone
    ));
  end loop;

  return v_result;
end;
$$;

comment on function private.claim_notification_delivery_targets(integer, integer) is
  'Faz NOTIF.2E.2, hardened in NOTIF.2E.2A, extended Faz NOTIF.2F.1. Fails closed (returns []) when activation is absent. Claims via FOR UPDATE SKIP LOCKED + an expiring lease + a fencing lock_token. Before returning a claimed target as sendable, re-checks three independent, current-state conditions in one pass: (1) recipient still active/same-tenant/appointments.view/preference-enabled, (2) the underlying event''s created_at still >= the activation watermark, (3) the exact push_subscription''s own current revoked_at IS NULL. Any failure marks the target ''skipped'' with a distinct diagnostic code, re-finalizes the parent delivery, and never places endpoint/p256dh/authKey OR the display fields into the result. Once all three checks pass, also returns customerName/serviceNames/appointmentStartAt/tenantTimezone from notification_event_display_snapshots — all 4 nullable, null for any event with no snapshot row. Never performs a live join to customers/services/appointments: the snapshot table is the only source for these fields, by design.';

revoke execute on function private.claim_notification_delivery_targets(integer, integer) from public;
