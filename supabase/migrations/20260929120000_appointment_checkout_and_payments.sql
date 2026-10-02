-- Faz FIN.1A — Appointment checkout & payments. The first real financial
-- module: what an appointment was actually charged, what has been
-- collected, how, and what remains outstanding.
--
-- =====================================================================
-- CORE PRINCIPLE
-- =====================================================================
-- Appointment/service completion != payment. private.complete_appointment
-- (Faz 5A.1) is completely untouched — completing an appointment never
-- requires or implies payment, and paying never mutates
-- appointments.status. appointment_items.price remains exactly what it
-- has always been: the BOOKING-TIME price snapshot, never overwritten.
-- Everything charged/collected lives in three new, independent tables:
--
--   appointment_sales       - one financial account per appointment
--   appointment_sale_items  - what was actually charged, per item,
--                             independent of later service/price/staff
--                             catalog changes
--   payments                - money actually received; never deleted,
--                             only voided with audit evidence
--
-- No historical backfill: existing appointments do not suddenly gain a
-- sale row. A sale is created lazily, only the first time finance is
-- used for that specific appointment (get_or_create_appointment_sale).
--
-- =====================================================================
-- COMPLETED-ONLY GATE (V1, Owner review — added after the first draft)
-- =====================================================================
-- get_or_create_appointment_sale refuses to create a sale unless
-- appointments.status = 'completed' (FN010 otherwise; this alone also
-- covers 'cancelled', which can never become 'completed'). This is the
-- other direction of "completion != payment" above: completion still
-- never requires or implies payment, but checkout may now never START
-- before completion. Reason: appointment_sale_items snapshots the
-- FINAL service/price/performer at checkout-creation time — creating a
-- sale while still scheduled/confirmed/in_progress would risk
-- snapshotting a value a later reschedule or a completion-time
-- performer correction (private.complete_appointment's own
-- p_performer_overrides) could make stale, which would be especially
-- dangerous for a future commission/payroll report built on this same
-- snapshot. Deposits/prepayments are explicitly out of scope for
-- FIN.1A; if ever added, they need their own deliberate model, not a
-- relaxation of this gate.
--
-- =====================================================================
-- DISCOUNT MODEL (V1, authoritative — see FIN.1A spec "PRICE / DISCOUNT
-- EDITING"): ONE discount mechanism, not two competing ones.
-- =====================================================================
-- appointment_sale_items.unit_price is the actual charged price per
-- item (editable, defaults to the booking snapshot). Discounts are
-- SALE-LEVEL only (appointment_sales.discount_amount) — there is no
-- per-line discount column. subtotal = sum(unit_price); total_amount =
-- subtotal - discount_amount, enforced as a GENERATED column so the
-- invariant cannot drift. This keeps "booked price / actual checkout
-- price / discount / final charged amount" each independently visible
-- without inventing a second discount system.
--
-- =====================================================================
-- STATUS DERIVATION
-- =====================================================================
-- appointment_sales.status is a real, indexable column, but its value is
-- always DERIVED — never a second source of truth for "how much has been
-- paid". private.compute_appointment_sale_status(total, posted) is the
-- one place that logic lives; it runs after every payment insert/void
-- (trigger on public.payments) AND after every price/discount edit
-- (called inline, since those change total_amount but do not touch
-- payments). total=0 after discount is defined as 'paid' (zero
-- outstanding balance) per the spec. 'voided' is reserved for a future,
-- separately-authorized sale-void path — nothing in FIN.1A ever sets it,
-- but every mutation RPC below already refuses to touch a sale in that
-- state, so introducing that path later needs no change here.
--
-- No paid_total/balance_due column exists anywhere: both are always
-- computed from non-voided payment rows at read time (see
-- private.get_appointment_sale_for_appointment), exactly as the spec
-- asks — the only persisted, mutable aggregate is the derived `status`
-- column itself, which the spec explicitly allows.
--
-- =====================================================================
-- ACCESS MODEL
-- =====================================================================
-- Financial data is sensitive. All three tables: RLS enabled, ZERO
-- permissive policies, ALL direct privileges revoked from
-- public/anon/authenticated/service_role — exactly the NOTIF.1A posture,
-- not the RLS-policy-based posture appointments/appointment_items use.
-- The only door in is the narrow SECURITY DEFINER RPC surface below,
-- each of which independently re-derives tenant_id from the row being
-- acted on (never trusts a client-supplied tenant/branch/customer id)
-- and checks finance.view (read) or finance.manage (write) via the
-- existing private.has_permission — no new permission keys, no
-- role-name checks. Read results are hand-curated jsonb: no customer
-- name/phone/email, no appointment.notes, no staff email/phone, no raw
-- created_by/voided_by user ids.

begin;

-- =====================================================================
-- 1. TABLES
-- =====================================================================

create table public.appointment_sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  branch_id uuid not null references public.branches (id),
  appointment_id uuid not null unique references public.appointments (id),
  customer_id uuid not null references public.customers (id),
  currency text not null,
  subtotal numeric(12, 2) not null default 0 check (subtotal >= 0),
  discount_amount numeric(12, 2) not null default 0 check (discount_amount >= 0),
  -- Generated, not a plain column: structurally impossible for
  -- total_amount to drift from subtotal - discount_amount, regardless of
  -- which RPC or future code path writes subtotal/discount_amount.
  total_amount numeric(12, 2) generated always as (subtotal - discount_amount) stored,
  status text not null default 'open'
    check (status in ('open', 'partially_paid', 'paid', 'voided')),
  finalized_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_sales_discount_le_subtotal check (discount_amount <= subtotal)
);

