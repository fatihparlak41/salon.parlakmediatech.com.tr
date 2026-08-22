-- Faz 2F.1 Part A — two real correctness gaps in the Faz 2F report,
-- found on review rather than in testing (the existing tests only
-- proved the fields that WERE compared were compared correctly; they
-- never proved the comparison was complete).
--
-- =====================================================================
-- Gap 1: idempotency compared an incomplete subset of the request.
-- =====================================================================
-- The shipped create_guest_booking treated a retry as "the same
-- request" whenever branch_id + service_id + scheduled_start_at +
-- phone_normalized matched. That silently ignored: staff preference
-- (explicit staff vs "any staff" collapsed to indistinguishable if the
-- any-staff resolution happened to land on that same person), customer
-- full name, and customer email. A caller could replay the same key
-- with a different staff preference, a different name, or a different
-- email and get the *original* booking's confirmation back — data the
-- second request never actually asked for and didn't necessarily match.
--
-- Fix: a single canonical fingerprint over every field that actually
-- defines "the same booking request", stored alongside the key on the
-- appointment, compared exactly on retry.
--
-- Canonical fields, in this fixed order:
--   1. tenant_id            (post-slug-resolution, not the raw slug —
--                             the authoritative identity)
--   2. branch_id
--   3. service_id
--   4. staff preference     — the raw p_staff_member_id AS SUPPLIED,
--                             before any-staff resolution: coalesce to
--                             the literal sentinel 'ANY_STAFF' when
--                             null. An explicit staff id and "any staff"
--                             are different requests even when any-staff
--                             happens to resolve to that same person —
--                             computed from the parameter, never from
--                             v_resolved_staff_id.
--   5. scheduled_start_at   — canonicalized to a fixed-width UTC string
--                             (YYYY-MM-DDTHH24:MI:SS.US), not the raw
--                             timestamptz, so the fingerprint's text
--                             form doesn't depend on how any particular
--                             text() cast might render a timestamptz
--   6. customer full name   — lower(btrim(...))
--   7. customer phone       — private.normalize_phone(...), the same
--                             function phone_normalized is generated
--                             from
--   8. customer email       — private.normalize_email(...), or the
--                             empty string when not supplied (matches
--                             normalize_email's own null-for-blank
--                             behavior, so "omitted" and "blank" collapse
--                             to the same canonical value, which is the
--                             correct behavior — they mean the same thing)
--
-- Fields are length-prefixed before concatenation (not delimiter-joined)
-- so no field's own content — a name containing the delimiter character,
-- for instance — could ever shift a later field's boundary and produce
-- a false match. Hashed with md5(): this is an equality-check digest
-- for "did this exact payload happen before", not a security boundary,
-- so collision-resistance requirements that would justify sha256/pgcrypto
-- don't apply here, and md5() is a Postgres core function — no new
-- extension dependency for a single equality check. Never returned
-- publicly (private.public_booking_confirmation doesn't select it).
--
-- =====================================================================
-- Gap 2: BK006 only checked for blank name / phone-normalizes-to-empty.
-- =====================================================================
-- Nothing rejected a phone that normalizes to a handful of digits, a
-- malformed phone with a '+' in the middle, or a garbled non-empty
-- email. Country-neutral by design — no Turkey-specific +90/05 handling
-- — and explicitly validation, not anti-abuse: it rejects obviously
-- meaningless input, it does not attempt to verify the contact is real
-- or reachable (that needs actual verification — SMS/email OTP — which
-- is out of scope here, tracked as a PROD-launch consideration
-- separately from this fix).
--   - phone, after normalize_phone, must match ^\+?[0-9]+$ (at most one
--     leading '+', digits only — rejects a '+' anywhere else, which
--     normalize_phone's character-class strip alone doesn't catch)
--   - digit count (excluding a leading '+') must be 7-15 inclusive —
--     15 is E.164's own maximum; 7 is a defensible, widely-used floor
--     for a real subscriber number in virtually any numbering plan.
--     Deliberately not tighter than that: this project has no
--     authoritative per-country numbering-plan data, and being wrong in
--     the strict direction turns away real customers, which is worse
--     than being wrong in the loose direction.
--   - email, only when supplied (still fully optional), must match a
--     loose x@y.z shape — not RFC 5322-complete, just enough to reject
--     "not-an-email" or "foo@" while not rejecting anything a real
--     address could plausibly look like.

alter table public.appointments
  add column idempotency_fingerprint text;

create or replace function private.canonical_booking_fingerprint(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_service_id uuid,
  p_staff_member_id uuid,
  p_scheduled_start_at timestamptz,
  p_customer_full_name text,
  p_customer_phone text,
  p_customer_email text
)
returns text
language sql
immutable
set search_path = ''
as $$
  with fields as (
    select
      p_tenant_id::text as f1,
      p_branch_id::text as f2,
      p_service_id::text as f3,
      coalesce(p_staff_member_id::text, 'ANY_STAFF') as f4,
      to_char(p_scheduled_start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as f5,
      lower(btrim(coalesce(p_customer_full_name, ''))) as f6,
      coalesce(private.normalize_phone(p_customer_phone), '') as f7,
      coalesce(private.normalize_email(p_customer_email), '') as f8
  )
  select md5(
    array_to_string(
      array[
        length(f1)::text || ':' || f1,
        length(f2)::text || ':' || f2,
        length(f3)::text || ':' || f3,
        length(f4)::text || ':' || f4,
        length(f5)::text || ':' || f5,
        length(f6)::text || ':' || f6,
        length(f7)::text || ':' || f7,
        length(f8)::text || ':' || f8
      ],
      '|'
    )
  )
  from fields;
$$;

revoke execute on function private.canonical_booking_fingerprint(uuid, uuid, uuid, uuid, timestamptz, text, text, text) from public;

create or replace function private.create_guest_booking(
  p_tenant_slug text,
  p_branch_id uuid,
  p_service_id uuid,
  p_scheduled_start_at timestamptz,
  p_customer_full_name text,
  p_customer_phone text,
  p_staff_member_id uuid default null,
  p_customer_email text default null,
  p_idempotency_key uuid default null
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

  -- Contact validation (BK006) — see this migration's header for the
  -- exact, documented, country-neutral policy.
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

  -- Canonical fingerprint — computed from p_staff_member_id exactly as
  -- supplied (ANY_STAFF sentinel when null), never from a resolved
  -- staff id, so "any staff" and an explicit id are always different
  -- requests even if any-staff happens to land on that same person.
  v_fingerprint := private.canonical_booking_fingerprint(
    v_tenant.id, p_branch_id, p_service_id, p_staff_member_id, p_scheduled_start_at,
    p_customer_full_name, p_customer_phone, p_customer_email
  );

  -- Idempotent replay: same (tenant, key) already produced a booking.
  -- Same key + matching fingerprint -> return that booking's
  -- confirmation again rather than creating a second one. Same key +
  -- any other difference in the canonical request -> fail safely
  -- (BK007) rather than silently returning a mismatched booking.
  if p_idempotency_key is not null then
    select a.id, a.idempotency_fingerprint into v_existing_appt
    from public.appointments a
    where a.tenant_id = v_tenant.id and a.idempotency_key = p_idempotency_key;

    if found then
      if v_existing_appt.idempotency_fingerprint = v_fingerprint then
        return private.public_booking_confirmation(v_existing_appt.id);
      else
        raise exception 'booking already submitted' using errcode = 'BK007';
      end if;
    end if;
  end if;

  -- Customer: conservative find-or-create. Reuses normalize_phone
  -- directly (the same function phone_normalized is generated from, so
  -- this comparison matches exactly what the row already stores).
  -- Requires phone AND name to agree — phone alone is never a safe
  -- match (shared family phones, recycled numbers). No indication is
  -- ever returned about whether a match was found vs. created.
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

  -- Header first, placeholder range corrected below once the item's
  -- real start/end is known — mirrors private.create_appointment's own
  -- pattern of never leaving scheduled_end_at <= scheduled_start_at,
  -- computed here from the already-validated service duration.
  -- created_by is null: there is no auth.uid() for a guest request, and
  -- that's the correct signal (source already records provenance)
  -- rather than inventing a fake salon user to attribute it to.
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

  perform private.log_audit_event(
    v_tenant.id, 'appointment.created', 'appointment', v_appointment_id,
    null, jsonb_build_object('customer_id', v_customer_id, 'source', 'public_booking')
  );

  return private.public_booking_confirmation(v_appointment_id);
end;
$$;

-- CREATE OR REPLACE preserves the existing grants (anon, authenticated)
-- and the PUBLIC revoke — re-asserted here anyway so this migration is
-- independently correct even if read in isolation.
revoke execute on function private.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid) from public;
