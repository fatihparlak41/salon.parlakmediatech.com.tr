import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  admin,
  anonClient,
  cleanupPlatformAdmins,
  cleanupTenants,
  cleanupUsers,
  createTestTenant,
  createTestUser,
  signInAs,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz 1's mandatory security net (see architecture report section H and
 * the Faz 1 completion report "Test sonuçları"): proves tenant isolation
 * holds against the REAL RLS policies over the network, not just "looks
 * right in the SQL". Every assertion here uses a client authenticated as
 * a real test user — never the admin/service-role client, which would
 * bypass RLS and prove nothing.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env.local (fixture setup only —
 * creating/tearing down test tenants and users needs it). Runs against the
 * live DEV project; all fixtures are removed in afterAll.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let userA: TestUser; // member of tenant A only
let userB: TestUser; // member of tenant B only
let platformAdminUser: TestUser;

// Signed in once and reused across every `it` below — permission checks
// (has_permission, RLS policies) are looked up live from the DB on every
// call, never baked into the JWT, so a cached session is exactly as valid
// as a fresh sign-in. Re-authenticating per assertion previously tripped
// Supabase Auth's password sign-in rate limit once this file ran
// alongside permission-ceiling.test.ts.
let clientA: SupabaseClient;
let platformAdminClient: SupabaseClient;

beforeAll(async () => {
  userA = await createTestUser("user-a");
  userB = await createTestUser("user-b");
  platformAdminUser = await createTestUser("platform-admin");

  tenantA = await createTestTenant("test-tenant-a", userA.id);
  tenantB = await createTestTenant("test-tenant-b", userB.id);

  await admin
    .from("platform_admins")
    .insert({ user_id: platformAdminUser.id, role: "owner" });

  clientA = await signInAs(userA);
  platformAdminClient = await signInAs(platformAdminUser);
}, 30000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupPlatformAdmins([platformAdminUser.id]);
  await cleanupUsers([userA.id, userB.id, platformAdminUser.id]);
}, 30000);

describe("cross-tenant isolation", () => {
  it("a member can read their own tenant", async () => {
    const { data, error } = await clientA
      .from("tenants")
      .select("id")
      .eq("id", tenantA.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("a member cannot read another tenant's row (silently filtered, not an error)", async () => {
    const { data, error } = await clientA
      .from("tenants")
      .select("id")
      .eq("id", tenantB.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("listing tenants only returns the caller's own", async () => {
    const { data } = await clientA.from("tenants").select("id");
    const ids = (data ?? []).map((t) => t.id);
    expect(ids).toContain(tenantA.id);
    expect(ids).not.toContain(tenantB.id);
  });

  it("a member cannot insert a branch into another tenant", async () => {
    const { error } = await clientA
      .from("branches")
      .insert({ tenant_id: tenantB.id, name: "Sızma Şube" });
    expect(error).not.toBeNull();
  });

  it("a member can insert a branch into their own tenant", async () => {
    const { error } = await clientA
      .from("branches")
      .insert({ tenant_id: tenantA.id, name: "Test Şube" });
    expect(error).toBeNull();
  });

  it("a member cannot read another tenant's memberships", async () => {
    const { data } = await clientA
      .from("tenant_memberships")
      .select("id")
      .eq("tenant_id", tenantB.id);
    expect(data).toHaveLength(0);
  });

  it("a member cannot read another tenant's roles", async () => {
    const { data } = await clientA
      .from("roles")
      .select("id")
      .eq("tenant_id", tenantB.id);
    expect(data).toHaveLength(0);
  });

  it("has_permission() is true for the owner on their own tenant", async () => {
    const { data, error } = await clientA.rpc("has_permission", {
      p_tenant_id: tenantA.id,
      p_permission_key: "staff.manage",
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  it("has_permission() is false for a tenant the user doesn't belong to", async () => {
    const { data } = await clientA.rpc("has_permission", {
      p_tenant_id: tenantB.id,
      p_permission_key: "staff.manage",
    });
    expect(data).toBe(false);
  });

  it("a regular member cannot see platform_admins at all", async () => {
    const { data } = await clientA.from("platform_admins").select("id");
    expect(data).toHaveLength(0);
  });

  it("is_platform_admin() is false for a regular tenant owner", async () => {
    const { data } = await clientA.rpc("is_platform_admin");
    expect(data).toBe(false);
  });

  it("a platform admin can read across both tenants", async () => {
    const { data } = await platformAdminClient
      .from("tenants")
      .select("id")
      .in("id", [tenantA.id, tenantB.id]);
    const ids = (data ?? []).map((t) => t.id);
    expect(ids).toContain(tenantA.id);
    expect(ids).toContain(tenantB.id);
  });

  it("an unauthenticated client cannot query tenants at all", async () => {
    // Pre-Faz-1.5 this returned { data: [], error: null } — anon had a
    // table grant (Supabase project-bootstrap default, not anything this
    // project granted) and RLS silently filtered every row. Migration
    // 20260816090006 revoked that grant entirely, so anon now fails at
    // the permission-check stage before RLS is even evaluated — a hard
    // error, not an empty result. Asserting the error here is the point:
    // it's the regression test for that hardening.
    const client = anonClient();
    const { data, error } = await client.from("tenants").select("id");
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("a member cannot escalate by updating their own membership row", async () => {
    const { data: before } = await admin
      .from("tenant_memberships")
      .select("id, status")
      .eq("tenant_id", tenantA.id)
      .eq("user_id", userA.id)
      .single();

    const { data: updateResult } = await clientA
      .from("tenant_memberships")
      .update({ status: "suspended" })
      .eq("id", before!.id)
      .select();

    // tenant_memberships_update_staff_manage excludes user_id = auth.uid()
    // — RLS makes the row invisible to this UPDATE, so it matches zero
    // rows rather than throwing.
    expect(updateResult).toHaveLength(0);

    const { data: after } = await admin
      .from("tenant_memberships")
      .select("status")
      .eq("id", before!.id)
      .single();
    expect(after?.status).toBe(before?.status);
  });
});