comment on table public.appointment_sales is
  'Faz FIN.1A. One financial account per appointment, created lazily (private.get_or_create_appointment_sale) the first time checkout is used for that appointment — never backfilled for existing appointments. total_amount is generated (subtotal - discount_amount); status is derived, never a second source of truth for how much has been paid (see private.compute_appointment_sale_status).';

create table public.appointment_sale_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  sale_id uuid not null references public.appointment_sales (id),
  appointment_item_id uuid not null references public.appointment_items (id),
  service_id uuid not null references public.services (id),
  -- Snapshots, taken once at checkout-creation time. A later rename of
  -- the service, a catalog price change, or a staff re-assignment must
  -- never alter an already-created checkout — see appointment_items'
  -- own price/duration_minutes snapshot comment (20260819052514), same
  -- reasoning, one level up.
  service_name_snapshot text not null,
  actual_staff_member_id uuid references public.staff_members (id),
  unit_price numeric(10, 2) not null check (unit_price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_sale_items_one_row_per_item unique (sale_id, appointment_item_id)
);

comment on table public.appointment_sale_items is
  'Faz FIN.1A. What was actually charged per appointment_item, snapshotted once at checkout creation (service name, actual performer, unit price) — independent of later edits to the service catalog or staff assignment. unit_price is editable by finance.manage before settlement, atomically alongside every other item and the sale-level discount (private.update_appointment_sale_pricing); there is no per-line discount, by design — see the migration header.';

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  branch_id uuid not null references public.branches (id),
  appointment_sale_id uuid not null references public.appointment_sales (id),
  amount numeric(10, 2) not null check (amount > 0),
  method text not null check (method in ('cash', 'card', 'bank_transfer', 'other')),
  paid_at timestamptz not null default now(),
  note text check (char_length(note) <= 500),
  status text not null default 'posted' check (status in ('posted', 'voided')),
  idempotency_key uuid not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  voided_by uuid references auth.users (id),
  voided_at timestamptz,
  void_reason text check (char_length(void_reason) <= 500),
  constraint payments_void_state_consistent check (
    (status = 'posted' and voided_at is null and voided_by is null and void_reason is null)
    or
    (status = 'voided' and voided_at is not null and void_reason is not null)
  ),
  -- Idempotency is scoped per-tenant (not globally) so a key collision
  -- across two different tenants can never happen or matter.
  constraint payments_idempotency_key_unique unique (tenant_id, idempotency_key)
);

comment on table public.payments is
  'Faz FIN.1A. Money actually received against an appointment_sale. Never hard-deleted through any application RPC — an incorrect payment is voided (status=voided, voided_at/voided_by/void_reason set) with the row kept as audit evidence. idempotency_key (unique per tenant) makes a retried/double-clicked record_appointment_payment call safe.';

create index appointment_sale_items_sale_idx on public.appointment_sale_items (sale_id);
create index payments_sale_idx on public.payments (appointment_sale_id) where status = 'posted';
create index appointment_sales_tenant_status_idx on public.appointment_sales (tenant_id, status);

