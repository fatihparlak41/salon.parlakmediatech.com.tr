-- Phase 2I.2B: a staff member may sometimes handle more than one
-- customer concurrently (e.g. a stylist running a color and a cut in
-- parallel). Until now, one staff member = at most one active
-- appointment at any instant was a hard DB-level invariant, enforced by
-- appointment_items_no_staff_overlap (a GiST EXCLUDE constraint). That
-- constraint is pairwise by construction — it can only express "no two
-- rows may conflict," never "up to N rows may overlap" — so it cannot
-- simply be loosened. It is replaced here by a per-staff capacity
-- invariant, enforced at the single point where appointment_items rows
-- are ever created: private.validate_and_insert_appointment_item.
--
-- Every existing staff member keeps concurrent_capacity = 1, which
-- reproduces today's exact enforcement (zero overlap tolerance) via the
-- new count-based check below. No tenant-specific values are set here —
-- the pilot salon (Gökhan İlhan) will be configured after this ships.

alter table public.staff_members
  add column concurrent_capacity integer not null default 1
    check (concurrent_capacity between 1 and 20);

comment on column public.staff_members.concurrent_capacity is
  'Maximum number of active (non-cancelled/no_show) appointment_items this staff member may hold with overlapping time ranges at once. 1 = today''s default, one customer at a time. See supabase/migrations/README.md "Phase 2I.2B".';

-- Replaces the old EXCLUDE constraint's implicit GiST index so the new
-- count-based checks below (and the advisory-only checks in
-- check_appointment_availability / get_public_availability_slots /
-- get_my_reschedule_slots) keep the same index support they had before.
-- Same shape as the dropped constraint; btree_gist is already installed
-- (it was a prerequisite for that constraint's "staff_member_id WITH ="
-- term to have worked at all). Dropping the constraint automatically
-- drops its own backing index too — nothing else to clean up first.
alter table public.appointment_items
  drop constraint appointment_items_no_staff_overlap;

create index appointment_items_staff_overlap_idx
  on public.appointment_items
  using gist (staff_member_id, tstzrange(scheduled_start_at, scheduled_end_at))
  where appointment_status <> all (array['cancelled', 'no_show']);

-- private.validate_and_insert_appointment_item (20260819052514, body
-- unchanged in shape until now): the sole write path for
-- appointment_items (no authenticated/anon role holds direct INSERT on
-- that table — see security-grants-regression.test.ts), which makes the
-- advisory-lock-guarded count check below the complete, transaction-safe
-- replacement for the dropped constraint. The lock is scoped to the
-- staff member alone, not staff+time: two inserts for the same staff at
-- DIFFERENT-but-overlapping windows must still serialize against each
-- other, or both could read a stale count and together exceed capacity.
-- pg_advisory_xact_lock is held for the rest of this transaction only,
-- released automatically on commit/rollback — same mechanism already
-- used for pairing-code generation, primary-link decisions and claim
-- correlation elsewhere in this codebase.
create or replace function private.validate_and_insert_appointment_item(p_tenant_id uuid, p_branch_id uuid, p_appointment_id uuid, p_item jsonb, p_sequence integer, p_duration_override integer DEFAULT NULL::integer, p_price_override numeric DEFAULT NULL::numeric)
 returns private.appointment_item_result
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_service record;
  v_staff_member record;
  v_start timestamptz;
  v_end timestamptz;
  v_duration integer;
  v_price numeric;
  v_result private.appointment_item_result;
  v_overlap_count integer;
