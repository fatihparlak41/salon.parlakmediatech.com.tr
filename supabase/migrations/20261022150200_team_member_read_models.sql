-- Faz LAUNCH.1A (3 of 3) — read models for the Owner-facing Team management UI.
--
-- WHY
-- The membership lifecycle RPCs (suspend_membership, reactivate_membership,
-- remove_membership_access, update_membership_role — SAAS.1E.0) have existed
-- since 2026-09-21, but the Team page only listed ACTIVE members and returned
-- the auth user id of every row to the browser. A UI that manages members needs
--  - the suspended members too,
--  - to know, per member, whether THIS caller may act on them — answered by the
--    SAME authority function the mutations use (private.membership_authority_
--    decision), so the page never second-guesses the database, and
--  - the roles THIS caller may assign.
-- Both reads are SECURITY DEFINER functions that return exactly the columns the
-- UI needs: a display name, role, status, a self flag, the linked staff NAME and
-- the opaque membership id (the handle the mutation RPCs take). No auth user id,
-- no e-mail, no phone.
--
-- These are READ models. They authorize nothing: every mutation still runs the
-- full authority / last-owner / release-gate checks inside its own RPC.
--
-- ROLLBACK: drop the two public wrappers and the two private functions.

create or replace function private.list_team_members(p_tenant_id uuid)
returns table (
  membership_id uuid,
  display_name text,
  role_id uuid,
  role_name text,
  status text,
  is_self boolean,
  linked_staff_name text,
  can_manage boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- Same single gate as list_team_invitations: a non-member and a member
  -- without staff.manage get the same answer, so a tenant id cannot be probed.
  if not private.has_permission(p_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  return query
  select
    tm.id,
    nullif(btrim(p.full_name), ''),
    tm.role_id,
    r.name,
    tm.status,
    (tm.user_id = auth.uid()),
    (
      select sm.full_name
      from public.staff_members sm
      where sm.tenant_id = tm.tenant_id
        and sm.tenant_membership_id = tm.id
        and sm.deleted_at is null
      limit 1
    ),
    (private.membership_authority_decision(tm.tenant_id, tm.id, 'role_change') = 'ok')
  from public.tenant_memberships tm
  join public.roles r on r.id = tm.role_id and r.tenant_id = tm.tenant_id
  left join public.profiles p on p.id = tm.user_id
  where tm.tenant_id = p_tenant_id
    and tm.deleted_at is null
    and tm.status in ('active', 'suspended')
  order by tm.created_at, tm.id;
end;
$function$;

-- The roles the caller could put a member into. ADVISORY: it mirrors the two
-- authority conditions update_membership_role enforces (grant ceiling on the
-- role's full permission set, and strictly-below-caller unless unrestricted) by
-- calling the same helpers; the RPC re-checks both, and also applies the
-- staged-release gate, which is deliberately not duplicated here.
create or replace function private.list_assignable_roles(p_tenant_id uuid)
returns table (
  role_id uuid,
  role_name text,
  assignable boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_is_unrestricted boolean;
  v_caller_keys text[];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not private.has_permission(p_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  v_is_unrestricted := private.has_permission(p_tenant_id, 'permissions.manage_unrestricted');
  v_caller_keys := private.caller_permission_keys(p_tenant_id);

  return query
  select
    r.id,
    r.name,
    (
      private.caller_can_grant_permissions(p_tenant_id, private.role_permission_keys(r.id))
      and (v_is_unrestricted or private.is_strict_subset(private.role_permission_keys(r.id), v_caller_keys))
    )
  from public.roles r
  where r.tenant_id = p_tenant_id
    and r.deleted_at is null
  order by r.name, r.id;
end;
$function$;

create or replace function public.list_team_members(p_tenant_id uuid)
returns table (
  membership_id uuid,
  display_name text,
  role_id uuid,
  role_name text,
  status text,
  is_self boolean,
  linked_staff_name text,
  can_manage boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.list_team_members(p_tenant_id);
$$;

create or replace function public.list_assignable_roles(p_tenant_id uuid)
returns table (
  role_id uuid,
  role_name text,
  assignable boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.list_assignable_roles(p_tenant_id);
$$;

comment on function public.list_team_members(uuid) is
  'Faz LAUNCH.1A. staff.manage holders only. Active and suspended members of the tenant with display name, role, status, a self flag, the linked staff NAME and can_manage (the shared authority decision). Returns no auth user id, e-mail or phone.';
comment on function public.list_assignable_roles(uuid) is
  'Faz LAUNCH.1A. staff.manage holders only. Every live role of the tenant with an advisory assignable flag for the caller (grant ceiling + strictly-below rule). update_membership_role remains the enforcement point.';

revoke execute on function private.list_team_members(uuid) from public;
revoke execute on function private.list_assignable_roles(uuid) from public;
revoke execute on function public.list_team_members(uuid) from public, anon;
revoke execute on function public.list_assignable_roles(uuid) from public, anon;
grant execute on function public.list_team_members(uuid) to authenticated;
grant execute on function public.list_assignable_roles(uuid) to authenticated;
