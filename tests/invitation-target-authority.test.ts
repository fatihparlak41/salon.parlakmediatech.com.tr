import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import {
  addMembership,
  allPermissionKeys,
  asAuthenticatedUser,
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
 * Faz SAAS.1E.0 (part 2) — invitation TARGET authority
 * (20260921083417_invitation_target_authority.sql).
 *
 * create_, resend_ and revoke_team_invitation now judge authority over the
 * invitation's TARGET ROLE on EFFECTIVE permissions: an unrestricted caller
 * may act on any live role; anyone else only on a role whose permission set is
 * a STRICT subset of their own (so never on an Owner and never on a peer of
 * equal authority). Roles below carry deliberately misleading names/keys — a
 * "Stajyer" holding every permission, a role literally KEYED SALON_OWNER with
 * three — so any name-based shortcut would be caught.
 *
 * Calls run through asAuthenticatedUser: role `authenticated` + JWT claims in
 * one transaction, i.e. exactly what a PostgREST request sees, without one of
 * Supabase Auth's rate-limited sign-ins per actor.
 */

const MANAGER_KEYS = [
  "appointments.view", "appointments.create", "appointments.update", "appointments.cancel",
  "customers.view", "customers.create", "customers.update", "customers.link_account",
  "reports.basic", "reports.staff", "schedules.view", "schedules.manage",
  "services.view", "services.manage", "staff.view", "staff.manage",
];
const RECEPTION_KEYS = [
  "appointments.view", "appointments.create", "appointments.update", "appointments.cancel",
  "customers.view", "customers.create", "customers.update", "schedules.view", "services.view",
];
const PERSONEL_KEYS = ["appointments.view", "customers.view", "schedules.view", "services.view"];
const EXTRA_KEY = "settings.manage";

let tenantA: TestTenant;
let tenantB: TestTenant;
let allKeys: string[];

const users: Record<string, TestUser> = {};
const roleOf: Record<string, string> = {};
const membershipOf: Record<string, string> = {};

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`tia2-${label}`);
  createdUserIds.push(user.id);
  users[label] = user;
  return user;
}

type Outcome<T> = { ok: true; rows: T[] } | { ok: false; message: string; code: string | undefined };

async function callAs<T>(userId: string, run: (sql: postgres.TransactionSql) => Promise<T[]>): Promise<Outcome<T>> {
  try {
    return { ok: true, rows: await asAuthenticatedUser(userId, run) };
  } catch (error) {
    const e = error as { message?: string; code?: string };
    return { ok: false, message: e.message ?? String(error), code: e.code };
  }
}

type CreateRow = { id: string; role_id: string; status: string; expires_at: string; token: string };
type ResendRow = { id: string; status: string; expires_at: string; token: string | null };
type RevokeRow = { id: string; status: string };

const create = (userId: string, tenantId: string, email: string, roleId: string) =>
  callAs<CreateRow>(
    userId,
    (sql) => sql<CreateRow[]>`
      select id, role_id, status, expires_at::text as expires_at, token
      from public.create_team_invitation(${tenantId}::uuid, ${email}::text, ${roleId}::uuid, null::uuid)`,
  );

// The observation goes through ::text on purpose: with a bare ::timestamptz cast postgres.js
// round-trips the value through a JS Date and drops the microseconds, so the optimistic fence
// (which compares exact microsecond timestamps) would see a "stale" value.
const resend = (userId: string, invitationId: string, expected: string | null) =>
  callAs<ResendRow>(
    userId,
    (sql) => sql<ResendRow[]>`
      select id, status, expires_at::text as expires_at, token
      from public.resend_team_invitation(${invitationId}::uuid, ${expected}::text::timestamptz)`,
  );

const revoke = (userId: string, invitationId: string) =>
  callAs<RevokeRow>(
    userId,
    (sql) => sql<RevokeRow[]>`select id, status from public.revoke_team_invitation(${invitationId}::uuid)`,
  );

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
const emailFor = (label: string) => `inv-tia2-${label}-${Math.random().toString(36).slice(2, 9)}@example.com`;

type Invitation = { id: string; expiresAt: string; email: string; token: string };

