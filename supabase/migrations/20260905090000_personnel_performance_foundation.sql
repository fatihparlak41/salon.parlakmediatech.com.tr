-- Faz 5A.1 — Personnel Performance data foundation. Approved architecture:
-- see the Phase 5A audit (sections 2/4/5/11/12). Scope is deliberately
-- narrow — schema + one atomic completion RPC + one thin reporting view.
-- NO UI, NO dashboard, NO stock/checkout/commission. Nothing here changes
-- the behavior of any existing feature: update_appointment_status is
-- completely untouched, and every existing SELECT policy stays exactly
-- as permissive as it already was (the two new policies below are
-- strictly additive).
--
-- ===================================================================
-- CORE MODEL
-- ===================================================================
-- appointment_items.actual_staff_member_id: the PRIMARY actual performer
-- of that service item, when it differs from staff_member_id (the
-- booked/requested staff). Null means "not yet corrected" — reporting
-- must always read effective_performer_id = coalesce(actual_staff_member_id,
-- staff_member_id), never this column alone (see
-- appointment_item_performance below, the one place this rule lives).
-- Legacy/pre-existing completed rows are deliberately never backfilled
-- and stay null forever — the coalesce fallback is what makes that safe.
--
-- Named and commented as "primary" performer, not "only" performer, on
-- purpose: a future multi-contributor extension (e.g. a role-tagged
-- appointment_item_staff_assignments table for assistant/colorist/
-- responsible-stylist cases) can sit ALONGSIDE this column later without
-- replacing it or requiring a migration of existing data — see Phase 5A
-- architecture audit section 2 (Option 3).

-- Enables the composite tenant-safety FK below — same trick already used
-- for tenant_memberships (20260819052317) and customer/appointment rows
-- elsewhere in this schema. Redundant with the existing PK on id alone,
-- but Postgres requires the referenced columns to carry a unique
-- constraint of their own shape to be an FK target.
alter table public.staff_members
  add constraint staff_members_id_tenant_id_key unique (id, tenant_id);

alter table public.appointment_items
  add column actual_staff_member_id uuid references public.staff_members (id);

-- Tenant-safe integrity at the DB level, not just inside the RPC below:
-- this constraint makes it structurally impossible for
-- actual_staff_member_id to ever point at a staff row belonging to a
-- DIFFERENT tenant than the appointment_item itself, regardless of which
-- code path writes it, now or in the future. MATCH SIMPLE (the default)
-- means the constraint is only checked when actual_staff_member_id is
-- non-null — a null value (the "not yet corrected" default) is always
-- valid, exactly the same shape as staff_members_membership_same_tenant.
alter table public.appointment_items
  add constraint appointment_items_actual_staff_same_tenant
  foreign key (actual_staff_member_id, tenant_id)
  references public.staff_members (id, tenant_id);

comment on column public.appointment_items.actual_staff_member_id is
  'Faz 5A.1 — PRIMARY actual performer of this item, when it differs from staff_member_id (booked/requested staff). Null = not yet corrected; reporting must read effective_performer_id = coalesce(actual_staff_member_id, staff_member_id), never this column alone (see appointment_item_performance). Written only by private.complete_appointment, which always populates it (falling back to staff_member_id when no override is supplied) for every item it completes — null only ever describes a row completed before this existed, and legacy rows are never backfilled. "Primary" performer, not "only" performer: a future multi-contributor table can sit alongside this column without replacing it.';

-- ===================================================================
-- REPORT-ORIENTED INDEXES
-- ===================================================================
-- Audited existing indexes first (Phase 5A architecture audit section
-- 12): appointment_items_staff_scheduled_idx (staff_member_id,
-- scheduled_start_at, scheduled_end_at) already serves plain per-staff
-- time lookups, and the GiST overlap index serves booking-conflict
-- checks — neither is shaped for "this tenant, this status, this date
-- range" aggregation, which every personnel-performance report query
-- needs. Two new indexes close that gap; nothing existing is touched.
create index appointment_items_actual_staff_idx
  on public.appointment_items (tenant_id, actual_staff_member_id, appointment_status, scheduled_start_at)
  where actual_staff_member_id is not null;

create index appointment_items_tenant_status_scheduled_idx
  on public.appointment_items (tenant_id, appointment_status, scheduled_start_at);

