import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  allPermissionKeys,
  asAuthenticatedUser,
  cleanupTenants,
  cleanupUsers,
  createCustomRole,
  createTestTenant,
  createTestUser,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1E.0 (C) — a soft-deleted role must behave like a role that is
 * not there: it grants ZERO permissions, its members do not count as
 * unrestricted holders, and soft-deleting the role that backs the LAST
 * holder cannot commit. Before this migration private.has_permission and
 * the holder calculation never joined roles at all (probe D5: both holder
 * roles could be soft-deleted, and the tenant kept "having" holders that
 * held nothing).
 *
 * The invariant is enforced by the deferred constraint trigger
 * roles_unrestricted_holder_guard, so it holds even for a privileged
 * connection with no RPC in the way — every mutation below is raw SQL on
 * purpose (roles have no client-writable column and no delete RPC).
 */

let tenant: TestTenant;
let allKeys: string[];
const users: Record<string, TestUser> = {};
const membershipOf: Record<string, string> = {};
const roleOf: Record<string, string> = {};
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

const MEMBER_KEYS = ["appointments.view", "customers.view", "staff.view"];

async function hasPermission(userId: string, key: string): Promise<boolean> {
  return asAuthenticatedUser(userId, async (sql) => {
    const [row] = await sql<{ v: boolean }[]>`select public.has_permission(${tenant.id}::uuid, ${key}) as v`;
    return row!.v;
  });
}

async function isMember(userId: string): Promise<boolean> {
  return asAuthenticatedUser(userId, async (sql) => {
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${userId}`;
    return Number(row!.n) > 0;
  });
}

/** The private calculations, evaluated as the database owner with the caller's claims. */
async function privateCalc(userId: string) {
  return testDb.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true),
                     set_config('request.jwt.claim.sub', ${userId}, true)`;
    const [row] = await sql<{ holder: boolean; keys: string[]; roleKeys: string[] }[]>`
      select private.tenant_has_active_unrestricted_holder(${tenant.id}::uuid) as holder,
             private.caller_permission_keys(${tenant.id}::uuid) as keys,
             private.role_permission_keys(${roleOf.member!}::uuid) as "roleKeys"`;
    return row!;
  });
}

async function holdersCount(): Promise<number> {
  const [row] = await testDb<{ n: string }[]>`
    select count(distinct tm.id)::text as n
    from tenant_memberships tm
    join roles r on r.id = tm.role_id and r.deleted_at is null
    join role_permissions rp on rp.role_id = r.id
    join permissions p on p.id = rp.permission_id
    where tm.tenant_id = ${tenant.id} and tm.status = 'active' and tm.deleted_at is null and p.key = 'permissions.manage_unrestricted'`;
  return Number(row!.n);
}

async function roleDeleted(roleId: string): Promise<boolean> {
  const [row] = await testDb<{ deleted_at: string | null }[]>`select deleted_at from roles where id = ${roleId}`;
  return row!.deleted_at !== null;
}

