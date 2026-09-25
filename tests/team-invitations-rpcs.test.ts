import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMembership,
  anonClient,
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

/**
 * Faz SAAS.1C.1 — create/list/resend/revoke/accept RPCs on top of
 * public.team_invitations (schema from 20260917070000). No outbound
 * email in this phase — tokens are read directly out of the RPC
 * response / DB for test purposes only.
 *
 * Same "real client over the network, never admin/testDb, for
 * security-boundary assertions" discipline as permission-ceiling.test.ts
 * and cross-tenant-isolation.test.ts. A handful of signed-in clients are
 * reused across many scenarios by targeting a *fresh tenant* per
 * scenario rather than a fresh user — tenant_memberships is unique per
 * (tenant, user), so the same user can accept into many different
 * tenants without collision, keeping this file's total sign-in count
 * (and therefore Supabase Auth's password rate limit exposure) low.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;

let ownerA: TestUser;
let managerA: TestUser;
let existingActiveUser: TestUser;
let existingSuspendedUser: TestUser;
let primaryAccepter: TestUser;
let secondAccepter: TestUser;

let ownerAClient: SupabaseClient;
let managerAClient: SupabaseClient;
let primaryAccepterClient: SupabaseClient;

let limitedRoleId: string; // tenantA — appointments.view only, within managerA's ceiling
let managerRoleId: string; // tenantA — staff.manage only (not manage_unrestricted)
let staffMemberA: string; // tenantA, unlinked

const createdUserIds: string[] = [];

beforeAll(async () => {
  ownerA = await createTestUser("inv-owner-a");
  managerA = await createTestUser("inv-manager-a");
  existingActiveUser = await createTestUser("inv-existing-active");
  existingSuspendedUser = await createTestUser("inv-existing-suspended");
  primaryAccepter = await createTestUser("inv-accepter-primary");
  secondAccepter = await createTestUser("inv-accepter-second");
  createdUserIds.push(
    ownerA.id,
    managerA.id,
    existingActiveUser.id,
    existingSuspendedUser.id,
    primaryAccepter.id,
    secondAccepter.id,
  );

  tenantA = await createTestTenant("test-tenant-inv-a", ownerA.id);
  tenantB = await createTestTenant("test-tenant-inv-b", ownerA.id);

  // Holds appointments.view too (not just staff.manage) so "manager can
  // invite a role within their ceiling" has a role it's actually able to
  // grant — caller_can_grant_permissions requires holding every target
  // permission, not just staff.manage.
  managerRoleId = await createRoleForTenant(tenantA.id, "Yönetici", ["staff.manage", "appointments.view"]);
  await addMembership(tenantA.id, managerA.id, managerRoleId);

  limitedRoleId = await createRoleForTenant(tenantA.id, "Sınırlı Davet Rolü", ["appointments.view"]);

  await addMembership(tenantA.id, existingActiveUser.id, limitedRoleId);
  const suspendedMembershipId = await addMembership(tenantA.id, existingSuspendedUser.id, limitedRoleId);
  await testDb`update tenant_memberships set status = 'suspended' where id = ${suspendedMembershipId}`;

  const [staff] = await testDb<{ id: string }[]>`
    insert into staff_members (tenant_id, full_name) values (${tenantA.id}, 'Test Staff A') returning id
  `;
  staffMemberA = staff!.id;

  ownerAClient = await signInAs(ownerA);
  managerAClient = await signInAs(managerA);
  primaryAccepterClient = await signInAs(primaryAccepter);
}, 60000);

const createdTenantIds: string[] = [];

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id, ...createdTenantIds]);
  await cleanupUsers(createdUserIds);
}, 90000);

type CreateResult = {
  id: string;
  tenant_id: string;
  email: string;
  role_id: string;
  staff_member_id: string | null;
  status: string;
  expires_at: string;
  created_at: string;
  token: string;
};

async function createInvitation(
  client: SupabaseClient,
  args: { tenantId: string; email: string; roleId: string; staffMemberId?: string | null },
) {
  const { data, error } = await client.rpc("create_team_invitation", {
    p_tenant_id: args.tenantId,
    p_email: args.email,
    p_role_id: args.roleId,
    p_staff_member_id: args.staffMemberId ?? null,
  });
  return { data: (data as CreateResult[] | null)?.[0] ?? null, error };
}

/** A fresh single-use tenant + owner-signed invite target, for ACCEPT
 * scenarios that just need "some tenant, some role, an invitation
 * pointed at a known accepter email" without touching tenantA/B's own
 * shared fixture state. */
