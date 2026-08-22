-- Faz 2F: public online booking. First anonymous-writable surface in the
-- product. Every function below is SECURITY DEFINER + search_path = ''
-- (the established pattern for anything crossing into `private`), and
-- every one independently re-validates tenant/branch/service/staff
-- relationships from scratch — none of them trust a caller-supplied id
-- just because it was supplied, per architecture review.
--
-- No direct table grants to anon anywhere in this migration (there are
-- none — see 20260816090006/20260817104813, still the standing
-- baseline, re-verified read-only before this file was written). All
-- access is through these 4 functions only.
--
-- Grants: every function here goes to BOTH anon and authenticated, not
-- anon alone. Reason: Supabase Auth session storage is per-browser-
-- origin, not per-route — a salon owner who is logged into /app/their-
-- salon and then opens /book/their-salon (or any tenant's public page)
-- in the same browser has their JWT attached to every Supabase call on
-- that page too, so PostgREST executes as `authenticated`, not `anon`.
-- None of these functions branch on caller identity or grant anything
-- extra to an authenticated caller — they answer the same public-safe
-- question either way — so this is not a widened surface, just a
-- correct one for how the browser actually behaves.

-- =====================================================================
-- Shared read-only predicates — kept small and reused by all 4 public
-- functions below so "is this tenant/branch/service publicly bookable"
-- can never drift into three slightly different answers.
-- =====================================================================

-- Returns the tenant id only if the tenant is genuinely publicly
-- bookable right now: exists, not soft-deleted, status permits normal
-- operation, and the online_booking feature (already defined in the
-- existing features catalog) is enabled for it via the existing
-- has_feature() resolution (explicit tenant_features override, else
-- plan inclusion, else false). trial and active both count as
-- operationally normal for this schema — nothing here signals trial
-- tenants are feature-restricted, and a trial salon test-driving the
-- product is exactly who should be able to try booking. suspended and
-- canceled do not. Returns null for every failure mode alike (unknown
-- slug, wrong status, feature off) so callers can never distinguish
-- "does not exist" from "exists but not bookable" — required to avoid
-- tenant-slug enumeration via a side channel.
create or replace function private.resolve_bookable_tenant(p_tenant_slug text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id
  from public.tenants t
  where t.slug = p_tenant_slug
    and t.deleted_at is null
    and t.status in ('trial', 'active')
    and private.has_feature(t.id, 'online_booking');
$$;

-- branches carries no status/is_active column at all (checked before
-- writing this migration) — deleted_at is the only lifecycle state that
-- exists for this table, so "active branch" means exactly "not
-- soft-deleted", nothing more is invented here.
create or replace function private.is_public_branch_valid(p_tenant_id uuid, p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.branches
    where id = p_branch_id and tenant_id = p_tenant_id and deleted_at is null
  );
$$;

-- Mirrors the AP006/AP007 checks already inside
-- validate_and_insert_appointment_item, as a boolean predicate for the
-- read-only preview functions (which must never raise / leak a reason,
-- only ever return an empty result).
create or replace function private.is_public_service_valid(p_tenant_id uuid, p_branch_id uuid, p_service_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.services s
    join public.service_branches sb on sb.service_id = s.id
    where s.id = p_service_id
      and s.tenant_id = p_tenant_id
      and s.status = 'active'
      and s.deleted_at is null
      and sb.branch_id = p_branch_id
  );
$$;

-- Safe confirmation payload shared by the success path and the
-- idempotent-replay path in create_guest_booking, so both return
-- identically-shaped data. Returns the raw UTC instant + tenant
-- timezone rather than a pre-formatted local string — formatting for
-- display is the TS layer's job everywhere else in this codebase (see
-- lib/modules/appointments/timezone.ts), no reason to duplicate that
-- here. appointmentReference is the appointment's own uuid, used as an
-- opaque booking reference — no separate reference scheme was added,
-- the uuid already is one (unguessable, unique); customers never see
-- any other internal id.
create or replace function private.public_booking_confirmation(p_appointment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'appointmentReference', a.id,
    'branchName', b.name,
    'serviceName', s.name,
    'staffName', sm.full_name,
    'scheduledStartAt', a.scheduled_start_at,
    'durationMinutes', ai.duration_minutes,
    'price', ai.price,
    'tenantTimezone', t.timezone
  )
  from public.appointments a
  join public.branches b on b.id = a.branch_id
  join public.appointment_items ai on ai.appointment_id = a.id
  join public.services s on s.id = ai.service_id
  join public.staff_members sm on sm.id = ai.staff_member_id
  join public.tenants t on t.id = a.tenant_id
  where a.id = p_appointment_id;
$$;

-- =====================================================================
-- STEP 1 — public booking context: salon + bookable gate + branches +
-- each branch's active services, in one call. Covers wizard steps
-- "branch" and "service". Not split further: a salon has a handful of
-- branches and dozens of services at most, so returning the full
-- catalog up front is one round trip instead of N, with no real payload
-- cost. bookable:false is the ONLY key present on failure — no salon
-- name, no branches, nothing that would let a caller distinguish
-- "wrong status" from "does not exist".
-- =====================================================================
create or replace function public.get_public_booking_context(p_tenant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant record;
  v_result jsonb;
begin
  select t.id, t.name, t.slug, t.timezone into v_tenant
  from public.tenants t
  where t.slug = p_tenant_slug
    and t.deleted_at is null
    and t.status in ('trial', 'active')
    and private.has_feature(t.id, 'online_booking');

  if not found then
    return jsonb_build_object('bookable', false);
  end if;

  select jsonb_build_object(
    'bookable', true,
    'salon', jsonb_build_object('name', v_tenant.name, 'slug', v_tenant.slug, 'timezone', v_tenant.timezone),
    'branches', coalesce(jsonb_agg(
      jsonb_build_object(
        'id', b.id,
        'name', b.name,
        'address', b.address,
        'services', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'id', s.id, 'name', s.name, 'category', s.category,
              'durationMinutes', s.duration_minutes, 'price', s.price
            )
            order by s.display_order, s.name
          ), '[]'::jsonb)
          from public.services s
          join public.service_branches sb on sb.service_id = s.id
          where sb.branch_id = b.id and s.tenant_id = v_tenant.id and s.status = 'active' and s.deleted_at is null
        )
      )
      order by b.is_primary desc, b.name
    ), '[]'::jsonb)
  ) into v_result
  from public.branches b
  where b.tenant_id = v_tenant.id and b.deleted_at is null;

  return v_result;
