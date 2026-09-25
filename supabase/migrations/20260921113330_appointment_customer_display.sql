-- Faz SAAS.1E.1 (part 4) — the appointment-scoped customer DISPLAY projection.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- Every appointment screen (calendar, list, detail, dashboard "today")
-- embeds customers(full_name) through PostgREST. The customers table is
-- readable only with customers.view, so a member who can see appointments but
-- lacks customers.view — Personel, by design — gets a placeholder instead of
-- a name: RLS silently omits the embedded row. Granting customers.view would
-- fix the name but hand over the whole directory: phone, e-mail, notes,
-- account linkage, archived customers, everything.
--
-- This migration adds the ONE thing Personel legitimately needs: for
-- appointments the caller can already see, the customer's DISPLAY NAME.
--
--   get_appointment_customer_display(tenant, appointment_ids[])
--     -> (appointment_id, customer_display_name)
--
-- It is DB-authoritative — not a frontend filter:
--   * SECURITY DEFINER, so it can read the customers row the caller's RLS
--     hides; but it returns ONLY appointments.id and customers.full_name.
--     Never phone, e-mail, notes, status, account/user linkage, created_by,
--     timestamps or any other column, and never a customer that is not
--     attached to one of the requested appointments.
--   * Requires appointments.view IN THE REQUESTED TENANT — exactly the
--     permission that already makes those appointment rows visible to the
--     caller (the appointments SELECT policy is tenant-wide). Without it the
--     call raises; it cannot be used to read anything a caller could not
--     already see the appointment for.
--   * Tenant-bound on both sides: appointments.tenant_id = the argument AND
--     customers.tenant_id = appointments.tenant_id. An appointment id from
--     another tenant simply yields no row (no error, no oracle).
--   * Bounded: at most 500 ids per call (the largest page any screen needs).
--
-- Personel's tenant-wide visibility of appointments is unchanged; the
-- customers table and customers.view are untouched, so nobody gains
-- customer-directory access and nobody who has customers.view loses
-- anything (the app simply reads names through this one path for everyone).
--
-- The function is wrapped in a public definer function (PostgREST only
-- exposes public) granted to authenticated only; anon and PUBLIC get nothing.

create or replace function private.get_appointment_customer_display(
  p_tenant_id uuid,
  p_appointment_ids uuid[]
)
returns table(appointment_id uuid, customer_display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not private.has_permission(p_tenant_id, 'appointments.view') then
    raise exception 'appointments.view required';
  end if;

  if p_appointment_ids is null or cardinality(p_appointment_ids) = 0 then
    return;
  end if;

  if cardinality(p_appointment_ids) > 500 then
    raise exception 'too_many_appointment_ids';
  end if;

  return query
  select a.id, c.full_name
  from public.appointments a
  join public.customers c
    on c.id = a.customer_id
   and c.tenant_id = a.tenant_id
  where a.tenant_id = p_tenant_id
    and a.id = any (p_appointment_ids);
end;
$$;

create or replace function public.get_appointment_customer_display(
  p_tenant_id uuid,
  p_appointment_ids uuid[]
)
returns table(appointment_id uuid, customer_display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.get_appointment_customer_display(p_tenant_id, p_appointment_ids);
$$;

revoke execute on function private.get_appointment_customer_display(uuid, uuid[]) from public;
revoke execute on function public.get_appointment_customer_display(uuid, uuid[]) from public;
grant execute on function public.get_appointment_customer_display(uuid, uuid[]) to authenticated;