async function freshInviteTarget(slugSuffix: string, email: string, staffMemberId: string | null = null) {
  const tenant = await createTestTenant(`test-tenant-inv-${slugSuffix}`, ownerA.id);
  const roleId = await createRoleForTenant(tenant.id, "Sınırlı", ["appointments.view"]);
  const { data, error } = await createInvitation(ownerAClient, {
    tenantId: tenant.id,
    email,
    roleId,
    staffMemberId,
  });
  if (error || !data) throw new Error(`freshInviteTarget setup failed: ${error?.message}`);
  return { tenant, roleId, invitation: data };
}

describe("CREATE", () => {
  it("owner can invite an eligible role, including the unrestricted owner role", async () => {
    const { data, error } = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-create-owner-${Date.now().toString(36)}@example.com`,
      roleId: tenantA.ownerRoleId,
    });
    expect(error).toBeNull();
    expect(data?.status).toBe("pending");
    expect(typeof data?.token).toBe("string");
    expect(data!.token.length).toBeGreaterThanOrEqual(64);
  });

  it("manager can invite a role within their ceiling", async () => {
    const { data, error } = await createInvitation(managerAClient, {
      tenantId: tenantA.id,
      email: `inv-create-mgr-ok-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
    });
    expect(error).toBeNull();
    expect(data?.status).toBe("pending");
  });

  it("manager cannot invite into the unrestricted owner role", async () => {
    const { data, error } = await createInvitation(managerAClient, {
      tenantId: tenantA.id,
      email: `inv-create-mgr-fail-${Date.now().toString(36)}@example.com`,
      roleId: tenantA.ownerRoleId,
    });
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("rejects a role belonging to another tenant", async () => {
    const { error } = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-create-crosstenant-role-${Date.now().toString(36)}@example.com`,
      roleId: tenantB.ownerRoleId,
    });
    expect(error).not.toBeNull();
  });

  it("rejects a staff_member_id belonging to another tenant", async () => {
    const [staffB] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name) values (${tenantB.id}, 'Staff B') returning id
    `;
    const { error } = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-create-crosstenant-staff-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
      staffMemberId: staffB!.id,
    });
    expect(error).not.toBeNull();
  });

  it("blocks inviting an email that already has an active membership", async () => {
    const { error } = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: existingActiveUser.email,
      roleId: limitedRoleId,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/already_member/);
  });

  it("blocks inviting an email that has a suspended membership, without reactivating it", async () => {
    const { error } = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: existingSuspendedUser.email,
      roleId: limitedRoleId,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/membership_suspended/);

    const [row] = await testDb<{ status: string }[]>`
      select status from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${existingSuspendedUser.id}
    `;
    expect(row?.status).toBe("suspended");
  });

  it("blocks a duplicate pending invitation for the same tenant+email", async () => {
    const email = `inv-create-dup-${Date.now().toString(36)}@example.com`;
    const first = await createInvitation(ownerAClient, { tenantId: tenantA.id, email, roleId: limitedRoleId });
    expect(first.error).toBeNull();

    const second = await createInvitation(ownerAClient, { tenantId: tenantA.id, email, roleId: limitedRoleId });
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toMatch(/pending_invitation_exists/);
  });

  it("transitions a stale expired-but-pending invitation before creating the replacement", async () => {
    const email = `inv-create-stale-${Date.now().toString(36)}@example.com`;
    const rawToken = randomTokenHex();
    const [stale] = await testDb<{ id: string }[]>`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenantA.id}, ${email}, ${limitedRoleId}, ${ownerA.id}, 'pending', ${sha256Hex(rawToken)}, now() - interval '1 hour', now() - interval '8 days')
      returning id
    `;

    const { data, error } = await createInvitation(ownerAClient, { tenantId: tenantA.id, email, roleId: limitedRoleId });
    expect(error).toBeNull();
    expect(data?.status).toBe("pending");

    const [staleRow] = await testDb<{ status: string }[]>`select status from team_invitations where id = ${stale!.id}`;
    expect(staleRow?.status).toBe("expired");
  });

  it("normalizes email casing and whitespace", async () => {
    const suffix = Date.now().toString(36);
    const { data, error } = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `  InV-Create-Norm-${suffix}@EXAMPLE.com  `,
      roleId: limitedRoleId,
    });
    expect(error).toBeNull();
    expect(data?.email).toBe(`inv-create-norm-${suffix}@example.com`);
  });

  it("sets a 7-day expiry", async () => {
    const { data, error } = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-create-expiry-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
    });
    expect(error).toBeNull();
    const expiresAt = new Date(data!.expires_at).getTime();
    const expected = Date.now() + 7 * 24 * 3600_000;
    expect(Math.abs(expiresAt - expected)).toBeLessThan(60_000);
  });

  it("never stores the raw token — only its SHA-256 hash", async () => {
    const { data, error } = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-create-hash-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
    });
    expect(error).toBeNull();

    const [row] = await testDb<{ token_hash: string }[]>`select token_hash from team_invitations where id = ${data!.id}`;
    expect(row?.token_hash).toBe(sha256Hex(data!.token));
    expect(row?.token_hash).not.toBe(data!.token);
  });

  it("produces a unique token_hash per invitation", async () => {
    const a = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-create-uniq-a-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
    });
    const b = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-create-uniq-b-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
    });
    expect(a.data!.token).not.toBe(b.data!.token);

    const rows = await testDb<{ token_hash: string }[]>`
      select token_hash from team_invitations where id in ${testDb([a.data!.id, b.data!.id])}
    `;
    expect(rows[0]?.token_hash).not.toBe(rows[1]?.token_hash);
  });
});

