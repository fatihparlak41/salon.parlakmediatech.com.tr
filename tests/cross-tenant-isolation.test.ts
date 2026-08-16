import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

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
 * live DEV project; all fixtures are prefixed test-<runId> and removed in
 * afterAll.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !publishableKey || !serviceRoleKey) {
  throw new Error(
    "Missing Supabase env vars for tests. Check .env.local has " +
      "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and " +
      "SUPABASE_SERVICE_ROLE_KEY (the last one is added manually, never " +
      "committed — see .env.example).",
  );
}

const admin = createSupabaseClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RUN_ID = Date.now().toString(36);

type TestTenant = { id: string; slug: string; ownerRoleId: string };
type TestUser = { id: string; email: string; password: string };

let tenantA: TestTenant;
let tenantB: TestTenant;
let userA: TestUser; // member of tenant A only
let userB: TestUser; // member of tenant B only
let platformAdminUser: TestUser;

function anonClient() {
  return createSupabaseClient(url!, publishableKey!);
}

async function createTestUser(label: string): Promise<TestUser> {
  const email = `test-${RUN_ID}-${label}@example.com`;
  const password = "Test1234!Test1234!";
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`failed to create test user ${label}: ${error?.message}`);
  }
  return { id: data.user.id, email, password };
}

/** Bypasses the onboarding RPC on purpose — isolation tests only need two
 * clean, independent tenants to exist, not to re-verify onboarding here. */
async function createTestTenant(
  slug: string,
  ownerId: string,
): Promise<TestTenant> {
  const { data: tenant, error: tenantError } = await admin
    .from("tenants")
    .insert({ name: `Test Tenant ${slug}`, slug, created_by: ownerId })
    .select("id")
    .single();
  if (tenantError || !tenant) {
    throw new Error(`failed to create test tenant: ${tenantError?.message}`);
  }

  const { data: template } = await admin
    .from("role_templates")
    .select("id, key, name, description")
    .eq("key", "SALON_OWNER")
    .single();
  if (!template) throw new Error("SALON_OWNER role template is missing");

  const { data: role, error: roleError } = await admin
    .from("roles")
    .insert({
      tenant_id: tenant.id,
      key: template.key,
      name: template.name,
      description: template.description,
      is_system_default: true,
      cloned_from_template_id: template.id,
    })
    .select("id")
    .single();
  if (roleError || !role) {
    throw new Error(`failed to create test role: ${roleError?.message}`);
  }

  const { data: templatePermissions } = await admin
    .from("role_template_permissions")
    .select("permission_id")
    .eq("role_template_id", template.id);

  if (templatePermissions && templatePermissions.length > 0) {
    await admin.from("role_permissions").insert(
      templatePermissions.map((p) => ({
        role_id: role.id,
        permission_id: p.permission_id,
      })),
    );
  }

  await admin.from("tenant_memberships").insert({
    tenant_id: tenant.id,
    user_id: ownerId,
    role_id: role.id,
    status: "active",
  });

  return { id: tenant.id, slug, ownerRoleId: role.id };
}

async function signInAs(user: TestUser) {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error)
    throw new Error(`failed to sign in as ${user.email}: ${error.message}`);
  return client;
}

beforeAll(async () => {
  userA = await createTestUser("user-a");
  userB = await createTestUser("user-b");
  platformAdminUser = await createTestUser("platform-admin");

  tenantA = await createTestTenant(`test-tenant-a-${RUN_ID}`, userA.id);
  tenantB = await createTestTenant(`test-tenant-b-${RUN_ID}`, userB.id);

  await admin
    .from("platform_admins")
    .insert({ user_id: platformAdminUser.id, role: "owner" });
}, 30000);

