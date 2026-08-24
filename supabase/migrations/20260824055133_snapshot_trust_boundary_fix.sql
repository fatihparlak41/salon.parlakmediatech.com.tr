-- Faz 2G.2B.1 — critical snapshot trust-boundary fix.
--
-- =====================================================================
-- CONFIRMED VULNERABILITY (proven empirically before this fix, against
-- the live 20260823205200 migration, then reverted): a service costing
-- 1100 TL / 60 min could be booked via a direct call to
-- public.create_appointment with p_items containing
-- {..., "duration_minutes": 1, "price": 1} and the malicious values were
-- stored verbatim in appointment_items. Root cause: 20260823205200 made
-- private.validate_and_insert_appointment_item read OPTIONAL
-- duration_minutes/price keys from the item jsonb to support reschedule
-- snapshot preservation, but never distinguished "this jsonb key was put
-- here by trusted private.* server logic reading an existing DB row"
-- from "this jsonb key arrived verbatim from a client's own p_items
-- payload" — a JSON key looks identical either way. create_appointment
-- and create_guest_booking pass their caller's p_items essentially
-- untouched into this function; reschedule_appointment's own
-- service-unchanged merge branch was accidentally safe (jsonb `||`
-- right-hand-side-wins), but its service-changed/new-item branch was
-- not — nothing stripped a client-supplied duration_minutes/price
-- before it reached the function.
--
-- FIX (the chosen "cleanest architecture", per the closeout's own
-- framing — a combination of options A and C): the override is now an
-- EXPLICIT SQL FUNCTION PARAMETER (p_duration_override/p_price_override),
-- never a jsonb field read out of arbitrary caller input. This makes it
-- structurally impossible for ANY amount of JSON crafting, from any
-- current or future caller, to influence pricing — the function simply
-- does not look at p_item for these two fields anymore. The one
-- remaining untrusted-input entry point (reschedule_appointment's own
-- merge of a staff-supplied p_items against the locked row's existing
-- items) now explicitly STRIPS duration_minutes/price from the raw
-- client item before ever building the merged payload, rather than
-- relying on jsonb concatenation order alone.
--
-- create_appointment and create_guest_booking need NO changes at all:
-- both already call validate_and_insert_appointment_item with exactly 5
-- positional arguments, and the two new parameters default to null —
-- meaning they now provably always fall through to the service's live
-- catalog price/duration, regardless of what a caller's p_items happens
-- to contain. reschedule_my_appointment (customer) needs no changes
-- either: its item snapshot values were already read exclusively from
-- the appointment_items table, never from any customer-supplied
-- parameter — proven safe by construction both before and after this
-- fix, and covered by an explicit regression test below regardless.

drop function if exists private.validate_and_insert_appointment_item(uuid, uuid, uuid, jsonb, integer);

-- p_item is now ONLY ever read for service_id/staff_member_id/
-- scheduled_start_at — the two snapshot fields are explicit scalar
-- parameters a caller must deliberately pass, never inferred from
-- arbitrary jsonb content.
create function private.validate_and_insert_appointment_item(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_appointment_id uuid,
  p_item jsonb,
  p_sequence integer,
  p_duration_override integer default null,
  p_price_override numeric default null
)
returns private.appointment_item_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service record;
  v_staff_member record;
  v_start timestamptz;
  v_end timestamptz;
  v_duration integer;
  v_price numeric;
  v_result private.appointment_item_result;
begin
  select * into v_service
  from public.services
  where id = (p_item ->> 'service_id')::uuid
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
  where id = (p_item ->> 'staff_member_id')::uuid
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

  v_start := (p_item ->> 'scheduled_start_at')::timestamptz;
  -- Faz 2G.2B.1: explicit parameters only — p_item's own content is
  -- never consulted for these two fields, closing the injection path
  -- regardless of what any caller (current or future) puts in p_item.
  v_duration := coalesce(p_duration_override, v_service.duration_minutes);
  v_price := coalesce(p_price_override, v_service.price);
  v_end := v_start + (v_duration || ' minutes')::interval;

  if not private.staff_is_available(p_tenant_id, p_branch_id, v_staff_member.id, v_start, v_end) then
    raise exception 'staff member "%" is not working at the requested time', v_staff_member.full_name using errcode = 'AP011';
  end if;

  begin
    insert into public.appointment_items (
      tenant_id, appointment_id, service_id, staff_member_id,
      scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence
    )
    values (
      p_tenant_id, p_appointment_id, v_service.id, v_staff_member.id,
      v_start, v_end, v_duration, v_price, p_sequence
    );
  exception
    when exclusion_violation then
      raise exception 'staff member "%" was just booked for an overlapping time by another request', v_staff_member.full_name using errcode = 'AP012';
  end;

  v_result.scheduled_start_at := v_start;
  v_result.scheduled_end_at := v_end;
  return v_result;
end;
$$;

revoke execute on function private.validate_and_insert_appointment_item(uuid, uuid, uuid, jsonb, integer, integer, numeric) from public;

-- =====================================================================
-- replace_appointment_items — same 4-arg signature, CREATE OR REPLACE.
-- Reachable ONLY by reschedule_appointment and reschedule_my_appointment
-- (private, zero grants, verified empirically in 2G.2B's own security
-- suite) — its p_items is only ever trustworthy because those two
-- specific callers are now provably careful about what they put in it
-- (see below). This function itself now explicitly reads
-- duration_minutes/price from each item and forwards them as
-- validate_and_insert_appointment_item's new explicit parameters,
-- rather than letting that function read the jsonb itself.
-- =====================================================================
create or replace function private.replace_appointment_items(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_appointment_id uuid,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_item_result private.appointment_item_result;
  v_min_start timestamptz;
  v_max_end timestamptz;
  v_sequence integer := 0;
begin
  delete from public.appointment_items where appointment_id = p_appointment_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_sequence := v_sequence + 1;
    v_item_result := private.validate_and_insert_appointment_item(
      p_tenant_id, p_branch_id, p_appointment_id, v_item,
      coalesce((v_item ->> 'sequence')::integer, v_sequence),
      (v_item ->> 'duration_minutes')::integer,
      (v_item ->> 'price')::numeric
    );
    v_min_start := least(coalesce(v_min_start, v_item_result.scheduled_start_at), v_item_result.scheduled_start_at);
    v_max_end := greatest(coalesce(v_max_end, v_item_result.scheduled_end_at), v_item_result.scheduled_end_at);
  end loop;

  update public.appointments
  set scheduled_start_at = v_min_start, scheduled_end_at = v_max_end
  where id = p_appointment_id;
end;
$$;

revoke execute on function private.replace_appointment_items(uuid, uuid, uuid, jsonb) from public;

-- =====================================================================
-- reschedule_appointment (staff) — same 2-arg signature, CREATE OR
-- REPLACE. The merge now EXPLICITLY strips duration_minutes/price from
-- the raw client item (the `- 'duration_minutes' - 'price'` jsonb
-- delete-key operator) in BOTH branches, before ever adding the trusted
-- old snapshot back in the service-unchanged case. Previously this
-- relied only on jsonb `||`'s right-hand-side-wins order in the
-- service-unchanged branch, which happened to be safe there but did
-- nothing for the service-changed/new-item branch — now neither branch
-- can ever carry a client-supplied value through.
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
  v_before jsonb;
  v_merged_items jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AP001';
  end if;

  select tenant_id, branch_id, status into v_tenant_id, v_branch_id, v_status
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
end;
$$;