describe("RESEND", () => {
  it("rotates the token on a valid pending invitation", async () => {
    const created = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-resend-rotate-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
    });
    const { data, error } = await ownerAClient.rpc("resend_team_invitation", {
      p_invitation_id: created.data!.id,
      p_expected_expires_at: created.data!.expires_at,
    });
    const row = (data as { id: string; status: string; expires_at: string; token: string }[] | null)?.[0];
    expect(error).toBeNull();
    expect(row?.status).toBe("pending");
    expect(row?.token).not.toBe(created.data!.token);
  });

  it("invalidates the old token and accepts only the new one", async () => {
    const email = primaryAccepter.email;
    const tenant = await createTestTenant(`test-tenant-inv-resend-${Date.now().toString(36)}`, ownerA.id);
    createdTenantIds.push(tenant.id);
    const created = await createInvitation(ownerAClient, { tenantId: tenant.id, email, roleId: tenant.ownerRoleId });

    const { data } = await ownerAClient.rpc("resend_team_invitation", {
      p_invitation_id: created.data!.id,
      p_expected_expires_at: created.data!.expires_at,
    });
    const newToken = (data as { token: string }[])[0]!.token;

    const oldAttempt = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: created.data!.token });
    expect(oldAttempt.error).not.toBeNull();
    expect(oldAttempt.error?.message).toMatch(/invitation_not_found/);

    const newAttempt = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: newToken });
    expect(newAttempt.error).toBeNull();
    const acceptRow = (newAttempt.data as { outcome: string }[])[0];
    expect(acceptRow?.outcome).toBe("accepted");
  });

  it("renews expiry to a fresh 7 days", async () => {
    const created = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-resend-expiry-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
    });
    const { data } = await ownerAClient.rpc("resend_team_invitation", {
      p_invitation_id: created.data!.id,
      p_expected_expires_at: created.data!.expires_at,
    });
    const row = (data as { expires_at: string }[])[0]!;
    const expected = Date.now() + 7 * 24 * 3600_000;
    expect(Math.abs(new Date(row.expires_at).getTime() - expected)).toBeLessThan(60_000);
  });

  it("transitions an expired-but-pending invitation to expired instead of resurrecting it", async () => {
    const email = `inv-resend-stale-${Date.now().toString(36)}@example.com`;
    const rawToken = randomTokenHex();
    const [stale] = await testDb<{ id: string; expires_at: string }[]>`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenantA.id}, ${email}, ${limitedRoleId}, ${ownerA.id}, 'pending', ${sha256Hex(rawToken)}, now() - interval '1 hour', now() - interval '8 days')
      returning id, expires_at
    `;

    // The expiry check fires before the fencing check (see this
    // migration's own header — expiry is a terminal fact regardless of
    // what the caller expected to see), so the exact value passed here
    // is never actually compared for this specific case; passed anyway
    // for a realistic, non-vacuous call.
    const { data, error } = await ownerAClient.rpc("resend_team_invitation", {
      p_invitation_id: stale!.id,
      p_expected_expires_at: stale!.expires_at,
    });
    const row = (data as { status: string; token: string | null }[] | null)?.[0];
    expect(error).toBeNull();
    expect(row?.status).toBe("expired");
    expect(row?.token).toBeNull();

    const [dbRow] = await testDb<{ status: string }[]>`select status from team_invitations where id = ${stale!.id}`;
    expect(dbRow?.status).toBe("expired");
  });

  it("cannot resend a revoked or accepted invitation", async () => {
    const revokedTarget = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-resend-revoked-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
    });
    await ownerAClient.rpc("revoke_team_invitation", { p_invitation_id: revokedTarget.data!.id });

    // status-not-pending fires before fencing, same reasoning as the
    // stale-expiry case above — the value here is never compared.
    const { error } = await ownerAClient.rpc("resend_team_invitation", {
      p_invitation_id: revokedTarget.data!.id,
      p_expected_expires_at: revokedTarget.data!.expires_at,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/invitation_not_pending/);
  });

  it("enforces permission ceiling on resend", async () => {
    const created = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-resend-ceiling-${Date.now().toString(36)}@example.com`,
      roleId: tenantA.ownerRoleId,
    });
    const { error } = await managerAClient.rpc("resend_team_invitation", {
      p_invitation_id: created.data!.id,
      p_expected_expires_at: created.data!.expires_at,
    });
    expect(error).not.toBeNull();
  });
});

describe("REVOKE", () => {
  it("revokes a valid pending invitation", async () => {
    const created = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-revoke-ok-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
    });
    const { data, error } = await ownerAClient.rpc("revoke_team_invitation", { p_invitation_id: created.data!.id });
    expect(error).toBeNull();
    expect((data as { status: string }[])[0]?.status).toBe("revoked");

    const [row] = await testDb<{ revoked_at: string | null; revoked_by: string | null }[]>`
      select revoked_at, revoked_by from team_invitations where id = ${created.data!.id}
    `;
    expect(row?.revoked_at).not.toBeNull();
    expect(row?.revoked_by).toBe(ownerA.id);
  });

  it("protects terminal states from being revoked again", async () => {
    const created = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-revoke-terminal-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
    });
    await ownerAClient.rpc("revoke_team_invitation", { p_invitation_id: created.data!.id });

    const { error } = await ownerAClient.rpc("revoke_team_invitation", { p_invitation_id: created.data!.id });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/invitation_not_pending/);
  });

  it("transitions an expired-but-pending invitation to expired on revoke", async () => {
    const email = `inv-revoke-stale-${Date.now().toString(36)}@example.com`;
    const rawToken = randomTokenHex();
    const [stale] = await testDb<{ id: string }[]>`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenantA.id}, ${email}, ${limitedRoleId}, ${ownerA.id}, 'pending', ${sha256Hex(rawToken)}, now() - interval '1 hour', now() - interval '8 days')
      returning id
    `;
    const { data, error } = await ownerAClient.rpc("revoke_team_invitation", { p_invitation_id: stale!.id });
    expect(error).toBeNull();
    expect((data as { status: string }[])[0]?.status).toBe("expired");
  });

  it("enforces permission ceiling on revoke", async () => {
    const created = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-revoke-ceiling-${Date.now().toString(36)}@example.com`,
      roleId: tenantA.ownerRoleId,
    });
    const { error } = await managerAClient.rpc("revoke_team_invitation", { p_invitation_id: created.data!.id });
    expect(error).not.toBeNull();
  });
});

