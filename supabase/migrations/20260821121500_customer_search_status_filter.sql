-- Corrects 20260821120000's search_customers: p_include_archived boolean
-- only supported "active only" or "active + archived together" (union),
-- which cannot express the dedicated "archived view" the customer list
-- needs (to find someone to reactivate) once active customers outnumber
-- one page — archived rows could be pushed off the page entirely with no
-- way to see just them. Replaces it with an explicit status filter.
-- Found before any UI/test depended on the old signature. Do not edit
-- 20260821120000 — it was already applied; correct forward.
drop function if exists public.search_customers(uuid, text, boolean, integer, integer);

create or replace function public.search_customers(
  p_tenant_id uuid,
  p_query text default '',
  p_status text default 'active',
  p_limit integer default 30,
  p_offset integer default 0
)
returns setof public.customers
language sql
security invoker
stable
set search_path = ''
as $$
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
$$;

comment on function public.search_customers(uuid, text, text, integer, integer) is
  'Read-only, SECURITY INVOKER — RLS on customers (customers.view) is what actually authorizes this. p_status: ''active'' (default) | ''archived'' | ''all''. p_limit capped at 100 server-side regardless of what the caller asks for.';

revoke execute on function public.search_customers(uuid, text, text, integer, integer) from public;
grant execute on function public.search_customers(uuid, text, text, integer, integer) to authenticated;
