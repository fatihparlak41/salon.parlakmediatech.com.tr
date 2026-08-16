-- Faz 1.5: permission ceiling. A staff.manage holder must not be able to
-- grant a permission they don't hold themselves to another role/member —
-- that's a privilege escalation path. This adds the one explicit,
-- permission-keyed (never role-name-keyed) bypass: whoever holds
-- permissions.manage_unrestricted can grant anything. Seeded into
-- SALON_OWNER's template only, but any tenant can grant it to any role —
-- it's a normal catalog permission, not a hardcoded role check anywhere
-- in code (see private.caller_can_grant_permissions in 20260816090003).
insert into public.permissions (key, name, category, description) values
  (
    'permissions.manage_unrestricted',
    'Sınırsız izin yönetimi',
    'permissions',
    'Sahip olunmayan izinleri başka rol/üyeye atayabilme — normalde staff.manage sahibi yalnızca kendi sahip olduğu izinleri devredebilir.'
  )
on conflict (key) do update set
  name = excluded.name,
  category = excluded.category,
  description = excluded.description;

insert into public.role_template_permissions (role_template_id, permission_id)
select rt.id, p.id
from public.role_templates rt
cross join public.permissions p
where rt.key = 'SALON_OWNER'
  and p.key = 'permissions.manage_unrestricted'
on conflict do nothing;