/** A pending invitation written directly (bypassing the RPC under test). */
async function newInvitation(
  roleId: string,
  label: string,
  options: { status?: string; expired?: boolean; tenantId?: string } = {},
): Promise<Invitation> {
  const token = randomBytes(32).toString("hex");
  const email = emailFor(label);
  const tenantId = options.tenantId ?? tenantA.id;
  const [row] = options.expired
    ? await testDb<{ id: string; expires_at: string }[]>`
        insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, created_at)
        values (${tenantId}, ${email}, ${roleId}, ${users.owner!.id}, ${options.status ?? "pending"}, ${sha256(token)}, now() - interval '1 hour', now() - interval '8 days')
        returning id, expires_at::text as expires_at`
    : await testDb<{ id: string; expires_at: string }[]>`
        insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at)
        values (${tenantId}, ${email}, ${roleId}, ${users.owner!.id}, ${options.status ?? "pending"}, ${sha256(token)}, now() + interval '3 days')
        returning id, expires_at::text as expires_at`;
  return { id: row!.id, expiresAt: row!.expires_at, email, token };
}

async function snapshot(invitationId: string) {
  const [row] = await testDb<
    { status: string; token_hash: string; expires_at: string; updated_at: string; revoked_at: string | null; revoked_by: string | null }[]
  >`
    select status, token_hash, expires_at::text as expires_at, updated_at::text as updated_at,
           revoked_at::text as revoked_at, revoked_by
    from team_invitations where id = ${invitationId}`;
  return row!;
}

async function invitationAudit(invitationId: string, actions?: string[]) {
  const rows = await testDb<{ action: string; actor_user_id: string | null; before: unknown; after: unknown }[]>`
    select action, actor_user_id, before, after from audit_logs
    where entity_type = 'team_invitation' and entity_id = ${invitationId}
    order by created_at, id`;
  return actions ? rows.filter((row) => actions.includes(row.action)) : rows;
}

const LEGACY_CEILING = {
  create: "cannot invite into a role with permissions you do not hold",
  resend: "cannot resend an invitation into a role with permissions you do not hold",
  revoke: "cannot revoke an invitation into a role with permissions you do not hold",
} as const;

