import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StaffUtilizationSummary } from "@/lib/modules/reports/queries";
import {
  testDb,
  signInAs,
  anonClient,
  createTestTenant,
  createTestUser,
  createTestMembershipFromTemplate,
  createRoleForTenant,
  addMembership,
  createBranch,
  createService,
  createStaffMember,
  createCustomer,
  linkStaffBranch,
  createStaffSchedule,
  createScheduleException,
  cleanupTenants,
  cleanupUsers,
  hoursFromNow,
  type TestUser,
  type TestTenant,
} from "./helpers";

/**
 * Faz 5A.3B — get_staff_utilization. Covers the full locked contract from
 * the fresh utilization audit + its product-owner corrections: population
 * is roster-plus-history (never schedule-driven), scheduledMinutes is a
 * UNION of wall-clock intervals (never a sum of raw rows), a NULL-branch
 * schedule row contributes once tenant-wide but fully to each
 * independently-filtered branch, custom_hours exceptions completely
 * replace (never add to) the recurring day, effective_end_at clips future
 * capacity out of the denominator, utilizedMinutes is an elapsed-overlap
 * calculation (never full duration_minutes — a deliberate, tested
 * difference from personnel-performance-reports.test.ts's
 * completedMinutes), and totals are independently recomputed from summed
 * minutes rather than averaged staff percentages.
 *
 * Every test asserting an exact number uses its own freshly created,
 * dedicated staff member and always passes staffIds to scope both staff[]
 * AND totals to that one staff — required here even more than in
 * personnel-performance-reports.test.ts, since many tests deliberately
 * reuse the same past reference dates (population is date/weekday-keyed,
 * not tied to a narrow relative-time window the way appointment items
 * are), so an unfiltered totals assertion would sum every other test's
 * fixture staff too.
 */

let owner: TestUser;
let stylistUser: TestUser;
let reportsOnlyUser: TestUser;
let noPermUser: TestUser;
let tenant: TestTenant;
let branchId: string;
let branchId2: string;
let serviceA: { id: string; name: string };

let otherTenant: TestTenant;
let otherOwner: TestUser;
let otherStaffId: string;
let otherBranchId: string;

let dstTenant: TestTenant;
let dstOwner: TestUser;
let dstBranchId: string;

/** A calendar date "N days ago" (UTC date string) — safely in the past
 * regardless of when the suite actually runs, so effective_end_at never
 * clips it. Used for every test exercising pure schedule/exception/
 * capacity/branch logic, where "was this window clipped by now()" must
 * never be in play. */
