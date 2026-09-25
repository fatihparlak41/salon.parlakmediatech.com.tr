import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  allPermissionKeys,
  asAuthenticatedUser,
  attemptAs,
  cleanupTenants,
  cleanupUsers,
  createCustomRole,
  createTestTenant,
  createTestUser,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";
import {
  DEFAULT_ROLE_KEYS as DEFAULT_KEYS,
  DEFAULT_ROLE_NAMES as NAMES,
  MANAGER_KEYS,
  PERSONEL_KEYS,
  RECEPTION_KEYS,
} from "./default-role-matrix";

/**
 * Faz SAAS.1E.1 — deterministic default-role provisioning and the LOCKED
 * four-role permission matrix (migrations 20260921113315 … 20260921113340).
 *
 * The expected sets (tests/default-role-matrix.ts) are written out by hand from
 * the product decision, NOT read back from role_templates: the point is to
 * catch the templates (or the provisioning that copies them) drifting away
 * from what was decided.
 *
 * Calls run through asAuthenticatedUser (role `authenticated` + JWT claims in
 * one transaction — what a PostgREST request sees) so RLS, the RPC wrappers
 * and the deferred last-holder triggers behave exactly as in production.
 */

const sorted = (keys: readonly string[]) => [...keys].sort();

let allKeys: string[];
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`drp-${label}`);
  createdUserIds.push(user.id);
  return user;
}

type RoleRow = {
  id: string;
  key: string | null;
  name: string;
  is_system_default: boolean;
  cloned_from_template_id: string | null;
  customized_at: string | null;
  deleted_at: string | null;
};

async function rolesOf(tenantId: string, includeDeleted = false): Promise<RoleRow[]> {
  return await testDb<RoleRow[]>`
    select id, key, name, is_system_default, cloned_from_template_id, customized_at::text as customized_at, deleted_at::text as deleted_at
    from roles where tenant_id = ${tenantId} ${includeDeleted ? testDb`` : testDb`and deleted_at is null`}
    order by key nulls last, name`;
}

async function keysOf(roleId: string): Promise<string[]> {
  return (
    await testDb<{ key: string }[]>`
      select p.key from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = ${roleId} order by p.key`
  ).map((r) => r.key);
}

async function roleByKey(tenantId: string, key: string): Promise<RoleRow> {
  const row = (await rolesOf(tenantId)).find((r) => r.key === key);
  if (!row) throw new Error(`no live role ${key} in tenant ${tenantId}`);
  return row;
}

async function provision(tenantId: string) {
  return await testDb<{ provisioned_role_id: string; provisioned_role_key: string; outcome: string }[]>`
    select * from private.provision_default_roles(${tenantId}::uuid)`;
}