beforeAll(async () => {
  allKeys = await allPermissionKeys();
  expect(allKeys).toContain(EXTRA_KEY);
  expect(MANAGER_KEYS).not.toContain(EXTRA_KEY);

  for (const label of [
    "owner", "partner", "manager", "reception", "suspended", "removed", "outsider", "dual", "stranger", "invitee",
  ]) {
    await newUser(label);
  }

  tenantA = await createTestTenant("test-tenant-tia2-a", users.owner!.id);
  tenantB = await createTestTenant("test-tenant-tia2-b", users.outsider!.id);
  createdTenantIds.push(tenantA.id, tenantB.id);

  roleOf.owner = tenantA.ownerRoleId;
  // Unrestricted, but nothing like an "Owner" by name or key.
  roleOf.partner = await createCustomRole(tenantA.id, "Ortak", allKeys);
  roleOf.manager = await createCustomRole(tenantA.id, "Yönetici", MANAGER_KEYS);
  // A DIFFERENT role row with EXACTLY the manager's permission set: a peer.
  roleOf.peer = await createCustomRole(tenantA.id, "Kıdemli Yönetici", MANAGER_KEYS);
  roleOf.lower = await createCustomRole(tenantA.id, "Resepsiyon", RECEPTION_KEYS);
  roleOf.personel = await createCustomRole(tenantA.id, "Personel", PERSONEL_KEYS);
  roleOf.empty = await createCustomRole(tenantA.id, "Boş Rol", []);
  roleOf.higher = await createCustomRole(tenantA.id, "Yönetici Artı", [...MANAGER_KEYS, EXTRA_KEY]);
  roleOf.incomparable = await createCustomRole(tenantA.id, "Ayar Yetkilisi", ["staff.manage", EXTRA_KEY]);
  // Literally keyed SALON_OWNER, three permissions, no unrestricted key.
  roleOf.fake = await createCustomRole(tenantA.id, "SALON_OWNER", ["appointments.view", "staff.manage", "staff.view"], {
    key: "SALON_OWNER",
  });
  // Every permission, but named like an intern.
  roleOf.intern = await createCustomRole(tenantA.id, "Stajyer", allKeys);
  roleOf.deleted = await createCustomRole(tenantA.id, "Silinecek Rol", PERSONEL_KEYS);

  const [ownerMembership] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${users.owner!.id}`;
  membershipOf.owner = ownerMembership!.id;
  membershipOf.partner = await addMembership(tenantA.id, users.partner!.id, roleOf.partner);
  membershipOf.manager = await addMembership(tenantA.id, users.manager!.id, roleOf.manager);
  membershipOf.reception = await addMembership(tenantA.id, users.reception!.id, roleOf.personel);
  membershipOf.suspended = await addMembership(tenantA.id, users.suspended!.id, roleOf.manager);
  await testDb`update tenant_memberships set status = 'suspended' where id = ${membershipOf.suspended}`;
  membershipOf.removed = await addMembership(tenantA.id, users.removed!.id, roleOf.manager);
  await testDb`update tenant_memberships set deleted_at = now() where id = ${membershipOf.removed}`;

  // One person: a Manager in tenant A and an unrestricted Owner in tenant B.
  membershipOf.dualA = await addMembership(tenantA.id, users.dual!.id, roleOf.manager);
  membershipOf.dualB = await addMembership(tenantB.id, users.dual!.id, tenantB.ownerRoleId);

  await testDb`update roles set deleted_at = now() where id = ${roleOf.deleted}`;
}, 180000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 120000);

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

type Verdict = "allow" | "ceiling" | "authority" | "no_staff_manage";
type Rpc = "create" | "resend" | "revoke";

const ALL_TARGETS = ["owner", "partner", "manager", "peer", "lower", "personel", "empty", "higher", "incomparable", "fake", "intern"];

/** What a MANAGER (16 keys, no unrestricted) may do per target role. */
const MANAGER_VERDICT: Record<string, Verdict> = {
  owner: "ceiling",
  partner: "ceiling",
  manager: "authority", // the manager's OWN role
  peer: "authority", // a different role with an EQUAL permission set
  lower: "allow",
  personel: "allow",
  empty: "allow",
  higher: "ceiling",
  incomparable: "ceiling",
  fake: "allow", // keyed SALON_OWNER, but only 3 permissions
  intern: "ceiling", // named "Stajyer", but holds every permission
};

function expectDenied(outcome: Outcome<unknown>, rpc: Rpc, verdict: Verdict) {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  if (verdict === "ceiling") expect(outcome.message).toBe(LEGACY_CEILING[rpc]);
  else if (verdict === "authority") expect(outcome.message).toBe("insufficient_authority");
  else if (verdict === "no_staff_manage") expect(outcome.message).toBe("staff.manage required");
}

async function runOne(rpc: Rpc, callerId: string, targetKey: string, verdict: Verdict, label: string) {
  const roleId = roleOf[targetKey]!;

  if (rpc === "create") {
    const email = emailFor(`${label}-c`);
    const before = await testDb<{ n: number }[]>`select count(*)::int as n from team_invitations where tenant_id = ${tenantA.id}`;
    const outcome = await create(callerId, tenantA.id, email, roleId);
    const after = await testDb<{ n: number }[]>`select count(*)::int as n from team_invitations where tenant_id = ${tenantA.id}`;
    if (verdict === "allow") {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.rows[0]!.status).toBe("pending");
      expect(outcome.rows[0]!.token).toMatch(/^[0-9a-f]{64}$/);
      expect(after[0]!.n).toBe(before[0]!.n + 1);
      const audit = await invitationAudit(outcome.rows[0]!.id, ["team_invitation.created"]);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor_user_id).toBe(callerId);
    } else {
      expectDenied(outcome, "create", verdict);
      expect(after[0]!.n).toBe(before[0]!.n); // nothing was written
    }
    return;
  }

  const invitation = await newInvitation(roleId, `${label}-${rpc}`);
  const before = await snapshot(invitation.id);
  const outcome =
    rpc === "resend" ? await resend(callerId, invitation.id, invitation.expiresAt) : await revoke(callerId, invitation.id);
  const after = await snapshot(invitation.id);
  const audit = await invitationAudit(invitation.id);

  if (verdict === "allow") {
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    if (rpc === "resend") {
      const row = outcome.rows[0] as ResendRow;
      expect(row.status).toBe("pending");
      expect(row.token).toMatch(/^[0-9a-f]{64}$/);
      expect(after.token_hash).toBe(sha256(row.token!));
      expect(after.token_hash).not.toBe(before.token_hash);
      expect(audit.map((a) => a.action)).toEqual(["team_invitation.resent"]);
    } else {
      expect((outcome.rows[0] as RevokeRow).status).toBe("revoked");
      expect(after.status).toBe("revoked");
      expect(after.revoked_by).toBe(callerId);
      expect(audit.map((a) => a.action)).toEqual(["team_invitation.revoked"]);
    }
    expect(audit[0]!.actor_user_id).toBe(callerId);
  } else {
    expectDenied(outcome, rpc, verdict);
    // A refused call leaves NO trace: same row, same token hash, no audit.
    expect(after).toEqual(before);
    expect(audit).toHaveLength(0);
  }
}

describe("F1 — authority matrix: create / resend / revoke versus the TARGET role's effective permissions", () => {
  const rpcs: Rpc[] = ["create", "resend", "revoke"];

  describe("Owner (unrestricted by the shipped SALON_OWNER role) may act on every live role", () => {
    for (const target of ["owner", "peer", "higher", "fake", "intern", "empty"]) {
      for (const rpc of rpcs) {
        it(`${rpc} -> ${target}: ALLOW`, async () => {
          await runOne(rpc, users.owner!.id, target, "allow", `own-${target}`);
        }, 40000);
      }
    }
  });

  describe("A differently named unrestricted member is judged on permissions, not on the name", () => {
    for (const target of ["owner", "manager", "intern"]) {
      for (const rpc of rpcs) {
        it(`${rpc} -> ${target}: ALLOW`, async () => {
          await runOne(rpc, users.partner!.id, target, "allow", `par-${target}`);
        }, 40000);
      }
    }
  });

  describe("Manager (16 permissions, not unrestricted)", () => {
    for (const target of ALL_TARGETS) {
      const verdict = MANAGER_VERDICT[target]!;
      for (const rpc of rpcs) {
        it(`${rpc} -> ${target}: ${verdict === "allow" ? "ALLOW" : `DENY (${verdict})`}`, async () => {
          await runOne(rpc, users.manager!.id, target, verdict, `mgr-${target}`);
        }, 40000);
      }
    }
  });

  describe("a member without staff.manage may act on nothing", () => {
    for (const target of ["personel", "empty"]) {
      for (const rpc of rpcs) {
        it(`${rpc} -> ${target}: DENY (no staff.manage)`, async () => {
          await runOne(rpc, users.reception!.id, target, "no_staff_manage", `rec-${target}`);
        }, 40000);
      }
    }
  });

  it("the roles used above really have the permission relations the matrix claims", async () => {
    const keys = async (roleId: string) =>
      (await testDb<{ key: string }[]>`
        select p.key from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = ${roleId} order by p.key`
      ).map((r) => r.key);
    const manager = new Set(await keys(roleOf.manager!));
    expect(await keys(roleOf.peer!)).toEqual(await keys(roleOf.manager!)); // equal sets, different roles
    expect(roleOf.peer).not.toBe(roleOf.manager);
    for (const k of await keys(roleOf.lower!)) expect(manager.has(k)).toBe(true);
    for (const k of await keys(roleOf.fake!)) expect(manager.has(k)).toBe(true);
    expect(await keys(roleOf.empty!)).toEqual([]);
    expect(manager.has(EXTRA_KEY)).toBe(false);
    expect((await keys(roleOf.incomparable!)).some((k) => !manager.has(k))).toBe(true);
    expect((await keys(roleOf.owner!)).length).toBeGreaterThan(MANAGER_KEYS.length);
  });
});

// ---------------------------------------------------------------------------
// Who may act at all; the tenant cannot be forged
// ---------------------------------------------------------------------------

describe("F1 — caller must be an ACTIVE member of the invitation's own tenant", () => {
  it("a stranger, an outsider (Owner of ANOTHER tenant), a suspended and a removed manager all get invitation_not_found — the same answer as for an id that does not exist", async () => {
    const invitation = await newInvitation(roleOf.lower!, "foreign");
    const before = await snapshot(invitation.id);
    const unknown = randomUUID();

    for (const [label, callerId] of [
      ["stranger", users.stranger!.id],
      ["outsider", users.outsider!.id],
      ["suspended", users.suspended!.id],
      ["removed", users.removed!.id],
    ] as const) {
      const resendReal = await resend(callerId, invitation.id, invitation.expiresAt);
      const resendGhost = await resend(callerId, unknown, invitation.expiresAt);
      const revokeReal = await revoke(callerId, invitation.id);
      const revokeGhost = await revoke(callerId, unknown);
      for (const outcome of [resendReal, resendGhost, revokeReal, revokeGhost]) {
        expect(outcome, label).toMatchObject({ ok: false, message: "invitation_not_found" });
      }
    }
    expect(await snapshot(invitation.id)).toEqual(before);
    expect(await invitationAudit(invitation.id)).toHaveLength(0);
  }, 60000);

  it("for create the same callers get `staff.manage required`, and nothing is written", async () => {
    const before = await testDb<{ n: number }[]>`select count(*)::int as n from team_invitations where tenant_id = ${tenantA.id}`;
    for (const callerId of [users.stranger!.id, users.outsider!.id, users.suspended!.id, users.removed!.id]) {
      const outcome = await create(callerId, tenantA.id, emailFor("nomember"), roleOf.lower!);
      expect(outcome).toMatchObject({ ok: false, message: "staff.manage required" });
    }
    const after = await testDb<{ n: number }[]>`select count(*)::int as n from team_invitations where tenant_id = ${tenantA.id}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  }, 60000);

  it("a member of the tenant WITHOUT staff.manage gets `staff.manage required` for resend and revoke", async () => {
    const invitation = await newInvitation(roleOf.lower!, "nostaffmanage");
    expect(await resend(users.reception!.id, invitation.id, invitation.expiresAt)).toMatchObject({
      ok: false,
      message: "staff.manage required",
    });
    expect(await revoke(users.reception!.id, invitation.id)).toMatchObject({ ok: false, message: "staff.manage required" });
    expect(await invitationAudit(invitation.id)).toHaveLength(0);
  }, 40000);

  it("the tenant is derived from the invitation: unrestricted authority in ANOTHER tenant grants nothing here", async () => {
    // `dual` is an unrestricted Owner of tenant B but only a Manager of tenant A.
    const ownerRoleInvitation = await newInvitation(roleOf.owner!, "dual-owner");
    const before = await snapshot(ownerRoleInvitation.id);
    expect(await resend(users.dual!.id, ownerRoleInvitation.id, ownerRoleInvitation.expiresAt)).toMatchObject({
      ok: false,
      message: LEGACY_CEILING.resend,
    });
    expect(await revoke(users.dual!.id, ownerRoleInvitation.id)).toMatchObject({ ok: false, message: LEGACY_CEILING.revoke });
    expect(await snapshot(ownerRoleInvitation.id)).toEqual(before);

    // ...and the same person cannot smuggle a role of the OTHER tenant in, in either direction.
    expect(await create(users.dual!.id, tenantA.id, emailFor("dual-x1"), tenantB.ownerRoleId)).toMatchObject({
      ok: false,
      message: "role not found in this tenant",
    });
    expect(await create(users.dual!.id, tenantB.id, emailFor("dual-x2"), roleOf.lower!)).toMatchObject({
      ok: false,
      message: "role not found in this tenant",
    });
    // In tenant B that same person IS unrestricted, judged by tenant B's own state.
    const inB = await create(users.dual!.id, tenantB.id, emailFor("dual-b"), tenantB.ownerRoleId);
    expect(inB.ok).toBe(true);
  }, 60000);

  it("an invitation can never point at a role of another tenant (structural), so its tenant cannot be forged through the role", async () => {
    await expect(testDb`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at)
      values (${tenantA.id}, ${emailFor("cross")}, ${tenantB.ownerRoleId}, ${users.owner!.id}, 'pending', ${sha256(randomBytes(8).toString("hex"))}, now() + interval '1 day')
    `).rejects.toMatchObject({ code: "23503" });
  });
});