-- =====================================================================
-- 2. LOCKDOWN — RLS on, zero policies, all direct grants revoked. The
--    only access path is the SECURITY DEFINER RPC surface below (same
--    posture as NOTIF.1A's private.customer_notification_* tables).
-- =====================================================================
alter table public.appointment_sales enable row level security;
alter table public.appointment_sale_items enable row level security;
alter table public.payments enable row level security;

revoke all on public.appointment_sales from public, anon, authenticated, service_role;
revoke all on public.appointment_sale_items from public, anon, authenticated, service_role;
revoke all on public.payments from public, anon, authenticated, service_role;

-- =====================================================================
-- 3. STATUS DERIVATION — one pure function, called from the payments
--    trigger AND inline from the price/discount RPCs (both change what
--    total_amount vs. posted-payments looks like).
-- =====================================================================
create function private.compute_appointment_sale_status(p_total numeric, p_posted numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_total = 0 then 'paid'
    when p_posted is null or p_posted <= 0 then 'open'
    when p_posted >= p_total then 'paid'
    else 'partially_paid'
  end;
$$;

comment on function private.compute_appointment_sale_status(numeric, numeric) is
  'Faz FIN.1A. Pure derivation: total=0 -> paid (zero outstanding balance, per spec); posted<=0 -> open; posted>=total -> paid; else partially_paid. Never called for a sale whose status is already ''voided'' (every caller checks that first and leaves voided sales alone).';

revoke execute on function private.compute_appointment_sale_status(numeric, numeric) from public;

create function private.recalculate_appointment_sale_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale_id uuid := coalesce(new.appointment_sale_id, old.appointment_sale_id);
  v_total numeric(12, 2);
  v_current_status text;
  v_posted numeric(12, 2);
begin
  select total_amount, status into v_total, v_current_status
  from public.appointment_sales
  where id = v_sale_id
  for update;

  -- A voided sale is left alone: nothing in FIN.1A can reach this state,
  -- but if a future path ever does, payment activity must never silently
  -- resurrect it into open/partially_paid/paid.
  if v_current_status = 'voided' then
    return coalesce(new, old);
  end if;

  select coalesce(sum(amount), 0) into v_posted
  from public.payments
  where appointment_sale_id = v_sale_id and status = 'posted';

  update public.appointment_sales
  set status = private.compute_appointment_sale_status(v_total, v_posted),
      updated_at = now()
  where id = v_sale_id;

  return coalesce(new, old);
end;
$$;

comment on function private.recalculate_appointment_sale_status() is
  'Faz FIN.1A. AFTER INSERT/UPDATE OF status trigger on public.payments. Recomputes the parent sale''s status from the sum of its posted payments — fires on both a new posted payment and a void (status change), so voiding naturally recalculates outstanding state exactly as the spec''s 3500/1500+2000/void-2000 example requires.';

revoke execute on function private.recalculate_appointment_sale_status() from public;

create trigger recalculate_appointment_sale_status_trg
  after insert or update of status on public.payments
  for each row
  execute function private.recalculate_appointment_sale_status();

-- =====================================================================
-- 4. CHECKOUT CREATION (idempotent, concurrency-safe)
-- =====================================================================
create function private.get_or_create_appointment_sale(p_appointment_id uuid)
returns public.appointment_sales
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_branch_id uuid;
  v_customer_id uuid;
  v_appt_status text;
  v_currency text;
  v_subtotal numeric(12, 2);
  v_sale public.appointment_sales;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  -- Locks the appointment row for the duration of this transaction:
  -- two concurrent first-time-checkout calls for the SAME appointment
  -- serialize here, so the "on conflict do nothing + reselect" below is
  -- defense in depth, not the only thing preventing a duplicate sale.
  select tenant_id, branch_id, customer_id, status
    into v_tenant_id, v_branch_id, v_customer_id, v_appt_status
  from public.appointments
  where id = p_appointment_id
  for update;

  if v_tenant_id is null then
    raise exception 'appointment not found' using errcode = 'FN003';
  end if;

  if not private.has_permission(v_tenant_id, 'finance.manage') then
    raise exception 'finance.manage required' using errcode = 'FN002';
  end if;

  -- V1 rule (Owner review): checkout may only start once the appointment
  -- is actually completed — not merely "not cancelled". A sale created
  -- while still scheduled/confirmed/in_progress would snapshot a price/
  -- performer that a later reschedule or performer correction (at
  -- completion time) could make stale, which would be especially
  -- dangerous for a future commission/payroll report built on this same
  -- snapshot. This single check also covers 'cancelled' (trivially never
  -- 'completed'), so no separate cancelled-check is needed. Checked
  -- AFTER the permission check above on purpose: an unauthorized or
  -- cross-tenant caller must get FN002, never a hint (via FN010) that a
  -- non-completed appointment even exists. complete_appointment (Faz
  -- 5A.1) makes 'completed' a true terminal state — it can never
  -- transition away — so this can never reject a sale that already
  -- legitimately exists.
  if v_appt_status != 'completed' then
    raise exception 'appointment is not completed' using errcode = 'FN010';
  end if;

  -- Idempotent fast path: already exists, return the SAME sale.
  select * into v_sale from public.appointment_sales where appointment_id = p_appointment_id;
  if found then
    return v_sale;
  end if;

  select currency into v_currency from public.tenants where id = v_tenant_id;

  select coalesce(sum(ai.price), 0) into v_subtotal
  from public.appointment_items ai
  where ai.appointment_id = p_appointment_id;

  insert into public.appointment_sales (
    tenant_id, branch_id, appointment_id, customer_id, currency,
    subtotal, discount_amount, status, created_by
  )
  values (
    v_tenant_id, v_branch_id, p_appointment_id, v_customer_id, v_currency,
    v_subtotal, 0, private.compute_appointment_sale_status(v_subtotal, 0), auth.uid()
  )
  on conflict (appointment_id) do nothing
  returning * into v_sale;

  if v_sale.id is null then
    select * into v_sale from public.appointment_sales where appointment_id = p_appointment_id;
  end if;

  insert into public.appointment_sale_items (
    tenant_id, sale_id, appointment_item_id, service_id, service_name_snapshot,
    actual_staff_member_id, unit_price
  )
  select
    v_tenant_id,
    v_sale.id,
    ai.id,
    ai.service_id,
    coalesce(s.name, 'Hizmet'),
    coalesce(ai.actual_staff_member_id, ai.staff_member_id),
    ai.price
  from public.appointment_items ai
  left join public.services s on s.id = ai.service_id
  where ai.appointment_id = p_appointment_id
  on conflict (sale_id, appointment_item_id) do nothing;

  perform private.log_audit_event(
    v_tenant_id, 'finance.sale_created', 'appointment_sale', v_sale.id,
    null,
    jsonb_build_object('appointment_id', p_appointment_id, 'subtotal', v_subtotal)
  );

  return v_sale;
end;
$$;

comment on function private.get_or_create_appointment_sale(uuid) is
  'Faz FIN.1A. The only way a sale is ever created. Requires the appointment to be status=completed (FN010 otherwise — this alone also covers cancelled, which can never be completed) so the snapshot below reflects the FINAL performer/price, not a value a later reschedule or completion-time correction could make stale. Idempotent (repeat calls return the same row) and concurrency-safe (appointment row lock + unique appointment_id constraint). Snapshots every appointment_item into appointment_sale_items exactly once: unit_price = appointment_items.price, actual_staff_member_id = coalesce(actual_staff_member_id, staff_member_id), service name = current catalog name at that moment. Requires finance.manage.';

revoke execute on function private.get_or_create_appointment_sale(uuid) from public;

-- =====================================================================
-- 5. PRICE / DISCOUNT EDITING — ONE atomic RPC (Owner review: the UI's
--    single "Kaydet" action must mean every requested item price AND
--    the discount commit together, or nothing commits — a sequence of
--    independent per-item RPC calls followed by a separate discount
--    call could leave a sale partially edited if a later call in the
--    sequence failed after an earlier one already succeeded). This
--    replaces an earlier two-RPC draft (adjust_appointment_sale_item_
--    price + adjust_appointment_sale_discount) outright — FIN.1A was
--    never released, so there is no reason to keep three competing
--    write paths for the same V1 operation.
-- =====================================================================
create function private.update_appointment_sale_pricing(
  p_sale_id uuid,
  p_items jsonb,
  p_discount_amount numeric,
  p_discount_reason text default null
)
returns public.appointment_sales
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_sale_status text;
  v_posted numeric(12, 2);
  -- Deliberately UNBOUNDED numeric (not numeric(12,2)/(10,2)) for every
  -- value being validated below: assigning to a bounded variable would
  -- silently round (or raise a raw 22003 overflow) BEFORE the explicit
  -- checks that turn a bad value into a stable FN004 could run.
  v_proposed_subtotal numeric;
  v_proposed_total numeric;
  v_item jsonb;
  v_item_id uuid;
  v_item_price numeric;
  -- Parsed (canonical) ids seen so far — duplicate detection MUST run on
  -- the parsed uuid, never on the raw text: '...ABC...', '...abc...',
  -- '{...abc...}' and the hyphen-less form all cast to the same uuid.
  v_seen uuid[] := '{}';
  v_supplied_count int;
  v_existing_count int;
  v_before jsonb;
  v_after jsonb;
  v_sale public.appointment_sales;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  -- Locks the sale for the whole function: every read below (posted
  -- total, existing item set) is consistent with what gets written at
  -- the end, and a concurrent record_appointment_payment/void/another
  -- pricing edit on the same sale serializes here.
  select tenant_id, status into v_tenant_id, v_sale_status
  from public.appointment_sales
  where id = p_sale_id
  for update;

  if v_tenant_id is null then
    raise exception 'sale not found' using errcode = 'FN003';
  end if;

  if not private.has_permission(v_tenant_id, 'finance.manage') then
    raise exception 'finance.manage required' using errcode = 'FN002';
  end if;

  if v_sale_status = 'voided' then
    raise exception 'sale is voided' using errcode = 'FN008';
  end if;

  -- Two separate ifs on purpose: SQL does not guarantee OR-operand
  -- evaluation order, and jsonb_array_length on a non-array would raise
  -- a raw 22023 instead of this stable FN004.
  if p_items is null or jsonb_typeof(p_items) != 'array' then
    raise exception 'items must be a non-empty array' using errcode = 'FN004';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'items must be a non-empty array' using errcode = 'FN004';
  end if;

  v_supplied_count := jsonb_array_length(p_items);

  -- Validate EVERY supplied item before writing anything: a well-formed
  -- uuid (each seen at most once, compared as parsed uuids), a numeric
  -- unit_price >= 0, and it must belong to THIS sale (and therefore this
  -- tenant — appointment_sale_items.tenant_id is set from the same
  -- tenant at creation, checked again here as defense in depth, never
  -- trusted from the client).
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    begin
      v_item_id := (v_item ->> 'sale_item_id')::uuid;
    exception when others then
      raise exception 'invalid sale item id' using errcode = 'FN004';
    end;

    if v_item_id is null then
      raise exception 'invalid sale item id' using errcode = 'FN004';
    end if;

    if v_item_id = any (v_seen) then
      raise exception 'duplicate sale item id supplied' using errcode = 'FN004';
    end if;
    v_seen := array_append(v_seen, v_item_id);

    if v_item -> 'unit_price' is null or jsonb_typeof(v_item -> 'unit_price') != 'number' then
      raise exception 'invalid unit price' using errcode = 'FN004';
    end if;
    -- >= 0, within appointment_sale_items.unit_price's numeric(10,2)
    -- range, and at most 2 decimals: a value like 10.005 would otherwise
    -- be silently rounded per ITEM at write time while the subtotal is
    -- summed from the UNROUNDED values, leaving appointment_sales.subtotal
    -- different from the sum of the stored item prices.
    v_item_price := (v_item ->> 'unit_price')::numeric;
    if v_item_price < 0 or v_item_price > 99999999.99 or v_item_price != round(v_item_price, 2) then
      raise exception 'invalid unit price' using errcode = 'FN004';
    end if;

    if not exists (
      select 1 from public.appointment_sale_items
      where id = v_item_id and sale_id = p_sale_id and tenant_id = v_tenant_id
    ) then
      raise exception 'sale item does not belong to this sale' using errcode = 'FN004';
    end if;
  end loop;

  -- Exact-set-match: every supplied item is already confirmed distinct
  -- and confirmed to belong to this sale (a subset of its real items);
  -- equal cardinality with the sale's real item count therefore proves
  -- the supplied set IS the sale's real item set — no missing item can
  -- silently survive with its old price, no stale/partial client state
  -- can rewrite only part of the checkout.
  select count(*) into v_existing_count
  from public.appointment_sale_items
  where sale_id = p_sale_id;

  if v_supplied_count != v_existing_count then
    raise exception 'must supply exactly the sale''s current items' using errcode = 'FN004';
  end if;

  select coalesce(sum((elem ->> 'unit_price')::numeric), 0) into v_proposed_subtotal
  from jsonb_array_elements(p_items) elem;

  -- Same 2-decimal rule as the item prices (a sub-cent discount would be
  -- silently rounded at write time while the checks below used the
  -- unrounded value).
  if p_discount_amount is null or p_discount_amount < 0 or p_discount_amount != round(p_discount_amount, 2) then
    raise exception 'invalid discount' using errcode = 'FN004';
  end if;

  if p_discount_amount > v_proposed_subtotal then
    raise exception 'discount exceeds subtotal' using errcode = 'FN004';
  end if;

  if p_discount_reason is not null and char_length(p_discount_reason) > 500 then
    raise exception 'reason too long' using errcode = 'FN004';
  end if;

  select coalesce(sum(amount), 0) into v_posted
  from public.payments
  where appointment_sale_id = p_sale_id and status = 'posted';

  v_proposed_total := v_proposed_subtotal - p_discount_amount;

  -- V1 safe-editing rule: this edit may never leave the sale owing LESS
  -- than what is already collected (e.g. collected=2500, this edit
  -- would make total=2000 -> rejected).
  if v_proposed_total < v_posted then
    raise exception 'new total would be less than the amount already collected' using errcode = 'FN004';
  end if;

  -- Every validation has passed. From here on this is pure write —
  -- BEFORE snapshot for the audit event, captured just ahead of it.
  select jsonb_build_object(
    'subtotal', s.subtotal,
    'discountAmount', s.discount_amount,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'unitPrice', unit_price) order by id), '[]'::jsonb)
      from public.appointment_sale_items where sale_id = p_sale_id
    )
  ) into v_before
  from public.appointment_sales s
  where s.id = p_sale_id;

  update public.appointment_sale_items asi
  set unit_price = (elem ->> 'unit_price')::numeric,
      updated_at = now()
  from jsonb_array_elements(p_items) elem
  where asi.id = (elem ->> 'sale_item_id')::uuid
    and asi.sale_id = p_sale_id;

  update public.appointment_sales
  set subtotal = v_proposed_subtotal,
      discount_amount = p_discount_amount,
      status = private.compute_appointment_sale_status(v_proposed_total, v_posted),
      updated_at = now()
  where id = p_sale_id
  returning * into v_sale;

  select jsonb_build_object(
    'subtotal', v_sale.subtotal,
    'discountAmount', v_sale.discount_amount,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'unitPrice', unit_price) order by id), '[]'::jsonb)
      from public.appointment_sale_items where sale_id = p_sale_id
    ),
    'discountReason', p_discount_reason
  ) into v_after;

  -- ONE audit event for the whole atomic save, not one per line item.
  perform private.log_audit_event(
    v_tenant_id, 'finance.sale_updated', 'appointment_sale', p_sale_id,
    v_before, v_after
  );

  return v_sale;
