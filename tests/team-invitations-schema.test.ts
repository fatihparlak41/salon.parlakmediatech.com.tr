import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anonClient,
  createRoleForTenant,
  createStaffMember,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  cleanupTenants,
  cleanupUsers,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1B — schema-only tests for public.team_invitations
 * (20260917070000). No invitation RPC exists yet (Faz SAAS.1C) — every
 * row here is inserted directly via testDb (the raw Postgres connection,
 * same convention as every other schema-level test in this project),
 * simulating what a future RPC will eventually write. Sections 12/13
 * (browser inaccessibility) go through REAL clients over the network —
 * an anon client and a genuinely signed-in tenant OWNER (full
 * permissions) — never testDb/admin, matching tests/permission-
 * ceiling.test.ts's own established "prove it against a real client,
 * never a bypass-everything connection" discipline.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let ownerB: TestUser;
let ownerAClient: SupabaseClient;
let roleA: string;
let roleB: string;
let staffA: { id: string; fullName: string };
const cleanupUserIds: string[] = [];

async function insertInvitation(overrides: Partial<{
  tenantId: string;
  email: string;
  roleId: string;
  staffMemberId: string | null;
  invitedBy: string;
  status: string;
  tokenHash: string;
  expiresAt: Date;
}> = {}): Promise<string> {
  const tenantId = overrides.tenantId ?? tenantA.id;
  const email = overrides.email ?? `invitee-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const roleId = overrides.roleId ?? roleA;
  const invitedBy = overrides.invitedBy ?? ownerA.id;
  const status = overrides.status ?? "pending";
  const tokenHash = overrides.tokenHash ?? `hash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const staffMemberId = overrides.staffMemberId === undefined ? null : overrides.staffMemberId;

  const [row] = await testDb<{ id: string }[]>`
    insert into team_invitations (tenant_id, email, role_id, staff_member_id, invited_by, status, token_hash, expires_at)
    values (${tenantId}, ${email}, ${roleId}, ${staffMemberId}, ${invitedBy}, ${status}, ${tokenHash}, ${expiresAt.toISOString()})
    returning id
  `;
  if (!row) throw new Error("failed to insert test team_invitations row");
  return row.id;
}

beforeAll(async () => {
  ownerA = await createTestUser("saas1b-owner-a");
  ownerB = await createTestUser("saas1b-owner-b");
  cleanupUserIds.push(ownerA.id, ownerB.id);

  tenantA = await createTestTenant("saas1b-invit-a", ownerA.id);
  tenantB = await createTestTenant("saas1b-invit-b", ownerB.id);

  roleA = await createRoleForTenant(tenantA.id, "SAAS.1B Test Role A", ["staff.view"]);
  roleB = await createRoleForTenant(tenantB.id, "SAAS.1B Test Role B", ["staff.view"]);

  staffA = await createStaffMember(tenantA.id, "SAAS.1B Staff A");

  ownerAClient = await signInAs(ownerA);
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers(cleanupUserIds);
}, 60000);