// ---------------------------------------------------------------------------
// Deleted roles
// ---------------------------------------------------------------------------

describe("F1 — a deleted role", () => {
  it("cannot be resent by anyone (role_not_found), rotates nothing and writes no audit", async () => {
    for (const [label, callerId] of [["owner", users.owner!.id], ["manager", users.manager!.id]] as const) {
      const invitation = await newInvitation(roleOf.deleted!, `deleted-resend-${label}`);
      const before = await snapshot(invitation.id);
      const outcome = await resend(callerId, invitation.id, invitation.expiresAt);
      expect(outcome, label).toMatchObject({ ok: false, message: "role_not_found" });
      expect(await snapshot(invitation.id)).toEqual(before);
      expect(await invitationAudit(invitation.id)).toHaveLength(0);
    }
  }, 60000);

  it("cannot be invited into (role not found in this tenant)", async () => {
    expect(await create(users.owner!.id, tenantA.id, emailFor("del-create"), roleOf.deleted!)).toMatchObject({
      ok: false,
      message: "role not found in this tenant",
    });
    expect(await create(users.manager!.id, tenantA.id, emailFor("del-create-m"), roleOf.deleted!)).toMatchObject({
      ok: false,
      message: "role not found in this tenant",
    });
  }, 40000);

  it("can still be REVOKED (cleanup) by an authorized caller, with exactly one audit row", async () => {
    for (const [label, callerId] of [["owner", users.owner!.id], ["manager", users.manager!.id]] as const) {
      const invitation = await newInvitation(roleOf.deleted!, `deleted-revoke-${label}`);
      const outcome = await revoke(callerId, invitation.id);
      expect(outcome, label).toMatchObject({ ok: true });
      expect((await snapshot(invitation.id)).status).toBe("revoked");
      expect((await invitationAudit(invitation.id)).map((a) => a.action)).toEqual(["team_invitation.revoked"]);
    }
    // ...but a caller without staff.manage still may not.
    const invitation = await newInvitation(roleOf.deleted!, "deleted-revoke-nostaff");
    expect(await revoke(users.reception!.id, invitation.id)).toMatchObject({ ok: false, message: "staff.manage required" });
  }, 60000);

  it("acceptance is unchanged: an invitation into a deleted role is still not acceptable (invitation_not_found)", async () => {
    const invitation = await newInvitation(roleOf.deleted!, "deleted-accept");
    await testDb`update team_invitations set email = ${users.invitee!.email.toLowerCase()} where id = ${invitation.id}`;
    const outcome = await callAs(users.invitee!.id, (sql) => sql`select * from public.accept_team_invitation(${invitation.token}::text)`);
    expect(outcome).toMatchObject({ ok: false, message: "invitation_not_found" });
    expect((await snapshot(invitation.id)).status).toBe("pending");
  }, 40000);
});

