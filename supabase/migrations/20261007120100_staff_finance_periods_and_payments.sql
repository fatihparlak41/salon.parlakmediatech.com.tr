-- Faz FIN.1C.1 - Personnel period ledger (staff finance). What the salon owes each staff member for a calendar month
-- (earning, employee-deduction and employer-cost lines), the money actually paid to that person (salary, advances,
-- bonuses) and the derived balance. Operational tracking only: this is NOT statutory payroll, files nothing with any
-- institution and calculates NO statutory amount. Social Insurance, Provident Fund and P.A.Y.E. are plain lines that the
-- Owner types in from the accountant's figures.
--
-- A separate ledger from FIN.1A (appointment sales and payments in) and FIN.1B.1 (expenses and expense payments):
-- nothing here reads, writes, copies into or joins those tables. No personnel row ever becomes an expense.
--
-- =====================================================================
-- CORE PRINCIPLE
-- =====================================================================
-- An EARNING is not a PAYMENT. Recording what a person earned never implies that money left the till; only a posted
-- staff_payments row does. An ADVANCE is a payment (purpose 'advance'), never a line: it is counted once, inside the paid
-- total, and never again as a deduction. No institution deposit lives here (that is FIN.1C.2).
--
--   staff_line_kinds       - system reference catalog: 16 kinds, each with an explicit line_group
--   staff_finance_periods  - one AGGREGATE per tenant / staff member / month / currency: lifecycle, cached totals, version
--   staff_period_lines     - earning / employee_deduction / employer_cost lines of a period
--   staff_payments         - money actually paid to the person; never edited, never deleted, only voided
--
-- Every formula is written on the line GROUP, never on a list of kinds: a kind joins the arithmetic by being assigned a
-- group in the catalog (the single exception is the P.A.Y.E. figure, which the Owner asked to see by name).
--   G = earning_total              sum of active earning lines
--   D = employee_deduction_total   sum of active employee_deduction lines (Social Insurance share, Provident Fund share,
--                                  P.A.Y.E., other)
--   N = G - D                      net payable to the employee            (generated column net_payable)
--   P = paid_total                 sum of posted payments, advances included (advance_total A is a subset of P)
--   R = N - P                      employee outstanding (negative = paid in excess, possible only while the period is open)
--   E = employer_cost_total        sum of active employer_cost lines;     personnel cost = G + E
--
-- =====================================================================
-- LIFECYCLE (authoritative; enforced by trigger T1 and the T2/T3 lock rules, not repeated in the RPCs)
-- =====================================================================
--   open       lines of every group can be added, edited (amount AND description) and voided; payments of every purpose are
--              recorded WITHOUT a cap (an advance may be recorded before any earning line exists); the period may be
--              'overpaid' (P above N) and is then shown as such. Finalization is the control point.
--   finalized  finalization stores an immutable snapshot of the employee statement (finalized_earning_total,
--              finalized_deduction_total, finalized_net_payable). It requires G above 0 (FN031) and P at most N (FN033).
--              Afterwards the employee statement is LOCKED: no add, edit or void of an earning or employee-deduction
--              line (FN024), except that explicit, flagged adjustment lines (kinds adjustment_credit and
--              adjustment_debit) can still be appended. Employer-cost lines stay editable (amount and description) and
--              voidable, and can be added. Payments are capped at the outstanding amount (FN023) and P can never exceed N
--              (FN026). A payment recorded after finalization is flagged post_finalization.
--   reopen     finalized -> open, with a reason and the expected version. Only while no POSTED payment that was recorded
--              after finalization exists (FN027). Clears the snapshot.
--   cancelled  terminal, no edits (FN025). Cancel needs no posted payment of any purpose (FN027).
-- currency is a snapshot of the tenant currency at creation and is immutable; every line and payment carries the period's
-- currency through a composite foreign key. Nothing is ever hard-deleted.
--
-- =====================================================================
-- VERSION (one owner: trigger T1)
-- =====================================================================
-- staff_finance_periods.version protects the edit and transition RPCs against stale forms. It starts at 1 and is written
-- by exactly two things: the column default on INSERT and trigger T1 on UPDATE. No RPC assigns it. T1 increments it
-- exactly once per UPDATE statement that changes any tracked column, and every real change of the aggregate moves one:
--   * a line add, a line edit (amount, description or both) and a line void (+1 each)
--   * a payment record and a payment void (+1 each)
--   * finalize, reopen, cancel and a due-date change (+1 each)
-- A no-op, an idempotent replay and a refused action execute no UPDATE that changes a tracked column and change nothing.
-- To make "every real child change moves a tracked column" true without a second version writer, the period carries
-- content_revision, a change counter that trigger T4 increases by one after every real line or payment mutation (in the
-- same UPDATE as the refreshed totals). A description-only edit moves no total but still moves the counter, so it bumps the
-- version exactly once. T1 treats the counter as a tracked column and allows it to move by at most one per UPDATE.
--
-- =====================================================================
-- TRIGGERS (invariants only)
-- =====================================================================
-- T1 enforce_staff_period_invariants   (periods, BEFORE INSERT OR UPDATE)
-- T2 enforce_staff_line_invariants     (lines,   BEFORE INSERT OR UPDATE)
-- T3 enforce_staff_payment_invariants  (payments, BEFORE INSERT OR UPDATE)
-- T4 recalculate_staff_period_totals   (lines AFTER INSERT OR UPDATE; payments AFTER INSERT OR UPDATE OF status)
-- They protect rules that must hold even if a future trusted code path writes the tables directly: lifecycle legality,
-- the finalization checks and the stored snapshot, the employee-statement lock, the narrow reopen guard, floors (D at most
-- G; P at most N once finalized), payment cap after finalization, no payment on a cancelled period, payment rows never
-- edited and never un-voided, cached totals equal to the live sums, version bookkeeping. They do NOT validate string shape,
-- length or enum membership (table CHECKs and the RPCs do), check permissions, write audit events or handle idempotency.
-- LOCK ORDER everywhere: the period row first, then line or payment rows.
--
-- =====================================================================
-- IDEMPOTENCY
-- =====================================================================
-- create_staff_finance_period, add_staff_period_line and record_staff_payment REQUIRE a non-null key. The ORIGINAL create
-- payload of a period and of a line is fingerprinted (md5 over length-prefixed components, Faz 2F.1 convention, version
-- tagged) and stored; a replay compares that stored fingerprint, never the live row, because lines and periods are editable
-- afterwards. Payments are immutable, so a replay compares stored columns. Same key + same payload returns the existing ids
-- (noop); a different payload is FN007. SQLSTATE 23505 never reaches a caller.
--
-- =====================================================================
-- ACCESS MODEL
-- =====================================================================
-- All four tables: RLS enabled, ZERO policies, ALL direct privileges revoked from public/anon/authenticated/service_role.
-- The only door in is the SECURITY DEFINER RPC surface below. Reads need finance.staff_view, writes finance.staff_manage
-- (new keys, Owner template only, no role-name checks). Write RPCs return only ids/lifecycle/payment state/version/noop;
-- read models are curated and carry no auth user id, no email, no phone, no created_by / voided_by / cancelled_by /
-- finalized_by, no idempotency data and no staff member id inside a period, line or payment model.
--
-- SQLSTATE taxonomy: reused with identical meaning FN001 unauthenticated, FN002 forbidden, FN004 invalid input, FN006
-- invalid payment method, FN007 idempotency conflict, FN013 stale expected version. New: FN020 period not found, FN021 line
-- not found, FN022 payment not found, FN023 payment above the outstanding amount (finalized period only), FN024 finalized
-- period: employee-statement change not allowed, FN025 period cancelled, FN026 deductions above earnings or a finalized
-- net below its payments, FN027 transition blocked by payments, FN028 duplicate period, FN029 staff member not eligible,
-- FN030 invalid or inactive line kind, FN031 nothing to finalize, FN032 immutability or invariant violation, FN033
-- finalization blocked because payments exceed the net payable. (FN014/FN015 stay reserved for FIN.1B.2; FN034-FN038 are
-- reserved for the FIN.1C.2 institution settlements.)
--
-- No institution tables, no rule tables, no statutory calculation and no export in this migration.

begin;

-- =====================================================================
-- 1. TABLES
-- =====================================================================
create table public.staff_line_kinds (
  code text primary key,
  line_group text not null,
  institution text,
  is_adjustment boolean not null default false,
  display_order smallint not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint staff_line_kinds_code_format check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint staff_line_kinds_group_check check (line_group in ('earning', 'employee_deduction', 'employer_cost')),
  constraint staff_line_kinds_institution_check check (institution is null or institution in ('social_insurance', 'provident_fund')),
  constraint staff_line_kinds_institution_group check (institution is null or line_group in ('employee_deduction', 'employer_cost')),
  constraint staff_line_kinds_adjustment_shape check (not is_adjustment or (line_group in ('earning', 'employee_deduction') and institution is null)),
  constraint staff_line_kinds_display_order_positive check (display_order > 0)
);

comment on table public.staff_line_kinds is
  'Faz FIN.1C.1. System reference catalog of personnel line kinds (7 earning, 5 employee deduction, 4 employer cost). Every kind has exactly one line_group, which drives every formula, report and trigger; institution tags the Social Insurance and Provident Fund kinds (both sides) for the person-level split and the FIN.1C.2 liability. paye is the manual P.A.Y.E. deduction: untagged, never calculated. Classification is immutable once seeded. Labels live in messages/tr.json. Read only through list_staff_line_kinds.';

create table public.staff_finance_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  staff_member_id uuid not null,
  staff_display_name text not null,
  period_month date not null,
  currency text not null,
  lifecycle text not null default 'open',
  due_date date,
  earning_total numeric(12, 2) not null default 0,
  employee_deduction_total numeric(12, 2) not null default 0,
  employer_cost_total numeric(12, 2) not null default 0,
  paid_total numeric(12, 2) not null default 0,
  advance_total numeric(12, 2) not null default 0,
  content_revision integer not null default 0,
  net_payable numeric(12, 2) generated always as (earning_total - employee_deduction_total) stored,
  payment_state text generated always as (
    case when paid_total > earning_total - employee_deduction_total then 'overpaid'
         when earning_total - employee_deduction_total <= 0 then 'nothing_due'
         when paid_total <= 0 then 'unpaid'
         when paid_total < earning_total - employee_deduction_total then 'partially_paid'
         else 'paid' end) stored,
  finalized_earning_total numeric(12, 2),
  finalized_deduction_total numeric(12, 2),
  finalized_net_payable numeric(12, 2),
  version integer not null default 1,
  idempotency_key uuid not null,
  idempotency_fingerprint text not null,
  finalized_at timestamptz,
  finalized_by uuid references auth.users (id),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id),
  cancel_reason text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_periods_staff_fk foreign key (staff_member_id, tenant_id) references public.staff_members (id, tenant_id),
  constraint staff_periods_name_length check (char_length(btrim(staff_display_name)) between 1 and 200),
  constraint staff_periods_month_first_day check (extract(day from period_month) = 1),
  constraint staff_periods_month_range check (period_month between date '2000-01-01' and date '2100-12-01'),
  constraint staff_periods_currency_not_blank check (char_length(btrim(currency)) > 0),
  constraint staff_periods_lifecycle_check check (lifecycle in ('open', 'finalized', 'cancelled')),
  constraint staff_periods_due_date_range check (due_date is null or (due_date >= period_month and due_date <= date '2100-12-31')),
  constraint staff_periods_totals_nonneg check (earning_total >= 0 and employee_deduction_total >= 0 and employer_cost_total >= 0 and paid_total >= 0 and advance_total >= 0),
  constraint staff_periods_deductions_within_earning check (employee_deduction_total <= earning_total),
  constraint staff_periods_finalized_paid_within_net check (lifecycle = 'open' or paid_total <= earning_total - employee_deduction_total),
  constraint staff_periods_advance_within_paid check (advance_total <= paid_total),
  constraint staff_periods_version_positive check (version >= 1),
  constraint staff_periods_content_revision_nonneg check (content_revision >= 0),
  constraint staff_periods_fingerprint_format check (idempotency_fingerprint ~ '^[0-9a-f]{32}$'),
  constraint staff_periods_snapshot_state check (
    (lifecycle = 'finalized'
       and finalized_earning_total is not null and finalized_deduction_total is not null and finalized_net_payable is not null
       and finalized_deduction_total <= finalized_earning_total
       and finalized_net_payable = finalized_earning_total - finalized_deduction_total)
    or (lifecycle <> 'finalized'
       and finalized_earning_total is null and finalized_deduction_total is null and finalized_net_payable is null)),
  constraint staff_periods_finalize_state check ((lifecycle = 'finalized') = (finalized_at is not null) and (lifecycle = 'finalized' or finalized_by is null)),
  constraint staff_periods_cancel_state check (
    (lifecycle = 'cancelled' and cancelled_at is not null and cancel_reason is not null)
    or (lifecycle <> 'cancelled' and cancelled_at is null and cancelled_by is null and cancel_reason is null)),
  constraint staff_periods_cancel_reason_length check (cancel_reason is null or char_length(btrim(cancel_reason)) between 1 and 500),
  constraint staff_periods_id_tenant_unique unique (id, tenant_id),
  constraint staff_periods_id_tenant_currency_unique unique (id, tenant_id, currency),
  constraint staff_periods_idempotency_key_unique unique (tenant_id, idempotency_key)
);

create unique index staff_periods_one_active_per_month
  on public.staff_finance_periods (tenant_id, staff_member_id, period_month) where lifecycle <> 'cancelled';

comment on table public.staff_finance_periods is
  'Faz FIN.1C.1. The AGGREGATE of the personnel ledger: one row per tenant, staff member, calendar month and currency (a cancelled period frees the month). lifecycle (open, finalized, cancelled) is stored; payment_state and net_payable are generated. The five totals are a cache of the active lines and posted payments, refreshed by trigger T4 and verified against the live sums by trigger T1 on every update. content_revision is the change counter T4 moves after every real line or payment change so that every such change bumps version (T1 is the only writer of version and updated_at). The finalization snapshot columns are present exactly while the period is finalized. staff_display_name is a snapshot taken at creation. currency is a tenant-currency snapshot, immutable. An open period may be overpaid; a finalized one may not.';

