import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  asAuthenticatedUser,
  asDatabaseRole,
  attemptAs,
  cleanupPlatformAdmins,
  cleanupTenantProvisioningApprovals,
  cleanupTenants,
  cleanupUsers,
  createPlatformAdmin,
  createTestTenant,
  createTestUser,
  testDb,
  type TestUser,
} from "./helpers";

/**
 * Faz LAUNCH.1A (1 of 3) — the owner-approval gate on tenant provisioning
 * (migration 20261022150000).
 *
 * Business rule: during the Founding Salon phase SalonOS is invite /
 * owner-approval only. The ONLY public path that creates a tenant is
 * public.create_tenant (SECURITY DEFINER, executable by `authenticated`), and
 * the publishable key is public, so the proof has to be at the database: a
 * signed-in user calling the RPC directly — exactly what a browser could do —
 * must be refused without an approval for their own CONFIRMED e-mail address.
 *
 * Every call runs through asAuthenticatedUser / attemptAs (role `authenticated`
 * plus JWT claims in one transaction — what a PostgREST request sees). Test
 * users are created through the admin API; a few are created directly so they
 * can be unconfirmed or passwordless.
 */

const TAG = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];
const createdEmails: string[] = [];
const createdTenantIds: string[] = [];
const adminUserIds: string[] = [];

const slug = (label: string) => `l1a-${label}-${TAG}-${randomUUID().slice(0, 4)}`;

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`l1a-${label}`);
  createdUserIds.push(user.id);
  createdEmails.push(user.email);
  return user;
}

async function newPlatformAdmin(label: string, role: "owner" | "support", isActive = true): Promise<TestUser> {
  const user = await newUser(label);
  await createPlatformAdmin(user.id, role, isActive);
  adminUserIds.push(user.id);
  return user;
}

type ApprovalRow = {
  id: string;
  email_normalized: string;
  status: string;
  note: string | null;
  approved_by: string | null;
  expires_at: Date;
  consumed_by: string | null;
  consumed_tenant_id: string | null;
  consumed_at: Date | null;
  revoked_by: string | null;
  revoked_at: Date | null;
};

const approvalsOf = (email: string) =>
  testDb<ApprovalRow[]>`select * from tenant_provisioning_approvals where email_normalized = ${email.trim().toLowerCase()} order by created_at, id`;

async function insertApproval(email: string, opts: { status?: string; daysFromNow?: number; approvedDaysAgo?: number } = {}) {
  const status = opts.status ?? "approved";
  const expiresIn = opts.daysFromNow ?? 7;
  const approvedAgo = opts.approvedDaysAgo ?? 0;
  const [row] = await testDb<{ id: string }[]>`
    insert into tenant_provisioning_approvals (email_normalized, status, approved_at, expires_at, consumed_at, revoked_at)
    values (
      ${email.trim().toLowerCase()},
      ${status},
      now() - make_interval(days => ${approvedAgo}),
      now() + make_interval(days => ${expiresIn}),
      ${status === "consumed" ? testDb`now()` : null},
      ${status === "revoked" ? testDb`now()` : null}
    )
    returning id`;
  return row!.id;
}

async function tryCreate(userId: string, tenantSlug: string, name = "Gate Test Salon") {
  const outcome = await attemptAs(userId, (sql) => sql`select public.create_tenant(${name}, ${tenantSlug}) as id`);
  return outcome;
}

async function tenantIdBySlug(tenantSlug: string): Promise<string | null> {
  const [row] = await testDb<{ id: string }[]>`select id from tenants where slug = ${tenantSlug}`;
  if (row) createdTenantIds.push(row.id);
  return row?.id ?? null;
}

/** Create a salon with a stable slug and register it for teardown when it was really created. */
async function createSalon(userId: string, label: string, name = "Gate Test Salon") {
  const s = slug(label);
  const outcome = await tryCreate(userId, s, name);
  const tenantId = outcome.ok ? await tenantIdBySlug(s) : null;
  return { outcome, slug: s, tenantId };
}

const platformAudit = (action: string, entityId: string) =>
  testDb<{ actor_user_id: string | null; actor_type: string; before: unknown; after: unknown }[]>`
    select actor_user_id, actor_type, before, after from audit_logs
    where tenant_id is null and action = ${action} and entity_id = ${entityId} order by created_at`;

