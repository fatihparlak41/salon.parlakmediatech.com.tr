import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  allPermissionKeys,
  anonClient,
  attemptAs,
  auditRows,
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
 * Faz SAAS.1E.0 — team authority hardening (A: target authority, B: role
 * edit authority, G: update_membership_role).
 *
 * Authority is judged on EFFECTIVE PERMISSIONS only: a caller may manage a
 * member only if they hold staff.manage AND the target's CURRENT permission
 * set is a STRICT subset of theirs, unless they hold
 * permissions.manage_unrestricted. Roles here carry deliberately misleading
 * names (a "Stajyer" with every permission, a role literally keyed
 * SALON_OWNER with three) so any name-based shortcut would be caught.
 *
 * Every call runs through asAuthenticatedUser: the same `authenticated`
 * role + JWT claims a PostgREST request has, in one transaction, so RPCs,
 * RLS and the deferred constraint triggers behave exactly as they do for a
 * real signed-in call (see the helper's own comment). The PostgREST-surface
 * assertions (anon, raw table writes) use real clients in the lifecycle and
 * link test files.
 */

const MANAGER_KEYS = [
  "appointments.view", "appointments.create", "appointments.update", "appointments.cancel",
  "customers.view", "customers.create", "customers.update", "customers.link_account",
  "reports.basic", "reports.staff", "schedules.view", "schedules.manage",
  "services.view", "services.manage", "staff.view", "staff.manage",
];
const RECEPTION_KEYS = [
  "appointments.view", "appointments.create", "appointments.update", "appointments.cancel",
  "customers.view", "customers.create", "customers.update", "schedules.view", "services.view",
];
const PERSONEL_KEYS = ["appointments.view", "customers.view", "schedules.view", "services.view"];

let tenantA: TestTenant;
let tenantB: TestTenant;
let allKeys: string[];

const users: Record<string, TestUser> = {};
const membershipOf: Record<string, string> = {};
const roleOf: Record<string, string> = {};

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`tah-${label}`);
  createdUserIds.push(user.id);
  users[label] = user;
  return user;
}

async function membershipRow(id: string) {
  const [row] = await testDb<{ role_id: string; status: string; deleted_at: string | null; updated_at: string }[]>`
    select role_id, status, deleted_at, updated_at from tenant_memberships where id = ${id}
  `;
  return row!;
}

async function restoreMembership(id: string, roleId: string, status = "active") {
  await testDb`update tenant_memberships set role_id = ${roleId}, status = ${status}, deleted_at = null where id = ${id}`;
}

async function rolePermissionKeys(roleId: string): Promise<string[]> {
  const rows = await testDb<{ key: string }[]>`
    select p.key from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = ${roleId} order by p.key
  `;
  return rows.map((r) => r.key);
}

async function restoreRolePermissions(roleId: string, keys: string[]) {
  await testDb`delete from role_permissions where role_id = ${roleId}`;
  if (keys.length > 0) {
    const perms = await testDb<{ id: string }[]>`select id from permissions where key in ${testDb(keys)}`;
    await testDb`insert into role_permissions ${testDb(perms.map((p) => ({ role_id: roleId, permission_id: p.id })))}`;
  }
}

const updateRole = (callerId: string, membershipId: string, roleId: string) =>
  attemptAs(callerId, (sql) => sql`select public.update_membership_role(${membershipId}::uuid, ${roleId}::uuid)`);

const updateRolePermissions = (callerId: string, roleId: string, keys: string[]) =>
  attemptAs(callerId, (sql) => sql`select public.update_role_permissions(${roleId}::uuid, ${sql.array(keys, 1009)}::text[])`);

const suspend = (callerId: string, tenantId: string, membershipId: string) =>
  attemptAs(callerId, (sql) => sql`select public.suspend_membership(${tenantId}::uuid, ${membershipId}::uuid)`);

const remove = (callerId: string, tenantId: string, membershipId: string) =>
  attemptAs(callerId, (sql) => sql`select public.remove_membership_access(${tenantId}::uuid, ${membershipId}::uuid)`);

