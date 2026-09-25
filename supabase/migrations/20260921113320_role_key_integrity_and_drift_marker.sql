-- Faz SAAS.1E.1 (part 2) — role key integrity and the durable drift marker.
--
-- =====================================================================
-- WHY THIS EXISTS
-- =====================================================================
--
-- 1. IDENTITY BY KEY. Provisioning must be able to say "this tenant has its
--    SALON_MANAGER role" without ever comparing display names — a salon may
--    legitimately own a custom role called "Yönetici". roles.key was a free,
--    nullable text with no uniqueness at all, so nothing stopped two live
--    roles with the same key in one tenant. A partial unique index makes the
--    key a real identity: at most ONE live role per (tenant, key). Soft-
--    deleted rows are excluded (exactly like the existing live-only name
--    index), which is what lets provisioning create a fresh role for a key
--    whose earlier role was deleted.
--
-- 2. SYSTEM-DEFAULT SEMANTICS. is_system_default = true means "provisioned
--    from a role template": it MUST carry a stable key. A CHECK enforces
--    that. Custom roles (is_system_default = false) may have any key or none.
--
-- 3. THE DRIFT MARKER. A system-default role is either
--      pristine    (customized_at IS NULL) — nobody has edited its permission
--                  set; the template is its definition, so a template change
--                  may be propagated to it; or
--      customized  (customized_at IS NOT NULL) — an authorized owner edited it
--                  on purpose; template syncs must NEVER touch it again, and
--                  any difference from the template is only REPORTED.
--    The marker is set by update_role_permissions (part 3) when a system-
--    default role's permission set actually changes, and it is never cleared
--    automatically. The audit trail alone is not a sufficient marker:
--    audit_logs is a log, not a state column (it is not indexed by entity for
--    this purpose, can be pruned by an operator, and every drift check would
--    have to scan it) — but it IS sufficient EVIDENCE to backfill the marker
--    for roles that existed before this column did (part 6 does exactly
--    that, from role.permissions_updated rows).
--    A customized_at on a non-system role is meaningless, so a CHECK forbids
--    it.
--
-- No data changes here: no role, membership or permission row is touched.
-- Existing rows already satisfy both CHECKs and the unique index (PROD has
-- exactly one live SALON_OWNER role per tenant).

alter table public.roles
  add column if not exists customized_at timestamptz;

comment on column public.roles.is_system_default is
  'true = provisioned from a role template (stable key, translated display name, not editable below unrestricted authority, never deleted casually). Custom roles are false.';
comment on column public.roles.customized_at is
  'Durable drift marker for a system-default role: NULL = pristine (the role template defines it and template syncs may update it); NOT NULL = an authorized owner edited its permission set on purpose (template syncs never touch it; differences are only reported). Set by update_role_permissions, never cleared automatically.';

create unique index if not exists roles_tenant_key_live_uidx
  on public.roles (tenant_id, key)
  where key is not null and deleted_at is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.roles'::regclass and conname = 'roles_system_default_requires_key') then
    alter table public.roles
      add constraint roles_system_default_requires_key
      check (not is_system_default or key is not null);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.roles'::regclass and conname = 'roles_customized_requires_system_default') then
    alter table public.roles
      add constraint roles_customized_requires_system_default
      check (customized_at is null or is_system_default);
  end if;
end;
$$;
