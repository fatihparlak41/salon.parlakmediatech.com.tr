-- Faz NOTIF.2E.1A — historical recipient correctness + materialization
-- completion state. Corrective, forward-only — 20260914130000 is NOT
-- edited; every function below is a CREATE OR REPLACE with an UNCHANGED
-- signature, matching this project's own established precedent
-- (20260909110000's own header says the same thing about 20260909100000).
--
-- =====================================================================
-- THE BUG, REPRODUCED ON DEV BEFORE WRITING ANY FIX (not assumed)
-- =====================================================================
-- 1. Appointment created, assigned to Staff A -> appointment.created
--    event enqueued (event_data = {}, the only shape that existed
--    before this migration).
-- 2. BEFORE that event is ever materialized, the appointment is
--    reassigned to Staff B via the real reschedule_appointment RPC
--    (staff-only change -- emits its own, separate
--    appointment.staff_reassigned event, untouched by this bug).
-- 3. The ORIGINAL appointment.created event is materialized.
--
-- 20260914130000's materializer resolves "assigned staff" for created/
-- cancelled from LIVE public.appointment_items state, because event_data
-- was empty and there was nothing else to read. Reproduced live: step 3
-- incorrectly produced a delivery for Staff B's membership and NONE for
-- Staff A -- the person actually assigned when the appointment was
-- created never got notified, and someone who had nothing to do with
-- that creation did. Confirmed via a real DEV fixture (owner-signed-in
-- create_appointment -> reschedule_appointment staff swap ->
-- materialize_notification_deliveries), not inferred from reading the
-- code alone.
--
-- =====================================================================
-- THE FIX -- event-time snapshots, additive, schema_version UNCHANGED
-- =====================================================================
-- appointment.created and appointment.cancelled now carry
-- {"staffMemberIds": uuid[]} -- sorted ascending by uuid value (same
-- determinism discipline 20260909110000 already established for
-- staff_reassigned's own arrays), deduplicated, captured inside the
-- SAME transaction that creates the notification_events row, from
-- whichever staff were actually booked at that instant. No customer
-- PII, no new column on notification_events itself (this lives entirely
-- inside the existing jsonb event_data column), no service-role/browser
-- grant change of any kind -- these are the same four already-SECURITY-
-- DEFINER, already-sole-write-path functions notification_events has
-- always gone through.
--
-- WHY schema_version stays 1, not bumped to 2 (freshly decided, not
-- mechanical): schema_version's own documented purpose (20260909110000's
-- column comment) is for when a payload change is NOT safely
-- distinguishable from event_data's own shape -- exactly the trap the
-- original two-incompatible-reschedule-shapes bug fell into, which is
-- why that migration introduced the column at all. This change is the
-- opposite case: {} and {"staffMemberIds": [...]} are trivially and
-- UNAMBIGUOUSLY distinguishable by a single presence/type check
-- (jsonb_typeof(event_data->'staffMemberIds') = 'array'), the new shape
-- is a strict superset of the old one (nothing old is removed or
-- reinterpreted), and gating on schema_version would not remove the
-- need for that same presence check anyway -- old schema_version=1 rows
-- still need the live-state fallback regardless. Bumping the version
-- here would apply the tool to a problem it does not have.
--
-- =====================================================================
-- BACKWARD COMPATIBILITY -- legacy rows are NEVER rewritten
-- =====================================================================
-- Every existing notification_events row (PROD's live gokhanilhan
-- tenant included) keeps its exact current event_data forever -- this
-- migration touches zero existing rows, only the function bodies that
-- emit FUTURE ones. The materializer (rewritten below) checks for the
-- new key and falls back to the exact 20260914130000 live-state
-- behavior when it is absent -- a legacy created/cancelled event
-- materializes exactly as it did before this migration.
--
-- =====================================================================
-- MATERIALIZATION COMPLETION STATE -- why a separate table, not a
-- column on notification_events
-- =====================================================================
-- notification_events is insert-only by design (its own table comment:
-- "no UPDATE/DELETE grant to any role, no update trigger, by design").
-- A zero-recipient event still needs a durable "this was already
-- handled" marker so a future worker never retries it forever -- that
-- is inherently a fact recorded AFTER the event exists, which would
-- require an UPDATE on notification_events itself if stored there,
-- violating the one invariant that table exists to guarantee. A
-- separate table, keyed 1:1 on notification_event_id as its own PRIMARY
-- KEY (not a surrogate id + a separate UNIQUE constraint), both
-- expresses "at most one marker per event" as a structural fact and
-- needs no extra uniqueness machinery.
--
-- =====================================================================
-- FAZ NOTIF.2E.1B — CONSOLIDATED INTO A SINGLE RELEASE-SAFE MIGRATION
-- =====================================================================
-- This file originally shipped with a broken private.create_guest_
-- booking (reconstructed from a truncated live dump instead of the real
-- source, referencing a table — public.booking_idempotency_keys — that
-- never existed) and a NULL-logic bug in the materializer's legacy-
-- fallback branch. Both were caught on DEV and corrected by two
-- follow-up forward-only migrations: 20260914150000 (materializer NULL-
-- logic fix) and 20260914160000 (create_guest_booking restored to its
-- true 20260909100000 body). DEV's migration history table has already
-- recorded all three (140000-original, 150000, 160000) as applied, and
-- that history is NOT rewritten by this change.
--
-- Neither 140000, 150000, nor 160000 had reached PROD when this
-- consolidation was made. That made this the last point where the
-- MIGRATION PATH itself — not just the final schema — could still be
-- fixed: a fresh replay of the original three-file sequence installs a
-- genuinely broken create_guest_booking for the two migrations between
-- 140000 and 160000, even though the end state after 160000 is correct.
-- A new environment (a from-scratch PROD release, a disposable test
-- database, a future teammate's local stack) that only ever replays
-- migrations — never DEV's own patched-in-place history — must never
-- pass through that broken intermediate state.
--
-- This file is therefore retroactively rewritten (an explicit, reviewed
-- exception to this project's normal forward-only rule, made only
-- because PROD had received none of it yet) to install the CORRECT
-- create_guest_booking body and the CORRECT (coalesce-guarded)
-- materializer directly, in one step. 20260914150000 and 20260914160000
-- are left in place, unedited — replaying them after this corrected
-- 140000 re-issues `create or replace function`: 160000's body is now
-- byte-identical to what this migration just installed; 150000's
-- executable SQL is identical too (only its comment text still narrates
-- itself as a standalone correction) — either way Postgres re-storing
-- an equivalent function body is a harmless no-op (same OID, same
-- behavior, no data touched), confirmed by replaying this exact
-- sequence against a disposable database and re-running the same
-- contract tests before and after with identical results. See that
-- pair's own files for the original bug reports; see this phase's final
-- report for the old/new SHA-256 of this file and why DEV's applied
-- history is left exactly as it is.

create table public.notification_event_materializations (
  notification_event_id uuid primary key,
  tenant_id uuid not null,
  materialized_at timestamptz not null default now(),
  recipient_count integer not null check (recipient_count >= 0),

  constraint notification_event_materializations_tenant_id_fkey
    foreign key (tenant_id) references public.tenants (id),

  -- Plain + composite, matching every other tenant-safe FK in this
  -- project (staff_members_membership_same_tenant, notification_
  -- deliveries_event_same_tenant, ...).
  constraint notification_event_materializations_event_id_fkey
    foreign key (notification_event_id) references public.notification_events (id),
  constraint notification_event_materializations_event_same_tenant
    foreign key (notification_event_id, tenant_id) references public.notification_events (id, tenant_id)
);

comment on table public.notification_event_materializations is
  'Faz NOTIF.2E.1A — durable "this event has already been materialized" marker, one row per event, keyed by notification_event_id itself as the primary key. Exists so a future worker never re-processes a zero-recipient event forever, and so notification_events itself never needs an UPDATE to record this fact. Infrastructure data: RLS enabled with zero policies, zero grants to anon/authenticated — same posture as notification_deliveries. Never stores endpoint/p256dh/auth_key or any other subscription material, and never any customer PII.';

alter table public.notification_event_materializations enable row level security;
-- No policy — RLS enabled with zero policies denies every command to
-- every role except the table owner, and there is no grant below for
-- authenticated/anon to even attempt one. Same double-lock as
-- notification_deliveries/push_subscriptions/notification_events.

-- =====================================================================
-- create_appointment — signature UNCHANGED. Only change: captures the
-- just-inserted items' distinct staff_member_id set, sorted ascending,
-- into appointment.created's event_data.
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

  -- Faz NOTIF.2B — actor is the creating auth user, never suppressed
  -- merely because they are a salon user: a future delivery phase is
  -- what decides to exclude the actor from their own push recipients,
  -- not this insert.
  perform private.enqueue_notification_event(
    v_appointment_id, 'appointment.created', auth.uid(),
    jsonb_build_object('staffMemberIds', v_staff_ids)
  );

  return v_appointment_id;
end;
$$;

comment on function private.create_appointment(uuid, uuid, uuid, jsonb, text, text) is
  'Faz NOTIF.2E.1A — appointment.created now carries {"staffMemberIds": uuid[]} (sorted, deduplicated), the event-time booked-staff snapshot, so a delivery materialized after a later staff reassignment still resolves the staff who were ACTUALLY assigned at creation, never whoever is currently assigned. schema_version stays 1 — see this migration''s own header for why.';

-- =====================================================================
-- create_guest_booking — signature UNCHANGED. Body is 20260909100000's
-- exact, verified-correct implementation (idempotency fingerprinting,
-- tenant status/online_booking feature gate, past-slot check, phone/
-- email validation, customer-account-link advisory-lock race handling,
-- AP0xx->BK0xx error mapping, all intact) — re-derived directly from
-- that migration file for THIS consolidation, not carried over from
-- this file's own first draft. See this migration's own NOTIF.2E.1B
-- header section above for why a from-scratch read was necessary again.
-- Only intentional change from the 20260909100000 original: the final
-- appointment.created event now carries
-- {"staffMemberIds": [v_resolved_staff_id]} instead of {} — the single-
-- element event-time booked-staff snapshot (a guest booking always
-- resolves exactly one staff member, guaranteed non-null past the BK005
-- check below).
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
  -- Faz NOTIF.2B — actor_user_id NULL: this path is anonymous (or, for
  -- account-linked guest booking, still not an authenticated staff
  -- actor) — matches this function's own pre-existing created_by = null
  -- convention above, followed literally rather than substituting
  -- auth.uid() (which would also happen to be null under the
  -- booking_gateway role, but an explicit null is clearer and does not
  -- depend on that role's exact connection/JWT context).
  perform private.enqueue_notification_event(
    v_appointment_id, 'appointment.created', null,
    jsonb_build_object('staffMemberIds', jsonb_build_array(v_resolved_staff_id))
  );

  return private.public_booking_confirmation(v_appointment_id)
    || jsonb_build_object('claimIssued', v_claim_ref is not null, 'claimRef', v_claim_ref);
end;
$$;

comment on function private.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid, text) is
  'Faz NOTIF.2E.1A, consolidated release-safe form (Faz NOTIF.2E.1B) — the exact 20260909100000 body (idempotency fingerprinting, tenant status/feature gate, phone/email validation, customer-account-link race handling, AP0xx->BK0xx error mapping all intact), with only appointment.created''s event_data changed to {"staffMemberIds": [uuid]} — the event-time booked-staff snapshot, single element since a guest booking always resolves exactly one staff member.';

-- =====================================================================
-- update_appointment_status — signature UNCHANGED. Only change: the
-- cancelled branch now snapshots the CURRENT appointment_items staff
-- set (this function never mutates appointment_items itself, so "the
-- current set" IS "the set at the moment of cancellation").
-- =====================================================================
create or replace function private.update_appointment_status(p_appointment_id uuid, p_new_status text)
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
    -- Faz NOTIF.2E.1A — event-time booked-staff snapshot, captured from
    -- appointment_items BEFORE this row could ever be reassigned again
    -- (a cancelled appointment cannot be rescheduled — AP014 above
    -- blocks any further status/item change on it), sorted + deduplicated.
    select coalesce(jsonb_agg(id order by id), '[]'::jsonb)
    into v_staff_ids
    from (select distinct staff_member_id as id from public.appointment_items where appointment_id = p_appointment_id) t;

    perform private.enqueue_notification_event(
      p_appointment_id, 'appointment.cancelled', auth.uid(),
      jsonb_build_object('staffMemberIds', v_staff_ids)
    );
  end if;
end;
$$;

comment on function private.update_appointment_status(uuid, text) is
  'Faz NOTIF.2E.1A — appointment.cancelled now carries {"staffMemberIds": uuid[]} (sorted, deduplicated), the event-time booked-staff snapshot. schema_version stays 1 — see the create_appointment migration header for why.';

-- =====================================================================
-- cancel_my_appointment (customer-facing) — signature UNCHANGED. Same
-- snapshot addition as update_appointment_status''s cancelled branch.
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

  -- Faz NOTIF.2E.1A — same event-time snapshot as update_appointment_
  -- status' own cancelled branch.
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb)
  into v_staff_ids
  from (select distinct staff_member_id as id from public.appointment_items where appointment_id = p_appointment_id) t;

  -- Faz NOTIF.2B — customer auth user IS the actor here even though they
  -- hold no tenant_membership; useful later for actor exclusion/audit
  -- semantics (Step 9's explicit instruction).
  perform private.enqueue_notification_event(
    p_appointment_id, 'appointment.cancelled', auth.uid(),
    jsonb_build_object('staffMemberIds', v_staff_ids)
  );

  return jsonb_build_object('appointmentId', p_appointment_id, 'status', 'cancelled');
end;
$$;

comment on function private.cancel_my_appointment(uuid) is
  'Faz NOTIF.2E.1A — appointment.cancelled now carries {"staffMemberIds": uuid[]} (sorted, deduplicated), the event-time booked-staff snapshot. Same reasoning as update_appointment_status''s own comment.';

-- =====================================================================
-- materialize_notification_deliveries — signature UNCHANGED
-- (p_event_id uuid). Consolidated release-safe body (Faz NOTIF.2E.1B):
--   1. short-circuits on an existing completion marker (idempotent
--      no-op for a repeat call, including one made against an event
--      that already has deliveries but never got a marker — see this
--      migration's own header on why that backfills cleanly rather
--      than duplicating).
--   2. resolves created/cancelled staff from the event's own
--      staffMemberIds snapshot when present; falls back to the exact
--      20260914130000 live-appointment_items behavior only when it is
--      absent (a legacy row) — via coalesce(..., false), never a bare
--      boolean expression that could evaluate to SQL NULL for a
--      {}-shaped legacy row (jsonb_typeof(NULL) = 'array' is NULL, not
--      false — the bug this coalesce specifically guards against).
--   3. atomically inserts missing deliveries AND records the
--      completion marker in the same function invocation (one
--      Postgres function body is already one transaction — no
--      explicit BEGIN/COMMIT needed or possible here).
-- =====================================================================
create or replace function private.materialize_notification_deliveries(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event record;
  v_preference_column text;
  v_created_count integer := 0;
  v_recipient_count integer := 0;
  v_after jsonb;
  v_reassigned_ids jsonb;
  v_created_cancelled_snapshot jsonb;
  v_use_snapshot_for_created_cancelled boolean;
  v_already_materialized boolean;
begin
  select id, tenant_id, appointment_id, event_type, actor_user_id, event_data, schema_version
  into v_event
  from public.notification_events
  where id = p_event_id;

  if v_event.id is null then
    return jsonb_build_object('created', 0, 'alreadyMaterialized', false, 'reason', 'event_not_found');
  end if;

  if v_event.event_type not in (
       'appointment.created', 'appointment.cancelled',
       'appointment.rescheduled', 'appointment.staff_reassigned'
     )
     or v_event.schema_version <> 1
  then
    return jsonb_build_object('created', 0, 'alreadyMaterialized', false, 'reason', 'unsupported_event_type_or_schema_version');
  end if;

  select exists(
    select 1 from public.notification_event_materializations where notification_event_id = p_event_id
  ) into v_already_materialized;

  if v_already_materialized then
    select count(*) into v_recipient_count
    from public.notification_deliveries
    where notification_event_id = p_event_id;

    return jsonb_build_object(
      'created', 0, 'alreadyMaterialized', true,
      'recipientCount', v_recipient_count, 'eventType', v_event.event_type
    );
  end if;

  v_preference_column := case v_event.event_type
    when 'appointment.created' then 'new_appointment'
    when 'appointment.cancelled' then 'cancellation'
    when 'appointment.rescheduled' then 'reschedule'
    when 'appointment.staff_reassigned' then 'assignment_change'
  end;

  v_after := case when jsonb_typeof(v_event.event_data->'after') = 'array'
                  then v_event.event_data->'after' else '[]'::jsonb end;
  v_reassigned_ids :=
    (case when jsonb_typeof(v_event.event_data->'previousStaffMemberIds') = 'array'
          then v_event.event_data->'previousStaffMemberIds' else '[]'::jsonb end)
    ||
    (case when jsonb_typeof(v_event.event_data->'newStaffMemberIds') = 'array'
          then v_event.event_data->'newStaffMemberIds' else '[]'::jsonb end);

  -- Faz NOTIF.2E.1A — created/cancelled: prefer the event-time
  -- staffMemberIds snapshot when the event carries one (every event
  -- emitted from this migration onward); fall back to LIVE
  -- appointment_items state ONLY as compatibility behavior for a
  -- legacy row whose event_data is still the pre-2E.1A {} — see this
  -- migration's own header for why that fallback, not a backfill, is
  -- the right compatibility behavior (never rewriting historical rows).
  --
  -- coalesce(..., false): jsonb_typeof(NULL) = 'array' is NULL, not
  -- false, for a genuinely legacy {} row (the key does not exist at
  -- all) — without this guard, EVERY WHERE clause below that tests
  -- either this variable or its negation evaluates to NULL for that
  -- row, silently excluding legacy events from BOTH the snapshot and
  -- the live-state branch at once.
  v_use_snapshot_for_created_cancelled :=
    coalesce(jsonb_typeof(v_event.event_data->'staffMemberIds') = 'array', false);
  v_created_cancelled_snapshot := case when v_use_snapshot_for_created_cancelled
    then v_event.event_data->'staffMemberIds' else '[]'::jsonb end;

  with candidate_memberships as (
    select tm.id as tenant_membership_id
    from public.tenant_memberships tm
    join public.role_permissions rp on rp.role_id = tm.role_id
    join public.permissions perm on perm.id = rp.permission_id
    where tm.tenant_id = v_event.tenant_id
      and perm.key = 'appointments.create'

    union

    -- created/cancelled, NEW-format events: the event's own snapshot.
    select sm.tenant_membership_id
    from jsonb_array_elements_text(v_created_cancelled_snapshot) as staff_id
    join public.staff_members sm
      on sm.id = staff_id::uuid and sm.tenant_id = v_event.tenant_id
    where v_event.event_type in ('appointment.created', 'appointment.cancelled')
      and v_use_snapshot_for_created_cancelled
      and sm.tenant_membership_id is not null

    union

    -- created/cancelled, LEGACY events only (event_data = {}): live
    -- appointment_items state, exactly 20260914130000's own behavior.
    select sm.tenant_membership_id
    from public.appointment_items ai
    join public.staff_members sm
      on sm.id = ai.staff_member_id and sm.tenant_id = v_event.tenant_id
    where v_event.event_type in ('appointment.created', 'appointment.cancelled')
      and not v_use_snapshot_for_created_cancelled
      and ai.appointment_id = v_event.appointment_id
      and ai.tenant_id = v_event.tenant_id
      and sm.tenant_membership_id is not null

    union

    select sm.tenant_membership_id
    from jsonb_array_elements(v_after) as item
    join public.staff_members sm
      on sm.id = (item->>'staffMemberId')::uuid and sm.tenant_id = v_event.tenant_id
    where v_event.event_type = 'appointment.rescheduled'
      and sm.tenant_membership_id is not null

    union

    select sm.tenant_membership_id
    from jsonb_array_elements_text(v_reassigned_ids) as staff_id
    join public.staff_members sm
      on sm.id = staff_id::uuid and sm.tenant_id = v_event.tenant_id
    where v_event.event_type = 'appointment.staff_reassigned'
      and sm.tenant_membership_id is not null
  ),
  eligible_memberships as (
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
      and (v_event.actor_user_id is null or tm.user_id <> v_event.actor_user_id)
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

  select count(*) into v_recipient_count
  from public.notification_deliveries
  where notification_event_id = p_event_id;

  insert into public.notification_event_materializations (notification_event_id, tenant_id, recipient_count)
  values (p_event_id, v_event.tenant_id, v_recipient_count)
  on conflict (notification_event_id) do nothing;

  return jsonb_build_object(
    'created', v_created_count, 'alreadyMaterialized', false,
    'recipientCount', v_recipient_count, 'eventType', v_event.event_type
  );
end;
$$;

comment on function private.materialize_notification_deliveries(uuid) is
  'Faz NOTIF.2E.1A, consolidated release-safe form (Faz NOTIF.2E.1B). Idempotent via notification_event_materializations (checked first, short-circuits a repeat call) AND the pre-existing notification_deliveries dedup key (belt and suspenders). created/cancelled resolve staff from the event''s own staffMemberIds snapshot when present, falling back to live appointment_items only for a legacy pre-2E.1A row — that fallback branch is reached via coalesce(..., false), never a bare boolean expression that could evaluate to SQL NULL for a {}-shaped legacy row. A zero-eligible-recipient event still gets a completion marker (recipient_count = 0) so a future worker never retries it forever.';
