import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  allPermissionKeys,
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
 * Faz SAAS.1E.1 (residual B/C) — accept_team_invitation revalidates the
 * INVITER's CURRENT authority at the moment a new membership is actually
 * granted, not their authority at invite-creation time.
 *
 * Two proven gaps this closes: (B) an invitation survives the inviter being
 * removed or suspended after it was sent; (C) the invited role's permission
 * set can grow after the invitation was created, past what the inviter was
 * ever allowed to grant. Both now make acceptance fail with the SAME
 * generic 'invitation_not_found' every other dead invitation gives —
 * nothing about the inviter or the reason is ever revealed to the invitee.
 * An unrestricted inviter is exempt from the ceiling, same as everywhere
 * else in the authority model. A membership that already exists through
 * another path (the idempotent replay / already_member branches) is never
 * re-gated — no NEW access is granted there, so there is nothing to
 * revalidate.
 */

const TAG = randomUUID().slice(0, 8);
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`iar-${label}`);
  createdUserIds.push(user.id);
  return user;
}

async function provisionedRoles(tenantId: string): Promise<Record<string, string>> {
  await testDb`select * from private.provision_default_roles(${tenantId}::uuid)`;
  const rows = await testDb<{ id: string; key: string }[]>`select id, key from roles where tenant_id = ${tenantId} and deleted_at is null`;
  return Object.fromEntries(rows.map((r) => [r.key, r.id]));
}

type Invite = { id: string; token: string };

async function invite(caller: string, tenantId: string, email: string, roleId: string): Promise<Invite> {
  const rows = await asAuthenticatedUser(caller, (sql) =>
    sql<Invite[]>`select id, token from public.create_team_invitation(${tenantId}::uuid, ${email}::text, ${roleId}::uuid, null::uuid)`,
  );
  return rows[0]!;
}

/** The real outcome string on success ("accepted" / "already_member" /
 * "already_accepted"), or the attemptAs failure shape on rejection —
 * attemptAs itself only ever resolves to {ok:true}/{ok:false,...}, so a
 * plain wrap around it would discard exactly the value these tests need. */
async function accept(invitee: string, token: string): Promise<string | { ok: false; message: string; code: string | undefined }> {
  try {
    const rows = await asAuthenticatedUser(invitee, (sql) => sql<{ outcome: string }[]>`select outcome from public.accept_team_invitation(${token}::text)`);
    return rows[0]!.outcome;
  } catch (error) {
    const e = error as { message?: string; code?: string };
    return { ok: false, message: e.message ?? String(error), code: e.code };
  }
}

async function activeMembership(tenantId: string, userId: string): Promise<{ id: string; role_id: string } | null> {
  const rows = await testDb<{ id: string; role_id: string }[]>`
    select id, role_id from tenant_memberships where tenant_id = ${tenantId} and user_id = ${userId} and deleted_at is null`;
  return rows[0] ?? null;
}

