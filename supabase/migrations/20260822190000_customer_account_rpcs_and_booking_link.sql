-- Faz 2G.1 — three narrow customer-portal RPCs (get_my_account_profile,
-- update_my_account_profile, get_my_appointments), all identity-derived
-- exclusively from auth.uid(), no id ever accepted as a parameter; and
-- the approved "Option A" future-booking link: create_guest_booking
-- grows one new trailing parameter, p_customer_account_user_id, always
-- computed server-side from the caller's real session (never from
-- browser-submitted JSON — see lib/modules/public-booking/actions.ts)
-- and never returned in any public response.
--
-- Signature change means overload risk (house rule): DROP the exact old
-- signature, CREATE the new one fresh, reapply REVOKE/GRANT explicitly.
-- Applies to canonical_booking_fingerprint and create_guest_booking
-- (both public. and private.) below.

drop function if exists private.canonical_booking_fingerprint(uuid, uuid, uuid, uuid, timestamptz, text, text, text);
drop function if exists public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid);
drop function if exists private.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid);

-- =====================================================================
-- Fingerprint: 9th canonical field, the trusted account identity. Same
-- ANY_STAFF-style sentinel technique — 'GUEST' when no authenticated
-- account is attached — so an anonymous request and an authenticated
-- request that otherwise share every browser-supplied field never
-- collapse into "the same request" when their ownership/linking outcome
-- genuinely differs (2G.1 spec section 16). Computed from the
-- server-derived parameter, which is never browser input either way.
-- =====================================================================
create function private.canonical_booking_fingerprint(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_service_id uuid,
  p_staff_member_id uuid,
  p_scheduled_start_at timestamptz,
  p_customer_full_name text,
  p_customer_phone text,
  p_customer_email text,
  p_customer_account_user_id uuid
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
      coalesce(private.normalize_email(p_customer_email), '') as f8,
      coalesce(p_customer_account_user_id::text, 'GUEST') as f9
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
        length(f8)::text || ':' || f8,
        length(f9)::text || ':' || f9
      ],
      '|'
    )
  )
  from fields;
$$;

revoke execute on function private.canonical_booking_fingerprint(uuid, uuid, uuid, uuid, timestamptz, text, text, text, uuid) from public;

-- =====================================================================
-- create_guest_booking — identical to the 20260822160000 body (tenant/
-- branch/service/time/contact validation, idempotency replay, staff
-- resolution/any-staff loop, audit log) with exactly one behavioral
-- change: how the customer row is resolved. See the inline comment at
-- that block for the three cases (guest / has-primary / needs-first-link).
-- =====================================================================
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
  p_customer_account_user_id uuid default null
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

  -- Contact validation (BK006) — unchanged, see 20260822160000's header
  -- for the exact, documented, country-neutral policy.
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

  -- =====================================================================
  -- Customer resolution — three cases:
  --
  -- 1. No trusted account user (ordinary guest booking): conservative
  --    phone+name match-or-create, byte-for-byte the pre-2G.1 behavior.
  --
  -- 2. Trusted account user WITH an existing active PRIMARY link in this
  --    tenant: use that customer_id directly. Never re-run phone/name
  --    matching, never create a second row, never rewrite that row from
  --    the submitted contact fields — an authenticated repeat customer's
  --    canonical CRM row does not drift just because they typed their
  --    name slightly differently this time (2G.1 section 13(A)).
  --
  -- 3. Trusted account user with NO primary link yet in this tenant:
  --    serialize on a per-(tenant,user) advisory lock (auto-released at
  --    transaction end), matching Postgres-safe strategy required by
  --    2G.1 section 15 — a second concurrent request for the same user
  --    blocks here until the first commits or rolls back, so it always
  --    re-reads a consistent post-commit state rather than racing on a
  --    stale "no primary yet" snapshot. Then hijack-protected
  --    match-or-create (2G.1 section 14): a phone+name match is only
  --    reused if no account has ever actively linked it — a customer row
  --    already claimed by a DIFFERENT account is never attached to this
  --    one, a fresh row is created instead. Booking + first primary link
  --    commit or roll back together: nothing after this point commits
  --    independently, it's all one function-call transaction.
  -- =====================================================================
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
          -- Only reachable across two DIFFERENT users' simultaneous first
          -- bookings matching the same phone+name: this user's own
          -- concurrent attempts are already serialized by the advisory
          -- lock above, so a same-user race can't land here. Someone else
          -- won that customer row between our match and our insert —
          -- never contest it, fall back to a brand new row for this
          -- booking instead.
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

  perform private.log_audit_event(
    v_tenant.id, 'appointment.created', 'appointment', v_appointment_id,
    null, jsonb_build_object('customer_id', v_customer_id, 'source', 'public_booking')
  );

  return private.public_booking_confirmation(v_appointment_id);
