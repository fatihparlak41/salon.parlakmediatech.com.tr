import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMembership,
  admin,
  cleanupTenants,
  cleanupUsers,
  createRoleForTenant,
  createTestTenant,
  createTestUser,
  signInAs,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz 1.5's mandatory security net: a tenant member may only grant a
 * permission to someone else (via role creation, role-permission edits, or
 * role reassignment) if the member already holds that permission
 * themselves — unless they hold the single explicit bypass permission
 * `permissions.manage_unrestricted` (never a role-name check, see
 * 20260816090001 and 20260816090003). Every assertion here goes through a
 * real signed-in user's client calling the actual RPCs/tables over the
 * network — never the admin/service-role client, which would bypass both
 * RLS and the RPCs' own checks and prove nothing.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;

let ownerA: TestUser; // SALON_OWNER clone: full permissions incl. manage_unrestricted
let limitedA: TestUser; // staff.manage + appointments.view only
let bypassOnlyA: TestUser; // staff.manage + manage_unrestricted only, deliberately no finance.manage
let ownerB: TestUser; // SALON_OWNER clone on tenant B, used only for cross-tenant checks

let limitedRoleA: string;
let limitedMembershipA: string;
let bypassOnlyRoleA: string;
let ownerBMembershipId: string;
let financePermissionId: string;

// Signed in once per user and reused across every `it` below — see the
// same note in cross-tenant-isolation.test.ts. With 4 distinct users this
// keeps the whole file to 3 real sign-ins (ownerB is never signed in)
// instead of one per assertion, which is what previously tripped
// Supabase Auth's password sign-in rate limit when both test files ran
// in the same pass.
let ownerAClient: SupabaseClient;
let limitedAClient: SupabaseClient;
let bypassOnlyAClient: SupabaseClient;

beforeAll(async () => {
  ownerA = await createTestUser("owner-a");
  limitedA = await createTestUser("limited-a");
  bypassOnlyA = await createTestUser("bypass-only-a");
  ownerB = await createTestUser("owner-b");

  tenantA = await createTestTenant("test-tenant-pc-a", ownerA.id);
  tenantB = await createTestTenant("test-tenant-pc-b", ownerB.id);

  limitedRoleA = await createRoleForTenant(tenantA.id, "Sınırlı Resepsiyon", [
    "staff.manage",
    "appointments.view",
  ]);
  limitedMembershipA = await addMembership(tenantA.id, limitedA.id, limitedRoleA);

  bypassOnlyRoleA = await createRoleForTenant(tenantA.id, "Yetki Yöneticisi", [
    "staff.manage",
    "permissions.manage_unrestricted",
  ]);
  await addMembership(tenantA.id, bypassOnlyA.id, bypassOnlyRoleA);

  const { data: ownerBMembership } = await admin
    .from("tenant_memberships")
    .select("id")
    .eq("tenant_id", tenantB.id)
    .eq("user_id", ownerB.id)
    .single();
  ownerBMembershipId = ownerBMembership!.id;

  const { data: financePermission } = await admin
    .from("permissions")
    .select("id")
    .eq("key", "finance.manage")
    .single();
  financePermissionId = financePermission!.id;

  ownerAClient = await signInAs(ownerA);
  limitedAClient = await signInAs(limitedA);
  bypassOnlyAClient = await signInAs(bypassOnlyA);
}, 30000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([ownerA.id, limitedA.id, bypassOnlyA.id, ownerB.id]);
}, 30000);

