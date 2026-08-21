-- Phase 2C: customer phone/email normalization + server-side search.
--
-- GENUINE NEED (not convenience): public booking (future) and "thousands
-- of customers per salon" search both require a deterministic way to
-- match "0555 123 45 67" against "+90 555 1234567" against "5551234567"
-- without assuming a country. private.normalize_phone() strips
-- everything but digits and a leading '+' — no Turkish-specific
-- assumption (no forced country code, no fixed digit count), so it holds
-- up if SalonOS expands beyond Turkey. Email normalization is simpler
-- (trim + lowercase) but kept as its own function for the same "one
-- definition, reused everywhere" reason.
--
-- Deliberately NOT a hard uniqueness constraint on either field —
-- families share phone numbers, numbers get recycled, some customers
-- have no email at all. This is match-and-warn infrastructure, not
-- dedup-and-merge.
create or replace function private.normalize_phone(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
$$;

create or replace function private.normalize_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(lower(trim(coalesce(p_email, ''))), '');
$$;

-- Generated columns, not a trigger: always in sync with phone/email by
-- construction, queryable/indexable directly, and computed once at
-- write time rather than on every read. Both functions must be callable
-- by whichever role performs the customers INSERT/UPDATE that triggers
-- generation — granted below, same reasoning as private.is_tenant_member/
-- has_permission already being directly grantable to authenticated for
-- the same "evaluated as part of the caller's own statement" reason.
revoke execute on function private.normalize_phone(text) from public;
revoke execute on function private.normalize_email(text) from public;
grant execute on function private.normalize_phone(text) to authenticated;
grant execute on function private.normalize_email(text) to authenticated;

alter table public.customers
  add column phone_normalized text generated always as (private.normalize_phone(phone)) stored,
  add column email_normalized text generated always as (private.normalize_email(email)) stored;

comment on column public.customers.phone_normalized is
  'Digits + leading "+" only, derived from phone. Used for search/duplicate matching — never displayed. Country-agnostic on purpose (see supabase/migrations/README.md "Phase 2C").';
comment on column public.customers.email_normalized is
  'trim+lowercase of email. Used for search/duplicate matching.';

create index customers_tenant_phone_normalized_idx
  on public.customers (tenant_id, phone_normalized)
  where deleted_at is null and phone_normalized is not null;

create index customers_tenant_email_normalized_idx
  on public.customers (tenant_id, email_normalized)
  where deleted_at is null and email_normalized is not null;

-- Search RPC: not a security boundary (RLS already applies to
-- SECURITY INVOKER — no privilege bridge needed here, unlike the
-- write-side RPCs elsewhere in this schema), but a correctness one.
-- PostgREST's `.or()` filter takes a raw client-built string; splicing a
-- user's search term into it directly is fragile (commas/parens/periods
-- are syntax in that mini-language) and would duplicate the
-- normalization logic client-side. Here the search term is a plain bound
-- function parameter — normalized exactly like the stored columns, in
-- exactly one place — and ILIKE against three columns is expressed
-- directly in SQL instead.
create or replace function public.search_customers(
  p_tenant_id uuid,
  p_query text default '',
  p_include_archived boolean default false,
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
    and (p_include_archived or c.status = 'active')
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

comment on function public.search_customers(uuid, text, boolean, integer, integer) is
  'Read-only, SECURITY INVOKER — RLS on customers (customers.view) is what actually authorizes this, same as querying the table directly would be. Exists for query-construction safety (avoids splicing a raw search term into a PostgREST .or() filter string) and to apply the exact same normalization used by phone_normalized/email_normalized in one place. p_limit capped at 100 server-side regardless of what the caller asks for.';

revoke execute on function public.search_customers(uuid, text, boolean, integer, integer) from public;
grant execute on function public.search_customers(uuid, text, boolean, integer, integer) to authenticated;