end;
$$;

comment on function private.update_appointment_sale_pricing(uuid, jsonb, numeric, text) is
  'Faz FIN.1A. The ONE atomic pricing-save RPC — replaces an earlier draft''s separate per-item-price and discount RPCs. p_items must be the COMPLETE desired set of the sale''s item prices (every current sale_item_id exactly once, each with a numeric unit_price >= 0, at most 2 decimals, within numeric(10,2) range; the discount likewise at most 2 decimals) — validated entirely (shape, precision, tenancy, no duplicates, no missing/foreign items) before any row is written, so a rejected call changes zero rows: one Postgres function call is one implicit transaction, so any raise exception anywhere above rolls back every write this call would have made. Never touches appointment_items.price (the immutable booking snapshot). Requires finance.manage. Refused once the sale is voided (FN008), and refused if the resulting total would fall below the amount already collected (FN004). Writes exactly one finance.sale_updated audit event for the whole save.';

revoke execute on function private.update_appointment_sale_pricing(uuid, jsonb, numeric, text) from public;

-- =====================================================================
-- 6. PAYMENTS
-- =====================================================================
create function private.record_appointment_payment(
  p_sale_id uuid,
  p_amount numeric,
  p_method text,
  p_paid_at timestamptz,
  p_note text default null,
  p_idempotency_key uuid default null
)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_branch_id uuid;
  v_total numeric(12, 2);
  v_sale_status text;
  v_posted numeric(12, 2);
  v_existing public.payments;
  v_payment public.payments;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = 'FN004';
  end if;

  -- Locks the sale for the duration of this transaction: two concurrent
  -- payment requests against the SAME sale serialize here, so the
  -- overpayment check below (reading the posted total) can never race.
  select tenant_id, branch_id, total_amount, status
    into v_tenant_id, v_branch_id, v_total, v_sale_status
  from public.appointment_sales
  where id = p_sale_id
  for update;

  if v_tenant_id is null then
    raise exception 'sale not found' using errcode = 'FN003';
  end if;

  if not private.has_permission(v_tenant_id, 'finance.manage') then
    raise exception 'finance.manage required' using errcode = 'FN002';
  end if;

  if v_sale_status = 'voided' then
    raise exception 'sale is voided' using errcode = 'FN008';
  end if;

  -- Idempotency: same tenant + key already used at all?
  select * into v_existing
  from public.payments
  where tenant_id = v_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.appointment_sale_id = p_sale_id
       and v_existing.amount = p_amount
       and v_existing.method = p_method
       and v_existing.paid_at = p_paid_at
       and coalesce(v_existing.note, '') = coalesce(p_note, '')
    then
      return v_existing;
    else
      raise exception 'idempotency key already used with a different payload' using errcode = 'FN007';
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount' using errcode = 'FN004';
  end if;

  if p_method is null or p_method not in ('cash', 'card', 'bank_transfer', 'other') then
    raise exception 'invalid payment method' using errcode = 'FN006';
  end if;

  if p_paid_at is null or p_paid_at > now() + interval '1 hour' then
    raise exception 'invalid payment date' using errcode = 'FN004';
  end if;

  if p_note is not null and char_length(p_note) > 500 then
    raise exception 'note too long' using errcode = 'FN004';
  end if;

  select coalesce(sum(amount), 0) into v_posted
  from public.payments
  where appointment_sale_id = p_sale_id and status = 'posted';

  if v_posted + p_amount > v_total then
    raise exception 'payment would exceed the sale total' using errcode = 'FN005';
  end if;

  insert into public.payments (
    tenant_id, branch_id, appointment_sale_id, amount, method, paid_at, note,
    idempotency_key, created_by
  )
  values (
    v_tenant_id, v_branch_id, p_sale_id, p_amount, p_method, p_paid_at, p_note,
    p_idempotency_key, auth.uid()
  )
  returning * into v_payment;

  perform private.log_audit_event(
    v_tenant_id, 'finance.payment_recorded', 'payment', v_payment.id,
    null,
    jsonb_build_object('appointment_sale_id', p_sale_id, 'amount', p_amount, 'method', p_method)
  );

  return v_payment;
