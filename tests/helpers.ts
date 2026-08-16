import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !publishableKey || !serviceRoleKey) {
  throw new Error(
    "Missing Supabase env vars for tests. Check .env.local has " +
      "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and " +
      "SUPABASE_SERVICE_ROLE_KEY (added manually, never committed — see " +
      ".env.example). Never paste the service role key in chat.",
  );
}

/** Fixture setup/teardown only — real assertions always use a signed-in
 * user's own client (anonClient() + signInAs()), never this one, or the
 * test proves nothing about what RLS actually allows. */
export const admin = createSupabaseClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export type TestUser = { id: string; email: string; password: string };
export type TestTenant = { id: string; slug: string; ownerRoleId: string };

export function anonClient() {
  return createSupabaseClient<Database>(url!, publishableKey!);
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createTestUser(label: string): Promise<TestUser> {
  const email = `test-${uniqueSuffix()}-${label}@example.com`;
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

export async function signInAs(user: TestUser) {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) {
    throw new Error(`failed to sign in as ${user.email}: ${error.message}`);
  }
  return client;
}

/** Tenant with the SALON_OWNER template cloned as-is (full permission
 * set, including permissions.manage_unrestricted) for `ownerId`. */
export async function createTestTenant(
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
    await admin
      .from("role_permissions")
      .insert(templatePermissions.map((p) => ({ role_id: role.id, permission_id: p.permission_id })));
  }

  await admin
    .from("tenant_memberships")
    .insert({ tenant_id: tenant.id, user_id: ownerId, role_id: role.id, status: "active" });

  return { id: tenant.id, slug, ownerRoleId: role.id };
}

/** A role with exactly `permissionKeys` — for building a deliberately
 * limited (non-owner) tenant member. Not attached to any membership. */
export async function createRoleForTenant(
  tenantId: string,
  name: string,
  permissionKeys: string[],
): Promise<string> {
  const { data: role, error } = await admin
    .from("roles")
    .insert({ tenant_id: tenantId, name, is_system_default: false })
    .select("id")
    .single();
  if (error || !role) {
    throw new Error(`failed to create role "${name}": ${error?.message}`);
  }

  if (permissionKeys.length > 0) {
    const { data: perms } = await admin.from("permissions").select("id, key").in("key", permissionKeys);
    if (perms && perms.length > 0) {
      await admin
        .from("role_permissions")
        .insert(perms.map((p) => ({ role_id: role.id, permission_id: p.id })));
    }
  }

  return role.id;
}

export async function addMembership(
  tenantId: string,
  userId: string,
  roleId: string,
): Promise<string> {
  const { data, error } = await admin
    .from("tenant_memberships")
    .insert({ tenant_id: tenantId, user_id: userId, role_id: roleId, status: "active" })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`failed to create membership: ${error?.message}`);
  }
  return data.id;
}

/**
 * FK-safe teardown, in dependency order. audit_logs and branches are the
 * two easy-to-forget ones — private.log_audit_event() and the "insert a
 * branch" test both leave rows that block a plain tenants delete (found
 * the hard way twice in Faz 1/1.5, see supabase/migrations/README.md).
 * Every test file's afterAll should route through this rather than
 * reimplementing the order.
 */
export async function cleanupTenants(tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return;

  await admin.from("audit_logs").delete().in("tenant_id", tenantIds);
  await admin.from("branches").delete().in("tenant_id", tenantIds);
  await admin.from("tenant_memberships").delete().in("tenant_id", tenantIds);

  const { data: roles } = await admin.from("roles").select("id").in("tenant_id", tenantIds);
  const roleIds = (roles ?? []).map((r) => r.id);
  if (roleIds.length > 0) {
    await admin.from("role_permissions").delete().in("role_id", roleIds);
  }
  await admin.from("roles").delete().in("tenant_id", tenantIds);

  const { error } = await admin.from("tenants").delete().in("id", tenantIds);
  if (error) {
    throw new Error(`cleanupTenants: failed to delete tenants: ${error.message}`);
  }
}

export async function cleanupUsers(userIds: string[]): Promise<void> {
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id);
  }
}

export async function cleanupPlatformAdmins(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await admin.from("platform_admins").delete().in("user_id", userIds);
}
