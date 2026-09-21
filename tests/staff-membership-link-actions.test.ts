import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMembership,
  auditRows,
  cleanupTenants,
  cleanupUsers,
  createCustomRole,
  createStaffMember,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";
import { applyStaffMembershipLink, mapStaffLinkError } from "@/lib/modules/staff/membership-link";

/**
 * Faz SAAS.1E.0 — the application's ONLY path to change a staff member's
 * login link (lib/modules/staff/membership-link.ts), exercised with real
 * signed-in clients exactly as the Personnel Server Actions call it. The
 * database rules themselves (authority, tenant, uniqueness, direct-write
 * refusal) are proven in staff-membership-link-rpcs.test.ts; this file
 * proves the adapter neither re-implements nor bypasses them.
 */

const MANAGER_KEYS = [
  "appointments.view", "customers.view", "customers.create", "customers.update",
  "schedules.view", "schedules.manage", "services.view", "staff.view", "staff.manage",
];

let tenant: TestTenant;
let owner: TestUser;
let manager: TestUser;
let m1User: TestUser;
let m2User: TestUser;
let ownerClient: SupabaseClient;
let managerClient: SupabaseClient;
const membershipOf: Record<string, string> = {};
const createdUserIds: string[] = [];

async function linkOf(staffId: string): Promise<string | null> {
  const [row] = await testDb<{ tenant_membership_id: string | null }[]>`select tenant_membership_id from staff_members where id = ${staffId}`;
  return row!.tenant_membership_id;
}