end;
$$;

comment on function private.record_appointment_payment(uuid, numeric, text, timestamptz, text, uuid) is
  'Faz FIN.1A. Requires finance.manage. amount > 0, method in (cash,card,bank_transfer,other), paid_at not absurdly future-dated, note <=500 chars, idempotency_key required. Row-locks the sale so two concurrent calls cannot overpay it. Same idempotency_key + identical payload returns the original payment (safe retry); same key + a different payload is a stable FN007, never a silent overwrite. Never allows posted total to exceed the sale total (FN005).';

revoke execute on function private.record_appointment_payment(uuid, numeric, text, timestamptz, text, uuid) from public;

create function private.void_appointment_payment(p_payment_id uuid, p_reason text)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_status text;
  v_payment public.payments;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  select tenant_id, status into v_tenant_id, v_status
  from public.payments
  where id = p_payment_id
  for update;

  if v_tenant_id is null then
    raise exception 'payment not found' using errcode = 'FN009';
  end if;

  if not private.has_permission(v_tenant_id, 'finance.manage') then
    raise exception 'finance.manage required' using errcode = 'FN002';
  end if;

  -- Already voided: idempotent no-op (safe against a double-clicked
  -- void button / a retried request) — returns the current row as-is,
  -- no second audit entry, no re-validation of the reason.
  if v_status = 'voided' then
    select * into v_payment from public.payments where id = p_payment_id;
    return v_payment;
  end if;

  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    raise exception 'void reason required' using errcode = 'FN004';
  end if;

  if char_length(p_reason) > 500 then
    raise exception 'void reason too long' using errcode = 'FN004';
  end if;

  update public.payments
  set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
  where id = p_payment_id
  returning * into v_payment;

  perform private.log_audit_event(
    v_tenant_id, 'finance.payment_voided', 'payment', p_payment_id,
    jsonb_build_object('status', 'posted'),
    jsonb_build_object('status', 'voided', 'reason', btrim(p_reason))
  );

  return v_payment;