/** The private decision functions are not reachable by `authenticated` (no
 * USAGE on the private schema, by design), so they are evaluated here as the
 * database owner with the caller's JWT claims set — auth.uid() resolves
 * exactly as it does inside the RPCs. */
async function decision(userId: string, tenantId: string, targetMembershipId: string, action: string) {
  return await testDb.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true),
                     set_config('request.jwt.claim.sub', ${userId}, true)`;
    const [row] = await sql<{ d: string; ok: boolean }[]>`
      select private.membership_authority_decision(${tenantId}::uuid, ${targetMembershipId}::uuid, ${action}) as d,
             private.can_manage_membership(${tenantId}::uuid, ${targetMembershipId}::uuid, ${action}) as ok`;
    return row!;
  });
}

async function roleDecision(userId: string, tenantId: string, roleId: string) {
  return await testDb.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true),
                     set_config('request.jwt.claim.sub', ${userId}, true)`;
    const [row] = await sql<{ d: string; ok: boolean }[]>`
      select private.role_edit_decision(${tenantId}::uuid, ${roleId}::uuid) as d,
             private.can_edit_role(${tenantId}::uuid, ${roleId}::uuid) as ok`;
    return row!;
  });
}

beforeAll(async () => {
  allKeys = await allPermissionKeys();

  for (const label of ["owner", "ownerPeer", "intern", "manager", "peer", "reception", "personel", "fakeOwner", "ownerB"]) {
    await newUser(label);
  }

  tenantA = await createTestTenant("test-tenant-tah-a", users.owner!.id);
  tenantB = await createTestTenant("test-tenant-tah-b", users.ownerB!.id);
  createdTenantIds.push(tenantA.id, tenantB.id);

  roleOf.owner = tenantA.ownerRoleId;
  // A second, differently named unrestricted holder and a "Stajyer" (intern)
  // holding EVERY permission: neither name means anything to the database.
  roleOf.ownerPeer = await createCustomRole(tenantA.id, "Ortak Sahip", allKeys);
  roleOf.intern = await createCustomRole(tenantA.id, "Stajyer", allKeys);
  roleOf.manager = await createCustomRole(tenantA.id, "Yönetici", MANAGER_KEYS);
  roleOf.reception = await createCustomRole(tenantA.id, "Resepsiyon", RECEPTION_KEYS);
  roleOf.personel = await createCustomRole(tenantA.id, "Personel", PERSONEL_KEYS);
  // Literally keyed SALON_OWNER, but with three permissions and no
  // unrestricted key: a name/key must confer no authority whatsoever.
  // Since Faz SAAS.1E.1 a key is unique among a tenant's live roles, so the
  // real owner role hands its key over first and keeps its full permission
  // set under another one — authority is the effective set, never a key.
  await testDb`update roles set key = 'SALON_OWNER_FIXTURE' where id = ${tenantA.ownerRoleId}`;
  roleOf.fake = await createCustomRole(tenantA.id, "SALON_OWNER", ["appointments.view", "staff.manage", "staff.view"], {
    key: "SALON_OWNER",
  });
  // A system-default role must carry a key (Faz SAAS.1E.1): the real one.
  roleOf.systemReception = await createCustomRole(tenantA.id, "Sistem Resepsiyon", RECEPTION_KEYS, {
    key: "RECEPTIONIST",
    isSystemDefault: true,
  });
  roleOf.withSettings = await createCustomRole(tenantA.id, "Ayar Yetkilisi", ["appointments.view", "settings.manage"]);
  roleOf.deleted = await createCustomRole(tenantA.id, "Silinmiş Rol", PERSONEL_KEYS);
  await testDb`update roles set deleted_at = now() where id = ${roleOf.deleted}`;
  roleOf.roleB = await createCustomRole(tenantB.id, "B Personel", PERSONEL_KEYS);

  const [ownerMembership] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${users.owner!.id}`;
  membershipOf.owner = ownerMembership!.id;
  membershipOf.ownerPeer = await addMembership(tenantA.id, users.ownerPeer!.id, roleOf.ownerPeer);
  membershipOf.intern = await addMembership(tenantA.id, users.intern!.id, roleOf.intern);
  membershipOf.manager = await addMembership(tenantA.id, users.manager!.id, roleOf.manager);
  membershipOf.peer = await addMembership(tenantA.id, users.peer!.id, roleOf.manager);
  membershipOf.reception = await addMembership(tenantA.id, users.reception!.id, roleOf.reception);
  membershipOf.personel = await addMembership(tenantA.id, users.personel!.id, roleOf.personel);
  membershipOf.fakeOwner = await addMembership(tenantA.id, users.fakeOwner!.id, roleOf.fake);

  const [ownerBMembership] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenantB.id} and user_id = ${users.ownerB!.id}`;
  membershipOf.ownerB = ownerBMembership!.id;
}, 120000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 90000);

