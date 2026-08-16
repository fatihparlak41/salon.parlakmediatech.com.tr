-- Faz 1.5 audit follow-up: these three private.* functions carried a
-- direct `authenticated` EXECUTE grant left over from 20260815120014/
-- 20260815120018, but none of them is ever referenced inside an RLS
-- policy's USING/WITH CHECK clause (unlike has_permission, has_feature's
-- sibling is_tenant_member/is_platform_admin/is_platform_owner/
-- current_tenant_ids, which genuinely need it for policy evaluation to
-- work when `authenticated` queries a table directly). Their only real
-- callers are their own SECURITY DEFINER public.* wrapper, or — for
-- log_audit_event — other SECURITY DEFINER functions (create_role,
-- update_role_permissions, update_membership_role,
-- create_tenant_with_owner). A SECURITY DEFINER function's internal calls
-- run as its owner (postgres), not as the original caller, so the
-- original caller's own EXECUTE grant was never actually exercised here.
--
-- Confirmed by grepping every private.<fn>( call site across
-- supabase/migrations before writing this — see the Faz 1.5 report for
-- the full per-function table. Not a live vulnerability (private is not
-- in PostgREST's exposed schema list, see 20260815120014), same
-- defense-in-depth reasoning as 20260816090006.
revoke execute on function private.has_feature(uuid, text) from authenticated;
revoke execute on function private.log_audit_event(uuid, text, text, uuid, jsonb, jsonb) from authenticated;
revoke execute on function private.create_tenant_with_owner(text, text) from authenticated;
