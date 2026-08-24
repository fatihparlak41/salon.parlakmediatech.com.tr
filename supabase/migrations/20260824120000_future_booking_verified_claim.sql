-- Faz 2G.3.1 — Future Guest Booking Verified Claim.
--
-- 2G.3.0's architecture review was approved with one rejection: legacy
-- historical guest bookings get NO self-service claim path, ever — "CRM
-- email never changed + current Auth email matches" was judged
-- insufficient identity evidence (it proves inbox control today and CRM
-- non-edit history, never that the ORIGINAL guest actually typed that
-- email). Legacy rows stay unlinked until a separate salon-assisted
-- mechanism (2G.3.2, not yet designed).
--
-- This migration ships the stronger mechanism approved for FUTURE guest
-- bookings only, going forward from this migration: a booking may be
-- linked to a customer account only after TWO independent proofs both
-- succeed —
--
--   PROOF A — booking-browser possession: the browser/session that
--   completed the booking holds a high-entropy secret, generated on the
--   Next.js server (never in Postgres, never in the browser's own JS —
--   see lib/modules/public-booking/gateway.ts), stored here as a hash
--   only, and handed to that one browser as a short-lived HttpOnly
--   cookie.
--
--   PROOF B — email control: the caller authenticates through Supabase
--   Auth (existing scanner-safe magic-link flow, unmodified) using the
--   EXACT email captured immutably at booking time — never a live re-read
--   of customers.email, which stays freely staff-editable and must have
--   zero effect on this proof (2G.3.1 section 9's worked example: a
--   later CRM edit to a different email must not let the new email holder
--   claim an old booking, and must not stop the original booking email
--   from claiming it either).
--
-- Neither proof alone is sufficient: an attacker who books using a
-- victim's email has the browser capability but cannot authenticate as
-- the victim; the real victim controls the inbox but never possessed the
-- booking browser's cookie.
--
-- Table/RPC naming and shape decided AFTER reading customer_account_links
-- (20260822180000) and create_guest_booking (20260822190000) directly —
-- reuses the identical conventions: gen_random_uuid() PK, a named
-- composite FK against each parent's (id, tenant_id) unique key (added
-- fresh below for appointments, exactly as customers already has),
-- RLS-enabled-with-zero-policy for deny-by-construction (stricter than
-- customer_account_links' own narrow self-select policy — this table's
-- contents, a secret hash and an email snapshot, must never be directly
-- queryable by any client role at all, only through the two narrow RPCs
-- below), and the already-reserved 'verified_booking_claim' value in
-- customer_account_links.claimed_via's check constraint (20260822180000)
-- — no schema change needed there.

-- Structural tenant-consistency for the new composite FK below, mirroring
-- customers_id_tenant_id_key exactly (customer_account_links' own header
-- comment explains why this is a database-level guarantee, not an
-- application-trusted one).
alter table public.appointments
  add constraint appointments_id_tenant_id_key unique (id, tenant_id);

create table public.booking_account_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  customer_id uuid not null,
  -- One claim row per appointment, ever (not just "while unconsumed") —
  -- a retry of the same guest booking (idempotent replay) rotates THIS
  -- row's secret_hash rather than ever creating a second row for the
  -- same appointment; see private.upsert_booking_claim below for the
  -- exact upsert semantics and 2G.3.1 section 8 for why.
  appointment_id uuid not null unique,
  -- Immutable booking-time snapshot (2G.3.1 section 9) — the exact email
  -- string create_guest_booking received THIS request, never re-read
  -- from customers.email afterward. email_snapshot keeps the original
  -- casing/formatting for potential display; email_normalized_snapshot
  -- (private.normalize_email's own lower/trim rule, matching customers'
  -- own generated column) is what claim verification actually compares
  -- against the authenticated caller's normalized Auth email.
  email_snapshot text not null,
  email_normalized_snapshot text not null,
  -- Hash only, per 2G.3.1 section 5 — the raw secret is generated on the
  -- Next.js server (node:crypto), hashed there too, and never sent to or
  -- stored by Postgres in raw form at any point, not even transiently as
  -- a bind parameter.
  secret_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint booking_account_claims_customer_tenant_fkey
    foreign key (customer_id, tenant_id) references public.customers (id, tenant_id),
  constraint booking_account_claims_appointment_tenant_fkey
    foreign key (appointment_id, tenant_id) references public.appointments (id, tenant_id)
);

