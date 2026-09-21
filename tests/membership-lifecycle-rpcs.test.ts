import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type postgres from "postgres";
import {
  addMembership,
  allPermissionKeys,
  asAuthenticatedUser,
  attemptAs,
  auditRows,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createCustomRole,
  createCustomer,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1E.0 — membership lifecycle RPCs: suspend_membership,
 * reactivate_membership, remove_membership_access.
 *
 * What is proven here:
 *   - each mutation writes EXACTLY ONE audit row of its own name, and a
 *     refused / no-op call writes none;
 *   - suspending and removing never touch the staff row's business data,
 *     appointments, schedules or performance history (remove only clears the
 *     link, in the same transaction), nor the auth user;
 *   - a suspended or removed member grants ZERO permissions and sees nothing;
 *   - reactivation re-checks the target's role NOW (live role, current
 *     authority), not as it was when they were suspended;
 *   - a removed person can be invited again into a brand-new membership and
 *     is relinked to the SAME staff row (no duplicate);
 *   - tenant_memberships.status can no longer be PATCHed through the Data
 *     API (real signed-in client);
 *   - the last-holder protection holds at both layers, and concurrent
 *     management calls on one tenant serialize.
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

let tenant: TestTenant;
let soloTenant: TestTenant;
let allKeys: string[];
let branchId: string;
let serviceId: string;
let customerId: string;

const users: Record<string, TestUser> = {};
const membershipOf: Record<string, string> = {};
const roleOf: Record<string, string> = {};
const staffOf: Record<string, string> = {};

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

let managerClient: SupabaseClient;
let ownerClient: SupabaseClient;
let ownerPeerClient: SupabaseClient;

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`mlc-${label}`);
  createdUserIds.push(user.id);
  users[label] = user;
  return user;
}

/** A staff row linked to `label`'s membership, with a schedule, a future
 * appointment and a completed one carrying a performance-history marker
 * (actual_staff_member_id). */
