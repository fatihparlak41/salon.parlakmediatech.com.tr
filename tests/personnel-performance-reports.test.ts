import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StaffPerformanceSummary } from "@/lib/modules/reports/queries";
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
  linkStaffService,
  cleanupTenants,
  cleanupUsers,
  hoursFromNow,
  type TestUser,
  type TestTenant,
} from "./helpers";

/**
 * Faz 5A.3A — get_staff_performance_summary. Covers the full metric
 * contract locked in the Faz 5A.3 audit + its corrections: totals
 * computed independently (never summed from staff[]), cancelled/no-show
 * as DISTINCT appointment counts (never item counts), tenant-wide
 * first-ever new/returning classification, effective-performer fallback
 * read from the view (never re-derived), zero customer PII, and full
 * tenant isolation. No utilization here — that's Faz 5A.3B.
 *
 * Every test asserting an EXACT count uses its own freshly created,
 * dedicated staff member(s) and/or customer(s). Many tests here use
 * overlapping relative-time windows on purpose (hoursFromNow(-1) etc. is
 * a natural, readable way to express "in range" vs "before range"), so
 * without per-test dedicated staff, one test's fixture would silently
 * pollute another's aggregate count. This is the exact same lesson
 * already documented in customer-cancellation.test.ts and applied
 * throughout personnel-performance-foundation.test.ts.
 */

let owner: TestUser;
let managerUser: TestUser;
let stylistUser: TestUser;
let reportsOnlyUser: TestUser;
let noPermUser: TestUser;
let tenant: TestTenant;
let branchId: string;
let serviceA: { id: string; name: string };
let serviceB: { id: string; name: string };
let otherTenant: TestTenant;
let otherOwner: TestUser;
let otherStaffId: string;
let otherServiceId: string;

async function eligibleStaff(fullName: string): Promise<string> {
  const staff = await createStaffMember(tenant.id, fullName);
  await linkStaffBranch(staff.id, branchId);
  await linkStaffService(staff.id, serviceA.id);
  await linkStaffService(staff.id, serviceB.id);
  return staff.id;
}

/** Inserts an appointment + N items directly at whatever status is
 * needed for a given test — this file exercises the report RPC's READ
 * contract, not the completion RPC, so fixtures go straight to their
 * target state rather than transitioning through complete_appointment. */
