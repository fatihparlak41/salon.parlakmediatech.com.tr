-- Faz NOTIF.2E.1A (correction #2) — 20260914140000 is NOT edited; this
-- is a forward-only fix.
--
-- =====================================================================
-- A SERIOUS BUG, CAUGHT BY THE EXISTING notification-outbox.test.ts
-- SUITE, NOT BY INSPECTION
-- =====================================================================
-- 20260914140000's own replacement of private.create_guest_booking was
-- written from an incomplete basis: only this function's tail (~40
-- lines, via a truncated live pg_get_functiondef dump) was actually
-- read before that migration reconstructed the rest of the body from
-- general inference about what a typical booking flow looks like. That
-- reconstruction was wrong in multiple, serious ways compared to the
-- real function last correctly defined in 20260909100000 (the latest
-- migration that actually touched it before 20260914140000):
--
--   - It referenced a table, public.booking_idempotency_keys, that has
--     never existed in this schema — the real idempotency mechanism is
--     the idempotency_key/idempotency_fingerprint columns directly on
--     public.appointments (added 20260822150000/20260822160000).
--   - It dropped the tenant status/online_booking-feature-flag check
--     (t.status in ('trial','active') and private.has_feature(t.id,
--     'online_booking')) entirely.
--   - It dropped the "slot already in the past" check
--     (p_scheduled_start_at < now()).
--   - It dropped all phone/email normalization and validation, the
--     booking fingerprint computation, the customer-account-link
--     advisory-lock/race-handling logic, and the staff-resolution
--     loop's specific AP0xx-errcode-to-BK0xx-errcode mapping — replacing
--     all of it with a much simpler, materially different flow.
--
-- This was caught live on DEV by tests/notification-outbox.test.ts's
-- own pre-existing "guest booking" test failing with "relation
-- public.booking_idempotency_keys does not exist" — a real regression
-- against a real regression suite, not a defect found by re-reading the
-- code after the fact. It was never applied to PROD (this whole phase
-- is DEV-only, uncommitted, pending review) and gokhanilhan's real
-- public booking flow was never affected in production.
--
-- =====================================================================
-- THE FIX
-- =====================================================================
-- private.create_guest_booking is restored to 20260909100000's exact,
-- correct, complete body (verified by reading that migration file in
-- full, not a live tail-only dump), with ONLY the one intended NOTIF.
-- 2E.1A change applied on top: appointment.created's event_data becomes
-- {"staffMemberIds": [v_resolved_staff_id]} instead of {} — the single
-- line this whole correction was ever supposed to touch. Every other
-- line is byte-for-byte the 20260909100000 original.

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
  'Faz NOTIF.2E.1A, corrected in this migration — restored to the exact 20260909100000 body (idempotency fingerprinting, tenant status/feature gate, phone/email validation, customer-account-link race handling, AP0xx->BK0xx error mapping all intact), with only appointment.created''s event_data changed to {"staffMemberIds": [uuid]} — the event-time booked-staff snapshot, single element since a guest booking always resolves exactly one staff member.';