// ---------------------------------------------------------------------------
// Existing state semantics, fencing, secrecy, audit
// ---------------------------------------------------------------------------

describe("F1 — state semantics and the optimistic fence are unchanged", () => {
  for (const status of ["revoked", "accepted", "expired"] as const) {
    it(`an authorized caller gets invitation_not_pending for a ${status} invitation (resend and revoke), and nothing changes`, async () => {
      for (const callerId of [users.owner!.id, users.manager!.id]) {
        const invitation = await newInvitation(roleOf.lower!, `state-${status}`, { status });
        const before = await snapshot(invitation.id);
        expect(await resend(callerId, invitation.id, invitation.expiresAt)).toMatchObject({ ok: false, message: "invitation_not_pending" });
        expect(await revoke(callerId, invitation.id)).toMatchObject({ ok: false, message: "invitation_not_pending" });
        expect(await snapshot(invitation.id)).toEqual(before);
        expect(await invitationAudit(invitation.id)).toHaveLength(0);
      }
    }, 60000);
  }

  it("authority is judged BEFORE state: a manager sees the ceiling denial, not the state, for an Owner-role invitation", async () => {
    const revokedOwnerInvitation = await newInvitation(roleOf.owner!, "auth-first", { status: "revoked" });
    expect(await resend(users.manager!.id, revokedOwnerInvitation.id, revokedOwnerInvitation.expiresAt)).toMatchObject({
      ok: false,
      message: LEGACY_CEILING.resend,
    });
    expect(await revoke(users.manager!.id, revokedOwnerInvitation.id)).toMatchObject({ ok: false, message: LEGACY_CEILING.revoke });
  }, 40000);

  it("a pending invitation past its expiry is transitioned to expired (no token, no audit) for resend and revoke — only for an AUTHORIZED caller", async () => {
    for (const rpc of ["resend", "revoke"] as const) {
      const denied = await newInvitation(roleOf.owner!, `stale-denied-${rpc}`, { expired: true });
      const deniedBefore = await snapshot(denied.id);
      const deniedOutcome =
        rpc === "resend" ? await resend(users.manager!.id, denied.id, denied.expiresAt) : await revoke(users.manager!.id, denied.id);
      expect(deniedOutcome).toMatchObject({ ok: false });
      expect(await snapshot(denied.id)).toEqual(deniedBefore); // the unauthorized caller could not even expire it

      const allowed = await newInvitation(roleOf.lower!, `stale-allowed-${rpc}`, { expired: true });
      const outcome =
        rpc === "resend" ? await resend(users.manager!.id, allowed.id, allowed.expiresAt) : await revoke(users.manager!.id, allowed.id);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.rows[0]!.status).toBe("expired");
      if (rpc === "resend") expect((outcome.rows[0] as ResendRow).token).toBeNull();
      expect((await snapshot(allowed.id)).status).toBe("expired");
      expect(await invitationAudit(allowed.id)).toHaveLength(0);
    }
  }, 60000);

  it("a matching expected_expires_at rotates exactly once; a replay, a stale value and NULL all raise invitation_changed and rotate nothing", async () => {
    const invitation = await newInvitation(roleOf.lower!, "fence");
    const first = await resend(users.manager!.id, invitation.id, invitation.expiresAt);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const afterFirst = await snapshot(invitation.id);
    expect(afterFirst.token_hash).toBe(sha256(first.rows[0]!.token!));

    for (const stale of [invitation.expiresAt, null, "2001-01-01T00:00:00+00"]) {
      const outcome = await resend(users.owner!.id, invitation.id, stale);
      expect(outcome, String(stale)).toMatchObject({ ok: false, message: "invitation_changed" });
    }
    expect(await snapshot(invitation.id)).toEqual(afterFirst);
    expect((await invitationAudit(invitation.id, ["team_invitation.resent"]))).toHaveLength(1);

    // The value the LAST resend returned is the new fence and works.
    const second = await resend(users.owner!.id, invitation.id, first.rows[0]!.expires_at);
    expect(second.ok).toBe(true);
    expect((await invitationAudit(invitation.id, ["team_invitation.resent"]))).toHaveLength(2);
  }, 60000);

  it("two concurrent resends with the SAME observation: exactly one wins, the other gets invitation_changed, the token rotates once", async () => {
    const invitation = await newInvitation(roleOf.lower!, "race");
    const original = await snapshot(invitation.id);
    const [a, b] = await Promise.all([
      resend(users.owner!.id, invitation.id, invitation.expiresAt),
      resend(users.manager!.id, invitation.id, invitation.expiresAt),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ message: "invitation_changed" });
    const final = await snapshot(invitation.id);
    expect(final.token_hash).not.toBe(original.token_hash);
    expect((await invitationAudit(invitation.id, ["team_invitation.resent"]))).toHaveLength(1);
  }, 60000);
});

