-- Fixes a real gap found during Faz 2F's own post-migration verification
-- (a live anon-role smoke test plus a direct pg_proc.proacl read): every
-- function created by 20260822150500 came back with an explicit `=X`
-- (PUBLIC) entry in its ACL, alongside the intended anon/authenticated
-- grants on the 4 public.* ones.
--
-- Root cause: CREATE FUNCTION grants EXECUTE to PUBLIC by default —
-- this is Postgres's own built-in behavior, entirely separate from the
-- FOR-ROLE default-privilege machinery. 20260817104813's "FOR ROLE
-- postgres ... revoke execute on functions from anon, authenticated,
-- service_role" (still verified clean via
-- security_audit_default_privileges(), unaffected by this file) never
-- listed PUBLIC — it was scoped to closing DEV's stray anon/
-- authenticated/service_role bootstrap default, not PUBLIC's ordinary
-- default. Grepping every prior migration that creates a function shows
-- this project's actual, 100%-consistent convention for closing that
-- gap has never been a default-privilege statement at all: every single
-- one (20260815120014 through 20260822120000) explicitly runs
-- `revoke execute on function ... from public;` immediately after
-- creating each function, in the same migration. 20260822150500 missed
-- that step for its 9 new functions — this migration is the immediate
-- forward fix, not an edit to the already-applied file.
--
-- Practical impact of the gap was low (private schema USAGE is already
-- revoked from anon/authenticated so they could not have reached the 5
-- private.* functions regardless; PostgREST only ever routes RPC calls
-- to public.* by name, never private.*; and the 4 public.* functions
-- already had their intended anon/authenticated grants, so PUBLIC
-- ownership added no new caller PostgREST would ever route to) — but it
-- is real, it is inconsistent with this project's own established
-- pattern, and it must not stand uncorrected.

revoke execute on function private.resolve_bookable_tenant(text) from public;
revoke execute on function private.is_public_branch_valid(uuid, uuid) from public;
revoke execute on function private.is_public_service_valid(uuid, uuid, uuid) from public;
revoke execute on function private.public_booking_confirmation(uuid) from public;
revoke execute on function private.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid) from public;

revoke execute on function public.get_public_booking_context(text) from public;
revoke execute on function public.get_public_eligible_staff(text, uuid, uuid) from public;
revoke execute on function public.get_public_availability_slots(text, uuid, uuid, date, uuid) from public;
revoke execute on function public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid) from public;