begin
  select * into v_service
  from public.services
  where id = (p_item->>'service_id')::uuid
    and tenant_id = p_tenant_id
    and status = 'active'
    and deleted_at is null;

  if not found then
    raise exception 'service not found or inactive in this tenant' using errcode = 'AP006';
  end if;

  if not exists (
    select 1 from public.service_branches
    where service_id = v_service.id and branch_id = p_branch_id
  ) then
    raise exception 'service "%" is not offered at this branch', v_service.name using errcode = 'AP007';
  end if;

  select * into v_staff_member
  from public.staff_members
  where id = (p_item->>'staff_member_id')::uuid
    and tenant_id = p_tenant_id
    and status = 'active'
    and deleted_at is null;

  if not found then
    raise exception 'staff member not found or inactive in this tenant' using errcode = 'AP008';
  end if;

  if not exists (
    select 1 from public.staff_branches
    where staff_member_id = v_staff_member.id and branch_id = p_branch_id
  ) then
    raise exception 'staff member "%" does not work at this branch', v_staff_member.full_name using errcode = 'AP009';
  end if;

  if not exists (
    select 1 from public.staff_services
    where staff_member_id = v_staff_member.id and service_id = v_service.id
  ) then
    raise exception 'staff member "%" is not eligible for service "%"', v_staff_member.full_name, v_service.name using errcode = 'AP010';
  end if;

  v_start := (p_item->>'scheduled_start_at')::timestamptz;
  -- Faz 2G.2B.1: explicit parameters only — p_item's own content is
  -- never consulted for these two fields, closing the injection path
  -- regardless of what any caller (current or future) puts in p_item.
  v_duration := coalesce(p_duration_override, v_service.duration_minutes);
  v_price := coalesce(p_price_override, v_service.price);
  v_end := v_start + (v_duration || ' minutes')::interval;

  if not private.staff_is_available(p_tenant_id, p_branch_id, v_staff_member.id, v_start, v_end) then
    raise exception 'staff member "%" is not working at the requested time', v_staff_member.full_name using errcode = 'AP011';
  end if;

  -- Faz 2I.2B capacity check — see migration header comment.
  perform pg_advisory_xact_lock(hashtext('appointment_capacity'), hashtext(v_staff_member.id::text));

  select count(*) into v_overlap_count
  from public.appointment_items ai
  where ai.staff_member_id = v_staff_member.id
    and ai.appointment_status not in ('cancelled', 'no_show')
    and tstzrange(ai.scheduled_start_at, ai.scheduled_end_at) && tstzrange(v_start, v_end);

  if v_overlap_count >= v_staff_member.concurrent_capacity then
    raise exception 'staff member "%" is at capacity for the requested time', v_staff_member.full_name using errcode = 'AP012';
  end if;

  insert into public.appointment_items (
    tenant_id, appointment_id, service_id, staff_member_id,
    scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence
  )
  values (
    p_tenant_id, p_appointment_id, v_service.id, v_staff_member.id,
    v_start, v_end, v_duration, v_price, p_sequence
  );

  v_result.scheduled_start_at := v_start;
  v_result.scheduled_end_at := v_end;
  return v_result;
end;
$function$;

-- public.check_appointment_availability (20260822091500 +
-- 20260822093000 + 20260822120000): staff-side single-slot preview,
-- called from appointment-items-editor.tsx for both staff booking and
-- staff reschedule. Advisory only (mirrors the real write-time check,
-- never the enforcement point itself — see its own pre-existing
-- comment) so it needs no lock, only the same count-vs-capacity
-- comparison.
create or replace function public.check_appointment_availability(p_tenant_id uuid, p_branch_id uuid, p_staff_member_id uuid, p_service_id uuid, p_scheduled_start_at timestamp with time zone, p_exclude_appointment_id uuid DEFAULT NULL::uuid)
 returns table(is_available boolean, reason text, scheduled_end_at timestamp with time zone)
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_service record;
  v_staff_member record;
  v_end timestamptz;
  v_verified_exclude_id uuid;
  v_overlap_count integer;
