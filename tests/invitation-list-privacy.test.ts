import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  asAuthenticatedUser,
  attemptAs,
  cleanupTenants,
  cleanupUsers,
  createCustomRole,
  createTestTenant,
  createTestUser,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1E.1 (residual A) — list_team_invitations must not leak an
 * invitation above or equal to the caller's own authority.
 *
 * Until this phase, ANY staff.manage holder could list EVERY pending/past
 * invitation of the tenant — including an invitation into the Owner role,
 * or into an equal (peer) role — learning who was being promoted and their
 * e-mail. The fix reuses the exact ceiling create_team_invitation already
 * enforces: a normal caller sees only invitations whose target role's
 * permission set is a STRICT SUBSET of their own (private.is_strict_subset,
 * the same primitive SAAS.1E.0 built for the create/resend/revoke ceiling).
 * An unrestricted caller sees everything, same as before.
 */

const TAG = randomUUID().slice(0, 8);
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`ilp-${label}`);
  createdUserIds.push(user.id);
  return user;
}

type RoleMap = Record<string, string>;

async function provisionedRoles(tenantId: string): Promise<RoleMap> {
  await testDb`select * from private.provision_default_roles(${tenantId}::uuid)`;
  const rows = await testDb<{ id: string; key: string }[]>`select id, key from roles where tenant_id = ${tenantId} and deleted_at is null`;
  return Object.fromEntries(rows.map((r) => [r.key, r.id]));
}

type ListedInvitation = { id: string; email: string; role_name: string; status: string };

const list = (caller: string, tenantId: string) =>
  asAuthenticatedUser(caller, (sql) => sql<ListedInvitation[]>`select id, email, role_name, status from public.list_team_invitations(${tenantId}::uuid)`);

const listAttempt = (caller: string, tenantId: string) => attemptAs(caller, (sql) => sql`select * from public.list_team_invitations(${tenantId}::uuid)`);

async function invite(caller: string, tenantId: string, email: string, roleId: string): Promise<string> {
  const rows = await asAuthenticatedUser(caller, (sql) =>
    sql<{ id: string }[]>`select id from public.create_team_invitation(${tenantId}::uuid, ${email}::text, ${roleId}::uuid, null::uuid)`,
  );
  return rows[0]!.id;
}

