-- Faz SAAS.1E.1 — Wave 3: open the staged-release gate.
--
-- This is the ONLY thing this migration does. It must never run bundled
-- with Wave 1 or Wave 2 — it is its own separately reviewed, separately
-- approved release step, applied only after Wave 2 has been live in PROD
-- long enough to be confirmed correct on its own. Everything above the
-- final UPDATE is a hard pre-condition: any single one failing aborts the
-- whole transaction and leaves the gate exactly as it was.

do $$
declare
  v_unexpected_active_count int;
begin
  -- 1. Both privacy-contract migrations recorded as applied.
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20260921132725') then
    raise exception 'activation pre-condition failed: 20260921132725 (appointment_private_fields_contract) is not applied';
  end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20260921132730') then
    raise exception 'activation pre-condition failed: 20260921132730 (staff_contact_columns_contract) is not applied';
  end if;

  -- 2. The actual column REVOKEs are structurally present — checked against
  -- the live catalog, not merely trusted from the migration-history row.
  -- The COMPLETE contract: every column either contract migration hides,
  -- not just a representative sample.
  if has_column_privilege('authenticated', 'public.appointments', 'notes', 'select') then
    raise exception 'activation pre-condition failed: appointments.notes is still directly readable';
  end if;
  if has_column_privilege('authenticated', 'public.appointments', 'created_by', 'select') then
    raise exception 'activation pre-condition failed: appointments.created_by is still directly readable';
  end if;
  if has_column_privilege('authenticated', 'public.appointment_items', 'price', 'select') then
    raise exception 'activation pre-condition failed: appointment_items.price is still directly readable';
  end if;
  if has_column_privilege('authenticated', 'public.staff_members', 'email', 'select') then
    raise exception 'activation pre-condition failed: staff_members.email is still directly readable';
  end if;
  if has_column_privilege('authenticated', 'public.staff_members', 'phone', 'select') then
    raise exception 'activation pre-condition failed: staff_members.phone is still directly readable';
  end if;
  if has_column_privilege('authenticated', 'public.staff_members', 'tenant_membership_id', 'select') then
    raise exception 'activation pre-condition failed: staff_members.tenant_membership_id is still directly readable';
  end if;
  if has_column_privilege('authenticated', 'public.staff_members', 'created_by', 'select') then
    raise exception 'activation pre-condition failed: staff_members.created_by is still directly readable';
  end if;
  if has_column_privilege('authenticated', 'public.staff_schedule_exceptions', 'reason', 'select') then
    raise exception 'activation pre-condition failed: staff_schedule_exceptions.reason is still directly readable';
  end if;
  -- Grants: every safe column must still be readable (the contract hides
  -- SPECIFIC columns, not the whole table) — a botched revoke that took
  -- everything down would break the app just as much as a missing one.
  if not has_column_privilege('authenticated', 'public.appointments', 'status', 'select') then
    raise exception 'activation pre-condition failed: appointments.status unexpectedly not readable';
  end if;
  if not has_column_privilege('authenticated', 'public.staff_members', 'full_name', 'select') then
    raise exception 'activation pre-condition failed: staff_members.full_name unexpectedly not readable';
  end if;

  -- 3. Every safe operational RPC Wave 1 introduced still exists and is
  -- callable by authenticated (not dropped by some intervening action).
  if not (
    has_function_privilege('authenticated', 'public.get_appointment_private_details(uuid, uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.get_staff_management_details(uuid, uuid[])', 'execute')
    and has_function_privilege('authenticated', 'public.get_staff_exception_reasons(uuid, uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.get_my_staff_link(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.get_staff_link_for_membership(uuid, uuid)', 'execute')
  ) then
    raise exception 'activation pre-condition failed: one or more Wave-1 safe operational RPCs is missing or not callable';
  end if;

  -- 4. The gate is currently closed (activation is a one-way, one-time
  -- transition inside this migration, never a blind re-open).
  if private.release_gate_open() then
    raise exception 'activation pre-condition failed: the release gate is already open';
  end if;

  -- 5. No unexpected non-owner activation happened during Wave 1 / Wave 2.
  -- PERMISSION-based, not role-key-based (a custom role with none of the
  -- four default keys carries exactly the same risk if it somehow got an
  -- active member while non-unrestricted). Per the confirmed current PROD
  -- state, both existing tenants have only their unrestricted Owner as an
  -- active membership — so today, correctly, this expects zero rows,
  -- system-wide, with no exceptions. Any active membership referencing a
  -- non-unrestricted role can only exist here if something bypassed every
  -- assert_role_activation_allowed call site (a bug, or a direct-SQL write
  -- outside the RPC layer entirely) — this does not prove that never
  -- happened, but it is the precise, checkable signal available, and a
  -- nonzero count here must stop activation for a manual audit rather than
  -- silently proceeding.
  select count(*) into v_unexpected_active_count
  from public.tenant_memberships tm
  join public.roles r on r.id = tm.role_id
  where tm.status = 'active'
    and tm.deleted_at is null
    and not ('permissions.manage_unrestricted' = any (private.role_permission_keys(r.id)));

  if v_unexpected_active_count > 0 then
    raise exception 'activation pre-condition failed: % unexpected active membership(s) already hold a newly-introduced role — manual audit required before activation', v_unexpected_active_count;
  end if;

  -- All pre-conditions hold. Activation is atomic (this whole DO block and
  -- the UPDATE below run in the migration's single implicit transaction)
  -- and auditable (enabled_at records exactly when).
  update private.release_gates
  set enabled = true, enabled_at = now()
  where key = 'saas_1e1_non_owner_roles_safe';

  if not found then
    raise exception 'activation failed: private.release_gates row for saas_1e1_non_owner_roles_safe not found';
  end if;
end $$;

-- post-condition
do $$
begin
  if not private.release_gate_open() then
    raise exception 'activation post-condition failed: gate did not open';
  end if;
end $$;
