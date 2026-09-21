import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMembership,
  cleanupTenants,
  cleanupUsers,
  createRoleForTenant,
  createTestTenant,
  createTestUser,
  randomTokenHex,
  sha256Hex,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";
import {
  getTeamMembers,
  getTeamInvitations,
  getEligibleStaffForLinking,
  getTenantRoleOptions,
} from "@/lib/modules/team/queries";
import { revokeTeamInvitationCore } from "@/lib/modules/team/actions";
import { mapRevokeInvitationError } from "@/lib/modules/team/helpers";

/**
 * Faz SAAS.1D.1 — Team Management page foundation: the new query layer
 * (lib/modules/team/queries.ts) and the new revoke action
 * (revokeTeamInvitationCore, lib/modules/team/actions.ts). Every query
 * here uses a REAL signed-in client over the network, never testDb/admin
 * for the assertions themselves — same discipline as every other
 * security-boundary test in this suite. testDb is used only for fixture
 * setup (inserting a cross-tenant/stale invitation row directly) and for
 * ground-truth verification.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let managerA: TestUser; // staff.manage, distinct actor from ownerA
let outsiderB: TestUser; // member of tenantB only

let ownerAClient: SupabaseClient;
let managerAClient: SupabaseClient;

let managerRoleId: string; // within ownerA's ceiling
let linkedStaffId: string;
let unlinkedStaffId: string;

const createdUserIds: string[] = [];

beforeAll(async () => {
  ownerA = await createTestUser("tp-owner-a");
  managerA = await createTestUser("tp-manager-a");
  outsiderB = await createTestUser("tp-outsider-b");
  createdUserIds.push(ownerA.id, managerA.id, outsiderB.id);

  tenantA = await createTestTenant("test-tenant-tp-a", ownerA.id);
  tenantB = await createTestTenant("test-tenant-tp-b", outsiderB.id);

  managerRoleId = await createRoleForTenant(tenantA.id, "Sınırlı Rol", [
    "staff.manage",
    "appointments.view",
  ]);
  await addMembership(tenantA.id, managerA.id, managerRoleId);

  const [linked] = await testDb<{ id: string }[]>`
    insert into staff_members (tenant_id, full_name, tenant_membership_id)
    values (${tenantA.id}, ${"Linked Staff"}, (select id from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${managerA.id}))
    returning id
  `;
  linkedStaffId = linked!.id;

  const [unlinked] = await testDb<{ id: string }[]>`
    insert into staff_members (tenant_id, full_name)
    values (${tenantA.id}, ${"Unlinked Staff"})
    returning id
  `;
  unlinkedStaffId = unlinked!.id;

  ownerAClient = await signInAs(ownerA);
  managerAClient = await signInAs(managerA);
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers(createdUserIds);
}, 60000);

function freshEmail(label: string): string {
  return `tp-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.com`;
}

async function createInvitation(email: string, roleId = managerRoleId, staffMemberId?: string) {
  const { data, error } = await ownerAClient.rpc("create_team_invitation", {
    p_tenant_id: tenantA.id,
    p_email: email,
    p_role_id: roleId,
    p_staff_member_id: staffMemberId,
  });
  if (error || !data) throw new Error(`fixture create failed: ${error?.message}`);
  return (data as { id: string; expires_at: string; token: string }[])[0]!;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("getTeamMembers (1, 3, 4, 5, 6)", () => {
  it("1/4/5. returns active members with role name and linked-staff name", async () => {
    const members = await getTeamMembers(ownerAClient, tenantA.id);
    expect(members.length).toBeGreaterThanOrEqual(2);

    const owner = members.find((m) => m.userId === ownerA.id);
    expect(owner).toBeDefined();
    // createTestTenant clones the SALON_OWNER role_template, whose own
    // display name is "Salon Sahibi" (supabase/migrations/20260815120006).
    expect(owner!.roleName).toBe("Salon Sahibi");
    expect(owner!.linkedStaffName).toBeNull();

    const manager = members.find((m) => m.userId === managerA.id);
    expect(manager).toBeDefined();
    expect(manager!.roleName).toBe("Sınırlı Rol");
    expect(manager!.linkedStaffName).toBe("Linked Staff");
  });

  it("6. displayName is never a raw UUID, even without a profiles row", async () => {
    const members = await getTeamMembers(ownerAClient, tenantA.id);
    for (const m of members) {
      expect(UUID_RE.test(m.displayName)).toBe(false);
    }
  });

  it("3. tenant isolation — tenantB members never appear in tenantA's list", async () => {
    const members = await getTeamMembers(ownerAClient, tenantA.id);
    expect(members.some((m) => m.userId === outsiderB.id)).toBe(false);
  });
});

describe("getTeamInvitations (3, 7, 8)", () => {
  it("7. loads through list_team_invitations — role name and staff link resolved", async () => {
    const created = await createInvitation(freshEmail("list-1"), managerRoleId, unlinkedStaffId);
    const invitations = await getTeamInvitations(ownerAClient, tenantA.id);
    const row = invitations.find((i) => i.id === created.id);
    expect(row).toBeDefined();
    expect(row!.roleName).toBe("Sınırlı Rol");
    expect(row!.staffMemberId).toBe(unlinkedStaffId);
    expect(row!.staffMemberName).toBe("Unlinked Staff");
    expect(row!.status).toBe("pending");
  });

  it("8. effective_status reports expired for a stale-but-still-pending row without mutating persisted status", async () => {
    const email = freshEmail("list-stale");
    const rawToken = randomTokenHex();
    const [stale] = await testDb<{ id: string }[]>`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenantA.id}, ${email}, ${managerRoleId}, ${ownerA.id}, 'pending', ${sha256Hex(rawToken)}, now() - interval '1 hour', now() - interval '8 days')
      returning id
    `;
    const invitations = await getTeamInvitations(ownerAClient, tenantA.id);
    const row = invitations.find((i) => i.id === stale!.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");
    expect(row!.effectiveStatus).toBe("expired");
  });

  it("3. tenant isolation — ownerA's own client sees nothing when pointed at tenantB, even though tenantA has real invitations", async () => {
    const created = await createInvitation(freshEmail("list-isolation"));
    // ownerA is not a member of tenantB at all — RLS must return zero
    // rows regardless of the tenantId argument passed, proving the
    // caller-supplied tenantId alone is never trusted for isolation.
    const invitationsAsB = await getTeamInvitations(ownerAClient, tenantB.id);
    expect(invitationsAsB.some((i) => i.id === created.id)).toBe(false);
    expect(invitationsAsB).toHaveLength(0);
  });
});

describe("getEligibleStaffForLinking (3)", () => {
  it("excludes staff already linked to a membership, includes unlinked staff", async () => {
    const options = await getEligibleStaffForLinking(ownerAClient, tenantA.id);
    expect(options.some((s) => s.id === linkedStaffId)).toBe(false);
    expect(options.some((s) => s.id === unlinkedStaffId)).toBe(true);
  });

  it("3. tenant isolation — ownerA's own client sees no staff when pointed at tenantB", async () => {
    const options = await getEligibleStaffForLinking(ownerAClient, tenantB.id);
    expect(options.some((s) => s.id === unlinkedStaffId)).toBe(false);
  });
});

describe("getTenantRoleOptions (3)", () => {
  it("returns active tenant roles by name", async () => {
    const roles = await getTenantRoleOptions(ownerAClient, tenantA.id);
    expect(roles.some((r) => r.id === managerRoleId && r.name === "Sınırlı Rol")).toBe(true);
  });

  it("3. tenant isolation — ownerA's own client sees no roles when pointed at tenantB", async () => {
    const roles = await getTenantRoleOptions(ownerAClient, tenantB.id);
    expect(roles.some((r) => r.id === managerRoleId)).toBe(false);
  });

  it("excludes a soft-deleted role", async () => {
    const [deletedRole] = await testDb<{ id: string }[]>`
      insert into roles (tenant_id, name, is_system_default, deleted_at)
      values (${tenantA.id}, ${"Silinmiş Rol"}, false, now())
      returning id
    `;
    const roles = await getTenantRoleOptions(ownerAClient, tenantA.id);
    expect(roles.some((r) => r.id === deletedRole!.id)).toBe(false);
  });
});

describe("revokeTeamInvitationCore", () => {
  it("revokes a pending invitation", async () => {
    const created = await createInvitation(freshEmail("revoke-1"));
    const result = await revokeTeamInvitationCore(ownerAClient, {
      tenantId: tenantA.id,
      invitationId: created.id,
    });
    expect(result).toMatchObject({ success: true, data: { invitationId: created.id, status: "revoked" } });

    const [row] = await testDb<{ status: string }[]>`select status from team_invitations where id = ${created.id}`;
    expect(row?.status).toBe("revoked");
  });

  it("a non-pending invitation cannot be revoked again", async () => {
    const created = await createInvitation(freshEmail("revoke-2"));
    const first = await revokeTeamInvitationCore(ownerAClient, { tenantId: tenantA.id, invitationId: created.id });
    expect(first.success).toBe(true);

    const second = await revokeTeamInvitationCore(ownerAClient, { tenantId: tenantA.id, invitationId: created.id });
    expect(second).toMatchObject({ success: false, error: { code: "CONFLICT" } });
  });

  it("an expired-but-pending invitation transitions to expired instead of revoked", async () => {
    const email = freshEmail("revoke-expired");
    const rawToken = randomTokenHex();
    const [stale] = await testDb<{ id: string }[]>`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenantA.id}, ${email}, ${managerRoleId}, ${ownerA.id}, 'pending', ${sha256Hex(rawToken)}, now() - interval '1 hour', now() - interval '8 days')
      returning id
    `;
    const result = await revokeTeamInvitationCore(ownerAClient, {
      tenantId: tenantA.id,
      invitationId: stale!.id,
    });
    expect(result).toMatchObject({ success: true, data: { invitationId: stale!.id, status: "expired" } });
  });

  it("cross-tenant invitationId fails the prelookup as NOT_FOUND — no mutation", async () => {
    const rawToken = randomTokenHex();
    const [crossTenantInv] = await testDb<{ id: string; token_hash: string }[]>`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenantB.id}, ${freshEmail("revoke-cross")}, ${tenantB.ownerRoleId}, ${outsiderB.id}, 'pending', ${sha256Hex(rawToken)}, now() + interval '7 days', now())
      returning id, token_hash
    `;
    const result = await revokeTeamInvitationCore(ownerAClient, {
      tenantId: tenantA.id, // ownerA's own tenant, wrong invitation
      invitationId: crossTenantInv!.id,
    });
    expect(result).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });

    const [after] = await testDb<{ token_hash: string; status: string }[]>`
      select token_hash, status from team_invitations where id = ${crossTenantInv!.id}
    `;
    expect(after?.status).toBe("pending");
    expect(after?.token_hash).toBe(crossTenantInv!.token_hash);
  });

  it("permission ceiling: cannot revoke an invitation into a role with permissions the caller does not hold", async () => {
    const ownerRoleInvite = await createInvitation(freshEmail("revoke-ceiling"), tenantA.ownerRoleId);
    const result = await revokeTeamInvitationCore(managerAClient, {
      tenantId: tenantA.id,
      invitationId: ownerRoleInvite.id,
    });
    expect(result).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
  });

  it("a caller without staff.manage is denied", async () => {
    const created = await createInvitation(freshEmail("revoke-denied"));
    const outsiderBClient = await signInAs(outsiderB);
    const result = await revokeTeamInvitationCore(outsiderBClient, {
      tenantId: tenantB.id,
      invitationId: created.id, // belongs to tenantA, not tenantB — fails prelookup, not permission
    });
    expect(result).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });
});

describe("mapRevokeInvitationError — pure function, exact live RPC messages", () => {
  it("maps every known revoke_team_invitation error message", () => {
    expect(mapRevokeInvitationError({ message: "invitation_not_found" })).toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
    expect(mapRevokeInvitationError({ message: "staff.manage required" })).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
    expect(
      mapRevokeInvitationError({ message: "cannot revoke an invitation into a role with permissions you do not hold" }),
    ).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(mapRevokeInvitationError({ message: "insufficient_authority" })).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
    expect(mapRevokeInvitationError({ message: "invitation_not_pending" })).toMatchObject({
      error: { code: "CONFLICT" },
    });
    expect(mapRevokeInvitationError({ message: "some completely unrecognized message" })).toMatchObject({
      error: { code: "UNEXPECTED" },
    });
  });
});

describe("privacy (30-34) — no token/token_hash/acceptUrl/providerMessageId ever leaves the query layer", () => {
  it("getTeamInvitations never includes the raw token, token_hash, or an acceptUrl-shaped field", async () => {
    const created = await createInvitation(freshEmail("privacy-invitations"));
    const invitations = await getTeamInvitations(ownerAClient, tenantA.id);
    const serialized = JSON.stringify(invitations);
    expect(serialized).not.toContain(created.token);
    expect(serialized).not.toMatch(/https?:\/\//);
    for (const row of invitations) {
      expect(Object.keys(row)).not.toContain("token");
      expect(Object.keys(row)).not.toContain("tokenHash");
      expect(Object.keys(row)).not.toContain("acceptUrl");
    }
  });

  it("getTeamMembers / getEligibleStaffForLinking / getTenantRoleOptions never contain token-shaped or provider fields", async () => {
    const [members, staffOptions, roles] = await Promise.all([
      getTeamMembers(ownerAClient, tenantA.id),
      getEligibleStaffForLinking(ownerAClient, tenantA.id),
      getTenantRoleOptions(ownerAClient, tenantA.id),
    ]);
    const serialized = JSON.stringify([members, staffOptions, roles]);
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toMatch(/providerMessageId/i);
    expect(serialized).not.toMatch(/smtp/i);
  });
});