describe("A — target authority: a manager-like caller versus effective permissions", () => {
  it("a manager-like caller cannot demote an Owner", async () => {
    const before = await membershipRow(membershipOf.owner!);
    const out = await updateRole(users.manager!.id, membershipOf.owner!, roleOf.personel!);
    expect(out).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await membershipRow(membershipOf.owner!)).toEqual(before);
    expect(await auditRows(tenantA.id, "membership.role_changed", membershipOf.owner!)).toHaveLength(0);
  });

  it("a manager-like caller cannot change a peer with equal authority", async () => {
    const before = await membershipRow(membershipOf.peer!);
    const out = await updateRole(users.manager!.id, membershipOf.peer!, roleOf.reception!);
    expect(out).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await membershipRow(membershipOf.peer!)).toEqual(before);
    expect(await auditRows(tenantA.id, "membership.role_changed", membershipOf.peer!)).toHaveLength(0);
  });

  it("a manager-like caller CAN change a strictly lower member, with exactly one audit row", async () => {
    const out = await updateRole(users.manager!.id, membershipOf.reception!, roleOf.personel!);
    expect(out).toEqual({ ok: true });

    expect((await membershipRow(membershipOf.reception!)).role_id).toBe(roleOf.personel);
    const audit = await auditRows(tenantA.id, "membership.role_changed", membershipOf.reception!);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: users.manager!.id,
      before: { role_id: roleOf.reception },
      after: { role_id: roleOf.personel },
    });

    await restoreMembership(membershipOf.reception!, roleOf.reception!);
    await testDb`delete from audit_logs where tenant_id = ${tenantA.id} and action = 'membership.role_changed' and entity_id = ${membershipOf.reception!}`;
  });

  it("an unrestricted owner can manage lower roles, a manager, and a peer owner", async () => {
    for (const [target, newRole, original] of [
      [membershipOf.reception!, roleOf.personel!, roleOf.reception!],
      [membershipOf.manager!, roleOf.reception!, roleOf.manager!],
      [membershipOf.ownerPeer!, roleOf.personel!, roleOf.ownerPeer!],
    ] as const) {
      const out = await updateRole(users.owner!.id, target, newRole);
      expect(out, `owner -> ${target}`).toEqual({ ok: true });
      expect((await membershipRow(target)).role_id).toBe(newRole);
      await restoreMembership(target, original);
    }
  });

  it("authority follows effective permissions, never role names", async () => {
    // "Stajyer" holds every permission (incl. the unrestricted key): it may manage a manager.
    expect(await updateRole(users.intern!.id, membershipOf.manager!, roleOf.reception!)).toEqual({ ok: true });
    await restoreMembership(membershipOf.manager!, roleOf.manager!);

    // A role literally keyed SALON_OWNER with three permissions may not.
    expect(await updateRole(users.fakeOwner!.id, membershipOf.manager!, roleOf.reception!)).toMatchObject({
      ok: false,
      message: "insufficient_authority",
    });
    expect((await membershipRow(membershipOf.manager!)).role_id).toBe(roleOf.manager);
  });

  it("the authority decision codes are stable and consistent with can_manage_membership", async () => {
    const A = tenantA.id;
    const cases: Array<[string, string, string, string, string]> = [
      // [caller, target membership, action, expected decision, label]
      [users.manager!.id, membershipOf.owner!, "role_change", "insufficient_authority", "manager -> owner"],
      [users.manager!.id, membershipOf.peer!, "suspend", "insufficient_authority", "manager -> peer"],
      [users.manager!.id, membershipOf.reception!, "suspend", "ok", "manager -> lower"],
      [users.manager!.id, membershipOf.manager!, "suspend", "cannot_manage_self", "manager -> self (suspend)"],
      [users.manager!.id, membershipOf.manager!, "link", "ok", "manager -> self (link)"],
      [users.owner!.id, membershipOf.owner!, "remove", "cannot_manage_self", "owner -> self (remove)"],
      [users.owner!.id, membershipOf.manager!, "remove", "ok", "owner -> manager"],
      [users.personel!.id, membershipOf.reception!, "suspend", "staff_manage_required", "no staff.manage"],
      [users.manager!.id, membershipOf.ownerB!, "suspend", "membership_not_found", "cross-tenant target"],
      [users.ownerB!.id, membershipOf.reception!, "suspend", "membership_not_found", "caller is not a member of the tenant"],
      [users.manager!.id, membershipOf.reception!, "explode", "invalid_action", "unknown action"],
    ];
    for (const [caller, target, action, expected, label] of cases) {
      const got = await decision(caller, A, target, action);
      expect(got.d, label).toBe(expected);
      expect(got.ok, `${label} (boolean)`).toBe(expected === "ok");
    }
  });
});