beforeAll(async () => {
  for (const label of ["owner", "manager", "m1", "m2"]) {
    const user = await createTestUser(`sla-${label}`);
    createdUserIds.push(user.id);
    if (label === "owner") owner = user;
    if (label === "manager") manager = user;
    if (label === "m1") m1User = user;
    if (label === "m2") m2User = user;
  }
  tenant = await createTestTenant("test-tenant-sla", owner.id);
  const managerRole = await createCustomRole(tenant.id, "Yönetici", MANAGER_KEYS);
  const lowerRole = await createCustomRole(tenant.id, "Personel", ["appointments.view"]);
  const [ownerMembership] = await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${owner.id}`;
  membershipOf.owner = ownerMembership!.id;
  membershipOf.manager = await addMembership(tenant.id, manager.id, managerRole);
  membershipOf.m1 = await addMembership(tenant.id, m1User.id, lowerRole);
  membershipOf.m2 = await addMembership(tenant.id, m2User.id, lowerRole);
  ownerClient = await signInAs(owner);
  managerClient = await signInAs(manager);
}, 90000);

afterAll(async () => {
  await cleanupTenants([tenant.id]);
  await cleanupUsers(createdUserIds);
}, 60000);

describe("applyStaffMembershipLink", () => {
  // every test starts from a tenant where no staff row is linked to any login (the database owner
  // is a trusted writer of the link), so tests cannot pollute each other's setup
  beforeEach(async () => {
    await testDb`update staff_members set tenant_membership_id = null where tenant_id = ${tenant.id}`;
  });

  it("'no change' is not a write: no RPC, no audit row", async () => {
    const staff = await createStaffMember(tenant.id, "Değişmeyen");
    const before = (await auditRows(tenant.id, "staff_member.updated", staff.id)).length;

    for (const desired of [null, undefined, ""]) {
      expect(await applyStaffMembershipLink(ownerClient, { staffMemberId: staff.id, desiredMembershipId: desired })).toEqual({ success: true, data: null });
    }
    expect((await auditRows(tenant.id, "staff_member.updated", staff.id)).length).toBe(before);
    expect(await linkOf(staff.id)).toBeNull();
  });

  it("links, then leaves an identical request alone, then unlinks on an empty selection", async () => {
    const staff = await createStaffMember(tenant.id, "Bağlanan");

    expect((await applyStaffMembershipLink(ownerClient, { staffMemberId: staff.id, desiredMembershipId: membershipOf.m1! })).success).toBe(true);
    expect(await linkOf(staff.id)).toBe(membershipOf.m1);
    const afterLink = (await auditRows(tenant.id, "staff_member.updated", staff.id)).length;

    // the deployed form resends the current value: still no write
    expect((await applyStaffMembershipLink(ownerClient, { staffMemberId: staff.id, desiredMembershipId: membershipOf.m1! })).success).toBe(true);
    expect((await auditRows(tenant.id, "staff_member.updated", staff.id)).length).toBe(afterLink);

    expect((await applyStaffMembershipLink(ownerClient, { staffMemberId: staff.id, desiredMembershipId: "" })).success).toBe(true);
    expect(await linkOf(staff.id)).toBeNull();
  });

  it("changes A -> B as unlink-then-link (the database never overwrites)", async () => {
    const staff = await createStaffMember(tenant.id, "Değişen");
    await testDb`update staff_members set tenant_membership_id = ${membershipOf.m1!} where id = ${staff.id}`;

    expect((await applyStaffMembershipLink(ownerClient, { staffMemberId: staff.id, desiredMembershipId: membershipOf.m2! })).success).toBe(true);
    expect(await linkOf(staff.id)).toBe(membershipOf.m2);
  });

  it("puts A back if the second step of A -> B is refused, and reports the conflict", async () => {
    const holder = await createStaffMember(tenant.id, "Mevcut Sahip");
    const mover = await createStaffMember(tenant.id, "Taşınan");
    await testDb`update staff_members set tenant_membership_id = ${membershipOf.m2!} where id = ${holder.id}`;
    await testDb`update staff_members set tenant_membership_id = ${membershipOf.m1!} where id = ${mover.id}`;

    // m2 already belongs to `holder`: moving `mover` there must fail cleanly and leave m1 in place.
    const result = await applyStaffMembershipLink(ownerClient, { staffMemberId: mover.id, desiredMembershipId: membershipOf.m2! });
    expect(result).toEqual({ success: false, error: { code: "CONFLICT", message: "Bu hesap zaten başka bir personele bağlı" } });
    expect(await linkOf(mover.id)).toBe(membershipOf.m1);
    expect(await linkOf(holder.id)).toBe(membershipOf.m2);
  });

  it("does not let a manager attach or detach an Owner's login (authority is the database's, surfaced as UNAUTHORIZED)", async () => {
    const staff = await createStaffMember(tenant.id, "Sahibin Personeli");

    const attach = await applyStaffMembershipLink(managerClient, { staffMemberId: staff.id, desiredMembershipId: membershipOf.owner! });
    expect(attach).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    expect(await linkOf(staff.id)).toBeNull();

    await testDb`update staff_members set tenant_membership_id = ${membershipOf.owner!} where id = ${staff.id}`;
    const detach = await applyStaffMembershipLink(managerClient, { staffMemberId: staff.id, desiredMembershipId: null });
    expect(detach).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    expect(await linkOf(staff.id)).toBe(membershipOf.owner);
  });

  it("reports a missing staff row", async () => {
    expect(await applyStaffMembershipLink(ownerClient, { staffMemberId: "00000000-0000-4000-8000-000000000000", desiredMembershipId: null })).toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
  });
});

describe("mapStaffLinkError", () => {
  it("maps every stable database code to an action-layer error", () => {
    const cases: Array<[string, string]> = [
      ["staff_already_linked", "CONFLICT"],
      ["membership_already_linked", "CONFLICT"],
      ["staff_member_not_found", "NOT_FOUND"],
      ["membership_not_found", "NOT_FOUND"],
      ["staff_not_linked", "NOT_FOUND"],
      ["staff_manage_required", "UNAUTHORIZED"],
      ["insufficient_authority", "UNAUTHORIZED"],
      ["something unexpected", "UNEXPECTED"],
    ];
    for (const [message, code] of cases) {
      expect(mapStaffLinkError({ message }), message).toMatchObject({ success: false, error: { code } });
    }
    expect(mapStaffLinkError({ code: "42501", message: "staff_membership_link_via_rpc_only" })).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});
