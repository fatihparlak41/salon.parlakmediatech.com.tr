import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  allPermissionKeys,
  asAuthenticatedUser,
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
 * Faz SAAS.1E.0 (part 5) — a caller below "unrestricted" can never hand out
 * authority EQUAL to their own (20260921092226_no_peer_authority_creation.sql).
 *
 * Part 2 of this release already refuses invitations into a peer role. This file
 * proves the two other doors are closed the same way — update_membership_role
 * (the NEW role) and update_role_permissions (the NEW permission set) — and that
 * the two-step route around the invitation rule (invite into a lower role, then
 * promote) no longer works. The rule everywhere: a non-unrestricted caller
 * may only put someone into, or shape a role into, a permission set that is a
 * STRICT subset of their own; unrestricted callers are exempt; the pre-existing
 * grant-ceiling messages are unchanged for sets that are not contained at all.
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
const EXTRA_KEY = "settings.manage";

let tenantA: TestTenant;
let tenantB: TestTenant;
let allKeys: string[];

const users: Record<string, TestUser> = {};
const roleOf: Record<string, string> = {};
const membershipOf: Record<string, string> = {};

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`pac-${label}`);
  createdUserIds.push(user.id);
  users[label] = user;
  return user;
}

const updateRole = (callerId: string, membershipId: string, roleId: string) =>
  attemptAs(callerId, (sql) => sql`select public.update_membership_role(${membershipId}::uuid, ${roleId}::uuid)`);

const updatePermissions = (callerId: string, roleId: string, keys: string[] | null) =>
  attemptAs(callerId, (sql) => sql`select public.update_role_permissions(${roleId}::uuid, ${keys === null ? null : sql.array(keys, 1009)}::text[])`);

async function roleOfMembership(membershipId: string): Promise<string> {
  const [row] = await testDb<{ role_id: string }[]>`select role_id from tenant_memberships where id = ${membershipId}`;
  return row!.role_id;
}

async function keysOf(roleId: string): Promise<string[]> {
  return (
    await testDb<{ key: string }[]>`
      select p.key from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = ${roleId} order by p.key`
  ).map((r) => r.key);
}

async function setKeys(roleId: string, keys: string[]) {
  await testDb`delete from role_permissions where role_id = ${roleId}`;
  if (keys.length > 0) {
    await testDb`insert into role_permissions (role_id, permission_id) select ${roleId}, id from permissions where key in ${testDb(keys)}`;
  }
}

const sorted = (keys: string[]) => [...keys].sort();
const auditCount = async (action: string, entityId: string) => (await auditRows(tenantA.id, action, entityId)).length;

beforeAll(async () => {
  allKeys = await allPermissionKeys();
  expect(allKeys).toContain(EXTRA_KEY);
  for (const label of ["owner", "partner", "manager", "victim", "plain", "invitee", "outsider"]) {
    await newUser(label);
  }

  tenantA = await createTestTenant("test-tenant-pac-a", users.owner!.id);
  tenantB = await createTestTenant("test-tenant-pac-b", users.outsider!.id);
  createdTenantIds.push(tenantA.id, tenantB.id);

  roleOf.owner = tenantA.ownerRoleId;
  roleOf.partner = await createCustomRole(tenantA.id, "Ortak", allKeys); // unrestricted, differently named
  roleOf.manager = await createCustomRole(tenantA.id, "Yönetici", MANAGER_KEYS);
  roleOf.peer = await createCustomRole(tenantA.id, "Kıdemli Yönetici", MANAGER_KEYS); // EQUAL set, different row
  roleOf.higher = await createCustomRole(tenantA.id, "Yönetici Artı", [...MANAGER_KEYS, EXTRA_KEY]);
  roleOf.lower = await createCustomRole(tenantA.id, "Resepsiyon", RECEPTION_KEYS);
  roleOf.personel = await createCustomRole(tenantA.id, "Personel", PERSONEL_KEYS);
  roleOf.empty = await createCustomRole(tenantA.id, "Boş Rol", []);
  roleOf.editable = await createCustomRole(tenantA.id, "Düzenlenebilir", PERSONEL_KEYS);

  membershipOf.partner = await addMembership(tenantA.id, users.partner!.id, roleOf.partner);
  membershipOf.manager = await addMembership(tenantA.id, users.manager!.id, roleOf.manager);
  membershipOf.victim = await addMembership(tenantA.id, users.victim!.id, roleOf.lower);
  membershipOf.plain = await addMembership(tenantA.id, users.plain!.id, roleOf.personel);
}, 180000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 120000);