function pastDateStr(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

/** A UTC window generously covering the tenant-local calendar date(s)
 * from fromDateStr through throughDateStr (inclusive), safe margin on
 * both sides regardless of the test tenant's fixed Europe/Istanbul UTC+3
 * offset (no DST, so a flat 3h margin computation is exact, not
 * approximate). Only ever used for safely-past dates. */
function windowFor(fromDateStr: string, throughDateStr: string = fromDateStr): { start: Date; end: Date } {
  const start = new Date(new Date(`${fromDateStr}T00:00:00Z`).getTime() - 6 * 3600_000);
  const end = new Date(new Date(`${throughDateStr}T00:00:00Z`).getTime() + 30 * 3600_000);
  return { start, end };
}

async function activeStaff(fullName: string, branchIds: string[] = [branchId]): Promise<string> {
  const staff = await createStaffMember(tenant.id, fullName);
  for (const b of branchIds) await linkStaffBranch(staff.id, b);
  return staff.id;
}

async function inactiveStaff(fullName: string, branchIds: string[] = []): Promise<string> {
  const id = await activeStaff(fullName, branchIds);
  await testDb`update staff_members set status = 'inactive' where id = ${id}`;
  return id;
}

/** Same shape as personnel-performance-reports.test.ts's own local
 * fixture helper — inserts an appointment + N items directly at whatever
 * status is needed, bypassing complete_appointment (this file exercises
 * the report RPC's READ contract, not the completion RPC). */
async function createAppointment(params: {
  status: "completed" | "cancelled" | "no_show" | "confirmed";
  scheduledStartAt: Date;
  branchId?: string;
  customerId?: string;
  items: { staffMemberId: string; durationMinutes?: number }[];
}): Promise<{ appointmentId: string; itemIds: string[] }> {
  const customerId = params.customerId ?? (await createCustomer(tenant.id, `Util Customer ${crypto.randomUUID().slice(0, 8)}`)).id;
  let cursor = params.scheduledStartAt;
  const totalMinutes = params.items.reduce((sum, i) => sum + (i.durationMinutes ?? 30), 0);
  const end = new Date(params.scheduledStartAt.getTime() + totalMinutes * 60_000);
  const [appt] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
    values (${tenant.id}, ${params.branchId ?? branchId}, ${customerId}, ${params.status}, ${params.scheduledStartAt.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
    returning id`;
  const itemIds: string[] = [];
  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i]!;
    const duration = item.durationMinutes ?? 30;
    const itemStart = new Date(cursor);
    const itemEnd = new Date(itemStart.getTime() + duration * 60_000);
    cursor = itemEnd;
    const [row] = await testDb<{ id: string }[]>`
      insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence, appointment_status)
      values (${tenant.id}, ${appt!.id}, ${serviceA.id}, ${item.staffMemberId}, ${itemStart.toISOString()}::timestamptz, ${itemEnd.toISOString()}::timestamptz, ${duration}, 200, ${i + 1}, ${params.status})
      returning id`;
    itemIds.push(row!.id);
  }
  return { appointmentId: appt!.id, itemIds };
}

/** Casts the RPC's generic Json return to the real shape once, here — see
 * personnel-performance-reports.test.ts's summaryAs for why this is a
 * flat (not discriminated-union) type. No serviceIds param: this RPC has
 * none (see the migration's own header comment). */
async function utilizationAs(
  user: TestUser,
  params: { startAt: Date; endAt: Date; tenantId?: string; branchId?: string | null; staffIds?: string[] | null },
): Promise<{ data: StaffUtilizationSummary; error: { code?: string; message: string } | null }> {
  const client = await signInAs(user);
  const { data, error } = await client.rpc("get_staff_utilization", {
    p_tenant_id: params.tenantId ?? tenant.id,
    p_start_at: params.startAt.toISOString(),
    p_end_at: params.endAt.toISOString(),
    p_branch_id: params.branchId ?? null,
    p_staff_ids: params.staffIds ?? null,
  });
  await client.auth.signOut();
  return { data: data as unknown as StaffUtilizationSummary, error };
}

beforeAll(async () => {
  owner = await createTestUser("p5a3b-owner");
  stylistUser = await createTestUser("p5a3b-stylist");
  reportsOnlyUser = await createTestUser("p5a3b-reports-only");
  noPermUser = await createTestUser("p5a3b-no-perm");
  otherOwner = await createTestUser("p5a3b-other-owner");
  dstOwner = await createTestUser("p5a3b-dst-owner");

  tenant = await createTestTenant("test-p5a3b-util", owner.id);
  branchId = await createBranch(tenant.id, "Utilization Branch A");
  branchId2 = await createBranch(tenant.id, "Utilization Branch B");
  serviceA = await createService(tenant.id, "Kesim", 30, 300);
  await testDb`insert into service_branches (service_id, branch_id) values (${serviceA.id}, ${branchId}), (${serviceA.id}, ${branchId2})`;

  await createTestMembershipFromTemplate(tenant.id, stylistUser.id, "STYLIST");
  const reportsOnlyRoleId = await createRoleForTenant(tenant.id, "Reports Only", ["reports.staff"]);
  await addMembership(tenant.id, reportsOnlyUser.id, reportsOnlyRoleId);
  const noPermRoleId = await createRoleForTenant(tenant.id, "No Perm", []);
  await addMembership(tenant.id, noPermUser.id, noPermRoleId);

  otherTenant = await createTestTenant("test-p5a3b-other", otherOwner.id);
  otherBranchId = await createBranch(otherTenant.id, "Other Branch");
  const [otherStaffRow] = await testDb<{ id: string }[]>`insert into staff_members (tenant_id, full_name) values (${otherTenant.id}, 'Other Tenant Staff') returning id`;
  otherStaffId = otherStaffRow!.id;
  await testDb`insert into staff_branches (staff_member_id, branch_id) values (${otherStaffId}, ${otherBranchId})`;

  dstTenant = await createTestTenant("test-p5a3b-dst", dstOwner.id);
  dstBranchId = await createBranch(dstTenant.id, "DST Branch");
  await testDb`update tenants set timezone = 'Europe/Nicosia' where id = ${dstTenant.id}`;
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenant.id, otherTenant.id, dstTenant.id]);
  await cleanupUsers([owner.id, stylistUser.id, reportsOnlyUser.id, noPermUser.id, otherOwner.id, dstOwner.id]);
});

describe("security & permissions", () => {
  it("owner (reports.staff via SALON_OWNER) is allowed", async () => {
    const { error } = await utilizationAs(owner, { startAt: hoursFromNow(-1), endAt: hoursFromNow(1) });
    expect(error).toBeNull();
  });

  it("reports-only role (bare reports.staff permission) is allowed", async () => {
    const { error } = await utilizationAs(reportsOnlyUser, { startAt: hoursFromNow(-1), endAt: hoursFromNow(1) });
    expect(error).toBeNull();
  });

  it("STYLIST (no reports.staff by default) is rejected RP002", async () => {
    const { error } = await utilizationAs(stylistUser, { startAt: hoursFromNow(-1), endAt: hoursFromNow(1) });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("RP002");
  });

  it("authenticated member with an explicit empty-permission role is rejected RP002", async () => {
    const { error } = await utilizationAs(noPermUser, { startAt: hoursFromNow(-1), endAt: hoursFromNow(1) });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("RP002");
  });

  it("anon is rejected outright (no execute grant)", async () => {
    const client = anonClient();
    const { error } = await client.rpc("get_staff_utilization", {
      p_tenant_id: tenant.id,
      p_start_at: hoursFromNow(-1).toISOString(),
      p_end_at: hoursFromNow(1).toISOString(),
      p_branch_id: null,
      p_staff_ids: null,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
  });
});

describe("tenant isolation & foreign filter safety", () => {
  it("a foreign tenant's staff never appears, even unfiltered", async () => {
    const { data } = await utilizationAs(owner, { startAt: hoursFromNow(-1), endAt: hoursFromNow(1) });
    expect(data.staff.some((s) => s.staffId === otherStaffId)).toBe(false);
  });

  it("filtering p_staff_ids to a foreign-tenant staff id safely returns empty, no leak/error", async () => {
    const { data, error } = await utilizationAs(owner, { startAt: hoursFromNow(-1), endAt: hoursFromNow(1), staffIds: [otherStaffId] });
    expect(error).toBeNull();
    expect(data.staff).toEqual([]);
    expect(data.totals).toEqual({ scheduledMinutes: 0, capacityMinutes: 0, utilizedMinutes: 0, utilization: null });
  });

  it("filtering p_branch_id to a foreign-tenant branch id safely returns empty, no leak/error", async () => {
    const { data, error } = await utilizationAs(owner, { startAt: hoursFromNow(-1), endAt: hoursFromNow(1), branchId: otherBranchId });
    expect(error).toBeNull();
    expect(data.staff).toEqual([]);
    expect(data.totals.scheduledMinutes).toBe(0);
    expect(data.totals.utilization).toBeNull();
  });

  it("filtering p_branch_id to a nonexistent (random) uuid is equally safe", async () => {
    const { data, error } = await utilizationAs(owner, {
      startAt: hoursFromNow(-1), endAt: hoursFromNow(1), branchId: "00000000-0000-0000-0000-000000000000",
    });
    expect(error).toBeNull();
    expect(data.staff).toEqual([]);
  });

  it("a foreign-tenant p_branch_id does NOT pull in this tenant's own NULL-branch schedule rows", async () => {
    // The specific leak the audit flagged: (branch_id IS NULL OR branch_id
    // = p_branch_id) alone would match a NULL-branch row for ANY
    // p_branch_id, including a foreign one, unless p_branch_id is proven
    // to belong to this tenant first.
    const date = pastDateStr(200);
    const staff = await activeStaff("Foreign Branch Leak Staff", [branchId]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00"); // NULL branch_id
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, branchId: otherBranchId, staffIds: [staff] });
    expect(data.staff).toEqual([]);
    expect(data.totals.scheduledMinutes).toBe(0);
  });
});

describe("population: roster + history, never schedule-driven", () => {
  it("an active staff member with NO schedule configured still appears, all zero, utilization null", async () => {
    const staff = await activeStaff("No Schedule Staff");
    const { data } = await utilizationAs(owner, { startAt: hoursFromNow(-1), endAt: hoursFromNow(1), staffIds: [staff] });
    expect(data.staff).toHaveLength(1);
    const row = data.staff[0]!;
    expect(row.scheduledMinutes).toBe(0);
    expect(row.capacityMinutes).toBe(0);
    expect(row.utilizedMinutes).toBe(0);
    expect(row.utilization).toBeNull();
  });

  it("inactive staff WITH completed activity in the selected range still appears", async () => {
    const staff = await inactiveStaff("Inactive But Active History Staff", [branchId]);
    const start = hoursFromNow(-3);
    await createAppointment({ status: "completed", scheduledStartAt: hoursFromNow(-2), items: [{ staffMemberId: staff, durationMinutes: 30 }] });
    const { data } = await utilizationAs(owner, { startAt: start, endAt: hoursFromNow(-1), staffIds: [staff] });
    expect(data.staff.map((s) => s.staffId)).toContain(staff);
  });

  it("inactive staff with only a stale schedule row and NO activity in range does NOT appear", async () => {
    const date = pastDateStr(210);
    const staff = await inactiveStaff("Stale Schedule Only Staff", [branchId]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00");
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    expect(data.staff).toEqual([]);
  });

  it("branch-filtered historical inclusion uses the appointment's OWN branch_id, not the staff member's current staff_branches row", async () => {
    // Staff worked at branchId2 historically, is inactive now, and has
    // since been removed from staff_branches entirely (or never had it) —
    // history must not be erased by that.
    const staff = await inactiveStaff("Branch History Staff", []);
    const start = hoursFromNow(-3);
    await createAppointment({ status: "completed", scheduledStartAt: hoursFromNow(-2), branchId: branchId2, items: [{ staffMemberId: staff, durationMinutes: 30 }] });
    const { data } = await utilizationAs(owner, { startAt: start, endAt: hoursFromNow(-1), branchId: branchId2, staffIds: [staff] });
    expect(data.staff.map((s) => s.staffId)).toContain(staff);
    // and correctly absent when filtered to the OTHER branch, where they never worked
    const { data: dataA } = await utilizationAs(owner, { startAt: start, endAt: hoursFromNow(-1), branchId: branchId, staffIds: [staff] });
    expect(dataA.staff.map((s) => s.staffId)).not.toContain(staff);
  });
});

describe("capacity", () => {
  it("capacity=1 (default): capacityMinutes equals scheduledMinutes", async () => {
    const date = pastDateStr(61);
    const staff = await activeStaff("Capacity One Staff");
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "10:00"); // 120 min
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    const row = data.staff.find((s) => s.staffId === staff)!;
    expect(row.scheduledMinutes).toBe(120);
    expect(row.capacityMinutes).toBe(120);
    expect(row.concurrentCapacity).toBe(1);
  });

  it("capacity>1: capacityMinutes = scheduledMinutes x concurrentCapacity", async () => {
    const date = pastDateStr(62);
    const [staffRow] = await testDb<{ id: string }[]>`insert into staff_members (tenant_id, full_name, concurrent_capacity) values (${tenant.id}, 'Capacity Three Staff', 3) returning id`;
    await linkStaffBranch(staffRow!.id, branchId);
    await createStaffSchedule(tenant.id, staffRow!.id, weekdayOf(date), "08:00", "10:00"); // 120 min
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staffRow!.id] });
    const row = data.staff.find((s) => s.staffId === staffRow!.id)!;
    expect(row.scheduledMinutes).toBe(120);
    expect(row.capacityMinutes).toBe(360);
    expect(row.concurrentCapacity).toBe(3);
  });
});

describe("exceptions", () => {
  it("a closed weekday (no schedule row for that weekday, no exception) contributes zero", async () => {
    // 27 days apart (not adjacent) so windowFor's generous +30h/-6h margin
    // for closedDate can never spill into scheduledDate's own local day.
    const scheduledDate = pastDateStr(63);
    const closedDate = pastDateStr(90);
    const staff = await activeStaff("Closed Weekday Staff");
    await createStaffSchedule(tenant.id, staff, weekdayOf(scheduledDate), "08:00", "17:00");
    const { start, end } = windowFor(closedDate);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    const row = data.staff.find((s) => s.staffId === staff);
    expect(row?.scheduledMinutes ?? 0).toBe(0);
  });

  it("custom_hours COMPLETELY REPLACES the recurring day, never adds to it", async () => {
    const date = pastDateStr(65);
    const staff = await activeStaff("Custom Hours Staff");
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00"); // recurring 9h
    await createScheduleException(tenant.id, staff, date, "custom_hours", "09:00", "11:00"); // 2h override
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    const row = data.staff.find((s) => s.staffId === staff)!;
    expect(row.scheduledMinutes).toBe(120); // exactly the override, not 9h+2h and not 9h
  });

  it("unavailable zeroes the entire date, regardless of the recurring schedule", async () => {
    const date = pastDateStr(66);
    const staff = await activeStaff("Unavailable Staff");
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00");
    await createScheduleException(tenant.id, staff, date, "unavailable");
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    const row = data.staff.find((s) => s.staffId === staff);
    expect(row?.scheduledMinutes ?? 0).toBe(0);
  });
});

describe("branch semantics", () => {
  it("a branch-specific schedule row only counts for that branch, not the other", async () => {
    const date = pastDateStr(67);
    const staff = await activeStaff("Branch Specific Staff", [branchId, branchId2]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00", branchId); // 540 min, branch A only
    const { start, end } = windowFor(date);
    const [dataA, dataB] = await Promise.all([
      utilizationAs(owner, { startAt: start, endAt: end, branchId, staffIds: [staff] }),
      utilizationAs(owner, { startAt: start, endAt: end, branchId: branchId2, staffIds: [staff] }),
    ]);
    expect(dataA.data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(540);
    expect(dataB.data.staff.find((s) => s.staffId === staff)?.scheduledMinutes ?? 0).toBe(0);
  });

  it("a NULL-branch schedule row is visible tenant-wide", async () => {
    const date = pastDateStr(68);
    const staff = await activeStaff("Null Branch Visible Staff", [branchId]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00"); // NULL branch
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(540);
  });

  it("multi-branch NULL-branch schedule: tenant-wide total is 9h, NEVER multiplied by assigned-branch count", async () => {
    const date = pastDateStr(69);
    const staff = await activeStaff("Multi Branch Null Staff", [branchId, branchId2]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00"); // NULL branch, 9h
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(540); // not 1080
    expect(data.totals.scheduledMinutes).toBe(540);
  });

  it("the SAME NULL-branch row independently gives the full 9h when filtered to branch A", async () => {
    const date = pastDateStr(70);
    const staff = await activeStaff("Null Branch A View Staff", [branchId, branchId2]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00");
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, branchId, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(540);
  });

  it("the SAME NULL-branch row independently gives the full 9h when filtered to branch B too (intentional overlap)", async () => {
    const date = pastDateStr(71);
    const staff = await activeStaff("Null Branch B View Staff", [branchId, branchId2]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00");
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, branchId: branchId2, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(540);
  });
});

describe("Faz 5A.3E — tenant-wide reports must include branch-specific schedule rows", () => {
  // Regression coverage for a real PROD defect: (ss.branch_id is null or
  // ss.branch_id = p_branch_id) collapses to just "ss.branch_id is null"
  // whenever p_branch_id is NULL (SQL three-valued logic makes
  // "x = NULL" never TRUE regardless of x), so a tenant-wide report was
  // silently excluding every branch-specific schedule row. Every existing
  // tenant-wide test above happens to use a NULL-branch schedule, and the
  // one branch-specific test above always pairs it with an explicit,
  // matching branch filter — neither combination exercises the bug. These
  // tests specifically combine "branch-specific schedule row" with "no
  // branch filter", the exact shape the real PROD tenant's data has.

  it("1. tenant-wide, one branch-specific 08:00-17:00 schedule => scheduledMinutes=540", async () => {
    const date = pastDateStr(80);
    const staff = await activeStaff("5A3E Single Branch Specific Staff", [branchId]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00", branchId);
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] }); // no branchId => tenant-wide
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(540);
  });

  it("2. tenant-wide, two non-overlapping branch-specific rows (branch A 08-12, branch B 13-17) => scheduledMinutes=480", async () => {
    const date = pastDateStr(81);
    const staff = await activeStaff("5A3E Two Branch Staff", [branchId, branchId2]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "12:00", branchId);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "13:00", "17:00", branchId2);
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(480);
  });

  it("3. tenant-wide, two OVERLAPPING branch-specific rows (branch A 08-12, branch B 08-12) => scheduledMinutes=240, NOT 480 (UNION of wall-clock capacity, not SUM)", async () => {
    const date = pastDateStr(82);
    const staff = await activeStaff("5A3E Overlap Branch Staff", [branchId, branchId2]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "12:00", branchId);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "12:00", branchId2);
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(240);
  });

  it("4. tenant-wide, NULL-branch schedule still works unchanged (no regression from the fix)", async () => {
    const date = pastDateStr(83);
    const staff = await activeStaff("5A3E Null Still Works Staff", [branchId]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00"); // NULL branch
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(540);
  });

  it("5. branch A filter includes a NULL-branch row and a branch-A row, excludes a branch-B-only row", async () => {
    const date = pastDateStr(84);
    const staff = await activeStaff("5A3E Filter Mix A Staff", [branchId, branchId2]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "09:00", null); // NULL branch, 60min
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "10:00", "11:00", branchId); // branch A, 60min
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "12:00", "13:00", branchId2); // branch B only, 60min
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, branchId, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(120); // NULL + A, not B
  });

  it("6. branch B filter includes a NULL-branch row and a branch-B row, excludes a branch-A-only row", async () => {
    const date = pastDateStr(85);
    const staff = await activeStaff("5A3E Filter Mix B Staff", [branchId, branchId2]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "09:00", null); // NULL branch, 60min
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "10:00", "11:00", branchId); // branch A only, 60min
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "12:00", "13:00", branchId2); // branch B, 60min
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, branchId: branchId2, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(120); // NULL + B, not A
  });

  it("7. a foreign-tenant branch id still returns empty safely with branch-specific schedules present", async () => {
    const date = pastDateStr(86);
    const staff = await activeStaff("5A3E Foreign Branch Safety Staff", [branchId]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00", branchId);
    const { start, end } = windowFor(date);
    const { data, error } = await utilizationAs(owner, { startAt: start, endAt: end, branchId: otherBranchId, staffIds: [staff] });
    expect(error).toBeNull();
    expect(data.staff).toEqual([]);
    expect(data.totals.scheduledMinutes).toBe(0);
  });

  it("8. Gökhan production shape: active staff with branch-specific-only schedules, no branch filter => capacityMinutes>0 and utilization is NOT null once completed work exists", async () => {
    const date = pastDateStr(87);
    const staff = await activeStaff("5A3E Production Shape Staff", [branchId]);
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "09:00", "18:00", branchId); // 540 min, branch-specific only
    await createAppointment({
      status: "completed",
      scheduledStartAt: new Date(`${date}T09:00:00Z`),
      items: [{ staffMemberId: staff, durationMinutes: 30 }],
    });
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] }); // tenant-wide, matching the real PROD Raporlar default
    const row = data.staff.find((s) => s.staffId === staff)!;
    expect(row.scheduledMinutes).toBe(540);
    expect(row.capacityMinutes).toBeGreaterThan(0);
    expect(row.utilization).not.toBeNull();
    expect(row.utilization).toBeCloseTo(30 / 540, 10);
  });
});

describe("overlapping schedule rows: UNION, not SUM", () => {
  it("two exact-duplicate schedule rows dedupe to one interval's worth of minutes", async () => {
    const date = pastDateStr(72);
    const staff = await activeStaff("Duplicate Rows Staff");
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "12:00");
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "12:00");
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(240); // not 480
  });

  it("two partially-overlapping schedule rows (08-12 + 10-14) UNION to 360, not 480", async () => {
    const date = pastDateStr(73);
    const staff = await activeStaff("Partial Overlap Staff");
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "12:00");
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "10:00", "14:00");
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(360);
  });
});

describe("effective_end_at: today / future", () => {
  it("historical range (both boundaries in the past) is NOT clipped — full scheduled minutes count", async () => {
    const date = pastDateStr(74);
    const staff = await activeStaff("Historical Not Clipped Staff");
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "17:00");
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes).toBe(540);
  });

  it("today: a wide-open schedule clips to elapsed minutes only, never the full day", async () => {
    const staff = await activeStaff("Today Clip Staff");
    const nowIstanbul = new Date(Date.now() + 3 * 3600_000);
    const todayWeekday = nowIstanbul.getUTCDay();
    const expectedElapsed = nowIstanbul.getUTCHours() * 60 + nowIstanbul.getUTCMinutes();
    await createStaffSchedule(tenant.id, staff, todayWeekday, "00:00", "23:59");
    const { data } = await utilizationAs(owner, { startAt: hoursFromNow(-100), endAt: hoursFromNow(100), staffIds: [staff] });
    const row = data.staff.find((s) => s.staffId === staff)!;
    expect(row.scheduledMinutes).toBeGreaterThanOrEqual(expectedElapsed - 1);
    expect(row.scheduledMinutes).toBeLessThanOrEqual(expectedElapsed + 3);
    expect(row.scheduledMinutes).toBeLessThan(1439);
  });

  it("a schedule row for tomorrow's weekday is entirely excluded once the window clips to now", async () => {
    const staff = await activeStaff("Future Excluded Staff");
    const tomorrowWeekday = new Date(Date.now() + 27 * 3600_000).getUTCDay();
    await createStaffSchedule(tenant.id, staff, tomorrowWeekday, "08:00", "17:00");
    const { data } = await utilizationAs(owner, { startAt: hoursFromNow(-1), endAt: hoursFromNow(48), staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.scheduledMinutes ?? 0).toBe(0);
  });

  it("an entirely future range returns zero everything and null utilization, not an error", async () => {
    const { data, error } = await utilizationAs(owner, { startAt: hoursFromNow(100), endAt: hoursFromNow(200) });
    expect(error).toBeNull();
    expect(data.totals).toEqual({ scheduledMinutes: 0, capacityMinutes: 0, utilizedMinutes: 0, utilization: null });
    expect(data.staff).toEqual([]);
  });
});

describe("utilizedMinutes: elapsed-overlap numerator (deliberately unlike 5A.3A's completedMinutes)", () => {
  it("a future-scheduled item already marked completed contributes ZERO before its own scheduled_start_at is reached", async () => {
    const staff = await activeStaff("Future Completed Staff");
    const itemStart = hoursFromNow(3);
    await createAppointment({ status: "completed", scheduledStartAt: itemStart, items: [{ staffMemberId: staff, durationMinutes: 60 }] });
    const { data } = await utilizationAs(owner, { startAt: hoursFromNow(-1), endAt: hoursFromNow(10), staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.utilizedMinutes ?? 0).toBe(0);
  });

  it("a partially-elapsed completed item contributes only the overlap with [p_start_at, effective_end_at)", async () => {
    const staff = await activeStaff("Partial Elapsed Staff");
    // straddles "now": started 30 min ago, scheduled to run another 90 min.
    const itemStart = hoursFromNow(-0.5);
    await createAppointment({ status: "completed", scheduledStartAt: itemStart, items: [{ staffMemberId: staff, durationMinutes: 120 }] });
    const { data } = await utilizationAs(owner, { startAt: hoursFromNow(-2), endAt: hoursFromNow(5), staffIds: [staff] });
    const row = data.staff.find((s) => s.staffId === staff)!;
    // elapsed portion is ~30 minutes (now - itemStart), never the full 120.
    expect(row.utilizedMinutes).toBeGreaterThanOrEqual(29);
    expect(row.utilizedMinutes).toBeLessThanOrEqual(32);
  });

  it("duration crossing the report's own end boundary is clipped for utilizedMinutes (unlike 5A.3A's completedMinutes)", async () => {
    const staff = await activeStaff("Crosses Report End Staff");
    const base = hoursFromNow(-50); // safely historical: p_end_at itself, not now(), is what clips here
    const itemStart = base;
    const itemEnd = new Date(base.getTime() + 60 * 60_000); // 60-minute item
    const reportEnd = new Date(base.getTime() + 30 * 60_000); // report ends 30 min into the item
    const [cust] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'Crosses End Customer') returning id`;
    const [appt] = await testDb<{ id: string }[]>`insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at) values (${tenant.id}, ${branchId}, ${cust!.id}, 'completed', ${itemStart.toISOString()}, ${itemEnd.toISOString()}) returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence, appointment_status) values (${tenant.id}, ${appt!.id}, ${serviceA.id}, ${staff}, ${itemStart.toISOString()}, ${itemEnd.toISOString()}, 60, 200, 1, 'completed')`;
    const { data } = await utilizationAs(owner, { startAt: new Date(base.getTime() - 3600_000), endAt: reportEnd, staffIds: [staff] });
    expect(data.staff.find((s) => s.staffId === staff)?.utilizedMinutes).toBe(30);
  });

  it("overlapping completed items for a capacity>1 staff member are additive in the numerator", async () => {
    const [staffRow] = await testDb<{ id: string }[]>`insert into staff_members (tenant_id, full_name, concurrent_capacity) values (${tenant.id}, 'Additive Overlap Staff', 2) returning id`;
    await linkStaffBranch(staffRow!.id, branchId);
    const start = hoursFromNow(-52);
    await createAppointment({ status: "completed", scheduledStartAt: start, items: [{ staffMemberId: staffRow!.id, durationMinutes: 60 }] });
    await createAppointment({ status: "completed", scheduledStartAt: start, items: [{ staffMemberId: staffRow!.id, durationMinutes: 60 }] });
    const { data } = await utilizationAs(owner, { startAt: hoursFromNow(-53), endAt: hoursFromNow(-50), staffIds: [staffRow!.id] });
    expect(data.staff.find((s) => s.staffId === staffRow!.id)?.utilizedMinutes).toBe(120); // both count in full, not deduped
  });
});