create table public.staff_period_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  period_id uuid not null,
  currency text not null,
  kind text not null references public.staff_line_kinds (code),
  line_group text not null,
  institution text,
  amount numeric(12, 2) not null,
  description text,
  calculation_source text not null default 'manual',
  status text not null default 'active',
  post_finalization boolean not null default false,
  idempotency_key uuid not null,
  idempotency_fingerprint text not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_by uuid references auth.users (id),
  voided_at timestamptz,
  void_reason text,
  constraint staff_lines_period_fk foreign key (period_id, tenant_id, currency)
    references public.staff_finance_periods (id, tenant_id, currency),
  constraint staff_lines_group_check check (line_group in ('earning', 'employee_deduction', 'employer_cost')),
  constraint staff_lines_institution_check check (institution is null or institution in ('social_insurance', 'provident_fund')),
  constraint staff_lines_institution_group check (institution is null or line_group <> 'earning'),
  constraint staff_lines_amount_positive check (amount > 0),
  constraint staff_lines_description_length check (description is null or char_length(btrim(description)) between 1 and 200),
  constraint staff_lines_source_check check (calculation_source = 'manual'),
  constraint staff_lines_status_check check (status in ('active', 'voided')),
  constraint staff_lines_void_state check (
    (status = 'active' and voided_at is null and voided_by is null and void_reason is null)
    or (status = 'voided' and voided_at is not null and void_reason is not null)),
  constraint staff_lines_void_reason_length check (void_reason is null or char_length(btrim(void_reason)) between 1 and 500),
  constraint staff_lines_fingerprint_format check (idempotency_fingerprint ~ '^[0-9a-f]{32}$'),
  constraint staff_lines_id_tenant_unique unique (id, tenant_id),
  constraint staff_lines_idempotency_key_unique unique (tenant_id, idempotency_key)
);

comment on table public.staff_period_lines is
  'Faz FIN.1C.1. One typed amount of a period: earning, employee deduction or employer cost, by the kind''s line_group (copied from the catalog at insert, with the institution tag, and immutable: a later catalog change never reclassifies history). Only amount and description (where the lock matrix allows it: open period, or an employer-cost line) and the void block ever change; a line is never deleted, only voided (active to voided, once, with a reason). post_finalization records that the line was added to an already finalized period (adjustments and employer costs). The stored fingerprint describes the ORIGINAL add payload and is never recomputed. calculation_source is pinned to manual until FIN.1C.3. The composite FK keeps a line in its period''s tenant and currency.';

create table public.staff_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  period_id uuid not null,
  currency text not null,
  purpose text not null,
  method text not null,
  amount numeric(12, 2) not null,
  paid_at timestamptz not null default now(),
  note text,
  status text not null default 'posted',
  post_finalization boolean not null default false,
  idempotency_key uuid not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  voided_by uuid references auth.users (id),
  voided_at timestamptz,
  void_reason text,
  constraint staff_payments_period_fk foreign key (period_id, tenant_id, currency)
    references public.staff_finance_periods (id, tenant_id, currency),
  constraint staff_payments_purpose_check check (purpose in ('salary', 'advance', 'bonus', 'other')),
  constraint staff_payments_method_check check (method in ('cash', 'card', 'bank_transfer', 'other')),
  constraint staff_payments_amount_positive check (amount > 0),
  constraint staff_payments_paid_at_floor check (paid_at >= timestamptz '2000-01-01 00:00:00+00'),
  constraint staff_payments_note_length check (note is null or char_length(btrim(note)) between 1 and 500),
  constraint staff_payments_status_check check (status in ('posted', 'voided')),
  constraint staff_payments_void_state check (
    (status = 'posted' and voided_at is null and voided_by is null and void_reason is null)
    or (status = 'voided' and voided_at is not null and void_reason is not null)),
  constraint staff_payments_void_reason_length check (void_reason is null or char_length(btrim(void_reason)) between 1 and 500),
  constraint staff_payments_idempotency_key_unique unique (tenant_id, idempotency_key)
);

comment on table public.staff_payments is
  'Faz FIN.1C.1. Money actually paid to the staff member (salary, advance, bonus, other) against a period. Append-only: a row is never edited and never deleted; an incorrect payment is voided (posted to voided, one way, void fields set) and kept as evidence. An advance is a payment of purpose advance, never a line. There is no amount cap while the period is open (an advance may precede the earnings); once the period is finalized a payment may not exceed the outstanding amount. post_finalization records that the period was already finalized when the payment was recorded and is the exact signal of the narrow reopen guard. Payments are period-level (no line reference). The composite FK keeps a payment in its period''s tenant and currency. These are payments to the person, never institution deposits and never FIN.1B expense payments.';

create index staff_periods_tenant_month_idx on public.staff_finance_periods (tenant_id, period_month desc, staff_member_id);
create index staff_periods_tenant_open_idx on public.staff_finance_periods (tenant_id, period_month) where lifecycle <> 'cancelled';
create index staff_lines_period_idx on public.staff_period_lines (period_id, status, created_at, id);
create index staff_lines_institution_idx on public.staff_period_lines (tenant_id, institution) where institution is not null and status = 'active';
create index staff_payments_period_idx on public.staff_payments (period_id, paid_at, id);
create index staff_payments_tenant_paid_at_idx on public.staff_payments (tenant_id, paid_at) where status = 'posted';

-- =====================================================================
-- 2. LOCKDOWN - RLS on, zero policies, all direct grants revoked. The only
--    access path is the SECURITY DEFINER RPC surface below.
-- =====================================================================
alter table public.staff_line_kinds enable row level security;
alter table public.staff_finance_periods enable row level security;
alter table public.staff_period_lines enable row level security;
alter table public.staff_payments enable row level security;

revoke all on public.staff_line_kinds from public, anon, authenticated, service_role;
revoke all on public.staff_finance_periods from public, anon, authenticated, service_role;
revoke all on public.staff_period_lines from public, anon, authenticated, service_role;
revoke all on public.staff_payments from public, anon, authenticated, service_role;

-- =====================================================================
-- 3. KIND SEED - idempotent; never touches is_active, so a retired kind
--    stays retired when this is re-run, and the classification of a seeded kind is never rewritten.
-- =====================================================================
insert into public.staff_line_kinds (code, line_group, institution, is_adjustment, display_order) values
  ('salary', 'earning', null, false, 10),
  ('bonus', 'earning', null, false, 20),
  ('commission', 'earning', null, false, 30),
  ('overtime', 'earning', null, false, 40),
  ('extra_payment', 'earning', null, false, 50),
  ('other_earning', 'earning', null, false, 60),
  ('adjustment_credit', 'earning', null, true, 90),
  ('employee_social_insurance', 'employee_deduction', 'social_insurance', false, 110),
  ('employee_provident_fund', 'employee_deduction', 'provident_fund', false, 120),
  ('paye', 'employee_deduction', null, false, 130),
  ('other_deduction', 'employee_deduction', null, false, 140),
  ('adjustment_debit', 'employee_deduction', null, true, 190),
  ('employer_social_insurance', 'employer_cost', 'social_insurance', false, 210),
  ('employer_provident_fund', 'employer_cost', 'provident_fund', false, 220),
  ('private_insurance', 'employer_cost', null, false, 230),
  ('other_employer_cost', 'employer_cost', null, false, 240)
on conflict (code) do nothing;

-- =====================================================================
-- 4. HELPERS (private; no API-role grant)
-- =====================================================================

-- H1. The one definition of the live totals: active lines by GROUP, posted payments only (voided rows never count),
--     advances as the posted subset of purpose 'advance'. Unbounded numeric on purpose: T4 range-checks the sums and raises a
--     stable FN004 instead of a raw numeric overflow.
create function private.staff_period_live_totals(p_period_id uuid)
returns table (
  earning_total numeric,
  employee_deduction_total numeric,
  employer_cost_total numeric,
  paid_total numeric,
  advance_total numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((select sum(l.amount) from public.staff_period_lines l
              where l.period_id = p_period_id and l.status = 'active' and l.line_group = 'earning'), 0),
    coalesce((select sum(l.amount) from public.staff_period_lines l
              where l.period_id = p_period_id and l.status = 'active' and l.line_group = 'employee_deduction'), 0),
    coalesce((select sum(l.amount) from public.staff_period_lines l
              where l.period_id = p_period_id and l.status = 'active' and l.line_group = 'employer_cost'), 0),
    coalesce((select sum(p.amount) from public.staff_payments p
              where p.period_id = p_period_id and p.status = 'posted'), 0),
    coalesce((select sum(p.amount) from public.staff_payments p
              where p.period_id = p_period_id and p.status = 'posted' and p.purpose = 'advance'), 0);
$$;

comment on function private.staff_period_live_totals(uuid) is
  'Faz FIN.1C.1 helper H1. The single definition of the five live totals of a period: active earning, employee_deduction and employer_cost lines (by line_group), posted payments, posted advances. Voided rows never count. Used by triggers T1, T3 and T4; the read models and the cached columns are verified against it.';

-- H2. Text normalization: trim space, tab, CR, LF at both ends; blank becomes null. Nothing else is rewritten (no case
--     folding, no inner-whitespace collapse, no Unicode normalization).
create function private.normalize_staff_finance_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(p_text, ' ' || chr(9) || chr(10) || chr(13)), '');
$$;

comment on function private.normalize_staff_finance_text(text) is
  'Faz FIN.1C.1 helper H2. Trims space, tab, CR and LF from both ends; a blank result becomes null. Nothing else is normalized.';

-- H3. Amount normalization on an UNBOUNDED numeric: a bad value becomes a stable FN004, never a raw numeric overflow.
create function private.normalize_staff_finance_amount(p_amount numeric)
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

comment on function private.normalize_staff_finance_amount(numeric) is
  'Faz FIN.1C.1 helper H3. Rejects null, NaN and +/-Infinity, applies trim_scale (250.500 is 250.5), then requires at most 2 decimals and 0 < value <= 9999999999.99. Raises FN004 and returns the value as numeric(12,2).';

-- H4. Period month: the first day of a month between 2000-01-01 and 2100-12-01.
create function private.normalize_staff_finance_month(p_month date)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_month is null
     or extract(day from p_month) <> 1
     or p_month < date '2000-01-01'
     or p_month > date '2100-12-01' then
    raise exception 'invalid period month' using errcode = 'FN004';
  end if;
  return p_month;
end;
$$;

comment on function private.normalize_staff_finance_month(date) is
  'Faz FIN.1C.1 helper H4. Requires the first day of a month between 2000-01-01 and 2100-12-01 (FN004 otherwise, including null) and returns it.';

-- H5. Canonical fingerprint of the ORIGINAL period-create payload: a version tag plus 3 payload fields = 4 components, each
--     rendered as length || ':' || value, joined with '|', hashed with md5 (Faz 2F.1 convention). The tenant is not hashed
--     (idempotency is tenant-scoped); the currency and the staff display name are server-assigned and not hashed either.
create function private.staff_period_create_fingerprint(
  p_staff_member_id uuid,
  p_period_month date,
  p_due_date date
)
returns text
language sql
immutable
set search_path = ''
as $$
  with fields as (
    select
      'staff.period.create.v1'::text as f0,
      lower(p_staff_member_id::text) as f1,
      to_char(p_period_month, 'YYYY-MM-DD') as f2,
      coalesce(to_char(p_due_date, 'YYYY-MM-DD'), 'NO_DUE') as f3
  )
  select md5(
    array_to_string(
      array[
        length(f0)::text || ':' || f0,
        length(f1)::text || ':' || f1,
        length(f2)::text || ':' || f2,
        length(f3)::text || ':' || f3
      ],
      '|'
    )
  )
  from fields;
$$;

comment on function private.staff_period_create_fingerprint(uuid, date, date) is
  'Faz FIN.1C.1 helper H5. md5 over 4 length-prefixed components in fixed order: tag staff.period.create.v1, staff member id (lowercase uuid), period month (YYYY-MM-DD), due date (NO_DUE when null). Inputs must already be normalized. The tenant is not part of it (idempotency is tenant-scoped).';

-- H6. Canonical fingerprint of the ORIGINAL line-add payload: a version tag plus 4 payload fields = 5 components.
create function private.staff_line_add_fingerprint(
  p_period_id uuid,
  p_kind text,
  p_amount numeric,
  p_description text
)
returns text
language sql
immutable
set search_path = ''
as $$
  with fields as (
    select
      'staff.line.add.v1'::text as f0,
      lower(p_period_id::text) as f1,
      p_kind as f2,
      (p_amount::numeric(12, 2))::text as f3,
      coalesce(p_description, '') as f4
  )
  select md5(
    array_to_string(
      array[
        length(f0)::text || ':' || f0,
        length(f1)::text || ':' || f1,
        length(f2)::text || ':' || f2,
        length(f3)::text || ':' || f3,
        length(f4)::text || ':' || f4
      ],
      '|'
    )
  )
  from fields;
$$;

comment on function private.staff_line_add_fingerprint(uuid, text, numeric, text) is
  'Faz FIN.1C.1 helper H6. md5 over 5 length-prefixed components in fixed order: tag staff.line.add.v1, period id (lowercase uuid), kind, amount as numeric(12,2) text (two decimals), description (empty when absent). Inputs must already be normalized. A pipe inside a description cannot shift a boundary (length prefixes).';