end;
$$;

-- =====================================================================
-- STEP 2 — eligible staff for one (branch, service) pair. Kept separate
-- from get_public_booking_context because the pairing isn't known until
-- the customer has made two selections; folding it in would mean
-- precomputing a branch x service x staff cross product nobody may ever
-- read. Never raises — an invalid branch/service silently resolves to
-- an empty list, same "no distinguishing side channel" rule as above.
-- =====================================================================
create or replace function public.get_public_eligible_staff(p_tenant_slug text, p_branch_id uuid, p_service_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := private.resolve_bookable_tenant(p_tenant_slug);
  if v_tenant_id is null then
    return '[]'::jsonb;
  end if;

  if not private.is_public_branch_valid(v_tenant_id, p_branch_id)
     or not private.is_public_service_valid(v_tenant_id, p_branch_id, p_service_id) then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('id', sm.id, 'fullName', sm.full_name) order by sm.display_order, sm.full_name)
    from public.staff_members sm
    join public.staff_branches sbr on sbr.staff_member_id = sm.id and sbr.branch_id = p_branch_id
    join public.staff_services ss on ss.staff_member_id = sm.id and ss.service_id = p_service_id
    where sm.tenant_id = v_tenant_id and sm.status = 'active' and sm.deleted_at is null
  ), '[]'::jsonb);
end;
$$;