describe("utilization ratio", () => {
  it("exactly 100% (utilization = 1) when utilizedMinutes equals capacityMinutes", async () => {
    const date = pastDateStr(75);
    const staff = await activeStaff("Exactly Full Staff");
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "09:00"); // 60 min capacity
    const { start } = windowFor(date);
    await createAppointment({ status: "completed", scheduledStartAt: new Date(`${date}T08:00:00Z`), items: [{ staffMemberId: staff, durationMinutes: 60 }] });
    const { end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staff] });
    const row = data.staff.find((s) => s.staffId === staff)!;
    expect(row.scheduledMinutes).toBe(60);
    expect(row.utilizedMinutes).toBe(60);
    expect(row.utilization).toBe(1);
  });

  it(">100% is returned honestly, never silently capped", async () => {
    // Capacity based on a narrow 1h schedule window, but two DIFFERENT
    // staff-eligible completed appointments (capacity=2) both land inside
    // it, so utilizedMinutes can legitimately exceed capacityMinutes: a
    // real, disclosed artifact of "current capacity applied retroactively
    // to historical schedule minutes" (see migration header, capacity
    // history is not snapshotted).
    const date = pastDateStr(76);
    const [staffRow] = await testDb<{ id: string }[]>`insert into staff_members (tenant_id, full_name, concurrent_capacity) values (${tenant.id}, 'Over Full Staff', 2) returning id`;
    await linkStaffBranch(staffRow!.id, branchId);
    await createStaffSchedule(tenant.id, staffRow!.id, weekdayOf(date), "08:00", "09:00"); // 60 min x capacity 2 = 120 capacityMinutes
    await createAppointment({ status: "completed", scheduledStartAt: new Date(`${date}T08:00:00Z`), items: [{ staffMemberId: staffRow!.id, durationMinutes: 60 }] });
    await createAppointment({ status: "completed", scheduledStartAt: new Date(`${date}T08:00:00Z`), items: [{ staffMemberId: staffRow!.id, durationMinutes: 60 }] });
    await createAppointment({ status: "completed", scheduledStartAt: new Date(`${date}T08:00:00Z`), items: [{ staffMemberId: staffRow!.id, durationMinutes: 60 }] });
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staffRow!.id] });
    const row = data.staff.find((s) => s.staffId === staffRow!.id)!;
    expect(row.capacityMinutes).toBe(120);
    expect(row.utilizedMinutes).toBe(180);
    expect(row.utilization).toBeCloseTo(1.5, 10);
  });

  it("totals.utilization is recomputed from summed minutes, NOT averaged from staff[] percentages", async () => {
    const date = pastDateStr(77);
    const staffLow = await activeStaff("Weighted Low Staff");
    const staffHigh = await activeStaff("Weighted High Staff");
    // staff A: 100 min capacity, 50 min utilized -> 0.5
    await createStaffSchedule(tenant.id, staffLow, weekdayOf(date), "08:00", "09:40"); // 100 min
    await createAppointment({ status: "completed", scheduledStartAt: new Date(`${date}T08:00:00Z`), items: [{ staffMemberId: staffLow, durationMinutes: 50 }] });
    // staff B: 300 min capacity, 30 min utilized -> 0.1
    await createStaffSchedule(tenant.id, staffHigh, weekdayOf(date), "10:00", "15:00"); // 300 min
    await createAppointment({ status: "completed", scheduledStartAt: new Date(`${date}T10:00:00Z`), items: [{ staffMemberId: staffHigh, durationMinutes: 30 }] });
    const { start, end } = windowFor(date);
    const { data } = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [staffLow, staffHigh] });
    const rowLow = data.staff.find((s) => s.staffId === staffLow)!;
    const rowHigh = data.staff.find((s) => s.staffId === staffHigh)!;
    expect(rowLow.utilization).toBeCloseTo(0.5, 10);
    expect(rowHigh.utilization).toBeCloseTo(0.1, 10);
    // naive average of [0.5, 0.1] would be 0.3 -- the correct weighted
    // figure is (50+30)/(100+300) = 0.2.
    expect(data.totals.scheduledMinutes).toBe(400);
    expect(data.totals.capacityMinutes).toBe(400);
    expect(data.totals.utilizedMinutes).toBe(80);
    expect(data.totals.utilization).toBeCloseTo(0.2, 10);
  });
});

