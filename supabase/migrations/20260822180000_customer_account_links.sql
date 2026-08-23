-- Faz 2G.1 — the one new table Phase 2G.0's architecture review proposed:
-- connects a global Supabase Auth identity (auth.users, via the existing
-- public.profiles) to zero, one, or many tenant-scoped CRM customer rows.
-- Never a second identity table, never a flag on auth/profiles — see
-- this migration's own header for why: staff (tenant_memberships) and
-- customer (this table) access are or independent already, and profiles
-- was already generic/tenant-agnostic before this phase touched anything.
--
-- Cardinality (corrected from the original 2G.0 proposal, which wrongly
-- capped one link per tenant+user — that would have made legitimate
-- future retroactive-claim work destructive, forcing a CRM merge):
--   customers row       -> at most ONE active linked account (ever)
--   account (user_id)   -> zero or MANY customers rows, including
--                          several within the SAME tenant
--   account + tenant    -> at most ONE of those links may be PRIMARY;
--                          new authenticated bookings resolve/create
--                          through the primary link only
--
-- Structural (not just app-level) tenant-consistency guarantee: a
-- composite foreign key against customers(id, tenant_id) makes it
-- impossible to insert a link row whose tenant_id disagrees with the
-- customer it points at — the database rejects the mismatch outright,
-- not a check this project trusts application code to get right. This
-- needs customers to expose (id, tenant_id) as a referenceable unique
-- key first; customers.id is already unique (primary key), so adding
-- (id, tenant_id) is a redundant-but-valid second unique constraint,
-- not a new restriction on any existing row.
alter table public.customers
  add constraint customers_id_tenant_id_key unique (id, tenant_id);

create table public.customer_account_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id),
  customer_id uuid not null,
  -- Controlled provenance vocabulary, not a free-text field the browser
  -- could ever populate with anything else — only 'future_booking' is
  -- actually produced by any code in this phase; the other two values
  -- are allowed now so a later phase implementing them needs no schema
  -- migration, only new code that starts using an already-legal value.
  claimed_via text not null check (claimed_via in ('future_booking', 'verified_booking_claim', 'salon_assisted')),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint customer_account_links_customer_tenant_fkey
    foreign key (customer_id, tenant_id) references public.customers (id, tenant_id)
);

-- One CRM customer row is actively claimed by at most one account.
create unique index customer_account_links_customer_unique_active_idx
  on public.customer_account_links (tenant_id, customer_id)
  where deleted_at is null;

-- At most one PRIMARY link per (tenant, account) — the canonical CRM
-- row a new authenticated booking in that tenant resolves to. Does NOT
-- limit how many non-primary links the same account may hold in the
-- same tenant (historical duplicate CRM records, once retroactive claim
-- exists, may all point at one account without merging them).
create unique index customer_account_links_primary_unique_active_idx
  on public.customer_account_links (tenant_id, user_id)
  where deleted_at is null and is_primary = true;

-- Read path only, and only for a caller's own rows — matches every
-- other identity-scoped table in this project (profiles' own
-- id = auth.uid() policies). No INSERT/UPDATE/DELETE policy: every
-- write goes through a SECURITY DEFINER boundary (this phase:
-- private.create_guest_booking's authenticated-booking path), never a
-- direct client mutation, so there is nothing here for such a policy to
-- safely permit. No GRANT to anon/authenticated is added in this
-- migration either — the customer portal is designed to consume narrow
-- RPCs (get_my_appointments etc.), not query this table directly; this
-- policy exists as defense-in-depth for if/when a genuine UI need for
-- direct SELECT ever arises, not because one exists today.
alter table public.customer_account_links enable row level security;

create policy customer_account_links_select_own
  on public.customer_account_links
  for select
  using (user_id = auth.uid());