describe("A — cross-tenant, forged ids and self rules", () => {
  it("rejects a target in another tenant, and forged or foreign tenant ids, without disclosing anything", async () => {
    expect(await updateRole(users.manager!.id, membershipOf.ownerB!, roleOf.personel!)).toMatchObject({
      ok: false,
      message: "membership not found",
    });
    for (const tenantArg of [tenantA.id, tenantB.id, randomUUID()]) {
      expect(await suspend(users.manager!.id, tenantArg, membershipOf.ownerB!), `tenant ${tenantArg}`).toMatchObject({
        ok: false,
        message: "membership_not_found",
      });
    }
    // Right membership, wrong tenant argument.
    expect(await suspend(users.manager!.id, tenantB.id, membershipOf.reception!)).toMatchObject({
      ok: false,
      message: "membership_not_found",
    });
    expect((await membershipRow(membershipOf.ownerB!)).status).toBe("active");
  });

  it("rejects a forged, foreign or soft-deleted role UUID", async () => {
    for (const roleId of [randomUUID(), roleOf.roleB!, roleOf.deleted!]) {
      expect(await updateRole(users.manager!.id, membershipOf.reception!, roleId), roleId).toMatchObject({
        ok: false,
        message: "role not found in this tenant",
      });
    }
    expect((await membershipRow(membershipOf.reception!)).role_id).toBe(roleOf.reception);
  });

  it("enforces the self-action rules", async () => {
    expect(await updateRole(users.manager!.id, membershipOf.manager!, roleOf.personel!)).toMatchObject({
      ok: false,
      message: "cannot change your own role",
    });
    expect(await suspend(users.owner!.id, tenantA.id, membershipOf.owner!)).toMatchObject({ ok: false, message: "cannot_manage_self" });
    expect(await remove(users.owner!.id, tenantA.id, membershipOf.owner!)).toMatchObject({ ok: false, message: "cannot_manage_self" });
    expect((await membershipRow(membershipOf.owner!)).status).toBe("active");
  });

  it("answers a non-member and a member without staff.manage with the right, non-leaking codes", async () => {
    expect(await updateRole(users.ownerB!.id, membershipOf.reception!, roleOf.personel!)).toMatchObject({
      ok: false,
      message: "membership not found",
    });
    expect(await updateRole(users.personel!.id, membershipOf.reception!, roleOf.personel!)).toMatchObject({
      ok: false,
      message: "staff.manage required",
    });
  });

  it("no unauthenticated (anon) caller can reach any management RPC", async () => {
    const anon = anonClient();
    const results = await Promise.all([
      anon.rpc("update_membership_role", { p_membership_id: membershipOf.reception!, p_new_role_id: roleOf.personel! }),
      anon.rpc("update_role_permissions", { p_role_id: roleOf.personel!, p_permission_keys: [] }),
      anon.rpc("suspend_membership", { p_tenant_id: tenantA.id, p_membership_id: membershipOf.reception! }),
      anon.rpc("reactivate_membership", { p_tenant_id: tenantA.id, p_membership_id: membershipOf.reception! }),
      anon.rpc("remove_membership_access", { p_tenant_id: tenantA.id, p_membership_id: membershipOf.reception! }),
      anon.rpc("link_staff_membership", { p_tenant_id: tenantA.id, p_staff_member_id: randomUUID(), p_membership_id: membershipOf.reception! }),
      anon.rpc("unlink_staff_membership", { p_tenant_id: tenantA.id, p_staff_member_id: randomUUID() }),
    ]);
    for (const { error } of results) expect(error).not.toBeNull();
    expect((await membershipRow(membershipOf.reception!)).status).toBe("active");
  });
});