describe("timezone / DST — Europe/Nicosia", () => {
  it("spring-forward 2026-03-29: a normal 08:00-17:00 business day still computes to exactly 540 minutes", async () => {
    const [staffRow] = await testDb<{ id: string }[]>`insert into staff_members (tenant_id, full_name) values (${dstTenant.id}, 'DST Spring Staff') returning id`;
    await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staffRow!.id}, ${dstBranchId})`;
    await testDb`insert into staff_schedules (tenant_id, staff_member_id, weekday, start_time, end_time) values (${dstTenant.id}, ${staffRow!.id}, 0, '08:00', '17:00')`; // 2026-03-29 is a Sunday
    const { data, error } = await utilizationAs(dstOwner, {
      tenantId: dstTenant.id,
      startAt: new Date("2026-03-28T20:00:00Z"),
      endAt: new Date("2026-03-29T22:00:00Z"),
      staffIds: [staffRow!.id],
    });
    expect(error).toBeNull();
    expect(data.staff.find((s) => s.staffId === staffRow!.id)?.scheduledMinutes).toBe(540);
  });

  it("fall-back 2025-10-26: a normal 08:00-17:00 business day still computes to exactly 540 minutes", async () => {
    const [staffRow] = await testDb<{ id: string }[]>`insert into staff_members (tenant_id, full_name) values (${dstTenant.id}, 'DST Fall Staff') returning id`;
    await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staffRow!.id}, ${dstBranchId})`;
    await testDb`insert into staff_schedules (tenant_id, staff_member_id, weekday, start_time, end_time) values (${dstTenant.id}, ${staffRow!.id}, 0, '08:00', '17:00')`; // 2025-10-26 is a Sunday
    const { data, error } = await utilizationAs(dstOwner, {
      tenantId: dstTenant.id,
      startAt: new Date("2025-10-25T20:00:00Z"),
      endAt: new Date("2025-10-26T23:00:00Z"),
      staffIds: [staffRow!.id],
    });
    expect(error).toBeNull();
    expect(data.staff.find((s) => s.staffId === staffRow!.id)?.scheduledMinutes).toBe(540);
  });
});