describe("F1 — audit is exact and the raw token stays secret", () => {
  it("create, resend and revoke each write exactly one audit row carrying no token, hash or (resend/revoke) e-mail", async () => {
    const email = emailFor("audit");
    const created = await create(users.manager!.id, tenantA.id, email, roleOf.lower!);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { id, token, expires_at: expiresAt } = created.rows[0]!;

    const resent = await resend(users.manager!.id, id, expiresAt);
    expect(resent.ok).toBe(true);
    if (!resent.ok) return;
    const newToken = resent.rows[0]!.token!;
    expect(newToken).not.toBe(token);

    expect(await revoke(users.manager!.id, id)).toMatchObject({ ok: true });

    const audit = await invitationAudit(id);
    expect(audit.map((a) => a.action)).toEqual(["team_invitation.created", "team_invitation.resent", "team_invitation.revoked"]);
    for (const row of audit) expect(row.actor_user_id).toBe(users.manager!.id);
    expect(audit[0]!.after).toEqual({ email: email.toLowerCase(), role_id: roleOf.lower, staff_member_id: null });
    expect(audit[1]!.before).toBeNull();
    expect(audit[1]!.after).toBeNull();
    expect(audit[2]!.before).toBeNull();
    expect(audit[2]!.after).toBeNull();

    const serialized = JSON.stringify(audit);
    for (const secret of [token, newToken, sha256(token), sha256(newToken)]) expect(serialized).not.toContain(secret);
    // The audit table as a whole, for this invitation and this tenant's other rows, never contains them either.
    const [{ hits }] = await testDb<{ hits: number }[]>`
      select count(*)::int as hits from audit_logs
      where tenant_id = ${tenantA.id}
        and (strpos(coalesce(before::text, ''), ${token}) > 0 or strpos(coalesce(after::text, ''), ${token}) > 0
          or strpos(coalesce(before::text, ''), ${newToken}) > 0 or strpos(coalesce(after::text, ''), ${newToken}) > 0)`;
    expect(hits).toBe(0);
  }, 60000);

  it("a refused call returns no row (so no token) and the stored hash is never the plaintext token", async () => {
    const invitation = await newInvitation(roleOf.owner!, "secrecy");
    const denied = await resend(users.manager!.id, invitation.id, invitation.expiresAt);
    expect(denied.ok).toBe(false);
    expect("rows" in denied).toBe(false);

    const ok = await resend(users.owner!.id, invitation.id, invitation.expiresAt);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const token = ok.rows[0]!.token!;
    const [row] = await testDb<{ dump: string }[]>`select team_invitations::text as dump from team_invitations where id = ${invitation.id}`;
    expect(row!.dump).not.toContain(token);
  }, 40000);
});

