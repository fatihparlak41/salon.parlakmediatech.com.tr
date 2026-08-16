-- Faz 1.5: the only paths that create a role, change a role's permission
-- set, or reassign a member's role. Each enforces: the caller may only
-- grant permissions they hold themselves, unless they hold
-- permissions.manage_unrestricted (20260816090001) — never a role-name
-- check. See supabase/migrations/README.md "Lessons" for why these are
-- RPCs and not direct-table RLS policies (bulk permission-set checks don't
-- express cleanly in a single WITH CHECK boolean, and grants for these
-- columns were removed in 20260816090002 specifically so this is the only
-- path).

create or replace function private.caller_can_grant_permissions(
  p_tenant_id uuid,
  p_permission_keys text[]
)
returns boolean
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_missing_count integer;
begin
  if private.has_permission(p_tenant_id, 'permissions.manage_unrestricted') then
    return true;
  end if;

  select count(*) into v_missing_count
  from unnest(coalesce(p_permission_keys, array[]::text[])) as requested_key
  where not private.has_permission(p_tenant_id, requested_key);

  return v_missing_count = 0;
end;
$$;

comment on function private.caller_can_grant_permissions(uuid, text[]) is
  'True iff every key in p_permission_keys is already held by the caller on p_tenant_id, or the caller holds permissions.manage_unrestricted. The one deliberate ceiling bypass, gated by a permission key — never a role name.';

create or replace function private.create_role(
  p_tenant_id uuid,
  p_name text,
  p_description text,
  p_permission_keys text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role_id uuid;
begin
  if not private.has_permission(p_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  if not private.caller_can_grant_permissions(p_tenant_id, p_permission_keys) then
    raise exception 'cannot grant a permission you do not hold';
  end if;

  insert into public.roles (tenant_id, name, description, is_system_default)
  values (p_tenant_id, p_name, p_description, false)
  returning id into v_role_id;

  insert into public.role_permissions (role_id, permission_id)
  select v_role_id, p.id
  from public.permissions p
  where p.key = any (coalesce(p_permission_keys, array[]::text[]));

  perform private.log_audit_event(
    p_tenant_id, 'role.created', 'role', v_role_id,
    null, jsonb_build_object('name', p_name, 'permissions', p_permission_keys)
  );

  return v_role_id;
end;
$$;

create or replace function private.update_role_permissions(
  p_role_id uuid,
  p_permission_keys text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_before jsonb;
begin
  select tenant_id into v_tenant_id
  from public.roles
  where id = p_role_id and deleted_at is null;

  if v_tenant_id is null then
    raise exception 'role not found';
  end if;

  if not private.has_permission(v_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  if not private.caller_can_grant_permissions(v_tenant_id, p_permission_keys) then
    raise exception 'cannot grant a permission you do not hold';
  end if;

  select coalesce(jsonb_agg(p.key), '[]'::jsonb) into v_before
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = p_role_id;

  delete from public.role_permissions where role_id = p_role_id;

  insert into public.role_permissions (role_id, permission_id)
  select p_role_id, p.id
  from public.permissions p
  where p.key = any (coalesce(p_permission_keys, array[]::text[]));

  perform private.log_audit_event(
    v_tenant_id, 'role.permissions_updated', 'role', p_role_id,
    jsonb_build_object('permissions', v_before),
    jsonb_build_object('permissions', p_permission_keys)
  );
end;
$$;

create or replace function private.update_membership_role(
  p_membership_id uuid,
  p_new_role_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_member_user_id uuid;
  v_old_role_id uuid;
  v_new_role_tenant_id uuid;
  v_target_permission_keys text[];
begin
  select tenant_id, user_id, role_id
    into v_tenant_id, v_member_user_id, v_old_role_id
  from public.tenant_memberships
  where id = p_membership_id and deleted_at is null;

  if v_tenant_id is null then
    raise exception 'membership not found';
  end if;

  if not private.has_permission(v_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  -- Same guard as the (now grant-revoked) direct-update policy had: a
  -- staff.manage holder may change anyone's role except their own.
  if v_member_user_id = auth.uid() then
    raise exception 'cannot change your own role';
  end if;

  select tenant_id into v_new_role_tenant_id
  from public.roles
  where id = p_new_role_id and deleted_at is null;

  if v_new_role_tenant_id is null or v_new_role_tenant_id <> v_tenant_id then
    raise exception 'role not found in this tenant';
  end if;

  -- Checked against the target role's FULL permission set, not a delta
  -- from the member's old role — otherwise someone could route around the
  -- ceiling by assigning a member to an already-overpowered existing role
  -- instead of editing role_permissions directly.
  select array_agg(p.key) into v_target_permission_keys
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = p_new_role_id;

  if not private.caller_can_grant_permissions(v_tenant_id, coalesce(v_target_permission_keys, array[]::text[])) then
    raise exception 'cannot assign a role with permissions you do not hold';
  end if;

  update public.tenant_memberships
  set role_id = p_new_role_id
  where id = p_membership_id;

  perform private.log_audit_event(
    v_tenant_id, 'membership.role_changed', 'tenant_membership', p_membership_id,
    jsonb_build_object('role_id', v_old_role_id),
    jsonb_build_object('role_id', p_new_role_id)
  );
end;
$$;

revoke execute on function private.caller_can_grant_permissions(uuid, text[]) from public;
revoke execute on function private.create_role(uuid, text, text, text[]) from public;
revoke execute on function private.update_role_permissions(uuid, text[]) from public;
revoke execute on function private.update_membership_role(uuid, uuid) from public;

-- private.* stays unreachable via RPC (not in the exposed API schema
-- list) — these public wrappers are the only client-callable surface,
-- same pattern as 20260815120019.
create or replace function public.create_role(
  p_tenant_id uuid,
  p_name text,
  p_description text,
  p_permission_keys text[]
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.create_role(p_tenant_id, p_name, p_description, p_permission_keys);
$$;

create or replace function public.update_role_permissions(
  p_role_id uuid,
  p_permission_keys text[]
)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.update_role_permissions(p_role_id, p_permission_keys);
$$;

create or replace function public.update_membership_role(
  p_membership_id uuid,
  p_new_role_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.update_membership_role(p_membership_id, p_new_role_id);
$$;

revoke execute on function public.create_role(uuid, text, text, text[]) from public;
revoke execute on function public.update_role_permissions(uuid, text[]) from public;
revoke execute on function public.update_membership_role(uuid, uuid) from public;

grant execute on function public.create_role(uuid, text, text, text[]) to authenticated;
grant execute on function public.update_role_permissions(uuid, text[]) to authenticated;
grant execute on function public.update_membership_role(uuid, uuid) to authenticated;