describe("accept_team_invitation — the inviter's authority is revalidated, fresh, every time", () => {
  let tenant: TestTenant;
  const users: Record<string, TestUser> = {};
  const role: Record<string, string> = {};
  let allKeys: string[];

  beforeAll(async () => {
    allKeys = await allPermissionKeys();
    users.owner = await newUser("owner");
    tenant = await createTestTenant(`test-tenant-iar-${TAG}`, users.owner!.id);
    createdTenantIds.push(tenant.id);
    Object.assign(role, await provisionedRoles(tenant.id));
  }, 60000);

  afterAll(async () => {
    await cleanupTenants(createdTenantIds);
    await cleanupUsers(createdUserIds);
  }, 120000);

  async function freshManager(label: string): Promise<{ user: TestUser; membershipId: string }> {
    const user = await newUser(label);
    const membershipId = await addMembership(tenant.id, user.id, role.SALON_MANAGER!);
    return { user, membershipId };
  }

  it("baseline: an active, unchanged inviter's invitation accepts normally and grants exactly the invited role", async () => {
    const { user: manager } = await freshManager("baseline-manager");
    const invitee = await newUser("baseline-invitee");
    const inv = await invite(manager.id, tenant.id, invitee.email, role.STYLIST!);
    expect(await accept(invitee.id, inv.token)).toBe("accepted");
    const m = await activeMembership(tenant.id, invitee.id);
    expect(m?.role_id).toBe(role.STYLIST);
  }, 60000);

  it("a REMOVED inviter's pending invitation can no longer be accepted — fails safely, no membership created", async () => {
    const { user: manager, membershipId } = await freshManager("removed-manager");
    const invitee = await newUser("removed-invitee");
    const inv = await invite(manager.id, tenant.id, invitee.email, role.RECEPTIONIST!);

    const removed = await attemptAs(users.owner!.id, (sql) => sql`select public.remove_membership_access(${tenant.id}::uuid, ${membershipId}::uuid)`);
    expect(removed).toEqual({ ok: true });

    const result = await accept(invitee.id, inv.token);
    expect(result).toMatchObject({ ok: false, message: "invitation_not_found" });
    expect(await activeMembership(tenant.id, invitee.id)).toBeNull();

    // The invitation row itself is untouched — still pending, not consumed by the failed attempt.
    const [row] = await testDb<{ status: string }[]>`select status from team_invitations where id = ${inv.id}`;
    expect(row!.status).toBe("pending");
  }, 60000);

  it("a SUSPENDED inviter's pending invitation can no longer be accepted", async () => {
    const { user: manager, membershipId } = await freshManager("suspended-manager");
    const invitee = await newUser("suspended-invitee");
    const inv = await invite(manager.id, tenant.id, invitee.email, role.STYLIST!);

    expect(await attemptAs(users.owner!.id, (sql) => sql`select public.suspend_membership(${tenant.id}::uuid, ${membershipId}::uuid)`)).toEqual({ ok: true });
    expect(await accept(invitee.id, inv.token)).toMatchObject({ ok: false, message: "invitation_not_found" });
    expect(await activeMembership(tenant.id, invitee.id)).toBeNull();
  }, 60000);

  it("an inviter who LOST the permission that justified the invite (role edited down) can no longer have it accepted", async () => {
    const custom = await createCustomRole(tenant.id, "Davetçi", ["appointments.view", "customers.view", "staff.manage"]);
    const inviter = await newUser("shrunk-inviter");
    await addMembership(tenant.id, inviter.id, custom);
    const invitee = await newUser("shrunk-invitee");
    const target = await createCustomRole(tenant.id, "Hedef", ["customers.view"]);
    const inv = await invite(inviter.id, tenant.id, invitee.email, target);

    // The Owner narrows the inviter's own role: customers.view is gone, so the target role is no longer contained.
    expect(await attemptAs(users.owner!.id, (sql) => sql`select public.update_role_permissions(${custom}::uuid, ${sql.array(["appointments.view", "staff.manage"], 1009)}::text[])`)).toEqual({ ok: true });

    expect(await accept(invitee.id, inv.token)).toMatchObject({ ok: false, message: "invitation_not_found" });
    expect(await activeMembership(tenant.id, invitee.id)).toBeNull();
  }, 60000);

  it("a role that GREW after the invitation was created is not granted in full — the invitee never exceeds the inviter's CURRENT authority", async () => {
    const { user: manager } = await freshManager("growth-manager");
    const growing = await createCustomRole(tenant.id, "Büyüyen", ["appointments.view"]);
    const invitee = await newUser("growth-invitee");
    const inv = await invite(manager.id, tenant.id, invitee.email, growing);

    // The role grows to hold everything but the unrestricted key — now larger than the Manager's own 16 keys.
    const beyondManager = allKeys.filter((k) => k !== "permissions.manage_unrestricted");
    expect(await attemptAs(users.owner!.id, (sql) => sql`select public.update_role_permissions(${growing}::uuid, ${sql.array(beyondManager, 1009)}::text[])`)).toEqual({ ok: true });

    expect(await accept(invitee.id, inv.token)).toMatchObject({ ok: false, message: "invitation_not_found" });
    expect(await activeMembership(tenant.id, invitee.id)).toBeNull();
  }, 60000);

  it("a role that shrank stays acceptable if the inviter still, currently, strictly contains it", async () => {
    const { user: manager } = await freshManager("shrink-manager");
    const wide = await createCustomRole(tenant.id, "Küçülen", ["appointments.view", "customers.view", "staff.view"]);
    const invitee = await newUser("shrink-invitee");
    const inv = await invite(manager.id, tenant.id, invitee.email, wide);

    expect(await attemptAs(users.owner!.id, (sql) => sql`select public.update_role_permissions(${wide}::uuid, ${sql.array(["appointments.view"], 1009)}::text[])`)).toEqual({ ok: true });

    expect(await accept(invitee.id, inv.token)).toBe("accepted");
    const m = await activeMembership(tenant.id, invitee.id);
    expect(m?.role_id).toBe(wide);
  }, 60000);

  it("an UNRESTRICTED inviter is exempt from the ceiling — acceptance always succeeds regardless of the target role's size", async () => {
    const invitee = await newUser("unrestricted-invitee");
    const inv = await invite(users.owner!.id, tenant.id, invitee.email, role.SALON_MANAGER!);
    expect(await accept(invitee.id, inv.token)).toBe("accepted");
  }, 60000);

  it("an inviter DEMOTED to a weaker role (update_membership_role, not merely their role's permissions edited) can no longer have their invitation accepted", async () => {
    const { user: manager, membershipId } = await freshManager("demoted-manager");
    const invitee = await newUser("demoted-invitee");
    // The Manager invites into a role they genuinely have authority over —
    // Receptionist (9 keys), a strict subset of their own 16.
    const inv = await invite(manager.id, tenant.id, invitee.email, role.RECEPTIONIST!);

    // Only the Owner may move a Manager. Demote them past Receptionist,
    // onto Personel (1 key: appointments.view) — which no longer contains
    // Receptionist's 9 keys at all.
    expect(await attemptAs(users.owner!.id, (sql) => sql`select public.update_membership_role(${membershipId}::uuid, ${role.STYLIST!}::uuid)`)).toEqual({ ok: true });

    expect(await accept(invitee.id, inv.token)).toMatchObject({ ok: false, message: "invitation_not_found" });
    expect(await activeMembership(tenant.id, invitee.id)).toBeNull();
  }, 60000);

  it("staff linking still completes for a successful, fully-authorized acceptance — the new revalidation does not disturb it", async () => {
    const { user: manager } = await freshManager("staff-link-manager");
    const staffId = (
      await testDb<{ id: string }[]>`insert into staff_members (tenant_id, full_name) values (${tenant.id}, ${"Bağlanacak Personel"}) returning id`
    )[0]!.id;
    const invitee = await newUser("staff-link-invitee");
    const rows = await asAuthenticatedUser(manager.id, (sql) =>
      sql<{ id: string; token: string }[]>`select id, token from public.create_team_invitation(${tenant.id}::uuid, ${invitee.email}::text, ${role.STYLIST!}::uuid, ${staffId}::uuid)`,
    );
    const [result] = await asAuthenticatedUser(invitee.id, (sql) =>
      sql<{ outcome: string; staff_linked: boolean }[]>`select outcome, staff_linked from public.accept_team_invitation(${rows[0]!.token}::text)`,
    );
    expect(result).toMatchObject({ outcome: "accepted", staff_linked: true });
    const [link] = await testDb<{ tenant_membership_id: string | null }[]>`select tenant_membership_id from staff_members where id = ${staffId}`;
    expect(link!.tenant_membership_id).not.toBeNull();
  }, 60000);

  it("if the inviter is later re-authorized (re-promoted to sufficient authority), the SAME still-pending invitation starts working again — the check is fresh, not a one-time kill", async () => {
    const { user: manager, membershipId } = await freshManager("reinstated-manager");
    const invitee = await newUser("reinstated-invitee");
    const inv = await invite(manager.id, tenant.id, invitee.email, role.STYLIST!);

    expect(await attemptAs(users.owner!.id, (sql) => sql`select public.suspend_membership(${tenant.id}::uuid, ${membershipId}::uuid)`)).toEqual({ ok: true });
    expect(await accept(invitee.id, inv.token)).toMatchObject({ ok: false, message: "invitation_not_found" });

    expect(await attemptAs(users.owner!.id, (sql) => sql`select public.reactivate_membership(${tenant.id}::uuid, ${membershipId}::uuid)`)).toEqual({ ok: true });
    expect(await accept(invitee.id, inv.token)).toBe("accepted");
  }, 60000);

  it("the target ROLE being deleted still refuses acceptance with the pre-existing message, unaffected by the new checks", async () => {
    const { user: manager } = await freshManager("deletedrole-manager");
    const doomed = await createCustomRole(tenant.id, "Silinecek", ["appointments.view"]);
    const invitee = await newUser("deletedrole-invitee");
    const inv = await invite(manager.id, tenant.id, invitee.email, doomed);
    await testDb`update roles set deleted_at = now() where id = ${doomed}`;
    expect(await accept(invitee.id, inv.token)).toMatchObject({ ok: false, message: "invitation_not_found" });
  }, 60000);

  it("no NEW audit row is written for a revalidation-failed acceptance (matches every other silent failure branch)", async () => {
    const { user: manager, membershipId } = await freshManager("noaudit-manager");
    const invitee = await newUser("noaudit-invitee");
    const inv = await invite(manager.id, tenant.id, invitee.email, role.STYLIST!);
    await attemptAs(users.owner!.id, (sql) => sql`select public.remove_membership_access(${tenant.id}::uuid, ${membershipId}::uuid)`);
    const before = await testDb<{ n: number }[]>`select count(*)::int as n from audit_logs where tenant_id = ${tenant.id} and entity_id = ${inv.id}`;
    await accept(invitee.id, inv.token);
    const after = await testDb<{ n: number }[]>`select count(*)::int as n from audit_logs where tenant_id = ${tenant.id} and entity_id = ${inv.id}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  }, 60000);

  it("idempotent replay is untouched: accepting twice as the same (now-successful) invitee is safe even if the inviter is removed AFTER the first accept", async () => {
    const { user: manager, membershipId } = await freshManager("replay-manager");
    const invitee = await newUser("replay-invitee");
    const inv = await invite(manager.id, tenant.id, invitee.email, role.STYLIST!);
    expect(await accept(invitee.id, inv.token)).toBe("accepted");

    // The inviter is removed AFTER the membership already exists — the replay branch never re-checks them.
    await attemptAs(users.owner!.id, (sql) => sql`select public.remove_membership_access(${tenant.id}::uuid, ${membershipId}::uuid)`);
    expect(await accept(invitee.id, inv.token)).toBe("already_accepted");
    expect((await activeMembership(tenant.id, invitee.id))?.role_id).toBe(role.STYLIST);
  }, 60000);

  it("'already_member' (a still-pending invitation whose invitee already holds an active membership some other way) is accepted without gating on the inviter's authority", async () => {
    // create_team_invitation itself refuses to create a second invitation once the target email is already an
    // active member, so this state — a PENDING invitation coexisting with an already-active membership for its
    // own email — cannot arise through the normal RPC surface. accept_team_invitation still defends against it
    // (the "already_member" outcome exists specifically for this), so the fixture is built directly, the same
    // way other defensive-branch tests in this suite construct a state the RPC surface itself cannot produce.
    const { user: manager, membershipId } = await freshManager("alreadymember-manager");
    const invitee = await newUser("alreadymember-invitee");
    const inv = await invite(manager.id, tenant.id, invitee.email, role.STYLIST!);

    await addMembership(tenant.id, invitee.id, role.RECEPTIONIST!);
    await attemptAs(users.owner!.id, (sql) => sql`select public.remove_membership_access(${tenant.id}::uuid, ${membershipId}::uuid)`);

    // The now-authority-less Manager's invitation still resolves — not to a NEW grant (none is made; the
    // existing Receptionist membership is untouched), but the harmless already_member acknowledgement.
    expect(await accept(invitee.id, inv.token)).toBe("already_member");
    expect((await activeMembership(tenant.id, invitee.id))?.role_id).toBe(role.RECEPTIONIST);
    const [row] = await testDb<{ status: string }[]>`select status from team_invitations where id = ${inv.id}`;
    expect(row!.status).toBe("accepted");
  }, 60000);
});
