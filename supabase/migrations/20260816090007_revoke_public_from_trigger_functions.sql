-- Cleanup from 20260816090006's audit: set_updated_at/handle_new_user
-- still had EXECUTE granted to the PUBLIC pseudo-role specifically (a
-- separate grant from the named anon/authenticated roles revoked in that
-- migration). Harmless in practice — Postgres refuses to invoke a trigger
-- function outside trigger context regardless of EXECUTE grants — but
-- removed anyway for a clean audit result.
revoke execute on function public.set_updated_at() from public;
revoke execute on function public.handle_new_user() from public;
