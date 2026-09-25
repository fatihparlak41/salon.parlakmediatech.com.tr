-- Faz SAAS.1E.1 (part 8B of 8A+8B — CONTRACT half) — revoke direct reads of staff
-- contact details, login links and leave reasons.
--
-- Replaces the second half of the original combined 20260921132701_staff_contact_privacy.sql.
-- 8A (20260921132658_staff_contact_privacy_expand.sql) already added the RPCs that
-- replace these direct reads.
--
-- MUST NOT be applied until the new application (which calls the part-8A RPCs instead
-- of reading these columns directly) is confirmed serving 100% of production traffic.
-- Applying this against the currently-deployed (pre-SAAS.1E.1) application breaks
-- Personnel, Staff detail, Staff schedules, the Team page's linked-staff display, staff
-- membership linking, and the Dashboard's staff-link lookup — see the SAAS.1E.1
-- staged-release compatibility audit, which is the reason this migration is separated
-- from 8A at all.
--
-- SAFE OPERATIONAL PROJECTION. The two tables keep their tenant-wide row
-- policies, but authenticated may now SELECT only these COLUMNS:
--
--   staff_members             id, tenant_id, full_name, color, status,
--                             display_order, concurrent_capacity, created_at,
--                             updated_at, deleted_at   (NOT email, phone,
--                             tenant_membership_id, created_by)
--   staff_schedule_exceptions id, tenant_id, staff_member_id, exception_date,
--                             type, start_time, end_time, created_at,
--                             updated_at, deleted_at   (NOT reason)
--
-- That is exactly what the calendar, the appointment screens, the dashboard roster and
-- the eligible-staff pickers already select. Column grants are per database role, so
-- the hidden columns are unreadable by every signed-in client. Writes are unchanged:
-- staff.manage still inserts/updates rows through the existing grants and policies, the
-- login link still changes only through link_staff_membership / unlink_staff_membership,
-- and the audit trigger (which records the whole row) is a definer function.

revoke select on public.staff_members from authenticated;

grant select (
  id,
  tenant_id,
  full_name,
  color,
  status,
  display_order,
  concurrent_capacity,
  created_at,
  updated_at,
  deleted_at
) on public.staff_members to authenticated;

revoke select on public.staff_schedule_exceptions from authenticated;

grant select (
  id,
  tenant_id,
  staff_member_id,
  exception_date,
  type,
  start_time,
  end_time,
  created_at,
  updated_at,
  deleted_at
) on public.staff_schedule_exceptions to authenticated;

-- Staged-release gate: deliberately NOT flipped here. Wave 2 applies every
-- privacy REVOKE and leaves private.release_gates closed — opening it is a
-- separately reviewed, separately approved Wave 3
-- (20260921132735_activate_non_owner_roles.sql), never an automatic side
-- effect of the contract migrations landing.
