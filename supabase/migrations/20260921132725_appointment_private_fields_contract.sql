-- Faz SAAS.1E.1 (part 7B of 7A+7B — CONTRACT half) — revoke direct reads of appointment
-- notes, item prices and the creating user.
--
-- Replaces the second half of the original combined 20260921132656_appointment_private_fields_hidden.sql.
-- 7A (20260921132656_appointment_private_details_expand.sql) already added the RPC that
-- replaces these direct reads.
--
-- MUST NOT be applied until the new application (which calls
-- get_appointment_private_details instead of reading these columns directly) is
-- confirmed serving 100% of production traffic. Applying this against the
-- currently-deployed (pre-SAAS.1E.1) application breaks its appointment-detail screen —
-- see the SAAS.1E.1 staged-release compatibility audit, which is the reason this
-- migration is separated from 7A at all.
--
--   appointments        readable columns: id, tenant_id, branch_id, customer_id,
--                       status, source, scheduled_start_at, scheduled_end_at,
--                       created_at, updated_at   (NOT notes, created_by,
--                       idempotency_key, idempotency_fingerprint)
--   appointment_items   readable columns: everything EXCEPT price
--
-- Column grants are per database ROLE, so the columns are unreadable by every
-- signed-in client, the Owner included. Everything else an appointment screen shows
-- (calendar, list, dashboard "today", the operational half of the detail sheet) already
-- lists its columns explicitly, so none of it changes. A PostgREST select=* on either
-- table is now refused, which is the point.
--
-- appointments still has no INSERT/UPDATE/DELETE grant for authenticated, and
-- appointment_items keeps none: every write goes through the appointment RPCs.
-- RLS is untouched (the tenant-wide appointments.view policy still decides
-- which ROWS a member sees); service_role and postgres keep full access.

revoke select (notes, created_by) on public.appointments from authenticated;

revoke select on public.appointment_items from authenticated;

grant select (
  id,
  tenant_id,
  appointment_id,
  service_id,
  staff_member_id,
  scheduled_start_at,
  scheduled_end_at,
  duration_minutes,
  sequence,
  appointment_status,
  created_at,
  updated_at,
  actual_staff_member_id
) on public.appointment_items to authenticated;