afterAll(async () => {
  // Children before parents (FK order). branches has no ON DELETE CASCADE
  // to tenants (deliberately — see 20260815120004), so the "member can
  // insert a branch" test's row must be removed explicitly or the tenants
  // delete below fails on a foreign-key violation. That failure is
  // returned as { error }, not thrown, so it was previously silent —
  // caught via leftover rows visible in /super-admin, not a test failure.
  await admin
    .from("branches")
    .delete()
    .in("tenant_id", [tenantA.id, tenantB.id]);
  await admin
    .from("tenant_memberships")
    .delete()
    .in("tenant_id", [tenantA.id, tenantB.id]);
  await admin
    .from("role_permissions")
    .delete()
    .in("role_id", [tenantA.ownerRoleId, tenantB.ownerRoleId]);
  await admin.from("roles").delete().in("tenant_id", [tenantA.id, tenantB.id]);
  const { error: tenantsDeleteError } = await admin
    .from("tenants")
    .delete()
    .in("id", [tenantA.id, tenantB.id]);
  if (tenantsDeleteError) {
    throw new Error(
      `afterAll: failed to delete test tenants: ${tenantsDeleteError.message}`,
    );
  }
  await admin
    .from("platform_admins")
    .delete()
    .eq("user_id", platformAdminUser.id);
  await admin.auth.admin.deleteUser(userA.id);
  await admin.auth.admin.deleteUser(userB.id);
  await admin.auth.admin.deleteUser(platformAdminUser.id);
}, 30000);

describe("cross-tenant isolation", () => {
  it("a member can read their own tenant", async () => {
    const client = await signInAs(userA);
    const { data, error } = await client
      .from("tenants")
      .select("id")
      .eq("id", tenantA.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("a member cannot read another tenant's row (silently filtered, not an error)", async () => {
    const client = await signInAs(userA);
    const { data, error } = await client
      .from("tenants")
      .select("id")
      .eq("id", tenantB.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("listing tenants only returns the caller's own", async () => {
    const client = await signInAs(userA);
    const { data } = await client.from("tenants").select("id");
    const ids = (data ?? []).map((t) => t.id);
    expect(ids).toContain(tenantA.id);
    expect(ids).not.toContain(tenantB.id);
  });

  it("a member cannot insert a branch into another tenant", async () => {
    const client = await signInAs(userA);
    const { error } = await client
      .from("branches")
      .insert({ tenant_id: tenantB.id, name: "Sızma Şube" });
    expect(error).not.toBeNull();
  });

  it("a member can insert a branch into their own tenant", async () => {
    const client = await signInAs(userA);
    const { error } = await client
      .from("branches")
      .insert({ tenant_id: tenantA.id, name: "Test Şube" });
    expect(error).toBeNull();
  });

  it("a member cannot read another tenant's memberships", async () => {
    const client = await signInAs(userA);
    const { data } = await client
      .from("tenant_memberships")
      .select("id")
      .eq("tenant_id", tenantB.id);
    expect(data).toHaveLength(0);
  });

  it("a member cannot read another tenant's roles", async () => {
    const client = await signInAs(userA);
    const { data } = await client
      .from("roles")
      .select("id")
      .eq("tenant_id", tenantB.id);
    expect(data).toHaveLength(0);
  });

  it("has_permission() is true for the owner on their own tenant", async () => {
    const client = await signInAs(userA);
    const { data, error } = await client.rpc("has_permission", {
      p_tenant_id: tenantA.id,
      p_permission_key: "staff.manage",
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  it("has_permission() is false for a tenant the user doesn't belong to", async () => {
    const client = await signInAs(userA);
    const { data } = await client.rpc("has_permission", {
      p_tenant_id: tenantB.id,
      p_permission_key: "staff.manage",
    });
    expect(data).toBe(false);
  });

  it("a regular member cannot see platform_admins at all", async () => {
    const client = await signInAs(userA);
    const { data } = await client.from("platform_admins").select("id");
    expect(data).toHaveLength(0);
  });

  it("is_platform_admin() is false for a regular tenant owner", async () => {
    const client = await signInAs(userA);
    const { data } = await client.rpc("is_platform_admin");
    expect(data).toBe(false);
  });

  it("a platform admin can read across both tenants", async () => {
    const client = await signInAs(platformAdminUser);
    const { data } = await client
      .from("tenants")
      .select("id")
      .in("id", [tenantA.id, tenantB.id]);
    const ids = (data ?? []).map((t) => t.id);
    expect(ids).toContain(tenantA.id);
    expect(ids).toContain(tenantB.id);
  });

  it("an unauthenticated client reads no tenants", async () => {
    const client = anonClient();
    const { data } = await client.from("tenants").select("id");
    expect(data).toHaveLength(0);
  });

  it("a member cannot escalate by updating their own membership row", async () => {
    const client = await signInAs(userA);

    const { data: before } = await admin
      .from("tenant_memberships")
      .select("id, status")
      .eq("tenant_id", tenantA.id)
      .eq("user_id", userA.id)
      .single();

    const { data: updateResult } = await client
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