describe("permission ceiling — cannot grant what you don't hold", () => {
  it("rejects create_role granting a permission the caller lacks", async () => {
    const { data, error } = await limitedAClient.rpc("create_role", {
      p_tenant_id: tenantA.id,
      p_name: "Sızma Rolü",
      p_description: null,
      p_permission_keys: ["finance.manage"],
    });
    expect(error).not.toBeNull();
    expect(data).toBeNull();

    const { data: leaked } = await admin
      .from("roles")
      .select("id")
      .eq("tenant_id", tenantA.id)
      .eq("name", "Sızma Rolü");
    expect(leaked).toHaveLength(0);
  });

  it("allows create_role granting only a permission the caller holds", async () => {
    const { data, error } = await limitedAClient.rpc("create_role", {
      p_tenant_id: tenantA.id,
      p_name: "Sınırlı Yeni Rol",
      p_description: null,
      p_permission_keys: ["appointments.view"],
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
  });

  it("rejects update_role_permissions adding a permission the caller lacks", async () => {
    const { error } = await limitedAClient.rpc("update_role_permissions", {
      p_role_id: limitedRoleA,
      p_permission_keys: ["staff.manage", "appointments.view", "finance.manage"],
    });
    expect(error).not.toBeNull();

    const { data: rolePerms } = await admin
      .from("role_permissions")
      .select("permission_id")
      .eq("role_id", limitedRoleA);
    const { data: perms } = await admin
      .from("permissions")
      .select("key")
      .in("id", (rolePerms ?? []).map((r) => r.permission_id));
    const keys = (perms ?? []).map((p) => p.key).sort();
    expect(keys).toEqual(["appointments.view", "staff.manage"]);
  });
});

describe("permission ceiling — self privilege-escalation", () => {
  it("rejects a member reassigning their own membership to a stronger role", async () => {
    const { error } = await limitedAClient.rpc("update_membership_role", {
      p_membership_id: limitedMembershipA,
      p_new_role_id: tenantA.ownerRoleId,
    });
    expect(error).not.toBeNull();

    const { data: after } = await admin
      .from("tenant_memberships")
      .select("role_id")
      .eq("id", limitedMembershipA)
      .single();
    expect(after?.role_id).toBe(limitedRoleA);
  });
});

describe("permission ceiling — cross-tenant rejection", () => {
  it("rejects update_role_permissions on another tenant's role", async () => {
    const { error } = await limitedAClient.rpc("update_role_permissions", {
      p_role_id: tenantB.ownerRoleId,
      p_permission_keys: ["appointments.view"],
    });
    expect(error).not.toBeNull();
  });

  it("rejects update_membership_role on another tenant's membership", async () => {
    const { error } = await limitedAClient.rpc("update_membership_role", {
      p_membership_id: ownerBMembershipId,
      p_new_role_id: tenantB.ownerRoleId,
    });
    expect(error).not.toBeNull();

    const { data: after } = await admin
      .from("tenant_memberships")
      .select("role_id")
      .eq("id", ownerBMembershipId)
      .single();
    expect(after?.role_id).toBe(tenantB.ownerRoleId);
  });

  it("rejects create_role on another tenant even for a manage_unrestricted holder", async () => {
    // manage_unrestricted is checked via has_permission(tenant_id, ...),
    // scoped to tenants the caller actually belongs to — it is not a
    // global superuser flag. ownerA has no membership in tenant B at all.
    const { error } = await ownerAClient.rpc("create_role", {
      p_tenant_id: tenantB.id,
      p_name: "Sızma Rolü B",
      p_description: null,
      p_permission_keys: [],
    });
    expect(error).not.toBeNull();
  });
});

describe("permission ceiling — authorized bypass via permissions.manage_unrestricted", () => {
  it("lets a manage_unrestricted holder grant a permission they don't individually hold", async () => {
    const { data, error } = await bypassOnlyAClient.rpc("create_role", {
      p_tenant_id: tenantA.id,
      p_name: "Finans Rolü",
      p_description: null,
      p_permission_keys: ["finance.manage"],
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
  });

  it("lets a manage_unrestricted holder reassign a member to a stronger role", async () => {
    const { error } = await bypassOnlyAClient.rpc("update_membership_role", {
      p_membership_id: limitedMembershipA,
      p_new_role_id: tenantA.ownerRoleId,
    });
    expect(error).toBeNull();

    const { data: after } = await admin
      .from("tenant_memberships")
      .select("role_id")
      .eq("id", limitedMembershipA)
      .single();
    expect(after?.role_id).toBe(tenantA.ownerRoleId);
  });
});

describe("permission ceiling — direct table writes are blocked", () => {
  it("cannot insert into role_permissions directly", async () => {
    const { error } = await limitedAClient
      .from("role_permissions")
      .insert({ role_id: limitedRoleA, permission_id: financePermissionId });
    expect(error).not.toBeNull();
  });

  it("cannot insert into roles directly", async () => {
    const { error } = await limitedAClient
      .from("roles")
      .insert({ tenant_id: tenantA.id, name: "Doğrudan Yazma Denemesi" });
    expect(error).not.toBeNull();
  });

  it("cannot update tenant_memberships.role_id directly", async () => {
    const { error } = await limitedAClient
      .from("tenant_memberships")
      .update({ role_id: tenantA.ownerRoleId })
      .eq("id", limitedMembershipA);
    expect(error).not.toBeNull();
  });
});