-- H7. Stateless payment validation shared by record_staff_payment. There is deliberately NO amount-versus-net check here or
--     anywhere in the RPC: an open period has no payment-time cap; the cap after finalization lives in trigger T3.
create function private.normalize_staff_payment_input(
  p_amount numeric,
  p_purpose text,
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
  v_amount := private.normalize_staff_finance_amount(p_amount);

  if p_purpose is null or p_purpose not in ('salary', 'advance', 'bonus', 'other') then
    raise exception 'invalid payment purpose' using errcode = 'FN004';
  end if;

  if p_method is null or p_method not in ('cash', 'card', 'bank_transfer', 'other') then
    raise exception 'invalid payment method' using errcode = 'FN006';
  end if;

  if p_paid_at is null
     or p_paid_at < timestamptz '2000-01-01 00:00:00+00'
     or p_paid_at > now() + interval '1 hour' then
    raise exception 'invalid payment date' using errcode = 'FN004';
  end if;

  v_note := private.normalize_staff_finance_text(p_note);
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note too long' using errcode = 'FN004';
  end if;

  return jsonb_build_object(
    'amount', v_amount,
    'purpose', p_purpose,
    'method', p_method,
    'paid_at', to_char(p_paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'note', v_note
  );
end;
$$;

comment on function private.normalize_staff_payment_input(numeric, text, text, timestamptz, text) is
  'Faz FIN.1C.1 helper H7. Stateless payment validation: amount through normalize_staff_finance_amount (FN004), purpose must be salary/advance/bonus/other (FN004), method must be cash/card/bank_transfer/other (FN006), paid_at between 2000-01-01 and now() + 1 hour (FN004), note trimmed and at most 500 chars (FN004). Returns the normalized {amount, purpose, method, paid_at (UTC text with microseconds), note}. It performs NO amount-versus-net check: an open period has no payment-time cap.';

-- =====================================================================
-- 5. TRIGGERS - invariants only (see the header). Raised codes are the
--    stable FN taxonomy. LOCK ORDER: the period row first, then children.
-- =====================================================================

-- T1. Period invariants and the single owner of version / updated_at.
create function private.enforce_staff_period_invariants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Columns an UPDATE may change. Everything else (id, tenant_id, staff_member_id, staff_display_name, period_month,
  -- currency, idempotency_*, created_*) is immutable by default, so a column added later stays immutable until it is
  -- deliberately added here. net_payable and payment_state are generated: they are excluded from the comparison because they
  -- derive from the totals (and a writer cannot assign them).
  v_mutable constant text[] := array[
    'lifecycle', 'due_date', 'earning_total', 'employee_deduction_total', 'employer_cost_total', 'paid_total',
    'advance_total', 'content_revision', 'finalized_at', 'finalized_by', 'finalized_earning_total',
    'finalized_deduction_total', 'finalized_net_payable', 'cancelled_at', 'cancelled_by', 'cancel_reason',
    'version', 'updated_at', 'net_payable', 'payment_state'
  ];
  v_live record;
  v_live_net numeric;
begin
  if tg_op = 'INSERT' then
    -- T1.1 A new period starts open, version 1, with zero totals and no finalization, snapshot or cancellation data.
    if new.lifecycle <> 'open' or new.version <> 1
       or new.earning_total <> 0 or new.employee_deduction_total <> 0 or new.employer_cost_total <> 0
       or new.paid_total <> 0 or new.advance_total <> 0 or new.content_revision <> 0
       or new.finalized_at is not null or new.finalized_by is not null
       or new.finalized_earning_total is not null or new.finalized_deduction_total is not null
       or new.finalized_net_payable is not null
       or new.cancelled_at is not null or new.cancelled_by is not null or new.cancel_reason is not null then
      raise exception 'a new period must start open, version 1, with zero totals and no finalization or cancellation data'
        using errcode = 'FN032';
    end if;
    return new;
  end if;

  -- T1.2 Default-deny column immutability.
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'immutable period column changed' using errcode = 'FN032';
  end if;

  -- T1.3 version is trigger-managed: a writer that sets it is rejected, so a double increment cannot happen silently.
  if new.version is distinct from old.version then
    raise exception 'version is managed by the trigger' using errcode = 'FN032';
  end if;

  -- Nothing tracked changed: a genuine no-op leaves version and updated_at alone.
  if (new.lifecycle, new.due_date, new.earning_total, new.employee_deduction_total, new.employer_cost_total,
      new.paid_total, new.advance_total, new.content_revision, new.finalized_at, new.finalized_by,
      new.finalized_earning_total, new.finalized_deduction_total, new.finalized_net_payable,
      new.cancelled_at, new.cancelled_by, new.cancel_reason)
     is not distinct from
     (old.lifecycle, old.due_date, old.earning_total, old.employee_deduction_total, old.employer_cost_total,
      old.paid_total, old.advance_total, old.content_revision, old.finalized_at, old.finalized_by,
      old.finalized_earning_total, old.finalized_deduction_total, old.finalized_net_payable,
      old.cancelled_at, old.cancelled_by, old.cancel_reason) then
    new.version := old.version;
    new.updated_at := old.updated_at;
    return new;
  end if;

  -- T1.4 Cancelled is terminal.
  if old.lifecycle = 'cancelled' then
    raise exception 'period is cancelled' using errcode = 'FN025';
  end if;

  -- T1.5 Legal lifecycle transitions only.
  if new.lifecycle <> old.lifecycle
     and not ((old.lifecycle = 'open' and new.lifecycle in ('finalized', 'cancelled'))
              or (old.lifecycle = 'finalized' and new.lifecycle in ('open', 'cancelled'))) then
    raise exception 'illegal lifecycle transition' using errcode = 'FN032';
  end if;

  select * into v_live from private.staff_period_live_totals(old.id);
  v_live_net := v_live.earning_total - v_live.employee_deduction_total;

  if old.lifecycle = 'open' and new.lifecycle = 'finalized' then
    -- T1.6 Finalization needs something to finalize.
    if v_live.earning_total <= 0 then
      raise exception 'nothing to finalize: the earning total is 0' using errcode = 'FN031';
    end if;
    -- T1.7 Finalization needs the posted payments (advances included) to be within the net payable.
    if v_live.paid_total > v_live_net then
      raise exception 'payments and advances exceed the net payable' using errcode = 'FN033';
    end if;
  end if;

  -- T1.8 The snapshot is present exactly while finalized, equals the live statement when it is stored and never changes
  --      while finalized; every state-bound field is coherent with the lifecycle (stable FN032 instead of a raw CHECK error).
  if new.lifecycle = 'finalized' then
    if new.finalized_at is null or new.finalized_earning_total is null
       or new.finalized_deduction_total is null or new.finalized_net_payable is null then
      raise exception 'a finalized period needs finalized_at and the snapshot' using errcode = 'FN032';
    end if;
    if old.lifecycle = 'open' then
      if new.finalized_earning_total <> v_live.earning_total
         or new.finalized_deduction_total <> v_live.employee_deduction_total
         or new.finalized_net_payable <> v_live_net then
        raise exception 'the snapshot must equal the live statement at finalization' using errcode = 'FN032';
      end if;
    elsif (new.finalized_at, new.finalized_by, new.finalized_earning_total, new.finalized_deduction_total,
           new.finalized_net_payable)
          is distinct from
          (old.finalized_at, old.finalized_by, old.finalized_earning_total, old.finalized_deduction_total,
           old.finalized_net_payable) then
      raise exception 'the snapshot is immutable while the period is finalized' using errcode = 'FN032';
    end if;
  elsif new.finalized_at is not null or new.finalized_by is not null
        or new.finalized_earning_total is not null or new.finalized_deduction_total is not null
        or new.finalized_net_payable is not null then
    raise exception 'finalization data must be cleared when the period is not finalized' using errcode = 'FN032';
  end if;
  if new.lifecycle = 'cancelled' then
    if new.cancelled_at is null or new.cancel_reason is null then
      raise exception 'a cancelled period needs cancelled_at and a reason' using errcode = 'FN032';
    end if;
  elsif new.cancelled_at is not null or new.cancelled_by is not null or new.cancel_reason is not null then
    raise exception 'cancellation data is only for a cancelled period' using errcode = 'FN032';
  end if;

  -- T1.9 Narrow reopen: no posted payment that was recorded after finalization.
  if old.lifecycle = 'finalized' and new.lifecycle = 'open' then
    if exists (
      select 1 from public.staff_payments p
      where p.period_id = old.id and p.status = 'posted' and p.post_finalization
    ) then
      raise exception 'a payment was recorded after finalization' using errcode = 'FN027';
    end if;
  end if;

  -- T1.10 Cancel needs a zero posted total (any purpose).
  if new.lifecycle = 'cancelled' and v_live.paid_total > 0 then
    raise exception 'a period with posted payments cannot be cancelled' using errcode = 'FN027';
  end if;

  -- T1.11 The cached totals equal the live sums (T4 maintains them; a raw writer cannot desynchronize them).
  if new.earning_total <> v_live.earning_total
     or new.employee_deduction_total <> v_live.employee_deduction_total
     or new.employer_cost_total <> v_live.employer_cost_total
     or new.paid_total <> v_live.paid_total
     or new.advance_total <> v_live.advance_total then
    raise exception 'cached totals must equal the live sums' using errcode = 'FN032';
  end if;

  -- T1.12 Floors: deductions never above earnings; payments never above the net once finalized.
  if new.employee_deduction_total > new.earning_total then
    raise exception 'employee deductions cannot exceed the earnings' using errcode = 'FN026';
  end if;
  if new.lifecycle = 'finalized' and new.paid_total > new.earning_total - new.employee_deduction_total then
    raise exception 'a finalized period cannot have a net payable below its payments' using errcode = 'FN026';
  end if;

  -- T1.12a The change counter moves by at most one per UPDATE and never backwards.
  if new.content_revision < old.content_revision or new.content_revision - old.content_revision > 1 then
    raise exception 'content_revision may only move forward by one' using errcode = 'FN032';
  end if;

  -- T1.13 Bookkeeping: a real aggregate change bumps version exactly once.
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

comment on function private.enforce_staff_period_invariants() is
  'Faz FIN.1C.1 trigger T1 (staff_finance_periods, BEFORE INSERT OR UPDATE). Invariants only: a new row starts open/version 1 with zero totals (FN032); default-deny column immutability (FN032); version is trigger-managed (FN032); cancelled is terminal (FN025); legal transitions only (FN032); finalize needs earning above 0 (FN031) and payments within the net (FN033), stores a snapshot equal to the live statement, immutable while finalized and cleared on reopen or cancel (FN032); reopen is blocked by a posted payment recorded after finalization (FN027); cancel is blocked by any posted payment (FN027); cached totals equal the live sums (FN032); deductions at most earnings, and payments at most the net once finalized (FN026); content_revision moves by at most one (FN032). The single owner of version and updated_at: one UPDATE that changes any tracked column bumps version exactly once, an UPDATE that changes none changes nothing. No input-shape validation, no permissions, no audit.';

-- T2. Line invariants.
create function private.enforce_staff_line_invariants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mutable constant text[] := array['amount', 'description', 'status', 'voided_at', 'voided_by', 'void_reason', 'updated_at'];
  v_lifecycle text;
  v_parent_found boolean;
  v_kind_group text;
  v_kind_institution text;
  v_kind_adjustment boolean;
  v_kind_active boolean;
begin
  if tg_op = 'INSERT' then
    -- T2.1 Lock the parent so the checks cannot race with a lifecycle change or a payment; a cancelled parent refuses.
    select p.lifecycle into v_lifecycle
    from public.staff_finance_periods p
    where p.id = new.period_id and p.tenant_id = new.tenant_id
    for update;
    v_parent_found := found;
    if v_parent_found and v_lifecycle = 'cancelled' then
      raise exception 'period is cancelled' using errcode = 'FN025';
    end if;

    -- T2.2 The kind must exist and be active.
    select k.line_group, k.institution, k.is_adjustment, k.is_active
      into v_kind_group, v_kind_institution, v_kind_adjustment, v_kind_active
    from public.staff_line_kinds k
    where k.code = new.kind;
    if not found or not v_kind_active then
      raise exception 'unknown or inactive line kind' using errcode = 'FN030';
    end if;

    -- T2.3 The group and institution snapshot come from the catalog.
    if new.line_group is distinct from v_kind_group or new.institution is distinct from v_kind_institution then
      raise exception 'line_group and institution must equal the catalog classification' using errcode = 'FN032';
    end if;

    -- T2.4 Employee-statement lock: a finalized period accepts only adjustment kinds and employer-cost kinds.
    if v_parent_found and v_lifecycle = 'finalized'
       and v_kind_group in ('earning', 'employee_deduction') and not v_kind_adjustment then
      raise exception 'a finalized period accepts only adjustment and employer-cost lines' using errcode = 'FN024';
    end if;

    -- T2.5 post_finalization records whether the period was finalized; a new line is active.
    if (v_parent_found and new.post_finalization is distinct from (v_lifecycle = 'finalized')) or new.status <> 'active' then
      raise exception 'post_finalization must equal the period state and a new line must be active' using errcode = 'FN032';
    end if;
    return new;
  end if;

  -- T2.6 Everything except amount, description and the void block is immutable.
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'immutable line column changed' using errcode = 'FN032';
  end if;

  -- An UPDATE that changes nothing is a no-op: nothing fires, nothing is checked.
  if (new.amount, new.description, new.status, new.voided_at, new.voided_by, new.void_reason)
     is not distinct from
     (old.amount, old.description, old.status, old.voided_at, old.voided_by, old.void_reason) then
    new.updated_at := old.updated_at;
    return new;
  end if;

  -- T2.7 A voided line is final; the only status move is active to voided, with its void block set.
  if old.status = 'voided' or new.status not in ('active', 'voided') then
    raise exception 'a voided line cannot change and a line can only move from active to voided' using errcode = 'FN032';
  end if;
  if new.status = 'voided' and (new.voided_at is null or new.void_reason is null) then
    raise exception 'a voided line needs voided_at and a reason' using errcode = 'FN032';
  end if;
  if new.status = 'active' and (new.voided_at is not null or new.voided_by is not null or new.void_reason is not null) then
    raise exception 'an active line cannot carry void data' using errcode = 'FN032';
  end if;

  -- T2.8 Lock the parent; a cancelled parent refuses every change.
  select p.lifecycle into v_lifecycle
  from public.staff_finance_periods p
  where p.id = new.period_id
  for update;
  if v_lifecycle = 'cancelled' then
    raise exception 'period is cancelled' using errcode = 'FN025';
  end if;

  -- T2.9 Employee-statement lock: on a finalized period an earning or employee-deduction line (adjustments included) can
  --      change neither its amount, its description nor its status. Employer-cost lines stay editable.
  if v_lifecycle = 'finalized' and old.line_group in ('earning', 'employee_deduction') then
    raise exception 'the employee statement is locked after finalization' using errcode = 'FN024';
  end if;

  -- T2.10 Bookkeeping.
  new.updated_at := now();
  return new;
end;
$$;

comment on function private.enforce_staff_line_invariants() is
  'Faz FIN.1C.1 trigger T2 (staff_period_lines, BEFORE INSERT OR UPDATE). Invariants only. INSERT: locks the parent, refuses a cancelled parent (FN025), requires an existing active kind (FN030), the catalog group and institution (FN032), refuses non-adjustment earning and employee-deduction kinds on a finalized period (FN024), checks post_finalization and the active status (FN032). UPDATE: only amount, description and the void block may change (FN032); an UPDATE that changes nothing fires nothing; a voided line is final and the only status move is active to voided (FN032); a cancelled parent refuses (FN025); on a finalized period an earning or employee-deduction line (adjustments included) is locked (FN024) while employer-cost lines stay editable. No input-shape validation.';

-- T3. Payment ledger invariants.
create function private.enforce_staff_payment_invariants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_voidable constant text[] := array['status', 'voided_at', 'voided_by', 'void_reason'];
  v_lifecycle text;
  v_parent_found boolean := false;
  v_live record;
begin
  if tg_op = 'INSERT' then
    if new.status = 'posted' then
      -- T3.1 Lock the parent so the checks cannot race with a lifecycle change, a line change or another payment.
      select p.lifecycle into v_lifecycle
      from public.staff_finance_periods p
      where p.id = new.period_id and p.tenant_id = new.tenant_id
      for update;
      v_parent_found := found;

      if v_parent_found then
        if v_lifecycle = 'cancelled' then
          raise exception 'period is cancelled' using errcode = 'FN025';
        end if;
        -- T3.2 The cap exists ONLY after finalization: an open period has no payment-time cap (an advance may precede the
        --      earnings), and finalization itself refuses payments above the net (T1.7).
        if v_lifecycle = 'finalized' then
          select * into v_live from private.staff_period_live_totals(new.period_id);
          if new.amount > (v_live.earning_total - v_live.employee_deduction_total) - v_live.paid_total then
            raise exception 'payment would exceed the outstanding amount of a finalized period' using errcode = 'FN023';
          end if;
        end if;
      end if;
    end if;

    -- T3.3 post_finalization records whether the period was finalized; a new payment is posted.
    if new.status <> 'posted' or (v_parent_found and new.post_finalization is distinct from (v_lifecycle = 'finalized')) then
      raise exception 'post_finalization must equal the period state and a new payment must be posted' using errcode = 'FN032';
    end if;
    return new;
  end if;

  -- T3.4 Everything except the void block is immutable.
  if (to_jsonb(new) - v_voidable) is distinct from (to_jsonb(old) - v_voidable) then
    raise exception 'payment rows are not editable' using errcode = 'FN032';
  end if;

  -- T3.5 The only allowed transition is posted -> voided, with its void block set; a voided row is final (no un-void).
  if (new.status, new.voided_at, new.voided_by, new.void_reason)
     is distinct from
     (old.status, old.voided_at, old.voided_by, old.void_reason) then
    if not (old.status = 'posted' and new.status = 'voided') then
      raise exception 'a payment can only move from posted to voided' using errcode = 'FN032';
    end if;
    if new.voided_at is null or new.void_reason is null then
      raise exception 'a voided payment needs voided_at and a reason' using errcode = 'FN032';
    end if;
  end if;

  return new;
end;
$$;

comment on function private.enforce_staff_payment_invariants() is
  'Faz FIN.1C.1 trigger T3 (staff_payments, BEFORE INSERT OR UPDATE). Invariants only: a posted insert locks the parent period, refuses a cancelled parent (FN025) and, ONLY when the parent is finalized, refuses an amount above the live outstanding amount (FN023); an open parent has no cap. post_finalization must equal the parent state and a new payment is posted (FN032). An UPDATE may change nothing except the void block, and only posted to voided (FN032); a voided row is final. No input-shape validation.';

-- T4. After a real line or payment mutation, refresh the cached totals and the change counter in ONE update.
create function private.recalculate_staff_period_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_live record;
  v_max constant numeric := 9999999999.99;
begin
  -- An UPDATE that changed no column is not a mutation: nothing fires, nothing moves.
  if tg_op = 'UPDATE' and old is not distinct from new then
    return null;
  end if;

  -- Period first (the RPCs already hold it; a trusted raw writer takes the same order).
  perform 1 from public.staff_finance_periods p where p.id = new.period_id for update;

  select * into v_live from private.staff_period_live_totals(new.period_id);
  if v_live.earning_total > v_max or v_live.employee_deduction_total > v_max
     or v_live.employer_cost_total > v_max or v_live.paid_total > v_max then
    raise exception 'a period total would exceed the supported range' using errcode = 'FN004';
  end if;

  -- One UPDATE: the five totals and the change counter. Trigger T1 verifies the totals against the live sums, checks the
  -- floors and turns this into exactly one version bump, even when no total moved (a description-only edit).
  update public.staff_finance_periods
  set earning_total = v_live.earning_total,
      employee_deduction_total = v_live.employee_deduction_total,
      employer_cost_total = v_live.employer_cost_total,
      paid_total = v_live.paid_total,
      advance_total = v_live.advance_total,
      content_revision = content_revision + 1
  where id = new.period_id;

  return null;
end;
$$;

comment on function private.recalculate_staff_period_totals() is
  'Faz FIN.1C.1 trigger T4 (staff_period_lines AFTER INSERT OR UPDATE; staff_payments AFTER INSERT OR UPDATE OF status). After every real mutation of a line or a payment it locks the parent, recomputes the five live totals and issues ONE update that refreshes them and increases content_revision by one; trigger T1 verifies the totals, checks the floors and converts the update into exactly one version bump. A range overflow is a stable FN004. An UPDATE that changed no column is not a mutation and fires nothing.';

create trigger enforce_staff_period_invariants_trg
  before insert or update on public.staff_finance_periods
  for each row
  execute function private.enforce_staff_period_invariants();

create trigger enforce_staff_line_invariants_trg
  before insert or update on public.staff_period_lines
  for each row
  execute function private.enforce_staff_line_invariants();

create trigger enforce_staff_payment_invariants_trg
  before insert or update on public.staff_payments
  for each row
  execute function private.enforce_staff_payment_invariants();

create trigger recalculate_staff_totals_after_line_trg
  after insert or update on public.staff_period_lines
  for each row
  execute function private.recalculate_staff_period_totals();

create trigger recalculate_staff_totals_after_payment_trg
  after insert or update of status on public.staff_payments
  for each row
  execute function private.recalculate_staff_period_totals();

comment on trigger enforce_staff_period_invariants_trg on public.staff_finance_periods is
  'Faz FIN.1C.1 T1: period invariants, version and updated_at bookkeeping.';
comment on trigger enforce_staff_line_invariants_trg on public.staff_period_lines is
  'Faz FIN.1C.1 T2: line invariants and the employee-statement lock.';
comment on trigger enforce_staff_payment_invariants_trg on public.staff_payments is
  'Faz FIN.1C.1 T3: payment ledger invariants (append-only, void-only, cap after finalization).';
comment on trigger recalculate_staff_totals_after_line_trg on public.staff_period_lines is
  'Faz FIN.1C.1 T4: refresh the cached totals and the change counter after a real line mutation.';
comment on trigger recalculate_staff_totals_after_payment_trg on public.staff_payments is
  'Faz FIN.1C.1 T4: refresh the cached totals and the change counter after a payment insert or void.';

-- =====================================================================
-- 6. THE ONE WRITER OF staff_payments
-- =====================================================================
create function private.post_staff_payment(
  p_tenant_id uuid,
  p_period_id uuid,
  p_purpose text,
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
  v_currency text;
  v_post boolean;
begin
  -- The calling RPC holds the period lock; the currency and the finalization flag come from the locked row.
  select pe.currency, (pe.lifecycle = 'finalized') into v_currency, v_post
  from public.staff_finance_periods pe
  where pe.id = p_period_id and pe.tenant_id = p_tenant_id;

  begin
    insert into public.staff_payments (
      tenant_id, period_id, currency, purpose, method, amount, paid_at, note, post_finalization, idempotency_key, created_by
    )
    values (
      p_tenant_id, p_period_id, v_currency, p_purpose, p_method, p_amount, p_paid_at, p_note,
      coalesce(v_post, false), p_idempotency_key, auth.uid()
    )
    returning id into v_id;
  exception when unique_violation then
    raise exception 'idempotency key already used for another payment' using errcode = 'FN007';
  end;

  perform private.log_audit_event(
    p_tenant_id, 'finance.staff_payment_recorded', 'staff_payment', v_id,
    null,
    jsonb_build_object(
      'period_id', p_period_id, 'purpose', p_purpose, 'method', p_method, 'amount', p_amount,
      'currency', v_currency, 'paid_at', p_paid_at, 'post_finalization', coalesce(v_post, false)
    )
  );

  return v_id;
end;
$$;

comment on function private.post_staff_payment(uuid, uuid, text, numeric, text, timestamptz, text, uuid) is
  'Faz FIN.1C.1 helper H8. The only writer of staff_payments. Takes already-normalized values and the period lock held by the caller, inserts the payment with the currency and the post_finalization flag of the locked period (triggers T3 and T4 fire), writes the finance.staff_payment_recorded audit event, returns the payment id. A unique-key race becomes FN007.';

-- =====================================================================
-- 7. WRITE RPCs (private implementations). Error precedence, in every one: authentication, required-parameter presence,
--    row lock and not-found, permission, defined-success short-circuits (replay, already in the target state), stateless
--    validation, state checks owned by the RPC (version, references), the write (where triggers raise lifecycle and
--    invariant codes). LOCK ORDER: the period row first, then line or payment rows.
-- =====================================================================

create function private.create_staff_finance_period(
  p_tenant_id uuid,
  p_staff_member_id uuid,
  p_period_month date,
  p_idempotency_key uuid default null,
  p_due_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date;
  v_fingerprint text;
  v_existing public.staff_finance_periods;
  v_staff_name text;
  v_currency text;
  v_id uuid;
  v_lifecycle text;
  v_state text;
  v_version integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_idempotency_key is null or p_tenant_id is null then
    raise exception 'idempotency key and tenant are required' using errcode = 'FN004';
  end if;

  -- A foreign, non-member or nonexistent tenant is indistinguishable: FN002 for all of them.
  if not private.has_permission(p_tenant_id, 'finance.staff_manage') then
    raise exception 'finance.staff_manage required' using errcode = 'FN002';
  end if;

  -- ---- stateless validation and normalization -------------------------------------------------
  if p_staff_member_id is null then
    raise exception 'staff member required' using errcode = 'FN004';
  end if;

  v_month := private.normalize_staff_finance_month(p_period_month);

  if p_due_date is not null and (p_due_date < v_month or p_due_date > date '2100-12-31') then
    raise exception 'invalid due date' using errcode = 'FN004';
  end if;

  v_fingerprint := private.staff_period_create_fingerprint(p_staff_member_id, v_month, p_due_date);

  -- ---- replay ---------------------------------------------------------------------------------
  select * into v_existing
  from public.staff_finance_periods
  where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.idempotency_fingerprint = v_fingerprint then
      return jsonb_build_object(
        'periodId', v_existing.id, 'lifecycle', v_existing.lifecycle, 'paymentState', v_existing.payment_state,
        'version', v_existing.version, 'noop', true
      );
    end if;
    raise exception 'idempotency key already used with a different payload' using errcode = 'FN007';
  end if;

  -- ---- stateful validation --------------------------------------------------------------------
  select btrim(s.full_name) into v_staff_name
  from public.staff_members s
  where s.id = p_staff_member_id and s.tenant_id = p_tenant_id and s.deleted_at is null;
  if v_staff_name is null then
    raise exception 'staff member not found or not available' using errcode = 'FN029';
  end if;

  if v_month > (date_trunc('month', private.tenant_local_date(p_tenant_id)::timestamp) + interval '1 month')::date then
    raise exception 'period month too far in the future' using errcode = 'FN004';
  end if;

  -- Deliberately NO "does a period already exist for this staff member and month" pre-check here. The partial unique index
  -- is the authority and the insert below reports a lost month race as FN028. A pre-check would turn an identical
  -- concurrent retry (same key, same payload) into a spurious FN028 whenever the winner commits between the replay lookup
  -- above and the pre-check (the FIN.1B.1 create_expense lesson; regression test K1b).
  select t.currency into v_currency from public.tenants t where t.id = p_tenant_id;

  -- ---- write ----------------------------------------------------------------------------------
  insert into public.staff_finance_periods (
    tenant_id, staff_member_id, staff_display_name, period_month, currency, due_date,
    idempotency_key, idempotency_fingerprint, created_by
  )
  values (
    p_tenant_id, p_staff_member_id, v_staff_name, v_month, v_currency, p_due_date,
    p_idempotency_key, v_fingerprint, auth.uid()
  )
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    -- Lost a race. Either the same key committed first (compare and answer like a replay) or another key took the staff
    -- member and month (the partial unique index): never a raw 23505.
    select * into v_existing
    from public.staff_finance_periods
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    if found then
      if v_existing.idempotency_fingerprint = v_fingerprint then
        return jsonb_build_object(
          'periodId', v_existing.id, 'lifecycle', v_existing.lifecycle, 'paymentState', v_existing.payment_state,
          'version', v_existing.version, 'noop', true
        );
      end if;
      raise exception 'idempotency key already used with a different payload' using errcode = 'FN007';
    end if;
    raise exception 'a period already exists for this staff member and month' using errcode = 'FN028';
  end if;

  perform private.log_audit_event(
    p_tenant_id, 'finance.staff_period_created', 'staff_finance_period', v_id,
    null,
    jsonb_build_object(
      'staff_member_id', p_staff_member_id, 'period_month', v_month, 'currency', v_currency, 'due_date', p_due_date
    )
  );

  select pe.lifecycle, pe.payment_state, pe.version into v_lifecycle, v_state, v_version
  from public.staff_finance_periods pe where pe.id = v_id;

  return jsonb_build_object(
    'periodId', v_id, 'lifecycle', v_lifecycle, 'paymentState', v_state, 'version', v_version, 'noop', false
  );
end;
$$;

comment on function private.create_staff_finance_period(uuid, uuid, date, uuid, date) is
  'Faz FIN.1C.1. Requires finance.staff_manage. p_idempotency_key is REQUIRED (null is FN004). Order: authentication, key and tenant presence, permission, stateless validation (staff member required, month through H4, due date between the month start and 2100-12-31: FN004), fingerprint of the original payload, replay lookup (same stored fingerprint returns the existing period with noop=true, a different one is FN007), stateful validation (staff member in the tenant and not deleted: FN029; month at most the tenant-local current month plus one: FN004), insert on conflict do nothing (there is deliberately no duplicate-month pre-check: the partial unique index decides; a conflict on the same key is answered like a replay when the payload is identical and FN007 otherwise, any other conflict, the staff member and month already taken by another key, is FN028; never 23505), audit finance.staff_period_created. Currency is the tenant''s, the display name the trimmed full_name. Returns {periodId, lifecycle, paymentState, version, noop}; version starts at 1.';

create function private.update_staff_finance_period(
  p_period_id uuid,
  p_due_date date,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cur public.staff_finance_periods;
  v_new public.staff_finance_periods;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_period_id is null then
    raise exception 'period id required' using errcode = 'FN004';
  end if;

  -- 1. lock the aggregate, 2. permission against the locked row's tenant
  select * into v_cur from public.staff_finance_periods where id = p_period_id for update;
  if not found then
    raise exception 'period not found' using errcode = 'FN020';
  end if;

  if not private.has_permission(v_cur.tenant_id, 'finance.staff_manage') then
    raise exception 'finance.staff_manage required' using errcode = 'FN002';
  end if;

  if p_expected_version is null then
    raise exception 'expected version required' using errcode = 'FN004';
  end if;

  if p_due_date is not null and (p_due_date < v_cur.period_month or p_due_date > date '2100-12-31') then
    raise exception 'invalid due date' using errcode = 'FN004';
  end if;

  -- The version is validated BEFORE the no-op decision: a stale form never succeeds, even with equal values.
  if p_expected_version <> v_cur.version then
    raise exception 'the period changed since it was read' using errcode = 'FN013';
  end if;

  if p_due_date is not distinct from v_cur.due_date then
    return jsonb_build_object(
      'periodId', v_cur.id, 'lifecycle', v_cur.lifecycle, 'paymentState', v_cur.payment_state,
      'version', v_cur.version, 'noop', true
    );
  end if;

  -- Trigger T1 raises FN025 for a cancelled period and bumps the version exactly once. This statement never assigns
  -- version or updated_at.
  update public.staff_finance_periods
  set due_date = p_due_date
  where id = v_cur.id
  returning * into v_new;

  perform private.log_audit_event(
    v_cur.tenant_id, 'finance.staff_period_updated', 'staff_finance_period', v_cur.id,
    jsonb_build_object('due_date', v_cur.due_date),
    jsonb_build_object('due_date', p_due_date, 'version', v_new.version)
  );

  return jsonb_build_object(
    'periodId', v_new.id, 'lifecycle', v_new.lifecycle, 'paymentState', v_new.payment_state,
    'version', v_new.version, 'noop', false
  );
end;
$$;

comment on function private.update_staff_finance_period(uuid, date, integer) is
  'Faz FIN.1C.1. Requires finance.staff_manage. Edits the due date only (null clears it). Order: authentication, period id, lock, FN020, permission, expected version (null is FN004), due date range (FN004), version check (FN013 EVEN WHEN the due date is unchanged), unchanged due date is a noop (no UPDATE, no bump, no audit), UPDATE (trigger T1 raises FN025 for a cancelled period and bumps the version once). Audit: one finance.staff_period_updated with the due date before and after.';

create function private.add_staff_period_line(
  p_period_id uuid,
  p_kind text,
  p_amount numeric,
  p_description text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period public.staff_finance_periods;
  v_description text;
  v_amount numeric;
  v_fingerprint text;
  v_existing public.staff_period_lines;
  v_group text;
  v_institution text;
  v_adjustment boolean;
  v_active boolean;
  v_count integer;
  v_id uuid;
  v_lifecycle text;
  v_state text;
  v_version integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_idempotency_key is null or p_period_id is null then
    raise exception 'idempotency key and period are required' using errcode = 'FN004';
  end if;

  -- Locks the aggregate for the whole call: concurrent line changes, payments and lifecycle changes of the SAME period
  -- serialize here.
  select * into v_period from public.staff_finance_periods where id = p_period_id for update;
  if not found then
    raise exception 'period not found' using errcode = 'FN020';
  end if;

  if not private.has_permission(v_period.tenant_id, 'finance.staff_manage') then
    raise exception 'finance.staff_manage required' using errcode = 'FN002';
  end if;

  -- ---- stateless validation and normalization -------------------------------------------------
  v_description := private.normalize_staff_finance_text(p_description);
  if v_description is not null and char_length(v_description) > 200 then
    raise exception 'description too long' using errcode = 'FN004';
  end if;

  v_amount := private.normalize_staff_finance_amount(p_amount);

  if p_kind is null or p_kind !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'invalid kind' using errcode = 'FN004';
  end if;

  v_fingerprint := private.staff_line_add_fingerprint(p_period_id, p_kind, v_amount, v_description);

  -- ---- replay: the lookup precedes every state rule, so an identical retry is a noop in any later state ------------
  select * into v_existing
  from public.staff_period_lines
  where tenant_id = v_period.tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.idempotency_fingerprint = v_fingerprint then
      return jsonb_build_object(
        'periodId', v_period.id, 'lineId', v_existing.id, 'lifecycle', v_period.lifecycle,
        'paymentState', v_period.payment_state, 'version', v_period.version, 'noop', true
      );
    end if;
    raise exception 'idempotency key already used with a different payload' using errcode = 'FN007';
  end if;

  -- ---- stateful validation --------------------------------------------------------------------
  select k.line_group, k.institution, k.is_adjustment, k.is_active
    into v_group, v_institution, v_adjustment, v_active
  from public.staff_line_kinds k
  where k.code = p_kind;
  if not found or not v_active then
    raise exception 'unknown or inactive line kind' using errcode = 'FN030';
  end if;

  if v_adjustment and v_description is null then
    raise exception 'an adjustment line needs a description' using errcode = 'FN004';
  end if;

  select count(*) into v_count from public.staff_period_lines l where l.period_id = p_period_id;
  if v_count >= 100 then
    raise exception 'a period holds at most 100 lines' using errcode = 'FN004';
  end if;

  -- ---- write ----------------------------------------------------------------------------------
  -- Triggers: T2 raises FN025 (cancelled period) or FN024 (finalized period and a non-adjustment earning or
  -- employee-deduction kind); T4 refreshes the totals and the change counter; T1 checks the floors (FN026) and bumps the
  -- version once.
  insert into public.staff_period_lines (
    tenant_id, period_id, currency, kind, line_group, institution, amount, description,
    post_finalization, idempotency_key, idempotency_fingerprint, created_by
  )
  values (
    v_period.tenant_id, p_period_id, v_period.currency, p_kind, v_group, v_institution, v_amount, v_description,
    (v_period.lifecycle = 'finalized'), p_idempotency_key, v_fingerprint, auth.uid()
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- Lost a same-key race: the winner has committed. Compare and answer like a replay.
    select * into v_existing
    from public.staff_period_lines
    where tenant_id = v_period.tenant_id and idempotency_key = p_idempotency_key;
    if found and v_existing.idempotency_fingerprint = v_fingerprint then
      select pe.lifecycle, pe.payment_state, pe.version into v_lifecycle, v_state, v_version
      from public.staff_finance_periods pe where pe.id = p_period_id;
      return jsonb_build_object(
        'periodId', p_period_id, 'lineId', v_existing.id, 'lifecycle', v_lifecycle,
        'paymentState', v_state, 'version', v_version, 'noop', true
      );
    end if;
    raise exception 'idempotency key already used with a different payload' using errcode = 'FN007';
  end if;

  perform private.log_audit_event(
    v_period.tenant_id, 'finance.staff_line_added', 'staff_period_line', v_id,
    null,
    jsonb_build_object(
      'period_id', p_period_id, 'kind', p_kind, 'line_group', v_group, 'amount', v_amount,
      'currency', v_period.currency, 'post_finalization', (v_period.lifecycle = 'finalized')
    )
  );

  select pe.lifecycle, pe.payment_state, pe.version into v_lifecycle, v_state, v_version
  from public.staff_finance_periods pe where pe.id = p_period_id;

  return jsonb_build_object(
    'periodId', p_period_id, 'lineId', v_id, 'lifecycle', v_lifecycle, 'paymentState', v_state,
    'version', v_version, 'noop', false
  );
end;
$$;

comment on function private.add_staff_period_line(uuid, text, numeric, text, uuid) is
  'Faz FIN.1C.1. Requires finance.staff_manage. p_idempotency_key is REQUIRED (null is FN004). Locks the period first. Order: authentication, key and period presence, lock, FN020, permission, stateless validation (description at most 200, amount through H3, kind shape: FN004), fingerprint of the original payload, replay lookup (identical stored fingerprint: noop with the existing line id in ANY later state; different: FN007), stateful validation (kind exists and is active: FN030; an adjustment kind needs a description: FN004; at most 100 lines, voided ones counted: FN004), insert with line_group and institution copied from the catalog and post_finalization from the period (a lost same-key race is answered like a replay), where triggers raise FN025 (cancelled), FN024 (finalized, non-adjustment earning or deduction kind) and FN026 (deductions above earnings) and bump the version once. Audit: one finance.staff_line_added. Returns {periodId, lineId, lifecycle, paymentState, version, noop}.';

create function private.update_staff_period_line(
  p_line_id uuid,
  p_amount numeric,
  p_description text default null,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_id uuid;
  v_period public.staff_finance_periods;
  v_line public.staff_period_lines;
  v_amount numeric;
  v_description text;
  v_is_adjustment boolean;
  v_amount_changed boolean;
  v_description_changed boolean;
  v_before jsonb;
  v_after jsonb;
  v_lifecycle text;
  v_state text;
  v_version integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_expected_version is null or p_line_id is null then
    raise exception 'line id and expected version required' using errcode = 'FN004';
  end if;

  -- The line's period never changes, so this unlocked read only locates the aggregate; the lock order is then fixed:
  -- period first, line second.
  select l.period_id into v_period_id from public.staff_period_lines l where l.id = p_line_id;
  if v_period_id is null then
    raise exception 'line not found' using errcode = 'FN021';
  end if;

  select * into v_period from public.staff_finance_periods where id = v_period_id for update;

  if not private.has_permission(v_period.tenant_id, 'finance.staff_manage') then
    raise exception 'finance.staff_manage required' using errcode = 'FN002';
  end if;

  select * into v_line from public.staff_period_lines where id = p_line_id for update;

  -- ---- stateless validation of the desired state ---------------------------------------------
  v_amount := private.normalize_staff_finance_amount(p_amount);

  v_description := private.normalize_staff_finance_text(p_description);
  if v_description is not null and char_length(v_description) > 200 then
    raise exception 'description too long' using errcode = 'FN004';
  end if;

  select k.is_adjustment into v_is_adjustment from public.staff_line_kinds k where k.code = v_line.kind;
  if coalesce(v_is_adjustment, false) and v_description is null then
    raise exception 'an adjustment line needs a description' using errcode = 'FN004';
  end if;

  -- The version is validated BEFORE the no-op decision: a stale form never succeeds, even with equal values.
  if p_expected_version <> v_period.version then
    raise exception 'the period changed since it was read' using errcode = 'FN013';
  end if;

  -- ---- the changed set (the description is compared normalized against the stored normalized value) -----------
  v_amount_changed := v_amount is distinct from v_line.amount;
  v_description_changed := v_description is distinct from v_line.description;

  if not v_amount_changed and not v_description_changed then
    return jsonb_build_object(
      'periodId', v_period.id, 'lineId', v_line.id, 'lifecycle', v_period.lifecycle,
      'paymentState', v_period.payment_state, 'version', v_period.version, 'noop', true
    );
  end if;

  -- ---- write: only amount and description. Triggers: T2 raises FN025 (cancelled), FN024 (an earning or deduction line
  --      of a finalized period) and FN032 (a voided line); T4 refreshes the totals and the change counter; T1 checks the
  --      floors (FN026) and bumps the version once. This statement never assigns version or updated_at.
  update public.staff_period_lines
  set amount = v_amount,
      description = v_description
  where id = v_line.id;

  v_before := jsonb_build_object('amount', v_line.amount);
  v_after := jsonb_build_object(
    'period_id', v_line.period_id, 'kind', v_line.kind, 'amount', v_amount, 'post_finalization', v_line.post_finalization
  );
  if v_description_changed then
    v_before := v_before || jsonb_build_object('description', v_line.description);
    v_after := v_after || jsonb_build_object('description', v_description);
  end if;

  perform private.log_audit_event(
    v_period.tenant_id, 'finance.staff_line_updated', 'staff_period_line', v_line.id, v_before, v_after
  );

  select pe.lifecycle, pe.payment_state, pe.version into v_lifecycle, v_state, v_version
  from public.staff_finance_periods pe where pe.id = v_period_id;

  return jsonb_build_object(
    'periodId', v_period_id, 'lineId', v_line.id, 'lifecycle', v_lifecycle, 'paymentState', v_state,
    'version', v_version, 'noop', false
  );
end;
$$;

comment on function private.update_staff_period_line(uuid, numeric, text, integer) is
  'Faz FIN.1C.1. Requires finance.staff_manage. Edits the amount and the description of a line as a DESIRED STATE (null description clears it). Lock order: period, then line. Order: authentication, line id and expected version presence (FN004), line lookup (FN021), period lock, permission, line lock, stateless validation (amount through H3, description at most 200, an adjustment line keeps a description: FN004), version check (FN013 EVEN WHEN the values are unchanged), changed set (nothing changed with a matching version is a noop: no UPDATE, no bump, no audit), UPDATE of the two columns only, where triggers raise FN025 (cancelled), FN024 (earning or deduction line of a finalized period), FN032 (voided line) and FN026 (floors) and bump the version once however many fields changed. Audit: one finance.staff_line_updated with the amount before and after and, when it changed, the description before and after. Returns {periodId, lineId, lifecycle, paymentState, version, noop}.';

create function private.void_staff_period_line(
  p_line_id uuid,
  p_reason text,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_id uuid;
  v_period public.staff_finance_periods;
  v_line public.staff_period_lines;
  v_reason text;
  v_lifecycle text;
  v_state text;
  v_version integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_expected_version is null or p_line_id is null then
    raise exception 'line id and expected version required' using errcode = 'FN004';
  end if;

  select l.period_id into v_period_id from public.staff_period_lines l where l.id = p_line_id;
  if v_period_id is null then
    raise exception 'line not found' using errcode = 'FN021';
  end if;

  select * into v_period from public.staff_finance_periods where id = v_period_id for update;

  if not private.has_permission(v_period.tenant_id, 'finance.staff_manage') then
    raise exception 'finance.staff_manage required' using errcode = 'FN002';
  end if;

  select * into v_line from public.staff_period_lines where id = p_line_id for update;

  -- Already voided: an idempotent no-op (reason not re-validated, no audit, no version change).
  if v_line.status = 'voided' then
    return jsonb_build_object(
      'periodId', v_period.id, 'lineId', v_line.id, 'lifecycle', v_period.lifecycle,
      'paymentState', v_period.payment_state, 'version', v_period.version, 'noop', true
    );
  end if;

  v_reason := private.normalize_staff_finance_text(p_reason);
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'void reason required' using errcode = 'FN004';
  end if;

  if p_expected_version <> v_period.version then
    raise exception 'the period changed since it was read' using errcode = 'FN013';
  end if;

  -- Triggers: T2 allows only active to voided and applies the lock matrix (FN025 cancelled; FN024 earning or deduction
  -- line of a finalized period); T4 and T1 refresh the totals, check the floors (FN026) and bump the version once.
  update public.staff_period_lines
  set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
  where id = v_line.id;

  perform private.log_audit_event(
    v_period.tenant_id, 'finance.staff_line_voided', 'staff_period_line', v_line.id,
    jsonb_build_object('status', 'active'),
    jsonb_build_object(
      'status', 'voided', 'period_id', v_line.period_id, 'kind', v_line.kind, 'amount', v_line.amount, 'reason', v_reason
    )
  );

  select pe.lifecycle, pe.payment_state, pe.version into v_lifecycle, v_state, v_version
  from public.staff_finance_periods pe where pe.id = v_period_id;

  return jsonb_build_object(
    'periodId', v_period_id, 'lineId', v_line.id, 'lifecycle', v_lifecycle, 'paymentState', v_state,
    'version', v_version, 'noop', false
  );
end;
$$;

comment on function private.void_staff_period_line(uuid, text, integer) is
  'Faz FIN.1C.1. Requires finance.staff_manage. Never deletes: active to voided with voided_at/by/reason. Lock order: period, then line. Order: authentication, line id and expected version presence (FN004), line lookup (FN021), period lock, permission, line lock, already voided is an idempotent noop (reason not re-validated), reason (trimmed, 1-500: FN004), version check (FN013), UPDATE where triggers raise FN025 (cancelled), FN024 (earning or deduction line of a finalized period) and FN026 (floors) and bump the version once. Audit: one finance.staff_line_voided with the reason.';

create function private.finalize_staff_finance_period(
  p_period_id uuid,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cur public.staff_finance_periods;
  v_new public.staff_finance_periods;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_expected_version is null or p_period_id is null then
    raise exception 'period id and expected version required' using errcode = 'FN004';
  end if;

  select * into v_cur from public.staff_finance_periods where id = p_period_id for update;
  if not found then
    raise exception 'period not found' using errcode = 'FN020';
  end if;

  if not private.has_permission(v_cur.tenant_id, 'finance.staff_manage') then
    raise exception 'finance.staff_manage required' using errcode = 'FN002';
  end if;

  -- Already finalized: an idempotent no-op (a retry with an older version is still a no-op, no audit, no version change).
  if v_cur.lifecycle = 'finalized' then
    return jsonb_build_object(
      'periodId', v_cur.id, 'lifecycle', v_cur.lifecycle, 'paymentState', v_cur.payment_state,
      'version', v_cur.version, 'noop', true
    );
  end if;

  if v_cur.lifecycle = 'cancelled' then
    raise exception 'period is cancelled' using errcode = 'FN025';
  end if;

  if p_expected_version <> v_cur.version then
    raise exception 'the period changed since it was read' using errcode = 'FN013';
  end if;

  -- The snapshot is the locked row's current statement. Trigger T1 refuses an empty statement (FN031), payments (advances
  -- included) above the net payable (FN033: nothing is written) and a snapshot that differs from the live statement
  -- (FN032), and bumps the version once.
  update public.staff_finance_periods
  set lifecycle = 'finalized',
      finalized_at = now(),
      finalized_by = auth.uid(),
      finalized_earning_total = v_cur.earning_total,
      finalized_deduction_total = v_cur.employee_deduction_total,
      finalized_net_payable = v_cur.earning_total - v_cur.employee_deduction_total
  where id = v_cur.id
  returning * into v_new;

  perform private.log_audit_event(
    v_cur.tenant_id, 'finance.staff_period_finalized', 'staff_finance_period', v_cur.id,
    jsonb_build_object('lifecycle', 'open'),
    jsonb_build_object(
      'lifecycle', 'finalized',
      'earning_total', v_new.finalized_earning_total,
      'employee_deduction_total', v_new.finalized_deduction_total,
      'net_payable', v_new.finalized_net_payable,
      'paid_total', v_new.paid_total,
      'version', v_new.version
    )
  );

  return jsonb_build_object(
    'periodId', v_new.id, 'lifecycle', v_new.lifecycle, 'paymentState', v_new.payment_state,
    'version', v_new.version, 'noop', false
  );
end;
$$;

comment on function private.finalize_staff_finance_period(uuid, integer) is
  'Faz FIN.1C.1. Requires finance.staff_manage. Open to finalized, atomically storing the immutable employee-statement snapshot (earning, deductions, net) from the locked row. Order: authentication, period id and expected version presence (FN004), lock, FN020, permission, already finalized is an idempotent noop (even with an older version), cancelled FN025, version check (FN013), UPDATE where trigger T1 raises FN031 (earning total 0), FN033 (posted payments and advances above the net payable; nothing is written, no audit, no version change) and FN032 (snapshot mismatch) and bumps the version once. Audit: one finance.staff_period_finalized with the snapshot and the paid total.';

create function private.reopen_staff_finance_period(
  p_period_id uuid,
  p_reason text,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cur public.staff_finance_periods;
  v_new public.staff_finance_periods;
  v_reason text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_expected_version is null or p_reason is null or p_period_id is null then
    raise exception 'period id, reason and expected version required' using errcode = 'FN004';
  end if;

  select * into v_cur from public.staff_finance_periods where id = p_period_id for update;
  if not found then
    raise exception 'period not found' using errcode = 'FN020';
  end if;

  if not private.has_permission(v_cur.tenant_id, 'finance.staff_manage') then
    raise exception 'finance.staff_manage required' using errcode = 'FN002';
  end if;

  -- Already open: an idempotent no-op (reason not re-validated, no audit, no version change).
  if v_cur.lifecycle = 'open' then
    return jsonb_build_object(
      'periodId', v_cur.id, 'lifecycle', v_cur.lifecycle, 'paymentState', v_cur.payment_state,
      'version', v_cur.version, 'noop', true
    );
  end if;

  if v_cur.lifecycle = 'cancelled' then
    raise exception 'period is cancelled' using errcode = 'FN025';
  end if;

  v_reason := private.normalize_staff_finance_text(p_reason);
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'reopen reason required' using errcode = 'FN004';
  end if;

  if p_expected_version <> v_cur.version then
    raise exception 'the period changed since it was read' using errcode = 'FN013';
  end if;

  -- The narrow guard (a posted payment recorded after finalization: FN027) belongs to trigger T1, which also checks that
  -- the snapshot and finalized_at are cleared and bumps the version once.
  update public.staff_finance_periods
  set lifecycle = 'open',
      finalized_at = null,
      finalized_by = null,
      finalized_earning_total = null,
      finalized_deduction_total = null,
      finalized_net_payable = null
  where id = v_cur.id
  returning * into v_new;

  perform private.log_audit_event(
    v_cur.tenant_id, 'finance.staff_period_reopened', 'staff_finance_period', v_cur.id,
    jsonb_build_object(
      'lifecycle', 'finalized',
      'earning_total', v_cur.finalized_earning_total,
      'employee_deduction_total', v_cur.finalized_deduction_total,
      'net_payable', v_cur.finalized_net_payable
    ),
    jsonb_build_object('lifecycle', 'open', 'reason', v_reason, 'version', v_new.version)
  );

  return jsonb_build_object(
    'periodId', v_new.id, 'lifecycle', v_new.lifecycle, 'paymentState', v_new.payment_state,
    'version', v_new.version, 'noop', false
  );
end;
$$;

comment on function private.reopen_staff_finance_period(uuid, text, integer) is
  'Faz FIN.1C.1. Requires finance.staff_manage. The narrow reopen: finalized to open, only with a reason and the expected version, clearing finalized_at and the snapshot. Order: authentication, period id, reason and expected version presence (FN004), lock, FN020, permission, already open is an idempotent noop (reason not re-validated), cancelled FN025, reason (trimmed, 1-500: FN004), version check (FN013), UPDATE where trigger T1 raises FN027 when a posted payment recorded after finalization exists (payments recorded before finalization do not block) and bumps the version once. Audit: one finance.staff_period_reopened with the reason and the cleared snapshot values.';

create function private.cancel_staff_finance_period(
  p_period_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cur public.staff_finance_periods;
  v_new public.staff_finance_periods;
  v_reason text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_period_id is null then
    raise exception 'period id required' using errcode = 'FN004';
  end if;

  select * into v_cur from public.staff_finance_periods where id = p_period_id for update;
  if not found then
    raise exception 'period not found' using errcode = 'FN020';
  end if;

  if not private.has_permission(v_cur.tenant_id, 'finance.staff_manage') then
    raise exception 'finance.staff_manage required' using errcode = 'FN002';
  end if;

  -- Already cancelled: an idempotent no-op (reason not re-validated, no audit, no version change).
  if v_cur.lifecycle = 'cancelled' then
    return jsonb_build_object(
      'periodId', v_cur.id, 'lifecycle', v_cur.lifecycle, 'paymentState', v_cur.payment_state,
      'version', v_cur.version, 'noop', true
    );
  end if;

  v_reason := private.normalize_staff_finance_text(p_reason);
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'cancel reason required' using errcode = 'FN004';
  end if;

  -- Trigger T1 refuses (FN027) when any posted payment exists and bumps the version once. Nothing is deleted: the lines
  -- and the voided payments stay as evidence.
  update public.staff_finance_periods
  set lifecycle = 'cancelled',
      cancelled_at = now(),
      cancelled_by = auth.uid(),
      cancel_reason = v_reason,
      finalized_at = null,
      finalized_by = null,
      finalized_earning_total = null,
      finalized_deduction_total = null,
      finalized_net_payable = null
  where id = v_cur.id
  returning * into v_new;

  perform private.log_audit_event(
    v_cur.tenant_id, 'finance.staff_period_cancelled', 'staff_finance_period', v_cur.id,
    jsonb_build_object('lifecycle', v_cur.lifecycle),
    jsonb_build_object('lifecycle', 'cancelled', 'reason', v_reason, 'version', v_new.version)
  );

  return jsonb_build_object(
    'periodId', v_new.id, 'lifecycle', v_new.lifecycle, 'paymentState', v_new.payment_state,
    'version', v_new.version, 'noop', false
  );
end;
$$;

comment on function private.cancel_staff_finance_period(uuid, text) is
  'Faz FIN.1C.1. Requires finance.staff_manage. Never deletes: open or finalized to cancelled with cancelled_at/by/reason, clearing finalized_at and the snapshot. No expected version (as the FIN.1B.1 cancel). Order: authentication, period id presence (FN004), lock, FN020, permission, already cancelled is an idempotent noop (reason not re-validated), reason (trimmed, 1-500: FN004), UPDATE where trigger T1 raises FN027 when ANY posted payment exists and bumps the version once. Audit: one finance.staff_period_cancelled with the reason.';

create function private.record_staff_payment(
  p_period_id uuid,
  p_purpose text,
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
  v_period public.staff_finance_periods;
  v_norm jsonb;
  v_amount numeric;
  v_paid_at timestamptz;
  v_note text;
  v_existing public.staff_payments;
  v_payment_id uuid;
  v_lifecycle text;
  v_state text;
  v_version integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_idempotency_key is null or p_period_id is null then
    raise exception 'idempotency key and period are required' using errcode = 'FN004';
  end if;

  -- Locks the aggregate for the whole call: concurrent payments, line changes and lifecycle changes of the SAME period
  -- serialize here (trigger T3 takes the same lock again inside the insert).
  select * into v_period from public.staff_finance_periods where id = p_period_id for update;
  if not found then
    raise exception 'period not found' using errcode = 'FN020';
  end if;

  if not private.has_permission(v_period.tenant_id, 'finance.staff_manage') then
    raise exception 'finance.staff_manage required' using errcode = 'FN002';
  end if;

  -- Stateless validation only. There is deliberately NO amount-versus-net check in this RPC: an open period has no
  -- payment-time cap (an advance may precede the earnings); the cap after finalization is trigger T3.
  v_norm := private.normalize_staff_payment_input(p_amount, p_purpose, p_method, p_paid_at, p_note);
  v_amount := (v_norm ->> 'amount')::numeric;
  v_paid_at := (v_norm ->> 'paid_at')::timestamptz;
  v_note := v_norm ->> 'note';

  -- Replay: the lookup precedes every lifecycle rule, so an identical retry is a noop in any later state.
  select * into v_existing
  from public.staff_payments
  where tenant_id = v_period.tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.period_id = p_period_id
       and v_existing.purpose = p_purpose
       and v_existing.method = p_method
       and v_existing.amount = v_amount
       and v_existing.paid_at = v_paid_at
       and v_existing.note is not distinct from v_note then
      return jsonb_build_object(
        'periodId', v_period.id, 'paymentId', v_existing.id, 'lifecycle', v_period.lifecycle,
        'paymentState', v_period.payment_state, 'version', v_period.version, 'noop', true
      );
    end if;
    raise exception 'idempotency key already used with a different payload' using errcode = 'FN007';
  end if;

  -- Triggers: T3 raises FN025 (cancelled) or FN023 (finalized and above the outstanding amount) and checks the
  -- post_finalization flag; T4 refreshes the totals and the change counter; T1 bumps the version once (and keeps P at most
  -- N on a finalized period).
  v_payment_id := private.post_staff_payment(
    v_period.tenant_id, p_period_id, p_purpose, v_amount, p_method, v_paid_at, v_note, p_idempotency_key
  );

  select pe.lifecycle, pe.payment_state, pe.version into v_lifecycle, v_state, v_version
  from public.staff_finance_periods pe where pe.id = p_period_id;

  return jsonb_build_object(
    'periodId', p_period_id, 'paymentId', v_payment_id, 'lifecycle', v_lifecycle, 'paymentState', v_state,
    'version', v_version, 'noop', false
  );
end;
$$;

comment on function private.record_staff_payment(uuid, text, numeric, text, timestamptz, text, uuid) is
  'Faz FIN.1C.1. Requires finance.staff_manage. p_idempotency_key is required (FN004). Locks the period first. Order: authentication, key and period presence (FN004), lock, FN020, permission, stateless payment validation (amount FN004, purpose FN004, method FN006, paid_at FN004, note FN004; NO amount-versus-net check), replay lookup (identical stored payment: noop with the existing payment id in ANY later state; different payload or another period: FN007), then the insert through post_staff_payment where trigger T3 raises FN025 (cancelled) or FN023 (finalized period, amount above the outstanding amount). An open period has no cap: any purpose, including an advance before any earning line, may exceed the net payable. Every real payment bumps the version exactly once; a replay changes nothing. Audit: one finance.staff_payment_recorded. Returns {periodId, paymentId, lifecycle, paymentState, version, noop}.';

create function private.void_staff_payment(
  p_payment_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_id uuid;
  v_period public.staff_finance_periods;
  v_payment public.staff_payments;
  v_reason text;
  v_lifecycle text;
  v_state text;
  v_version integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_payment_id is null then
    raise exception 'payment id required' using errcode = 'FN004';
  end if;

  -- The payment's period never changes, so this unlocked read only locates the aggregate; the lock order is then fixed:
  -- period first, payment second.
  select p.period_id into v_period_id from public.staff_payments p where p.id = p_payment_id;
  if v_period_id is null then
    raise exception 'payment not found' using errcode = 'FN022';
  end if;

  select * into v_period from public.staff_finance_periods where id = v_period_id for update;

  if not private.has_permission(v_period.tenant_id, 'finance.staff_manage') then
    raise exception 'finance.staff_manage required' using errcode = 'FN002';
  end if;

  select * into v_payment from public.staff_payments where id = p_payment_id for update;

  -- Already voided: an idempotent no-op (reason not re-validated, no audit, no version change).
  if v_payment.status = 'voided' then
    return jsonb_build_object(
      'periodId', v_period.id, 'paymentId', v_payment.id, 'lifecycle', v_period.lifecycle,
      'paymentState', v_period.payment_state, 'version', v_period.version, 'noop', true
    );
  end if;

  v_reason := private.normalize_staff_finance_text(p_reason);
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'void reason required' using errcode = 'FN004';
  end if;

  -- Trigger T3 allows only posted to voided; T4 and T1 refresh the totals, keep a finalized period within its floors and
  -- bump the version once.
  update public.staff_payments
  set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
  where id = v_payment.id;

  perform private.log_audit_event(
    v_period.tenant_id, 'finance.staff_payment_voided', 'staff_payment', v_payment.id,
    jsonb_build_object('status', 'posted'),
    jsonb_build_object(
      'status', 'voided', 'period_id', v_payment.period_id, 'amount', v_payment.amount, 'reason', v_reason
    )
  );

  select pe.lifecycle, pe.payment_state, pe.version into v_lifecycle, v_state, v_version
  from public.staff_finance_periods pe where pe.id = v_period_id;

  return jsonb_build_object(
    'periodId', v_period_id, 'paymentId', v_payment.id, 'lifecycle', v_lifecycle, 'paymentState', v_state,
    'version', v_version, 'noop', false
  );
end;
$$;

comment on function private.void_staff_payment(uuid, text) is
  'Faz FIN.1C.1. Requires finance.staff_manage. Never deletes: posted to voided with voided_at/by/reason (trigger T3 allows only that transition). Lock order: period, then payment. Order: authentication, payment id (FN004), payment lookup (FN022), period lock, permission, payment lock, already voided is an idempotent noop (reason not re-validated), reason (trimmed, 1-500: FN004), UPDATE. Every real void bumps the period version exactly once. Audit: one finance.staff_payment_voided with the reason. Returns {periodId, paymentId, lifecycle, paymentState, version, noop}.';

-- =====================================================================
-- 8. READ RPCs (private implementations). finance.staff_view; curated jsonb that carries no auth user id, no email, no
--    phone, no created_by / voided_by / cancelled_by / finalized_by, no idempotency data, no tenant id and no staff member id
--    inside a period, line or payment model. p_reference_date only drives overdue and the default month; it never
--    reconstructs history. A read never writes.
-- =====================================================================

create function private.list_finance_staff(p_tenant_id uuid)
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
  if not private.has_permission(p_tenant_id, 'finance.staff_view') then
    raise exception 'finance.staff_view required' using errcode = 'FN002';
  end if;

  return (
    select coalesce(
      jsonb_agg(
        jsonb_build_object('staffMemberId', s.id, 'fullName', s.full_name, 'status', s.status)
        order by (s.status = 'active') desc, s.display_order, s.full_name, s.id
      ),
      '[]'::jsonb
    )
    from public.staff_members s
    where s.tenant_id = p_tenant_id and s.deleted_at is null
  );
end;
$$;

comment on function private.list_finance_staff(uuid) is
  'Faz FIN.1C.1. Requires finance.staff_view in the tenant (FN002 for a foreign, non-member or nonexistent tenant). The tenant''s staff members that are not soft-deleted, active first, then display_order, full_name, id. Returns only {staffMemberId, fullName, status}: nothing else about a person.';

create function private.list_staff_line_kinds(p_tenant_id uuid)
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
  if not private.has_permission(p_tenant_id, 'finance.staff_view') then
    raise exception 'finance.staff_view required' using errcode = 'FN002';
  end if;

  return (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'code', k.code, 'lineGroup', k.line_group, 'institution', k.institution,
          'isAdjustment', k.is_adjustment, 'displayOrder', k.display_order
        )
        order by k.display_order, k.code
      ),
      '[]'::jsonb
    )
    from public.staff_line_kinds k
    where k.is_active
  );
end;
$$;

comment on function private.list_staff_line_kinds(uuid) is
  'Faz FIN.1C.1. Requires finance.staff_view in the tenant. Active line kinds ordered by display_order then code, each with its line_group, institution tag and adjustment flag.';

create function private.get_staff_finance_period(p_period_id uuid, p_reference_date date default null)
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
  if p_period_id is null then
    raise exception 'period id required' using errcode = 'FN004';
  end if;

  select pe.tenant_id into v_tenant_id from public.staff_finance_periods pe where pe.id = p_period_id;
  if v_tenant_id is null then
    raise exception 'period not found' using errcode = 'FN020';
  end if;

  if not private.has_permission(v_tenant_id, 'finance.staff_view') then
    raise exception 'finance.staff_view required' using errcode = 'FN002';
  end if;

  if p_reference_date is not null and (p_reference_date < date '2000-01-01' or p_reference_date > date '2100-12-31') then
    raise exception 'invalid reference date' using errcode = 'FN004';
  end if;
  v_ref := coalesce(p_reference_date, private.tenant_local_date(v_tenant_id));

  select jsonb_build_object(
    'id', p.id,
    'staffName', p.staff_display_name,
    'periodMonth', p.period_month,
    'currency', p.currency,
    'lifecycle', p.lifecycle,
    'paymentState', p.payment_state,
    'dueDate', p.due_date,
    'grossEntitlement', p.earning_total,
    'employeeDeductions', p.employee_deduction_total,
    'paye', x.paye,
    'netPayable', p.net_payable,
    'paid', p.paid_total,
    'advances', p.advance_total,
    'employeeOutstanding', case when p.lifecycle = 'cancelled' then 0 else p.net_payable - p.paid_total end,
    'paidInExcess', case when p.lifecycle = 'cancelled' then 0 else greatest(p.paid_total - p.net_payable, 0) end,
    'employerCost', p.employer_cost_total,
    'personnelCost', p.earning_total + p.employer_cost_total,
    'socialInsurance', jsonb_build_object('employee', x.si_emp, 'employer', x.si_er),
    'providentFund', jsonb_build_object('employee', x.pf_emp, 'employer', x.pf_er),
    'finalizedStatement', case when p.lifecycle = 'finalized' then
        jsonb_build_object(
          'finalizedAt', p.finalized_at,
          'grossEntitlement', p.finalized_earning_total,
          'employeeDeductions', p.finalized_deduction_total,
          'netPayable', p.finalized_net_payable)
      else null end,
    'sinceFinalization', case when p.lifecycle = 'finalized' then
        jsonb_build_object(
          'grossEntitlement', p.earning_total - p.finalized_earning_total,
          'employeeDeductions', p.employee_deduction_total - p.finalized_deduction_total,
          'netPayable', p.net_payable - p.finalized_net_payable)
      else null end,
    'isOverdue', od.is_overdue,
    'daysOverdue', case when od.is_overdue then v_ref - p.due_date else null end,
    'flags', jsonb_build_object(
      'canFinalize', (p.lifecycle = 'open' and p.earning_total > 0 and p.paid_total <= p.net_payable),
      'finalizeBlockedReason', case
        when p.lifecycle <> 'open' then 'not_open'
        when p.earning_total <= 0 then 'no_earning'
        when p.paid_total > p.net_payable then 'payments_exceed_net'
        else null end,
      'canReopen', (p.lifecycle = 'finalized' and not x.post_paid),
      'reopenBlockedReason', case
        when p.lifecycle <> 'finalized' then 'not_finalized'
        when x.post_paid then 'payment_after_finalization'
        else null end,
      'canCancel', (p.lifecycle <> 'cancelled' and p.paid_total <= 0),
      'cancelBlockedReason', case when p.lifecycle <> 'cancelled' and p.paid_total > 0 then 'payments_posted' else null end,
      'canAddStatementLine', (p.lifecycle = 'open'),
      'canAddAdjustment', (p.lifecycle in ('open', 'finalized')),
      'canAddEmployerCost', (p.lifecycle in ('open', 'finalized')),
      'canPay', case p.lifecycle when 'open' then true when 'finalized' then (p.net_payable - p.paid_total) > 0 else false end,
      'maxPayable', case when p.lifecycle = 'finalized' then greatest(p.net_payable - p.paid_total, 0) else null end
    ),
    'version', p.version,
    'cancelledAt', p.cancelled_at,
    'cancelReason', p.cancel_reason,
    'createdAt', p.created_at,
    'updatedAt', p.updated_at,
    'lines', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', l.id,
            'kind', l.kind,
            'lineGroup', l.line_group,
            'institution', l.institution,
            'amount', l.amount,
            'description', l.description,
            'status', l.status,
            'postFinalization', l.post_finalization,
            'voidReason', l.void_reason,
            'calculationSource', l.calculation_source,
            'canEdit', (l.status = 'active' and (p.lifecycle = 'open' or (p.lifecycle = 'finalized' and l.line_group = 'employer_cost'))),
            'canVoid', (l.status = 'active' and (p.lifecycle = 'open' or (p.lifecycle = 'finalized' and l.line_group = 'employer_cost')))
          )
          order by (case l.line_group when 'earning' then 1 when 'employee_deduction' then 2 else 3 end), l.created_at, l.id
        ),
        '[]'::jsonb
      )
      from public.staff_period_lines l
      where l.period_id = p.id
    ),
    'payments', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', pay.id,
            'purpose', pay.purpose,
            'method', pay.method,
            'amount', pay.amount,
            'paidAt', pay.paid_at,
            'note', pay.note,
            'status', pay.status,
            'postFinalization', pay.post_finalization,
            'voidReason', pay.void_reason
          )
          order by pay.paid_at, pay.created_at, pay.id
        ),
        '[]'::jsonb
      )
      from public.staff_payments pay
      where pay.period_id = p.id
    )
  ) into v_result
  from public.staff_finance_periods p
  cross join lateral (
    select
      coalesce(sum(l.amount) filter (where l.kind = 'paye'), 0) as paye,
      coalesce(sum(l.amount) filter (where l.institution = 'social_insurance' and l.line_group = 'employee_deduction'), 0) as si_emp,
      coalesce(sum(l.amount) filter (where l.institution = 'social_insurance' and l.line_group = 'employer_cost'), 0) as si_er,
      coalesce(sum(l.amount) filter (where l.institution = 'provident_fund' and l.line_group = 'employee_deduction'), 0) as pf_emp,
      coalesce(sum(l.amount) filter (where l.institution = 'provident_fund' and l.line_group = 'employer_cost'), 0) as pf_er,
      exists (
        select 1 from public.staff_payments pp
        where pp.period_id = p.id and pp.status = 'posted' and pp.post_finalization
      ) as post_paid
    from public.staff_period_lines l
    where l.period_id = p.id and l.status = 'active'
  ) x
  cross join lateral (
    select (p.lifecycle <> 'cancelled' and p.due_date is not null and p.due_date < v_ref and p.net_payable > p.paid_total) as is_overdue
  ) od
  where p.id = p_period_id;

  return v_result;
end;
$$;

comment on function private.get_staff_finance_period(uuid, date) is
  'Faz FIN.1C.1. Requires finance.staff_view in the period''s tenant (FN020 when missing, FN002 when not permitted). Curated detail: figures by group, the finalized statement and the changes since finalization, display flags computed from the same rules as the triggers (the triggers are the authority), every line and payment including voided ones with their reasons. No user ids, no idempotency data, no tenant id and no staff member id. A cancelled period shows zero outstanding and all flags false. p_reference_date (default: tenant-local today) drives isOverdue and daysOverdue only. A read: it writes nothing.';

create function private.get_staff_finance_overview(
  p_tenant_id uuid,
  p_month date default null,
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
  v_periods jsonb;
  v_without jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;
  if p_tenant_id is null then
    raise exception 'tenant required' using errcode = 'FN004';
  end if;
  if not private.has_permission(p_tenant_id, 'finance.staff_view') then
    raise exception 'finance.staff_view required' using errcode = 'FN002';
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

  -- ---- the selected month's periods (non-cancelled), one row per person ------------------------------
  with per as (
    select p.id, p.currency, p.period_month, p.staff_display_name, p.lifecycle, p.payment_state, p.due_date,
           p.earning_total, p.employee_deduction_total, p.employer_cost_total, p.paid_total, p.advance_total,
           p.net_payable, p.version
    from public.staff_finance_periods p
    where p.tenant_id = p_tenant_id and p.lifecycle <> 'cancelled' and p.period_month = v_month_start
  ),
  lagg as (
    select l.period_id,
           coalesce(sum(l.amount) filter (where l.kind = 'paye'), 0) as paye,
           coalesce(sum(l.amount) filter (where l.institution = 'social_insurance' and l.line_group = 'employee_deduction'), 0) as si_emp,
           coalesce(sum(l.amount) filter (where l.institution = 'social_insurance' and l.line_group = 'employer_cost'), 0) as si_er,
           coalesce(sum(l.amount) filter (where l.institution = 'provident_fund' and l.line_group = 'employee_deduction'), 0) as pf_emp,
           coalesce(sum(l.amount) filter (where l.institution = 'provident_fund' and l.line_group = 'employer_cost'), 0) as pf_er
    from public.staff_period_lines l
    join per on per.id = l.period_id
    where l.status = 'active'
    group by l.period_id
  ),
  mp as (
    select per.*, coalesce(la.paye, 0) as paye, coalesce(la.si_emp, 0) as si_emp, coalesce(la.si_er, 0) as si_er,
           coalesce(la.pf_emp, 0) as pf_emp, coalesce(la.pf_er, 0) as pf_er,
           (per.due_date is not null and per.due_date < v_ref and per.net_payable > per.paid_total) as is_overdue
    from per
    left join lagg la on la.period_id = per.id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'periodId', m.id,
        'staffName', m.staff_display_name,
        'currency', m.currency,
        'lifecycle', m.lifecycle,
        'paymentState', m.payment_state,
        'grossEntitlement', m.earning_total,
        'employeeDeductions', m.employee_deduction_total,
        'paye', m.paye,
        'netPayable', m.net_payable,
        'paid', m.paid_total,
        'advances', m.advance_total,
        'employeeOutstanding', m.net_payable - m.paid_total,
        'paidInExcess', greatest(m.paid_total - m.net_payable, 0),
        'socialInsurance', jsonb_build_object('employee', m.si_emp, 'employer', m.si_er),
        'providentFund', jsonb_build_object('employee', m.pf_emp, 'employer', m.pf_er),
        'employerCost', m.employer_cost_total,
        'personnelCost', m.earning_total + m.employer_cost_total,
        'dueDate', m.due_date,
        'isOverdue', m.is_overdue,
        'daysOverdue', case when m.is_overdue then v_ref - m.due_date else null end,
        'version', m.version
      )
      order by lower(m.staff_display_name), m.id
    ),
    '[]'::jsonb
  ) into v_periods
  from mp m;

  -- ---- per-currency figures: the month, the cash of the month, and the all-time figures --------------
  with per_all as (
    select p.id, p.currency, p.period_month, p.due_date, p.net_payable, p.paid_total
    from public.staff_finance_periods p
    where p.tenant_id = p_tenant_id and p.lifecycle <> 'cancelled'
  ),
  per as (
    select p.id, p.currency, p.earning_total, p.employee_deduction_total, p.employer_cost_total, p.paid_total,
           p.advance_total, p.net_payable
    from public.staff_finance_periods p
    where p.tenant_id = p_tenant_id and p.lifecycle <> 'cancelled' and p.period_month = v_month_start
  ),
  lagg as (
    select l.period_id,
           coalesce(sum(l.amount) filter (where l.kind = 'paye'), 0) as paye,
           coalesce(sum(l.amount) filter (where l.institution = 'social_insurance' and l.line_group = 'employee_deduction'), 0) as si_emp,
           coalesce(sum(l.amount) filter (where l.institution = 'social_insurance' and l.line_group = 'employer_cost'), 0) as si_er,
           coalesce(sum(l.amount) filter (where l.institution = 'provident_fund' and l.line_group = 'employee_deduction'), 0) as pf_emp,
           coalesce(sum(l.amount) filter (where l.institution = 'provident_fund' and l.line_group = 'employer_cost'), 0) as pf_er
    from public.staff_period_lines l
    join per on per.id = l.period_id
    where l.status = 'active'
    group by l.period_id
  ),
  agg as (
    select per.currency,
           sum(per.earning_total) as g,
           sum(per.employee_deduction_total) as d,
           sum(per.net_payable) as n,
           sum(per.paid_total) as paid,
           sum(per.advance_total) as adv,
           sum(greatest(per.net_payable - per.paid_total, 0)) as outstanding,
           sum(greatest(per.paid_total - per.net_payable, 0)) as excess,
           sum(per.employer_cost_total) as e,
           sum(coalesce(la.paye, 0)) as paye,
           sum(coalesce(la.si_emp, 0)) as si_emp,
           sum(coalesce(la.si_er, 0)) as si_er,
           sum(coalesce(la.pf_emp, 0)) as pf_emp,
           sum(coalesce(la.pf_er, 0)) as pf_er,
           count(*) as period_count
    from per
    left join lagg la on la.period_id = per.id
    group by per.currency
  ),
  alltime as (
    select pa.currency,
           coalesce(sum(greatest(pa.net_payable - pa.paid_total, 0)), 0) as out_total,
           count(*) filter (where pa.net_payable > pa.paid_total) as out_count,
           coalesce(sum(greatest(pa.paid_total - pa.net_payable, 0)), 0) as ex_total,
           count(*) filter (where pa.paid_total > pa.net_payable) as ex_count,
           coalesce(sum(greatest(pa.net_payable - pa.paid_total, 0)) filter (
             where pa.due_date is not null and pa.due_date < v_ref), 0) as od_total,
           count(*) filter (
             where pa.due_date is not null and pa.due_date < v_ref and pa.net_payable > pa.paid_total) as od_count
    from per_all pa
    group by pa.currency
  ),
  cash as (
    select pe.currency, sum(pay.amount) as paid
    from public.staff_payments pay
    join public.staff_finance_periods pe on pe.id = pay.period_id and pe.tenant_id = pay.tenant_id
    where pay.tenant_id = p_tenant_id and pay.status = 'posted' and pay.paid_at >= v_lo and pay.paid_at < v_hi
    group by pe.currency
  ),
  currencies as (
    select a.currency from agg a
    union
    select t.currency from alltime t where t.out_count > 0 or t.ex_count > 0
    union
    select ca.currency from cash ca where ca.paid <> 0
    union
    select v_primary
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'currency', c.currency,
        'grossEntitlement', coalesce(a.g, 0),
        'employeeDeductions', coalesce(a.d, 0),
        'paye', coalesce(a.paye, 0),
        'netPayable', coalesce(a.n, 0),
        'paid', coalesce(a.paid, 0),
        'advances', coalesce(a.adv, 0),
        'employeeOutstanding', coalesce(a.outstanding, 0),
        'paidInExcess', coalesce(a.excess, 0),
        'employerCost', coalesce(a.e, 0),
        'personnelCost', coalesce(a.g, 0) + coalesce(a.e, 0),
        'socialInsurance', jsonb_build_object('employee', coalesce(a.si_emp, 0), 'employer', coalesce(a.si_er, 0)),
        'providentFund', jsonb_build_object('employee', coalesce(a.pf_emp, 0), 'employer', coalesce(a.pf_er, 0)),
        'periodCount', coalesce(a.period_count, 0),
        'cashPaidInMonth', coalesce(ca.paid, 0),
        'employeeOutstandingAllTime', jsonb_build_object('total', coalesce(t.out_total, 0), 'count', coalesce(t.out_count, 0)),
        'paidInExcessAllTime', jsonb_build_object('total', coalesce(t.ex_total, 0), 'count', coalesce(t.ex_count, 0)),
        'overdueAllTime', jsonb_build_object('total', coalesce(t.od_total, 0), 'count', coalesce(t.od_count, 0))
      )
      order by (c.currency = v_primary) desc, c.currency
    ),
    '[]'::jsonb
  ) into v_by
  from currencies c
  left join agg a on a.currency = c.currency
  left join alltime t on t.currency = c.currency
  left join cash ca on ca.currency = c.currency;

  -- ---- staff without a non-cancelled period this month -----------------------------------------------
  select coalesce(
    jsonb_agg(
      jsonb_build_object('staffMemberId', s.id, 'fullName', s.full_name, 'status', s.status)
      order by (s.status = 'active') desc, s.display_order, s.full_name, s.id
    ),
    '[]'::jsonb
  ) into v_without
  from public.staff_members s
  where s.tenant_id = p_tenant_id and s.deleted_at is null
    and not exists (
      select 1 from public.staff_finance_periods p
      where p.tenant_id = p_tenant_id and p.staff_member_id = s.id
        and p.period_month = v_month_start and p.lifecycle <> 'cancelled'
    );

  return jsonb_build_object(
    'month', v_month_start,
    'referenceDate', v_ref,
    'primaryCurrency', v_primary,
    'byCurrency', v_by,
    'periods', v_periods,
    'staffWithoutPeriod', v_without
  );
