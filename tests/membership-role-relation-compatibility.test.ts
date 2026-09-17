import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMembership,
  cleanupTenants,
  cleanupUsers,
  createRoleForTenant,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1C.1R2 — 20260917081000 added a composite (role_id,
 * tenant_id) -> roles(id, tenant_id) FK alongside the pre-existing
 * plain (role_id) -> roles(id) FK, giving PostgREST two relationship
 * paths between tenant_memberships and roles and making any unhinted
 * `roles(name)` embed ambiguous — which would break the immediately
 * previous production application (still on the unhinted query shape)
 * if Vercel were ever rolled back after this schema shipped. This
 * migration drops the composite FK and replaces its integrity
 * guarantee with a plain BEFORE trigger instead, restoring exactly one
 * FK relationship while keeping the same-tenant invariant enforced at
 * the database level. These tests prove both the compatibility
 * restoration and that the invariant itself still holds.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let ownerAClient: SupabaseClient;
let roleA: string;
let roleB: string;

const createdUserIds: string[] = [];

beforeAll(async () => {
  ownerA = await createTestUser("mrc-owner-a");
  createdUserIds.push(ownerA.id);

  tenantA = await createTestTenant("test-tenant-mrc-a", ownerA.id);
  tenantB = await createTestTenant("test-tenant-mrc-b", ownerA.id);

  roleA = await createRoleForTenant(tenantA.id, "Rol A", ["appointments.view"]);
  roleB = await createRoleForTenant(tenantB.id, "Rol B", ["appointments.view"]);

  ownerAClient = await signInAs(ownerA);
}, 30000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers(createdUserIds);
}, 60000);

describe("exactly one tenant_memberships -> roles FK relationship", () => {
  it("relationship count is exactly 1, and it is the original, unrenamed FK", async () => {
    const rows = await testDb<{ conname: string; def: string }[]>`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'public.tenant_memberships'::regclass
        and confrelid = 'public.roles'::regclass
      order by conname
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conname).toBe("tenant_memberships_role_id_fkey");
    expect(rows[0]?.def).toBe("FOREIGN KEY (role_id) REFERENCES roles(id)");
  });

  it("tenant_memberships_role_same_tenant no longer exists", async () => {
    const rows = await testDb<{ conname: string }[]>`
      select conname from pg_constraint where conname = 'tenant_memberships_role_same_tenant'
    `;
    expect(rows).toHaveLength(0);
  });
});

describe("replacement trigger", () => {
  it("tenant_memberships_role_same_tenant_guard exists for INSERT and UPDATE", async () => {
    const rows = await testDb<{ event_manipulation: string; action_timing: string }[]>`
      select event_manipulation, action_timing from information_schema.triggers
      where event_object_table = 'tenant_memberships' and trigger_name = 'tenant_memberships_role_same_tenant_guard'
      order by event_manipulation
    `;
    expect(rows.map((r) => r.event_manipulation).sort()).toEqual(["INSERT", "UPDATE"]);
    expect(rows.every((r) => r.action_timing === "BEFORE")).toBe(true);
  });

  it("trigger function has no PUBLIC (or anon/authenticated) execute grant", async () => {
    const rows = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.routine_privileges
      where routine_name = 'assert_tenant_membership_role_same_tenant'
    `;
    const grantees = rows.map((r) => r.grantee);
    expect(grantees).not.toContain("PUBLIC");
    expect(grantees).not.toContain("anon");
    expect(grantees).not.toContain("authenticated");
  });
});

describe("PostgREST embed compatibility — both query shapes work simultaneously", () => {
  // ownerA's own membership uses the SALON_OWNER role ("Salon Sahibi")
  // that createTestTenant auto-creates for the tenant's owner — roleA
  // ("Rol A") is a separate, unused-by-ownerA role, exercised instead by
  // the cross-tenant integrity tests further down.
  it("the OLD unhinted roles(name) embed (previous production app's shape) succeeds", async () => {
    const { data, error } = await ownerAClient
      .from("tenant_memberships")
      .select("tenant_id, role_id, tenants(name, slug, status), roles(name)")
      .eq("user_id", ownerA.id)
      .eq("tenant_id", tenantA.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data![0] as unknown as { roles: { name: string } }).roles.name).toBe("Salon Sahibi");
  });

  it("the CURRENT explicit-hint embed still succeeds", async () => {
    const { data, error } = await ownerAClient
      .from("tenant_memberships")
      .select("tenant_id, role_id, roles!tenant_memberships_role_id_fkey(name)")
      .eq("user_id", ownerA.id)
      .eq("tenant_id", tenantA.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data![0] as unknown as { roles: { name: string } }).roles.name).toBe("Salon Sahibi");
  });

  it("getUserMemberships' exact query shape succeeds", async () => {
    const { data, error } = await ownerAClient
      .from("tenant_memberships")
      .select("tenant_id, role_id, tenants(name, slug, status), roles!tenant_memberships_role_id_fkey(name)")
      .eq("user_id", ownerA.id)
      .eq("status", "active")
      .is("deleted_at", null);
    expect(error).toBeNull();
    const row = data!.find((r) => r.tenant_id === tenantA.id) as { roles: { name: string } } | undefined;
    expect(row?.roles.name).toBe("Salon Sahibi");
  });

  it("getTenantAccess' exact query shape succeeds", async () => {
    const { data, error } = await ownerAClient
      .from("tenant_memberships")
      .select("id, status, role_id, roles!tenant_memberships_role_id_fkey(name)")
      .eq("tenant_id", tenantA.id)
      .eq("user_id", ownerA.id)
      .eq("status", "active")
      .is("deleted_at", null)
      .maybeSingle();
    expect(error).toBeNull();
    expect((data as unknown as { roles: { name: string } })?.roles.name).toBe("Salon Sahibi");
  });

  it("getAvailableMemberships' exact query shape succeeds", async () => {
    const { data, error } = await ownerAClient
      .from("tenant_memberships")
      .select("id, user_id, roles!tenant_memberships_role_id_fkey(name)")
      .eq("tenant_id", tenantA.id)
      .eq("status", "active")
      .is("deleted_at", null);
    expect(error).toBeNull();
    const row = data!.find((r) => r.user_id === ownerA.id) as { roles: { name: string } } | undefined;
    expect(row?.roles.name).toBe("Salon Sahibi");
  });
});