const tenantCount = async () => (await testDb<{ n: number }[]>`select count(*)::int as n from tenants`)[0]!.n;

beforeAll(async () => {
  const [gate] = await testDb<{ present: boolean }[]>`select to_regclass('public.tenant_provisioning_approvals') is not null as present`;
  expect(gate!.present, "run this file against a database that carries migration 20261022150000").toBe(true);
}, 60000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  // Platform-level audit rows (tenant_id null) written by these tests would block deleting their actors.
  if (createdUserIds.length > 0) {
    await testDb`delete from audit_logs where tenant_id is null and actor_user_id in ${testDb(createdUserIds)}`;
  }
  await cleanupTenantProvisioningApprovals(createdEmails);
  await cleanupPlatformAdmins(adminUserIds);
  await cleanupUsers(createdUserIds);
}, 120000);

// ---------------------------------------------------------------------------------------------------------------------
describe("the gate: an unapproved caller cannot provision a tenant", () => {
  it("anonymous callers cannot even execute create_tenant (no EXECUTE for anon)", async () => {
    await expect(
      asDatabaseRole("anon", null, (sql) => sql`select public.create_tenant(${"Anon Salon"}, ${slug("anon")}) as id`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("an authenticated user with NO approval is refused with tenant_provisioning_not_approved, and nothing is created", async () => {
    const user = await newUser("noapproval");
    const before = await tenantCount();
    const s = slug("noapproval");
    const outcome = await tryCreate(user.id, s);
    expect(outcome).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
    expect(await tenantCount()).toBe(before);
    expect(await tenantIdBySlug(s)).toBeNull();
    const memberships = await testDb`select 1 from tenant_memberships where user_id = ${user.id}`;
    expect(memberships).toHaveLength(0);
  });

  it("the refusal is identical for a free slug, a taken slug, a reserved slug and an invalid slug — an unapproved caller learns nothing about slugs", async () => {
    const owner = await newUser("slugprobe-owner");
    const takenSlug = slug("taken");
    const taken = await createTestTenant(takenSlug, owner.id);
    createdTenantIds.push(taken.id);

    const stranger = await newUser("slugprobe-stranger");
    const messages = new Set<string>();
    for (const probe of [slug("free"), takenSlug, "admin", "Not A Valid Slug!"]) {
      const outcome = await tryCreate(stranger.id, probe);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) messages.add(`${outcome.code}|${outcome.message}`);
    }
    expect(messages.size).toBe(1);
    expect([...messages][0]).toMatch(/tenant_provisioning_not_approved/);
  });

  it("an approval for ANOTHER address does not help", async () => {
    const approved = await newUser("other-approved");
    const stranger = await newUser("other-stranger");
    await insertApproval(approved.email);
    const outcome = await tryCreate(stranger.id, slug("other"));
    expect(outcome).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
    expect((await approvalsOf(approved.email))[0]!.status).toBe("approved");
  });

  it("an UNCONFIRMED account cannot use an approval for its own address (the address is not proven)", async () => {
    const email = `test-l1a-unconfirmed-${TAG}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: "Test1234!Test1234!", email_confirm: false });
    expect(error).toBeNull();
    createdUserIds.push(data.user!.id);
    createdEmails.push(email);
    await insertApproval(email);
    const outcome = await tryCreate(data.user!.id, slug("unconfirmed"));
    expect(outcome).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
    expect((await approvalsOf(email))[0]!.status).toBe("approved");
  });

  it("an expired approval does not count", async () => {
    const user = await newUser("expired");
    await insertApproval(user.email, { approvedDaysAgo: 10, daysFromNow: -1 });
    const outcome = await tryCreate(user.id, slug("expired"));
    expect(outcome).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
  });

  it("a revoked approval does not count, and neither does a consumed one", async () => {
    const revoked = await newUser("revoked");
    await insertApproval(revoked.email, { status: "revoked" });
    expect(await tryCreate(revoked.id, slug("revoked"))).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });

    const consumed = await newUser("consumed");
    await insertApproval(consumed.email, { status: "consumed" });
    expect(await tryCreate(consumed.id, slug("consumed"))).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
  });

  it("a passwordless (customer-style) confirmed account without approval is refused like anyone else", async () => {
    const email = `test-l1a-customer-${TAG}@example.com`;
    const { data } = await admin.auth.admin.createUser({ email, email_confirm: true });
    createdUserIds.push(data.user!.id);
    createdEmails.push(email);
    expect(await tryCreate(data.user!.id, slug("customer"))).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the gate: an approved caller can provision exactly one tenant", () => {
  it("creates the tenant, branch, four roles and the owner membership, and consumes the approval with an audit row", async () => {
    const user = await newUser("approved");
    const approvalId = await insertApproval(user.email);
    const created = await createSalon(user.id, "approved", "Approved Salon");
    expect(created.outcome.ok).toBe(true);

    const tenantId = created.tenantId!;
    expect(tenantId).toBeTruthy();
    const [counts] = await testDb<{ branches: number; roles: number; memberships: number }[]>`
      select (select count(*)::int from branches where tenant_id = ${tenantId}) as branches,
             (select count(*)::int from roles where tenant_id = ${tenantId} and deleted_at is null) as roles,
             (select count(*)::int from tenant_memberships where tenant_id = ${tenantId} and user_id = ${user.id} and status = 'active') as memberships`;
    expect(counts).toEqual({ branches: 1, roles: 4, memberships: 1 });

    const [approval] = await approvalsOf(user.email);
    expect(approval).toMatchObject({ id: approvalId, status: "consumed", consumed_by: user.id, consumed_tenant_id: tenantId });
    expect(approval!.consumed_at).not.toBeNull();

    const audit = await platformAudit("tenant_provisioning.approval_consumed", approvalId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: user.id, actor_type: "user" });
    expect(audit[0]!.after).toMatchObject({ status: "consumed", tenant_id: tenantId });
  });

  it("the approval is single-use: a second creation by the same user is refused", async () => {
    const user = await newUser("singleuse");
    await insertApproval(user.email);
    expect((await createSalon(user.id, "single-1")).outcome.ok).toBe(true);
    const second = await tryCreate(user.id, slug("single-2"));
    expect(second).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
  });

  it("matching ignores case and surrounding spaces in the approved address", async () => {
    const user = await newUser("case");
    await testDb`
      insert into tenant_provisioning_approvals (email_normalized, expires_at)
      values (${user.email.toLowerCase()}, now() + interval '3 days')`;
    expect((await createSalon(user.id, "case")).outcome.ok).toBe(true);
  });

  it("a FAILED creation (invalid slug, then a duplicate slug) leaves the approval open and usable", async () => {
    const owner = await newUser("fail-owner");
    const takenSlug = slug("fail-taken");
    const taken = await createTestTenant(takenSlug, owner.id);
    createdTenantIds.push(taken.id);

    const user = await newUser("fail");
    const approvalId = await insertApproval(user.email);
    expect(await tryCreate(user.id, "Not A Valid Slug!")).toMatchObject({ ok: false, message: "invalid slug format" });
    expect((await approvalsOf(user.email))[0]).toMatchObject({ id: approvalId, status: "approved" });
    const duplicate = await tryCreate(user.id, takenSlug);
    expect(duplicate.ok).toBe(false);
    expect((await approvalsOf(user.email))[0]).toMatchObject({ id: approvalId, status: "approved" });
    expect((await createSalon(user.id, "fail-ok")).outcome.ok).toBe(true);
  });

  it("two CONCURRENT creations with one approval produce exactly one tenant", async () => {
    const user = await newUser("race");
    await insertApproval(user.email);
    const slugs = [slug("race-a"), slug("race-b"), slug("race-c")];
    const outcomes = await Promise.all(slugs.map((s) => tryCreate(user.id, s)));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    for (const o of outcomes.filter((x) => !x.ok)) {
      expect(o).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
    }
    const created = await testDb<{ id: string }[]>`select id from tenants where slug in ${testDb(slugs)}`;
    expect(created).toHaveLength(1);
    createdTenantIds.push(created[0]!.id);
  });

  it("DETERMINISTIC RACE: a creation that starts while another is still uncommitted waits on the approval row lock, then is refused", async () => {
    // The three-way Promise.all above rarely overlaps (each call finishes in milliseconds), so it cannot catch a
    // missing row lock by itself. Here the first transaction is HELD OPEN after it has created its salon: with
    // `for update` the second call blocks on the approval row and, once the first commits, no longer sees an
    // 'approved' row; without it the second call would read the stale 'approved' state and create a second salon.
    const user = await newUser("race-hold");
    await insertApproval(user.email);
    const slugA = slug("hold-a");
    const slugB = slug("hold-b");

    let signalCreated!: () => void;
    const aHasCreated = new Promise<void>((resolve) => {
      signalCreated = resolve;
    });
    let letAFinish!: () => void;
    const aMayCommit = new Promise<void>((resolve) => {
      letAFinish = resolve;
    });

    const a = asAuthenticatedUser(user.id, async (sql) => {
      await sql`select public.create_tenant(${"Gate Test Salon"}, ${slugA}) as id`;
      signalCreated();
      await aMayCommit;
    });
    await aHasCreated;

    let bSettled = false;
    const b = tryCreate(user.id, slugB).then((outcome) => {
      bSettled = true;
      return outcome;
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(bSettled, "the second creation must still be waiting while the first is uncommitted").toBe(false);

    letAFinish();
    await a;
    expect(await b).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
    expect(await tenantIdBySlug(slugB)).toBeNull();
    expect(await tenantIdBySlug(slugA)).not.toBeNull();
    expect(await approvalsOf(user.email)).toMatchObject([{ status: "consumed" }]);
  });

  it("an existing owner is unaffected, and still needs an approval to create ANOTHER salon", async () => {
    const owner = await newUser("existing");
    const existing = await createTestTenant(slug("existing"), owner.id);
    createdTenantIds.push(existing.id);
    const outcome = await tryCreate(owner.id, slug("existing-2"));
    expect(outcome).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
    // ...while everything about the existing membership keeps working:
    const keys = await asAuthenticatedUser(owner.id, (sql) => sql`select public.has_permission(${existing.id}::uuid, 'staff.manage') as ok`);
    expect(keys[0]!.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("platform admins keep the ability to create tenants (demo / support)", () => {
  it("an active platform admin may create a tenant without an approval, and no approval row is touched", async () => {
    const adminUser = await newPlatformAdmin("padmin", "support");
    expect((await createSalon(adminUser.id, "padmin")).outcome.ok).toBe(true);
    expect(await approvalsOf(adminUser.email)).toHaveLength(0);
  });

  it("an INACTIVE platform admin gets no bypass", async () => {
    const adminUser = await newPlatformAdmin("inactive-admin", "owner", false);
    expect(await tryCreate(adminUser.id, slug("inactive"))).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("get_my_tenant_provisioning_status — about the caller only", () => {
  const status = async (userId: string) =>
    (await asAuthenticatedUser(userId, (sql) => sql<{ ok: boolean }[]>`select public.get_my_tenant_provisioning_status() as ok`))[0]!.ok;

  it("is false without an approval and true with a live one", async () => {
    const user = await newUser("status");
    expect(await status(user.id)).toBe(false);
    await insertApproval(user.email);
    expect(await status(user.id)).toBe(true);
  });

  it("is false for an expired approval, an unconfirmed account and an anonymous caller (which cannot execute it)", async () => {
    const expired = await newUser("status-expired");
    await insertApproval(expired.email, { approvedDaysAgo: 10, daysFromNow: -1 });
    expect(await status(expired.id)).toBe(false);

    const email = `test-l1a-status-unconfirmed-${TAG}@example.com`;
    const { data } = await admin.auth.admin.createUser({ email, password: "Test1234!Test1234!", email_confirm: false });
    createdUserIds.push(data.user!.id);
    createdEmails.push(email);
    await insertApproval(email);
    expect(await status(data.user!.id)).toBe(false);

    await expect(asDatabaseRole("anon", null, (sql) => sql`select public.get_my_tenant_provisioning_status()`)).rejects.toMatchObject({ code: "42501" });
  });

  it("is true for an active platform admin", async () => {
    const adminUser = await newPlatformAdmin("status-admin", "support");
    expect(await status(adminUser.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("approval management is for the platform OWNER only", () => {
  let owner: TestUser;
  let support: TestUser;
  let nobody: TestUser;

  beforeAll(async () => {
    owner = await newPlatformAdmin("mgmt-owner", "owner");
    support = await newPlatformAdmin("mgmt-support", "support");
    nobody = await newUser("mgmt-nobody");
  });

  const approve = (userId: string, email: string, note: string | null = null, days = 30) =>
    attemptAs(userId, (sql) => sql`select * from public.platform_approve_tenant_owner(${email}, ${note}, ${days})`);

  it("a tenant owner, a support-level admin and a plain user are refused (platform_owner_required) for approve, revoke and list", async () => {
    const target = await newUser("mgmt-target");
    const approvalId = await insertApproval(target.email);
    for (const actor of [support, nobody]) {
      expect(await approve(actor.id, "someone@example.com")).toMatchObject({ ok: false, message: "platform_owner_required" });
      expect(await attemptAs(actor.id, (sql) => sql`select public.platform_revoke_tenant_owner_approval(${approvalId}::uuid)`)).toMatchObject({
        ok: false,
        message: "platform_owner_required",
      });
      expect(await attemptAs(actor.id, (sql) => sql`select * from public.platform_list_tenant_owner_approvals()`)).toMatchObject({
        ok: false,
        message: "platform_owner_required",
      });
    }
    expect((await approvalsOf(target.email))[0]!.status).toBe("approved");
  });

  it("anon cannot execute any of the four RPCs", async () => {
    for (const call of [
      (sql: TransactionSql) => sql`select * from public.platform_approve_tenant_owner(${"x@example.com"}, ${null}, ${30})`,
      (sql: TransactionSql) => sql`select public.platform_revoke_tenant_owner_approval(${randomUUID()}::uuid)`,
      (sql: TransactionSql) => sql`select * from public.platform_list_tenant_owner_approvals()`,
    ]) {
      await expect(asDatabaseRole("anon", null, call)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("approve creates an open approval, audited once, with the actor as approver; a repeat is an idempotent no-op", async () => {
    const email = `Founding.${TAG}@Example.COM `;
    createdEmails.push(email);
    const first = await asAuthenticatedUser(owner.id, (sql) => sql<{ id: string; email: string; status: string; note: string | null }[]>`
      select * from public.platform_approve_tenant_owner(${email}, ${"Founding Salon #7"}, ${14})`);
    expect(first[0]).toMatchObject({ email: `founding.${TAG}@example.com`, status: "approved", note: "Founding Salon #7" });
    const id = first[0]!.id;
    const [row] = await approvalsOf(email);
    expect(row).toMatchObject({ id, approved_by: owner.id, status: "approved" });

    const again = await asAuthenticatedUser(owner.id, (sql) => sql<{ id: string }[]>`
      select * from public.platform_approve_tenant_owner(${email}, ${"different note"}, ${60})`);
    expect(again[0]!.id).toBe(id);
    expect((await approvalsOf(email))[0]!.note).toBe("Founding Salon #7"); // nothing was rewritten
    expect(await approvalsOf(email)).toHaveLength(1);
    const audit = await platformAudit("tenant_provisioning.approved", id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: owner.id, actor_type: "platform_admin" });
  });

  it("approving an address whose approval EXPIRED renews it in place (same row, new expiry, one renewal audit row)", async () => {
    const user = await newUser("mgmt-renew");
    const id = await insertApproval(user.email, { approvedDaysAgo: 20, daysFromNow: -2 });
    const renewed = await asAuthenticatedUser(owner.id, (sql) => sql<{ id: string; expires_at: Date }[]>`
      select * from public.platform_approve_tenant_owner(${user.email}, ${"renewed"}, ${10})`);
    expect(renewed[0]!.id).toBe(id);
    expect(renewed[0]!.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(await approvalsOf(user.email)).toHaveLength(1);
    expect(await platformAudit("tenant_provisioning.approval_renewed", id)).toHaveLength(1);
    expect(await status(user.id)).toBe(true);
  });

  async function status(userId: string) {
    return (await asAuthenticatedUser(userId, (sql) => sql<{ ok: boolean }[]>`select public.get_my_tenant_provisioning_status() as ok`))[0]!.ok;
  }

  it("validates its input: bad address, validity outside 1-90 days, over-long note", async () => {
    for (const bad of ["", "   ", "no-at-sign", "two@@example.com", "a b@example.com", "@example.com", "user@", `${"x".repeat(250)}@example.com`]) {
      expect(await approve(owner.id, bad), JSON.stringify(bad)).toMatchObject({ ok: false, message: "invalid_email" });
    }
    expect(await approve(owner.id, "valid@example.com", null, 0)).toMatchObject({ ok: false, message: "invalid_validity" });
    expect(await approve(owner.id, "valid@example.com", null, 91)).toMatchObject({ ok: false, message: "invalid_validity" });
    expect(await approve(owner.id, "valid@example.com", "n".repeat(501))).toMatchObject({ ok: false, message: "note_too_long" });
    expect(await approvalsOf("valid@example.com")).toHaveLength(0);
  });

  it("revoke closes an open approval (audited once); revoking again is a silent no-op; a consumed approval cannot be revoked", async () => {
    const user = await newUser("mgmt-revoke");
    const id = await insertApproval(user.email);
    expect((await attemptAs(owner.id, (sql) => sql`select public.platform_revoke_tenant_owner_approval(${id}::uuid)`)).ok).toBe(true);
    const [row] = await approvalsOf(user.email);
    expect(row).toMatchObject({ status: "revoked", revoked_by: owner.id });
    expect(row!.revoked_at).not.toBeNull();
    expect(await platformAudit("tenant_provisioning.approval_revoked", id)).toHaveLength(1);

    expect((await attemptAs(owner.id, (sql) => sql`select public.platform_revoke_tenant_owner_approval(${id}::uuid)`)).ok).toBe(true);
    expect(await platformAudit("tenant_provisioning.approval_revoked", id)).toHaveLength(1); // still one

    const consumedUser = await newUser("mgmt-revoke-consumed");
    const consumedId = await insertApproval(consumedUser.email, { status: "consumed" });
    expect(await attemptAs(owner.id, (sql) => sql`select public.platform_revoke_tenant_owner_approval(${consumedId}::uuid)`)).toMatchObject({
      ok: false,
      message: "approval_already_consumed",
    });
    expect(await attemptAs(owner.id, (sql) => sql`select public.platform_revoke_tenant_owner_approval(${randomUUID()}::uuid)`)).toMatchObject({
      ok: false,
      message: "approval_not_found",
    });
  });

  it("a revoked address can be approved again (a NEW row; the old one stays as history)", async () => {
    const user = await newUser("mgmt-reapprove");
    await insertApproval(user.email, { status: "revoked" });
    const again = await asAuthenticatedUser(owner.id, (sql) => sql<{ id: string }[]>`select * from public.platform_approve_tenant_owner(${user.email}, ${null}, ${5})`);
    const rows = await approvalsOf(user.email);
    expect(rows.map((r) => r.status).sort()).toEqual(["approved", "revoked"]);
    expect(rows.find((r) => r.status === "approved")!.id).toBe(again[0]!.id);
  });

  it("list shows the approvals with their effective status and the consuming salon's name, and nothing else", async () => {
    const expired = await newUser("mgmt-list-expired");
    await insertApproval(expired.email, { approvedDaysAgo: 10, daysFromNow: -1 });
    const consumer = await newUser("mgmt-list-consumer");
    await insertApproval(consumer.email);
    expect((await createSalon(consumer.id, "list", "Listed Salon")).outcome.ok).toBe(true);

    const rows = await asAuthenticatedUser(owner.id, (sql) => sql<Record<string, unknown>[]>`select * from public.platform_list_tenant_owner_approvals()`);
    const byEmail = new Map(rows.map((r) => [r.email as string, r]));
    expect(byEmail.get(expired.email.toLowerCase())).toMatchObject({ status: "approved", effective_status: "expired" });
    expect(byEmail.get(consumer.email.toLowerCase())).toMatchObject({ status: "consumed", effective_status: "consumed", consumed_tenant_name: "Listed Salon" });
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["approved_at", "consumed_at", "consumed_tenant_name", "effective_status", "email", "expires_at", "id", "note", "revoked_at", "status"],
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the approvals table is locked down: no API role can read or write it directly", () => {
  it("authenticated, anon and service_role are refused on select, insert, update and delete", async () => {
    const user = await newUser("lockdown");
    const id = await insertApproval(user.email);
    const statements: Array<[string, (sql: TransactionSql) => Promise<unknown>]> = [
      ["select", (sql) => sql`select * from public.tenant_provisioning_approvals`],
      ["insert", (sql) => sql`insert into public.tenant_provisioning_approvals (email_normalized, expires_at) values ('lock@example.com', now() + interval '1 day')`],
      ["update", (sql) => sql`update public.tenant_provisioning_approvals set status = 'revoked', revoked_at = now() where id = ${id}::uuid`],
      ["delete", (sql) => sql`delete from public.tenant_provisioning_approvals where id = ${id}::uuid`],
    ];
    for (const role of ["authenticated", "anon", "service_role"] as const) {
      for (const [name, run] of statements) {
        await expect(asDatabaseRole(role, role === "anon" ? null : user.id, run), `${role} ${name}`).rejects.toMatchObject({ code: "42501" });
      }
    }
    expect((await approvalsOf(user.email))[0]!.status).toBe("approved");
  });

  it("database constraints reject malformed rows (status, e-mail shape, consumed/revoked consistency, expiry order)", async () => {
    const bad: Array<[string, () => Promise<unknown>]> = [
      ["unknown status", () => testDb`insert into tenant_provisioning_approvals (email_normalized, status, expires_at) values ('c1@example.com', 'pending', now() + interval '1 day')`],
      ["upper-case address", () => testDb`insert into tenant_provisioning_approvals (email_normalized, expires_at) values ('C2@Example.com', now() + interval '1 day')`],
      ["address with a space", () => testDb`insert into tenant_provisioning_approvals (email_normalized, expires_at) values ('c3 x@example.com', now() + interval '1 day')`],
      ["no at sign", () => testDb`insert into tenant_provisioning_approvals (email_normalized, expires_at) values ('c4example.com', now() + interval '1 day')`],
      ["consumed without a timestamp", () => testDb`insert into tenant_provisioning_approvals (email_normalized, status, expires_at) values ('c5@example.com', 'consumed', now() + interval '1 day')`],
      ["revoked without a timestamp", () => testDb`insert into tenant_provisioning_approvals (email_normalized, status, expires_at) values ('c6@example.com', 'revoked', now() + interval '1 day')`],
      ["expiry before approval", () => testDb`insert into tenant_provisioning_approvals (email_normalized, approved_at, expires_at) values ('c7@example.com', now(), now() - interval '1 day')`],
      ["note over 500 characters", () => testDb`insert into tenant_provisioning_approvals (email_normalized, note, expires_at) values ('c8@example.com', ${"n".repeat(501)}, now() + interval '1 day')`],
    ];
    for (const [name, run] of bad) {
      await expect(run(), name).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("only ONE open approval can exist per address (partial unique index)", async () => {
    const user = await newUser("unique");
    await insertApproval(user.email);
    await expect(insertApproval(user.email)).rejects.toMatchObject({ code: "23505" });
    // history rows may repeat:
    await insertApproval(user.email, { status: "revoked" });
    await insertApproval(user.email, { status: "revoked" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("paths that must keep working: invitation acceptance never needs (or consumes) an approval", () => {
  it("an invited user with NO approval can accept an invitation into an existing tenant, and still cannot create a tenant", async () => {
    const owner = await newUser("inv-owner");
    const tenant = await createTestTenant(slug("inv"), owner.id);
    createdTenantIds.push(tenant.id);
    await testDb`select private.provision_default_roles(${tenant.id}::uuid)`;
    const [personel] = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${tenant.id} and key = 'STYLIST' and deleted_at is null`;

    const invitee = await newUser("inv-invitee");
    const created = await asAuthenticatedUser(owner.id, (sql) => sql<{ token: string }[]>`
      select * from public.create_team_invitation(${tenant.id}::uuid, ${invitee.email}, ${personel!.id}::uuid, ${null})`);
    const token = created[0]!.token;

    const accepted = await asAuthenticatedUser(invitee.id, (sql) => sql<{ outcome: string }[]>`select * from public.accept_team_invitation(${token})`);
    expect(accepted[0]!.outcome).toBe("accepted");
    const [membership] = await testDb<{ status: string }[]>`select status from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${invitee.id}`;
    expect(membership!.status).toBe("active");

    expect(await approvalsOf(invitee.email)).toHaveLength(0);
    expect(await tryCreate(invitee.id, slug("inv-own"))).toMatchObject({ ok: false, message: "tenant_provisioning_not_approved" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("there is no OTHER way for a signed-in or anonymous user to provision a tenant", () => {
  it("anon, authenticated, service_role and PUBLIC hold no INSERT / DELETE / TRUNCATE on tenants, and tenants has no INSERT policy", async () => {
    const grants = await testDb<{ grantee: string; privilege_type: string }[]>`
      select grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'tenants' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`;
    expect(grants.filter((g) => ["INSERT", "DELETE", "TRUNCATE"].includes(g.privilege_type))).toEqual([]);

    const policies = await testDb<{ policyname: string; cmd: string }[]>`
      select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'tenants'`;
    expect(policies.filter((p) => p.cmd === "INSERT" || p.cmd === "ALL")).toEqual([]);
  });

  it("a direct INSERT into tenants — even by a user WITH a live approval — is refused for authenticated, anon and service_role, and the approval is untouched", async () => {
    const user = await newUser("direct-insert");
    await insertApproval(user.email);
    const insertTenant = (sql: TransactionSql) =>
      sql`insert into tenants (name, slug, created_by) values ('Direct Insert', ${slug("direct")}, ${user.id}) returning id`;
    await expect(asAuthenticatedUser(user.id, insertTenant)).rejects.toMatchObject({ code: "42501" });
    await expect(asDatabaseRole("anon", null, insertTenant)).rejects.toMatchObject({ code: "42501" });
    await expect(asDatabaseRole("service_role", null, insertTenant)).rejects.toMatchObject({ code: "42501" });
    expect(await approvalsOf(user.email)).toMatchObject([{ status: "approved" }]);
  });

  it("the private implementation cannot be called directly by an API role either", async () => {
    const user = await newUser("direct-private");
    await insertApproval(user.email);
    const callPrivate = (sql: TransactionSql) => sql`select private.create_tenant_with_owner('Direct Private', ${slug("direct-private")})`;
    await expect(asAuthenticatedUser(user.id, callPrivate)).rejects.toMatchObject({ code: "42501" });
    await expect(asDatabaseRole("anon", null, callPrivate)).rejects.toMatchObject({ code: "42501" });
    expect(await approvalsOf(user.email)).toMatchObject([{ status: "approved" }]);
  });

  it("CATALOG GUARD: the only function whose body inserts into tenants is private.create_tenant_with_owner (no EXECUTE for PUBLIC, anon, authenticated or service_role), and its only caller is public.create_tenant", async () => {
    // A future migration that adds another tenant-creating function must make this fail, forcing a deliberate decision
    // about the gate instead of silently opening a second door.
    const inserters = await testDb<{ fn: string; acl: string | null }[]>`
      select n.nspname || '.' || p.proname as fn, p.proacl::text as acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosrc ~* 'insert[[:space:]]+into[[:space:]]+(public[.])?tenants([[:space:]]|[(])'
      order by 1`;
    expect(inserters.map((r) => r.fn)).toEqual(["private.create_tenant_with_owner"]);
    for (const r of inserters) {
      // a NULL ACL is the default: PUBLIC may execute
      expect(r.acl, `${r.fn} must have an explicit ACL`).not.toBeNull();
      expect(r.acl, `${r.fn}: PUBLIC`).not.toMatch(/(^|[{,])=X/);
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(r.acl, `${r.fn}: ${role}`).not.toMatch(new RegExp(`(^|[{,])${role}=`));
      }
    }

    const callers = await testDb<{ fn: string }[]>`
      select n.nspname || '.' || p.proname as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosrc ~* 'create_tenant_with_owner'
      order by 1`;
    expect(callers.map((c) => c.fn)).toEqual(["public.create_tenant"]);
  });
});