end;
$$;

comment on function private.void_appointment_payment(uuid, text) is
  'Faz FIN.1A. Requires finance.manage. Never deletes the row: sets status=voided/voided_at/voided_by/void_reason. Voiding an already-voided payment is an idempotent no-op (returns current state, no error, no duplicate audit entry) — safe against a double-clicked void action. The AFTER UPDATE OF status trigger on payments recalculates the parent sale''s status naturally.';

revoke execute on function private.void_appointment_payment(uuid, text) from public;

-- =====================================================================
-- 7. READ MODEL — one curated, PII-free jsonb shape for the finance
--    panel. No customer name/phone/email, no appointment.notes, no
--    staff email/phone, no raw created_by/voided_by ids.
-- =====================================================================
create function private.get_appointment_sale_for_appointment(p_appointment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_sale public.appointment_sales;
  v_collected numeric(12, 2);
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'FN001';
  end if;

  select tenant_id into v_tenant_id from public.appointments where id = p_appointment_id;
  if v_tenant_id is null then
    raise exception 'appointment not found' using errcode = 'FN003';
  end if;

  if not private.has_permission(v_tenant_id, 'finance.view') then
    raise exception 'finance.view required' using errcode = 'FN002';
  end if;

  select * into v_sale from public.appointment_sales where appointment_id = p_appointment_id;
  if not found then
    return null;
  end if;

  -- collected/outstanding are computed here, at read time, from posted
  -- payments only — never persisted as columns, so there is still only
  -- one source of truth (the payments rows); this RPC is simply where
  -- the UI-facing arithmetic happens instead of leaving it to the client.
  select coalesce(sum(amount), 0) into v_collected
  from public.payments
  where appointment_sale_id = v_sale.id and status = 'posted';

  select jsonb_build_object(
    'id', v_sale.id,
    'appointmentId', v_sale.appointment_id,
    'currency', v_sale.currency,
    'subtotal', v_sale.subtotal,
    'discountAmount', v_sale.discount_amount,
    'totalAmount', v_sale.total_amount,
    'collected', v_collected,
    'outstanding', v_sale.total_amount - v_collected,
    'status', v_sale.status,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', asi.id,
        'appointmentItemId', asi.appointment_item_id,
        'serviceName', asi.service_name_snapshot,
        'unitPrice', asi.unit_price
      ) order by asi.created_at), '[]'::jsonb)
      from public.appointment_sale_items asi
      where asi.sale_id = v_sale.id
    ),
    'payments', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id,
        'amount', p.amount,
        'method', p.method,
        'paidAt', p.paid_at,
        'note', p.note,
        'status', p.status,
        'voidReason', p.void_reason
      ) order by p.paid_at), '[]'::jsonb)
      from public.payments p
      where p.appointment_sale_id = v_sale.id
    )
  ) into v_result;

  return v_result;