-- ===================================================================
-- READ ACCESS: reports.staff stands alone (Phase 5A audit section 11)
-- ===================================================================
-- appointments/appointment_items today only grant SELECT to holders of
-- appointments.view (20260819052514). Per the approved architecture,
-- reports.staff (seeded since 20260815120005, currently unused anywhere
-- in code) must be sufficient on its own to read personnel-performance
-- data, without also requiring appointments.view — e.g. a future
-- accountant-shaped role. Postgres OR's multiple PERMISSIVE policies for
-- the same command together, so this is purely additive: nobody who
-- could already read these rows loses any access, and nothing else
-- about the existing appointments.view-gated policy changes.
create policy "appointments_select_reports_staff" on public.appointments
for select to authenticated
using (private.has_permission(tenant_id, 'reports.staff'));

create policy "appointment_items_select_reports_staff" on public.appointment_items
for select to authenticated
using (private.has_permission(tenant_id, 'reports.staff'));

-- services/staff_members already grant SELECT to any active tenant
-- member (is_tenant_member — see 20260819052350/20260819052317), and
-- reports.staff necessarily implies active tenant membership, so no
-- equivalent policy is needed on either of those tables.

-- ===================================================================
-- appointment_item_performance — thin reporting view
-- ===================================================================
-- security_invoker = true (Postgres 15+, this project runs 17): every
-- row is filtered by the CALLING user's own RLS on appointment_items/
-- appointments/services/staff_members, never the view owner's — this
-- view can never expose a row the caller could not already read
-- directly. Without this, a view created by the migration-owning role
-- would silently bypass RLS for every caller, since Postgres views
-- default to running as their owner.
--
-- Deliberately excludes price: Phase 5A explicitly excludes revenue/
-- financial performance (that is Phase 5B) — this view stays
-- structurally incapable of being summed into a fake revenue number.
-- Deliberately excludes any customer_* column beyond the opaque
-- customer_id FK — no full_name/phone/email, so no customer PII is ever
-- exposed through an analytics view. service_name/service_category are
-- exposed as separate, un-merged columns — service mix stays
-- service-based; any category-vs-name bucketing is a decision for
-- whatever report queries this later, not baked in here.
--
-- services/staff_members are LEFT JOINed defensively even though every
-- referenced row is guaranteed to exist (both FKs are NO ACTION, never
-- cascade, and both tables soft-delete) and every legitimate caller can
-- already see them (is_tenant_member) — this only guards against an RLS
-- edge case ever silently dropping a whole appointment_item row instead
-- of merely blanking a name column, which would be a much worse failure
-- mode for a reporting view. appointments is INNER JOINed: the new
-- reports.staff policy above guarantees it is always visible to anyone
-- who can see the appointment_item at all.
create view public.appointment_item_performance
with (security_invoker = true)
as
select
  ai.id as appointment_item_id,
  ai.tenant_id,
  ai.appointment_id,
  a.branch_id,
  a.customer_id,
  ai.service_id,
  s.name as service_name,
  s.category as service_category,
  ai.staff_member_id,
  sm.full_name as staff_member_name,
  ai.actual_staff_member_id,
  asm.full_name as actual_staff_member_name,
  coalesce(ai.actual_staff_member_id, ai.staff_member_id) as effective_performer_id,
  coalesce(asm.full_name, sm.full_name) as effective_performer_name,
  ai.appointment_status,
  ai.scheduled_start_at,
  ai.scheduled_end_at,
  ai.duration_minutes
from public.appointment_items ai
join public.appointments a on a.id = ai.appointment_id
left join public.services s on s.id = ai.service_id
left join public.staff_members sm on sm.id = ai.staff_member_id
left join public.staff_members asm on asm.id = ai.actual_staff_member_id;

comment on view public.appointment_item_performance is
  'Faz 5A.1 — thin, non-financial reporting foundation. security_invoker=true means every row is filtered by the CALLING user''s own RLS, never the view owner''s. No price/revenue (Phase 5A excludes financial performance; see Phase 5B). No customer PII beyond the opaque customer_id. service_name/service_category exposed unmerged — a future report decides its own bucketing.';

grant select on public.appointment_item_performance to authenticated;