async function createAppointment(params: {
  status: "completed" | "cancelled" | "no_show" | "confirmed";
  scheduledStartAt: Date;
  customerId?: string;
  items: { serviceId: string; staffMemberId: string; actualStaffMemberId?: string | null; durationMinutes?: number }[];
}): Promise<{ appointmentId: string; itemIds: string[]; customerId: string }> {
  const customerId = params.customerId ?? (await createCustomer(tenant.id, `Report Customer ${crypto.randomUUID().slice(0, 8)}`)).id;
  let cursor = params.scheduledStartAt;
  const totalMinutes = params.items.reduce((sum, i) => sum + (i.durationMinutes ?? 30), 0);
  const end = new Date(params.scheduledStartAt.getTime() + totalMinutes * 60_000);
  const [appt] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
    values (${tenant.id}, ${branchId}, ${customerId}, ${params.status}, ${params.scheduledStartAt.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
    returning id`;
  const itemIds: string[] = [];
  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i]!;
    const duration = item.durationMinutes ?? 30;
    const itemStart = new Date(cursor);
    const itemEnd = new Date(itemStart.getTime() + duration * 60_000);
    cursor = itemEnd;
    const [row] = await testDb<{ id: string }[]>`
      insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, actual_staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${appt!.id}, ${item.serviceId}, ${item.staffMemberId}, ${item.actualStaffMemberId ?? null}, ${itemStart.toISOString()}::timestamptz, ${itemEnd.toISOString()}::timestamptz, ${duration}, 200, ${i + 1})
      returning id`;
    itemIds.push(row!.id);
  }
  return { appointmentId: appt!.id, itemIds, customerId };
}

/** Casts the RPC's generic Json return to the real shape once, here,
 * rather than at each of the call sites below — same "cast at the query
 * boundary" convention lib/modules/reports/queries.ts itself follows.
 * Deliberately a flat type, not a discriminated union: every success-path
 * test below reads `data.*` straight through with no error check first,
 * and every error-path test (RP003/RP004) reads only `error` and never
 * touches `data` — so `data`'s declared type just needs to satisfy the
 * former without forcing a null-check at every one of those call sites. */
async function summaryAs(
  user: TestUser,
  params: { startAt: Date; endAt: Date; tenantId?: string; branchId?: string | null; staffIds?: string[] | null; serviceIds?: string[] | null },
): Promise<{ data: StaffPerformanceSummary; error: { code?: string; message: string } | null }> {
  const client = await signInAs(user);
  const { data, error } = await client.rpc("get_staff_performance_summary", {
    p_tenant_id: params.tenantId ?? tenant.id,
    p_start_at: params.startAt.toISOString(),
    p_end_at: params.endAt.toISOString(),
    p_branch_id: params.branchId ?? null,
    p_staff_ids: params.staffIds ?? null,
    p_service_ids: params.serviceIds ?? null,
  });
  await client.auth.signOut();
  return { data: data as unknown as StaffPerformanceSummary, error };
}

beforeAll(async () => {
  owner = await createTestUser("p5a3a-owner");
  managerUser = await createTestUser("p5a3a-manager");
  stylistUser = await createTestUser("p5a3a-stylist");
  reportsOnlyUser = await createTestUser("p5a3a-reports-only");
  noPermUser = await createTestUser("p5a3a-no-perm");
  otherOwner = await createTestUser("p5a3a-other-owner");

  tenant = await createTestTenant("test-p5a3a-reports", owner.id);
  branchId = await createBranch(tenant.id, "Reports Branch");
  serviceA = await createService(tenant.id, "Kesim", 30, 300);
  serviceB = await createService(tenant.id, "Boya", 60, 800);
  await testDb`insert into service_branches (service_id, branch_id) values (${serviceA.id}, ${branchId}), (${serviceB.id}, ${branchId})`;

  await createTestMembershipFromTemplate(tenant.id, managerUser.id, "SALON_MANAGER");
  await createTestMembershipFromTemplate(tenant.id, stylistUser.id, "STYLIST");
  const reportsOnlyRoleId = await createRoleForTenant(tenant.id, "Reports Only", ["reports.staff"]);
  await addMembership(tenant.id, reportsOnlyUser.id, reportsOnlyRoleId);
  const noPermRoleId = await createRoleForTenant(tenant.id, "No Perm", []);
  await addMembership(tenant.id, noPermUser.id, noPermRoleId);

  otherTenant = await createTestTenant("test-p5a3a-other", otherOwner.id);
  const otherBranchId = await createBranch(otherTenant.id, "Other Branch");
  const [otherStaffRow] = await testDb<{ id: string }[]>`insert into staff_members (tenant_id, full_name) values (${otherTenant.id}, 'Other Tenant Staff') returning id`;
  otherStaffId = otherStaffRow!.id;
  const otherService = await createService(otherTenant.id, "Other Service", 30, 200);
  otherServiceId = otherService.id;
  await testDb`insert into staff_branches (staff_member_id, branch_id) values (${otherStaffId}, ${otherBranchId})`;
  await testDb`insert into staff_services (staff_member_id, service_id) values (${otherStaffId}, ${otherServiceId})`;
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenant.id, otherTenant.id]);
  await cleanupUsers([owner.id, managerUser.id, stylistUser.id, reportsOnlyUser.id, noPermUser.id, otherOwner.id]);
});

describe("security & permissions", () => {
  it("owner (reports.staff via SALON_OWNER) is allowed", async () => {
    const { error } = await summaryAs(owner, { startAt: hoursFromNow(-0.01), endAt: hoursFromNow(0.01) });
    expect(error).toBeNull();
  });

  it("manager (reports.staff via SALON_MANAGER) is allowed", async () => {
    const { error } = await summaryAs(managerUser, { startAt: hoursFromNow(-0.01), endAt: hoursFromNow(0.01) });
    expect(error).toBeNull();
  });

  it("STYLIST is rejected (RP002) — confirms STYLIST still does not receive reports.staff", async () => {
    const { error } = await summaryAs(stylistUser, { startAt: hoursFromNow(-0.01), endAt: hoursFromNow(0.01) });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("RP002");
  });

  it("authenticated role without reports.staff is rejected (RP002)", async () => {
    const { error } = await summaryAs(noPermUser, { startAt: hoursFromNow(-0.01), endAt: hoursFromNow(0.01) });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("RP002");
  });

  it("anon is rejected outright (denied execute, not RP001)", async () => {
    const client = anonClient();
    const { error } = await client.rpc("get_staff_performance_summary", {
      p_tenant_id: tenant.id,
      p_start_at: hoursFromNow(-0.01).toISOString(),
      p_end_at: hoursFromNow(0.01).toISOString(),
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
  });

  it("private.get_staff_performance_summary has no direct grant to authenticated/anon/PUBLIC", async () => {
    const grants = await testDb<{ grantee: string }[]>`
      select grantee::text from information_schema.role_routine_grants
      where routine_schema = 'private' and routine_name = 'get_staff_performance_summary' and privilege_type = 'EXECUTE'`;
    const grantees = grants.map((g) => g.grantee);
    expect(grantees).not.toContain("authenticated");
    expect(grantees).not.toContain("anon");
    expect(grantees).not.toContain("PUBLIC");
  });

  it("public.get_staff_performance_summary: authenticated only, anon/PUBLIC denied", async () => {
    const grants = await testDb<{ grantee: string }[]>`
      select grantee::text from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'get_staff_performance_summary' and privilege_type = 'EXECUTE'`;
    const grantees = grants.map((g) => g.grantee);
    expect(grantees).toContain("authenticated");
    expect(grantees).not.toContain("anon");
    expect(grantees).not.toContain("PUBLIC");
  });
});

describe("tenant isolation", () => {
  it("tenant A cannot obtain tenant B's rows via its own tenant_id", async () => {
    const [otherBranchRow] = await testDb<{ branch_id: string }[]>`select branch_id from staff_branches where staff_member_id = ${otherStaffId} limit 1`;
    const [otherCustomer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${otherTenant.id}, 'Isolation Other Customer') returning id`;
    const start = hoursFromNow(60);
    const end = hoursFromNow(61);
    const [otherAppt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${otherTenant.id}, ${otherBranchRow!.branch_id}, ${otherCustomer!.id}, 'completed', ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
      returning id`;
    await testDb`
      insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${otherTenant.id}, ${otherAppt!.id}, ${otherServiceId}, ${otherStaffId}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, 30, 200, 1)`;

    const { data, error } = await summaryAs(owner, { startAt: start, endAt: end });
    expect(error).toBeNull();
    const staffIds = (data.staff as { staffId: string }[]).map((s) => s.staffId);
    expect(staffIds).not.toContain(otherStaffId);
    expect(data.totals.completedServiceItems).toBe(0); // tenant A's own window has nothing scheduled here
  });

  it("a foreign-tenant staff id in p_staff_ids matches zero rows, never leaks or errors", async () => {
    const staffX = await eligibleStaff("Foreign Filter Staff X");
    const start = hoursFromNow(70);
    await createAppointment({ status: "completed", scheduledStartAt: start, items: [{ serviceId: serviceA.id, staffMemberId: staffX }] });
    const { data, error } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(71), staffIds: [otherStaffId] });
    expect(error).toBeNull();
    expect(data.totals.completedServiceItems).toBe(0);
    expect(data.staff).toEqual([]);
  });

  it("a foreign-tenant service id in p_service_ids matches zero rows, never leaks or errors", async () => {
    const staffY = await eligibleStaff("Foreign Filter Staff Y");
    const start = hoursFromNow(72);
    await createAppointment({ status: "completed", scheduledStartAt: start, items: [{ serviceId: serviceA.id, staffMemberId: staffY }] });
    const { data, error } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(73), serviceIds: [otherServiceId] });
    expect(error).toBeNull();
    expect(data.totals.completedServiceItems).toBe(0);
  });
});

describe("effective performer", () => {
  it("legacy row (actual_staff_member_id explicitly NULL) falls back to booked staff", async () => {
    const staff1 = await eligibleStaff("Legacy Fallback Report Staff");
    const start = hoursFromNow(80);
    await createAppointment({ status: "completed", scheduledStartAt: start, items: [{ serviceId: serviceA.id, staffMemberId: staff1, actualStaffMemberId: null }] });
    const { data } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(81), staffIds: [staff1] });
    const row = (data.staff as { staffId: string; completedServiceItems: number }[]).find((s) => s.staffId === staff1);
    expect(row!.completedServiceItems).toBe(1);
  });

  it("actual performer overrides booked staff — the corrected item is grouped under the ACTUAL performer, never the booked one", async () => {
    const booked = await eligibleStaff("Override Booked Report Staff");
    const actual = await eligibleStaff("Override Actual Report Staff");
    const start = hoursFromNow(82);
    await createAppointment({ status: "completed", scheduledStartAt: start, items: [{ serviceId: serviceA.id, staffMemberId: booked, actualStaffMemberId: actual }] });
    const { data } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(83), staffIds: [booked, actual] });
    const bookedRow = (data.staff as { staffId: string; completedServiceItems: number }[]).find((s) => s.staffId === booked);
    const actualRow = (data.staff as { staffId: string; completedServiceItems: number }[]).find((s) => s.staffId === actual);
    expect(bookedRow).toBeUndefined();
    expect(actualRow!.completedServiceItems).toBe(1);
  });
});

describe("multi-service / multi-performer & distinct-count semantics", () => {
  it("a multi-service appointment with the SAME performer on both items: completedServiceItems=2, completedAppointments=1", async () => {
    const staff1 = await eligibleStaff("Same Performer Multi Staff");
    const start = hoursFromNow(84);
    await createAppointment({
      status: "completed",
      scheduledStartAt: start,
      items: [
        { serviceId: serviceA.id, staffMemberId: staff1 },
        { serviceId: serviceB.id, staffMemberId: staff1 },
      ],
    });
    const { data } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(85), staffIds: [staff1] });
    const row = (data.staff as { staffId: string; completedServiceItems: number; completedAppointments: number }[]).find((s) => s.staffId === staff1);
    expect(row!.completedServiceItems).toBe(2);
    expect(row!.completedAppointments).toBe(1);
  });

  it("the same appointment with DIFFERENT performers per item: each performer's own row credits only their own item", async () => {
    const staff1 = await eligibleStaff("Diff Performer Multi Staff 1");
    const staff2 = await eligibleStaff("Diff Performer Multi Staff 2");
    const start = hoursFromNow(86);
    await createAppointment({
      status: "completed",
      scheduledStartAt: start,
      items: [
        { serviceId: serviceA.id, staffMemberId: staff1 },
        { serviceId: serviceB.id, staffMemberId: staff2 },
      ],
    });
    const { data } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(87), staffIds: [staff1, staff2] });
    const row1 = (data.staff as { staffId: string; completedServiceItems: number }[]).find((s) => s.staffId === staff1);
    const row2 = (data.staff as { staffId: string; completedServiceItems: number }[]).find((s) => s.staffId === staff2);
    expect(row1!.completedServiceItems).toBe(1);
    expect(row2!.completedServiceItems).toBe(1);
  });
});

describe("customer counting: unique / new / returning, and non-additivity", () => {
  it("unique customer de-duplication: two completed visits for the same customer with the same staff count as ONE unique customer", async () => {
    const staff1 = await eligibleStaff("Dedup Report Staff");
    const customer = await createCustomer(tenant.id, "Dedup Customer");
    const start = hoursFromNow(88);
    await createAppointment({ status: "completed", scheduledStartAt: start, customerId: customer.id, items: [{ serviceId: serviceA.id, staffMemberId: staff1 }] });
    await createAppointment({ status: "completed", scheduledStartAt: hoursFromNow(88.5), customerId: customer.id, items: [{ serviceId: serviceA.id, staffMemberId: staff1 }] });
    const { data } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(89), staffIds: [staff1] });
    const row = (data.staff as { staffId: string; uniqueCustomers: number; completedAppointments: number }[]).find((s) => s.staffId === staff1);
    expect(row!.uniqueCustomers).toBe(1);
    expect(row!.completedAppointments).toBe(2);
  });

  it("same customer served by two DIFFERENT staff in range: each staff counts the customer; totals counts the customer ONCE (non-additive, proven directly)", async () => {
    const staff1 = await eligibleStaff("Shared Customer Staff 1");
    const staff2 = await eligibleStaff("Shared Customer Staff 2");
    const customer = await createCustomer(tenant.id, "Shared Customer");
    const start = hoursFromNow(90);
    await createAppointment({ status: "completed", scheduledStartAt: start, customerId: customer.id, items: [{ serviceId: serviceA.id, staffMemberId: staff1 }] });
    await createAppointment({ status: "completed", scheduledStartAt: hoursFromNow(90.5), customerId: customer.id, items: [{ serviceId: serviceB.id, staffMemberId: staff2 }] });

    const { data } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(91), staffIds: [staff1, staff2] });
    const row1 = (data.staff as { staffId: string; uniqueCustomers: number }[]).find((s) => s.staffId === staff1)!;
    const row2 = (data.staff as { staffId: string; uniqueCustomers: number }[]).find((s) => s.staffId === staff2)!;
    expect(row1.uniqueCustomers).toBe(1);
    expect(row2.uniqueCustomers).toBe(1);
    // Both staff rows individually credit this one customer (correct —
    // sum = 2), but the tenant-grain total must reflect ONE real
    // customer, proving totals is not derived by summing staff[].
    expect(data.totals.uniqueCustomers as number).toBe(1);
  });

  it("new customer: first-ever completed visit for this tenant falls inside the range", async () => {
    const staff1 = await eligibleStaff("Brand New Report Staff");
    const customer = await createCustomer(tenant.id, "Brand New Customer");
    const start = hoursFromNow(92);
    await createAppointment({ status: "completed", scheduledStartAt: start, customerId: customer.id, items: [{ serviceId: serviceA.id, staffMemberId: staff1 }] });
    const { data } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(93), staffIds: [staff1] });
    const row = (data.staff as { staffId: string; newCustomers: number; returningCustomers: number }[]).find((s) => s.staffId === staff1)!;
    expect(row.newCustomers).toBe(1);
    expect(row.returningCustomers).toBe(0);
  });

  it("returning customer: an earlier completed visit exists before the range", async () => {
    const staff1 = await eligibleStaff("Returning Report Staff");
    const customer = await createCustomer(tenant.id, "Returning Customer");
    await createAppointment({ status: "completed", scheduledStartAt: hoursFromNow(94), customerId: customer.id, items: [{ serviceId: serviceA.id, staffMemberId: staff1 }] });
    const rangeStart = hoursFromNow(95);
    await createAppointment({ status: "completed", scheduledStartAt: hoursFromNow(95.5), customerId: customer.id, items: [{ serviceId: serviceA.id, staffMemberId: staff1 }] });
    const { data } = await summaryAs(owner, { startAt: rangeStart, endAt: hoursFromNow(96), staffIds: [staff1] });
    const row = (data.staff as { staffId: string; newCustomers: number; returningCustomers: number }[]).find((s) => s.staffId === staff1)!;
    expect(row.newCustomers).toBe(0);
    expect(row.returningCustomers).toBe(1);
  });

  it("branch/staff/service filters do NOT redefine historical first-ever: a customer's true first visit was with a DIFFERENT staff (filtered out); reported filtered to the second staff only, they still show as RETURNING, never new", async () => {
    const firstStaff = await eligibleStaff("Filter Independence First Staff");
    const secondStaff = await eligibleStaff("Filter Independence Second Staff");
    const customer = await createCustomer(tenant.id, "Filter Independence Customer");
    await createAppointment({ status: "completed", scheduledStartAt: hoursFromNow(97), customerId: customer.id, items: [{ serviceId: serviceA.id, staffMemberId: firstStaff }] });
    const rangeStart = hoursFromNow(98);
    await createAppointment({ status: "completed", scheduledStartAt: hoursFromNow(98.5), customerId: customer.id, items: [{ serviceId: serviceB.id, staffMemberId: secondStaff }] });

    const { data } = await summaryAs(owner, { startAt: rangeStart, endAt: hoursFromNow(99), staffIds: [secondStaff] });
    const row = (data.staff as { staffId: string; newCustomers: number; returningCustomers: number }[]).find((s) => s.staffId === secondStaff)!;
    expect(row.returningCustomers).toBe(1);
    expect(row.newCustomers).toBe(0);
  });

  it("cancelled/no-show visits never establish completed-service 'served' history for new/returning purposes", async () => {
    const staff1 = await eligibleStaff("Cancelled Only Report Staff");
    const customer = await createCustomer(tenant.id, "Cancelled Only Customer");
    await createAppointment({ status: "cancelled", scheduledStartAt: hoursFromNow(100), customerId: customer.id, items: [{ serviceId: serviceA.id, staffMemberId: staff1 }] });
    const rangeStart = hoursFromNow(101);
    await createAppointment({ status: "completed", scheduledStartAt: hoursFromNow(101.5), customerId: customer.id, items: [{ serviceId: serviceA.id, staffMemberId: staff1 }] });
    const { data } = await summaryAs(owner, { startAt: rangeStart, endAt: hoursFromNow(102), staffIds: [staff1] });
    const row = (data.staff as { staffId: string; newCustomers: number; returningCustomers: number }[]).find((s) => s.staffId === staff1)!;
    // Their only COMPLETED visit is inside the range -> new, despite the earlier cancellation.
    expect(row.newCustomers).toBe(1);
    expect(row.returningCustomers).toBe(0);
  });
});

describe("cancellation & no-show: DISTINCT appointment counts, not item counts", () => {
  it("a multi-item cancelled appointment for ONE staff counts as ONE cancellation, not N", async () => {
    const staff1 = await eligibleStaff("Cancel Distinct Staff");
    const start = hoursFromNow(103);
    await createAppointment({
      status: "cancelled",
      scheduledStartAt: start,
      items: [
        { serviceId: serviceA.id, staffMemberId: staff1 },
        { serviceId: serviceB.id, staffMemberId: staff1 },
      ],
    });
    const { data } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(104), staffIds: [staff1] });
    const row = (data.staff as { staffId: string; cancelledAppointments: number }[]).find((s) => s.staffId === staff1)!;
    expect(row.cancelledAppointments).toBe(1);
  });

  it("a multi-item no_show appointment for ONE staff counts as ONE no-show, not N", async () => {
    const staff1 = await eligibleStaff("No Show Distinct Staff");
    const start = hoursFromNow(105);
    await createAppointment({
      status: "no_show",
      scheduledStartAt: start,
      items: [
        { serviceId: serviceA.id, staffMemberId: staff1 },
        { serviceId: serviceB.id, staffMemberId: staff1 },
      ],
    });
    const { data } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(106), staffIds: [staff1] });
    const row = (data.staff as { staffId: string; noShowAppointments: number }[]).find((s) => s.staffId === staff1)!;
    expect(row.noShowAppointments).toBe(1);
  });

  it("a multi-item cancelled appointment with DIFFERENT staff per item counts once for EACH involved staff, and once at the totals grain — proving totals is not a sum of staff rows", async () => {
    const staff1 = await eligibleStaff("Cancel Multi Staff 1");
    const staff2 = await eligibleStaff("Cancel Multi Staff 2");
    const start = hoursFromNow(107);
    await createAppointment({
      status: "cancelled",
      scheduledStartAt: start,
      items: [
        { serviceId: serviceA.id, staffMemberId: staff1 },
        { serviceId: serviceB.id, staffMemberId: staff2 },
      ],
    });
    const { data } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(108), staffIds: [staff1, staff2] });
    const row1 = (data.staff as { staffId: string; cancelledAppointments: number }[]).find((s) => s.staffId === staff1)!;
    const row2 = (data.staff as { staffId: string; cancelledAppointments: number }[]).find((s) => s.staffId === staff2)!;
    expect(row1.cancelledAppointments).toBe(1);
    expect(row2.cancelledAppointments).toBe(1);
    // sum(staff.cancelledAppointments) = 2, but this is ONE cancelled
    // appointment — totals must reflect that directly, not by summing.
    expect(data.totals.cancelledAppointments as number).toBe(1);
  });
});

describe("[start_at, end_at) boundary", () => {
  it("an item scheduled exactly AT start_at is INCLUDED; an item scheduled exactly AT end_at is EXCLUDED", async () => {
    const staffC = await eligibleStaff("Boundary Staff");
    const boundaryStart = hoursFromNow(110);
    const boundaryEnd = hoursFromNow(111);
    await createAppointment({ status: "completed", scheduledStartAt: boundaryStart, items: [{ serviceId: serviceA.id, staffMemberId: staffC }] });
    await createAppointment({ status: "completed", scheduledStartAt: boundaryEnd, items: [{ serviceId: serviceA.id, staffMemberId: staffC }] });

    const { data } = await summaryAs(owner, { startAt: boundaryStart, endAt: boundaryEnd, staffIds: [staffC] });
    const row = (data.staff as { staffId: string; completedServiceItems: number }[]).find((s) => s.staffId === staffC);
    expect(row!.completedServiceItems).toBe(1); // only the start-boundary item
  });
});

describe("filter NULL/empty semantics", () => {
  it("NULL p_staff_ids and an empty-array p_staff_ids both mean 'no filter' and produce identical results", async () => {
    const staff1 = await eligibleStaff("Null Empty Filter Staff");
    const start = hoursFromNow(112);
    await createAppointment({ status: "completed", scheduledStartAt: start, items: [{ serviceId: serviceA.id, staffMemberId: staff1 }] });
    const withNull = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(113), staffIds: null });
    const withEmpty = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(113), staffIds: [] });
    expect(withNull.data.totals).toEqual(withEmpty.data.totals);
  });
});

describe("input validation", () => {
  it("RP003: missing start_at or end_at is rejected", async () => {
    const client = await signInAs(owner);
    // Deliberately bypasses the generated type (p_start_at is typed as a
    // required string) to prove the RPC's own defensive validation still
    // rejects a null that reached it anyway — e.g. from unset client
    // state slipping past the TS layer. `rpc` is typed strictly enough
    // that only a plain `any` escape hatch expresses "malformed input a
    // real caller could still send" here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badArgs: any = { p_tenant_id: tenant.id, p_start_at: null, p_end_at: hoursFromNow(1).toISOString() };
    const { error } = await client.rpc("get_staff_performance_summary", badArgs);
    await client.auth.signOut();
    expect(error).not.toBeNull();
    expect(error!.code).toBe("RP003");
  });

  it("RP004: start_at >= end_at is rejected", async () => {
    const { error } = await summaryAs(owner, { startAt: hoursFromNow(1), endAt: hoursFromNow(-1) });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("RP004");
  });
});

describe("zero customer PII", () => {
  it("the RPC output never contains a real customer's name, and never contains PII-shaped keys", async () => {
    const staff1 = await eligibleStaff("PII Check Staff");
    const piiCustomer = await createCustomer(tenant.id, "Very Unique PII Name Zzqx");
    const start = hoursFromNow(115);
    await createAppointment({ status: "completed", scheduledStartAt: start, customerId: piiCustomer.id, items: [{ serviceId: serviceA.id, staffMemberId: staff1 }] });

    const { data } = await summaryAs(owner, { startAt: start, endAt: hoursFromNow(116), staffIds: [staff1] });
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("Very Unique PII Name Zzqx");
    expect(serialized.toLowerCase()).not.toContain("customerid");
    expect(serialized.toLowerCase()).not.toContain("customername");
    expect(serialized.toLowerCase()).not.toContain("phone");
    expect(serialized.toLowerCase()).not.toContain("email");
  });
});
