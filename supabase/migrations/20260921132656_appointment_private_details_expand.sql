-- Faz SAAS.1E.1 (part 7A of 7A+7B — EXPAND half) — appointment private-details RPC.
--
-- Replaces the original combined 20260921132656_appointment_private_fields_hidden.sql,
-- which bundled this RPC together with the column-level REVOKE that hides
-- appointments.notes / appointment_items.price from `authenticated`. That combined form
-- never reached PROD and is being split before release: the currently-deployed
-- application (pre-SAAS.1E.1) reads appointments.notes and appointment_items.price
-- directly, so revoking those columns before the new application code is live would
-- break the appointment-detail screen for every real user in the gap between migration
-- apply and Vercel deployment. See the SAAS.1E.1 staged-release compatibility audit.
--
-- This half only ADDS the new RPC. It touches zero existing grant — applying it alone
-- is a no-op for the currently-deployed application, which never calls it.
--
-- The column-level REVOKE (7B) is a separate, later migration, applied only once the
-- new application (which calls this RPC instead of reading the columns directly) is
-- confirmed serving all production traffic. 7A and 7B together are semantically
-- equivalent to the original combined migration.
--
--   get_appointment_private_details(tenant, appointment)
--     -> { visible, notes, prices: { <item id>: <price> } }
--
-- DB-authoritative and permission-based (never a role name):
--   * appointments.view in the tenant is required at all (else it raises);
--   * appointments.update — the permission to WORK the appointment, held by
--     Salon Sahibi, Yönetici and Resepsiyon and not by Personel — releases
--     the values; without it the function answers { visible: false, notes:
--     null, prices: {} } and nothing else;
--   * tenant-bound on both tables; an id from another tenant yields nothing.

create or replace function private.get_appointment_private_details(
  p_tenant_id uuid,
  p_appointment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_notes text;
  v_prices jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not private.has_permission(p_tenant_id, 'appointments.view') then
    raise exception 'appointments.view required';
  end if;

  -- Notes and price snapshots belong to whoever works the appointment. A
  -- view-only caller learns only that they are not shown.
  if not private.has_permission(p_tenant_id, 'appointments.update') then
    return jsonb_build_object('visible', false, 'notes', null, 'prices', '{}'::jsonb);
  end if;

  select a.notes into v_notes
  from public.appointments a
  where a.id = p_appointment_id
    and a.tenant_id = p_tenant_id;

  -- ai.price::text, not the bare numeric: jsonb_object_agg would otherwise
  -- serialize it as a native JSON number, breaking this codebase's
  -- money-round-trips-as-text convention (every other price in the app
  -- comes from PostgREST's own numeric-as-string serialization — see
  -- services.price / appointment_items.price elsewhere, always read with
  -- String(...) on the TypeScript side).
  select coalesce(jsonb_object_agg(ai.id::text, ai.price::text), '{}'::jsonb) into v_prices
  from public.appointment_items ai
  where ai.appointment_id = p_appointment_id
    and ai.tenant_id = p_tenant_id;

  return jsonb_build_object('visible', true, 'notes', v_notes, 'prices', v_prices);
end;
$$;

create or replace function public.get_appointment_private_details(
  p_tenant_id uuid,
  p_appointment_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_appointment_private_details(p_tenant_id, p_appointment_id);
$$;

revoke execute on function private.get_appointment_private_details(uuid, uuid) from public;
revoke execute on function public.get_appointment_private_details(uuid, uuid) from public;
grant execute on function public.get_appointment_private_details(uuid, uuid) to authenticated;