describe("update_membership_role — the NEW role must be strictly below a non-unrestricted caller", () => {
  it("a manager cannot promote a member into the manager's own role or into any peer role", async () => {
    for (const target of ["manager", "peer"]) {
      const before = await auditCount("membership.role_changed", membershipOf.victim!);
      expect(await updateRole(users.manager!.id, membershipOf.victim!, roleOf[target]!), target).toMatchObject({
        ok: false,
        message: "insufficient_authority",
      });
      expect(await roleOfMembership(membershipOf.victim!)).toBe(roleOf.lower);
      expect(await auditCount("membership.role_changed", membershipOf.victim!)).toBe(before);
    }
  }, 60000);

  it("the pre-existing ceiling message is unchanged for roles that are not contained at all", async () => {
    for (const target of ["higher", "owner", "partner"]) {
      expect(await updateRole(users.manager!.id, membershipOf.victim!, roleOf[target]!), target).toMatchObject({
        ok: false,
        message: "cannot assign a role with permissions you do not hold",
      });
    }
    expect(await roleOfMembership(membershipOf.victim!)).toBe(roleOf.lower);
  }, 60000);

  it("a manager still can move a member to a strictly lower role or an empty role — one audit row each", async () => {
    for (const target of ["personel", "empty", "lower"]) {
      const before = await auditCount("membership.role_changed", membershipOf.victim!);
      const current = await roleOfMembership(membershipOf.victim!);
      expect(await updateRole(users.manager!.id, membershipOf.victim!, roleOf[target]!), target).toEqual({ ok: true });
      expect(await roleOfMembership(membershipOf.victim!)).toBe(roleOf[target]);
      expect(await auditCount("membership.role_changed", membershipOf.victim!)).toBe(before + (current === roleOf[target] ? 0 : 1));
    }
  }, 90000);

  it("unrestricted callers are exempt — even one whose role is not called Owner", async () => {
    for (const [label, callerId] of [["owner", users.owner!.id], ["partner", users.partner!.id]] as const) {
      for (const target of ["peer", "manager", "higher", "owner"]) {
        expect(await updateRole(callerId, membershipOf.victim!, roleOf[target]!), `${label}->${target}`).toEqual({ ok: true });
        expect(await roleOfMembership(membershipOf.victim!)).toBe(roleOf[target]);
      }
      expect(await updateRole(callerId, membershipOf.victim!, roleOf.lower!)).toEqual({ ok: true });
    }
  }, 120000);

  it("the strictness follows the caller's CURRENT permissions: a peer role stops being a peer when the manager gains a permission", async () => {
    expect(await updateRole(users.manager!.id, membershipOf.victim!, roleOf.peer!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    await testDb`insert into role_permissions (role_id, permission_id) select ${roleOf.manager}, id from permissions where key = ${EXTRA_KEY}`;
    try {
      expect(await updateRole(users.manager!.id, membershipOf.victim!, roleOf.peer!)).toEqual({ ok: true });
      expect(await updateRole(users.manager!.id, membershipOf.victim!, roleOf.manager!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    } finally {
      await testDb`delete from role_permissions where role_id = ${roleOf.manager} and permission_id = (select id from permissions where key = ${EXTRA_KEY})`;
      await testDb`update tenant_memberships set role_id = ${roleOf.lower} where id = ${membershipOf.victim}`;
    }
    expect(await updateRole(users.manager!.id, membershipOf.victim!, roleOf.peer!)).toMatchObject({ ok: false, message: "insufficient_authority" });
  }, 60000);

  it("regressions: same-role no-op still succeeds silently; no staff.manage and other-tenant callers are still refused with the old messages", async () => {
    const before = await auditCount("membership.role_changed", membershipOf.victim!);
    expect(await updateRole(users.manager!.id, membershipOf.victim!, roleOf.lower!)).toEqual({ ok: true });
    expect(await auditCount("membership.role_changed", membershipOf.victim!)).toBe(before);
    expect(await updateRole(users.plain!.id, membershipOf.victim!, roleOf.personel!)).toMatchObject({ ok: false, message: "staff.manage required" });
    expect(await updateRole(users.outsider!.id, membershipOf.victim!, roleOf.personel!)).toMatchObject({ ok: false, message: "membership not found" });
  }, 60000);
});

describe("update_role_permissions — the NEW set must be strictly below a non-unrestricted caller", () => {
  it("a manager cannot rewrite a lower role into exactly their own set", async () => {
    const before = await keysOf(roleOf.editable!);
    const auditBefore = await auditCount("role.permissions_updated", roleOf.editable!);
    expect(await updatePermissions(users.manager!.id, roleOf.editable!, [...MANAGER_KEYS])).toMatchObject({
      ok: false,
      message: "insufficient_authority",
    });
    expect(await keysOf(roleOf.editable!)).toEqual(before);
    expect(await auditCount("role.permissions_updated", roleOf.editable!)).toBe(auditBefore);
  }, 40000);

  it("the pre-existing ceiling message is unchanged when the new set exceeds the caller's", async () => {
    expect(await updatePermissions(users.manager!.id, roleOf.editable!, [...MANAGER_KEYS, EXTRA_KEY])).toMatchObject({
      ok: false,
      message: "cannot grant a permission you do not hold",
    });
    expect(await updatePermissions(users.manager!.id, roleOf.editable!, ["not.a.real.permission"])).toMatchObject({
      ok: false,
      message: "cannot grant a permission you do not hold",
    });
  }, 40000);

  it("a manager still can shape a role into a strict subset, an empty set or NULL — audited once each", async () => {
    const withoutOne = MANAGER_KEYS.filter((k) => k !== "staff.manage");
    for (const keys of [withoutOne, RECEPTION_KEYS, [], null] as (string[] | null)[]) {
      const auditBefore = await auditCount("role.permissions_updated", roleOf.editable!);
      expect(await updatePermissions(users.manager!.id, roleOf.editable!, keys)).toEqual({ ok: true });
      expect(sorted(await keysOf(roleOf.editable!))).toEqual(sorted(keys ?? []));
      expect(await auditCount("role.permissions_updated", roleOf.editable!)).toBe(auditBefore + 1);
    }
    await setKeys(roleOf.editable!, PERSONEL_KEYS);
  }, 90000);

  it("unrestricted callers are exempt: they may set any set, equal to their own included", async () => {
    for (const callerId of [users.owner!.id, users.partner!.id]) {
      expect(await updatePermissions(callerId, roleOf.editable!, [...allKeys])).toEqual({ ok: true });
      expect(sorted(await keysOf(roleOf.editable!))).toEqual(sorted(allKeys));
      expect(await updatePermissions(callerId, roleOf.editable!, PERSONEL_KEYS)).toEqual({ ok: true });
    }
  }, 60000);

  it("regressions: a role above the caller is still not editable, and a member without staff.manage is still refused", async () => {
    // The shipped Owner role is a system default: not editable below "unrestricted" at all (pre-existing rule and message).
    expect(await updatePermissions(users.manager!.id, roleOf.owner!, ["appointments.view"])).toMatchObject({ ok: false, message: "system_role_edit_not_permitted" });
    expect(await updatePermissions(users.manager!.id, roleOf.manager!, ["appointments.view"])).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await updatePermissions(users.plain!.id, roleOf.editable!, [])).toMatchObject({ ok: false, message: "staff.manage required" });
    expect(await updatePermissions(users.manager!.id, randomUUID(), [])).toMatchObject({ ok: false, message: "role not found" });
  }, 60000);
});

describe("the two-step route around the invitation rule is closed", () => {
  it("invite into a lower role, accept, then try to promote or reshape into a peer: every step past the invitation is refused and no peer results", async () => {
    // Step 1 — the invitation itself is allowed (a strictly lower role) ...
    const invitation = await asAuthenticatedUser(users.manager!.id, async (sql) => {
      const rows = await sql<{ id: string; token: string }[]>`
        select id, token from public.create_team_invitation(${tenantA.id}::uuid, ${users.invitee!.email.toLowerCase()}::text, ${roleOf.lower}::uuid, null::uuid)`;
      return rows[0]!;
    });
    expect(invitation.token).toMatch(/^[0-9a-f]{64}$/);

    // ... and the invitee joins under that role.
    const accepted = await asAuthenticatedUser(users.invitee!.id, async (sql) => {
      const rows = await sql<{ membership_id: string; outcome: string }[]>`
        select membership_id, outcome from public.accept_team_invitation(${invitation.token}::text)`;
      return rows[0]!;
    });
    expect(accepted.outcome).toBe("accepted");
    expect(await roleOfMembership(accepted.membership_id)).toBe(roleOf.lower);

    // Step 2a — promote the new member into the manager's own role / a peer role: refused.
    for (const target of ["manager", "peer"]) {
      expect(await updateRole(users.manager!.id, accepted.membership_id, roleOf[target]!), target).toMatchObject({
        ok: false,
        message: "insufficient_authority",
      });
    }
    // Step 2b — reshape the invitee's own (lower) role into the manager's exact set: refused.
    const lowerBefore = await keysOf(roleOf.lower!);
    expect(await updatePermissions(users.manager!.id, roleOf.lower!, [...MANAGER_KEYS])).toMatchObject({
      ok: false,
      message: "insufficient_authority",
    });
    expect(await keysOf(roleOf.lower!)).toEqual(lowerBefore);

    // Nothing became a peer.
    expect(await roleOfMembership(accepted.membership_id)).toBe(roleOf.lower);
    expect(await keysOf(roleOf.lower!)).toEqual(lowerBefore);
  }, 120000);
});