-- =====================================================================
-- STEP 3 — available start times for one date, in the tenant's own
-- timezone (never the browser's). Candidates are generated every 15
-- minutes across the full local day and individually checked against
-- private.staff_is_available (working hours + exceptions) plus a direct
-- overlap check against appointment_items — the exact same two
-- primitives check_appointment_availability itself uses, reused rather
-- than reimplemented; check_appointment_availability itself can't be
-- called here because it requires appointments.view permission and only
-- answers for one (staff, time) pair, not a whole day. Booking horizon
-- (30 days) mirrored in lib/modules/public-booking/constants.ts — see
-- that file's comment for why it's duplicated rather than queried.
-- Reveals only "HH:MM" strings — never which staff, never why a time is
-- missing, never any appointment/customer detail.
-- =====================================================================
create or replace function public.get_public_availability_slots(
  p_tenant_slug text,
  p_branch_id uuid,
  p_service_id uuid,
  p_date date,
  p_staff_member_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_tz text;
  v_duration integer;
  v_today date;
  v_horizon date;
  v_candidate_local_ts timestamp;
  v_candidate_start_utc timestamptz;
  v_candidate_end_utc timestamptz;
  v_now_local timestamp;
  v_staff_ids uuid[];
  v_result jsonb := '[]'::jsonb;
  v_available boolean;
  v_i integer;
begin
  v_tenant_id := private.resolve_bookable_tenant(p_tenant_slug);
  if v_tenant_id is null then
    return '[]'::jsonb;
  end if;

  if not private.is_public_branch_valid(v_tenant_id, p_branch_id)
     or not private.is_public_service_valid(v_tenant_id, p_branch_id, p_service_id) then
    return '[]'::jsonb;
  end if;

  select timezone into v_tz from public.tenants where id = v_tenant_id;
  select duration_minutes into v_duration from public.services where id = p_service_id;

  v_now_local := now() at time zone v_tz;
  v_today := v_now_local::date;
  v_horizon := v_today + 30;

  if p_date < v_today or p_date > v_horizon then
    return '[]'::jsonb;
  end if;

  if p_staff_member_id is not null then
    if not exists (
      select 1
      from public.staff_members sm
      join public.staff_branches sbr on sbr.staff_member_id = sm.id and sbr.branch_id = p_branch_id
      join public.staff_services ss on ss.staff_member_id = sm.id and ss.service_id = p_service_id
      where sm.id = p_staff_member_id and sm.tenant_id = v_tenant_id and sm.status = 'active' and sm.deleted_at is null
    ) then
      return '[]'::jsonb;
    end if;
    v_staff_ids := array[p_staff_member_id];
  else
    select coalesce(array_agg(sm.id), array[]::uuid[]) into v_staff_ids
    from public.staff_members sm
    join public.staff_branches sbr on sbr.staff_member_id = sm.id and sbr.branch_id = p_branch_id
    join public.staff_services ss on ss.staff_member_id = sm.id and ss.service_id = p_service_id
    where sm.tenant_id = v_tenant_id and sm.status = 'active' and sm.deleted_at is null;
  end if;

  if array_length(v_staff_ids, 1) is null then
    return '[]'::jsonb;
  end if;

  v_candidate_local_ts := p_date::timestamp;
  while v_candidate_local_ts::date = p_date loop
    if v_candidate_local_ts > v_now_local then
      v_candidate_start_utc := v_candidate_local_ts at time zone v_tz;
      v_candidate_end_utc := v_candidate_start_utc + (v_duration || ' minutes')::interval;
      v_available := false;

      for v_i in 1 .. array_length(v_staff_ids, 1) loop
        if private.staff_is_available(v_tenant_id, p_branch_id, v_staff_ids[v_i], v_candidate_start_utc, v_candidate_end_utc)
          and not exists (
            select 1 from public.appointment_items ai
            where ai.staff_member_id = v_staff_ids[v_i]
              and ai.appointment_status not in ('cancelled', 'no_show')
              and tstzrange(ai.scheduled_start_at, ai.scheduled_end_at) && tstzrange(v_candidate_start_utc, v_candidate_end_utc)
          )
        then
          v_available := true;
          exit;
        end if;
      end loop;

      if v_available then
        v_result := v_result || to_jsonb(to_char(v_candidate_local_ts, 'HH24:MI'));
      end if;
    end if;

    v_candidate_local_ts := v_candidate_local_ts + interval '15 minutes';
  end loop;

  return v_result;
end;
$$;

-- =====================================================================
-- STEP 4 — the one mutating entry point. private.create_appointment
-- cannot be reused directly: it hard-requires auth.uid() and
-- appointments.create, both meaningless for a guest. What IS reused
-- directly is private.validate_and_insert_appointment_item — the same
-- function create_appointment itself calls — which has no auth check of
-- its own (permission-checking happens once, at create_appointment's
-- top level, not in this lower helper) and already does every domain
-- check (service/branch/staff/eligibility/working-hours) plus the
-- exclusion-constraint race guard (AP012). That means final-time
-- revalidation against the earlier availability preview comes for free
-- from code that already exists, rather than being reimplemented here.
--
-- "any staff": resolved server-side by trying eligible staff in a
-- deterministic order (display_order, then id) and moving to the next
-- candidate only on AP011/AP012 (unavailable / raced away) — never
-- random. If a candidate loses a race, the loop tries the next eligible
-- staff member, matching "if another eligible staff member is also
-- free, the second booking may succeed using that person."
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
  v_appointment_id uuid;
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

  select s.id, s.name into v_service
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
  if v_phone_norm is null or char_length(v_full_name_trimmed) = 0 then
    raise exception 'invalid contact details' using errcode = 'BK006';
  end if;

  -- Idempotent replay: same (tenant, key) already produced a booking.
  -- Same key + matching payload -> return that booking's confirmation
  -- again rather than creating a second one. Same key + a payload that
  -- doesn't match -> fail safely (BK007) rather than silently returning
  -- someone else's booking or overwriting it.
  if p_idempotency_key is not null then
    select a.id, a.branch_id, ai.service_id, a.scheduled_start_at, c.phone_normalized
      into v_existing_appt
    from public.appointments a
    join public.appointment_items ai on ai.appointment_id = a.id
    join public.customers c on c.id = a.customer_id
    where a.tenant_id = v_tenant.id and a.idempotency_key = p_idempotency_key;

    if found then
      if v_existing_appt.branch_id = p_branch_id
         and v_existing_appt.service_id = p_service_id
         and v_existing_appt.scheduled_start_at = p_scheduled_start_at
         and v_existing_appt.phone_normalized = v_phone_norm then
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
  -- two-phase pattern exactly. created_by is null: there is no
  -- auth.uid() for a guest request, and that's the correct signal
  -- (source already records provenance) rather than inventing a fake
  -- salon user to attribute it to.
  insert into public.appointments (
    tenant_id, branch_id, customer_id, source, scheduled_start_at, scheduled_end_at, created_by, idempotency_key
  )
  values (
    v_tenant.id, p_branch_id, v_customer_id, 'public_booking', p_scheduled_start_at, p_scheduled_start_at, null, p_idempotency_key
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

create or replace function public.create_guest_booking(
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
language sql
security definer
set search_path = ''
as $$
  select private.create_guest_booking(
    p_tenant_slug, p_branch_id, p_service_id, p_scheduled_start_at,
    p_customer_full_name, p_customer_phone, p_staff_member_id, p_customer_email, p_idempotency_key
  );
$$;

-- =====================================================================
-- Grants — the entire anon-facing surface this migration creates.
-- Nothing else in public/private gets touched. private.* helpers above
-- get no grant at all (same as every private.* function in this
-- project): they're reachable only because the public.* callers above
-- are SECURITY DEFINER and already own the elevated context.
-- =====================================================================
grant execute on function public.get_public_booking_context(text) to anon, authenticated;
grant execute on function public.get_public_eligible_staff(text, uuid, uuid) to anon, authenticated;
grant execute on function public.get_public_availability_slots(text, uuid, uuid, date, uuid) to anon, authenticated;
grant execute on function public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid) to anon, authenticated;