comment on table public.booking_account_claims is
  'Faz 2G.3.1 — one row per future guest booking that opted into account linking. A claim only succeeds when BOTH the exact booking browser (secret_hash) and the exact booking-time email inbox (email_normalized_snapshot, via Supabase Auth) are proven. Zero direct grants to any role — reachable only through private.upsert_booking_claim (creation, called from inside create_guest_booking''s own transaction) and private.claim_my_recent_booking (completion). Legacy pre-2G.3 guest bookings have no row here and are not self-claimable by design (2G.3.0).';

create index booking_account_claims_tenant_id_idx on public.booking_account_claims (tenant_id);
create index booking_account_claims_customer_id_idx on public.booking_account_claims (customer_id);

alter table public.booking_account_claims enable row level security;
-- Deliberately zero policies (unlike customer_account_links' own narrow
-- self-select-own policy): a secret_hash and an email snapshot must
-- never be directly readable via PostgREST by ANY role under any
-- circumstance, only through the two narrow SECURITY DEFINER RPCs below.
-- RLS-enabled-with-no-policy is deny-all by construction (same documented
-- pattern as public.tenants since Phase 1).

-- =====================================================================
-- private.upsert_booking_claim — called only from inside
-- create_guest_booking's own transaction (never a standalone grant), with
-- values that function has ALREADY resolved authoritatively
-- (tenant/customer/appointment) — never trusts a separately-supplied id.
-- Returns whether a claim capability was actually (re)issued this call,
-- so the caller knows whether to give the current browser a fresh cookie.
--
-- Idempotent-replay-safe by design (2G.3.1 section 8): unique(appointment_id)
-- plus ON CONFLICT ... DO UPDATE means a retried booking (same
-- idempotency key) rotates this row's secret_hash — the old raw secret,
-- if a different browser/tab still holds its cookie, stops working
-- atomically the moment the new row commits, since only ONE secret_hash
-- is ever live per appointment. If the row is already consumed (the
-- rare case where a retry arrives after the claim was already
-- completed), the DO UPDATE's WHERE clause skips the write entirely and
-- this returns false — nothing about an already-decided claim is ever
-- reopened.
--
-- Any failure here (constraint edge case, etc.) is swallowed, not
-- propagated: claim issuance is a best-effort side channel on top of the
-- booking, never a reason to fail the booking itself.
-- =====================================================================
create function private.upsert_booking_claim(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_appointment_id uuid,
  p_email text,
  p_claim_secret_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email_norm text;
  v_rows_affected int;
begin
  if p_claim_secret_hash is null or btrim(p_claim_secret_hash) = '' then
    return false;
  end if;

  v_email_norm := private.normalize_email(p_email);
  if v_email_norm is null then
    -- No usable email on this booking — nothing to bind proof B to.
    -- Matches 2G.3.1 section 2: "guest booking with no email = no
    -- self-service claim available."
    return false;
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
    where public.booking_account_claims.consumed_at is null;

    get diagnostics v_rows_affected = row_count;
    return v_rows_affected > 0;
  exception
    when others then
      return false;
  end;
end;
$$;

revoke execute on function private.upsert_booking_claim(uuid, uuid, uuid, text, text) from public;

-- =====================================================================
-- create_guest_booking — signature grows one trailing parameter,
-- p_claim_secret_hash (a HASH only, computed server-side in
-- gateway.ts; see that module's own header for why the raw secret never
-- reaches this function at all). Body is otherwise identical to
-- 20260822190000's, with claim-upsert wired into both return points:
-- the idempotent-replay early return (customer_id added to that SELECT)
-- and the fresh-creation return at the end. Guarded by
-- p_customer_account_user_id is null — an authenticated booker already
-- gets Phase 2G.1's stronger trusted linking and never needs this
-- weaker claim flow (2G.3.1 sections 2/3); this guard is structural here,
-- not just a TS-layer convention, since gateway.ts already never
-- generates a hash for an authenticated booker either.
--
-- Signature change: DROP the exact old signature, CREATE fresh, house
-- rule (see 20260822190000's own header for the same reasoning).
-- =====================================================================
drop function if exists public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid);
drop function if exists private.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid);

