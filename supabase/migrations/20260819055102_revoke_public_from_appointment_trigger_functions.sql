-- 20260819052514 created two trigger functions (private.set_appointment_item_status_from_parent,
-- private.sync_appointment_item_status) without revoking Postgres's default PUBLIC execute
-- grant, the same oversight 20260816090007 already fixed once for public.set_updated_at().
-- Trigger functions are invoked by the trigger mechanism itself, not via a caller EXECUTE
-- check, so revoking from public does not affect trigger firing (confirmed by
-- 20260816090007/8's precedent — set_updated_at has had no execute grants at all since and
-- every updated_at trigger still fires normally). Found by
-- tests/security-grants-regression.test.ts on DEV: "no function retains a PUBLIC execute
-- grant". Do not edit 20260819052514 — it was already applied; correct forward.
revoke execute on function private.set_appointment_item_status_from_parent() from public;
revoke execute on function private.sync_appointment_item_status() from public;
