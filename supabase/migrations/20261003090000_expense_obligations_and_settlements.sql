-- Faz FIN.1B.1 — Expense obligations and settlements. Manual operating expenses
-- (rent, electricity, supplies, ...) and the money actually paid out against
-- them. A separate ledger from FIN.1A: appointment_sales / payments are never
-- reused, touched or joined here.
--
-- =====================================================================
-- CORE PRINCIPLE
-- =====================================================================
-- An expense OBLIGATION is not a cash SETTLEMENT. Creating an expense never
-- implies money left the till; only a posted expense_payments row does. The
-- two live in two tables:
--
--   expense_categories - global reference catalog (16 fixed/variable keys)
--   expenses           - one row per obligation (accrual: expense_date, due_date)
--   expense_payments   - money actually paid out; never edited, never deleted,
--                        only voided (posted -> voided, one way)
--
-- No recurring templates, no template_id/period_start (FIN.1B.2), no payroll
-- (FIN.1C), no tax/VAT, no profit, no attachments. Nothing here is called
-- profit.
--
-- =====================================================================
-- LIFECYCLE (authoritative; enforced by trigger T1 below, not repeated in RPCs)
-- =====================================================================
-- posted total P = sum of posted payments (voided payments never count).
--   P = 0  : expense_date, branch_id, category_key, amount, due_date,
--            description, vendor_name, note are editable.
--   P > 0  : expense_date, branch_id, category_key are LOCKED; amount is
--            editable only to a value >= P; due_date, description,
--            vendor_name, note stay editable. To change attribution after a
--            payment, void the payments first.
--   cancelled: terminal, no edits. Cancel requires P = 0.
-- currency is a snapshot of the tenant currency at creation and is never
-- editable at any stage.
--
-- =====================================================================
-- VERSION (one owner: trigger T1)
-- =====================================================================
-- expenses.version protects update_expense against stale forms. It starts at 1
-- and is written by exactly two things: the column default on INSERT and
-- trigger T1 on UPDATE. No RPC assigns it. T1 increments it exactly once per
-- UPDATE statement that changes the aggregate:
--   * update_expense that really changes a field          (+1)
--   * cancel_expense                                       (+1)
--   * EVERY real settlement mutation: a posted payment insert or a void (+1),
--     even when the status enum stays the same
-- An idempotent replay or a genuine no-op executes no UPDATE and therefore
-- changes nothing. Create with an initial payment ends at version 2 (the
-- initial payment is a settlement mutation).
-- To make "every settlement mutation changes the aggregate" true without a
-- second version writer, expenses carries settlement_events: a DERIVED counter
-- (number of payment rows + number of voided rows) that trigger T3 refreshes
-- after every real payment insert or void, in the same UPDATE as the derived
-- status. T1 treats it as a tracked column, so one settlement mutation is one
-- tracked change is one version bump. It is verified against the payment rows
-- on every UPDATE exactly like status is.
--
-- =====================================================================
-- TRIGGERS (invariants only)
-- =====================================================================
-- T1 enforce_expense_invariants  (expenses, BEFORE INSERT OR UPDATE)
-- T2 enforce_expense_payment_invariants (expense_payments, BEFORE INSERT OR UPDATE)
-- T3 recalculate_expense_status  (expense_payments, AFTER INSERT OR UPDATE OF status)
-- They protect rules that must hold even if a future trusted code path writes
-- the tables directly: immutability, cancelled is terminal, structure lock and
-- amount floor after a posted payment, no overpayment, no payment on a
-- cancelled expense, payment rows are never edited and never un-voided, status
-- and settlement_events are derived from the payment rows, version bookkeeping.
-- They do NOT validate string shape, length or enum membership (table CHECKs
-- and the RPCs do), check permissions, write audit events or handle
-- idempotency.
--
-- =====================================================================
-- IDEMPOTENCY
-- =====================================================================
-- create_expense REQUIRES a non-null key (expenses.idempotency_key stays
-- nullable at table level so FIN.1B.2 recurring rows, which have none, fit).
-- The ORIGINAL create payload is fingerprinted (md5 over 13 length-prefixed
-- components: a schema tag plus 12 payload fields, Faz 2F.1 convention) and
-- stored; a replay compares that stored fingerprint, never the live row,
-- because an expense is editable afterwards. Same key + same fingerprint
-- returns the existing expense (noop); a different fingerprint is FN007. The
-- initial payment reuses the creation key inside expense_payments, in the same
-- transaction. record_expense_payment compares stored columns.
--
-- =====================================================================
-- ACCESS MODEL
-- =====================================================================
-- All three tables: RLS enabled, ZERO policies, ALL direct privileges revoked
-- from public/anon/authenticated/service_role (the FIN.1A / NOTIF.1A posture).
-- The only door in is the SECURITY DEFINER RPC surface below. Reads need
-- finance.view, writes finance.manage (existing keys, no new permission, no
-- role-name checks). Write RPCs return only ids/status/version/noop; read
-- models are curated PII-free jsonb (no user ids, no idempotency data).
--
-- SQLSTATE taxonomy (FN001-FN013): FN001 unauthenticated, FN002 forbidden,
-- FN003 expense not found, FN004 invalid input, FN005 payment exceeds the
-- remaining amount, FN006 invalid payment method, FN007 idempotency conflict,
-- FN008 expense is cancelled, FN009 payment not found, FN010 unused here
-- (appointment-only in FIN.1A), FN011 cancel blocked by posted payments,
-- FN012 change conflicts with posted payments / internal invariant,
-- FN013 stale expected version.

begin;

-- =====================================================================
-- 1. TABLES
-- =====================================================================
create table public.expense_categories (
  key text primary key,
  kind text not null,
  display_order smallint not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint expense_categories_key_format check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint expense_categories_kind_check check (kind in ('fixed', 'variable')),
  constraint expense_categories_display_order_positive check (display_order > 0)
);

comment on table public.expense_categories is
  'Faz FIN.1B.1. Global reference catalog of expense categories (8 fixed, 8 variable), seeded by this migration and read only through list_expense_categories. is_active lets a category be retired without touching existing expenses. Labels live in messages/tr.json. No payroll, tax or VAT category exists.';

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  branch_id uuid references public.branches (id),
  category_key text not null references public.expense_categories (key),
  description text not null,
  vendor_name text,
  note text,
  expense_date date not null,
  due_date date,
  amount numeric(12, 2) not null,
  currency text not null,
  status text not null default 'open',
  version integer not null default 1,
  settlement_events integer not null default 0,
  idempotency_key uuid,
  idempotency_fingerprint text,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id),
  cancel_reason text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expenses_description_length check (char_length(btrim(description)) between 1 and 200),
  constraint expenses_vendor_name_length check (vendor_name is null or char_length(btrim(vendor_name)) between 1 and 200),
  constraint expenses_note_length check (note is null or char_length(btrim(note)) between 1 and 500),
  constraint expenses_expense_date_range check (expense_date between date '2000-01-01' and date '2100-12-31'),
  constraint expenses_due_date_range check (due_date is null or (due_date >= expense_date and due_date <= date '2100-12-31')),
  constraint expenses_amount_positive check (amount > 0),
  constraint expenses_currency_not_blank check (char_length(btrim(currency)) > 0),
  constraint expenses_status_check check (status in ('open', 'partially_paid', 'paid', 'cancelled')),
  constraint expenses_version_positive check (version >= 1),
  constraint expenses_settlement_events_nonnegative check (settlement_events >= 0),
  constraint expenses_idempotency_coherent check ((idempotency_key is null) = (idempotency_fingerprint is null)),
  constraint expenses_fingerprint_format check (idempotency_fingerprint is null or idempotency_fingerprint ~ '^[0-9a-f]{32}$'),
  constraint expenses_cancel_state_consistent check (
    (status = 'cancelled' and cancelled_at is not null and cancel_reason is not null)
    or (status <> 'cancelled' and cancelled_at is null and cancelled_by is null and cancel_reason is null)
  ),
  constraint expenses_cancel_reason_length check (cancel_reason is null or char_length(btrim(cancel_reason)) between 1 and 500),
  constraint expenses_id_tenant_unique unique (id, tenant_id),
  constraint expenses_idempotency_key_unique unique (tenant_id, idempotency_key)
);

comment on table public.expenses is
  'Faz FIN.1B.1. One row per expense OBLIGATION (accrual). It never records that money was paid: that is expense_payments. status is derived (open/partially_paid/paid by trigger T3, cancelled by cancel_expense) and overdue is never stored. version and settlement_events are trigger-managed (see the migration header). branch_id null means "Genel" (not allocated to a branch). currency is a tenant-currency snapshot and never editable. idempotency_key is nullable at table level on purpose: only create_expense requires it; FIN.1B.2 recurring rows will have none.';

create table public.expense_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  expense_id uuid not null,
  amount numeric(12, 2) not null,
  method text not null,
  paid_at timestamptz not null default now(),
  note text,
  status text not null default 'posted',
  idempotency_key uuid not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  voided_by uuid references auth.users (id),
  voided_at timestamptz,
  void_reason text,
  constraint expense_payments_expense_fk foreign key (expense_id, tenant_id) references public.expenses (id, tenant_id),
  constraint expense_payments_amount_positive check (amount > 0),
  constraint expense_payments_method_check check (method in ('cash', 'card', 'bank_transfer', 'other')),
  constraint expense_payments_paid_at_floor check (paid_at >= timestamptz '2000-01-01 00:00:00+00'),
  constraint expense_payments_note_length check (note is null or char_length(btrim(note)) between 1 and 500),
  constraint expense_payments_status_check check (status in ('posted', 'voided')),
  constraint expense_payments_void_state_consistent check (
    (status = 'posted' and voided_at is null and voided_by is null and void_reason is null)
    or (status = 'voided' and voided_at is not null and void_reason is not null)
  ),
  constraint expense_payments_void_reason_length check (void_reason is null or char_length(btrim(void_reason)) between 1 and 500),
  constraint expense_payments_idempotency_key_unique unique (tenant_id, idempotency_key)
);

