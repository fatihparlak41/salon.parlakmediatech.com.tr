-- Fixes a real bug found during Faz 2F's own manual E2E verification:
-- the very first live booking attempt through the actual wizard UI
-- failed with a raw Postgres error ("new row for relation appointments
-- violates check constraint appointments_time_order") instead of a
-- BK00n code, because the appointments header's placeholder insert set
-- scheduled_end_at equal to scheduled_start_at.
--
-- Root cause: the header comment claimed this "mirrors
-- private.create_appointment's own two-phase pattern exactly", but that
-- was wrong — re-reading create_appointment's actual body shows it
-- never uses a same-value placeholder at all. It computes the real
-- range from MIN/MAX over the items joined against services.duration_minutes
-- BEFORE its first insert, so end_at is already correct (and different
-- from start_at) on that very first row. This function's placeholder
-- used p_scheduled_start_at for both columns, which can never satisfy
-- appointments_time_order (CHECK (scheduled_end_at > scheduled_start_at)).
--
-- Fix: fetch the service's duration_minutes alongside id/name (it was
-- already being validated, just not selected), and compute the
-- placeholder end time from it, same as create_appointment does. The
-- subsequent UPDATE after the item insert (setting the final, item-
-- authoritative start/end) is unchanged — that part was always correct.
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
  -- pattern of never leaving scheduled_end_at <= scheduled_start_at,
  -- computed here from the already-validated service duration (fixed:
  -- an earlier version of this function used p_scheduled_start_at for
  -- both columns, which always failed appointments_time_order).
  -- created_by is null: there is no auth.uid() for a guest request, and
  -- that's the correct signal (source already records provenance)
  -- rather than inventing a fake salon user to attribute it to.
  v_placeholder_end_at := p_scheduled_start_at + (v_service.duration_minutes || ' minutes')::interval;

  insert into public.appointments (
    tenant_id, branch_id, customer_id, source, scheduled_start_at, scheduled_end_at, created_by, idempotency_key
  )
  values (
    v_tenant.id, p_branch_id, v_customer_id, 'public_booking', p_scheduled_start_at, v_placeholder_end_at, null, p_idempotency_key
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
-- and the PUBLIC revoke from 20260822151000 — neither is reset by
-- replacing a function body with the same signature, but re-asserted
-- here anyway so this migration is independently correct even if read
-- in isolation.
revoke execute on function private.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid) from public;