/** Every permission key the user effectively holds in the tenant (private.has_permission with their JWT claims). */
async function heldKeys(userId: string, tenantId: string): Promise<string[]> {
  return await testDb.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true),
                     set_config('request.jwt.claim.sub', ${userId}, true)`;
    const rows = await sql<{ key: string }[]>`
      select k as key from unnest(${sql.array(allKeys, 1009)}::text[]) as k
      where private.has_permission(${tenantId}::uuid, k) order by k`;
    return rows.map((r) => r.key);
  });
}

const auditCount = async (tenantId: string, action: string) =>
  (await testDb<{ n: number }[]>`select count(*)::int as n from audit_logs where tenant_id = ${tenantId} and action = ${action}`)[0]!.n;

beforeAll(async () => {
  allKeys = await allPermissionKeys();
  expect(allKeys).toHaveLength(23);
}, 60000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 120000);

// ---------------------------------------------------------------------------
// New tenants
// ---------------------------------------------------------------------------

describe("a NEW tenant is born with exactly the four primary roles", () => {
  let creator: TestUser;
  let tenantId: string;

  beforeAll(async () => {
    creator = await newUser("creator");
    const slug = `drp-new-${randomUUID().slice(0, 8)}`;
    tenantId = await asAuthenticatedUser(creator.id, async (sql) => {
      const [row] = await sql<{ id: string }[]>`select public.create_tenant(${"DRP Test Salon"}, ${slug}) as id`;
      return row!.id;
    });
    createdTenantIds.push(tenantId);
  }, 60000);

  it("has exactly 4 live roles — one per primary key, no duplicates, all system-default and pristine", async () => {
    const roles = await rolesOf(tenantId, true);
    expect(roles.map((r) => r.key).sort()).toEqual(DEFAULT_KEYS);
    for (const r of roles) {
      expect(r.name, r.key ?? "").toBe(NAMES[r.key!]);
      expect(r.is_system_default, r.key ?? "").toBe(true);
      expect(r.cloned_from_template_id, r.key ?? "").not.toBeNull();
      expect(r.customized_at, r.key ?? "").toBeNull();
      expect(r.deleted_at, r.key ?? "").toBeNull();
    }
    const [dup] = await testDb<{ n: number }[]>`
      select count(*)::int as n from (select key from roles where tenant_id = ${tenantId} group by key having count(*) > 1) d`;
    expect(dup!.n).toBe(0);
  });

  it("gives the creator exactly one membership, active, on the SALON_OWNER role — and they are the unrestricted holder", async () => {
    const memberships = await testDb<{ id: string; user_id: string; role_id: string; status: string }[]>`
      select id, user_id, role_id, status from tenant_memberships where tenant_id = ${tenantId}`;
    expect(memberships).toHaveLength(1);
    const owner = await roleByKey(tenantId, "SALON_OWNER");
    expect(memberships[0]).toMatchObject({ user_id: creator.id, role_id: owner.id, status: "active" });
    const [holder] = await testDb<{ ok: boolean }[]>`select private.tenant_has_active_unrestricted_holder(${tenantId}::uuid) as ok`;
    expect(holder!.ok).toBe(true);
  });

  it("gives each role exactly its locked permission set", async () => {
    expect(await keysOf((await roleByKey(tenantId, "SALON_OWNER")).id)).toEqual(sorted(allKeys));
    expect(await keysOf((await roleByKey(tenantId, "SALON_MANAGER")).id)).toEqual(sorted(MANAGER_KEYS));
    expect(await keysOf((await roleByKey(tenantId, "RECEPTIONIST")).id)).toEqual(sorted(RECEPTION_KEYS));
    expect(await keysOf((await roleByKey(tenantId, "STYLIST")).id)).toEqual(sorted(PERSONEL_KEYS));
  });

  it("audits the tenant once and each provisioned role once (actor = the creator)", async () => {
    expect(await auditCount(tenantId, "tenant.created")).toBe(1);
    expect(await auditCount(tenantId, "role.provisioned")).toBe(4);
    const rows = await testDb<{ actor_user_id: string | null; actor_type: string }[]>`
      select actor_user_id, actor_type from audit_logs where tenant_id = ${tenantId} and action = 'role.provisioned'`;
    for (const r of rows) expect(r).toMatchObject({ actor_user_id: creator.id, actor_type: "user" });
  });

  it("the creator, as Salon Sahibi, holds every permission; the other three roles never hold the unrestricted key", async () => {
    expect(await heldKeys(creator.id, tenantId)).toEqual(sorted(allKeys));
    for (const key of ["SALON_MANAGER", "RECEPTIONIST", "STYLIST"]) {
      expect(await keysOf((await roleByKey(tenantId, key)).id), key).not.toContain("permissions.manage_unrestricted");
    }
  });

  it("the tenant-creation transaction still fails cleanly on a bad slug and leaves nothing behind", async () => {
    const before = await testDb<{ n: number }[]>`select count(*)::int as n from roles`;
    const outcome = await attemptAs(creator.id, (sql) => sql`select public.create_tenant(${"Bad Slug"}, ${"Not A Valid Slug!"})`);
    expect(outcome).toMatchObject({ ok: false, message: "invalid slug format" });
    const after = await testDb<{ n: number }[]>`select count(*)::int as n from roles`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

// ---------------------------------------------------------------------------
// The matrix, as effective permissions of real members
// ---------------------------------------------------------------------------

describe("the locked matrix, as the members of each role actually experience it", () => {
  let tenant: TestTenant;
  const users: Record<string, TestUser> = {};

  beforeAll(async () => {
    users.owner = await newUser("m-owner");
    tenant = await createTestTenant("test-tenant-drp-matrix", users.owner.id);
    createdTenantIds.push(tenant.id);
    await provision(tenant.id);
    for (const [label, key] of [["manager", "SALON_MANAGER"], ["reception", "RECEPTIONIST"], ["personel", "STYLIST"]] as const) {
      users[label] = await newUser(`m-${label}`);
      await addMembership(tenant.id, users[label]!.id, (await roleByKey(tenant.id, key)).id);
    }
  }, 90000);

  it("Owner: all 23 keys, including permissions.manage_unrestricted", async () => {
    expect(await heldKeys(users.owner!.id, tenant.id)).toEqual(sorted(allKeys));
    expect(await heldKeys(users.owner!.id, tenant.id)).toContain("permissions.manage_unrestricted");
  });

  it("Manager: exactly the 16 operational keys — no unrestricted, no finance, no inventory, no financial reports, no settings", async () => {
    const held = await heldKeys(users.manager!.id, tenant.id);
    expect(held).toEqual(sorted(MANAGER_KEYS));
    expect(held).toHaveLength(16);
    for (const forbidden of ["permissions.manage_unrestricted", "finance.view", "finance.manage", "inventory.view", "inventory.manage", "reports.financial", "settings.manage"]) {
      expect(held, forbidden).not.toContain(forbidden);
    }
  });

  it("Receptionist: exactly the 9 keys — and NOT customers.link_account, staff.manage, settings, reports, finance, inventory", async () => {
    const held = await heldKeys(users.reception!.id, tenant.id);
    expect(held).toEqual(sorted(RECEPTION_KEYS));
    expect(held).toHaveLength(9);
    for (const forbidden of [
      "customers.link_account", "staff.manage", "staff.view", "settings.manage", "permissions.manage_unrestricted",
      "reports.basic", "reports.staff", "reports.financial", "finance.view", "finance.manage", "inventory.view", "inventory.manage",
      "schedules.manage", "services.manage",
    ]) {
      expect(held, forbidden).not.toContain(forbidden);
    }
  });

  it("Personel: appointments.view and NOTHING else (no create/update/cancel, no customers.view)", async () => {
    const held = await heldKeys(users.personel!.id, tenant.id);
    expect(held).toEqual(["appointments.view"]);
    for (const forbidden of ["appointments.create", "appointments.update", "appointments.cancel", "customers.view", "customers.create", "customers.update", "staff.view", "staff.manage", "schedules.view", "services.view"]) {
      expect(held, forbidden).not.toContain(forbidden);
    }
  });

  it("the templates future tenants are cloned from hold exactly the same sets (and only these four are provisioned by default)", async () => {
    const rows = await testDb<{ key: string; provision: boolean; keys: string[] }[]>`
      select rt.key, rt.provision_by_default as provision, private.template_permission_keys(rt.id) as keys
      from role_templates rt order by rt.key`;
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("SALON_OWNER")!.keys).toEqual(sorted(allKeys));
    expect(byKey.get("SALON_MANAGER")!.keys).toEqual(sorted(MANAGER_KEYS));
    expect(byKey.get("RECEPTIONIST")!.keys).toEqual(sorted(RECEPTION_KEYS));
    expect(byKey.get("STYLIST")!.keys).toEqual(sorted(PERSONEL_KEYS));
    expect(rows.filter((r) => r.provision).map((r) => r.key).sort()).toEqual(DEFAULT_KEYS);
    // The optional templates stay available and untouched.
    for (const optional of ["CASHIER", "STOCK_MANAGER", "ACCOUNTANT"]) {
      expect(byKey.has(optional), optional).toBe(true);
      expect(byKey.get(optional)!.provision, optional).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency and key integrity
// ---------------------------------------------------------------------------

describe("provisioning is idempotent and the role KEY is a real identity", () => {
  let tenant: TestTenant;
  let owner: TestUser;

  beforeAll(async () => {
    owner = await newUser("idem-owner");
    tenant = await createTestTenant("test-tenant-drp-idem", owner.id);
    createdTenantIds.push(tenant.id);
  }, 60000);

  it("the first call creates the three missing roles and reports the existing owner role; the second creates nothing", async () => {
    const first = await provision(tenant.id);
    expect(first.map((r) => `${r.provisioned_role_key}:${r.outcome}`).sort()).toEqual([
      "RECEPTIONIST:created", "SALON_MANAGER:created", "SALON_OWNER:exists", "STYLIST:created",
    ]);
    const idsAfterFirst = (await rolesOf(tenant.id)).map((r) => r.id).sort();
    const auditAfterFirst = await auditCount(tenant.id, "role.provisioned");
    expect(auditAfterFirst).toBe(3);

    const second = await provision(tenant.id);
    expect(second.every((r) => r.outcome === "exists")).toBe(true);
    expect(second).toHaveLength(4);
    expect((await rolesOf(tenant.id)).map((r) => r.id).sort()).toEqual(idsAfterFirst);
    expect(await auditCount(tenant.id, "role.provisioned")).toBe(auditAfterFirst); // no audit for a no-op
  }, 60000);

  it("a second live role with an existing key is refused by the database; another tenant may reuse the key; a deleted role does not block", async () => {
    const [template] = await testDb<{ id: string }[]>`select id from role_templates where key = 'RECEPTIONIST'`;
    await expect(
      testDb`insert into roles (tenant_id, key, name, is_system_default, cloned_from_template_id)
             values (${tenant.id}, 'RECEPTIONIST', ${"Kopya Resepsiyon"}, true, ${template!.id})`,
    ).rejects.toMatchObject({ code: "23505", constraint_name: "roles_tenant_key_live_uidx" });

    // The same key in a DIFFERENT tenant is fine (the index is per tenant).
    const otherOwner = await newUser("idem-other-owner");
    const other = await createTestTenant("test-tenant-drp-idem-other", otherOwner.id);
    createdTenantIds.push(other.id);
    await provision(other.id);
    expect((await roleByKey(other.id, "RECEPTIONIST")).id).not.toBe((await roleByKey(tenant.id, "RECEPTIONIST")).id);

    // A soft-deleted role keeps its key but no longer blocks a live one.
    const custom = await createCustomRole(tenant.id, "Geçici", ["appointments.view"], { key: "TEMP_KEY" });
    await testDb`update roles set deleted_at = now() where id = ${custom}`;
    const replacement = await createCustomRole(tenant.id, "Geçici Yeni", ["appointments.view"], { key: "TEMP_KEY" });
    expect(replacement).not.toBe(custom);
  }, 60000);

  it("the CHECK constraints hold: a system-default role needs a key; a custom role cannot be 'customized'", async () => {
    await expect(
      testDb`insert into roles (tenant_id, name, is_system_default) values (${tenant.id}, ${"Anahtarsız Sistem Rolü"}, true)`,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "roles_system_default_requires_key" });
    await expect(
      testDb`insert into roles (tenant_id, name, is_system_default, customized_at) values (${tenant.id}, ${"Özel Ama İşaretli"}, false, now())`,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "roles_customized_requires_system_default" });
  });

  it("provisioning refuses an unknown tenant and never touches another tenant's roles", async () => {
    await expect(provision(randomUUID())).rejects.toMatchObject({ message: "tenant_not_found" });

    const lonelyOwner = await newUser("iso-owner");
    const lonely = await createTestTenant("test-tenant-drp-iso", lonelyOwner.id);
    createdTenantIds.push(lonely.id);
    const before = (await rolesOf(lonely.id)).map((r) => r.id);
    await provision(tenant.id); // provisioning a DIFFERENT tenant
    expect((await rolesOf(lonely.id)).map((r) => r.id)).toEqual(before);
    expect(before).toHaveLength(1); // still only its Owner role
  }, 60000);

  it("two concurrent provisioning calls for one tenant create each missing role exactly once (per-tenant lock + live-key index)", async () => {
    const raceOwner = await newUser("race-owner");
    const race = await createTestTenant(`test-tenant-drp-race-${randomUUID().slice(0, 6)}`, raceOwner.id);
    createdTenantIds.push(race.id);

    const [a, b] = await Promise.all([provision(race.id), provision(race.id)]);

    // Whichever call got the lock first created the three; the other saw them and reported 'exists'.
    const created = [...a, ...b].filter((r) => r.outcome === "created").map((r) => r.provisioned_role_key).sort();
    expect(created).toEqual(["RECEPTIONIST", "SALON_MANAGER", "STYLIST"]);
    for (const result of [a, b]) expect(result).toHaveLength(4);

    expect((await rolesOf(race.id)).map((r) => r.key).sort()).toEqual([...DEFAULT_KEYS]);
    expect(await auditCount(race.id, "role.provisioned")).toBe(3);
    const [dup] = await testDb<{ n: number }[]>`
      select count(*)::int as n from (select key from roles where tenant_id = ${race.id} group by key having count(*) > 1) d`;
    expect(dup!.n).toBe(0);
  }, 60000);

  it("the provisioning functions are not callable by any client role", async () => {
    const rows = await testDb<{ fn: string; anon: boolean; authenticated: boolean; service_role: boolean; public_grant: boolean }[]>`
      select p.proname as fn,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_grant
      from pg_proc p
      where p.pronamespace = 'private'::regnamespace
        and p.proname in ('provision_default_roles', 'sync_pristine_default_roles', 'role_template_drift', 'template_permission_keys')`;
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.anon, r.fn).toBe(false);
      expect(r.authenticated, r.fn).toBe(false);
      expect(r.service_role, r.fn).toBe(false);
      expect(r.public_grant, r.fn).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Display names never decide identity
// ---------------------------------------------------------------------------

describe("a display-name collision does not determine identity", () => {
  it("owner-created roles named like the standard ones are left completely alone; the standard roles get a deterministic suffix", async () => {
    const owner = await newUser("coll-owner");
    const tenant = await createTestTenant("test-tenant-drp-coll", owner.id);
    createdTenantIds.push(tenant.id);

    const customManager = await createCustomRole(tenant.id, "Yönetici", ["appointments.view", "staff.view"]);
    const customPersonel = await createCustomRole(tenant.id, "Personel", ["appointments.view", "customers.view", "schedules.view"]);
    const customSuffix = await createCustomRole(tenant.id, "Resepsiyon", ["appointments.view"]);
    const customSuffix2 = await createCustomRole(tenant.id, "Resepsiyon (varsayılan)", ["appointments.view"]);
    const before = new Map<string, string[]>();
    for (const id of [customManager, customPersonel, customSuffix, customSuffix2]) before.set(id, await keysOf(id));

    const result = await provision(tenant.id);
    expect(result.map((r) => `${r.provisioned_role_key}:${r.outcome}`).sort()).toEqual([
      "RECEPTIONIST:created", "SALON_MANAGER:created", "SALON_OWNER:exists", "STYLIST:created",
    ]);

    const live = await rolesOf(tenant.id);
    const byKey = new Map(live.filter((r) => r.key).map((r) => [r.key!, r]));
    expect(byKey.get("SALON_MANAGER")!.name).toBe("Yönetici (varsayılan)");
    expect(byKey.get("STYLIST")!.name).toBe("Personel (varsayılan)");
    expect(byKey.get("RECEPTIONIST")!.name).toBe("Resepsiyon (varsayılan 3)"); // "Resepsiyon" and "… (varsayılan)" are both taken
    // Identity is still the key: the standard roles hold exactly their matrix.
    expect(await keysOf(byKey.get("SALON_MANAGER")!.id)).toEqual(sorted(MANAGER_KEYS));
    expect(await keysOf(byKey.get("STYLIST")!.id)).toEqual(sorted(PERSONEL_KEYS));

    // The four owner-created roles are byte-for-byte what they were.
    for (const id of [customManager, customPersonel, customSuffix, customSuffix2]) {
      const row = live.find((r) => r.id === id)!;
      expect(row.key, id).toBeNull();
      expect(row.is_system_default, id).toBe(false);
      expect(row.customized_at, id).toBeNull();
      expect(await keysOf(id), id).toEqual(before.get(id));
    }
    expect(live.find((r) => r.id === customManager)!.name).toBe("Yönetici");
    expect(live.find((r) => r.id === customPersonel)!.name).toBe("Personel");
  }, 90000);

  it("a live role that already carries a standard KEY is never replaced or modified, whatever it is called or holds", async () => {
    const owner = await newUser("keyed-owner");
    const tenant = await createTestTenant("test-tenant-drp-keyed", owner.id);
    createdTenantIds.push(tenant.id);
    // A custom (non-system) role squatting on the STYLIST key with a wide permission set.
    const squatter = await createCustomRole(tenant.id, "Kuaför Özel", ["appointments.view", "appointments.update", "customers.view"], { key: "STYLIST" });

    const result = await provision(tenant.id);
    expect(result.find((r) => r.provisioned_role_key === "STYLIST")).toMatchObject({ provisioned_role_id: squatter, outcome: "exists" });
    expect(await keysOf(squatter)).toEqual(sorted(["appointments.view", "appointments.update", "customers.view"]));
    expect((await rolesOf(tenant.id)).filter((r) => r.key === "STYLIST")).toHaveLength(1);
  }, 60000);
});

// ---------------------------------------------------------------------------
// Soft-deleted standard roles
// ---------------------------------------------------------------------------

describe("a soft-deleted standard role is RECREATED, never silently restored", () => {
  it("creates a new role for the key, leaves the deleted one deleted, and leaves its members without permissions", async () => {
    const owner = await newUser("del-owner");
    const member = await newUser("del-member");
    const tenant = await createTestTenant("test-tenant-drp-del", owner.id);
    createdTenantIds.push(tenant.id);
    await provision(tenant.id);

    const oldManager = await roleByKey(tenant.id, "SALON_MANAGER");
    const membershipId = await addMembership(tenant.id, member.id, oldManager.id);
    expect(await heldKeys(member.id, tenant.id)).toEqual(sorted(MANAGER_KEYS));

    await testDb`update roles set deleted_at = now() where id = ${oldManager.id}`;
    expect(await heldKeys(member.id, tenant.id)).toEqual([]); // a deleted role grants nothing

    const result = await provision(tenant.id);
    expect(result.find((r) => r.provisioned_role_key === "SALON_MANAGER")!.outcome).toBe("created");
    const newManager = await roleByKey(tenant.id, "SALON_MANAGER");
    expect(newManager.id).not.toBe(oldManager.id);
    expect(newManager.name).toBe("Yönetici"); // the deleted role's name is free again
    expect(await keysOf(newManager.id)).toEqual(sorted(MANAGER_KEYS));

    // The old role stays deleted, keeps its rows, and nobody was moved onto the new one.
    const [old] = await testDb<{ deleted_at: string | null }[]>`select deleted_at::text as deleted_at from roles where id = ${oldManager.id}`;
    expect(old!.deleted_at).not.toBeNull();
    const [m] = await testDb<{ role_id: string }[]>`select role_id from tenant_memberships where id = ${membershipId}`;
    expect(m!.role_id).toBe(oldManager.id);
    expect(await heldKeys(member.id, tenant.id)).toEqual([]);

    // Auditable: the audit row names the role it replaced. A repeat is a no-op.
    const [audit] = await testDb<{ after: { replaced_deleted_role_id: string | null; key: string } }[]>`
      select after from audit_logs where tenant_id = ${tenant.id} and action = 'role.provisioned' and entity_id = ${newManager.id}`;
    expect(audit!.after).toMatchObject({ key: "SALON_MANAGER", replaced_deleted_role_id: oldManager.id });
    const auditBefore = await auditCount(tenant.id, "role.provisioned");
    expect((await provision(tenant.id)).every((r) => r.outcome === "exists")).toBe(true);
    expect(await auditCount(tenant.id, "role.provisioned")).toBe(auditBefore);
  }, 90000);
});

// ---------------------------------------------------------------------------
// SAAS.1E.0 authority, exercised with the real four roles
// ---------------------------------------------------------------------------

describe("provisioning does not weaken the SAAS.1E.0 authority rules", () => {
  let tenant: TestTenant;
  const users: Record<string, TestUser> = {};
  const membershipOf: Record<string, string> = {};
  const roleId: Record<string, string> = {};

  beforeAll(async () => {
    users.owner = await newUser("auth-owner");
    tenant = await createTestTenant("test-tenant-drp-auth", users.owner.id);
    createdTenantIds.push(tenant.id);
    await provision(tenant.id);
    for (const key of DEFAULT_KEYS) roleId[key] = (await roleByKey(tenant.id, key)).id;

    const [ownerMembership] = await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${users.owner.id}`;
    membershipOf.owner = ownerMembership!.id;
    for (const [label, key] of [
      ["manager", "SALON_MANAGER"], ["peer", "SALON_MANAGER"], ["reception", "RECEPTIONIST"], ["personel", "STYLIST"],
    ] as const) {
      users[label] = await newUser(`auth-${label}`);
      membershipOf[label] = await addMembership(tenant.id, users[label]!.id, roleId[key]!);
    }
  }, 120000);

  const suspend = (caller: string, membership: string) =>
    attemptAs(caller, (sql) => sql`select public.suspend_membership(${tenant.id}::uuid, ${membership}::uuid)`);
  const reactivate = (caller: string, membership: string) =>
    attemptAs(caller, (sql) => sql`select public.reactivate_membership(${tenant.id}::uuid, ${membership}::uuid)`);
  const changeRole = (caller: string, membership: string, role: string) =>
    attemptAs(caller, (sql) => sql`select public.update_membership_role(${membership}::uuid, ${role}::uuid)`);
  const editRole = (caller: string, role: string, keys: string[]) =>
    attemptAs(caller, (sql) => sql`select public.update_role_permissions(${role}::uuid, ${sql.array(keys, 1009)}::text[])`);

  it("a Manager cannot manage the Owner or an equal Manager, in any way", async () => {
    for (const target of ["owner", "peer"]) {
      expect(await suspend(users.manager!.id, membershipOf[target]!), `suspend ${target}`).toMatchObject({ ok: false, message: "insufficient_authority" });
      expect(await changeRole(users.manager!.id, membershipOf[target]!, roleId.RECEPTIONIST!), `role ${target}`).toMatchObject({ ok: false, message: "insufficient_authority" });
      expect(
        await attemptAs(users.manager!.id, (sql) => sql`select public.remove_membership_access(${tenant.id}::uuid, ${membershipOf[target]!}::uuid)`),
        `remove ${target}`,
      ).toMatchObject({ ok: false, message: "insufficient_authority" });
    }
  }, 60000);

  it("a Manager CAN manage the Receptionist and Personel (strictly lower), but cannot promote anyone to Manager or Owner", async () => {
    for (const target of ["reception", "personel"]) {
      expect(await suspend(users.manager!.id, membershipOf[target]!), `suspend ${target}`).toEqual({ ok: true });
      expect(await reactivate(users.manager!.id, membershipOf[target]!), `reactivate ${target}`).toEqual({ ok: true });
    }
    expect(await changeRole(users.manager!.id, membershipOf.personel!, roleId.RECEPTIONIST!)).toEqual({ ok: true });
    expect(await changeRole(users.manager!.id, membershipOf.personel!, roleId.STYLIST!)).toEqual({ ok: true });
    for (const higher of ["SALON_MANAGER", "SALON_OWNER"]) {
      expect(await changeRole(users.manager!.id, membershipOf.personel!, roleId[higher]!), `promote to ${higher}`).toMatchObject({ ok: false });
    }
    expect(await changeRole(users.manager!.id, membershipOf.personel!, roleId.SALON_MANAGER!)).toMatchObject({ message: "insufficient_authority" });
  }, 90000);

  it("system-default roles cannot be edited below unrestricted authority — a Manager cannot rewrite any of the four", async () => {
    for (const key of DEFAULT_KEYS) {
      expect(await editRole(users.manager!.id, roleId[key]!, ["appointments.view"]), key).toMatchObject({ ok: false, message: "system_role_edit_not_permitted" });
    }
  }, 60000);

  it("the Owner can manage every lower role, and Receptionist / Personel can manage nobody", async () => {
    for (const target of ["manager", "reception", "personel"]) {
      expect(await suspend(users.owner!.id, membershipOf[target]!), `owner suspends ${target}`).toEqual({ ok: true });
      expect(await reactivate(users.owner!.id, membershipOf[target]!), `owner reactivates ${target}`).toEqual({ ok: true });
    }
    for (const caller of ["reception", "personel"]) {
      expect(await suspend(users[caller]!.id, membershipOf.personel!), `${caller} suspends`).toMatchObject({ ok: false, message: "staff_manage_required" });
    }
  }, 90000);

  it("invitations follow the same rule: a Manager may invite into Receptionist/Personel, never into Manager or Owner", async () => {
    const invite = (role: string, label: string) =>
      attemptAs(users.manager!.id, (sql) => sql`select * from public.create_team_invitation(${tenant.id}::uuid, ${`drp-${label}-${randomUUID().slice(0, 8)}@example.com`}::text, ${role}::uuid, null::uuid)`);
    expect(await invite(roleId.RECEPTIONIST!, "rec")).toEqual({ ok: true });
    expect(await invite(roleId.STYLIST!, "per")).toEqual({ ok: true });
    expect(await invite(roleId.SALON_MANAGER!, "mgr")).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await invite(roleId.SALON_OWNER!, "own")).toMatchObject({ ok: false });
  }, 60000);
});