end;
$$;

revoke execute on function private.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid) from public;

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
  p_customer_account_user_id uuid default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.create_guest_booking(
    p_tenant_slug, p_branch_id, p_service_id, p_scheduled_start_at,
    p_customer_full_name, p_customer_phone, p_staff_member_id, p_customer_email, p_idempotency_key,
    p_customer_account_user_id
  );
$$;

-- Same gateway-only privilege model as 20260822170000 — DROP removed the
-- old signature's grants along with the object, so both are reapplied
-- fresh here rather than assumed carried over.
revoke execute on function public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid, uuid) to booking_gateway;

-- =====================================================================
-- Customer-portal RPC surface — exactly 3 functions, authenticated only,
-- identity exclusively from auth.uid(), no id ever accepted as an
-- argument. AC0nn is the account-domain error taxonomy (mirrors BK0nn),
-- mapped to Turkish in lib/modules/customer-account/error-codes.ts.
-- =====================================================================
create function public.get_my_account_profile()
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
    raise exception 'authentication required' using errcode = 'AC001';
  end if;

  select jsonb_build_object(
    'fullName', p.full_name,
    'phone', p.phone,
    'email', u.email
  ) into v_result
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.id = auth.uid();

  return v_result;
end;
$$;

revoke execute on function public.get_my_account_profile() from public;
grant execute on function public.get_my_account_profile() to authenticated;

create function public.update_my_account_profile(p_full_name text, p_phone text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_full_name_trimmed text;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AC001';
  end if;

  v_full_name_trimmed := btrim(coalesce(p_full_name, ''));
  if char_length(v_full_name_trimmed) < 1 or char_length(v_full_name_trimmed) > 200 then
    raise exception 'invalid profile details' using errcode = 'AC002';
  end if;

  -- Global account profile only (public.profiles) — never touches any
  -- tenant's customers row. A salon's own CRM copy of this person's
  -- name/phone is a separate, independently-editable record by design
  -- (2G.1 section 9); this function has no tenant context at all.
  update public.profiles
  set full_name = v_full_name_trimmed, phone = nullif(btrim(coalesce(p_phone, '')), '')
  where id = auth.uid();

  select jsonb_build_object(
    'fullName', p.full_name,
    'phone', p.phone,
    'email', u.email
  ) into v_result
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.id = auth.uid();

  return v_result;
end;
$$;

revoke execute on function public.update_my_account_profile(text, text) from public;
grant execute on function public.update_my_account_profile(text, text) to authenticated;

-- Safe fields only: salon/branch/service/staff display names, local
-- date/time (raw UTC + tenant timezone, formatted client-side same as
-- private.public_booking_confirmation), status, duration/price snapshot
-- from appointment_items (never re-read from the live services row).
-- Never CRM notes, staff contact fields, or any other customer's data —
-- the WHERE clause is the only access rule, scoped to every active link
-- (any tenant, any is_primary) owned by auth.uid(). Ordered+limited
-- BEFORE aggregation (a bare LIMIT after a whole-set jsonb_agg would not
-- actually bound the input rows).
create function public.get_my_appointments()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(appt), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'appointmentId', a.id,
      'tenantName', t.name,
      'tenantSlug', t.slug,
      'tenantTimezone', t.timezone,
      'branchName', b.name,
      'status', a.status,
      'scheduledStartAt', a.scheduled_start_at,
      'scheduledEndAt', a.scheduled_end_at,
      'services', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'serviceName', s.name,
            'staffName', sm.full_name,
            'durationMinutes', ai.duration_minutes,
            'price', ai.price
          )
          order by ai.sequence
        ), '[]'::jsonb)
        from public.appointment_items ai
        join public.services s on s.id = ai.service_id
        join public.staff_members sm on sm.id = ai.staff_member_id
        where ai.appointment_id = a.id
      )
    ) as appt
    from public.appointments a
    join public.branches b on b.id = a.branch_id
    join public.tenants t on t.id = a.tenant_id
    where a.customer_id in (
      select cal.customer_id
      from public.customer_account_links cal
      where cal.user_id = auth.uid() and cal.deleted_at is null
    )
    order by a.scheduled_start_at desc
    limit 200
  ) ordered;
$$;

revoke execute on function public.get_my_appointments() from public;
grant execute on function public.get_my_appointments() to authenticated;