begin
  if not private.has_permission(p_tenant_id, 'appointments.view') then
    raise exception 'appointments.view required' using errcode = 'AP002';
  end if;

  if p_exclude_appointment_id is not null then
    select id into v_verified_exclude_id
    from public.appointments
    where id = p_exclude_appointment_id and tenant_id = p_tenant_id;
    -- Not found (wrong tenant / forged / deleted) -> v_verified_exclude_id
    -- stays null -> the overlap check below excludes nothing extra.
  end if;

  select * into v_service
  from public.services
  where id = p_service_id and tenant_id = p_tenant_id and status = 'active' and deleted_at is null;
  if not found then
    return query select false, 'AP006'::text, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.service_branches where service_id = v_service.id and branch_id = p_branch_id
  ) then
    return query select false, 'AP007'::text, null::timestamptz;
    return;
  end if;

  select * into v_staff_member
  from public.staff_members
  where id = p_staff_member_id and tenant_id = p_tenant_id and status = 'active' and deleted_at is null;
  if not found then
    return query select false, 'AP008'::text, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.staff_branches where staff_member_id = v_staff_member.id and branch_id = p_branch_id
  ) then
    return query select false, 'AP009'::text, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.staff_services where staff_member_id = v_staff_member.id and service_id = v_service.id
  ) then
    return query select false, 'AP010'::text, null::timestamptz;
    return;
  end if;

  v_end := p_scheduled_start_at + (v_service.duration_minutes || ' minutes')::interval;

  if not private.staff_is_available(p_tenant_id, p_branch_id, v_staff_member.id, p_scheduled_start_at, v_end) then
    return query select false, 'AP011'::text, v_end;
    return;
  end if;

  -- staff_is_available deliberately only checks working hours/exceptions,
  -- never a conflicting appointment (see its own comment) — the real
  -- capacity enforcement happens only at write time, in the insert path.
  -- This mirrors that same check here, advisory only. Items belonging to
  -- v_verified_exclude_id (the appointment currently being rescheduled,
  -- once tenant-verified above) are ignored; every other appointment
  -- still counts against capacity normally.
  select count(*) into v_overlap_count
  from public.appointment_items ai
  where ai.staff_member_id = v_staff_member.id
    and ai.appointment_status not in ('cancelled', 'no_show')
    and (v_verified_exclude_id is null or ai.appointment_id != v_verified_exclude_id)
    and tstzrange(ai.scheduled_start_at, ai.scheduled_end_at) && tstzrange(p_scheduled_start_at, v_end);

  if v_overlap_count >= v_staff_member.concurrent_capacity then
    return query select false, 'AP012'::text, v_end;
    return;
  end if;

  return query select true, null::text, v_end;
end;
$function$;