describe("G — update_membership_role: ceiling, no-op and audit", () => {
  it("the grant ceiling on the NEW role still holds for a non-unrestricted caller", async () => {
    const out = await updateRole(users.manager!.id, membershipOf.reception!, roleOf.withSettings!);
    expect(out).toMatchObject({ ok: false, message: "cannot assign a role with permissions you do not hold" });
    expect((await membershipRow(membershipOf.reception!)).role_id).toBe(roleOf.reception);

    // An unrestricted caller may grant beyond their own set.
    expect(await updateRole(users.owner!.id, membershipOf.reception!, roleOf.withSettings!)).toEqual({ ok: true });
    await restoreMembership(membershipOf.reception!, roleOf.reception!);
    await testDb`delete from audit_logs where tenant_id = ${tenantA.id} and action = 'membership.role_changed' and entity_id = ${membershipOf.reception!}`;
  });

  it("assigning the role a member already has is an explicit no-op: success, no write, no audit row", async () => {
    const before = await membershipRow(membershipOf.reception!);
    const out = await updateRole(users.owner!.id, membershipOf.reception!, roleOf.reception!);
    expect(out).toEqual({ ok: true });
    expect(await membershipRow(membershipOf.reception!)).toEqual(before);
    expect(await auditRows(tenantA.id, "membership.role_changed", membershipOf.reception!)).toHaveLength(0);
  });

  it("the no-op never gives an unauthorized caller a silent success", async () => {
    const out = await updateRole(users.manager!.id, membershipOf.owner!, roleOf.owner!);
    expect(out).toMatchObject({ ok: false, message: "insufficient_authority" });
  });
});

