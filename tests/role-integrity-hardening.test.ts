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
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1C.1R — pre-release role integrity hardening. Fresh audit
 * found public.roles granting authenticated a full table-level UPDATE
 * (every column, gated only by staff.manage in RLS — no column
 * restriction), with private.has_permission() never joining roles at
 * all, so it never independently enforced roles.tenant_id or
 * roles.deleted_at. See 20260917081000_role_integrity_hardening.sql's
 * own header for the full audit and reasoning. These tests exercise the
 * three-part fix directly: the revoked UPDATE grant, the new composite
 * tenant_memberships(role_id, tenant_id) -> roles(id, tenant_id) FK, and
 * accept_team_invitation's extended role-tenant check.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let limitedA: TestUser;

let ownerAClient: SupabaseClient;
let limitedAClient: SupabaseClient;

let roleA: string;

const createdUserIds: string[] = [];

beforeAll(async () => {
  ownerA = await createTestUser("rih-owner-a");
  limitedA = await createTestUser("rih-limited-a");
  createdUserIds.push(ownerA.id, limitedA.id);

  tenantA = await createTestTenant("test-tenant-rih-a", ownerA.id);
  tenantB = await createTestTenant("test-tenant-rih-b", ownerA.id);

  roleA = await createRoleForTenant(tenantA.id, "Sınırlı", ["appointments.view"]);
  await addMembership(tenantA.id, limitedA.id, roleA);

  ownerAClient = await signInAs(ownerA);
  limitedAClient = await signInAs(limitedA);
}, 30000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers(createdUserIds);
}, 60000);

describe("authenticated cannot mutate roles directly", () => {
  it("cannot mutate roles.tenant_id", async () => {
    const { error } = await ownerAClient.from("roles").update({ tenant_id: tenantB.id }).eq("id", roleA);
    expect(error).not.toBeNull();

    const [row] = await testDb<{ tenant_id: string }[]>`select tenant_id from roles where id = ${roleA}`;
    expect(row?.tenant_id).toBe(tenantA.id);
  });

  it("cannot mutate roles.deleted_at", async () => {
    const { error } = await ownerAClient.from("roles").update({ deleted_at: new Date().toISOString() }).eq("id", roleA);
    expect(error).not.toBeNull();

    const [row] = await testDb<{ deleted_at: string | null }[]>`select deleted_at from roles where id = ${roleA}`;
    expect(row?.deleted_at).toBeNull();
  });

  it("cannot mutate any other roles column either — the grant itself is gone, not just RLS on these two", async () => {
    const { error } = await ownerAClient.from("roles").update({ name: "Renamed via PostgREST" }).eq("id", roleA);
    expect(error).not.toBeNull();

    const [row] = await testDb<{ name: string }[]>`select name from roles where id = ${roleA}`;
    expect(row?.name).toBe("Sınırlı");
  });

  it("still allows the intended read path (SELECT was never revoked)", async () => {
    const { data, error } = await limitedAClient.from("roles").select("id, name").eq("id", roleA).maybeSingle();
    expect(error).toBeNull();
    expect(data?.name).toBe("Sınırlı");
  });
});

describe("membership/role same-tenant integrity", () => {
  // Enforced by the composite tenant_memberships_role_same_tenant FK as
  // of this file's own original SAAS.1C.1R phase; replaced in
  // SAAS.1C.1R2 by a plain BEFORE trigger (raising
  // membership_role_tenant_mismatch) to restore PostgREST embed
  // backward-compatibility — see 20260917082000's own migration header.
  // The invariant itself (a membership can never reference a
  // cross-tenant role) is unchanged, only its enforcement mechanism.
  it("blocks a membership row referencing a cross-tenant role", async () => {
    await expect(
      testDb`
        insert into tenant_memberships (tenant_id, user_id, role_id, status)
        values (${tenantB.id}, ${limitedA.id}, ${roleA}, 'active')
      `,
    ).rejects.toThrow(/membership_role_tenant_mismatch/);

    const rows = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${tenantB.id} and user_id = ${limitedA.id}
    `;
    expect(rows).toHaveLength(0);
  });

  it("still allows a same-tenant membership/role relationship", async () => {
    const secondRole = await createRoleForTenant(tenantA.id, "İkinci Rol", ["appointments.view"]);
    const secondUser = await createTestUser("rih-same-tenant");
    createdUserIds.push(secondUser.id);

    const [row] = await testDb<{ id: string }[]>`
      insert into tenant_memberships (tenant_id, user_id, role_id, status)
      values (${tenantA.id}, ${secondUser.id}, ${secondRole}, 'active')
      returning id
    `;
    expect(row?.id).toBeTruthy();
  });
});

describe("role_permissions editing still works through the intended RPC", () => {
  it("update_role_permissions still succeeds — unaffected by the revoked roles UPDATE grant", async () => {
    const { error } = await ownerAClient.rpc("update_role_permissions", {
      p_role_id: roleA,
      p_permission_keys: ["appointments.view", "staff.manage"],
    });
    expect(error).toBeNull();

    const perms = await testDb<{ key: string }[]>`
      select p.key from role_permissions rp join permissions p on p.id = rp.permission_id
      where rp.role_id = ${roleA} order by p.key
    `;
    expect(perms.map((p) => p.key).sort()).toEqual(["appointments.view", "staff.manage"]);
  });
});

describe("accept_team_invitation's extended role-tenant check", () => {
  it("a live invitation structurally prevents its own role from being rescoped to another tenant", async () => {
    // Attempting the exact setup this check exists to defend against —
    // rescoping a role's tenant_id while an invitation still targets it
    // — is itself blocked at the FK level: team_invitations' own
    // role_same_tenant composite FK (Faz SAAS.1B) already makes this
    // state unreachable, independent of and in addition to the new
    // tenant_memberships composite FK and the revoked roles UPDATE
    // grant. Three independent layers now hold this invariant.
    const accepter = await createTestUser("rih-accept-crosstenant");
    createdUserIds.push(accepter.id);

    const targetRole = await createRoleForTenant(tenantA.id, "Hedef Rol", ["appointments.view"]);
    const { data: invitation, error: createError } = await ownerAClient.rpc("create_team_invitation", {
      p_tenant_id: tenantA.id,
      p_email: accepter.email,
      p_role_id: targetRole,
    });
    expect(createError).toBeNull();
    void invitation;

    await expect(
      testDb`update roles set tenant_id = ${tenantB.id} where id = ${targetRole}`,
    ).rejects.toThrow(/team_invitations_role_same_tenant/);

    const [row] = await testDb<{ tenant_id: string }[]>`select tenant_id from roles where id = ${targetRole}`;
    expect(row?.tenant_id).toBe(tenantA.id);
  });

  it("rejects acceptance outright when the token's invitation row is simply gone (defensive not-found path)", async () => {
    const accepter = await createTestUser("rih-accept-notfound");
    createdUserIds.push(accepter.id);
    const accepterClient = await signInAs(accepter);

    const { error } = await accepterClient.rpc("accept_team_invitation", { p_token: randomTokenHex() });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/invitation_not_found/);
  });
});