-- ===================================================================
-- complete_appointment — the sole, narrow, atomic completion path that
-- also records actual performers. update_appointment_status is
-- completely untouched and remains the only path for every OTHER
-- transition (confirmed/in_progress/cancelled/no_show) and remains a
-- VALID way to reach 'completed' too, exactly as before — it simply
-- never populates actual_staff_member_id, which the fallback above
-- exists to handle.
--
-- p_performer_overrides: a jsonb array of {"appointment_item_id": uuid,
-- "actual_staff_member_id": uuid} — one entry per item being corrected
-- away from its booked staff_member_id. Any item NOT named (including
-- the default empty array) gets actual_staff_member_id set to its own
-- staff_member_id — "no correction supplied" always means "booked staff
-- performed it", and this column is never left null for anything
-- completed through this path.
--
-- Every override is validated in a read-only pass BEFORE any write: the
-- named item must belong to THIS appointment (AP016), and the named
-- staff member must be active, non-deleted, and belong to the SAME
-- tenant (AP008 — deliberately the identical error used for "does not
-- exist at all", mirroring validate_and_insert_appointment_item's own
-- established posture: a caller must never be able to distinguish
-- "wrong tenant" from "doesn't exist" from the error returned). Because
-- validation performs no writes, any single invalid entry aborts the
-- whole function with zero partial effect on either appointment_items
-- or appointments — this is the atomicity guarantee, not a separate
-- transaction-control mechanism.
create function private.complete_appointment(
  p_appointment_id uuid,
  p_performer_overrides jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_old_status text;
  v_override jsonb;
  v_item_id uuid;
  v_performer_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'AP001';
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

  if not private.has_permission(v_tenant_id, 'appointments.update') then
    raise exception 'appointments.update required' using errcode = 'AP002';
  end if;

  for v_override in select * from jsonb_array_elements(coalesce(p_performer_overrides, '[]'::jsonb))
  loop
    v_item_id := (v_override ->> 'appointment_item_id')::uuid;
    v_performer_id := (v_override ->> 'actual_staff_member_id')::uuid;

    if not exists (
      select 1 from public.appointment_items
      where id = v_item_id and appointment_id = p_appointment_id
    ) then
      raise exception 'appointment item does not belong to this appointment' using errcode = 'AP016';
    end if;

    if not exists (
      select 1 from public.staff_members
      where id = v_performer_id
        and tenant_id = v_tenant_id
        and status = 'active'
        and deleted_at is null
    ) then
      raise exception 'staff member not found or inactive in this tenant' using errcode = 'AP008';
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'appointment_item_id', id,
    'staff_member_id', staff_member_id,
    'actual_staff_member_id', actual_staff_member_id
  )), '[]'::jsonb) into v_before
  from public.appointment_items
  where appointment_id = p_appointment_id;

  update public.appointment_items ai
  set actual_staff_member_id = coalesce(
    (
      select (ov ->> 'actual_staff_member_id')::uuid
      from jsonb_array_elements(coalesce(p_performer_overrides, '[]'::jsonb)) ov
      where (ov ->> 'appointment_item_id')::uuid = ai.id
    ),
    ai.staff_member_id
  )
  where ai.appointment_id = p_appointment_id;

  update public.appointments
  set status = 'completed'
  where id = p_appointment_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'appointment_item_id', id,
    'staff_member_id', staff_member_id,
    'actual_staff_member_id', actual_staff_member_id
  )), '[]'::jsonb) into v_after
  from public.appointment_items
  where appointment_id = p_appointment_id;

  perform private.log_audit_event(
    v_tenant_id, 'appointment.status_changed', 'appointment', p_appointment_id,
    jsonb_build_object('status', v_old_status, 'items', v_before),
    jsonb_build_object('status', 'completed', 'items', v_after)
  );
end;
$$;

revoke execute on function private.complete_appointment(uuid, jsonb) from public;

create function public.complete_appointment(
  p_appointment_id uuid,
  p_performer_overrides jsonb default '[]'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.complete_appointment(p_appointment_id, p_performer_overrides);
$$;

revoke execute on function public.complete_appointment(uuid, jsonb) from public;
revoke execute on function public.complete_appointment(uuid, jsonb) from anon;
grant execute on function public.complete_appointment(uuid, jsonb) to authenticated;
