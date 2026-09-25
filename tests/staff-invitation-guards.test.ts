import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  asAuthenticatedUser,
  attemptAs,
  cleanupTenants,
  cleanupUsers,
  createStaffMember,
  createTestTenant,
  createTestUser,
  randomTokenHex,
  sha256Hex,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1E.1 (residual F) — explicit, DB-enforced staff-invitation
 * guards on create_team_invitation's optional p_staff_member_id:
 *
 *   - an inactive staff member is as invalid a target as a deleted one
 *     (same generic, non-leaking message);
 *   - an already-linked staff member cannot receive a second invitation
 *     (a distinct, useful message — the caller is already staff.manage-
 *     authorized to see the whole roster's link state);
 *   - at most one live PENDING invitation per (tenant, staff member),
 *     enforced by a real partial unique index, not only an application
 *     check — proven here under genuine concurrency;
 *   - a cross-tenant staff uuid is rejected the same way it always was
 *     (no leakage either way);
 *   - inviting WITHOUT a staff link is completely unaffected;
 *   - acceptance's pre-existing no-overwrite behavior for a staff link
 *     is unaffected (unit F change only prevents the race that used to
 *     reach it — it is not itself modified).
 */

const TAG = randomUUID().slice(0, 8);
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`sig-${label}`);
  createdUserIds.push(user.id);
  return user;
}

async function provisionedRoles(tenantId: string): Promise<Record<string, string>> {
  await testDb`select * from private.provision_default_roles(${tenantId}::uuid)`;
  const rows = await testDb<{ id: string; key: string }[]>`select id, key from roles where tenant_id = ${tenantId} and deleted_at is null`;
  return Object.fromEntries(rows.map((r) => [r.key, r.id]));
}

