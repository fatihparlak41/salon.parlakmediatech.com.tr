-- Faz SAAS.1E.1 (part 5) — appointments.idempotency_key / idempotency_fingerprint
-- are no longer readable through the Data API.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- The appointment-scoped customer display (part 4) gives Personel a
-- customer's NAME and nothing else — that promise is only worth something if
-- no other column of a table Personel can read carries the rest of the
-- customer. An audit of every table an authenticated member can SELECT found
-- exactly one such column:
--
--   appointments.idempotency_fingerprint
--
-- create_guest_booking stores md5( tenant | branch | service | staff | start
-- time | customer name | NORMALIZED PHONE | NORMALIZED E-MAIL ) there for
-- public bookings that carry an idempotency key. Every input except phone and
-- e-mail is known to anyone who can see the appointment, and an unsalted MD5
-- over a 7–11 digit phone number falls to an offline brute force in seconds —
-- so any appointments.view holder could recover a guest's phone number from
-- that one column, customers.view or not. (Manager and Receptionist already
-- hold customers.view, so for them nothing changes; it is Personel that this
-- closes.)
--
-- Nothing in the application reads either column through PostgREST — only
-- SECURITY DEFINER booking functions and privileged test connections do — so
-- they simply stop being readable by clients. The table-level SELECT grant is
-- replaced by a column-level grant on every OTHER column. Consequences:
--   * every application query already lists its columns explicitly, so none
--     changes; a PostgREST select=* on appointments is now refused (permission
--     denied), which is the point;
--   * RLS is untouched (the tenant-wide appointments.view policy still decides
--     which ROWS a member sees);
--   * appointments has no INSERT/UPDATE/DELETE grant for authenticated, so
--     nothing else changes on the write side;
--   * this is a deliberate, reviewed column-level grant: the security-grants
--     regression test pins the exact list.
--
-- appointments.notes stays readable: it is appointment data, written for the
-- people who work the appointment. (The customer's OWN notes live on the
-- customers row and stay behind customers.view.)

revoke select on public.appointments from authenticated;

grant select (
  id,
  tenant_id,
  branch_id,
  customer_id,
  status,
  notes,
  source,
  scheduled_start_at,
  scheduled_end_at,
  created_by,
  created_at,
  updated_at
) on public.appointments to authenticated;