async function giveStaffHistory(label: string): Promise<void> {
  const staff = await createStaffMember(tenant.id, `Personel ${label}`);
  staffOf[label] = staff.id;
  await testDb`update staff_members set tenant_membership_id = ${membershipOf[label]!} where id = ${staff.id}`;
  await createStaffSchedule(tenant.id, staff.id, 1, "09:00", "17:00");

  for (const [days, completed] of [[3, false], [-3, true]] as const) {
    const start = new Date(Date.now() + days * 86_400_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    const [appointment] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${customerId}, ${completed ? "completed" : "scheduled"}, ${start}, ${end})
      returning id
    `;
    await testDb`
      insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at,
                                     scheduled_end_at, duration_minutes, price, sequence, actual_staff_member_id)
      values (${tenant.id}, ${appointment!.id}, ${serviceId}, ${staff.id}, ${start}, ${end}, 30, 100, 1,
              ${completed ? staff.id : null})
    `;
  }
}

async function staffSnapshot(staffId: string) {
  const [row] = await testDb<{ j: Record<string, unknown> }[]>`
    select to_jsonb(s) - 'updated_at' as j from staff_members s where id = ${staffId}
  `;
  return row!.j;
}

async function historyCounts() {
  const [row] = await testDb<{ appointments: string; items: string; performed: string; schedules: string; staff: string }[]>`
    select
      (select count(*) from appointments where tenant_id = ${tenant.id})::text as appointments,
      (select count(*) from appointment_items where tenant_id = ${tenant.id})::text as items,
      (select count(*) from appointment_items where tenant_id = ${tenant.id} and actual_staff_member_id is not null)::text as performed,
      (select count(*) from staff_schedules where tenant_id = ${tenant.id})::text as schedules,
      (select count(*) from staff_members where tenant_id = ${tenant.id})::text as staff
  `;
  return row!;
}

async function membershipRow(id: string) {
  const [row] = await testDb<{ role_id: string; status: string; deleted_at: string | null }[]>`
    select role_id, status, deleted_at from tenant_memberships where id = ${id}
  `;
  return row!;
}

async function unrestrictedHolders(tenantId: string): Promise<number> {
  const [row] = await testDb<{ n: string }[]>`
    select count(distinct tm.id)::text as n
    from tenant_memberships tm
    join roles r on r.id = tm.role_id and r.deleted_at is null
    join role_permissions rp on rp.role_id = r.id
    join permissions p on p.id = rp.permission_id
    where tm.tenant_id = ${tenantId} and tm.status = 'active' and tm.deleted_at is null
      and p.key = 'permissions.manage_unrestricted'
  `;
  return Number(row!.n);
}

/** What this user can see and do, as a real request would: the permission
 * answer plus how many rows RLS lets them read. */
async function visibilityOf(userId: string) {
  return asAuthenticatedUser(userId, async (sql) => {
    const [perm] = await sql<{ v: boolean }[]>`select public.has_permission(${tenant.id}::uuid, 'appointments.view') as v`;
    const [appointments] = await sql<{ n: string }[]>`select count(*)::text as n from appointments where tenant_id = ${tenant.id}`;
    const [memberships] = await sql<{ n: string }[]>`select count(*)::text as n from tenant_memberships where tenant_id = ${tenant.id}`;
    const [staff] = await sql<{ n: string }[]>`select count(*)::text as n from staff_members where tenant_id = ${tenant.id}`;
    return {
      hasAppointmentsView: perm!.v,
      appointments: Number(appointments!.n),
      memberships: Number(memberships!.n),
      staff: Number(staff!.n),
    };
  });
}

const suspend = (callerId: string, membershipId: string, tenantId = tenant.id) =>
  attemptAs(callerId, (sql) => sql`select public.suspend_membership(${tenantId}::uuid, ${membershipId}::uuid)`);
const reactivate = (callerId: string, membershipId: string, tenantId = tenant.id) =>
  attemptAs(callerId, (sql) => sql`select public.reactivate_membership(${tenantId}::uuid, ${membershipId}::uuid)`);
const remove = (callerId: string, membershipId: string, tenantId = tenant.id) =>
  attemptAs(callerId, (sql) => sql`select public.remove_membership_access(${tenantId}::uuid, ${membershipId}::uuid)`);

async function forceActive(membershipId: string, roleId?: string) {
  await testDb`update tenant_memberships set status = 'active', deleted_at = null where id = ${membershipId}`;
  if (roleId) await testDb`update tenant_memberships set role_id = ${roleId} where id = ${membershipId}`;
}

beforeAll(async () => {
  allKeys = await allPermissionKeys();
  for (const label of ["owner", "ownerPeer", "manager", "peer", "suspendee", "leaver", "personel", "soloOwner"]) {
    await newUser(label);
  }

  tenant = await createTestTenant("test-tenant-mlc-a", users.owner!.id);
  soloTenant = await createTestTenant("test-tenant-mlc-solo", users.soloOwner!.id);
  createdTenantIds.push(tenant.id, soloTenant.id);

  roleOf.owner = tenant.ownerRoleId;
  roleOf.ownerPeer = await createCustomRole(tenant.id, "Ortak Sahip", allKeys);
  roleOf.manager = await createCustomRole(tenant.id, "Yönetici", MANAGER_KEYS);
  roleOf.reception = await createCustomRole(tenant.id, "Resepsiyon", RECEPTION_KEYS);
  roleOf.personel = await createCustomRole(tenant.id, "Personel", ["appointments.view", "customers.view"]);

  const [ownerMembership] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${users.owner!.id}`;
  membershipOf.owner = ownerMembership!.id;
  membershipOf.ownerPeer = await addMembership(tenant.id, users.ownerPeer!.id, roleOf.ownerPeer);
  membershipOf.manager = await addMembership(tenant.id, users.manager!.id, roleOf.manager);
  membershipOf.peer = await addMembership(tenant.id, users.peer!.id, roleOf.manager);
  membershipOf.suspendee = await addMembership(tenant.id, users.suspendee!.id, roleOf.reception);
  membershipOf.leaver = await addMembership(tenant.id, users.leaver!.id, roleOf.reception);
  membershipOf.personel = await addMembership(tenant.id, users.personel!.id, roleOf.personel);

  branchId = await createBranch(tenant.id, "Merkez");
  serviceId = (await createService(tenant.id, "Saç Kesimi", 30, 100)).id;
  customerId = (await createCustomer(tenant.id, "Müşteri Bir")).id;
  await giveStaffHistory("suspendee");
  await giveStaffHistory("leaver");

  managerClient = await signInAs(users.manager!);
  ownerClient = await signInAs(users.owner!);
  ownerPeerClient = await signInAs(users.ownerPeer!);
}, 180000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 120000);