describe("LIST", () => {
  it("returns management fields with effective_status, never the token", async () => {
    const created = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-list-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
      staffMemberId: staffMemberA,
    });
    const { data, error } = await ownerAClient.rpc("list_team_invitations", { p_tenant_id: tenantA.id });
    expect(error).toBeNull();
    const row = (data as Record<string, unknown>[]).find((r) => r.id === created.data!.id);
    expect(row).toBeTruthy();
    expect(row!.status).toBe("pending");
    expect(row!.effective_status).toBe("pending");
    expect(row!.staff_member_id).toBe(staffMemberA);
    expect(row!.staff_member_name).toBe("Test Staff A");
    expect(row).not.toHaveProperty("token_hash");
    expect(row).not.toHaveProperty("token");
  });

  it("reports effective_status=expired for a stale pending row without mutating persisted status", async () => {
    const email = `inv-list-stale-${Date.now().toString(36)}@example.com`;
    const rawToken = randomTokenHex();
    const [stale] = await testDb<{ id: string }[]>`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenantA.id}, ${email}, ${limitedRoleId}, ${ownerA.id}, 'pending', ${sha256Hex(rawToken)}, now() - interval '1 hour', now() - interval '8 days')
      returning id
    `;
    const { data } = await ownerAClient.rpc("list_team_invitations", { p_tenant_id: tenantA.id });
    const row = (data as Record<string, unknown>[]).find((r) => r.id === stale!.id);
    expect(row!.status).toBe("pending");
    expect(row!.effective_status).toBe("expired");
  });
});