-- public.get_public_availability_slots (20260822150500): public
-- booking wizard's day slot-picker. Same advisory, no-lock treatment —
-- count of active overlaps against that staff member's capacity instead
-- of a flat zero-tolerance check.
create or replace function public.get_public_availability_slots(p_tenant_slug text, p_branch_id uuid, p_service_id uuid, p_date date, p_staff_member_id uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
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
          and (
            select count(*) from public.appointment_items ai
            where ai.staff_member_id = v_staff_ids[v_i]
              and ai.appointment_status not in ('cancelled', 'no_show')
              and tstzrange(ai.scheduled_start_at, ai.scheduled_end_at) && tstzrange(v_candidate_start_utc, v_candidate_end_utc)
          ) < (
            select concurrent_capacity from public.staff_members where id = v_staff_ids[v_i]
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
$function$;

-- private.get_my_reschedule_slots: customer reschedule's own day
-- slot-picker, structurally separate from the public wizard's. Same
-- count-vs-capacity swap, in the one clause of its exists(...) chain
-- that used to require zero overlap.
create or replace function private.get_my_reschedule_slots(p_appointment_id uuid, p_date date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_appointment record;
  v_tenant record;
  v_tz text;
  v_today date;
  v_horizon date;
  v_now_local timestamp;
  v_candidate_local_ts timestamp;
  v_candidate_start_utc timestamptz;
  v_delta interval;
  v_item record;
  v_shifted_start timestamptz;
  v_shifted_end timestamptz;
  v_candidate_valid boolean;
  v_result jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    return '[]'::jsonb;
  end if;

  select a.id, a.tenant_id, a.branch_id, a.customer_id, a.status, a.scheduled_start_at
  into v_appointment
  from public.appointments a
  where a.id = p_appointment_id;

  if not found then
    return '[]'::jsonb;
  end if;

  if not exists (
    select 1 from public.customer_account_links cal
    where cal.user_id = auth.uid() and cal.deleted_at is null and cal.customer_id = v_appointment.customer_id
  ) then
    return '[]'::jsonb;
  end if;

  if v_appointment.status not in ('scheduled', 'confirmed') then
    return '[]'::jsonb;
  end if;

  select customer_reschedule_enabled, customer_reschedule_cutoff_minutes, timezone
  into v_tenant
  from public.tenants
  where id = v_appointment.tenant_id;

  if not v_tenant.customer_reschedule_enabled then
    return '[]'::jsonb;
  end if;

  if now() > v_appointment.scheduled_start_at - (v_tenant.customer_reschedule_cutoff_minutes || ' minutes')::interval then
    return '[]'::jsonb;
  end if;

  v_tz := v_tenant.timezone;
  v_now_local := now() at time zone v_tz;
  v_today := v_now_local::date;
  v_horizon := v_today + 30;

  if p_date < v_today or p_date > v_horizon then
    return '[]'::jsonb;
  end if;

  v_candidate_local_ts := p_date::timestamp;
  while v_candidate_local_ts::date = p_date loop
    if v_candidate_local_ts > v_now_local then
      v_candidate_start_utc := v_candidate_local_ts at time zone v_tz;
      v_delta := v_candidate_start_utc - v_appointment.scheduled_start_at;
      v_candidate_valid := true;

      for v_item in
        select ai.staff_member_id, ai.service_id, ai.scheduled_start_at, ai.duration_minutes
        from public.appointment_items ai
        where ai.appointment_id = p_appointment_id
      loop
        v_shifted_start := v_item.scheduled_start_at + v_delta;
        v_shifted_end := v_shifted_start + (v_item.duration_minutes || ' minutes')::interval;

        if not (
          exists (
            select 1 from public.staff_members sm
            where sm.id = v_item.staff_member_id and sm.status = 'active' and sm.deleted_at is null
          )
          and exists (
            select 1 from public.staff_branches sb
            where sb.staff_member_id = v_item.staff_member_id and sb.branch_id = v_appointment.branch_id
          )
          and exists (
            select 1 from public.services s
            where s.id = v_item.service_id and s.status = 'active' and s.deleted_at is null
          )
          and exists (
            select 1 from public.service_branches svb
            where svb.service_id = v_item.service_id and svb.branch_id = v_appointment.branch_id
          )
          and exists (
            select 1 from public.staff_services ss
            where ss.staff_member_id = v_item.staff_member_id and ss.service_id = v_item.service_id
          )
          and private.staff_is_available(v_appointment.tenant_id, v_appointment.branch_id, v_item.staff_member_id, v_shifted_start, v_shifted_end)
          and (
            select count(*) from public.appointment_items ai2
            where ai2.staff_member_id = v_item.staff_member_id
              and ai2.appointment_id <> p_appointment_id
              and ai2.appointment_status not in ('cancelled', 'no_show')
              and tstzrange(ai2.scheduled_start_at, ai2.scheduled_end_at) && tstzrange(v_shifted_start, v_shifted_end)
          ) < (
            select concurrent_capacity from public.staff_members where id = v_item.staff_member_id
          )
        ) then
          v_candidate_valid := false;
          exit;
        end if;
      end loop;

      if v_candidate_valid then
        v_result := v_result || to_jsonb(to_char(v_candidate_local_ts, 'HH24:MI'));
      end if;
    end if;

    v_candidate_local_ts := v_candidate_local_ts + interval '15 minutes';
  end loop;

  return v_result;
end;
$function$;