describe("suspend_membership", () => {
  it("suspends a lower member: one audit row, and the staff link, appointments, schedules and history are untouched", async () => {
    const staffBefore = await staffSnapshot(staffOf.suspendee!);
    const countsBefore = await historyCounts();
    const staffAuditBefore = (await auditRows(tenant.id, "staff_member.updated", staffOf.suspendee!)).length;

    expect(await suspend(users.owner!.id, membershipOf.suspendee!)).toEqual({ ok: true });

    const row = await membershipRow(membershipOf.suspendee!);
    expect(row.status).toBe("suspended");
    expect(row.deleted_at).toBeNull();

    const audit = await auditRows(tenant.id, "membership.suspended", membershipOf.suspendee!);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: users.owner!.id, before: { status: "active" }, after: { status: "suspended" } });

    // Nothing else moved: the staff row (still linked!), its schedules, appointments and performance history.
    expect(await staffSnapshot(staffOf.suspendee!)).toEqual(staffBefore);
    expect((await staffSnapshot(staffOf.suspendee!)).tenant_membership_id).toBe(membershipOf.suspendee);
    expect(await historyCounts()).toEqual(countsBefore);
    expect((await auditRows(tenant.id, "staff_member.updated", staffOf.suspendee!)).length).toBe(staffAuditBefore);
  });

  it("a suspended member grants ZERO permissions and sees nothing", async () => {
    // (suspended by the previous test)
    expect(await visibilityOf(users.suspendee!.id)).toEqual({ hasAppointmentsView: false, appointments: 0, memberships: 0, staff: 0 });
  });

  it("refuses invalid transitions and refused calls write no audit row", async () => {
    expect(await suspend(users.owner!.id, membershipOf.suspendee!)).toMatchObject({ ok: false, message: "membership_not_active" });
    expect(await suspend(users.owner!.id, randomUUID())).toMatchObject({ ok: false, message: "membership_not_found" });
    expect(await suspend(users.manager!.id, membershipOf.owner!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await suspend(users.manager!.id, membershipOf.peer!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await suspend(users.owner!.id, membershipOf.owner!)).toMatchObject({ ok: false, message: "cannot_manage_self" });
    expect(await suspend(users.personel!.id, membershipOf.leaver!)).toMatchObject({ ok: false, message: "staff_manage_required" });

    expect(await auditRows(tenant.id, "membership.suspended", membershipOf.suspendee!)).toHaveLength(1);
    expect(await auditRows(tenant.id, "membership.suspended", membershipOf.owner!)).toHaveLength(0);
    expect((await membershipRow(membershipOf.owner!)).status).toBe("active");
    expect((await membershipRow(membershipOf.peer!)).status).toBe("active");
  });
});