comment on table public.expense_payments is
  'Faz FIN.1B.1. Money actually paid out against an expense. Append-only: a row is never edited and never deleted; an incorrect payment is voided (posted -> voided, one way, void fields set) and kept as evidence. The composite FK keeps a payment in its expense''s tenant. No branch or currency of its own: both come from the expense. idempotency_key (unique per tenant) makes a retried record_expense_payment safe.';

create index expenses_tenant_date_idx on public.expenses (tenant_id, expense_date desc, id desc);
create index expenses_tenant_outstanding_due_idx on public.expenses (tenant_id, due_date, id) where status in ('open', 'partially_paid');
create index expense_payments_expense_idx on public.expense_payments (expense_id, paid_at, id);
create index expense_payments_tenant_paid_at_idx on public.expense_payments (tenant_id, paid_at) where status = 'posted';

-- =====================================================================
-- 2. LOCKDOWN — RLS on, zero policies, all direct grants revoked. The only
--    access path is the SECURITY DEFINER RPC surface below.
-- =====================================================================
alter table public.expense_categories enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_payments enable row level security;

revoke all on public.expense_categories from public, anon, authenticated, service_role;
revoke all on public.expenses from public, anon, authenticated, service_role;
revoke all on public.expense_payments from public, anon, authenticated, service_role;

-- =====================================================================
-- 3. CATEGORY SEED — idempotent; never touches is_active, so a retired
--    category stays retired when this is re-run.
-- =====================================================================
insert into public.expense_categories (key, kind, display_order) values
  ('rent', 'fixed', 10),
  ('electricity', 'fixed', 20),
  ('water', 'fixed', 30),
  ('internet', 'fixed', 40),
  ('phone', 'fixed', 50),
  ('accountant', 'fixed', 60),
  ('software', 'fixed', 70),
  ('pos_fees', 'fixed', 80),
  ('supplies', 'variable', 110),
  ('beauty_products', 'variable', 120),
  ('cleaning', 'variable', 130),
  ('advertising', 'variable', 140),
  ('food', 'variable', 150),
  ('transport', 'variable', 160),
  ('repairs', 'variable', 170),
  ('other', 'variable', 180)
on conflict (key) do update set kind = excluded.kind, display_order = excluded.display_order;

-- =====================================================================
-- 4. HELPERS (private; no API-role grant)
-- =====================================================================

