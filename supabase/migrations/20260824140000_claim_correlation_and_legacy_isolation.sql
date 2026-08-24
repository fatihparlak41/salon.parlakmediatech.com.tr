-- Faz 2G.3.1A — Claim Correlation + Legacy Isolation.
--
-- Two independent fixes to the future-booking verified-claim mechanism
-- shipped in 20260824120000, both found by reproducing the exact
-- scenarios first (see the Faz 2G.3.1A report for the reproduction
-- evidence), before any code changed:
--
-- (1) MULTIPLE PENDING CLAIMS: the original design used one globally-
-- named browser cookie and one Magic Link destination
-- (/account/claim/complete) for every claim. A guest with two
-- unclaimed opted-in bookings would have the second booking's cookie
-- silently overwrite the first's — clicking the FIRST booking's email
-- and pressing the button would complete the SECOND claim instead, with
-- no error and no indication anything was wrong. Fixed by introducing a
-- non-secret claim_ref (booking_account_claims.id itself — already a
-- random, unguessable uuid, already the table's primary key, no new
-- column needed) that travels through the Magic Link's `next` path and
-- names a per-claim cookie. The ref alone is never authority — see
-- claim_my_recent_booking's new two-argument signature below, which
-- requires BOTH the ref and the matching secret hash together in one
-- lookup predicate, so "right ref + wrong secret" and "wrong ref + right
-- secret" are indistinguishable failures, exactly as they were when the
-- lookup was hash-only.
--
-- (2) LEGACY ROW ISOLATION: create_guest_booking's ordinary guest
-- customer-matching (phone+name, case 1, no trusted account) had no
-- awareness of the NEW claim flow at all. A new claim-opt-in booking
-- that happened to phone+name-match an existing CRM row silently reused
-- that row — meaning a successful two-proof claim on the NEW booking
-- would also expose every OLD appointment already attached to that row,
-- with zero booking-time identity proof for any of that history. This
-- is exactly the legacy self-claim backdoor 2G.3.0 explicitly rejected,
-- reachable indirectly through ordinary matching rather than a direct
-- claim-by-email RPC. Fixed by making claim-opt-in bookings specifically
-- (p_claim_secret_hash is not null, still only ever true for an
-- unauthenticated guest) refuse to reuse a matched row that already
-- carries any appointment history or any active account link — a fresh
-- CRM row is created instead. Ordinary non-claim guest matching is
-- completely unchanged; salon-assisted linking (2G.3.2) remains the only
-- path to the old row.

-- =====================================================================
-- upsert_booking_claim now returns the claim's own id (its claim_ref)
-- instead of a bare boolean, or null when nothing was issued/rotated
-- this call — same argument list, different return type, so this must
-- be DROP+CREATE (Postgres refuses to change a function's return type
-- via CREATE OR REPLACE).
-- =====================================================================
drop function if exists private.upsert_booking_claim(uuid, uuid, uuid, text, text);

create function private.upsert_booking_claim(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_appointment_id uuid,
  p_email text,
  p_claim_secret_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email_norm text;
  v_claim_id uuid;
begin
  if p_claim_secret_hash is null or btrim(p_claim_secret_hash) = '' then
    return null;
  end if;

  v_email_norm := private.normalize_email(p_email);
  if v_email_norm is null then
    return null;
  end if;

  begin
    insert into public.booking_account_claims (
      tenant_id, customer_id, appointment_id, email_snapshot, email_normalized_snapshot,
      secret_hash, expires_at
    )
    values (
      p_tenant_id, p_customer_id, p_appointment_id, p_email, v_email_norm,
      p_claim_secret_hash, now() + interval '24 hours'
    )
    on conflict (appointment_id) do update set
      secret_hash = excluded.secret_hash,
      email_snapshot = excluded.email_snapshot,
      email_normalized_snapshot = excluded.email_normalized_snapshot,
      expires_at = excluded.expires_at,
      created_at = now()
    where public.booking_account_claims.consumed_at is null
    returning id into v_claim_id;

    -- v_claim_id stays null when the WHERE clause skipped the write
    -- (already consumed) — a DML ... RETURNING INTO that matches zero
    -- rows leaves the target null, the same rule as a plain SELECT INTO.
    return v_claim_id;
  exception
    when others then
      return null;
  end;
end;
$$;

revoke execute on function private.upsert_booking_claim(uuid, uuid, uuid, text, text) from public;

-- =====================================================================
-- create_guest_booking — signature UNCHANGED (still 11 args), body
-- changes only: (a) v_claim_ref replaces v_claim_issued, both return
-- points now report claimRef alongside the still-boolean claimIssued;
-- (b) the claim-opt-in-only legacy-isolation branch inside case 1 of
-- customer resolution. CREATE OR REPLACE is correct here per house rule
-- — only the body changes, not the argument list.
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

    -- Faz 2G.3.1A — legacy isolation, scoped strictly to claim-opt-in
    -- bookings (p_claim_secret_hash is not null; this branch is only
    -- ever reached for an unauthenticated guest to begin with). A
    -- matched row that already carries any appointment history, or is
    -- already actively linked to someone else's account, must never be
    -- silently reused here: a successful future-booking claim would
    -- otherwise hand the claimer that unrelated history/authority with
    -- zero booking-time identity proof for it. Ordinary non-claim guest
    -- matching (the same select above) is completely unchanged.
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

  return private.public_booking_confirmation(v_appointment_id)
    || jsonb_build_object('claimIssued', v_claim_ref is not null, 'claimRef', v_claim_ref);
end;
$$;

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
  select private.create_guest_booking(
    p_tenant_slug, p_branch_id, p_service_id, p_scheduled_start_at,
    p_customer_full_name, p_customer_phone, p_staff_member_id, p_customer_email, p_idempotency_key,
    p_customer_account_user_id, p_claim_secret_hash
  );
$$;

-- CREATE OR REPLACE preserves the existing grants (unchanged signature)
-- — reasserted anyway so this migration is independently correct read
-- in isolation, same convention as every prior CREATE OR REPLACE here.
revoke execute on function public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid, text) to booking_gateway;

