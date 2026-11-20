-- Faz SAAS.1C.2c-A2 (3/3) - enforcement triggers for the DIRECT table writes of the API roles.
--
-- RLS decides who may write; these triggers decide whether the tenant's commercial state allows it, exactly like the lifecycle and branch-limit
-- guards (a BEFORE row trigger). The trigger fires ONLY when the writer is an API role: every trigger carries
--   WHEN (current_user in ('authenticated', 'anon', 'service_role', 'booking_gateway'))
-- which PostgreSQL evaluates in the context of the writing statement. Inside a SECURITY DEFINER function current_user is the function owner (the
-- trigger does not even fire), so a write made by an RPC is never guarded twice (the RPC has its own hook, or is classified never-refused, for example
-- a security action that must work in every state), and operator sessions (migrations, backups, break-glass) are never touched. (The check cannot
-- live inside the trigger function: that function is SECURITY DEFINER too, and there current_user is always its owner.) There is no recursion (the
-- guard writes only to private tables that carry no such trigger). The hook-coverage check requires this WHEN clause on every guard trigger.
--
-- Registered direct operations that can be refused (recomputed from the registry, 19 on 10 tables):
--   INSERT  branches, services, staff_members (CATALOG_CREATE), customers (CUSTOMER_CREATE_IMPORT)
--   UPDATE  branches, services, staff_members, staff_schedules, staff_schedule_exceptions (CATALOG_EDIT), customers (CUSTOMER_EDIT), tenants (SETTINGS_EDIT, the 7 profile columns)
--   INSERT / DELETE  service_branches, staff_branches, staff_services, and INSERT staff_schedules / staff_schedule_exceptions (CATALOG_EDIT)
-- Not hooked, by classification: profiles UPDATE (a person's own profile: SECURITY_ACCOUNT_ACTION) and platform_admins INSERT / UPDATE (CONTROL_PLANE).
--
-- UPDATE is not one class: a plain edit follows the table's UPDATE category (an edit of something that exists, allowed in read_only), but an UPDATE that
-- brings a soft-deleted or inactive / archived branch, service, staff member or customer back (deleted_at set -> null, or status inactive|archived -> active) creates a new metered entity again and is guarded as the
-- INSERT of the same table. A direct UPDATE therefore cannot be used to get around the growth restriction. A row that moves to another tenant is
-- guarded for BOTH tenants. The relation tables (service_branches, staff_branches, staff_services) have no tenant column: the tenant is taken from the
-- parent row (service / staff member).
--
-- ROLLBACK: rollback-saas-1c-2c-a2.sql drops these triggers and the function.

create or replace function private.billing_trigger_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage smallint;
  v_key text;
  v_shape text := tg_argv[0];
  v_new jsonb;
  v_old jsonb;
  v_tenant uuid;
  v_tenant_old uuid;
begin
  select c.stage into v_stage from private.billing_enforcement_config c where c.id = 1;
  if v_stage is null or v_stage = 0 then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  v_key := 'table:' || tg_table_name || ':' || tg_op;
  v_new := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_old := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  if tg_op = 'UPDATE' and tg_table_name in ('branches', 'services', 'staff_members', 'customers')
     and (((v_old ->> 'deleted_at') is not null and (v_new ->> 'deleted_at') is null)
          or ((v_old ->> 'status') in ('inactive', 'archived') and (v_new ->> 'status') = 'active')) then
    v_key := 'table:' || tg_table_name || ':INSERT'; -- bringing a soft-deleted / inactive / archived entity back is growth
  end if;

  if v_shape = 'tenant_col' then
    v_tenant := (coalesce(v_new, v_old) ->> 'tenant_id')::uuid;
    v_tenant_old := (v_old ->> 'tenant_id')::uuid;
  elsif v_shape = 'tenants_id' then
    v_tenant := (coalesce(v_new, v_old) ->> 'id')::uuid;
  elsif v_shape = 'relation:services:service_id' then
    select s.tenant_id into v_tenant from public.services s where s.id = (coalesce(v_new, v_old) ->> 'service_id')::uuid;
  elsif v_shape = 'relation:staff_members:staff_member_id' then
    select s.tenant_id into v_tenant from public.staff_members s where s.id = (coalesce(v_new, v_old) ->> 'staff_member_id')::uuid;
  end if;

  perform private.billing_guard(v_key, 'row', v_tenant);
  if tg_op = 'UPDATE' and v_tenant_old is not null and v_tenant_old is distinct from v_tenant then
    perform private.billing_guard(v_key, 'row', v_tenant_old); -- a tenant reassignment is guarded for the tenant the row leaves as well
  end if;
  return case tg_op when 'DELETE' then old else new end;
end;
$$;
revoke all on function private.billing_trigger_guard() from public, anon, authenticated, service_role;

do $a2$
declare
  r record;
  v_created integer := 0;
begin
  for r in select split_part(g.action_key, ':', 2) as tbl, min(g.scope) as shape,
                  string_agg(split_part(g.action_key, ':', 3), ' or ' order by split_part(g.action_key, ':', 3)) as ops
             from private.billing_action_registry g where g.kind = 'table_op' and g.hooked
            group by split_part(g.action_key, ':', 2) order by 1 loop
    if (select count(distinct g.scope) from private.billing_action_registry g where g.kind = 'table_op' and g.hooked and split_part(g.action_key, ':', 2) = r.tbl) <> 1 then
      raise exception 'A2 trigger: % has more than one tenant shape', r.tbl;
    end if;
    execute format('create trigger billing_a2_guard before %s on public.%I for each row when (current_user in (''authenticated'', ''anon'', ''service_role'', ''booking_gateway'')) execute function private.billing_trigger_guard(%L)', r.ops, r.tbl, r.shape);
    v_created := v_created + 1;
  end loop;
  if v_created <> 10 then
    raise exception 'A2 trigger: expected 10 guarded tables, created %', v_created;
  end if;
  if exists (select 1 from private.billing_hook_coverage()) then
    raise exception 'A2 trigger: hook coverage is not complete after the triggers';
  end if;
end
$a2$;
