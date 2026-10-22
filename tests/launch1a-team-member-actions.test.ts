import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  asAuthenticatedUser,
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
import {
  changeMemberRoleCore,
  reactivateMemberCore,
  removeMemberCore,
  suspendMemberCore,
} from "@/lib/modules/team/member-management";
import { getAssignableRoles, getTeamMembers } from "@/lib/modules/team/queries";
import {
  MEMBER_NOT_FOUND_MESSAGE,
  MEMBER_NOT_MANAGEABLE_MESSAGE,
  MEMBER_SELF_ACTION_MESSAGE,
  MEMBER_STATE_CHANGED_MESSAGE,
  mapMemberManagementError,
} from "@/lib/modules/team/helpers";

/**
 * Faz LAUNCH.1A — Owner-facing Team management: the Core functions behind the
 * Team page's role change / suspend / restore / remove (lib/modules/team/
 * member-management.ts), driven with REAL signed-in clients against the real
 * SAAS.1E.0 RPCs. Nothing about authority is re-implemented in the Core, so
 * these tests pin what the page actually guarantees: right people can act, wrong
 * people and wrong rows cannot, a stale page does not clobber a newer state, the
 * last unrestricted holder always survives, exactly one audit row per real
 * change, and no identifier leaks.
 */

const TAG = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

let tenant: TestTenant;
let otherTenant: TestTenant;
const u: Record<string, TestUser> = {};
const client: Record<string, SupabaseClient> = {};
const membershipOf: Record<string, string> = {};
const roleId: Record<string, string> = {};
let otherTenantMemberMembershipId: string;

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`l1a-ma-${label}`);
  createdUserIds.push(user.id);
  return user;
}

async function addMember(label: string, roleKey: "SALON_OWNER" | "SALON_MANAGER" | "RECEPTIONIST" | "STYLIST") {
  u[label] = await newUser(label);
  membershipOf[label] = await addMembership(tenant.id, u[label]!.id, roleId[roleKey]!);
  client[label] = await signInAs(u[label]!);
}

const rowOf = async (membershipId: string) =>
  (await testDb<{ role_id: string; status: string; deleted_at: Date | null }[]>`
    select role_id, status, deleted_at from tenant_memberships where id = ${membershipId}`)[0]!;

const auditCountsFor = async (membershipId: string) =>
  (
    await testDb<{ action: string }[]>`
      select action from audit_logs where tenant_id = ${tenant.id} and entity_type = 'tenant_membership' and entity_id = ${membershipId} order by created_at`
  ).map((r) => r.action);

const allMembershipAuditCount = async () =>
  (await testDb<{ n: number }[]>`select count(*)::int as n from audit_logs where tenant_id = ${tenant.id} and entity_type = 'tenant_membership'`)[0]!.n;

const input = (label: string) => ({ tenantId: tenant.id, membershipId: membershipOf[label]! });

const holderOk = async () =>
  (await testDb<{ ok: boolean }[]>`select private.tenant_has_active_unrestricted_holder(${tenant.id}::uuid) as ok`)[0]!.ok;