end;
$$;

comment on function private.get_appointment_sale_for_appointment(uuid) is
  'Faz FIN.1A. Requires finance.view. Returns null if no sale exists yet for this appointment (checkout was never opened) — this is not an error. Hand-curated shape only: no customer name/phone/email, no appointment.notes, no staff email/phone, no raw created_by/voided_by user ids. collected/outstanding are computed here from posted payments at read time, never persisted as columns — still one source of truth (the payments rows), just computed server-side instead of left to the caller.';

revoke execute on function private.get_appointment_sale_for_appointment(uuid) from public;

-- =====================================================================
-- 8. PUBLIC WRAPPERS — thin pass-throughs, authenticated only, same
--    shape as every other RPC surface in this codebase (e.g.
--    complete_appointment, 20260905090000).
-- =====================================================================
create function public.get_or_create_appointment_sale(p_appointment_id uuid)
returns public.appointment_sales
language sql
security definer
set search_path = ''
as $$
  select private.get_or_create_appointment_sale(p_appointment_id);
$$;

create function public.update_appointment_sale_pricing(
  p_sale_id uuid,
  p_items jsonb,
  p_discount_amount numeric,
  p_discount_reason text default null
)
returns public.appointment_sales
language sql
security definer
set search_path = ''
as $$
  select private.update_appointment_sale_pricing(p_sale_id, p_items, p_discount_amount, p_discount_reason);