// ---------------------------------------------------------------------------
// Authority is read at call time, from effective permissions
// ---------------------------------------------------------------------------

describe("F1 — authority follows the CURRENT permissions of both sides", () => {
  it("adding a permission the manager lacks to the target role makes the manager lose authority over it; removing it restores it", async () => {
    const roleId = await createCustomRole(tenantA.id, "Dinamik Rol", ["appointments.view"]);
    const before = await newInvitation(roleId, "dyn-1");
    expect(await resend(users.manager!.id, before.id, before.expiresAt)).toMatchObject({ ok: true });

    await testDb`
      insert into role_permissions (role_id, permission_id) select ${roleId}, id from permissions where key = ${EXTRA_KEY}`;
    const denied = await newInvitation(roleId, "dyn-2");
    expect(await resend(users.manager!.id, denied.id, denied.expiresAt)).toMatchObject({ ok: false, message: LEGACY_CEILING.resend });
    expect(await revoke(users.manager!.id, denied.id)).toMatchObject({ ok: false, message: LEGACY_CEILING.revoke });
    expect(await create(users.manager!.id, tenantA.id, emailFor("dyn-c"), roleId)).toMatchObject({ ok: false, message: LEGACY_CEILING.create });

    await testDb`
      delete from role_permissions where role_id = ${roleId} and permission_id = (select id from permissions where key = ${EXTRA_KEY})`;
    const restored = await newInvitation(roleId, "dyn-3");
    expect(await revoke(users.manager!.id, restored.id)).toMatchObject({ ok: true });
  }, 60000);

  it("giving the target role EXACTLY the manager's permissions turns ALLOW into insufficient_authority", async () => {
    const roleId = await createCustomRole(tenantA.id, "Eşitlenen Rol", RECEPTION_KEYS);
    const invitation = await newInvitation(roleId, "eq-1");
    expect(await revoke(users.manager!.id, invitation.id)).toMatchObject({ ok: true });

    await testDb`delete from role_permissions where role_id = ${roleId}`;
    await testDb`
      insert into role_permissions (role_id, permission_id) select ${roleId}, id from permissions where key in ${testDb(MANAGER_KEYS)}`;
    const equal = await newInvitation(roleId, "eq-2");
    expect(await resend(users.manager!.id, equal.id, equal.expiresAt)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await revoke(users.manager!.id, equal.id)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await create(users.manager!.id, tenantA.id, emailFor("eq-c"), roleId)).toMatchObject({ ok: false, message: "insufficient_authority" });
  }, 60000);

  it("a manager who is demoted or suspended loses the ability immediately", async () => {
    const email = `inv-tia2-demote-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const demoted = await createTestUser("tia2-demoted");
    createdUserIds.push(demoted.id);
    const membershipId = await addMembership(tenantA.id, demoted.id, roleOf.manager!);
    const invitation = await newInvitation(roleOf.lower!, "demote");

    expect(await create(demoted.id, tenantA.id, email, roleOf.lower!)).toMatchObject({ ok: true });

    await testDb`update tenant_memberships set role_id = ${roleOf.personel} where id = ${membershipId}`;
    expect(await revoke(demoted.id, invitation.id)).toMatchObject({ ok: false, message: "staff.manage required" });

    await testDb`update tenant_memberships set role_id = ${roleOf.manager}, status = 'suspended' where id = ${membershipId}`;
    expect(await revoke(demoted.id, invitation.id)).toMatchObject({ ok: false, message: "invitation_not_found" });
  }, 60000);
});

// ---------------------------------------------------------------------------
// Privilege surface of the new objects
// ---------------------------------------------------------------------------

describe("F1 — privilege surface", () => {
  it("the two new helpers are SECURITY DEFINER with an empty search_path and executable by no client role and not by PUBLIC", async () => {
    const rows = await testDb<
      { proname: string; prosecdef: boolean; config: string[] | null; public_grant: boolean; anon: boolean; authenticated: boolean; service_role: boolean }[]
    >`
      select p.proname, p.prosecdef, p.proconfig as config,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_grant,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role
      from pg_proc p
      where p.pronamespace = 'private'::regnamespace
        and p.proname in ('invitation_role_authority_decision', 'assert_invitation_role_authority')
      order by p.proname`;
    expect(rows.map((r) => r.proname)).toEqual(["assert_invitation_role_authority", "invitation_role_authority_decision"]);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.config, r.proname).toContain("search_path=\"\"");
      expect(r.public_grant, r.proname).toBe(false);
      expect(r.anon, r.proname).toBe(false);
      expect(r.authenticated, r.proname).toBe(false);
      expect(r.service_role, r.proname).toBe(false);
    }
  });

  it("the three public invitation RPCs stay executable by authenticated only (never anon, never PUBLIC)", async () => {
    const rows = await testDb<{ proname: string; public_grant: boolean; anon: boolean; authenticated: boolean }[]>`
      select p.proname,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_grant,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('create_team_invitation', 'resend_team_invitation', 'revoke_team_invitation')`;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.public_grant, r.proname).toBe(false);
      expect(r.anon, r.proname).toBe(false);
      expect(r.authenticated, r.proname).toBe(true);
    }
  });
});
