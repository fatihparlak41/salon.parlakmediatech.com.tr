-- Faz 5A.2 — close the completion bypass. Locked decision: OPTION A.
-- update_appointment_status must no longer accept 'completed' as a
-- target — every completion must go through public.complete_appointment
-- (Faz 5A.1), so actual-performer capture is never skippable. This is
-- the only behavior change in this function: every other transition
-- (confirmed/in_progress/cancelled/no_show) is completely unchanged —
-- same checks, same order, same permissions, same AP0nn codes.
--
-- New rejection uses AP017, not the generic AP015 "invalid target
-- status": 'completed' is a real, valid appointment status (unlike a
-- garbage/typo'd string), simply no longer reachable through this
-- function — a caller needs a different, more specific answer than
-- "invalid status" to understand what to do instead. Checked at the
-- same point AP015 already is (immediately after auth, before the
-- appointment lookup/permission checks) — matching this function's own
-- existing precedent that shape validation happens before existence or
-- authorization are even considered (see
-- tests/phase2d-appointments-flow.test.ts's own comment: "AP013 —
-- ...checked after AP015's status-shape validation").
--
-- Every application-code and test caller that sent 'completed' here has
-- been migrated to complete_appointment as part of this same phase — see
-- the Faz 5A.2 report for the exhaustive caller audit.
create or replace function private.update_appointment_status(
  p_appointment_id uuid,
  p_new_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_old_status text;
  v_required_permission text;
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
end;
$$;
