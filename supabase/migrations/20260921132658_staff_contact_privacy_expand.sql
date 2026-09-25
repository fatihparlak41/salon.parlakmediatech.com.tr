-- Faz SAAS.1E.1 (part 8A of 8A+8B — EXPAND half) — staff contact/identity RPCs.
--
-- Replaces the original combined 20260921132701_staff_contact_privacy.sql, which
-- bundled these RPCs together with the column-level REVOKE that hides
-- staff_members.email/phone/tenant_membership_id/created_by and
-- staff_schedule_exceptions.reason from `authenticated`. That combined form never
-- reached PROD and is being split before release: the currently-deployed application
-- reads all of those columns directly (Personnel list/detail, staff schedules, the Team
-- page's linked-staff display, staff membership linking, the Dashboard's staff-link
-- lookup) — revoking them before the new application code is live would break those
-- screens for every real user in the gap between migration apply and Vercel deployment.
-- See the SAAS.1E.1 staged-release compatibility audit.
--
-- This half only ADDS the four new RPCs. It touches zero existing grant — applying it
-- alone is a no-op for the currently-deployed application, which never calls them.
--
-- The column-level REVOKE (8B) is a separate, later migration, applied only once the
-- new application (which calls these RPCs instead of reading the columns directly) is
-- confirmed serving all production traffic. 8A and 8B together are semantically
-- equivalent to the original combined migration.
--
--   get_staff_management_details(tenant, staff_ids?)
--       -> (staff_member_id, email, phone, tenant_membership_id)
--       requires staff.view OR staff.manage in the tenant.
--   get_staff_exception_reasons(tenant, staff_member)
--       -> (exception_id, reason)              same permission.
--   get_my_staff_link(tenant)
--       -> (staff_member_id, full_name) of the CALLER's own linked staff row;
--       no permission needed — it can only ever describe the caller.
--   get_staff_link_for_membership(tenant, membership)
--       -> (staff_member_id, full_name); free for the caller's own membership,
--       staff.view/staff.manage required for anyone else's.
--
-- All four are SECURITY DEFINER, tenant-bound and granted to authenticated only.

create or replace function private.get_staff_management_details(
  p_tenant_id uuid,
  p_staff_member_ids uuid[] default null
)
returns table(staff_member_id uuid, email text, phone text, tenant_membership_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (private.has_permission(p_tenant_id, 'staff.view') or private.has_permission(p_tenant_id, 'staff.manage')) then
    raise exception 'staff.view required';
  end if;

  if p_staff_member_ids is not null and cardinality(p_staff_member_ids) > 500 then
    raise exception 'too_many_staff_ids';
  end if;

  return query
  select sm.id, sm.email, sm.phone, sm.tenant_membership_id
  from public.staff_members sm
  where sm.tenant_id = p_tenant_id
    and sm.deleted_at is null
    and (p_staff_member_ids is null or sm.id = any (p_staff_member_ids));
end;
$$;

create or replace function public.get_staff_management_details(
  p_tenant_id uuid,
  p_staff_member_ids uuid[] default null
)
returns table(staff_member_id uuid, email text, phone text, tenant_membership_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.get_staff_management_details(p_tenant_id, p_staff_member_ids);
$$;

create or replace function private.get_staff_exception_reasons(
  p_tenant_id uuid,
  p_staff_member_id uuid
)
returns table(exception_id uuid, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (private.has_permission(p_tenant_id, 'staff.view') or private.has_permission(p_tenant_id, 'staff.manage')) then
    raise exception 'staff.view required';
  end if;

  return query
  select e.id, e.reason
  from public.staff_schedule_exceptions e
  where e.tenant_id = p_tenant_id
    and e.staff_member_id = p_staff_member_id
    and e.deleted_at is null
    and e.reason is not null;
end;
$$;

create or replace function public.get_staff_exception_reasons(
  p_tenant_id uuid,
  p_staff_member_id uuid
)
returns table(exception_id uuid, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.get_staff_exception_reasons(p_tenant_id, p_staff_member_id);
$$;

create or replace function private.get_my_staff_link(p_tenant_id uuid)
returns table(staff_member_id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  return query
  select sm.id, sm.full_name
  from public.tenant_memberships tm
  join public.staff_members sm
    on sm.tenant_membership_id = tm.id
   and sm.tenant_id = tm.tenant_id
  where tm.tenant_id = p_tenant_id
    and tm.user_id = auth.uid()
    and tm.status = 'active'
    and tm.deleted_at is null
    and sm.status = 'active'
    and sm.deleted_at is null;
end;
$$;

create or replace function public.get_my_staff_link(p_tenant_id uuid)
returns table(staff_member_id uuid, full_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.get_my_staff_link(p_tenant_id);
$$;

create or replace function private.get_staff_link_for_membership(
  p_tenant_id uuid,
  p_membership_id uuid
)
returns table(staff_member_id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_is_own boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select exists (
    select 1 from public.tenant_memberships tm
    where tm.id = p_membership_id
      and tm.tenant_id = p_tenant_id
      and tm.user_id = auth.uid()
  ) into v_is_own;

  if not v_is_own and not (private.has_permission(p_tenant_id, 'staff.view') or private.has_permission(p_tenant_id, 'staff.manage')) then
    raise exception 'staff.view required';
  end if;

  return query
  select sm.id, sm.full_name
  from public.staff_members sm
  where sm.tenant_id = p_tenant_id
    and sm.tenant_membership_id = p_membership_id
    and sm.status = 'active'
    and sm.deleted_at is null;
end;
$$;

create or replace function public.get_staff_link_for_membership(
  p_tenant_id uuid,
  p_membership_id uuid
)
returns table(staff_member_id uuid, full_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.get_staff_link_for_membership(p_tenant_id, p_membership_id);
$$;

revoke execute on function private.get_staff_link_for_membership(uuid, uuid) from public;
revoke execute on function public.get_staff_link_for_membership(uuid, uuid) from public;
grant execute on function public.get_staff_link_for_membership(uuid, uuid) to authenticated;

revoke execute on function private.get_staff_management_details(uuid, uuid[]) from public;
revoke execute on function public.get_staff_management_details(uuid, uuid[]) from public;
grant execute on function public.get_staff_management_details(uuid, uuid[]) to authenticated;

revoke execute on function private.get_staff_exception_reasons(uuid, uuid) from public;
revoke execute on function public.get_staff_exception_reasons(uuid, uuid) from public;
grant execute on function public.get_staff_exception_reasons(uuid, uuid) to authenticated;

revoke execute on function private.get_my_staff_link(uuid) from public;
revoke execute on function public.get_my_staff_link(uuid) from public;
grant execute on function public.get_my_staff_link(uuid) to authenticated;
