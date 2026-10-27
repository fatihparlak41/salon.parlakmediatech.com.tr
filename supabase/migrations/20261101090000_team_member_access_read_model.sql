-- Faz SAAS.1A — the READ model behind the Owner-facing "Ekip" member list.
--
-- WHY
-- The membership lifecycle RPCs (suspend_membership, reactivate_membership, remove_membership_access,
-- update_membership_role — SAAS.1E.0) have existed since 2026-09-21, but the Team page could only list ACTIVE
-- members, returned the auth user id of every row to the browser, and could not show an e-mail address (auth.users
-- is not reachable through PostgREST). An account-administration screen needs
--   - the suspended members too (otherwise a suspended person can never be reactivated from the UI),
--   - each member's e-mail address (two people can share a display name; the Owner invited by e-mail),
--   - per member, whether THIS caller may suspend / reactivate / remove them, so the UI shows only controls that
--     can work (no fake buttons): answered by the SAME authority function the mutations use
--     (private.membership_authority_decision) plus the last-unrestricted-holder rule,
--   - a flag for the member who is the tenant's LAST unrestricted holder (the last Owner), so the page can say why
--     that person has no controls.
--
-- WHAT IT IS NOT
-- A read model. It authorizes nothing: every mutation still runs the full authority / last-owner / release-gate
-- checks inside its own RPC, which remain the enforcement point. The can_* columns are ADVISORY (a wrong value can
-- only show or hide a button, never grant or deny anything); tests pin them to the RPCs' real outcomes.
--
-- SECURITY REVIEW (dedicated, because it is a SECURITY DEFINER function that reads auth.users)
--  1. Gate: staff.manage in the ASKED tenant via private.has_permission, i.e. the caller's own ACTIVE membership
--     and live role. A non-member and a member without staff.manage get the same error, so a tenant id cannot be
--     probed. This is the same single gate as list_team_invitations, and the Team page itself.
--  2. Tenant predicate: every row comes from tenant_memberships where tenant_id = p_tenant_id; the e-mail is read
--     only for those membership rows' own user ids. No parameter other than the tenant id exists.
--  3. Disclosure: the e-mail of a TEAM MEMBER, to a person who holds staff.manage in that same tenant and
--     therefore already manages these accounts (and already sees the e-mail of every pending invitation through
--     list_team_invitations). Never returned: the auth user id, the phone, password data, provider metadata,
--     anything of a removed (soft-deleted) membership.
--  4. search_path is empty and every object is schema-qualified; the function is STABLE and writes nothing.
--  5. Grants: executable by authenticated only (revoked from PUBLIC and anon); the private function is not
--     executable by any client role.
--
-- ROLLBACK: drop function public.list_team_members(uuid); drop function private.list_team_members(uuid);

create or replace function private.list_team_members(p_tenant_id uuid)
returns table (
  membership_id uuid,
  display_name text,
  email text,
  role_id uuid,
  role_name text,
  status text,
  is_self boolean,
  linked_staff_name text,
  is_last_unrestricted_holder boolean,
  can_suspend boolean,
  can_reactivate boolean,
  can_remove boolean
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

  -- Same single gate as list_team_invitations: a non-member and a member without staff.manage get the same
  -- answer, so a tenant id cannot be probed.
  if not private.has_permission(p_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  return query
  with unrestricted_holders as (
    -- The exact population the last-unrestricted-holder invariant counts: ACTIVE, not removed, live role carrying
    -- permissions.manage_unrestricted.
    select tm.id
    from public.tenant_memberships tm
    join public.roles r on r.id = tm.role_id and r.tenant_id = tm.tenant_id and r.deleted_at is null
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id and p.key = 'permissions.manage_unrestricted'
    where tm.tenant_id = p_tenant_id
      and tm.status = 'active'
      and tm.deleted_at is null
  ),
  holder_count as (
    select count(*) as n from unrestricted_holders
  ),
  members as (
    select
      tm.id as membership_id,
      nullif(btrim(pr.full_name), '') as display_name,
      lower(u.email) as email,
      tm.role_id,
      r.name as role_name,
      tm.status,
      (tm.user_id = auth.uid()) as is_self,
      (
        select sm.full_name
        from public.staff_members sm
        where sm.tenant_id = tm.tenant_id
          and sm.tenant_membership_id = tm.id
          and sm.deleted_at is null
        limit 1
      ) as linked_staff_name,
      (
        tm.status = 'active'
        and exists (select 1 from unrestricted_holders h where h.id = tm.id)
        and (select n from holder_count) = 1
      ) as is_last_holder,
      tm.created_at
    from public.tenant_memberships tm
    join public.roles r on r.id = tm.role_id and r.tenant_id = tm.tenant_id
    left join public.profiles pr on pr.id = tm.user_id
    left join auth.users u on u.id = tm.user_id
    where tm.tenant_id = p_tenant_id
      and tm.deleted_at is null
      and tm.status in ('active', 'suspended')
  )
  select
    m.membership_id,
    m.display_name,
    m.email,
    m.role_id,
    m.role_name,
    m.status,
    m.is_self,
    m.linked_staff_name,
    m.is_last_holder,
    (m.status = 'active' and not m.is_last_holder
       and private.membership_authority_decision(p_tenant_id, m.membership_id, 'suspend') = 'ok'),
    (m.status = 'suspended'
       and private.membership_authority_decision(p_tenant_id, m.membership_id, 'reactivate') = 'ok'),
    (not (m.status = 'active' and m.is_last_holder)
       and private.membership_authority_decision(p_tenant_id, m.membership_id, 'remove') = 'ok')
  from members m
  order by m.created_at, m.membership_id;
end;
$function$;

create or replace function public.list_team_members(p_tenant_id uuid)
returns table (
  membership_id uuid,
  display_name text,
  email text,
  role_id uuid,
  role_name text,
  status text,
  is_self boolean,
  linked_staff_name text,
  is_last_unrestricted_holder boolean,
  can_suspend boolean,
  can_reactivate boolean,
  can_remove boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.list_team_members(p_tenant_id);
$$;

comment on function public.list_team_members(uuid) is
  'Faz SAAS.1A. staff.manage holders of the asked tenant only. Active and suspended members with display name, e-mail, role, status, a self flag, the linked staff NAME, a last-unrestricted-holder flag and ADVISORY can_suspend / can_reactivate / can_remove (the shared authority decision plus the last-holder rule; the mutation RPCs remain the enforcement point). Returns no auth user id, phone or secret.';

revoke execute on function private.list_team_members(uuid) from public;
revoke execute on function public.list_team_members(uuid) from public, anon;
grant execute on function public.list_team_members(uuid) to authenticated;