describe("cross-tenant integrity still enforced at the DB level", () => {
  it("blocks INSERT of a membership referencing a cross-tenant role", async () => {
    const otherUser = await createTestUser("mrc-xt-insert");
    createdUserIds.push(otherUser.id);

    await expect(
      testDb`
        insert into tenant_memberships (tenant_id, user_id, role_id, status)
        values (${tenantA.id}, ${otherUser.id}, ${roleB}, 'active')
      `,
    ).rejects.toThrow(/membership_role_tenant_mismatch/);

    const rows = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${otherUser.id}
    `;
    expect(rows).toHaveLength(0);
  });

  it("blocks UPDATE of role_id to a cross-tenant role", async () => {
    const otherUser = await createTestUser("mrc-xt-update");
    createdUserIds.push(otherUser.id);
    const membershipId = await addMembership(tenantA.id, otherUser.id, roleA);

    await expect(
      testDb`update tenant_memberships set role_id = ${roleB} where id = ${membershipId}`,
    ).rejects.toThrow(/membership_role_tenant_mismatch/);

    const [row] = await testDb<{ role_id: string }[]>`select role_id from tenant_memberships where id = ${membershipId}`;
    expect(row?.role_id).toBe(roleA);
  });

  it("still allows a status-only UPDATE — the trigger only fires on role_id/tenant_id changes", async () => {
    const otherUser = await createTestUser("mrc-status-update");
    createdUserIds.push(otherUser.id);
    const membershipId = await addMembership(tenantA.id, otherUser.id, roleA);

    await testDb`update tenant_memberships set status = 'suspended' where id = ${membershipId}`;
    const [row] = await testDb<{ status: string }[]>`select status from tenant_memberships where id = ${membershipId}`;
    expect(row?.status).toBe("suspended");
  });
});

describe("tenant bootstrap", () => {
  it("create_tenant still succeeds — the trigger allows normal bootstrap with no special bypass", async () => {
    const owner = await createTestUser("mrc-bootstrap");
    createdUserIds.push(owner.id);
    const client = await signInAs(owner);

    const { data, error } = await client.rpc("create_tenant", {
      p_name: "MRC Bootstrap Test",
      p_slug: `test-tenant-mrc-bootstrap-${Date.now().toString(36)}`,
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();

    await cleanupTenants([data as unknown as string]);
  });
});

describe("invitation acceptance regression", () => {
  it("accept_team_invitation still works and never creates a cross-tenant membership", async () => {
    const accepter = await createTestUser("mrc-accept");
    createdUserIds.push(accepter.id);

    const { data: invitation, error: createError } = await ownerAClient.rpc("create_team_invitation", {
      p_tenant_id: tenantA.id,
      p_email: accepter.email,
      p_role_id: roleA,
    });
    expect(createError).toBeNull();
    const token = (invitation as { token: string }[])[0]!.token;

    const accepterClient = await signInAs(accepter);
    const { data: acceptResult, error: acceptError } = await accepterClient.rpc("accept_team_invitation", {
      p_token: token,
    });
    expect(acceptError).toBeNull();
    const row = (acceptResult as { membership_id: string; tenant_id: string; role_id: string; outcome: string }[])[0]!;
    expect(row.outcome).toBe("accepted");
    expect(row.tenant_id).toBe(tenantA.id);
    expect(row.role_id).toBe(roleA);

    const [membership] = await testDb<{ tenant_id: string; role_id: string }[]>`
      select tenant_id, role_id from tenant_memberships where id = ${row.membership_id}
    `;
    expect(membership?.tenant_id).toBe(tenantA.id);
    expect(membership?.role_id).toBe(roleA);
  });
});

describe("role grants unchanged from SAAS.1C.1R", () => {
  it("authenticated retains SELECT-only on roles", async () => {
    const rows = await testDb<{ grantee: string; privilege_type: string }[]>`
      select grantee, privilege_type from security_audit_table_grants()
      where table_name = 'roles' and grantee in ('anon', 'authenticated')
    `;
    expect(rows).toEqual([{ grantee: "authenticated", privilege_type: "SELECT" }]);
  });
});
