-- Corrects 20260821121500's search_customers: it was SECURITY INVOKER on
-- the theory that RLS would apply "for free" the same way it does for a
-- direct table query. That theory was wrong in a specific way, confirmed
-- empirically: a SECURITY INVOKER function's own body calling a
-- private.* helper (normalize_phone/normalize_email here) executes that
-- nested call under the INVOKER's privileges too — and authenticated has
-- no USAGE on the private schema at all (deliberate, from Phase 2A.1).
-- RLS policies get away with calling private.* because policy-expression
-- evaluation is not an ordinary function call in this sense; an ordinary
-- SECURITY INVOKER function (SQL or plpgsql — both were tested directly
-- against DEV and both failed identically) does not get the same
-- exemption. Every other function in this schema that needs to call
-- private.* helpers is SECURITY DEFINER with its own explicit
-- has_permission() check (create_appointment, reschedule_appointment,
-- update_role_permissions, ...) — this now matches that same, only
-- reliable pattern instead of being the one exception. Do not edit
-- 20260821121500 — it was already applied; correct forward.
create or replace function public.search_customers(
  p_tenant_id uuid,
  p_query text default '',
  p_status text default 'active',
  p_limit integer default 30,
  p_offset integer default 0
)
returns setof public.customers
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not private.has_permission(p_tenant_id, 'customers.view') then
    raise exception 'customers.view required';
  end if;

  return query
  select c.*
  from public.customers c
  where c.tenant_id = p_tenant_id
    and c.deleted_at is null
    and (p_status = 'all' or c.status = p_status)
    and (
      p_query = ''
      or c.full_name ilike '%' || p_query || '%'
      or c.phone_normalized ilike '%' || private.normalize_phone(p_query) || '%'
      or c.email_normalized ilike '%' || private.normalize_email(p_query) || '%'
    )
  order by c.full_name
  limit least(coalesce(p_limit, 30), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.search_customers(uuid, text, text, integer, integer) is
  'SECURITY DEFINER with an explicit has_permission(p_tenant_id, ''customers.view'') check — not SECURITY INVOKER, see this migration''s own comment for why that does not work here. p_status: ''active'' (default) | ''archived'' | ''all''. p_limit capped at 100 server-side regardless of what the caller asks for. has_permission() itself is what makes an arbitrary/foreign p_tenant_id safe to accept as a parameter: a caller with no membership in that tenant gets false, not a bypass.';

revoke execute on function public.search_customers(uuid, text, text, integer, integer) from public;
grant execute on function public.search_customers(uuid, text, text, integer, integer) to authenticated;