describe("reactivate_membership", () => {
  it("reactivates: permissions return, exactly one audit row, and repeating it is refused", async () => {
    expect(await reactivate(users.owner!.id, membershipOf.suspendee!)).toEqual({ ok: true });

    expect((await membershipRow(membershipOf.suspendee!)).status).toBe("active");
    const audit = await auditRows(tenant.id, "membership.reactivated", membershipOf.suspendee!);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: users.owner!.id, before: { status: "suspended" }, after: { status: "active" } });

    const visible = await visibilityOf(users.suspendee!.id);
    expect(visible.hasAppointmentsView).toBe(true);
    expect(visible.appointments).toBeGreaterThan(0);

    expect(await reactivate(users.owner!.id, membershipOf.suspendee!)).toMatchObject({ ok: false, message: "membership_not_suspended" });
    expect(await auditRows(tenant.id, "membership.reactivated", membershipOf.suspendee!)).toHaveLength(1);
  });

  it("re-checks target authority: a manager cannot reactivate a suspended owner-level member; an owner can", async () => {
    expect(await suspend(users.owner!.id, membershipOf.ownerPeer!)).toEqual({ ok: true });

    expect(await reactivate(users.manager!.id, membershipOf.ownerPeer!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect((await membershipRow(membershipOf.ownerPeer!)).status).toBe("suspended");

    expect(await reactivate(users.owner!.id, membershipOf.ownerPeer!)).toEqual({ ok: true });
    expect((await membershipRow(membershipOf.ownerPeer!)).status).toBe("active");
  });

  it("re-checks the target's role NOW: a role that grew beyond the caller's authority since the suspension is refused", async () => {
    expect(await suspend(users.manager!.id, membershipOf.suspendee!)).toEqual({ ok: true });

    // While suspended, the owner adds a permission the manager does not hold.
    const [settings] = await testDb<{ id: string }[]>`select id from permissions where key = 'settings.manage'`;
    await testDb`insert into role_permissions (role_id, permission_id) values (${roleOf.reception!}, ${settings!.id})`;

    expect(await reactivate(users.manager!.id, membershipOf.suspendee!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect((await membershipRow(membershipOf.suspendee!)).status).toBe("suspended");
    expect(await reactivate(users.owner!.id, membershipOf.suspendee!)).toEqual({ ok: true });

    await testDb`delete from role_permissions where role_id = ${roleOf.reception!} and permission_id = ${settings!.id}`;
  });

  it("refuses a target whose role has been soft-deleted", async () => {
    expect(await suspend(users.owner!.id, membershipOf.suspendee!)).toEqual({ ok: true });
    await testDb`update roles set deleted_at = now() where id = ${roleOf.reception!}`;

    expect(await reactivate(users.owner!.id, membershipOf.suspendee!)).toMatchObject({ ok: false, message: "role_not_found" });
    expect((await membershipRow(membershipOf.suspendee!)).status).toBe("suspended");

    await testDb`update roles set deleted_at = null where id = ${roleOf.reception!}`;
    expect(await reactivate(users.owner!.id, membershipOf.suspendee!)).toEqual({ ok: true });
  });
});

describe("remove_membership_access", () => {
  it("soft-deletes the membership and clears the staff link; staff, history, schedules and the auth user survive", async () => {
    const staffBefore = await staffSnapshot(staffOf.leaver!);
    const countsBefore = await historyCounts();
    const staffAuditBefore = (await auditRows(tenant.id, "staff_member.updated", staffOf.leaver!)).length;

    expect(await remove(users.owner!.id, membershipOf.leaver!)).toEqual({ ok: true });

    const row = await membershipRow(membershipOf.leaver!);
    expect(row.deleted_at).not.toBeNull();

    // The staff row keeps every business field; only the link is cleared.
    const staffAfter = await staffSnapshot(staffOf.leaver!);
    expect(staffAfter.tenant_membership_id).toBeNull();
    expect({ ...staffAfter, tenant_membership_id: staffBefore.tenant_membership_id }).toEqual(staffBefore);
    expect(await historyCounts()).toEqual(countsBefore);

    // The login itself is untouched: same auth user, same profile.
    const [authUser] = await testDb<{ id: string }[]>`select id from auth.users where id = ${users.leaver!.id}`;
    expect(authUser?.id).toBe(users.leaver!.id);

    // Exactly one lifecycle event, naming the staff row it released...
    const audit = await auditRows(tenant.id, "membership.removed", membershipOf.leaver!);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: users.owner!.id,
      before: { status: "active", unlinked_staff_member_ids: [staffOf.leaver] },
      after: { deleted: true },
    });
    // ...and the pre-existing staff trigger recorded the link change once, as staff_member.updated.
    expect((await auditRows(tenant.id, "staff_member.updated", staffOf.leaver!)).length).toBe(staffAuditBefore + 1);
  });

  it("a removed member grants ZERO permissions and sees nothing", async () => {
    expect(await visibilityOf(users.leaver!.id)).toEqual({ hasAppointmentsView: false, appointments: 0, memberships: 0, staff: 0 });
  });

  it("refuses an already-removed or unknown membership, and writes no second audit row", async () => {
    expect(await remove(users.owner!.id, membershipOf.leaver!)).toMatchObject({ ok: false, message: "membership_not_found" });
    expect(await remove(users.owner!.id, randomUUID())).toMatchObject({ ok: false, message: "membership_not_found" });
    expect(await auditRows(tenant.id, "membership.removed", membershipOf.leaver!)).toHaveLength(1);
  });

  it("obeys target authority: a manager cannot remove an owner or a peer, and cannot remove themselves", async () => {
    expect(await remove(users.manager!.id, membershipOf.owner!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await remove(users.manager!.id, membershipOf.peer!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await remove(users.manager!.id, membershipOf.manager!)).toMatchObject({ ok: false, message: "cannot_manage_self" });
    for (const id of [membershipOf.owner!, membershipOf.peer!, membershipOf.manager!]) {
      expect((await membershipRow(id)).deleted_at).toBeNull();
    }
  });

  it("a removed person can be invited again: a NEW membership, relinked to the SAME staff row, no duplicate", async () => {
    const staffCountBefore = (await historyCounts()).staff;
    const removedMembership = membershipOf.leaver!;

    const invitation = await asAuthenticatedUser(users.owner!.id, async (sql) => {
      const rows = await sql<{ id: string; token: string }[]>`
        select id, token from public.create_team_invitation(${tenant.id}::uuid, ${users.leaver!.email}, ${roleOf.reception!}::uuid, ${staffOf.leaver!}::uuid)
      `;
      return rows[0]!;
    });
    expect(invitation.token).toBeTruthy();

    const accepted = await asAuthenticatedUser(users.leaver!.id, async (sql) => {
      const rows = await sql<{ membership_id: string; outcome: string; staff_linked: boolean }[]>`
        select membership_id, outcome, staff_linked from public.accept_team_invitation(${invitation.token})
      `;
      return rows[0]!;
    });
    expect(accepted).toMatchObject({ outcome: "accepted", staff_linked: true });
    expect(accepted.membership_id).not.toBe(removedMembership);

    // The old row stays soft-deleted; the staff row now points at the new membership.
    expect((await membershipRow(removedMembership)).deleted_at).not.toBeNull();
    expect((await staffSnapshot(staffOf.leaver!)).tenant_membership_id).toBe(accepted.membership_id);
    expect((await historyCounts()).staff).toBe(staffCountBefore);
    membershipOf.leaver = accepted.membership_id;

    // And the returning member has their access again.
    expect((await visibilityOf(users.leaver!.id)).hasAppointmentsView).toBe(true);
  });
});

describe("audit footprint — the COMPLETE set of audit rows each call writes", () => {
  /** Every audit row of the tenant that did not exist before `before` was taken. */
  async function auditIds(): Promise<Set<string>> {
    const rows = await testDb<{ id: string }[]>`select id from audit_logs where tenant_id = ${tenant.id}`;
    return new Set(rows.map((r) => r.id));
  }
  async function newActions(before: Set<string>): Promise<string[]> {
    const rows = await testDb<{ id: string; action: string }[]>`select id, action from audit_logs where tenant_id = ${tenant.id}`;
    return rows.filter((r) => !before.has(r.id)).map((r) => r.action).sort();
  }
  async function freshMember(label: string, options: { withStaff?: boolean } = {}) {
    const user = await newUser(label);
    const membershipId = await addMembership(tenant.id, user.id, roleOf.reception!);
    membershipOf[label] = membershipId;
    let staffId: string | null = null;
    if (options.withStaff) {
      staffId = (await createStaffMember(tenant.id, `Personel ${label}`)).id;
      await testDb`update staff_members set tenant_membership_id = ${membershipId} where id = ${staffId}`;
    }
    return { user, membershipId, staffId };
  }

  it("remove_membership_access WITH a linked staff row writes exactly membership.removed + one staff_member.updated (the link change), nothing else", async () => {
    const member = await freshMember("footprintLinked", { withStaff: true });
    const before = await auditIds();
    expect(await remove(users.owner!.id, member.membershipId)).toEqual({ ok: true });
    expect(await newActions(before)).toEqual(["membership.removed", "staff_member.updated"]);
  });

  it("remove_membership_access WITHOUT a staff link writes exactly membership.removed — no staff event at all", async () => {
    const member = await freshMember("footprintUnlinked");
    const before = await auditIds();
    expect(await remove(users.owner!.id, member.membershipId)).toEqual({ ok: true });
    expect(await newActions(before)).toEqual(["membership.removed"]);
  });

  it("suspend and reactivate each write exactly their own single event", async () => {
    const member = await freshMember("footprintSuspend", { withStaff: true });
    let before = await auditIds();
    expect(await suspend(users.owner!.id, member.membershipId)).toEqual({ ok: true });
    expect(await newActions(before)).toEqual(["membership.suspended"]); // the linked staff row is untouched: no staff event

    before = await auditIds();
    expect(await reactivate(users.owner!.id, member.membershipId)).toEqual({ ok: true });
    expect(await newActions(before)).toEqual(["membership.reactivated"]);
  });

  it("link and unlink write exactly ONE event each (the staff row's own change), and no membership event", async () => {
    const member = await freshMember("footprintLink");
    const staff = await createStaffMember(tenant.id, "Personel footprintLink");
    let before = await auditIds();
    expect(
      await attemptAs(users.owner!.id, (sql) => sql`select public.link_staff_membership(${tenant.id}::uuid, ${staff.id}::uuid, ${member.membershipId}::uuid)`),
    ).toEqual({ ok: true });
    expect(await newActions(before)).toEqual(["staff_member.updated"]);

    before = await auditIds();
    expect(
      await attemptAs(users.owner!.id, (sql) => sql`select public.unlink_staff_membership(${tenant.id}::uuid, ${staff.id}::uuid)`),
    ).toEqual({ ok: true });
    expect(await newActions(before)).toEqual(["staff_member.updated"]);
  });

  it("a refused call and a same-role no-op write NOTHING (not even a partial row)", async () => {
    const member = await freshMember("footprintRefused", { withStaff: true });
    const before = await auditIds();

    // refused: authority, self, unknown
    expect(await remove(users.manager!.id, membershipOf.owner!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await suspend(users.manager!.id, membershipOf.peer!)).toMatchObject({ ok: false, message: "insufficient_authority" });
    expect(await remove(users.manager!.id, membershipOf.manager!)).toMatchObject({ ok: false, message: "cannot_manage_self" });
    expect(await remove(users.owner!.id, randomUUID())).toMatchObject({ ok: false, message: "membership_not_found" });
    expect(await reactivate(users.owner!.id, member.membershipId)).toMatchObject({ ok: false, message: "membership_not_suspended" });

    // an authorized no-op: assigning the role the member already has
    expect(
      await attemptAs(users.owner!.id, (sql) => sql`select public.update_membership_role(${member.membershipId}::uuid, ${roleOf.reception!}::uuid)`),
    ).toEqual({ ok: true });

    expect(await newActions(before)).toEqual([]);
  });
});

describe("tenant_memberships.status is no longer writable through the Data API", () => {
  it("a staff.manage holder's raw PATCH of status, role_id or deleted_at is refused and nothing changes", async () => {
    const before = await membershipRow(membershipOf.suspendee!);
    const auditBefore = (await auditRows(tenant.id, "membership.suspended", membershipOf.suspendee!)).length;

    for (const patch of [{ status: "suspended" }, { role_id: roleOf.personel! }, { deleted_at: new Date().toISOString() }]) {
      const { error } = await managerClient.from("tenant_memberships").update(patch).eq("id", membershipOf.suspendee!);
      expect(error, JSON.stringify(patch)).not.toBeNull();
    }
    expect(await membershipRow(membershipOf.suspendee!)).toEqual(before);
    // a refused raw write leaves no audit trace either (only the RPCs write lifecycle events)
    expect((await auditRows(tenant.id, "membership.suspended", membershipOf.suspendee!)).length).toBe(auditBefore);
  });
});

describe("last unrestricted holder — RPC authority layer and database invariant", () => {
  let soloMembership: string;
  let otherRole: string;

  beforeAll(async () => {
    const [row] = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${soloTenant.id} and user_id = ${users.soloOwner!.id}`;
    soloMembership = row!.id;
    otherRole = await createCustomRole(soloTenant.id, "Diğer", ["appointments.view"]);
  });

  it("the sole holder cannot suspend, remove or demote themselves through the RPCs", async () => {
    expect(await suspend(users.soloOwner!.id, soloMembership, soloTenant.id)).toMatchObject({ ok: false, message: "cannot_manage_self" });
    expect(await remove(users.soloOwner!.id, soloMembership, soloTenant.id)).toMatchObject({ ok: false, message: "cannot_manage_self" });
    const demote = await attemptAs(users.soloOwner!.id, (sql) => sql`select public.update_membership_role(${soloMembership}::uuid, ${otherRole}::uuid)`);
    expect(demote).toMatchObject({ ok: false, message: "cannot change your own role" });
    expect((await membershipRow(soloMembership)).status).toBe("active");
  });

  it("the same three mutations attempted directly (raw SQL, no RPC) still cannot commit", async () => {
    const attempts: Array<(sql: postgres.TransactionSql) => Promise<unknown>> = [
      (sql) => sql`update tenant_memberships set status = 'suspended' where id = ${soloMembership}`,
      (sql) => sql`update tenant_memberships set deleted_at = now() where id = ${soloMembership}`,
      (sql) => sql`update tenant_memberships set role_id = ${otherRole} where id = ${soloMembership}`,
      (sql) => sql`delete from tenant_memberships where id = ${soloMembership}`,
    ];
    for (const attempt of attempts) {
      await expect(testDb.begin(async (sql) => { await attempt(sql); })).rejects.toThrow(/tenant_would_lose_last_unrestricted_holder/);
    }
    expect(await unrestrictedHolders(soloTenant.id)).toBe(1);
  });
});

describe("concurrency — management calls on one tenant serialize", () => {
  it("two holders suspending EACH OTHER at the same instant: exactly one succeeds and a holder always remains", async () => {
    expect(await unrestrictedHolders(tenant.id)).toBe(2);

    const [first, second] = await Promise.all([
      ownerClient.rpc("suspend_membership", { p_tenant_id: tenant.id, p_membership_id: membershipOf.ownerPeer! }),
      ownerPeerClient.rpc("suspend_membership", { p_tenant_id: tenant.id, p_membership_id: membershipOf.owner! }),
    ]);

    const successes = [first, second].filter((r) => r.error === null).length;
    expect(successes).toBe(1);
    expect(await unrestrictedHolders(tenant.id)).toBe(1);

    await forceActive(membershipOf.owner!);
    await forceActive(membershipOf.ownerPeer!);
    expect(await unrestrictedHolders(tenant.id)).toBe(2);
    await testDb`delete from audit_logs where tenant_id = ${tenant.id} and action = 'membership.suspended' and entity_id in ${testDb([membershipOf.owner!, membershipOf.ownerPeer!])}`;
  }, 60000);

  it("a second management call WAITS on the tenant lock and then decides on the first one's committed result", async () => {
    const conn1 = await testDb.reserve();
    const conn2 = await testDb.reserve();
    const claims = (id: string) => JSON.stringify({ sub: id, role: "authenticated" });

    try {
      await conn1`begin`;
      await conn2`begin`;
      for (const [conn, id] of [[conn1, users.owner!.id], [conn2, users.ownerPeer!.id]] as const) {
        await conn`select set_config('request.jwt.claims', ${claims(id)}, true), set_config('request.jwt.claim.sub', ${id}, true)`;
        await conn`set local role authenticated`;
      }

      // conn1 suspends the peer owner and keeps its transaction OPEN (holding the tenant lock).
      await conn1`select public.suspend_membership(${tenant.id}::uuid, ${membershipOf.ownerPeer!}::uuid)`;

      let settled = false;
      const second = conn2`select public.suspend_membership(${tenant.id}::uuid, ${membershipOf.owner!}::uuid)`
        .then(() => ({ ok: true as const }))
        .catch((e: Error) => ({ ok: false as const, message: e.message }))
        .finally(() => { settled = true; });

      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(settled, "the second call must be blocked while the first transaction is open").toBe(false);

      await conn1`commit`;
      const result = await second;
      expect(result.ok).toBe(false);
      expect((result as { message: string }).message).toMatch(/membership_not_found|staff_manage_required|tenant_would_lose_last_unrestricted_holder/);

      expect((await membershipRow(membershipOf.owner!)).status).toBe("active");
      expect((await membershipRow(membershipOf.ownerPeer!)).status).toBe("suspended");
      expect(await unrestrictedHolders(tenant.id)).toBe(1);
    } finally {
      await conn1`rollback`.catch(() => {});
      await conn2`rollback`.catch(() => {});
      conn1.release();
      conn2.release();
      await forceActive(membershipOf.ownerPeer!);
      await testDb`delete from audit_logs where tenant_id = ${tenant.id} and action = 'membership.suspended' and entity_id = ${membershipOf.ownerPeer!}`;
    }
  }, 60000);
});
