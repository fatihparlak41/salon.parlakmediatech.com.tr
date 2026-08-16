-- Faz 1.5: role_permissions and tenant_memberships.role_id are the two
-- actual privilege-escalation surfaces (role creation and role reassignment
-- go through the RPCs in 20260816090003 instead, which enforce the
-- permission ceiling). Direct client writes to them are removed here so
-- there's no way to route around the ceiling check via a raw PostgREST
-- call — the RPCs are the only path, not just the intended one.

-- role_permissions: read stays open to tenant members (already granted);
-- write only through private.create_role() / private.update_role_permissions().
revoke insert, delete on public.role_permissions from authenticated;

-- roles: name/description edits stay direct (not a security boundary —
-- see 20260816090003 comment). Creation goes through private.create_role()
-- so it always gets a ceiling-checked initial permission set.
revoke insert on public.roles from authenticated;

-- tenant_memberships: only `status` (suspend/reactivate) may be written
-- directly. `role_id` changes only through
-- private.update_membership_role(), which enforces the ceiling against
-- the target role's full permission set — not just a delta from the
-- member's previous role, which would otherwise let someone launder an
-- escalation through a pre-existing overpowered role instead of editing
-- role_permissions directly.
revoke update on public.tenant_memberships from authenticated;
grant update (status) on public.tenant_memberships to authenticated;