describe("zero customer PII", () => {
  it("the response never contains the served customer's real name or any customer-identifying key", async () => {
    const staff = await activeStaff("PII Proof Staff");
    const distinctiveName = `VeryDistinctivePII${crypto.randomUUID().slice(0, 8)}`;
    const customer = await createCustomer(tenant.id, distinctiveName);
    const start = hoursFromNow(-4);
    await createAppointment({ status: "completed", scheduledStartAt: hoursFromNow(-3), customerId: customer.id, items: [{ staffMemberId: staff, durationMinutes: 30 }] });
    const { data } = await utilizationAs(owner, { startAt: start, endAt: hoursFromNow(-1), staffIds: [staff] });
    const json = JSON.stringify(data);
    expect(json).not.toContain(distinctiveName);
    const lower = json.toLowerCase();
    for (const key of ["customerid", "customername", "phone", "email"]) {
      expect(lower).not.toContain(key.toLowerCase());
    }
  });
});

describe("filter NULL/empty semantics", () => {
  it("NULL p_staff_ids and an empty-array p_staff_ids both mean 'no filter' and produce identical staff sets", async () => {
    const date = pastDateStr(78);
    const staff = await activeStaff("Null Empty Filter Util Staff");
    await createStaffSchedule(tenant.id, staff, weekdayOf(date), "08:00", "09:00");
    const { start, end } = windowFor(date);
    const withNull = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: null });
    const withEmpty = await utilizationAs(owner, { startAt: start, endAt: end, staffIds: [] });
    const rowNull = withNull.data.staff.find((s) => s.staffId === staff);
    const rowEmpty = withEmpty.data.staff.find((s) => s.staffId === staff);
    expect(rowNull).toBeDefined();
    expect(rowEmpty).toBeDefined();
    expect(rowNull).toEqual(rowEmpty);
  });
});

describe("input validation", () => {
  it("RP003: missing start_at or end_at is rejected", async () => {
    const client = await signInAs(owner);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badArgs: any = { p_tenant_id: tenant.id, p_start_at: null, p_end_at: hoursFromNow(1).toISOString(), p_branch_id: null, p_staff_ids: null };
    const { error } = await client.rpc("get_staff_utilization", badArgs);
    await client.auth.signOut();
    expect(error).not.toBeNull();
    expect(error!.code).toBe("RP003");
  });

  it("RP004: start_at >= end_at is rejected", async () => {
    const { error } = await utilizationAs(owner, { startAt: hoursFromNow(1), endAt: hoursFromNow(-1) });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("RP004");
  });
});