-- H1. The one place status derivation lives. Never returns 'cancelled'.
create function private.compute_expense_status(p_amount numeric, p_posted numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_posted is null or p_posted <= 0 then 'open'
    when p_posted >= p_amount then 'paid'
    else 'partially_paid'
  end;
$$;

comment on function private.compute_expense_status(numeric, numeric) is
  'Faz FIN.1B.1. Pure derivation: posted <= 0 -> open; posted >= amount -> paid; else partially_paid. Never returns cancelled (that is an explicit state set only by cancel_expense).';

-- H2. The one definition of "posted total": posted payments only, voided never count.
create function private.expense_posted_total(p_expense_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(p.amount), 0)::numeric(12, 2)
  from public.expense_payments p
  where p.expense_id = p_expense_id and p.status = 'posted';
$$;

comment on function private.expense_posted_total(uuid) is
  'Faz FIN.1B.1. Sum of the POSTED payments of one expense (voided rows never count). The single definition used by the triggers, the RPCs and the read models.';

-- H2b. Derived settlement counter: one event per payment row inserted plus one per void.
create function private.expense_settlement_events(p_expense_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select (count(*) + count(*) filter (where p.status = 'voided'))::integer
  from public.expense_payments p
  where p.expense_id = p_expense_id;
$$;

comment on function private.expense_settlement_events(uuid) is
  'Faz FIN.1B.1. Number of settlement mutations applied to an expense: payment rows plus voided rows (each row was inserted once and voided at most once). Derived from the rows; expenses.settlement_events caches it so that every real settlement mutation changes the aggregate row and bumps version through trigger T1.';

-- H3. Tenant-local calendar date. No fallback: an unrecognized tenants.timezone is the same shared assumption the booking functions already make.
create function private.tenant_local_date(p_tenant_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone t.timezone)::date
  from public.tenants t
  where t.id = p_tenant_id;
$$;

comment on function private.tenant_local_date(uuid) is
  'Faz FIN.1B.1. (now() at time zone tenants.timezone)::date. Used for the default reference date of the expense reads and the upper bound of expense_date.';

-- H4. Text normalization: trim space, tab, CR, LF at both ends; blank becomes null. Nothing else is rewritten (no case folding, no inner-whitespace collapse, no Unicode normalization).
create function private.normalize_expense_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(p_text, ' ' || chr(9) || chr(10) || chr(13)), '');
$$;

comment on function private.normalize_expense_text(text) is
  'Faz FIN.1B.1. Trims space, tab, CR and LF from both ends; a blank result becomes null. Nothing else is normalized.';

-- H5. Amount normalization on an UNBOUNDED numeric: a bad value becomes a stable FN004, never a raw numeric overflow.
create function private.normalize_expense_amount(p_amount numeric)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v numeric;
begin
  if p_amount is null then
    raise exception 'amount required' using errcode = 'FN004';
  end if;
  if p_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'invalid amount' using errcode = 'FN004';
  end if;
  v := trim_scale(p_amount);
  if scale(v) > 2 or v <= 0 or v > 9999999999.99 then
    raise exception 'invalid amount' using errcode = 'FN004';
  end if;
  return v::numeric(12, 2);
end;
$$;

comment on function private.normalize_expense_amount(numeric) is
  'Faz FIN.1B.1. Rejects null, NaN and +/-Infinity, applies trim_scale (250.500 is 250.5), then requires at most 2 decimals and 0 < value <= 9999999999.99. Raises FN004 and returns the value as numeric(12,2).';

-- H6. Canonical fingerprint of the ORIGINAL create payload: a schema tag plus 12 payload fields = 13 components,
--     each rendered as length || ':' || value, joined with '|', hashed with md5 (Faz 2F.1 convention). The tenant is not
--     hashed (idempotency is tenant-scoped) and initial-payment presence is implied by its non-empty components.
create function private.expense_create_fingerprint(
  p_branch_id uuid,
  p_category_key text,
  p_expense_date date,
  p_due_date date,
  p_amount numeric,
  p_description text,
  p_vendor_name text,
  p_note text,
  p_ip_amount numeric,
  p_ip_method text,
  p_ip_paid_at timestamptz,
  p_ip_note text
)
returns text
language sql
immutable
set search_path = ''
as $$
  with fields as (
    select
      'expense.create.v1'::text as f0,
      coalesce(p_branch_id::text, 'GENERAL') as f1,
      p_category_key as f2,
      to_char(p_expense_date, 'YYYY-MM-DD') as f3,
      coalesce(to_char(p_due_date, 'YYYY-MM-DD'), 'NO_DUE') as f4,
      (p_amount::numeric(12, 2))::text as f5,
      p_description as f6,
      coalesce(p_vendor_name, '') as f7,
      coalesce(p_note, '') as f8,
      coalesce((p_ip_amount::numeric(12, 2))::text, '') as f9,
      coalesce(p_ip_method, '') as f10,
      coalesce(to_char(p_ip_paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), '') as f11,
      coalesce(p_ip_note, '') as f12
  )
  select md5(
    array_to_string(
      array[
        length(f0)::text || ':' || f0,
        length(f1)::text || ':' || f1,
        length(f2)::text || ':' || f2,
        length(f3)::text || ':' || f3,
        length(f4)::text || ':' || f4,
        length(f5)::text || ':' || f5,
        length(f6)::text || ':' || f6,
        length(f7)::text || ':' || f7,
        length(f8)::text || ':' || f8,
        length(f9)::text || ':' || f9,
        length(f10)::text || ':' || f10,
        length(f11)::text || ':' || f11,
        length(f12)::text || ':' || f12
      ],
      '|'
    )
  )
  from fields;
$$;

comment on function private.expense_create_fingerprint(uuid, text, date, date, numeric, text, text, text, numeric, text, timestamptz, text) is
  'Faz FIN.1B.1. md5 over 13 length-prefixed components in fixed order: tag expense.create.v1, branch (GENERAL when null), category, expense date, due date (NO_DUE when null), amount as numeric(12,2) text, description, vendor, note, initial amount, initial method, initial paid_at (UTC, microseconds), initial note; null optional values render as the empty string. Inputs must already be normalized. The tenant is not part of it (idempotency is tenant-scoped).';

-- H7. Stateless payment validation shared by record_expense_payment and the initial payment of create_expense.
create function private.normalize_expense_payment_input(
  p_amount numeric,
  p_method text,
  p_paid_at timestamptz,
  p_note text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_amount numeric;
  v_note text;
begin
  v_amount := private.normalize_expense_amount(p_amount);

  if p_method is null or p_method not in ('cash', 'card', 'bank_transfer', 'other') then
    raise exception 'invalid payment method' using errcode = 'FN006';
  end if;

  if p_paid_at is null
     or p_paid_at < timestamptz '2000-01-01 00:00:00+00'
     or p_paid_at > now() + interval '1 hour' then
    raise exception 'invalid payment date' using errcode = 'FN004';
  end if;

  v_note := private.normalize_expense_text(p_note);
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note too long' using errcode = 'FN004';
  end if;

  return jsonb_build_object(
    'amount', v_amount,
    'method', p_method,
    'paid_at', to_char(p_paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'note', v_note
  );
end;
$$;

comment on function private.normalize_expense_payment_input(numeric, text, timestamptz, text) is
  'Faz FIN.1B.1. Stateless payment validation: amount through normalize_expense_amount (FN004), method must be cash/card/bank_transfer/other (FN006), paid_at between 2000-01-01 and now() + 1 hour (FN004), note trimmed and at most 500 chars (FN004). Returns the normalized {amount, method, paid_at (UTC text with microseconds), note}.';

-- =====================================================================
-- 5. TRIGGERS — invariants only (see the header). Raised codes are the
--    stable FN taxonomy.
-- =====================================================================

-- T1. Obligation invariants and the single owner of version / updated_at.
create function private.enforce_expense_invariants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Columns an UPDATE may change. Everything else (id, tenant_id, currency, idempotency_*, created_*) is immutable by
  -- default, so a column added later stays immutable until it is deliberately added here.
  v_mutable constant text[] := array[
    'status', 'version', 'updated_at', 'settlement_events', 'branch_id', 'category_key', 'description',
    'vendor_name', 'note', 'expense_date', 'due_date', 'amount', 'cancelled_at', 'cancelled_by', 'cancel_reason'
  ];
  v_posted numeric(12, 2);
  v_events integer;
begin
  if tg_op = 'INSERT' then
    -- T1.1 A new obligation has no settlements yet.
    if new.status <> 'open' or new.version <> 1 or new.settlement_events <> 0 then
      raise exception 'a new expense must start open, version 1, with no settlement events' using errcode = 'FN012';
    end if;
    return new;
  end if;

  -- T1.2 Default-deny column immutability.
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'immutable expense column changed' using errcode = 'FN012';
  end if;

  -- T1.3 version is trigger-managed: a writer that sets it is rejected, so a double increment cannot happen silently.
  if new.version is distinct from old.version then
    raise exception 'version is managed by the trigger' using errcode = 'FN012';
  end if;

  -- Nothing tracked changed: a genuine no-op leaves version and updated_at alone.
  if (new.status, new.amount, new.expense_date, new.branch_id, new.category_key, new.due_date, new.description,
      new.vendor_name, new.note, new.cancelled_at, new.cancelled_by, new.cancel_reason, new.settlement_events)
     is not distinct from
     (old.status, old.amount, old.expense_date, old.branch_id, old.category_key, old.due_date, old.description,
      old.vendor_name, old.note, old.cancelled_at, old.cancelled_by, old.cancel_reason, old.settlement_events) then
    new.version := old.version;
    new.updated_at := old.updated_at;
    return new;
  end if;

  v_posted := private.expense_posted_total(old.id);
  v_events := private.expense_settlement_events(old.id);

  -- T1.4 Cancelled is terminal.
  if old.status = 'cancelled' then
    raise exception 'expense is cancelled' using errcode = 'FN008';
  end if;

  -- T1.5 Cancel needs a zero posted total.
  if new.status = 'cancelled' and v_posted > 0 then
    raise exception 'an expense with posted payments cannot be cancelled' using errcode = 'FN011';
  end if;

  if v_posted > 0 then
    -- T1.6 Structure lock after a posted payment.
    if new.expense_date <> old.expense_date
       or new.branch_id is distinct from old.branch_id
       or new.category_key <> old.category_key then
      raise exception 'date, branch and category are locked after a posted payment' using errcode = 'FN012';
    end if;
    -- T1.7 Amount floor.
    if new.amount < v_posted then
      raise exception 'amount cannot fall below the posted total' using errcode = 'FN012';
    end if;
  end if;

  -- T1.8 Status is derived from the posted payments.
  if new.status <> 'cancelled' and new.status <> private.compute_expense_status(new.amount, v_posted) then
    raise exception 'status must equal the derived status' using errcode = 'FN012';
  end if;

  -- T1.9 settlement_events is derived from the payment rows.
  if new.settlement_events <> v_events then
    raise exception 'settlement_events must equal the derived count' using errcode = 'FN012';
  end if;

  -- T1.10 Bookkeeping: a real aggregate change bumps version exactly once.
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

comment on function private.enforce_expense_invariants() is
  'Faz FIN.1B.1 trigger T1 (expenses, BEFORE INSERT OR UPDATE). Invariants only: a new row starts open/version 1; default-deny column immutability; version is trigger-managed; cancelled is terminal (FN008); cancel needs zero posted (FN011); after a posted payment expense_date/branch_id/category_key are locked and amount >= posted (FN012); status and settlement_events equal their derived values (FN012). The single owner of version and updated_at: one UPDATE that changes any tracked column bumps version exactly once, an UPDATE that changes none changes nothing. No input-shape validation, no permissions, no audit.';

-- T2. Payment ledger invariants.
create function private.enforce_expense_payment_invariants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount numeric(12, 2);
  v_status text;
  v_posted numeric(12, 2);
  v_voidable constant text[] := array['status', 'voided_at', 'voided_by', 'void_reason'];
begin
  if tg_op = 'INSERT' then
    if new.status = 'posted' then
      -- T2.1 / T2.2 Lock the parent so the checks cannot race with an edit, a cancel or another payment.
      select e.amount, e.status into v_amount, v_status
      from public.expenses e
      where e.id = new.expense_id and e.tenant_id = new.tenant_id
      for update;

      if found then
        if v_status = 'cancelled' then
          raise exception 'expense is cancelled' using errcode = 'FN008';
        end if;
        v_posted := private.expense_posted_total(new.expense_id);
        if v_posted + new.amount > v_amount then
          raise exception 'payment would exceed the expense amount' using errcode = 'FN005';
        end if;
      end if;
    end if;
    return new;
  end if;

  -- T2.3 Everything except the void block is immutable.
  if (to_jsonb(new) - v_voidable) is distinct from (to_jsonb(old) - v_voidable) then
    raise exception 'payment rows are not editable' using errcode = 'FN012';
  end if;

  -- T2.4 The only allowed transition is posted -> voided; a voided row is final (no un-void).
  if (new.status, new.voided_at, new.voided_by, new.void_reason)
     is distinct from
     (old.status, old.voided_at, old.voided_by, old.void_reason) then
    if not (old.status = 'posted' and new.status = 'voided') then
      raise exception 'a payment can only move from posted to voided' using errcode = 'FN012';
    end if;
  end if;

  return new;
end;
$$;

comment on function private.enforce_expense_payment_invariants() is
  'Faz FIN.1B.1 trigger T2 (expense_payments, BEFORE INSERT OR UPDATE). Invariants only: a posted insert locks the parent expense, refuses a cancelled parent (FN008) and refuses to push the posted total above the amount (FN005); an UPDATE may change nothing except the void block, and only posted -> voided (FN012); a voided row is final. No input-shape validation.';

-- T3. After a real settlement mutation, refresh the derived aggregate in ONE update (status and settlement_events).
create function private.recalculate_expense_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount numeric(12, 2);
  v_status text;
begin
  -- Not a settlement event: an UPDATE OF status that left the status as it was.
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return null;
  end if;

  select e.amount, e.status into v_amount, v_status
  from public.expenses e
  where e.id = new.expense_id
  for update;

  -- A cancelled parent is never touched.
  if not found or v_status = 'cancelled' then
    return null;
  end if;

  -- One UPDATE: status and settlement_events together. T1 turns it into exactly one version bump, even when the
  -- status enum is unchanged (a second partial payment, a void that leaves the expense partially paid).
  update public.expenses
  set status = private.compute_expense_status(v_amount, private.expense_posted_total(new.expense_id)),
      settlement_events = private.expense_settlement_events(new.expense_id)
  where id = new.expense_id;

  return null;
end;
$$;

comment on function private.recalculate_expense_status() is
  'Faz FIN.1B.1 trigger T3 (expense_payments, AFTER INSERT OR UPDATE OF status). After every real settlement mutation (a payment insert, or a status change such as a void) it recomputes the parent''s derived status and settlement_events in a single UPDATE, which trigger T1 converts into exactly one version bump. A cancelled parent is untouched.';

create trigger enforce_expense_invariants_trg
  before insert or update on public.expenses
  for each row
  execute function private.enforce_expense_invariants();

create trigger enforce_expense_payment_invariants_trg
  before insert or update on public.expense_payments
  for each row
  execute function private.enforce_expense_payment_invariants();

create trigger recalculate_expense_status_trg
  after insert or update of status on public.expense_payments
  for each row
  execute function private.recalculate_expense_status();

-- =====================================================================
-- 6. THE ONE WRITER OF expense_payments
-- =====================================================================
create function private.post_expense_payment(
  p_tenant_id uuid,
  p_expense_id uuid,
  p_amount numeric,
  p_method text,
  p_paid_at timestamptz,
  p_note text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  begin
    insert into public.expense_payments (
      tenant_id, expense_id, amount, method, paid_at, note, idempotency_key, created_by
    )
    values (
      p_tenant_id, p_expense_id, p_amount, p_method, p_paid_at, p_note, p_idempotency_key, auth.uid()
    )
    returning id into v_id;
  exception when unique_violation then
    raise exception 'idempotency key already used for another payment' using errcode = 'FN007';
  end;

  perform private.log_audit_event(
    p_tenant_id, 'finance.expense_payment_recorded', 'expense_payment', v_id,
    null,
    jsonb_build_object('expense_id', p_expense_id, 'amount', p_amount, 'method', p_method, 'paid_at', p_paid_at)
  );

  return v_id;
end;
$$;

comment on function private.post_expense_payment(uuid, uuid, numeric, text, timestamptz, text, uuid) is
  'Faz FIN.1B.1. The only writer of expense_payments. Takes already-normalized values, inserts the payment (triggers T2 and T3 fire), writes the finance.expense_payment_recorded audit event, returns the payment id. A unique-key race becomes FN007.';

-- =====================================================================
-- 7. WRITE RPCs (private implementations)
-- =====================================================================

create function private.create_expense(
  p_tenant_id uuid,
  p_category_key text,
  p_description text,
  p_expense_date date,
  p_amount numeric,
  p_idempotency_key uuid default null,
  p_branch_id uuid default null,
  p_vendor_name text default null,
  p_due_date date default null,
  p_note text default null,
  p_initial_payment jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_description text;
  v_vendor text;
  v_note text;
  v_amount numeric;
  v_has_initial boolean := false;
  v_ip_amount_raw numeric;
  v_ip_method_raw text;
  v_ip_paid_at_raw timestamptz;
  v_ip_note_raw text;
  v_ip_norm jsonb;
  v_ip_amount numeric;
  v_ip_method text;
  v_ip_paid_at timestamptz;
  v_ip_note text;
  v_ip_text text;
  v_fingerprint text;
  v_existing public.expenses;
  v_currency text;
  v_id uuid;
  v_payment_id uuid;
  v_status text;
  v_version integer;
  v_is_active boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_idempotency_key is null or p_tenant_id is null then
    raise exception 'idempotency key and tenant are required' using errcode = 'FN004';
  end if;

  -- A foreign, non-member or nonexistent tenant is indistinguishable: FN002 for all of them.
  if not private.has_permission(p_tenant_id, 'finance.manage') then
    raise exception 'finance.manage required' using errcode = 'FN002';
  end if;

  -- ---- stateless validation and normalization -------------------------------------------------
  v_description := private.normalize_expense_text(p_description);
  if v_description is null or char_length(v_description) > 200 then
    raise exception 'invalid description' using errcode = 'FN004';
  end if;

  v_vendor := private.normalize_expense_text(p_vendor_name);
  if v_vendor is not null and char_length(v_vendor) > 200 then
    raise exception 'vendor name too long' using errcode = 'FN004';
  end if;

  v_note := private.normalize_expense_text(p_note);
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note too long' using errcode = 'FN004';
  end if;

  if p_category_key is null or p_category_key !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'invalid category' using errcode = 'FN004';
  end if;

  v_amount := private.normalize_expense_amount(p_amount);

  if p_expense_date is null or p_expense_date < date '2000-01-01' or p_expense_date > date '2100-12-31' then
    raise exception 'invalid expense date' using errcode = 'FN004';
  end if;

  if p_due_date is not null and (p_due_date < p_expense_date or p_due_date > date '2100-12-31') then
    raise exception 'invalid due date' using errcode = 'FN004';
  end if;

  if p_initial_payment is not null and jsonb_typeof(p_initial_payment) <> 'null' then
    v_has_initial := true;

    if jsonb_typeof(p_initial_payment) <> 'object' then
      raise exception 'initial payment must be an object' using errcode = 'FN004';
    end if;

    if exists (
      select 1 from jsonb_object_keys(p_initial_payment) as k
      where k not in ('amount', 'method', 'paid_at', 'note')
    ) then
      raise exception 'unknown initial payment field' using errcode = 'FN004';
    end if;

    if not (p_initial_payment ? 'amount' and p_initial_payment ? 'method' and p_initial_payment ? 'paid_at') then
      raise exception 'initial payment needs amount, method and paid_at' using errcode = 'FN004';
    end if;

    -- amount: a JSON number or a plain decimal string; both go through the same numeric validation as p_amount.
    if jsonb_typeof(p_initial_payment -> 'amount') = 'number' then
      v_ip_text := p_initial_payment ->> 'amount';
    elsif jsonb_typeof(p_initial_payment -> 'amount') = 'string'
          and (p_initial_payment ->> 'amount') ~ '^[0-9]+([.][0-9]+)?$' then
      v_ip_text := p_initial_payment ->> 'amount';
    else
      raise exception 'invalid initial payment amount' using errcode = 'FN004';
    end if;
    begin
      v_ip_amount_raw := v_ip_text::numeric;
    exception when others then
      raise exception 'invalid initial payment amount' using errcode = 'FN004';
    end;

    -- method: anything but a string is an invalid method; the value itself is checked by the shared validator.
    if jsonb_typeof(p_initial_payment -> 'method') = 'string' then
      v_ip_method_raw := p_initial_payment ->> 'method';
    else
      raise exception 'invalid payment method' using errcode = 'FN006';
    end if;

    -- paid_at: an ISO string with an explicit offset, so its meaning never depends on a session time zone.
    if jsonb_typeof(p_initial_payment -> 'paid_at') <> 'string'
       or (p_initial_payment ->> 'paid_at') !~ '(Z|z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
      raise exception 'invalid initial payment date' using errcode = 'FN004';
    end if;
    begin
      v_ip_paid_at_raw := (p_initial_payment ->> 'paid_at')::timestamptz;
    exception when others then
      raise exception 'invalid initial payment date' using errcode = 'FN004';
    end;

    if not (p_initial_payment ? 'note') or jsonb_typeof(p_initial_payment -> 'note') = 'null' then
      v_ip_note_raw := null;
    elsif jsonb_typeof(p_initial_payment -> 'note') = 'string' then
      v_ip_note_raw := p_initial_payment ->> 'note';
    else
      raise exception 'invalid initial payment note' using errcode = 'FN004';
    end if;

    v_ip_norm := private.normalize_expense_payment_input(v_ip_amount_raw, v_ip_method_raw, v_ip_paid_at_raw, v_ip_note_raw);
    v_ip_amount := (v_ip_norm ->> 'amount')::numeric;
    v_ip_method := v_ip_norm ->> 'method';
    v_ip_paid_at := (v_ip_norm ->> 'paid_at')::timestamptz;
    v_ip_note := v_ip_norm ->> 'note';

    if v_ip_amount > v_amount then
      raise exception 'initial payment exceeds the expense amount' using errcode = 'FN005';
    end if;
  end if;

  v_fingerprint := private.expense_create_fingerprint(
    p_branch_id, p_category_key, p_expense_date, p_due_date, v_amount, v_description, v_vendor, v_note,
    v_ip_amount, v_ip_method, v_ip_paid_at, v_ip_note
  );

  -- ---- replay ---------------------------------------------------------------------------------
  select * into v_existing
  from public.expenses
  where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.idempotency_fingerprint = v_fingerprint then
      select p.id into v_payment_id
      from public.expense_payments p
      where p.tenant_id = p_tenant_id and p.idempotency_key = p_idempotency_key and p.expense_id = v_existing.id;
      return jsonb_build_object(
        'expenseId', v_existing.id, 'paymentId', v_payment_id,
        'status', v_existing.status, 'version', v_existing.version, 'noop', true
      );
    end if;
    raise exception 'idempotency key already used with a different payload' using errcode = 'FN007';
  end if;

  -- There is deliberately NO separate "is the initial-payment key already used by a payment" pre-check here. Such a check
  -- would run in a later statement than the replay lookup above; an identical concurrent create could commit in between, and
  -- the check would then fail that identical replay with FN007 instead of returning the noop. Without it the outcomes are
  -- already right: an identical concurrent create loses the expense insert below and is answered as a replay, and a key that
  -- really belongs to another payment fails inside post_expense_payment as FN007, rolling the whole create back.

  -- ---- stateful validation --------------------------------------------------------------------
  select c.is_active into v_is_active from public.expense_categories c where c.key = p_category_key;
  if v_is_active is null or not v_is_active then
    raise exception 'unknown or inactive category' using errcode = 'FN004';
  end if;

  if p_branch_id is not null and not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.tenant_id = p_tenant_id and b.deleted_at is null
  ) then
    raise exception 'invalid branch' using errcode = 'FN004';
  end if;

  if p_expense_date > private.tenant_local_date(p_tenant_id) + 366 then
    raise exception 'expense date too far in the future' using errcode = 'FN004';
  end if;

  select t.currency into v_currency from public.tenants t where t.id = p_tenant_id;

  -- ---- write ----------------------------------------------------------------------------------
  insert into public.expenses (
    tenant_id, branch_id, category_key, description, vendor_name, note, expense_date, due_date,
    amount, currency, idempotency_key, idempotency_fingerprint, created_by
  )
  values (
    p_tenant_id, p_branch_id, p_category_key, v_description, v_vendor, v_note, p_expense_date, p_due_date,
    v_amount, v_currency, p_idempotency_key, v_fingerprint, auth.uid()
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- Lost a same-key race: the winner has committed. Compare and answer like a replay.
    select * into v_existing
    from public.expenses
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    if found and v_existing.idempotency_fingerprint = v_fingerprint then
      select p.id into v_payment_id
      from public.expense_payments p
      where p.tenant_id = p_tenant_id and p.idempotency_key = p_idempotency_key and p.expense_id = v_existing.id;
      return jsonb_build_object(
        'expenseId', v_existing.id, 'paymentId', v_payment_id,
        'status', v_existing.status, 'version', v_existing.version, 'noop', true
      );
    end if;
    raise exception 'idempotency key already used with a different payload' using errcode = 'FN007';
  end if;

  perform private.log_audit_event(
    p_tenant_id, 'finance.expense_created', 'expense', v_id,
    null,
    jsonb_build_object(
      'amount', v_amount, 'currency', v_currency, 'category_key', p_category_key, 'branch_id', p_branch_id,
      'expense_date', p_expense_date, 'due_date', p_due_date, 'status', 'open'
    )
  );

  if v_has_initial then
    v_payment_id := private.post_expense_payment(
      p_tenant_id, v_id, v_ip_amount, v_ip_method, v_ip_paid_at, v_ip_note, p_idempotency_key
    );
  end if;

  select e.status, e.version into v_status, v_version from public.expenses e where e.id = v_id;

  return jsonb_build_object(
    'expenseId', v_id, 'paymentId', v_payment_id, 'status', v_status, 'version', v_version, 'noop', false
  );
end;
$$;

comment on function private.create_expense(uuid, text, text, date, numeric, uuid, uuid, text, date, text, jsonb) is
  'Faz FIN.1B.1. Requires finance.manage. p_idempotency_key is REQUIRED (null is FN004). Order: authentication, key and tenant presence, permission, stateless validation and normalization (FN004/FN005/FN006), fingerprint of the original payload, replay lookup (same stored fingerprint returns the existing expense with noop=true, a different one is FN007), stateful validation (active category, branch in tenant and not deleted, expense_date at most tenant-today + 366), insert on conflict do nothing (a lost same-key race is answered like a replay), audit finance.expense_created, optional initial payment through post_expense_payment in the SAME transaction (a failure rolls the expense back too, including FN007 when the key already belongs to another payment; second audit event finance.expense_payment_recorded). Returns {expenseId, paymentId, status, version, noop}. A create with an initial payment ends at version 2.';

create function private.update_expense(
  p_expense_id uuid,
  p_category_key text,
  p_description text,
  p_expense_date date,
  p_amount numeric,
  p_expected_version integer default null,
  p_branch_id uuid default null,
  p_vendor_name text default null,
  p_due_date date default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cur public.expenses;
  v_new public.expenses;
  v_description text;
  v_vendor text;
  v_note text;
  v_amount numeric;
  v_changed text[] := '{}';
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_new_status text;
  v_is_active boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  -- 1. lock the row, 2. permission against the locked row's tenant
  select * into v_cur from public.expenses where id = p_expense_id for update;
  if not found then
    raise exception 'expense not found' using errcode = 'FN003';
  end if;

  if not private.has_permission(v_cur.tenant_id, 'finance.manage') then
    raise exception 'finance.manage required' using errcode = 'FN002';
  end if;

  -- 3. the expected version is validated BEFORE anything else, and in particular before the no-op decision: a stale
  --    form never succeeds, even when its values equal the current ones.
  if p_expected_version is null then
    raise exception 'expected version required' using errcode = 'FN004';
  end if;
  if p_expected_version <> v_cur.version then
    raise exception 'the expense changed since it was read' using errcode = 'FN013';
  end if;

  -- 4. stateless validation and normalization of the desired state
  v_description := private.normalize_expense_text(p_description);
  if v_description is null or char_length(v_description) > 200 then
    raise exception 'invalid description' using errcode = 'FN004';
  end if;

  v_vendor := private.normalize_expense_text(p_vendor_name);
  if v_vendor is not null and char_length(v_vendor) > 200 then
    raise exception 'vendor name too long' using errcode = 'FN004';
  end if;

  v_note := private.normalize_expense_text(p_note);
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note too long' using errcode = 'FN004';
  end if;

  if p_category_key is null or p_category_key !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'invalid category' using errcode = 'FN004';
  end if;

  v_amount := private.normalize_expense_amount(p_amount);

  if p_expense_date is null or p_expense_date < date '2000-01-01' or p_expense_date > date '2100-12-31' then
    raise exception 'invalid expense date' using errcode = 'FN004';
  end if;

  if p_due_date is not null and (p_due_date < p_expense_date or p_due_date > date '2100-12-31') then
    raise exception 'invalid due date' using errcode = 'FN004';
  end if;

  -- 5. the changed set (text fields are compared normalized against the stored normalized values)
  if p_category_key is distinct from v_cur.category_key then
    v_changed := array_append(v_changed, 'category_key');
    v_before := v_before || jsonb_build_object('category_key', v_cur.category_key);
    v_after := v_after || jsonb_build_object('category_key', p_category_key);
  end if;
  if v_description is distinct from v_cur.description then
    v_changed := array_append(v_changed, 'description');
  end if;
  if p_expense_date is distinct from v_cur.expense_date then
    v_changed := array_append(v_changed, 'expense_date');
    v_before := v_before || jsonb_build_object('expense_date', v_cur.expense_date);
    v_after := v_after || jsonb_build_object('expense_date', p_expense_date);
  end if;
  if v_amount is distinct from v_cur.amount then
    v_changed := array_append(v_changed, 'amount');
    v_before := v_before || jsonb_build_object('amount', v_cur.amount);
    v_after := v_after || jsonb_build_object('amount', v_amount);
  end if;
  if p_branch_id is distinct from v_cur.branch_id then
    v_changed := array_append(v_changed, 'branch_id');
    v_before := v_before || jsonb_build_object('branch_id', v_cur.branch_id);
    v_after := v_after || jsonb_build_object('branch_id', p_branch_id);
  end if;
  if v_vendor is distinct from v_cur.vendor_name then
    v_changed := array_append(v_changed, 'vendor_name');
  end if;
  if p_due_date is distinct from v_cur.due_date then
    v_changed := array_append(v_changed, 'due_date');
    v_before := v_before || jsonb_build_object('due_date', v_cur.due_date);
    v_after := v_after || jsonb_build_object('due_date', p_due_date);
  end if;
  if v_note is distinct from v_cur.note then
    v_changed := array_append(v_changed, 'note');
  end if;

  -- Version matches and the normalized desired state equals the current state: a genuine no-op.
  if cardinality(v_changed) = 0 then
    return jsonb_build_object(
      'expenseId', v_cur.id, 'status', v_cur.status, 'version', v_cur.version, 'noop', true
    );
  end if;

  -- 6. stateful validation, for the CHANGED references only (unchanged legacy values are never re-validated)
  if 'category_key' = any (v_changed) then
    select c.is_active into v_is_active from public.expense_categories c where c.key = p_category_key;
    if v_is_active is null or not v_is_active then
      raise exception 'unknown or inactive category' using errcode = 'FN004';
    end if;
  end if;

  if 'branch_id' = any (v_changed) and p_branch_id is not null and not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.tenant_id = v_cur.tenant_id and b.deleted_at is null
  ) then
    raise exception 'invalid branch' using errcode = 'FN004';
  end if;

  if 'expense_date' = any (v_changed) and p_expense_date > private.tenant_local_date(v_cur.tenant_id) + 366 then
    raise exception 'expense date too far in the future' using errcode = 'FN004';
  end if;

  -- 7. write. The lifecycle rules (FN008 cancelled, FN012 structure lock / amount floor) are enforced by trigger T1,
  --    which also bumps version exactly once. This statement never assigns version or updated_at.
  v_new_status := case
    when v_cur.status = 'cancelled' then v_cur.status
    else private.compute_expense_status(v_amount, private.expense_posted_total(v_cur.id))
  end;

  update public.expenses
  set category_key = p_category_key,
      description = v_description,
      expense_date = p_expense_date,
      amount = v_amount,
      branch_id = p_branch_id,
      vendor_name = v_vendor,
      due_date = p_due_date,
      note = v_note,
      status = v_new_status
  where id = v_cur.id
  returning * into v_new;

  if v_new.status is distinct from v_cur.status then
    v_before := v_before || jsonb_build_object('status', v_cur.status);
    v_after := v_after || jsonb_build_object('status', v_new.status);
  end if;
  v_after := v_after || jsonb_build_object('changed_fields', to_jsonb(v_changed), 'version', v_new.version);

  perform private.log_audit_event(v_cur.tenant_id, 'finance.expense_updated', 'expense', v_cur.id, v_before, v_after);

  return jsonb_build_object(
    'expenseId', v_new.id, 'status', v_new.status, 'version', v_new.version, 'noop', false
  );
end;
$$;

comment on function private.update_expense(uuid, text, text, date, numeric, integer, uuid, text, date, text) is
  'Faz FIN.1B.1. Full-state edit. Requires finance.manage. Order: authentication, row lock, permission, expected version (null is FN004; a mismatch is FN013 EVEN WHEN the submitted values equal the current ones), stateless validation of the desired state, changed set (nothing changed with a matching version is a noop: no UPDATE, no version bump, no audit), stateful validation of the changed references only, UPDATE. The lifecycle rules (FN008 cancelled, FN012 structure lock and amount floor) belong to trigger T1, which also owns version: this function never assigns it. Audit: one finance.expense_updated with only the changed non-text fields in before/after, after.changed_fields naming every changed field (text fields by name only) and after.version. Returns {expenseId, status, version, noop}.';

create function private.cancel_expense(p_expense_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cur public.expenses;
  v_reason text;
  v_new public.expenses;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  select * into v_cur from public.expenses where id = p_expense_id for update;
  if not found then
    raise exception 'expense not found' using errcode = 'FN003';
  end if;

  if not private.has_permission(v_cur.tenant_id, 'finance.manage') then
    raise exception 'finance.manage required' using errcode = 'FN002';
  end if;

  -- Already cancelled: an idempotent no-op (reason not re-validated, no audit, no version change).
  if v_cur.status = 'cancelled' then
    return jsonb_build_object('expenseId', v_cur.id, 'status', v_cur.status, 'version', v_cur.version, 'noop', true);
  end if;

  v_reason := private.normalize_expense_text(p_reason);
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'cancel reason required' using errcode = 'FN004';
  end if;

  -- Trigger T1 refuses (FN011) when a posted payment exists and bumps version exactly once.
  update public.expenses
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = auth.uid(),
      cancel_reason = v_reason
  where id = v_cur.id
  returning * into v_new;

  perform private.log_audit_event(
    v_cur.tenant_id, 'finance.expense_cancelled', 'expense', v_cur.id,
    jsonb_build_object('status', v_cur.status),
    jsonb_build_object('status', 'cancelled', 'reason', v_reason)
  );

  return jsonb_build_object('expenseId', v_new.id, 'status', v_new.status, 'version', v_new.version, 'noop', false);
end;
$$;

comment on function private.cancel_expense(uuid, text) is
  'Faz FIN.1B.1. Requires finance.manage. Never deletes: sets status cancelled with cancelled_at/by/reason. Already cancelled is an idempotent noop. The reason (trimmed, 1-500 chars, FN004) is validated before the lifecycle rule; trigger T1 then raises FN011 when a posted payment exists. Audit: one finance.expense_cancelled with the reason. Version +1 on the real cancel only.';

create function private.record_expense_payment(
  p_expense_id uuid,
  p_amount numeric,
  p_method text,
  p_paid_at timestamptz,
  p_note text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_norm jsonb;
  v_amount numeric;
  v_paid_at timestamptz;
  v_note text;
  v_existing public.expense_payments;
  v_payment_id uuid;
  v_status text;
  v_version integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = 'FN004';
  end if;

  -- Locks the expense for the whole call: concurrent payments, edits and cancels of the SAME expense serialize here.
  select tenant_id into v_tenant_id from public.expenses where id = p_expense_id for update;
  if v_tenant_id is null then
    raise exception 'expense not found' using errcode = 'FN003';
  end if;

  if not private.has_permission(v_tenant_id, 'finance.manage') then
    raise exception 'finance.manage required' using errcode = 'FN002';
  end if;

  v_norm := private.normalize_expense_payment_input(p_amount, p_method, p_paid_at, p_note);
  v_amount := (v_norm ->> 'amount')::numeric;
  v_paid_at := (v_norm ->> 'paid_at')::timestamptz;
  v_note := v_norm ->> 'note';

  -- Replay: the lookup precedes every lifecycle rule, so an identical retry is a noop in any later state.
  select * into v_existing
  from public.expense_payments
  where tenant_id = v_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.expense_id = p_expense_id
       and v_existing.amount = v_amount
       and v_existing.method = p_method
       and v_existing.paid_at = v_paid_at
       and v_existing.note is not distinct from v_note then
      select e.status, e.version into v_status, v_version from public.expenses e where e.id = p_expense_id;
      return jsonb_build_object(
        'expenseId', p_expense_id, 'paymentId', v_existing.id, 'status', v_status, 'version', v_version, 'noop', true
      );
    end if;
    raise exception 'idempotency key already used with a different payload' using errcode = 'FN007';
  end if;

  -- Triggers: T2 raises FN008 (cancelled) / FN005 (overpayment); T3 refreshes status and settlement_events in one
  -- UPDATE, which T1 turns into exactly one version bump.
  v_payment_id := private.post_expense_payment(
    v_tenant_id, p_expense_id, v_amount, p_method, v_paid_at, v_note, p_idempotency_key
  );

  select e.status, e.version into v_status, v_version from public.expenses e where e.id = p_expense_id;

  return jsonb_build_object(
    'expenseId', p_expense_id, 'paymentId', v_payment_id, 'status', v_status, 'version', v_version, 'noop', false
  );
end;
$$;

comment on function private.record_expense_payment(uuid, numeric, text, timestamptz, text, uuid) is
  'Faz FIN.1B.1. Requires finance.manage. p_idempotency_key is required (FN004). Locks the expense first. Order: stateless payment validation (amount FN004, method FN006, paid_at FN004, note FN004), replay lookup (identical stored payment: noop with the existing payment id; different payload or another expense: FN007), then the insert through post_expense_payment where trigger T2 raises FN008 (cancelled expense) or FN005 (overpayment). Every real payment bumps the expense version exactly once, even when the status stays the same; a replay changes nothing. Audit: one finance.expense_payment_recorded. Returns {expenseId, paymentId, status, version, noop}.';

create function private.void_expense_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expense_id uuid;
  v_tenant_id uuid;
  v_status text;
  v_reason text;
  v_exp_status text;
  v_exp_version integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  -- The payment's expense never changes, so this unlocked read only locates the parent; lock order is then fixed:
  -- expense first, payment second.
  select expense_id into v_expense_id from public.expense_payments where id = p_payment_id;
  if v_expense_id is null then
    raise exception 'payment not found' using errcode = 'FN009';
  end if;

  select tenant_id into v_tenant_id from public.expenses where id = v_expense_id for update;

  if not private.has_permission(v_tenant_id, 'finance.manage') then
    raise exception 'finance.manage required' using errcode = 'FN002';
  end if;

  select status into v_status from public.expense_payments where id = p_payment_id for update;

  -- Already voided: an idempotent no-op (reason not re-validated, no audit, no version change).
  if v_status = 'voided' then
    select e.status, e.version into v_exp_status, v_exp_version from public.expenses e where e.id = v_expense_id;
    return jsonb_build_object(
      'expenseId', v_expense_id, 'paymentId', p_payment_id, 'status', v_exp_status, 'version', v_exp_version, 'noop', true
    );
  end if;

  v_reason := private.normalize_expense_text(p_reason);
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'void reason required' using errcode = 'FN004';
  end if;

  update public.expense_payments
  set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
  where id = p_payment_id;

  perform private.log_audit_event(
    v_tenant_id, 'finance.expense_payment_voided', 'expense_payment', p_payment_id,
    jsonb_build_object('status', 'posted'),
    jsonb_build_object('status', 'voided', 'reason', v_reason, 'expense_id', v_expense_id)
  );

  select e.status, e.version into v_exp_status, v_exp_version from public.expenses e where e.id = v_expense_id;

  return jsonb_build_object(
    'expenseId', v_expense_id, 'paymentId', p_payment_id, 'status', v_exp_status, 'version', v_exp_version, 'noop', false
  );
end;
$$;

comment on function private.void_expense_payment(uuid, text) is
  'Faz FIN.1B.1. Requires finance.manage. Never deletes: posted -> voided with voided_at/by/reason (trigger T2 allows only that transition). Lock order is expense then payment. Voiding an already voided payment is an idempotent noop. Every real void bumps the expense version exactly once, even when the status stays the same. Audit: one finance.expense_payment_voided with the reason and expense_id. Returns {expenseId, paymentId, status, version, noop}.';

-- =====================================================================
-- 8. READ RPCs (private implementations). finance.view; curated PII-free
--    jsonb. p_reference_date only drives overdue/upcoming classification
--    and the default month; it never reconstructs history.
-- =====================================================================

create function private.list_expense_categories(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;
  if p_tenant_id is null then
    raise exception 'tenant required' using errcode = 'FN004';
  end if;
  if not private.has_permission(p_tenant_id, 'finance.view') then
    raise exception 'finance.view required' using errcode = 'FN002';
  end if;

  return (
    select coalesce(
      jsonb_agg(
        jsonb_build_object('key', c.key, 'kind', c.kind, 'displayOrder', c.display_order)
        order by c.display_order, c.key
      ),
      '[]'::jsonb
    )
    from public.expense_categories c
    where c.is_active
  );
end;
$$;

comment on function private.list_expense_categories(uuid) is
  'Faz FIN.1B.1. Requires finance.view in the tenant. Active categories only, ordered by display_order then key.';

create function private.get_expense(p_expense_id uuid, p_reference_date date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_ref date;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;
  if p_expense_id is null then
    raise exception 'expense id required' using errcode = 'FN004';
  end if;

  select tenant_id into v_tenant_id from public.expenses where id = p_expense_id;
  if v_tenant_id is null then
    raise exception 'expense not found' using errcode = 'FN003';
  end if;

  if not private.has_permission(v_tenant_id, 'finance.view') then
    raise exception 'finance.view required' using errcode = 'FN002';
  end if;

  if p_reference_date is not null and (p_reference_date < date '2000-01-01' or p_reference_date > date '2100-12-31') then
    raise exception 'invalid reference date' using errcode = 'FN004';
  end if;
  v_ref := coalesce(p_reference_date, private.tenant_local_date(v_tenant_id));

  select jsonb_build_object(
    'id', e.id,
    'branchId', e.branch_id,
    'branchName', b.name,
    'categoryKey', e.category_key,
    'categoryKind', c.kind,
    'description', e.description,
    'vendorName', e.vendor_name,
    'note', e.note,
    'expenseDate', e.expense_date,
    'dueDate', e.due_date,
    'amount', e.amount,
    'currency', e.currency,
    'paid', x.paid,
    'outstanding', case when e.status = 'cancelled' then 0 else e.amount - x.paid end,
    'amountFloor', x.paid,
    'status', e.status,
    'isOverdue', od.is_overdue,
    'daysOverdue', case when od.is_overdue then v_ref - e.due_date else null end,
    'structureLocked', (x.paid > 0 or e.status = 'cancelled'),
    'canCancel', (e.status <> 'cancelled' and x.paid = 0),
    'cancelledAt', e.cancelled_at,
    'cancelReason', e.cancel_reason,
    'version', e.version,
    'createdAt', e.created_at,
    'updatedAt', e.updated_at,
    'payments', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', p.id, 'amount', p.amount, 'method', p.method, 'paidAt', p.paid_at,
            'note', p.note, 'status', p.status, 'voidReason', p.void_reason
          )
          order by p.paid_at, p.created_at, p.id
        ),
        '[]'::jsonb
      )
      from public.expense_payments p
      where p.expense_id = e.id
    )
  ) into v_result
  from public.expenses e
  join public.expense_categories c on c.key = e.category_key
  left join public.branches b on b.id = e.branch_id
  cross join lateral (select private.expense_posted_total(e.id) as paid) x
  cross join lateral (
    select (e.status in ('open', 'partially_paid') and e.due_date is not null and e.due_date < v_ref) as is_overdue
  ) od
  where e.id = p_expense_id;

  return v_result;
end;
$$;

comment on function private.get_expense(uuid, date) is
  'Faz FIN.1B.1. Requires finance.view in the expense''s tenant (FN003 when missing, FN002 when not permitted). Curated detail: no user ids, no idempotency data, no tenant id. paid is the posted total, outstanding is 0 for a cancelled expense, structureLocked/canCancel/amountFloor are display hints computed here (trigger T1 is the authority). p_reference_date (default: tenant-local today) drives isOverdue/daysOverdue only.';

create function private.list_expenses(
  p_tenant_id uuid,
  p_from_date date default null,
  p_to_date date default null,
  p_branch_id uuid default null,
  p_general_only boolean default false,
  p_category_key text default null,
  p_status text default null,
  p_include_cancelled boolean default false,
  p_overdue_only boolean default false,
  p_search text default null,
  p_limit integer default 50,
  p_cursor_date date default null,
  p_cursor_id uuid default null,
  p_reference_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := coalesce(p_limit, 50);
  v_ref date;
  v_search text;
  v_pattern text;
  v_items jsonb;
  v_last jsonb;
  v_next jsonb := null;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;
  if p_tenant_id is null then
    raise exception 'tenant required' using errcode = 'FN004';
  end if;
  if not private.has_permission(p_tenant_id, 'finance.view') then
    raise exception 'finance.view required' using errcode = 'FN002';
  end if;

  if p_from_date is not null and p_to_date is not null and p_from_date > p_to_date then
    raise exception 'invalid date window' using errcode = 'FN004';
  end if;
  if p_status is not null and p_status not in ('open', 'partially_paid', 'paid', 'cancelled') then
    raise exception 'invalid status' using errcode = 'FN004';
  end if;
  if p_branch_id is not null and coalesce(p_general_only, false) then
    raise exception 'branch and general-only are mutually exclusive' using errcode = 'FN004';
  end if;
  if v_limit < 1 or v_limit > 100 then
    raise exception 'invalid limit' using errcode = 'FN004';
  end if;
  if (p_cursor_date is null) <> (p_cursor_id is null) then
    raise exception 'cursor needs both date and id' using errcode = 'FN004';
  end if;
  if p_reference_date is not null and (p_reference_date < date '2000-01-01' or p_reference_date > date '2100-12-31') then
    raise exception 'invalid reference date' using errcode = 'FN004';
  end if;

  v_search := private.normalize_expense_text(p_search);
  if v_search is not null and char_length(v_search) > 100 then
    raise exception 'search too long' using errcode = 'FN004';
  end if;
  if v_search is not null then
    -- '!' is the ILIKE escape character; % and _ in the user's text are matched literally.
    v_pattern := '%' || replace(replace(replace(v_search, '!', '!!'), '%', '!%'), '_', '!_') || '%';
  end if;

  v_ref := coalesce(p_reference_date, private.tenant_local_date(p_tenant_id));

  select coalesce(jsonb_agg(s.item order by s.expense_date desc, s.id desc), '[]'::jsonb) into v_items
  from (
    select
      e.expense_date,
      e.id,
      jsonb_build_object(
        'id', e.id,
        'branchId', e.branch_id,
        'branchName', b.name,
        'categoryKey', e.category_key,
        'categoryKind', c.kind,
        'description', e.description,
        'vendorName', e.vendor_name,
        'expenseDate', e.expense_date,
        'dueDate', e.due_date,
        'amount', e.amount,
        'currency', e.currency,
        'paid', x.paid,
        'outstanding', case when e.status = 'cancelled' then 0 else e.amount - x.paid end,
        'status', e.status,
        'isOverdue', od.is_overdue,
        'daysOverdue', case when od.is_overdue then v_ref - e.due_date else null end,
        'version', e.version
      ) as item
    from public.expenses e
    join public.expense_categories c on c.key = e.category_key
    left join public.branches b on b.id = e.branch_id
    cross join lateral (select private.expense_posted_total(e.id) as paid) x
    cross join lateral (
      select (e.status in ('open', 'partially_paid') and e.due_date is not null and e.due_date < v_ref) as is_overdue
    ) od
    where e.tenant_id = p_tenant_id
      and (p_from_date is null or e.expense_date >= p_from_date)
      and (p_to_date is null or e.expense_date <= p_to_date)
      and (p_branch_id is null or e.branch_id = p_branch_id)
      and (not coalesce(p_general_only, false) or e.branch_id is null)
      and (p_category_key is null or e.category_key = p_category_key)
      and (
        case
          when p_status is not null then e.status = p_status
          when coalesce(p_include_cancelled, false) then true
          else e.status <> 'cancelled'
        end
      )
      and (not coalesce(p_overdue_only, false) or od.is_overdue)
      and (
        v_pattern is null
        or e.description ilike v_pattern escape '!'
        or e.vendor_name ilike v_pattern escape '!'
      )
      and (p_cursor_date is null or (e.expense_date, e.id) < (p_cursor_date, p_cursor_id))
    order by e.expense_date desc, e.id desc
    limit v_limit + 1
  ) s;

  if jsonb_array_length(v_items) > v_limit then
    v_last := v_items -> (v_limit - 1);
    v_next := jsonb_build_object('expenseDate', v_last ->> 'expenseDate', 'id', v_last ->> 'id');
    v_items := v_items - v_limit;
  end if;

  return jsonb_build_object('items', v_items, 'nextCursor', v_next);
end;
$$;

comment on function private.list_expenses(uuid, date, date, uuid, boolean, text, text, boolean, boolean, text, integer, date, uuid, date) is
  'Faz FIN.1B.1. Requires finance.view. Keyset-paginated list ordered by (expense_date desc, id desc), limit 1..100 (default 50), cursor needs both parts. Filters: inclusive expense_date window, branch or Genel-only (mutually exclusive), category, status, include_cancelled, overdue_only, case-insensitive substring search over description and vendor. The default list EXCLUDES cancelled rows; p_status = cancelled returns cancelled rows only. No user ids, no idempotency data.';

create function private.get_expense_overview(
  p_tenant_id uuid,
  p_month date default null,
  p_branch_id uuid default null,
  p_general_only boolean default false,
  p_reference_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ref date;
  v_month_start date;
  v_next_month date;
  v_tz text;
  v_primary text;
  v_lo timestamptz;
  v_hi timestamptz;
  v_by jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;
  if p_tenant_id is null then
    raise exception 'tenant required' using errcode = 'FN004';
  end if;
  if not private.has_permission(p_tenant_id, 'finance.view') then
    raise exception 'finance.view required' using errcode = 'FN002';
  end if;

  if p_branch_id is not null and coalesce(p_general_only, false) then
    raise exception 'branch and general-only are mutually exclusive' using errcode = 'FN004';
  end if;
  if p_month is not null and (p_month < date '2000-01-01' or p_month > date '2100-12-31') then
    raise exception 'invalid month' using errcode = 'FN004';
  end if;
  if p_reference_date is not null and (p_reference_date < date '2000-01-01' or p_reference_date > date '2100-12-31') then
    raise exception 'invalid reference date' using errcode = 'FN004';
  end if;

  select t.timezone, t.currency into v_tz, v_primary from public.tenants t where t.id = p_tenant_id;

  v_ref := coalesce(p_reference_date, private.tenant_local_date(p_tenant_id));
  v_month_start := date_trunc('month', coalesce(p_month, v_ref)::timestamp)::date;
  v_next_month := (v_month_start + interval '1 month')::date;
  v_lo := v_month_start::timestamp at time zone v_tz;
  v_hi := v_next_month::timestamp at time zone v_tz;

  with scope as (
    select e.id, e.amount, e.currency, e.status, e.expense_date, e.due_date
    from public.expenses e
    where e.tenant_id = p_tenant_id
      and (p_branch_id is null or e.branch_id = p_branch_id)
      and (not coalesce(p_general_only, false) or e.branch_id is null)
  ),
  posted as (
    select p.expense_id, sum(p.amount) as total
    from public.expense_payments p
    join scope s on s.id = p.expense_id
    where p.tenant_id = p_tenant_id and p.status = 'posted'
    group by p.expense_id
  ),
  month_paid as (
    select s.currency, sum(p.amount) as paid
    from public.expense_payments p
    join scope s on s.id = p.expense_id
    where p.tenant_id = p_tenant_id and p.status = 'posted' and p.paid_at >= v_lo and p.paid_at < v_hi
    group by s.currency
  ),
  agg as (
    select
      s.currency,
      coalesce(sum(s.amount) filter (
        where s.status <> 'cancelled' and s.expense_date >= v_month_start and s.expense_date < v_next_month
      ), 0) as incurred,
      coalesce(sum(s.amount - coalesce(po.total, 0)) filter (where s.status in ('open', 'partially_paid')), 0) as out_total,
      count(*) filter (where s.status in ('open', 'partially_paid')) as out_count,
      coalesce(sum(s.amount - coalesce(po.total, 0)) filter (
        where s.status in ('open', 'partially_paid') and s.due_date is not null and s.due_date < v_ref
      ), 0) as od_total,
      count(*) filter (
        where s.status in ('open', 'partially_paid') and s.due_date is not null and s.due_date < v_ref
      ) as od_count,
      coalesce(sum(s.amount - coalesce(po.total, 0)) filter (
        where s.status in ('open', 'partially_paid') and s.due_date is not null
          and s.due_date >= v_ref and s.due_date <= v_ref + 14
      ), 0) as up_total,
      count(*) filter (
        where s.status in ('open', 'partially_paid') and s.due_date is not null
          and s.due_date >= v_ref and s.due_date <= v_ref + 14
      ) as up_count
    from scope s
    left join posted po on po.expense_id = s.id
    group by s.currency
  ),
  currencies as (
    select a.currency from agg a
    union
    select m.currency from month_paid m
    union
    select v_primary
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'currency', c.currency,
        'incurred', coalesce(a.incurred, 0),
        'paid', coalesce(m.paid, 0),
        'outstanding', jsonb_build_object('total', coalesce(a.out_total, 0), 'count', coalesce(a.out_count, 0)),
        'overdue', jsonb_build_object('total', coalesce(a.od_total, 0), 'count', coalesce(a.od_count, 0)),
        'upcoming', jsonb_build_object('total', coalesce(a.up_total, 0), 'count', coalesce(a.up_count, 0), 'withinDays', 14)
      )
      order by (c.currency = v_primary) desc, c.currency
    ),
    '[]'::jsonb
  ) into v_by
  from currencies c
  left join agg a on a.currency = c.currency
  left join month_paid m on m.currency = c.currency
  where c.currency = v_primary
     or coalesce(a.incurred, 0) <> 0
     or coalesce(m.paid, 0) <> 0
     or coalesce(a.out_count, 0) > 0;

  return jsonb_build_object(
    'month', v_month_start,
    'referenceDate', v_ref,
    'primaryCurrency', v_primary,
    'byCurrency', v_by
  );
end;
$$;

comment on function private.get_expense_overview(uuid, date, uuid, boolean, date) is
  'Faz FIN.1B.1. Requires finance.view. Per currency, never summed across currencies: incurred (non-cancelled expenses by expense_date in the selected tenant-local month), paid (posted payments by paid_at in that month), outstanding (CURRENT all-time balance of open/partially paid expenses, independent of the month), overdue and upcoming (outstanding with due_date before the reference date / within [reference date, +14 days]). p_reference_date (default tenant-local today) only classifies overdue/upcoming and picks the default month; it never reconstructs history. The primary (tenant) currency entry is always present. Nothing here is profit.';

-- =====================================================================
-- 9. PUBLIC WRAPPERS — thin pass-throughs, authenticated only, security
--    definer (a private.* caller must be definer: see supabase/migrations/README.md "Lessons").
-- =====================================================================
create function public.list_expense_categories(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.list_expense_categories(p_tenant_id);
$$;

create function public.get_expense_overview(
  p_tenant_id uuid,
  p_month date default null,
  p_branch_id uuid default null,
  p_general_only boolean default false,
  p_reference_date date default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_expense_overview(p_tenant_id, p_month, p_branch_id, p_general_only, p_reference_date);
$$;

create function public.list_expenses(
  p_tenant_id uuid,
  p_from_date date default null,
  p_to_date date default null,
  p_branch_id uuid default null,
  p_general_only boolean default false,
  p_category_key text default null,
  p_status text default null,
  p_include_cancelled boolean default false,
  p_overdue_only boolean default false,
  p_search text default null,
  p_limit integer default 50,
  p_cursor_date date default null,
  p_cursor_id uuid default null,
  p_reference_date date default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.list_expenses(
    p_tenant_id, p_from_date, p_to_date, p_branch_id, p_general_only, p_category_key, p_status,
    p_include_cancelled, p_overdue_only, p_search, p_limit, p_cursor_date, p_cursor_id, p_reference_date
  );
$$;

create function public.get_expense(p_expense_id uuid, p_reference_date date default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_expense(p_expense_id, p_reference_date);
$$;

create function public.create_expense(
  p_tenant_id uuid,
  p_category_key text,
  p_description text,
  p_expense_date date,
  p_amount numeric,
  p_idempotency_key uuid default null,
  p_branch_id uuid default null,
  p_vendor_name text default null,
  p_due_date date default null,
  p_note text default null,
  p_initial_payment jsonb default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.create_expense(
    p_tenant_id, p_category_key, p_description, p_expense_date, p_amount, p_idempotency_key,
    p_branch_id, p_vendor_name, p_due_date, p_note, p_initial_payment
  );
$$;

create function public.update_expense(
  p_expense_id uuid,
  p_category_key text,
  p_description text,
  p_expense_date date,
  p_amount numeric,
  p_expected_version integer default null,
  p_branch_id uuid default null,
  p_vendor_name text default null,
  p_due_date date default null,
  p_note text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.update_expense(
    p_expense_id, p_category_key, p_description, p_expense_date, p_amount, p_expected_version,
    p_branch_id, p_vendor_name, p_due_date, p_note
  );
$$;

create function public.cancel_expense(p_expense_id uuid, p_reason text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.cancel_expense(p_expense_id, p_reason);
$$;

create function public.record_expense_payment(
  p_expense_id uuid,
  p_amount numeric,
  p_method text,
  p_paid_at timestamptz,
  p_note text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.record_expense_payment(p_expense_id, p_amount, p_method, p_paid_at, p_note, p_idempotency_key);
$$;

create function public.void_expense_payment(p_payment_id uuid, p_reason text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.void_expense_payment(p_payment_id, p_reason);
$$;

-- =====================================================================
-- 10. GRANTS — every function loses its PUBLIC execute; only the nine
--     wrappers are executable, by authenticated alone. Nothing for anon, and
--     nothing added for service_role (like FIN.1A it keeps only what an
--     environment's default function privileges give it: none on PROD). The
--     private helpers, RPCs and trigger functions have no API-role grant at
--     all.
-- =====================================================================
revoke execute on function private.compute_expense_status(numeric, numeric) from public;
revoke execute on function private.expense_posted_total(uuid) from public;
revoke execute on function private.expense_settlement_events(uuid) from public;
revoke execute on function private.tenant_local_date(uuid) from public;
revoke execute on function private.normalize_expense_text(text) from public;
revoke execute on function private.normalize_expense_amount(numeric) from public;
revoke execute on function private.expense_create_fingerprint(uuid, text, date, date, numeric, text, text, text, numeric, text, timestamptz, text) from public;
revoke execute on function private.normalize_expense_payment_input(numeric, text, timestamptz, text) from public;
revoke execute on function private.enforce_expense_invariants() from public;
revoke execute on function private.enforce_expense_payment_invariants() from public;
revoke execute on function private.recalculate_expense_status() from public;
revoke execute on function private.post_expense_payment(uuid, uuid, numeric, text, timestamptz, text, uuid) from public;
revoke execute on function private.create_expense(uuid, text, text, date, numeric, uuid, uuid, text, date, text, jsonb) from public;
revoke execute on function private.update_expense(uuid, text, text, date, numeric, integer, uuid, text, date, text) from public;
revoke execute on function private.cancel_expense(uuid, text) from public;
revoke execute on function private.record_expense_payment(uuid, numeric, text, timestamptz, text, uuid) from public;
revoke execute on function private.void_expense_payment(uuid, text) from public;
revoke execute on function private.list_expense_categories(uuid) from public;
revoke execute on function private.get_expense(uuid, date) from public;
revoke execute on function private.list_expenses(uuid, date, date, uuid, boolean, text, text, boolean, boolean, text, integer, date, uuid, date) from public;
revoke execute on function private.get_expense_overview(uuid, date, uuid, boolean, date) from public;

revoke execute on function public.list_expense_categories(uuid) from public, anon;
revoke execute on function public.get_expense_overview(uuid, date, uuid, boolean, date) from public, anon;
revoke execute on function public.list_expenses(uuid, date, date, uuid, boolean, text, text, boolean, boolean, text, integer, date, uuid, date) from public, anon;
revoke execute on function public.get_expense(uuid, date) from public, anon;
revoke execute on function public.create_expense(uuid, text, text, date, numeric, uuid, uuid, text, date, text, jsonb) from public, anon;
revoke execute on function public.update_expense(uuid, text, text, date, numeric, integer, uuid, text, date, text) from public, anon;
revoke execute on function public.cancel_expense(uuid, text) from public, anon;
revoke execute on function public.record_expense_payment(uuid, numeric, text, timestamptz, text, uuid) from public, anon;
revoke execute on function public.void_expense_payment(uuid, text) from public, anon;

grant execute on function public.list_expense_categories(uuid) to authenticated;
grant execute on function public.get_expense_overview(uuid, date, uuid, boolean, date) to authenticated;
grant execute on function public.list_expenses(uuid, date, date, uuid, boolean, text, text, boolean, boolean, text, integer, date, uuid, date) to authenticated;
grant execute on function public.get_expense(uuid, date) to authenticated;
grant execute on function public.create_expense(uuid, text, text, date, numeric, uuid, uuid, text, date, text, jsonb) to authenticated;
grant execute on function public.update_expense(uuid, text, text, date, numeric, integer, uuid, text, date, text) to authenticated;
grant execute on function public.cancel_expense(uuid, text) to authenticated;
grant execute on function public.record_expense_payment(uuid, numeric, text, timestamptz, text, uuid) to authenticated;
grant execute on function public.void_expense_payment(uuid, text) to authenticated;

commit;