describe("create_team_invitation — staff-target guards", () => {
  let tenant: TestTenant;
  const users: Record<string, TestUser> = {};
  const role: Record<string, string> = {};

  beforeAll(async () => {
    users.owner = await newUser("owner");
    tenant = await createTestTenant(`test-tenant-sig-${TAG}`, users.owner!.id);
    createdTenantIds.push(tenant.id);
    Object.assign(role, await provisionedRoles(tenant.id));
  }, 60000);

  afterAll(async () => {
    await cleanupTenants(createdTenantIds);
    await cleanupUsers(createdUserIds);
  }, 120000);

  const inviteAttempt = (email: string, staffId: string | null) =>
    attemptAs(users.owner!.id, (sql) => sql`select * from public.create_team_invitation(${tenant.id}::uuid, ${email}::text, ${role.STYLIST!}::uuid, ${staffId}::uuid)`);

  const invite = async (email: string, staffId: string | null): Promise<{ id: string; token: string }> => {
    const rows = await asAuthenticatedUser(users.owner!.id, (sql) =>
      sql<{ id: string; token: string }[]>`select id, token from public.create_team_invitation(${tenant.id}::uuid, ${email}::text, ${role.STYLIST!}::uuid, ${staffId}::uuid)`,
    );
    return rows[0]!;
  };

  it("a deleted staff member is refused with the pre-existing generic message", async () => {
    const s = await createStaffMember(tenant.id, "Silinmiş");
    await testDb`update staff_members set deleted_at = now() where id = ${s.id}`;
    const result = await inviteAttempt(`sig-deleted-${TAG}@example.com`, s.id);
    expect(result).toMatchObject({ ok: false, message: "staff member not found in this tenant" });
  }, 30000);

  it("an INACTIVE staff member is refused with the SAME generic message — no distinguishing detail leaked", async () => {
    const s = await createStaffMember(tenant.id, "İnaktif");
    await testDb`update staff_members set status = 'inactive' where id = ${s.id}`;
    const result = await inviteAttempt(`sig-inactive-${TAG}@example.com`, s.id);
    expect(result).toMatchObject({ ok: false, message: "staff member not found in this tenant" });
  }, 30000);

  it("reactivating the staff member makes the same id a valid target again", async () => {
    const s = await createStaffMember(tenant.id, "Yeniden Aktif");
    await testDb`update staff_members set status = 'inactive' where id = ${s.id}`;
    expect(await inviteAttempt(`sig-reactivate-a-${TAG}@example.com`, s.id)).toMatchObject({ ok: false });
    await testDb`update staff_members set status = 'active' where id = ${s.id}`;
    expect(await inviteAttempt(`sig-reactivate-b-${TAG}@example.com`, s.id)).toEqual({ ok: true });
  }, 30000);

  it("an already-linked staff member cannot receive a second invitation — distinct 'staff_already_linked' message", async () => {
    const s = await createStaffMember(tenant.id, "Bağlı");
    const holder = await newUser("link-holder");
    const membershipId = await addMembership(tenant.id, holder.id, role.STYLIST!);
    await testDb`update staff_members set tenant_membership_id = ${membershipId} where id = ${s.id}`;
    const result = await inviteAttempt(`sig-linked-${TAG}@example.com`, s.id);
    expect(result).toMatchObject({ ok: false, message: "staff_already_linked" });
  }, 30000);

  it("one live PENDING invitation per staff member: a second attempt is refused with a distinct message; expiring/revoking the first frees the slot", async () => {
    const s = await createStaffMember(tenant.id, "Bir Davet");
    const first = await invite(`sig-pending-a-${TAG}@example.com`, s.id);
    const second = await inviteAttempt(`sig-pending-b-${TAG}@example.com`, s.id);
    expect(second).toMatchObject({ ok: false, message: "staff_pending_invitation_exists" });

    await attemptAs(users.owner!.id, (sql) => sql`select public.revoke_team_invitation(${first.id}::uuid)`);
    const third = await inviteAttempt(`sig-pending-c-${TAG}@example.com`, s.id);
    expect(third).toEqual({ ok: true });
  }, 30000);

  it("a stale (expired-but-still-pending) invitation to the same staff member does not block a fresh one — same self-healing as the email-scoped guard", async () => {
    const s = await createStaffMember(tenant.id, "Süresi Dolmuş");
    const stale = await invite(`sig-stale-${TAG}@example.com`, s.id);
    // team_invitations_expires_after_created requires expires_at > created_at — push both back together.
    await testDb`update team_invitations set created_at = now() - interval '8 days', expires_at = now() - interval '1 minute' where id = ${stale.id}`;
    const fresh = await inviteAttempt(`sig-fresh-${TAG}@example.com`, s.id);
    expect(fresh).toEqual({ ok: true });
    const [row] = await testDb<{ status: string }[]>`select status from team_invitations where id = ${stale.id}`;
    expect(row!.status).toBe("expired");
  }, 30000);

  it("two truly CONCURRENT invitations for the same staff member: exactly one winner, DB-enforced, no raw constraint error leaks to the caller", async () => {
    const s = await createStaffMember(tenant.id, "Yarış");
    const [r1, r2] = await Promise.all([
      inviteAttempt(`sig-race-a-${TAG}@example.com`, s.id),
      inviteAttempt(`sig-race-b-${TAG}@example.com`, s.id),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      expect(r).toMatchObject({ message: "staff_pending_invitation_exists" });
      expect(r.message).not.toMatch(/duplicate key|constraint|23505/i);
    }
    const [count] = await testDb<{ n: number }[]>`select count(*)::int as n from team_invitations where tenant_id = ${tenant.id} and staff_member_id = ${s.id} and status = 'pending'`;
    expect(count!.n).toBe(1);
  }, 30000);

  it("the underlying unique index exists and covers exactly (tenant_id, staff_member_id) where status='pending'", async () => {
    const [idx] = await testDb<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'public' and tablename = 'team_invitations' and indexname = 'team_invitations_tenant_staff_pending_idx'`;
    expect(idx).toBeDefined();
    expect(idx!.indexdef).toContain("tenant_id");
    expect(idx!.indexdef).toContain("staff_member_id");
    expect(idx!.indexdef).toMatch(/status = 'pending'::text/);
  });

  it("a cross-tenant staff uuid is rejected with the same generic message — no leakage of the other tenant's existence", async () => {
    const otherOwner = await newUser("other-owner");
    const other = await createTestTenant(`test-tenant-sig-other-${TAG}`, otherOwner.id);
    createdTenantIds.push(other.id);
    const otherStaff = await createStaffMember(other.id, "Başka Kiracı");
    const result = await inviteAttempt(`sig-cross-${TAG}@example.com`, otherStaff.id);
    expect(result).toMatchObject({ ok: false, message: "staff member not found in this tenant" });
  }, 30000);

  it("a forged/nonexistent staff uuid gets the identical message — indistinguishable from every other invalid-target case", async () => {
    const result = await inviteAttempt(`sig-forged-${TAG}@example.com`, randomUUID());
    expect(result).toMatchObject({ ok: false, message: "staff member not found in this tenant" });
  });

  it("invite WITHOUT a staff link is completely unaffected by any of the new guards", async () => {
    const result = await inviteAttempt(`sig-nostaff-${TAG}@example.com`, null);
    expect(result).toEqual({ ok: true });
  });

  it("acceptance still never overwrites an existing link (pre-existing behavior, unaffected by this migration)", async () => {
    const s = await createStaffMember(tenant.id, "Önceden Bağlı");
    const firstHolder = await newUser("first-holder");
    const firstMembership = await addMembership(tenant.id, firstHolder.id, role.STYLIST!);
    await testDb`update staff_members set tenant_membership_id = ${firstMembership} where id = ${s.id}`;

    // A brand-new invitation targeting the same (now-linked) staff row is refused up front by the new guard —
    // the no-overwrite behavior this test is really about is exercised via a pre-existing invitation row
    // inserted directly, the same way team-page.test.ts's own fixtures construct edge cases the RPC surface
    // itself no longer produces.
    const invitee = await newUser("noverride-invitee");
    const rawToken = randomTokenHex();
    const tokenHash = sha256Hex(rawToken);
    await testDb`
      insert into team_invitations (tenant_id, email, role_id, staff_member_id, invited_by, status, token_hash, expires_at)
      values (${tenant.id}, ${invitee.email.toLowerCase()}, ${role.STYLIST!}, ${s.id}, ${users.owner!.id}, 'pending', ${tokenHash}, now() + interval '7 days')`;

    const [result] = await asAuthenticatedUser(invitee.id, (sql) =>
      sql<{ staff_linked: boolean; staff_link_reason: string | null }[]>`select staff_linked, staff_link_reason from public.accept_team_invitation(${rawToken}::text)`,
    );
    expect(result).toEqual({ staff_linked: false, staff_link_reason: "already_linked" });
    const [link] = await testDb<{ tenant_membership_id: string | null }[]>`select tenant_membership_id from staff_members where id = ${s.id}`;
    expect(link!.tenant_membership_id).toBe(firstMembership);
  }, 30000);
});