describe("B — role edit authority", () => {
  it("a manager-like caller cannot rewrite the Owner role or any system-default role", async () => {
    const ownerBefore = await rolePermissionKeys(roleOf.owner!);
    expect(await updateRolePermissions(users.manager!.id, roleOf.owner!, ["appointments.view"])).toMatchObject({
      ok: false,
      message: "system_role_edit_not_permitted",
    });
    expect(await rolePermissionKeys(roleOf.owner!)).toEqual(ownerBefore);

    // Strictly below the manager, but system-default: still not editable by an ordinary manager.
    const sysBefore = await rolePermissionKeys(roleOf.systemReception!);
    expect(await updateRolePermissions(users.manager!.id, roleOf.systemReception!, ["appointments.view"])).toMatchObject({
      ok: false,
      message: "system_role_edit_not_permitted",
    });
    expect(await rolePermissionKeys(roleOf.systemReception!)).toEqual(sysBefore);
  });

  it("a manager-like caller cannot rewrite its own role or a role of equal authority", async () => {
    const before = await rolePermissionKeys(roleOf.manager!);
    expect(await updateRolePermissions(users.manager!.id, roleOf.manager!, ["appointments.view"])).toMatchObject({
      ok: false,
      message: "insufficient_authority",
    });
    expect(await rolePermissionKeys(roleOf.manager!)).toEqual(before);
  });

  it("a manager-like caller CAN edit a strictly lower custom role within its own ceiling, audited once", async () => {
    const original = await rolePermissionKeys(roleOf.reception!);
    const wanted = [...original, "reports.basic"];
    expect(await updateRolePermissions(users.manager!.id, roleOf.reception!, wanted)).toEqual({ ok: true });
    expect(await rolePermissionKeys(roleOf.reception!)).toEqual([...wanted].sort());

    const audit = await auditRows(tenantA.id, "role.permissions_updated", roleOf.reception!);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: users.manager!.id });

    await restoreRolePermissions(roleOf.reception!, original);
    await testDb`delete from audit_logs where tenant_id = ${tenantA.id} and action = 'role.permissions_updated' and entity_id = ${roleOf.reception!}`;
  });

  it("the grant ceiling on the NEW permission set still holds when editing an editable role", async () => {
    const before = await rolePermissionKeys(roleOf.reception!);
    expect(await updateRolePermissions(users.manager!.id, roleOf.reception!, [...before, "settings.manage"])).toMatchObject({
      ok: false,
      message: "cannot grant a permission you do not hold",
    });
    expect(await rolePermissionKeys(roleOf.reception!)).toEqual(before);
  });

  it("an unrestricted owner can edit any role, including a system-default one", async () => {
    const original = await rolePermissionKeys(roleOf.systemReception!);
    expect(await updateRolePermissions(users.owner!.id, roleOf.systemReception!, ["appointments.view"])).toEqual({ ok: true });
    expect(await rolePermissionKeys(roleOf.systemReception!)).toEqual(["appointments.view"]);
    await restoreRolePermissions(roleOf.systemReception!, original);
  });

  it("role authority follows effective permissions, never names or keys", async () => {
    const fakeBefore = await rolePermissionKeys(roleOf.fake!);
    // The "Stajyer" holds every permission: it may edit the role keyed SALON_OWNER.
    expect(await updateRolePermissions(users.intern!.id, roleOf.fake!, ["appointments.view", "staff.manage"])).toEqual({ ok: true });
    await restoreRolePermissions(roleOf.fake!, fakeBefore);

    // ...while the holder of the role keyed SALON_OWNER cannot edit a manager role.
    const managerBefore = await rolePermissionKeys(roleOf.manager!);
    expect(await updateRolePermissions(users.fakeOwner!.id, roleOf.manager!, ["appointments.view"])).toMatchObject({
      ok: false,
      message: "insufficient_authority",
    });
    expect(await rolePermissionKeys(roleOf.manager!)).toEqual(managerBefore);
  });

  it("rejects a role of another tenant, an unknown role and a caller without staff.manage", async () => {
    expect(await updateRolePermissions(users.manager!.id, roleOf.roleB!, ["appointments.view"])).toMatchObject({
      ok: false,
      message: "role not found",
    });
    expect(await updateRolePermissions(users.manager!.id, randomUUID(), [])).toMatchObject({ ok: false, message: "role not found" });
    expect(await updateRolePermissions(users.personel!.id, roleOf.reception!, [])).toMatchObject({
      ok: false,
      message: "staff.manage required",
    });
  });

  it("the role-edit decision codes are stable and consistent with can_edit_role", async () => {
    const A = tenantA.id;
    const cases: Array<[string, string, string, string]> = [
      [users.manager!.id, roleOf.owner!, "system_role_edit_not_permitted", "manager -> owner role"],
      [users.manager!.id, roleOf.manager!, "insufficient_authority", "manager -> own role"],
      [users.manager!.id, roleOf.systemReception!, "system_role_edit_not_permitted", "manager -> system default below"],
      [users.manager!.id, roleOf.reception!, "ok", "manager -> lower custom role"],
      [users.owner!.id, roleOf.manager!, "ok", "owner -> manager role"],
      [users.personel!.id, roleOf.reception!, "staff_manage_required", "no staff.manage"],
      [users.manager!.id, roleOf.roleB!, "role_not_found", "other tenant's role"],
      [users.manager!.id, roleOf.deleted!, "role_not_found", "soft-deleted role"],
    ];
    for (const [caller, roleId, expected, label] of cases) {
      const got = await roleDecision(caller, A, roleId);
      expect(got.d, label).toBe(expected);
      expect(got.ok, `${label} (boolean)`).toBe(expected === "ok");
    }
  });
});