beforeAll(async () => {
  u.owner = await newUser("owner");
  tenant = await createTestTenant(`l1a-ma-${TAG}`, u.owner.id);
  createdTenantIds.push(tenant.id);
  await testDb`select private.provision_default_roles(${tenant.id}::uuid)`;
  for (const key of ["SALON_OWNER", "SALON_MANAGER", "RECEPTIONIST", "STYLIST"]) {
    const [r] = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${tenant.id} and key = ${key} and deleted_at is null`;
    roleId[key] = r!.id;
  }
  const [ownerMembership] = await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${u.owner.id}`;
  membershipOf.owner = ownerMembership!.id;
  client.owner = await signInAs(u.owner);

  await addMember("owner2", "SALON_OWNER");
  await addMember("manager", "SALON_MANAGER");
  await addMember("manager2", "SALON_MANAGER");
  await addMember("reception", "RECEPTIONIST");
  await addMember("personel", "STYLIST");
  await addMember("personel2", "STYLIST");
  await addMember("personel3", "STYLIST");

  // a staff row linked to personel3's login: removing access must clear the link and nothing else
  const staff = await createStaffMember(tenant.id, "Bağlı Personel");
  await testDb`update staff_members set tenant_membership_id = ${membershipOf.personel3} where id = ${staff.id}`;

  u.outsider = await newUser("outsider");
  otherTenant = await createTestTenant(`l1a-ma-other-${TAG}`, u.outsider.id);
  createdTenantIds.push(otherTenant.id);
  await testDb`select private.provision_default_roles(${otherTenant.id}::uuid)`;
  const [otherPersonelRole] = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${otherTenant.id} and key = 'STYLIST' and deleted_at is null`;
  const otherMember = await newUser("other-member");
  otherTenantMemberMembershipId = await addMembership(otherTenant.id, otherMember.id, otherPersonelRole!.id);
  client.outsider = await signInAs(u.outsider);
}, 180000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 180000);

// ---------------------------------------------------------------------------------------------------------------------
describe("the Owner can perform the four approved actions — each is exactly one audited change", () => {
  it("change role: the role changes, one membership.role_changed audit row with before/after and the Owner as actor", async () => {
    const before = await allMembershipAuditCount();
    const result = await changeMemberRoleCore(client.owner!, { ...input("personel"), newRoleId: roleId.RECEPTIONIST!, expectedRoleId: roleId.STYLIST! });
    expect(result).toEqual({ success: true, data: { membershipId: membershipOf.personel } });
    expect((await rowOf(membershipOf.personel!)).role_id).toBe(roleId.RECEPTIONIST);
    expect(await allMembershipAuditCount()).toBe(before + 1);
    const rows = await auditRows(tenant.id, "membership.role_changed", membershipOf.personel);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: u.owner!.id, before: { role_id: roleId.STYLIST }, after: { role_id: roleId.RECEPTIONIST } });
    // put it back so later groups start from the same fixture
    expect((await changeMemberRoleCore(client.owner!, { ...input("personel"), newRoleId: roleId.STYLIST!, expectedRoleId: roleId.RECEPTIONIST! })).success).toBe(true);
  });

  it("assigning the role the member already has is the database's silent no-op: success, NO write, NO audit row", async () => {
    const before = await allMembershipAuditCount();
    const result = await changeMemberRoleCore(client.owner!, { ...input("personel2"), newRoleId: roleId.STYLIST!, expectedRoleId: roleId.STYLIST! });
    expect(result.success).toBe(true);
    expect((await rowOf(membershipOf.personel2!)).role_id).toBe(roleId.STYLIST);
    expect(await allMembershipAuditCount()).toBe(before);
  });

  it("suspend then restore: status active -> suspended -> active, one audit row each, the role untouched", async () => {
    const suspend = await suspendMemberCore(client.owner!, input("personel2"));
    expect(suspend.success).toBe(true);
    expect(await rowOf(membershipOf.personel2!)).toMatchObject({ status: "suspended", role_id: roleId.STYLIST });
    const restore = await reactivateMemberCore(client.owner!, input("personel2"));
    expect(restore.success).toBe(true);
    expect(await rowOf(membershipOf.personel2!)).toMatchObject({ status: "active", role_id: roleId.STYLIST });
    expect(await auditCountsFor(membershipOf.personel2!)).toEqual(["membership.suspended", "membership.reactivated"]);
  });

  it("remove: the membership is soft-deleted, the linked staff row is unlinked (not deleted), one membership.removed audit row", async () => {
    const result = await removeMemberCore(client.owner!, input("personel3"));
    expect(result.success).toBe(true);
    const row = await rowOf(membershipOf.personel3!);
    expect(row.deleted_at).not.toBeNull();
    const [staff] = await testDb<{ tenant_membership_id: string | null; deleted_at: Date | null }[]>`
      select tenant_membership_id, deleted_at from staff_members where tenant_id = ${tenant.id} and full_name = 'Bağlı Personel'`;
    expect(staff).toEqual({ tenant_membership_id: null, deleted_at: null });
    const removed = (await auditCountsFor(membershipOf.personel3!)).filter((a) => a === "membership.removed");
    expect(removed).toHaveLength(1);
    // and the removed member is gone from the Team list
    const list = await getTeamMembers(client.owner!, tenant.id);
    expect(list.some((m) => m.membershipId === membershipOf.personel3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("who may act on whom", () => {
  it("members without staff.manage (Resepsiyon, Personel) are refused on every action and nothing changes", async () => {
    const before = await allMembershipAuditCount();
    for (const actor of ["reception", "personel"]) {
      for (const run of [
        () => suspendMemberCore(client[actor]!, input("personel2")),
        () => reactivateMemberCore(client[actor]!, input("personel2")),
        () => removeMemberCore(client[actor]!, input("personel2")),
        () => changeMemberRoleCore(client[actor]!, { ...input("personel2"), newRoleId: roleId.RECEPTIONIST!, expectedRoleId: roleId.STYLIST! }),
      ]) {
        const result = await run();
        expect(result, actor).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
      }
    }
    expect(await allMembershipAuditCount()).toBe(before);
    expect((await rowOf(membershipOf.personel2!)).status).toBe("active");
  });

  it("a Yönetici can act on members strictly below them (Resepsiyon, Personel) ...", async () => {
    expect((await suspendMemberCore(client.manager!, input("reception"))).success).toBe(true);
    expect((await reactivateMemberCore(client.manager!, input("reception"))).success).toBe(true);
    expect(
      (await changeMemberRoleCore(client.manager!, { ...input("personel"), newRoleId: roleId.RECEPTIONIST!, expectedRoleId: roleId.STYLIST! })).success,
    ).toBe(true);
    expect(
      (await changeMemberRoleCore(client.manager!, { ...input("personel"), newRoleId: roleId.STYLIST!, expectedRoleId: roleId.RECEPTIONIST! })).success,
    ).toBe(true);
  });

  it("... but never on a Salon Sahibi, a peer Yönetici or themselves — refused before any RPC, with the member message, and nothing is written", async () => {
    const before = await allMembershipAuditCount();
    for (const target of ["owner", "owner2", "manager2"]) {
      for (const run of [
        () => suspendMemberCore(client.manager!, input(target)),
        () => removeMemberCore(client.manager!, input(target)),
        () => changeMemberRoleCore(client.manager!, { ...input(target), newRoleId: roleId.STYLIST!, expectedRoleId: roleId.SALON_MANAGER! }),
      ]) {
        expect(await run(), target).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: MEMBER_NOT_MANAGEABLE_MESSAGE } });
      }
    }
    expect(await suspendMemberCore(client.manager!, input("manager"))).toEqual({
      success: false,
      error: { code: "UNAUTHORIZED", message: MEMBER_SELF_ACTION_MESSAGE },
    });
    expect(await allMembershipAuditCount()).toBe(before);
  });

  it("a Yönetici cannot hand out a role above their own — the picker does not offer it, and a forged request is refused by the database", async () => {
    const offered = await getAssignableRoles(client.manager!, tenant.id);
    expect(offered.map((r) => r.name).sort()).toEqual(["Personel", "Resepsiyon"]);
    // forge it anyway: promote a Personel to Yönetici / Salon Sahibi
    for (const roleKey of ["SALON_MANAGER", "SALON_OWNER"]) {
      const result = await changeMemberRoleCore(client.manager!, { ...input("personel"), newRoleId: roleId[roleKey]!, expectedRoleId: roleId.STYLIST! });
      expect(result.success, roleKey).toBe(false);
      if (!result.success) expect(result.error.code).toBe("UNAUTHORIZED");
    }
    expect((await rowOf(membershipOf.personel!)).role_id).toBe(roleId.STYLIST);
  });

  it("the Salon Sahibi's picker offers every role; a custom role with a permission the Yönetici lacks is offered to the Owner only", async () => {
    const rich = await createCustomRole(tenant.id, "Finans Özel", ["appointments.view", "finance.view"]);
    expect((await getAssignableRoles(client.owner!, tenant.id)).map((r) => r.id)).toContain(rich);
    expect((await getAssignableRoles(client.manager!, tenant.id)).map((r) => r.id)).not.toContain(rich);
    const result = await changeMemberRoleCore(client.manager!, { ...input("personel"), newRoleId: rich, expectedRoleId: roleId.STYLIST! });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("tenant isolation and forged identifiers", () => {
  it("a membership id from ANOTHER tenant, sent with this tenant's id, is NOT_FOUND — and nothing in either tenant changes", async () => {
    const before = await rowOf(otherTenantMemberMembershipId);
    for (const run of [
      () => suspendMemberCore(client.owner!, { tenantId: tenant.id, membershipId: otherTenantMemberMembershipId }),
      () => removeMemberCore(client.owner!, { tenantId: tenant.id, membershipId: otherTenantMemberMembershipId }),
      () => reactivateMemberCore(client.owner!, { tenantId: tenant.id, membershipId: otherTenantMemberMembershipId }),
      () =>
        changeMemberRoleCore(client.owner!, {
          tenantId: tenant.id,
          membershipId: otherTenantMemberMembershipId,
          newRoleId: roleId.RECEPTIONIST!,
          expectedRoleId: roleId.STYLIST!,
        }),
    ]) {
      expect(await run()).toEqual({ success: false, error: { code: "NOT_FOUND", message: MEMBER_NOT_FOUND_MESSAGE } });
    }
    expect(await rowOf(otherTenantMemberMembershipId)).toEqual(before);
  });

  it("naming ANOTHER tenant that the caller does not manage is refused outright (the same answer for an unknown tenant id)", async () => {
    for (const tenantId of [otherTenant.id, randomUUID()]) {
      const result = await suspendMemberCore(client.owner!, { tenantId, membershipId: otherTenantMemberMembershipId });
      expect(result).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    }
  });

  it("the other tenant's own owner can still manage their member (isolation is not just a blanket refusal)", async () => {
    expect((await suspendMemberCore(client.outsider!, { tenantId: otherTenant.id, membershipId: otherTenantMemberMembershipId })).success).toBe(true);
    expect((await reactivateMemberCore(client.outsider!, { tenantId: otherTenant.id, membershipId: otherTenantMemberMembershipId })).success).toBe(true);
  });

  it("a forged role id from another tenant is refused by the database (role not found in this tenant) and writes nothing", async () => {
    const [foreignRole] = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${otherTenant.id} and key = 'RECEPTIONIST' and deleted_at is null`;
    const before = await allMembershipAuditCount();
    const result = await changeMemberRoleCore(client.owner!, { ...input("personel2"), newRoleId: foreignRole!.id, expectedRoleId: roleId.STYLIST! });
    expect(result).toEqual({ success: false, error: { code: "VALIDATION", message: "Geçersiz rol" } });
    expect(await allMembershipAuditCount()).toBe(before);
  });

  it("malformed or random identifiers fail validation / not-found without touching anything", async () => {
    expect(await suspendMemberCore(client.owner!, { tenantId: "not-a-uuid", membershipId: membershipOf.personel! })).toMatchObject({ success: false, error: { code: "VALIDATION" } });
    expect(await suspendMemberCore(client.owner!, { tenantId: tenant.id, membershipId: "x" })).toMatchObject({ success: false, error: { code: "VALIDATION" } });
    expect(await suspendMemberCore(client.owner!, { tenantId: tenant.id, membershipId: randomUUID() })).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("self actions and the last unrestricted holder", () => {
  it("nobody can suspend, restore, remove or re-role THEMSELVES — including the Salon Sahibi", async () => {
    const before = await allMembershipAuditCount();
    for (const actor of ["owner", "owner2", "manager"]) {
      for (const run of [
        () => suspendMemberCore(client[actor]!, input(actor)),
        () => removeMemberCore(client[actor]!, input(actor)),
        () => reactivateMemberCore(client[actor]!, input(actor)),
        () => changeMemberRoleCore(client[actor]!, { ...input(actor), newRoleId: roleId.STYLIST!, expectedRoleId: roleId.SALON_OWNER! }),
      ]) {
        expect(await run(), actor).toMatchObject({ success: false, error: { code: "UNAUTHORIZED", message: MEMBER_SELF_ACTION_MESSAGE } });
      }
    }
    expect(await allMembershipAuditCount()).toBe(before);
    expect(await holderOk()).toBe(true);
  });

  it("the DATABASE refuses self-actions too, with no help from the Core (a direct RPC call as the Owner)", async () => {
    for (const rpc of ["suspend_membership", "remove_membership_access"]) {
      const { error } = await client.owner!.rpc(rpc as "suspend_membership", { p_tenant_id: tenant.id, p_membership_id: membershipOf.owner! });
      expect(error?.message, rpc).toContain("cannot_manage_self");
    }
    const { error } = await client.owner!.rpc("update_membership_role", { p_membership_id: membershipOf.owner!, p_new_role_id: roleId.STYLIST! });
    expect(error?.message).toContain("cannot change your own role");
    expect(await holderOk()).toBe(true);
  });

  it("two Owners acting on each other at the same moment: at most one wins and the tenant always keeps an active unrestricted holder", async () => {
    const [a, b] = await Promise.all([suspendMemberCore(client.owner!, input("owner2")), suspendMemberCore(client.owner2!, input("owner"))]);
    expect([a.success, b.success].filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(await holderOk()).toBe(true);
    // restore whoever lost access, so the rest of the file has both owners again
    const ownerRow = await rowOf(membershipOf.owner!);
    const owner2Row = await rowOf(membershipOf.owner2!);
    if (owner2Row.status === "suspended") expect((await reactivateMemberCore(client.owner!, input("owner2"))).success).toBe(true);
    if (ownerRow.status === "suspended") expect((await reactivateMemberCore(client.owner2!, input("owner"))).success).toBe(true);
    expect((await rowOf(membershipOf.owner!)).status).toBe("active");
    expect((await rowOf(membershipOf.owner2!)).status).toBe("active");
  });

  it("a peer Salon Sahibi CAN remove the other Owner, and the survivor then cannot be touched by anyone below — the last Owner is untouchable", async () => {
    // owner removes owner2: allowed, owner stays the unrestricted holder
    expect((await removeMemberCore(client.owner!, input("owner2"))).success).toBe(true);
    expect(await holderOk()).toBe(true);
    // a Yönetici cannot touch the now-sole Owner, and the Owner cannot touch themself
    expect(await suspendMemberCore(client.manager!, input("owner"))).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    expect(await removeMemberCore(client.manager!, input("owner"))).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    expect(await removeMemberCore(client.owner!, input("owner"))).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    expect((await rowOf(membershipOf.owner!)).status).toBe("active");
    expect(await holderOk()).toBe(true);
  });

  it("mapMemberManagementError turns the deferred last-holder trigger's text into a clear conflict", () => {
    expect(mapMemberManagementError({ message: "tenant_would_lose_last_unrestricted_holder" })).toMatchObject({
      success: false,
      error: { code: "CONFLICT" },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("a suspended member loses access; a restored member gets it back", () => {
  it("suspension takes effect on the next request: not a tenant member, no permissions, and no more Team reads — then restore reverses it", async () => {
    const hasPermission = (userId: string) =>
      asAuthenticatedUser(userId, (sql) => sql<{ ok: boolean; member: boolean }[]>`
        select public.has_permission(${tenant.id}::uuid, 'appointments.view') as ok,
               exists (select 1 from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${userId} and status = 'active') as member`);

    expect((await hasPermission(u.manager2!.id))[0]).toEqual({ ok: true, member: true });
    expect((await suspendMemberCore(client.owner!, input("manager2"))).success).toBe(true);
    expect((await hasPermission(u.manager2!.id))[0]!.ok).toBe(false);
    // a suspended Yönetici cannot read the Team list or act, even though the role still says staff.manage
    await expect(getTeamMembers(client.manager2!, tenant.id)).rejects.toThrow();
    expect(await suspendMemberCore(client.manager2!, input("personel2"))).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    // the Owner still sees them, marked suspended
    const listed = await getTeamMembers(client.owner!, tenant.id);
    expect(listed.find((m) => m.membershipId === membershipOf.manager2)).toMatchObject({ status: "suspended", canManage: true });

    expect((await reactivateMemberCore(client.owner!, input("manager2"))).success).toBe(true);
    expect((await hasPermission(u.manager2!.id))[0]).toEqual({ ok: true, member: true });
  });

  it("suspension and restore leave the person's staff link, role and history alone (only the status moves)", async () => {
    const staff = await createStaffMember(tenant.id, "Askıdaki Personel");
    await testDb`update staff_members set tenant_membership_id = ${membershipOf.personel} where id = ${staff.id}`;
    const roleBefore = (await rowOf(membershipOf.personel!)).role_id;
    expect((await suspendMemberCore(client.owner!, input("personel"))).success).toBe(true);
    const [linked] = await testDb<{ tenant_membership_id: string | null }[]>`select tenant_membership_id from staff_members where id = ${staff.id}`;
    expect(linked!.tenant_membership_id).toBe(membershipOf.personel);
    expect((await rowOf(membershipOf.personel!)).role_id).toBe(roleBefore);
    expect((await reactivateMemberCore(client.owner!, input("personel"))).success).toBe(true);
    await testDb`update staff_members set tenant_membership_id = null where id = ${staff.id}`;
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("stale pages and concurrent changes", () => {
  it("suspend/restore against a state the page did not show is a CONFLICT with the refresh message, and writes nothing", async () => {
    expect((await suspendMemberCore(client.owner!, input("personel2"))).success).toBe(true);
    const before = await allMembershipAuditCount();
    expect(await suspendMemberCore(client.owner!, input("personel2"))).toEqual({ success: false, error: { code: "CONFLICT", message: MEMBER_STATE_CHANGED_MESSAGE } });
    expect((await reactivateMemberCore(client.owner!, input("personel2"))).success).toBe(true);
    expect(await reactivateMemberCore(client.owner!, input("personel2"))).toEqual({ success: false, error: { code: "CONFLICT", message: MEMBER_STATE_CHANGED_MESSAGE } });
    expect(await allMembershipAuditCount()).toBe(before + 1); // only the one real restore
  });

  it("a role change from a stale page (the role the Owner saw is no longer the role) is a CONFLICT, no write, no audit row", async () => {
    // someone else changes Personel -> Resepsiyon first ...
    expect((await changeMemberRoleCore(client.owner!, { ...input("personel2"), newRoleId: roleId.RECEPTIONIST!, expectedRoleId: roleId.STYLIST! })).success).toBe(true);
    const before = await allMembershipAuditCount();
    // ... then a page that still shows Personel tries to promote the member to Yönetici
    const stale = await changeMemberRoleCore(client.owner!, { ...input("personel2"), newRoleId: roleId.SALON_MANAGER!, expectedRoleId: roleId.STYLIST! });
    expect(stale).toEqual({ success: false, error: { code: "CONFLICT", message: MEMBER_STATE_CHANGED_MESSAGE } });
    expect((await rowOf(membershipOf.personel2!)).role_id).toBe(roleId.RECEPTIONIST);
    expect(await allMembershipAuditCount()).toBe(before);
    expect((await changeMemberRoleCore(client.owner!, { ...input("personel2"), newRoleId: roleId.STYLIST!, expectedRoleId: roleId.RECEPTIONIST! })).success).toBe(true);
  });

  it("two simultaneous suspends of the same member: exactly one succeeds, the other is the refresh conflict, exactly one audit row", async () => {
    const before = (await auditCountsFor(membershipOf.personel2!)).filter((a) => a === "membership.suspended").length;
    const results = await Promise.all([suspendMemberCore(client.owner!, input("personel2")), suspendMemberCore(client.owner!, input("personel2"))]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    const loser = results.find((r) => !r.success)!;
    expect(loser).toEqual({ success: false, error: { code: "CONFLICT", message: MEMBER_STATE_CHANGED_MESSAGE } });
    expect((await auditCountsFor(membershipOf.personel2!)).filter((a) => a === "membership.suspended")).toHaveLength(before + 1);
    expect((await reactivateMemberCore(client.owner!, input("personel2"))).success).toBe(true);
  });

  it("a remove that races a suspend of the same member ends in exactly one consistent final state", async () => {
    const results = await Promise.all([removeMemberCore(client.owner!, input("personel2")), suspendMemberCore(client.owner!, input("personel2"))]);
    expect(results.some((r) => r.success)).toBe(true);
    const row = await rowOf(membershipOf.personel2!);
    expect(row.deleted_at).not.toBeNull(); // remove always wins eventually: it succeeded, or suspend ran first and then remove applied
    expect(await holderOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("read models and results never leak identifiers", () => {
  it("action results carry only the opaque membership id; failure messages contain no id, e-mail or auth id", async () => {
    const ok = await suspendMemberCore(client.owner!, input("personel"));
    expect(ok).toEqual({ success: true, data: { membershipId: membershipOf.personel } });
    expect((await reactivateMemberCore(client.owner!, input("personel"))).success).toBe(true);

    const failures = [
      await suspendMemberCore(client.manager!, input("owner")),
      await suspendMemberCore(client.owner!, { tenantId: tenant.id, membershipId: randomUUID() }),
      await changeMemberRoleCore(client.owner!, { ...input("reception"), newRoleId: roleId.STYLIST!, expectedRoleId: roleId.SALON_OWNER! }),
    ];
    for (const f of failures) {
      expect(f.success).toBe(false);
      const blob = JSON.stringify(f);
      for (const user of Object.values(u)) {
        expect(blob.includes(user.id)).toBe(false);
        expect(blob.includes(user.email)).toBe(false);
      }
      expect(blob).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });

  it("the Team list rows expose no auth id or e-mail for any caller (Owner and Yönetici views)", async () => {
    for (const actor of ["owner", "manager"]) {
      const rows = await getTeamMembers(client[actor]!, tenant.id);
      const blob = JSON.stringify(rows);
      for (const user of Object.values(u)) {
        expect(blob.includes(user.id), `${actor} sees ${user.email}`).toBe(false);
        expect(blob.includes(user.email)).toBe(false);
      }
    }
  });
});