create function private.create_guest_booking(
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
  v_claim_issued boolean := false;
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
          v_claim_issued := private.upsert_booking_claim(
            v_tenant.id, v_existing_appt.customer_id, v_existing_appt.id, p_customer_email, p_claim_secret_hash
          );
        end if;
        return private.public_booking_confirmation(v_existing_appt.id) || jsonb_build_object('claimIssued', v_claim_issued);
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
    v_claim_issued := private.upsert_booking_claim(
      v_tenant.id, v_customer_id, v_appointment_id, p_customer_email, p_claim_secret_hash
    );
  end if;

  perform private.log_audit_event(
    v_tenant.id, 'appointment.created', 'appointment', v_appointment_id,
    null, jsonb_build_object('customer_id', v_customer_id, 'source', 'public_booking')
  );

  return private.public_booking_confirmation(v_appointment_id) || jsonb_build_object('claimIssued', v_claim_issued);
end;
$$;

revoke execute on function private.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid, text) from public;

create function public.create_guest_booking(
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

-- Same gateway-only privilege model as 20260822190000 — DROP removed the
-- old signature's grants along with the object, reapplied fresh.
revoke execute on function public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid, text) to booking_gateway;

-- =====================================================================
-- claim_my_recent_booking — the sole completion boundary. Identity from
-- auth.uid() only; the ONLY claim-identifying input is an opaque secret
-- hash the Server Action computed from its own HttpOnly cookie — never a
-- user_id/tenant_id/customer_id/appointment_id from the client (2G.3.1
-- section 13). Row-locks the claim first (FOR UPDATE) — this is the
-- single serialization point for double-redemption: a second concurrent
-- attempt against the SAME claim blocks here until the first commits,
-- then re-reads consumed_at as already set and fails identically to a
-- forged/expired claim (no distinguishing signal, 2G.3.1 section 20).
--
-- Every rejection path (not found / wrong hash / expired / consumed /
-- email mismatch / already linked to someone else) raises the exact same
-- AC010 — enumeration-safe by construction, not by convention.
-- =====================================================================
create function private.claim_my_recent_booking(p_claim_secret_hash text)
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

  if p_claim_secret_hash is null or btrim(p_claim_secret_hash) = '' then
    raise exception 'claim not valid' using errcode = 'AC010';
  end if;

  select id, tenant_id, customer_id, email_normalized_snapshot, expires_at, consumed_at
  into v_claim
  from public.booking_account_claims
  where secret_hash = p_claim_secret_hash
  for update;

  if not found or v_claim.consumed_at is not null or v_claim.expires_at < now() then
    raise exception 'claim not valid' using errcode = 'AC010';
  end if;

  select u.email into v_auth_email from auth.users u where u.id = auth.uid();
  v_auth_email_norm := private.normalize_email(v_auth_email);

  -- Proof B: the AUTHENTICATED caller's own verified email must match the
  -- IMMUTABLE booking-time snapshot — never a live re-read of
  -- customers.email, which stays freely staff-editable and irrelevant to
  -- this check (2G.3.1 section 9).
  if v_auth_email_norm is null or v_auth_email_norm <> v_claim.email_normalized_snapshot then
    raise exception 'claim not valid' using errcode = 'AC010';
  end if;

  -- Target already actively linked to a DIFFERENT account: never
  -- transfer, never disclose which account. Permanently consume this
  -- claim so the same dead-end capability can't be retried indefinitely
  -- (2G.3.1 section 16) — a real transfer/dispute is a separate,
  -- salon-assisted process, not this RPC.
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
    -- Idempotent: already linked to the SAME account (e.g. a replayed
    -- completion click). No second link row, no second audit event.
    update public.booking_account_claims
    set consumed_at = now(), consumed_by_user_id = auth.uid()
    where id = v_claim.id;
    return jsonb_build_object('success', true);
  end if;

  -- Same tenant+user advisory lock as create_guest_booking's own
  -- future_booking first-link path (20260822190000) — serializes the
  -- primary-link decision below against any other concurrent link
  -- creation for this exact (tenant, user), including a simultaneous
  -- authenticated booking.
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
      -- Only reachable via a cross-claim race on the same customer_id
      -- (this exact claim is already serialized by its own row lock
      -- above) — someone else's link for this customer_id landed first.
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

revoke execute on function private.claim_my_recent_booking(text) from public;

create function public.claim_my_recent_booking(p_claim_secret_hash text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.claim_my_recent_booking(p_claim_secret_hash);
$$;

revoke execute on function public.claim_my_recent_booking(text) from public;
revoke execute on function public.claim_my_recent_booking(text) from anon;
grant execute on function public.claim_my_recent_booking(text) to authenticated;