describe("ACCEPT", () => {
  it("accepts with the correct matching email", async () => {
    const target = await freshInviteTarget(`accept-ok-${Date.now().toString(36)}`, primaryAccepter.email);
    createdTenantIds.push(target.tenant.id);

    const { data, error } = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: target.invitation.token });
    expect(error).toBeNull();
    const row = (data as { membership_id: string; tenant_id: string; role_id: string; outcome: string }[])[0]!;
    expect(row.outcome).toBe("accepted");
    expect(row.tenant_id).toBe(target.tenant.id);
    expect(row.role_id).toBe(target.roleId);

    const [membership] = await testDb<{ tenant_id: string; user_id: string; role_id: string; status: string }[]>`
      select tenant_id, user_id, role_id, status from tenant_memberships where id = ${row.membership_id}
    `;
    expect(membership?.tenant_id).toBe(target.tenant.id);
    expect(membership?.user_id).toBe(primaryAccepter.id);
    expect(membership?.role_id).toBe(target.roleId);
    expect(membership?.status).toBe("active");
  });

  it("rejects a mismatched email", async () => {
    const target = await freshInviteTarget(`accept-wrongemail-${Date.now().toString(36)}`, "someone-else@example.com");
    createdTenantIds.push(target.tenant.id);

    const { error } = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: target.invitation.token });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/invitation_email_mismatch/);
  });

  it("rejects an unauthenticated caller", async () => {
    const target = await freshInviteTarget(`accept-unauth-${Date.now().toString(36)}`, "whoever@example.com");
    createdTenantIds.push(target.tenant.id);

    const { error } = await anonClient().rpc("accept_team_invitation", { p_token: target.invitation.token });
    expect(error).not.toBeNull();
  });

  it("rejects an expired invitation", async () => {
    const tenant = await createTestTenant(`test-tenant-inv-accept-expired-${Date.now().toString(36)}`, ownerA.id);
    createdTenantIds.push(tenant.id);
    const rawToken = randomTokenHex();
    await testDb`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
      values (${tenant.id}, ${primaryAccepter.email}, ${tenant.ownerRoleId}, ${ownerA.id}, 'pending', ${sha256Hex(rawToken)}, now() - interval '1 hour', now() - interval '8 days')
    `;

    const { error } = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: rawToken });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/invitation_expired/);
  });

  it("rejects a revoked invitation", async () => {
    const target = await freshInviteTarget(`accept-revoked-${Date.now().toString(36)}`, primaryAccepter.email);
    createdTenantIds.push(target.tenant.id);
    await ownerAClient.rpc("revoke_team_invitation", { p_invitation_id: target.invitation.id });

    const { error } = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: target.invitation.token });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/invitation_revoked/);
  });

  it("gives the caller exactly the invitation's role — accept takes no role parameter", async () => {
    // Signature-level proof: accept_team_invitation(p_token) accepts no
    // role/tenant override, so a caller can never swap in a different
    // role than the one the invitation was created with.
    const rows = await testDb<{ args: string }[]>`
      select pg_get_function_identity_arguments('public.accept_team_invitation(text)'::regprocedure) as args
    `;
    expect(rows[0]?.args).toBe("p_token text");
  });

  it("blocks a forged cross-tenant accept — a token only ever resolves its own invitation's tenant", async () => {
    const targetA = await freshInviteTarget(`accept-forge-a-${Date.now().toString(36)}`, primaryAccepter.email);
    createdTenantIds.push(targetA.tenant.id);

    const { data, error } = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: targetA.invitation.token });
    expect(error).toBeNull();
    const row = (data as { tenant_id: string }[])[0]!;
    expect(row.tenant_id).toBe(targetA.tenant.id);
    expect(row.tenant_id).not.toBe(tenantB.id);
  });

  it("prevents a duplicate membership when one already exists via another path", async () => {
    const tenant = await createTestTenant(`test-tenant-inv-accept-dupe-${Date.now().toString(36)}`, ownerA.id);
    createdTenantIds.push(tenant.id);
    const roleId = await createRoleForTenant(tenant.id, "Sınırlı", ["appointments.view"]);
    const { data: invitation } = await createInvitation(ownerAClient, {
      tenantId: tenant.id,
      email: primaryAccepter.email,
      roleId,
    });

    // Membership appears through another legitimate path after the
    // invitation was created.
    const preExistingMembershipId = await addMembership(tenant.id, primaryAccepter.id, roleId);

    const { data, error } = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: invitation!.token });
    expect(error).toBeNull();
    const row = (data as { membership_id: string; outcome: string }[])[0]!;
    expect(row.outcome).toBe("already_member");
    expect(row.membership_id).toBe(preExistingMembershipId);

    const rows = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${primaryAccepter.id}
    `;
    expect(rows).toHaveLength(1);
  });

  it("rejects acceptance when the caller has a suspended membership", async () => {
    const tenant = await createTestTenant(`test-tenant-inv-accept-susp-${Date.now().toString(36)}`, ownerA.id);
    createdTenantIds.push(tenant.id);
    const roleId = await createRoleForTenant(tenant.id, "Sınırlı", ["appointments.view"]);
    const { data: invitation } = await createInvitation(ownerAClient, {
      tenantId: tenant.id,
      email: primaryAccepter.email,
      roleId,
    });
    const membershipId = await addMembership(tenant.id, primaryAccepter.id, roleId);
    await testDb`update tenant_memberships set status = 'suspended' where id = ${membershipId}`;

    const { error } = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: invitation!.token });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/membership_suspended/);
  });

  it("same-user replay of an already-accepted invitation is idempotent", async () => {
    const target = await freshInviteTarget(`accept-replay-same-${Date.now().toString(36)}`, primaryAccepter.email);
    createdTenantIds.push(target.tenant.id);

    const first = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: target.invitation.token });
    expect(first.error).toBeNull();
    const firstRow = (first.data as { membership_id: string; outcome: string }[])[0]!;
    expect(firstRow.outcome).toBe("accepted");

    const replay = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: target.invitation.token });
    expect(replay.error).toBeNull();
    const replayRow = (replay.data as { membership_id: string; outcome: string }[])[0]!;
    expect(replayRow.outcome).toBe("already_accepted");
    expect(replayRow.membership_id).toBe(firstRow.membership_id);

    const rows = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${target.tenant.id} and user_id = ${primaryAccepter.id}
    `;
    expect(rows).toHaveLength(1);
  });

  it("a different user replaying the same token hard-fails", async () => {
    const target = await freshInviteTarget(`accept-replay-diff-${Date.now().toString(36)}`, primaryAccepter.email);
    createdTenantIds.push(target.tenant.id);

    const first = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: target.invitation.token });
    expect(first.error).toBeNull();

    const otherAttempt = await managerAClient.rpc("accept_team_invitation", { p_token: target.invitation.token });
    expect(otherAttempt.error).not.toBeNull();
    expect(otherAttempt.error?.message).toMatch(/invitation_already_accepted/);

    const rows = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${target.tenant.id} and user_id = ${managerA.id}
    `;
    expect(rows).toHaveLength(0);
  });

  it("links an unlinked optional staff member on acceptance", async () => {
    const tenant = await createTestTenant(`test-tenant-inv-stafflink-${Date.now().toString(36)}`, ownerA.id);
    createdTenantIds.push(tenant.id);
    const roleId = await createRoleForTenant(tenant.id, "Sınırlı", ["appointments.view"]);
    const [staff] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name) values (${tenant.id}, 'Linkable Staff') returning id
    `;
    const { data: invitation } = await createInvitation(ownerAClient, {
      tenantId: tenant.id,
      email: primaryAccepter.email,
      roleId,
      staffMemberId: staff!.id,
    });

    const { data, error } = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: invitation!.token });
    expect(error).toBeNull();
    const row = (data as { membership_id: string; staff_linked: boolean; staff_link_reason: string | null }[])[0]!;
    expect(row.staff_linked).toBe(true);
    expect(row.staff_link_reason).toBeNull();

    const [staffRow] = await testDb<{ tenant_membership_id: string | null }[]>`
      select tenant_membership_id from staff_members where id = ${staff!.id}
    `;
    expect(staffRow?.tenant_membership_id).toBe(row.membership_id);
  });

  it("does not overwrite a staff member already linked to another membership", async () => {
    const tenant = await createTestTenant(`test-tenant-inv-stafflink-taken-${Date.now().toString(36)}`, ownerA.id);
    createdTenantIds.push(tenant.id);
    const roleId = await createRoleForTenant(tenant.id, "Sınırlı", ["appointments.view"]);
    const [staff] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name) values (${tenant.id}, 'Already Linked Staff') returning id
    `;
    const otherMembershipId = await addMembership(tenant.id, secondAccepter.id, roleId);
    await testDb`update staff_members set tenant_membership_id = ${otherMembershipId} where id = ${staff!.id}`;

    // Faz SAAS.1E.1 (F): create_team_invitation itself now refuses an
    // already-linked staff target (staff_already_linked — see
    // staff-invitation-guards.test.ts), so this state can no longer be
    // reached through the RPC. accept_team_invitation's own no-overwrite
    // behavior is still real, still worth proving, and still reachable for
    // an invitation that predates this migration — built directly here the
    // same way other now-RPC-unreachable defensive branches in this suite
    // are (see invitation-accept-revalidation.test.ts's "already_member"
    // case).
    const rawToken = randomTokenHex();
    await testDb`
      insert into team_invitations (tenant_id, email, role_id, staff_member_id, invited_by, status, token_hash, expires_at)
      values (${tenant.id}, ${primaryAccepter.email}, ${roleId}, ${staff!.id}, ${ownerA.id}, 'pending', ${sha256Hex(rawToken)}, now() + interval '7 days')
    `;

    const { data, error } = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: rawToken });
    expect(error).toBeNull();
    const row = (data as { membership_id: string; staff_linked: boolean; staff_link_reason: string | null }[])[0]!;
    expect(row.staff_linked).toBe(false);
    expect(row.staff_link_reason).toBe("already_linked");
    // The membership itself must still have been created successfully.
    expect(row.membership_id).toBeTruthy();

    const [staffRow] = await testDb<{ tenant_membership_id: string | null }[]>`
      select tenant_membership_id from staff_members where id = ${staff!.id}
    `;
    expect(staffRow?.tenant_membership_id).toBe(otherMembershipId);
  });

  // Faz SAAS.1E.1 (F) retired this test's original scenario — two pending
  // invitations to the SAME staff member racing at ACCEPT time — because it
  // can no longer be constructed at all: team_invitations_tenant_staff_
  // pending_idx (a real unique index, not just an application check) refuses
  // a second PENDING row for the same (tenant, staff member) outright, even
  // via a direct multi-row INSERT. The race this test used to exercise at
  // accept time is now impossible earlier, deterministically, at create
  // time instead — see staff-invitation-guards.test.ts's own "two truly
  // CONCURRENT invitations for the same staff member: exactly one winner"
  // for that guarantee. What remains genuinely this file's concern —
  // accept_team_invitation still links correctly under the normal,
  // now-only-possible shape (one pending invitation, one staff target) — is
  // covered by "links an unlinked optional staff member on acceptance"
  // directly above.
  it("a second invitation to an already-pending staff target is refused before any race can occur", async () => {
    const tenant = await createTestTenant(`test-tenant-inv-stafflink-race-${Date.now().toString(36)}`, ownerA.id);
    createdTenantIds.push(tenant.id);
    const roleId = await createRoleForTenant(tenant.id, "Sınırlı", ["appointments.view"]);
    const [staff] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name) values (${tenant.id}, 'Race Staff') returning id
    `;

    const first = await createInvitation(ownerAClient, { tenantId: tenant.id, email: primaryAccepter.email, roleId, staffMemberId: staff!.id });
    expect(first.error).toBeNull();

    const second = await createInvitation(ownerAClient, { tenantId: tenant.id, email: secondAccepter.email, roleId, staffMemberId: staff!.id });
    expect(second.data).toBeNull();
    expect(second.error?.message).toContain("staff_pending_invitation_exists");

    const { data, error } = await primaryAccepterClient.rpc("accept_team_invitation", { p_token: first.data!.token });
    expect(error).toBeNull();
    const row = (data as { membership_id: string; staff_linked: boolean }[])[0]!;
    expect(row.staff_linked).toBe(true);

    const [staffRow] = await testDb<{ tenant_membership_id: string | null }[]>`select tenant_membership_id from staff_members where id = ${staff!.id}`;
    expect(staffRow?.tenant_membership_id).toBe(row.membership_id);
  });
});