end;
$$;

comment on function private.get_staff_finance_overview(uuid, date, date) is
  'Faz FIN.1C.1. Requires finance.staff_view. Per currency, never summed across currencies, cancelled periods and voided rows excluded: the selected tenant-local month (grossEntitlement, employeeDeductions with the manual paye part, netPayable, paid with the advances part, employeeOutstanding as the sum of the POSITIVE parts and paidInExcess as the sum of the negative parts, never netted, employerCost, personnelCost = gross + employer cost, the Social Insurance and Provident Fund employee/employer split, periodCount), the cash paid in that month by paid_at in tenant time, and the all-time outstanding, paid-in-excess and overdue figures (independent of the month; open periods are provisional). The primary (tenant) currency entry is always present. Period rows carry no staff member id; staffWithoutPeriod lists the non-deleted staff with no non-cancelled period in the month. p_reference_date (default tenant-local today) classifies overdue and picks the default month only. A read: it writes nothing and creates nothing. Nothing here is profit.';

-- =====================================================================
-- 9. PUBLIC WRAPPERS - thin pass-throughs, authenticated only, security
--    definer (a private.* caller must be definer: see supabase/migrations/README.md "Lessons").
-- =====================================================================
create function public.list_finance_staff(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.list_finance_staff(p_tenant_id);
$$;

create function public.list_staff_line_kinds(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.list_staff_line_kinds(p_tenant_id);
$$;

create function public.get_staff_finance_overview(
  p_tenant_id uuid,
  p_month date default null,
  p_reference_date date default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_staff_finance_overview(p_tenant_id, p_month, p_reference_date);
$$;

create function public.get_staff_finance_period(p_period_id uuid, p_reference_date date default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_staff_finance_period(p_period_id, p_reference_date);
$$;

create function public.create_staff_finance_period(
  p_tenant_id uuid,
  p_staff_member_id uuid,
  p_period_month date,
  p_idempotency_key uuid default null,
  p_due_date date default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.create_staff_finance_period(p_tenant_id, p_staff_member_id, p_period_month, p_idempotency_key, p_due_date);
$$;

create function public.update_staff_finance_period(
  p_period_id uuid,
  p_due_date date,
  p_expected_version integer default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.update_staff_finance_period(p_period_id, p_due_date, p_expected_version);
$$;

create function public.add_staff_period_line(
  p_period_id uuid,
  p_kind text,
  p_amount numeric,
  p_description text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.add_staff_period_line(p_period_id, p_kind, p_amount, p_description, p_idempotency_key);
$$;

create function public.update_staff_period_line(
  p_line_id uuid,
  p_amount numeric,
  p_description text default null,
  p_expected_version integer default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.update_staff_period_line(p_line_id, p_amount, p_description, p_expected_version);
$$;

create function public.void_staff_period_line(
  p_line_id uuid,
  p_reason text,
  p_expected_version integer default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.void_staff_period_line(p_line_id, p_reason, p_expected_version);
$$;

create function public.finalize_staff_finance_period(
  p_period_id uuid,
  p_expected_version integer default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.finalize_staff_finance_period(p_period_id, p_expected_version);
$$;

create function public.reopen_staff_finance_period(
  p_period_id uuid,
  p_reason text,
  p_expected_version integer default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.reopen_staff_finance_period(p_period_id, p_reason, p_expected_version);
$$;

create function public.cancel_staff_finance_period(p_period_id uuid, p_reason text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.cancel_staff_finance_period(p_period_id, p_reason);
$$;

create function public.record_staff_payment(
  p_period_id uuid,
  p_purpose text,
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
  select private.record_staff_payment(p_period_id, p_purpose, p_amount, p_method, p_paid_at, p_note, p_idempotency_key);
$$;

create function public.void_staff_payment(p_payment_id uuid, p_reason text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.void_staff_payment(p_payment_id, p_reason);
$$;

comment on function public.list_finance_staff(uuid) is
  'Faz FIN.1C.1 wrapper of private.list_finance_staff. finance.staff_view. Authenticated only.';
comment on function public.list_staff_line_kinds(uuid) is
  'Faz FIN.1C.1 wrapper of private.list_staff_line_kinds. finance.staff_view. Authenticated only.';
comment on function public.get_staff_finance_overview(uuid, date, date) is
  'Faz FIN.1C.1 wrapper of private.get_staff_finance_overview. finance.staff_view. Authenticated only. A read: writes nothing.';
comment on function public.get_staff_finance_period(uuid, date) is
  'Faz FIN.1C.1 wrapper of private.get_staff_finance_period. finance.staff_view. Authenticated only. A read: writes nothing.';
comment on function public.create_staff_finance_period(uuid, uuid, date, uuid, date) is
  'Faz FIN.1C.1 wrapper of private.create_staff_finance_period. finance.staff_manage. Authenticated only.';
comment on function public.update_staff_finance_period(uuid, date, integer) is
  'Faz FIN.1C.1 wrapper of private.update_staff_finance_period. finance.staff_manage. Authenticated only.';
comment on function public.add_staff_period_line(uuid, text, numeric, text, uuid) is
  'Faz FIN.1C.1 wrapper of private.add_staff_period_line. finance.staff_manage. Authenticated only.';
comment on function public.update_staff_period_line(uuid, numeric, text, integer) is
  'Faz FIN.1C.1 wrapper of private.update_staff_period_line (amount and description as the desired state). finance.staff_manage. Authenticated only.';
comment on function public.void_staff_period_line(uuid, text, integer) is
  'Faz FIN.1C.1 wrapper of private.void_staff_period_line. finance.staff_manage. Authenticated only.';
comment on function public.finalize_staff_finance_period(uuid, integer) is
  'Faz FIN.1C.1 wrapper of private.finalize_staff_finance_period. finance.staff_manage. Authenticated only.';
comment on function public.reopen_staff_finance_period(uuid, text, integer) is
  'Faz FIN.1C.1 wrapper of private.reopen_staff_finance_period. finance.staff_manage. Authenticated only.';
comment on function public.cancel_staff_finance_period(uuid, text) is
  'Faz FIN.1C.1 wrapper of private.cancel_staff_finance_period. finance.staff_manage. Authenticated only.';
comment on function public.record_staff_payment(uuid, text, numeric, text, timestamptz, text, uuid) is
  'Faz FIN.1C.1 wrapper of private.record_staff_payment. finance.staff_manage. Authenticated only.';
comment on function public.void_staff_payment(uuid, text) is
  'Faz FIN.1C.1 wrapper of private.void_staff_payment. finance.staff_manage. Authenticated only.';

-- =====================================================================
-- 10. GRANTS - every function loses its PUBLIC execute; only the fourteen wrappers are executable, by authenticated alone
--     (anon and service_role are revoked explicitly: nothing in the product calls these through the service role). The
--     private helpers, RPCs and trigger functions have no API-role grant at all.
-- =====================================================================
revoke execute on function private.staff_period_live_totals(uuid) from public;
revoke execute on function private.normalize_staff_finance_text(text) from public;
revoke execute on function private.normalize_staff_finance_amount(numeric) from public;
revoke execute on function private.normalize_staff_finance_month(date) from public;
revoke execute on function private.staff_period_create_fingerprint(uuid, date, date) from public;
revoke execute on function private.staff_line_add_fingerprint(uuid, text, numeric, text) from public;
revoke execute on function private.normalize_staff_payment_input(numeric, text, text, timestamptz, text) from public;
revoke execute on function private.post_staff_payment(uuid, uuid, text, numeric, text, timestamptz, text, uuid) from public;
revoke execute on function private.enforce_staff_period_invariants() from public;
revoke execute on function private.enforce_staff_line_invariants() from public;
revoke execute on function private.enforce_staff_payment_invariants() from public;
revoke execute on function private.recalculate_staff_period_totals() from public;
revoke execute on function private.create_staff_finance_period(uuid, uuid, date, uuid, date) from public;
revoke execute on function private.update_staff_finance_period(uuid, date, integer) from public;
revoke execute on function private.add_staff_period_line(uuid, text, numeric, text, uuid) from public;
revoke execute on function private.update_staff_period_line(uuid, numeric, text, integer) from public;
revoke execute on function private.void_staff_period_line(uuid, text, integer) from public;
revoke execute on function private.finalize_staff_finance_period(uuid, integer) from public;
revoke execute on function private.reopen_staff_finance_period(uuid, text, integer) from public;
revoke execute on function private.cancel_staff_finance_period(uuid, text) from public;
revoke execute on function private.record_staff_payment(uuid, text, numeric, text, timestamptz, text, uuid) from public;
revoke execute on function private.void_staff_payment(uuid, text) from public;
revoke execute on function private.list_finance_staff(uuid) from public;
revoke execute on function private.list_staff_line_kinds(uuid) from public;
revoke execute on function private.get_staff_finance_period(uuid, date) from public;
revoke execute on function private.get_staff_finance_overview(uuid, date, date) from public;

revoke execute on function public.list_finance_staff(uuid) from public, anon, service_role;
revoke execute on function public.list_staff_line_kinds(uuid) from public, anon, service_role;
revoke execute on function public.get_staff_finance_overview(uuid, date, date) from public, anon, service_role;
revoke execute on function public.get_staff_finance_period(uuid, date) from public, anon, service_role;
revoke execute on function public.create_staff_finance_period(uuid, uuid, date, uuid, date) from public, anon, service_role;
revoke execute on function public.update_staff_finance_period(uuid, date, integer) from public, anon, service_role;
revoke execute on function public.add_staff_period_line(uuid, text, numeric, text, uuid) from public, anon, service_role;
revoke execute on function public.update_staff_period_line(uuid, numeric, text, integer) from public, anon, service_role;
revoke execute on function public.void_staff_period_line(uuid, text, integer) from public, anon, service_role;
revoke execute on function public.finalize_staff_finance_period(uuid, integer) from public, anon, service_role;
revoke execute on function public.reopen_staff_finance_period(uuid, text, integer) from public, anon, service_role;
revoke execute on function public.cancel_staff_finance_period(uuid, text) from public, anon, service_role;
revoke execute on function public.record_staff_payment(uuid, text, numeric, text, timestamptz, text, uuid) from public, anon, service_role;
revoke execute on function public.void_staff_payment(uuid, text) from public, anon, service_role;

grant execute on function public.list_finance_staff(uuid) to authenticated;
grant execute on function public.list_staff_line_kinds(uuid) to authenticated;
grant execute on function public.get_staff_finance_overview(uuid, date, date) to authenticated;
grant execute on function public.get_staff_finance_period(uuid, date) to authenticated;
grant execute on function public.create_staff_finance_period(uuid, uuid, date, uuid, date) to authenticated;
grant execute on function public.update_staff_finance_period(uuid, date, integer) to authenticated;
grant execute on function public.add_staff_period_line(uuid, text, numeric, text, uuid) to authenticated;
grant execute on function public.update_staff_period_line(uuid, numeric, text, integer) to authenticated;
grant execute on function public.void_staff_period_line(uuid, text, integer) to authenticated;
grant execute on function public.finalize_staff_finance_period(uuid, integer) to authenticated;
grant execute on function public.reopen_staff_finance_period(uuid, text, integer) to authenticated;
grant execute on function public.cancel_staff_finance_period(uuid, text) to authenticated;
grant execute on function public.record_staff_payment(uuid, text, numeric, text, timestamptz, text, uuid) to authenticated;
grant execute on function public.void_staff_payment(uuid, text) to authenticated;

commit;