beforeAll(async () => {
  allKeys = await allPermissionKeys();
  for (const label of ["ownerA", "holderB", "member"]) {
    const user = await createTestUser(`drs-${label}`);
    createdUserIds.push(user.id);
    users[label] = user;
  }
  tenant = await createTestTenant("test-tenant-drs", users.ownerA!.id);
  createdTenantIds.push(tenant.id);

  roleOf.ownerA = tenant.ownerRoleId;
  roleOf.holderB = await createCustomRole(tenant.id, "Ortak Sahip B", allKeys);
  roleOf.member = await createCustomRole(tenant.id, "Görevli", MEMBER_KEYS);
  roleOf.spare = await createCustomRole(tenant.id, "Yedek Rol", ["appointments.view"]);

  const [ownerMembership] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${users.ownerA!.id}`;
  membershipOf.ownerA = ownerMembership!.id;
  membershipOf.holderB = await addMembership(tenant.id, users.holderB!.id, roleOf.holderB);
  membershipOf.member = await addMembership(tenant.id, users.member!.id, roleOf.member);
}, 90000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 60000);

describe("a soft-deleted role grants nothing", () => {
  it("its member keeps the membership but holds ZERO permissions; un-deleting restores them", async () => {
    for (const key of MEMBER_KEYS) expect(await hasPermission(users.member!.id, key), `before: ${key}`).toBe(true);

    await testDb`update roles set deleted_at = now() where id = ${roleOf.member!}`;
    for (const key of MEMBER_KEYS) expect(await hasPermission(users.member!.id, key), `deleted: ${key}`).toBe(false);
    expect(await isMember(users.member!.id)).toBe(true);
    const calc = await privateCalc(users.member!.id);
    expect(calc.keys).toEqual([]);
    expect(calc.roleKeys).toEqual([]);

    await testDb`update roles set deleted_at = null where id = ${roleOf.member!}`;
    for (const key of MEMBER_KEYS) expect(await hasPermission(users.member!.id, key), `restored: ${key}`).toBe(true);
    expect((await privateCalc(users.member!.id)).roleKeys).toEqual([...MEMBER_KEYS].sort());
  });

  it("soft-deleting a role that backs no unrestricted holder is fine", async () => {
    await testDb`update roles set deleted_at = now() where id = ${roleOf.spare!}`;
    expect(await roleDeleted(roleOf.spare!)).toBe(true);
    expect(await holdersCount()).toBe(2);
    await testDb`update roles set deleted_at = null where id = ${roleOf.spare!}`;
  });
});

describe("a soft-deleted role's members are not unrestricted holders", () => {
  it("deleting one holder role leaves exactly the other holder — and the deleted role's member loses the key", async () => {
    expect(await holdersCount()).toBe(2);
    expect(await hasPermission(users.holderB!.id, "permissions.manage_unrestricted")).toBe(true);

    await testDb`update roles set deleted_at = now() where id = ${roleOf.holderB!}`;

    expect(await holdersCount()).toBe(1);
    expect(await hasPermission(users.holderB!.id, "permissions.manage_unrestricted")).toBe(false);
    expect(await hasPermission(users.ownerA!.id, "permissions.manage_unrestricted")).toBe(true);
    expect((await privateCalc(users.ownerA!.id)).holder).toBe(true);

    // the last holder is now ownerA: the role behind THEM cannot be soft-deleted
    await expect(
      testDb.begin(async (sql) => {
        await sql`update roles set deleted_at = now() where id = ${roleOf.ownerA!}`;
      }),
    ).rejects.toThrow(/tenant_would_lose_last_unrestricted_holder/);
    expect(await roleDeleted(roleOf.ownerA!)).toBe(false);
    expect(await holdersCount()).toBe(1);

    await testDb`update roles set deleted_at = null where id = ${roleOf.holderB!}`;
    expect(await holdersCount()).toBe(2);
  });

  it("soft-deleting BOTH holder roles in one transaction cannot commit", async () => {
    await expect(
      testDb.begin(async (sql) => {
        await sql`update roles set deleted_at = now() where id = ${roleOf.holderB!}`;
        await sql`update roles set deleted_at = now() where id = ${roleOf.ownerA!}`;
      }),
    ).rejects.toThrow(/tenant_would_lose_last_unrestricted_holder/);
    expect(await roleDeleted(roleOf.holderB!)).toBe(false);
    expect(await roleDeleted(roleOf.ownerA!)).toBe(false);
    expect(await holdersCount()).toBe(2);
  });

  it("the check is deferred: deleting a holder role while re-homing its member in the SAME transaction commits", async () => {
    await testDb.begin(async (sql) => {
      await sql`update roles set deleted_at = now() where id = ${roleOf.ownerA!}`;
      await sql`update tenant_memberships set role_id = ${roleOf.holderB!} where id = ${membershipOf.ownerA!}`;
    });

    expect(await roleDeleted(roleOf.ownerA!)).toBe(true);
    expect(await holdersCount()).toBe(2);
    expect(await hasPermission(users.ownerA!.id, "permissions.manage_unrestricted")).toBe(true);

    // restore the fixture
    await testDb.begin(async (sql) => {
      await sql`update roles set deleted_at = null where id = ${roleOf.ownerA!}`;
      await sql`update tenant_memberships set role_id = ${roleOf.ownerA!} where id = ${membershipOf.ownerA!}`;
    });
    expect(await holdersCount()).toBe(2);
  });

  it("the guard is a real database constraint trigger (deferrable, initially deferred, enabled)", async () => {
    const [row] = await testDb<{ enabled: string; deferrable: boolean; deferred: boolean }[]>`
      select tgenabled::text as enabled, tgdeferrable as deferrable, tginitdeferred as deferred
      from pg_trigger where tgname = 'roles_unrestricted_holder_guard' and not tgisinternal`;
    expect(row).toEqual({ enabled: "O", deferrable: true, deferred: true });
  });
});