describe("SECURITY", () => {
  it("anon cannot execute any invitation-management RPC", async () => {
    const anon = anonClient();
    const target = await freshInviteTarget(`security-anon-${Date.now().toString(36)}`, "whoever@example.com");
    createdTenantIds.push(target.tenant.id);

    const results = await Promise.all([
      anon.rpc("create_team_invitation", {
        p_tenant_id: tenantA.id,
        p_email: "anon-attempt@example.com",
        p_role_id: limitedRoleId,
      }),
      anon.rpc("list_team_invitations", { p_tenant_id: tenantA.id }),
      // Faz SAAS.1C.2C: resend_team_invitation's signature gained
      // p_expected_expires_at (optimistic fencing, 20260918070000) —
      // still just verifying anon gets denied on whatever the CURRENT
      // real RPC is, not an artifact of calling a deleted overload.
      anon.rpc("resend_team_invitation", {
        p_invitation_id: target.invitation.id,
        p_expected_expires_at: target.invitation.expires_at,
      }),
      anon.rpc("revoke_team_invitation", { p_invitation_id: target.invitation.id }),
    ]);
    for (const { error } of results) {
      expect(error).not.toBeNull();
    }
  });

  it("no PostgREST grants exist on team_invitations for anon or authenticated", async () => {
    const rows = await testDb<{ grantee: string; privilege_type: string }[]>`
      select grantee, privilege_type from security_audit_table_grants()
      where table_name = 'team_invitations' and grantee in ('anon', 'authenticated')
    `;
    expect(rows).toHaveLength(0);
  });

  it("never writes the raw token or its hash into audit_logs", async () => {
    const created = await createInvitation(ownerAClient, {
      tenantId: tenantA.id,
      email: `inv-security-audit-${Date.now().toString(36)}@example.com`,
      roleId: limitedRoleId,
    });
    const rawToken = created.data!.token;
    const tokenHash = sha256Hex(rawToken);

    const rows = await testDb<{ before: unknown; after: unknown }[]>`
      select before, after from audit_logs
      where tenant_id = ${tenantA.id} and entity_id = ${created.data!.id} and action = 'team_invitation.created'
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const serialized = JSON.stringify([row.before, row.after]);
      expect(serialized).not.toContain(rawToken);
      expect(serialized).not.toContain(tokenHash);
    }
  });

  it("exposes no plaintext token column on team_invitations", async () => {
    const columns = await testDb<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'team_invitations'
    `;
    const names = columns.map((c) => c.column_name);
    expect(names).toContain("token_hash");
    expect(names).not.toContain("token");
    expect(names).not.toContain("raw_token");
  });
});
