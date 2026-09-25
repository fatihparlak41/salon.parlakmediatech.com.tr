-- Faz SAAS.1E.1 (part 6) — backfill the default roles for EXISTING tenants.
--
-- =====================================================================
-- WHAT THIS DOES (and only this)
-- =====================================================================
--
-- New tenants get the four primary roles at creation (part 3). This brings
-- every existing, non-deleted tenant to the same place, using the same
-- idempotent functions — no special-case SQL:
--
--   1. MARK what is already customized. A system-default role whose
--      permission set was CHANGED through update_role_permissions has a
--      role.permissions_updated audit row; that is the evidence, and the
--      first such row's time becomes its customized_at. A row whose before
--      and after permission SETS are equal (a save that changed nothing —
--      update_role_permissions audits those too, but does not mark the
--      role) is not evidence; a row whose shape cannot be compared is
--      treated as evidence, the conservative direction (a role is never
--      synced on a guess). (PROD has no such row at all: no Owner role was
--      ever edited, so every existing system-default role is pristine.)
--      Marking comes BEFORE syncing so a customized role is never touched
--      below.
--   2. PROVISION the primary roles a tenant is missing (Yönetici, Resepsiyon,
--      Personel — and Salon Sahibi where absent). Existing roles, including
--      every owner-created custom role, are left exactly as they are.
--   3. SYNC pristine system-default roles to their template, ADDITIVELY:
--      missing template keys are added, nothing is ever removed. This is what
--      repairs a role that predates a permission key — e.g. a Salon Sahibi
--      that holds 19 of 23 keys gets the 4 it missed.
--
-- What it never does: create or change a membership, staff row, invitation,
-- customer, appointment or auth user; rename a role; remove a permission;
-- touch a customized role. Every role it creates or changes leaves a
-- role.provisioned / role.template_synced audit row (actor_type 'system').
--
-- Idempotent: a second run finds every role present and every pristine role in
-- sync, and changes nothing (no rows, no audit).

update public.roles r
set customized_at = ev.first_edit
from (
  select al.entity_id as role_id, min(al.created_at) as first_edit
  from public.audit_logs al
  where al.entity_type = 'role'
    and al.action = 'role.permissions_updated'
    and al.entity_id is not null
    -- not a provable no-op: compare the permission SETS (order and duplicates
    -- do not matter); anything that is not two arrays counts as a change.
    and not coalesce(
      case
        when jsonb_typeof(al.before -> 'permissions') = 'array'
         and jsonb_typeof(al.after -> 'permissions') = 'array'
        then (select coalesce(jsonb_agg(distinct x order by x), '[]'::jsonb) from jsonb_array_elements_text(al.before -> 'permissions') x)
           = (select coalesce(jsonb_agg(distinct x order by x), '[]'::jsonb) from jsonb_array_elements_text(al.after -> 'permissions') x)
      end,
      false)
  group by al.entity_id
) ev
where r.id = ev.role_id
  and r.is_system_default
  and r.customized_at is null;

select private.provision_default_roles(t.id)
from public.tenants t
where t.deleted_at is null
order by t.created_at, t.id;

select * from private.sync_pristine_default_roles(null, false, null);