-- =====================================================================
-- claim_my_recent_booking — grows a leading p_claim_ref uuid parameter.
-- Argument list changes, so DROP+CREATE. The lookup predicate binds
-- BOTH id = p_claim_ref AND secret_hash = p_claim_secret_hash in one
-- WHERE clause (not two sequential checks) specifically so "right ref,
-- wrong secret" and "wrong ref, right secret" are the exact same
-- "not found" outcome — claim_ref is a locator, never authority on its
-- own, matching 2G.3.1A's explicit requirement.
-- =====================================================================
drop function if exists public.claim_my_recent_booking(text);
drop function if exists private.claim_my_recent_booking(text);

create function private.claim_my_recent_booking(p_claim_ref uuid, p_claim_secret_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim record;
  v_auth_email text;
  v_auth_email_norm text;
  v_already_same_user boolean;
  v_should_be_primary boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AC001';
  end if;

  if p_claim_ref is null or p_claim_secret_hash is null or btrim(p_claim_secret_hash) = '' then
    raise exception 'claim not valid' using errcode = 'AC010';
  end if;

  select id, tenant_id, customer_id, email_normalized_snapshot, expires_at, consumed_at
  into v_claim
  from public.booking_account_claims
  where id = p_claim_ref and secret_hash = p_claim_secret_hash
  for update;

  if not found or v_claim.consumed_at is not null or v_claim.expires_at < now() then
    raise exception 'claim not valid' using errcode = 'AC010';
  end if;

  select u.email into v_auth_email from auth.users u where u.id = auth.uid();
  v_auth_email_norm := private.normalize_email(v_auth_email);

  if v_auth_email_norm is null or v_auth_email_norm <> v_claim.email_normalized_snapshot then
    raise exception 'claim not valid' using errcode = 'AC010';
  end if;

  if exists (
    select 1 from public.customer_account_links
    where tenant_id = v_claim.tenant_id and customer_id = v_claim.customer_id
      and deleted_at is null and user_id <> auth.uid()
  ) then
    update public.booking_account_claims
    set consumed_at = now(), consumed_by_user_id = auth.uid()
    where id = v_claim.id;
    raise exception 'claim not valid' using errcode = 'AC010';
  end if;

  select exists (
    select 1 from public.customer_account_links
    where tenant_id = v_claim.tenant_id and customer_id = v_claim.customer_id
      and deleted_at is null and user_id = auth.uid()
  ) into v_already_same_user;

  if v_already_same_user then
    update public.booking_account_claims
    set consumed_at = now(), consumed_by_user_id = auth.uid()
    where id = v_claim.id;
    return jsonb_build_object('success', true);
  end if;

  perform pg_advisory_xact_lock(
    hashtext('customer_account_link'),
    hashtext(v_claim.tenant_id::text || '|' || auth.uid()::text)
  );

  select not exists (
    select 1 from public.customer_account_links
    where tenant_id = v_claim.tenant_id and user_id = auth.uid()
      and deleted_at is null and is_primary = true
  ) into v_should_be_primary;

  begin
    insert into public.customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
    values (auth.uid(), v_claim.tenant_id, v_claim.customer_id, 'verified_booking_claim', v_should_be_primary);
  exception
    when unique_violation then
      update public.booking_account_claims
      set consumed_at = now(), consumed_by_user_id = auth.uid()
      where id = v_claim.id;
      raise exception 'claim not valid' using errcode = 'AC010';
  end;

  update public.booking_account_claims
  set consumed_at = now(), consumed_by_user_id = auth.uid()
  where id = v_claim.id;

  perform private.log_audit_event(
    v_claim.tenant_id, 'customer_account_link.claimed', 'customer', v_claim.customer_id,
    null, jsonb_build_object('claimedVia', 'verified_booking_claim')
  );

  return jsonb_build_object('success', true);
end;
$$;

revoke execute on function private.claim_my_recent_booking(uuid, text) from public;

create function public.claim_my_recent_booking(p_claim_ref uuid, p_claim_secret_hash text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.claim_my_recent_booking(p_claim_ref, p_claim_secret_hash);
$$;

revoke execute on function public.claim_my_recent_booking(uuid, text) from public;
revoke execute on function public.claim_my_recent_booking(uuid, text) from anon;
grant execute on function public.claim_my_recent_booking(uuid, text) to authenticated;