$$;

create function public.record_appointment_payment(
  p_sale_id uuid,
  p_amount numeric,
  p_method text,
  p_paid_at timestamptz,
  p_note text default null,
  p_idempotency_key uuid default null
)
returns public.payments
language sql
security definer
set search_path = ''
as $$
  select private.record_appointment_payment(p_sale_id, p_amount, p_method, p_paid_at, p_note, p_idempotency_key);
$$;

create function public.void_appointment_payment(p_payment_id uuid, p_reason text)
returns public.payments
language sql
security definer
set search_path = ''
as $$
  select private.void_appointment_payment(p_payment_id, p_reason);
$$;

create function public.get_appointment_sale_for_appointment(p_appointment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_appointment_sale_for_appointment(p_appointment_id);
$$;

revoke execute on function public.get_or_create_appointment_sale(uuid) from public, anon;
revoke execute on function public.update_appointment_sale_pricing(uuid, jsonb, numeric, text) from public, anon;
revoke execute on function public.record_appointment_payment(uuid, numeric, text, timestamptz, text, uuid) from public, anon;
revoke execute on function public.void_appointment_payment(uuid, text) from public, anon;
revoke execute on function public.get_appointment_sale_for_appointment(uuid) from public, anon;

grant execute on function public.get_or_create_appointment_sale(uuid) to authenticated;
grant execute on function public.update_appointment_sale_pricing(uuid, jsonb, numeric, text) to authenticated;
grant execute on function public.record_appointment_payment(uuid, numeric, text, timestamptz, text, uuid) to authenticated;
grant execute on function public.void_appointment_payment(uuid, text) to authenticated;
grant execute on function public.get_appointment_sale_for_appointment(uuid) to authenticated;

commit;