describe("list_team_invitations — authority-scoped, never role-name-scoped", () => {
  let tenant: TestTenant;
  const users: Record<string, TestUser> = {};
  const role: RoleMap = {};
  const invitationOf: Record<string, string> = {};

  beforeAll(async () => {
    for (const l of ["owner", "manager", "peer", "reception", "personel", "outsider"]) users[l] = await newUser(l);
    tenant = await createTestTenant(`test-tenant-ilp-${TAG}`, users.owner!.id);
    createdTenantIds.push(tenant.id);
    Object.assign(role, await provisionedRoles(tenant.id));
    await addMembership(tenant.id, users.manager!.id, role.SALON_MANAGER!);
    await addMembership(tenant.id, users.peer!.id, role.SALON_MANAGER!);
    await addMembership(tenant.id, users.reception!.id, role.RECEPTIONIST!);
    await addMembership(tenant.id, users.personel!.id, role.STYLIST!);

    invitationOf.toOwner = await invite(users.owner!.id, tenant.id, `ilp-invitee-owner-${TAG}@example.com`, role.SALON_OWNER!);
    invitationOf.toManager = await invite(users.owner!.id, tenant.id, `ilp-invitee-manager-${TAG}@example.com`, role.SALON_MANAGER!);
    invitationOf.toReception = await invite(users.owner!.id, tenant.id, `ilp-invitee-reception-${TAG}@example.com`, role.RECEPTIONIST!);
    invitationOf.toPersonel = await invite(users.owner!.id, tenant.id, `ilp-invitee-personel-${TAG}@example.com`, role.STYLIST!);
  }, 120000);

  afterAll(async () => {
    await cleanupTenants(createdTenantIds);
    await cleanupUsers(createdUserIds);
  }, 120000);

  it("the unrestricted Owner sees every invitation, including the Owner one", async () => {
    const rows = await list(users.owner!.id, tenant.id);
    expect(rows.map((r) => r.id).sort()).toEqual(Object.values(invitationOf).sort());
  });

  it("a Manager sees Receptionist and Personel invitations, but NOT the Owner invitation nor an equal Manager invitation", async () => {
    const rows = await list(users.manager!.id, tenant.id);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(invitationOf.toReception);
    expect(ids).toContain(invitationOf.toPersonel);
    expect(ids).not.toContain(invitationOf.toOwner);
    expect(ids).not.toContain(invitationOf.toManager);
  });

  it("an incomparable role (some keys the Manager lacks, some it has) is hidden too — no role name/key comparison, permission sets only", async () => {
    const incomparable = await createCustomRole(tenant.id, "Ayar Yetkilisi", ["appointments.view", "settings.manage"]);
    const inv = await invite(users.owner!.id, tenant.id, `ilp-incomparable-${TAG}@example.com`, incomparable);
    const rows = await list(users.manager!.id, tenant.id);
    expect(rows.map((r) => r.id)).not.toContain(inv);
    // The Owner, who is unrestricted, still sees it.
    expect((await list(users.owner!.id, tenant.id)).map((r) => r.id)).toContain(inv);
  }, 60000);

  it("a role with STRICTLY FEWER keys than the Manager's own is visible, even a hand-built role never provisioned by default", async () => {
    const lesser = await createCustomRole(tenant.id, "Yardımcı", ["appointments.view", "customers.view"]);
    const inv = await invite(users.owner!.id, tenant.id, `ilp-lesser-${TAG}@example.com`, lesser);
    expect((await list(users.manager!.id, tenant.id)).map((r) => r.id)).toContain(inv);
  }, 60000);

  it("Receptionist and Personel — no staff.manage — cannot list at all (the unlocked top-level gate, unchanged)", async () => {
    expect(await listAttempt(users.reception!.id, tenant.id)).toMatchObject({ ok: false, message: "staff.manage required" });
    expect(await listAttempt(users.personel!.id, tenant.id)).toMatchObject({ ok: false, message: "staff.manage required" });
  });

  it("a non-member gets the same generic refusal as a staff.manage-lacking member — tenant existence is not probeable either way", async () => {
    const memberDenied = await listAttempt(users.reception!.id, tenant.id);
    const outsiderDenied = await listAttempt(users.outsider!.id, tenant.id);
    const fakeTenantDenied = await listAttempt(users.owner!.id, randomUUID());
    expect(outsiderDenied).toEqual(memberDenied);
    expect(fakeTenantDenied).toEqual(memberDenied);
  });

  it("never returns a token or token_hash — only fields the Team UI actually renders", async () => {
    const rows = await asAuthenticatedUser(users.owner!.id, (sql) => sql<Record<string, unknown>[]>`select * from public.list_team_invitations(${tenant.id}::uuid)`);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["created_at", "effective_status", "email", "expires_at", "id", "invited_by_name", "role_id", "role_name", "staff_member_id", "staff_member_name", "status"].sort(),
      );
    }
  });

  it("visibility is re-evaluated fresh every call, from the caller's CURRENT permission set — not cached, not by role name", async () => {
    const shifting = await newUser("shifting");
    const wideRole = await createCustomRole(tenant.id, "Geniş Rol", ["appointments.view", "staff.manage"]);
    await addMembership(tenant.id, shifting.id, wideRole);
    // appointments.view ⊂ {appointments.view, staff.manage} — a strict subset, so Personel's invitation is visible.
    expect((await list(shifting.id, tenant.id)).map((r) => r.id)).toContain(invitationOf.toPersonel);

    // Narrowed to staff.manage alone: appointments.view is no longer contained at all — the same invitation
    // disappears, purely because the caller's OWN effective permissions changed, not the role's name or the target's.
    await attemptAs(users.owner!.id, (sql) => sql`select public.update_role_permissions(${wideRole}::uuid, ${sql.array(["staff.manage"], 1009)}::text[])`);
    expect((await list(shifting.id, tenant.id)).map((r) => r.id)).not.toContain(invitationOf.toPersonel);
  }, 60000);
});