describe("team_invitations schema (Faz SAAS.1B)", () => {
  it("1. the table exists", async () => {
    const [row] = await testDb<{ exists: string | null }[]>`
      select to_regclass('public.team_invitations')::text as exists
    `;
    expect(row?.exists).toBe("team_invitations");
  });

  it("2. has exactly the expected columns and types", async () => {
    const columns = await testDb<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'team_invitations'
      order by column_name
    `;
    const byName = Object.fromEntries(columns.map((c) => [c.column_name, c]));

    expect(Object.keys(byName).sort()).toEqual(
      [
        "id", "tenant_id", "email", "role_id", "staff_member_id", "invited_by",
        "status", "token_hash", "expires_at", "accepted_at", "accepted_by",
        "revoked_at", "revoked_by", "created_at", "updated_at",
      ].sort(),
    );

    expect(byName.id!.data_type).toBe("uuid");
    expect(byName.id!.is_nullable).toBe("NO");
    expect(byName.tenant_id!.is_nullable).toBe("NO");
    expect(byName.email!.data_type).toBe("text");
    expect(byName.email!.is_nullable).toBe("NO");
    expect(byName.role_id!.is_nullable).toBe("NO");
    expect(byName.staff_member_id!.is_nullable).toBe("YES");
    expect(byName.invited_by!.is_nullable).toBe("NO");
    expect(byName.status!.data_type).toBe("text");
    expect(byName.status!.is_nullable).toBe("NO");
    expect(byName.token_hash!.is_nullable).toBe("NO");
    expect(byName.expires_at!.data_type).toBe("timestamp with time zone");
    expect(byName.expires_at!.is_nullable).toBe("NO");
    expect(byName.accepted_at!.is_nullable).toBe("YES");
    expect(byName.accepted_by!.is_nullable).toBe("YES");
    expect(byName.revoked_at!.is_nullable).toBe("YES");
    expect(byName.revoked_by!.is_nullable).toBe("YES");
  });

  it("3. status only accepts pending/accepted/expired/revoked", async () => {
    await expect(insertInvitation({ status: "bogus" })).rejects.toThrow();

    for (const status of ["pending", "accepted", "expired", "revoked"]) {
      await expect(insertInvitation({ status })).resolves.toBeTruthy();
    }
  });

  it("4. a non-normalized email is rejected", async () => {
    await expect(insertInvitation({ email: "  Mixed.Case@Example.com  " })).rejects.toThrow();
    await expect(insertInvitation({ email: "" })).rejects.toThrow();
    await expect(insertInvitation({ email: "already.normalized@example.com" })).resolves.toBeTruthy();
  });

  it("5. token_hash must be unique across invitations", async () => {
    const sharedHash = `shared-hash-${Date.now()}`;
    await insertInvitation({ tokenHash: sharedHash });
    await expect(insertInvitation({ tokenHash: sharedHash })).rejects.toThrow();
  });

  it("6. only one pending invitation per (tenant, normalized email)", async () => {
    const email = `dup-pending-${Date.now()}@example.com`;
    await insertInvitation({ email, status: "pending" });
    await expect(insertInvitation({ email, status: "pending" })).rejects.toThrow();
  });

  it("7. the same email may have a pending invitation in a different tenant", async () => {
    const email = `cross-tenant-${Date.now()}@example.com`;
    await expect(insertInvitation({ tenantId: tenantA.id, email, roleId: roleA, status: "pending" })).resolves.toBeTruthy();
    await expect(insertInvitation({ tenantId: tenantB.id, email, roleId: roleB, status: "pending" })).resolves.toBeTruthy();
  });

  it("8. accepted/revoked/expired historical rows never block a new pending invitation for the same (tenant, email)", async () => {
    const email = `historical-${Date.now()}@example.com`;
    for (const status of ["accepted", "revoked", "expired"]) {
      await insertInvitation({ email, status });
    }
    await expect(insertInvitation({ email, status: "pending" })).resolves.toBeTruthy();
  });

  it("9. role_id must belong to the same tenant (composite FK)", async () => {
    await expect(insertInvitation({ tenantId: tenantA.id, roleId: roleB })).rejects.toThrow();
    await expect(insertInvitation({ tenantId: tenantA.id, roleId: roleA })).resolves.toBeTruthy();
  });

  it("10. staff_member_id must belong to the same tenant (composite FK)", async () => {
    const staffB = await createStaffMember(tenantB.id, "SAAS.1B Staff B (other tenant)");
    await expect(insertInvitation({ tenantId: tenantA.id, staffMemberId: staffB.id })).rejects.toThrow();
    await expect(insertInvitation({ tenantId: tenantA.id, staffMemberId: staffA.id })).resolves.toBeTruthy();
  });

  it("11. staff_member_id may be NULL", async () => {
    await expect(insertInvitation({ staffMemberId: null })).resolves.toBeTruthy();
  });

  it("12. anon can neither SELECT, INSERT, UPDATE, nor DELETE", async () => {
    const client = anonClient();

    const select = await client.from("team_invitations").select("id");
    expect(select.error).not.toBeNull();

    const insert = await client.from("team_invitations").insert({
      tenant_id: tenantA.id, email: "anon-attempt@example.com", role_id: roleA,
      invited_by: ownerA.id, token_hash: `anon-${Date.now()}`,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(insert.error).not.toBeNull();

    const update = await client.from("team_invitations").update({ status: "revoked" }).eq("tenant_id", tenantA.id);
    expect(update.error).not.toBeNull();

    const del = await client.from("team_invitations").delete().eq("tenant_id", tenantA.id);
    expect(del.error).not.toBeNull();
  });

  it("13. an authenticated tenant owner (full permissions) still cannot access the table directly", async () => {
    const select = await ownerAClient.from("team_invitations").select("id");
    expect(select.error).not.toBeNull();

    const insert = await ownerAClient.from("team_invitations").insert({
      tenant_id: tenantA.id, email: "owner-direct-attempt@example.com", role_id: roleA,
      invited_by: ownerA.id, token_hash: `owner-direct-${Date.now()}`,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(insert.error).not.toBeNull();

    const update = await ownerAClient.from("team_invitations").update({ status: "revoked" }).eq("tenant_id", tenantA.id);
    expect(update.error).not.toBeNull();

    const del = await ownerAClient.from("team_invitations").delete().eq("tenant_id", tenantA.id);
    expect(del.error).not.toBeNull();
  });

  it("14. creating invitation fixtures never modifies existing tenant_memberships/staff_members rows", async () => {
    // A fresh staff member, not the shared staffA fixture: test 10 above
    // already left staffA with a live pending invitation, and Faz SAAS.1E.1's
    // one-pending-per-staff unique index (team_invitations_tenant_staff_
    // pending_idx) now refuses a second one for the same staff member —
    // this test's own point (inserting an invitation touches nothing else)
    // doesn't depend on which staff member it targets.
    const freshStaff = await createStaffMember(tenantA.id, "SAAS.1B Fixture Isolation Staff");
    const beforeMemberships = await testDb<{ id: string; role_id: string; status: string }[]>`
      select id, role_id, status from tenant_memberships where tenant_id = ${tenantA.id} order by id
    `;
    const beforeStaff = await testDb<{ id: string; tenant_membership_id: string | null }[]>`
      select id, tenant_membership_id from staff_members where tenant_id = ${tenantA.id} order by id
    `;

    await insertInvitation({ staffMemberId: freshStaff.id });

    const afterMemberships = await testDb<{ id: string; role_id: string; status: string }[]>`
      select id, role_id, status from tenant_memberships where tenant_id = ${tenantA.id} order by id
    `;
    const afterStaff = await testDb<{ id: string; tenant_membership_id: string | null }[]>`
      select id, tenant_membership_id from staff_members where tenant_id = ${tenantA.id} order by id
    `;

    expect(afterMemberships).toEqual(beforeMemberships);
    expect(afterStaff).toEqual(beforeStaff);
  });

  it("15. a staff_member with tenant_membership_id NULL remains a fully valid, queryable row", async () => {
    const noLoginStaff = await createStaffMember(tenantA.id, "SAAS.1B No-Login Staff");
    const [row] = await testDb<{ tenant_membership_id: string | null }[]>`
      select tenant_membership_id from staff_members where id = ${noLoginStaff.id}
    `;
    expect(row?.tenant_membership_id).toBeNull();
  });

  it("16. a membership can still back at most one staff row (existing unique behavior unchanged)", async () => {
    const [membershipRow] = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${ownerA.id}
    `;
    const membershipId = membershipRow!.id;

    await testDb`update staff_members set tenant_membership_id = ${membershipId} where id = ${staffA.id}`;

    const secondStaff = await createStaffMember(tenantA.id, "SAAS.1B Second Staff (same membership attempt)");
    await expect(
      testDb`update staff_members set tenant_membership_id = ${membershipId} where id = ${secondStaff.id}`,
    ).rejects.toThrow();

    // Restore, so this test doesn't leave staffA linked for any later test
    // in this file that assumes an unlinked staffA.
    await testDb`update staff_members set tenant_membership_id = null where id = ${staffA.id}`;
  });

  it("18. gökhanilhan-shaped tenant (staff outnumbering memberships, most staff unlinked) remains fully representable", async () => {
    // Mirrors gökhanilhan's real production composition (4 staff, 1
    // membership, 3 of the 4 staff unlinked) at a schema level, in DEV,
    // without touching PROD or gökhanilhan itself.
    const s2 = await createStaffMember(tenantA.id, "SAAS.1B Shape Staff 2");
    const s3 = await createStaffMember(tenantA.id, "SAAS.1B Shape Staff 3");

    const rows = await testDb<{ id: string; tenant_membership_id: string | null }[]>`
      select id, tenant_membership_id from staff_members where id in (${staffA.id}, ${s2.id}, ${s3.id})
    `;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.tenant_membership_id === null)).toBe(true);

    const [membershipCount] = await testDb<{ n: string }[]>`
      select count(*)::text as n from tenant_memberships where tenant_id = ${tenantA.id} and status = 'active'
    `;
    expect(Number(membershipCount!.n)).toBeGreaterThanOrEqual(1);
  });
});
