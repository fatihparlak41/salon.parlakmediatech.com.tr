import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  testDb,
  createTestUser,
  signInAs,
  createTestTenant,
  createTestMembershipFromTemplate,
  createBranch,
  createStaffMember,
  createService,
  linkStaffBranch,
  linkServiceBranch,
  linkStaffService,
  createStaffSchedule,
  createCustomer,
  cleanupTenants,
  cleanupUsers,
  safeMorningStart,
  type TestUser,
} from "./helpers";
import {
  getTodayAppointments,
  getMonthSummary,
  getActiveStaffRoster,
  getMyMembershipId,
  getStaffLinkByMembership,
  getMyFirstName,
  getMyTodayWorkingHours,
  computeTodayKpis,
  selectNextAppointment,
  type DashboardTodayAppointment,
} from "@/lib/modules/dashboard/queries";

// Faz DASHBOARD.1 — every dashboard query function takes an
// already-constructed Supabase client as its first argument (see
// lib/modules/dashboard/queries.ts's own header comment for why:
// createClient() -> next/headers's cookies() cannot run under plain
// Vitest, the same constraint tests/reports-staff-page.test.ts already
// documents for lib/modules/reports/queries.ts). Every test below
// signs in as a real fixture user via tests/helpers.ts's signInAs() and
// passes that real client straight into the SAME functions
// app/[locale]/app/[tenantSlug]/page.tsx calls — this proves the actual
// production code path (including RLS), not a hand-duplicated stand-in
// for it.
//
// Every fixture tenant below uses 'Europe/Istanbul' (fixed UTC+3, no
// DST) deliberately: it isolates the dashboard-specific behavior under
// test (tenant-local day boundaries, permission-based section
// visibility, cross-tenant isolation, staff filtering) from the
// separately-known, separately-tracked DST-boundary defect in
// tests/public-booking-flow.test.ts — not fixed and not touched here.

async function insertAppointment(args: {
  tenantId: string;
  branchId: string;
  customerId: string;
  start: Date;
  end: Date;
  status: string;
  createdBy: string;
}) {
  const [row] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, source, scheduled_start_at, scheduled_end_at, status, created_by)
    values (${args.tenantId}, ${args.branchId}, ${args.customerId}, 'internal', ${args.start.toISOString()}, ${args.end.toISOString()}, ${args.status}, ${args.createdBy})
    returning id
  `;
  return row!.id;
}

async function insertAppointmentItem(args: {
  tenantId: string;
  appointmentId: string;
  serviceId: string;
  staffMemberId: string;
  start: Date;
  end: Date;
}) {
  await testDb`
    insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
    values (${args.tenantId}, ${args.appointmentId}, ${args.serviceId}, ${args.staffMemberId}, ${args.start.toISOString()}, ${args.end.toISOString()}, 30, 100, 1)
  `;
}

/** Minimal fixture builder for selectNextAppointment's own unit tests
 * below — pure function, no DB, no signed-in client needed at all. Only
 * the fields selectNextAppointment actually reads (status,
 * scheduledStartAt) vary per call; the rest are stable filler. */
function fakeAppointment(id: string, status: string, scheduledStartAt: string): DashboardTodayAppointment {
  return {
    id,
    status,
    scheduledStartAt,
    scheduledEndAt: scheduledStartAt,
    customerName: id,
    serviceNames: [],
    staff: [],
  };
}

describe("Faz DASHBOARD.1A — selectNextAppointment (the exact selector TodaySchedule renders from)", () => {
  const NOW = "2026-09-15T07:00:00.000Z";
  const past = (offsetMin: number) => new Date(new Date(NOW).getTime() - offsetMin * 60000).toISOString();
  const future = (offsetMin: number) => new Date(new Date(NOW).getTime() + offsetMin * 60000).toISOString();

  it("the user's own regression fixture: 3 completed (one past, two future) + 1 confirmed future + 1 scheduled later -> next is the confirmed one, never a completed one", () => {
    const rows = [
      fakeAppointment("a-0900-completed", "completed", past(30)),
      fakeAppointment("a-0930-completed", "completed", future(30)),
      fakeAppointment("a-1030-completed", "completed", future(90)),
      fakeAppointment("a-1130-confirmed", "confirmed", future(150)),
      fakeAppointment("a-1200-scheduled", "scheduled", future(180)),
    ];
    const { next, inProgress } = selectNextAppointment(rows, NOW);
    expect(next?.id).toBe("a-1130-confirmed");
    expect(inProgress).toBeNull();
  });

  it("a completed appointment is NEVER next, even when its own scheduled_start_at is still in the future", () => {
    const rows = [fakeAppointment("completed-future", "completed", future(30))];
    expect(selectNextAppointment(rows, NOW).next).toBeNull();
  });

  it("a cancelled appointment is NEVER next, even when its own scheduled_start_at is still in the future", () => {
    const rows = [fakeAppointment("cancelled-future", "cancelled", future(30))];
    expect(selectNextAppointment(rows, NOW).next).toBeNull();
  });

  it("a no_show appointment is NEVER next, even when its own scheduled_start_at is still in the future", () => {
    const rows = [fakeAppointment("noshow-future", "no_show", future(30))];
    expect(selectNextAppointment(rows, NOW).next).toBeNull();
  });

  it("a confirmed appointment in the future is selected as next; a confirmed appointment already in the past is not", () => {
    const futureConfirmed = fakeAppointment("confirmed-future", "confirmed", future(15));
    expect(selectNextAppointment([futureConfirmed], NOW).next?.id).toBe("confirmed-future");

    const pastConfirmed = fakeAppointment("confirmed-past", "confirmed", past(15));
    expect(selectNextAppointment([pastConfirmed], NOW).next).toBeNull();
  });

  it("a scheduled appointment in the future is selected as next; picks the EARLIEST eligible one when several qualify", () => {
    const rows = [fakeAppointment("later", "scheduled", future(120)), fakeAppointment("sooner", "scheduled", future(30))];
    // selectNextAppointment itself does not sort — it trusts the caller
    // (getTodayAppointments) to hand it rows already ordered by
    // scheduled_start_at ascending, exactly as that function's own
    // `.order("scheduled_start_at", { ascending: true })` guarantees.
    expect(selectNextAppointment(rows, NOW).next?.id).toBe("later");
    const sortedRows = [...rows].sort((a, b) => a.scheduledStartAt.localeCompare(b.scheduledStartAt));
    expect(selectNextAppointment(sortedRows, NOW).next?.id).toBe("sooner");
  });

  it("in_progress is returned as its own result, distinct from next — never labeled as the upcoming one", () => {
    const rows = [fakeAppointment("underway", "in_progress", past(10)), fakeAppointment("later", "scheduled", future(60))];
    const { inProgress, next } = selectNextAppointment(rows, NOW);
    expect(inProgress?.id).toBe("underway");
    expect(next?.id).toBe("later");
  });

  it("in_progress with no other eligible upcoming appointment: inProgress is set, next is null", () => {
    const rows = [fakeAppointment("underway", "in_progress", past(10))];
    const { inProgress, next } = selectNextAppointment(rows, NOW);
    expect(inProgress?.id).toBe("underway");
    expect(next).toBeNull();
  });

  it("no eligible appointments at all -> both null, not an error", () => {
    const rows = [fakeAppointment("done", "completed", past(60)), fakeAppointment("gone", "cancelled", future(60))];
    expect(selectNextAppointment(rows, NOW)).toEqual({ inProgress: null, next: null });
  });

  it("empty input -> both null", () => {
    expect(selectNextAppointment([], NOW)).toEqual({ inProgress: null, next: null });
  });
});

describe("Faz DASHBOARD.1A — tenant-app shell has exactly one navigation presentation per breakpoint", () => {
  const shellSrc = readFileSync(new URL("../components/tenant-app/app-shell.tsx", import.meta.url), "utf8");

  it("the desktop sidebar and the mobile header use the SAME breakpoint token, so they are structurally complementary (never both hidden, never both shown)", () => {
    const asideMatch = shellSrc.match(/<aside className="([^"]*)"/);
    const headerMatch = shellSrc.match(/<header className="([^"]*)"/);
    expect(asideMatch, "expected exactly one <aside> in app-shell.tsx").not.toBeNull();
    expect(headerMatch, "expected exactly one <header> in app-shell.tsx").not.toBeNull();

    const asideClass = asideMatch![1]!;
    const headerClass = headerMatch![1]!;
    // The sidebar starts hidden and only becomes visible from a named
    // breakpoint up; the header is visible by default and only hides
    // from that SAME named breakpoint up — this is what makes them
    // mutually exclusive at every width, not merely "correct by
    // convention at 768px specifically."
    const asideBreakpointMatch = asideClass.match(/\bhidden\b.*?\b([a-z0-9]+):flex\b/);
    expect(asideBreakpointMatch, `expected "hidden ...<bp>:flex" on <aside>, got: ${asideClass}`).not.toBeNull();
    const breakpoint = asideBreakpointMatch![1];
    expect(headerClass).toContain(`${breakpoint}:hidden`);
  });

  it("exactly one UserMenu implementation exists, reused by both the desktop sidebar and the mobile drawer — not two separate hand-duplicated user-menu components", () => {
    const definitionCount = (shellSrc.match(/function UserMenu\(/g) ?? []).length;
    const usageCount = (shellSrc.match(/<UserMenu\b/g) ?? []).length;
    expect(definitionCount).toBe(1);
    // Used exactly twice — once for the always-in-DOM desktop <aside>,
    // once for the always-in-DOM (but display:none until opened)
    // mobile <Sheet> drawer. Two call sites of the SAME component is
    // not duplication; a second function definition would be.
    expect(usageCount).toBe(2);
  });

  it("exactly one tenant-name Badge implementation is used per shell branch (desktop aside, mobile drawer, mobile collapsed header) — confirmed live: the mobile header is display:none at >=768px (getComputedStyle), so only one is ever visually rendered at a time regardless of how many are mounted", () => {
    // This documents the finding from live DOM inspection (768x1024 and
    // 390x844): a second "tenant chip" node exists in the accessibility
    // tree only because the mobile header's own markup — and everything
    // inside it, badge included — stays mounted (not conditionally
    // rendered) so the Sheet drawer doesn't lose its open/close state on
    // resize. Its ANCESTOR <header> computes to display:none at >=768px,
    // so it contributes zero rendered pixels; a screenshot or a real
    // user never sees two chips. Not a bug to "fix" — see this phase's
    // final report for the exact getComputedStyle() evidence.
    const badgeCount = (shellSrc.match(/<Badge variant="secondary"/g) ?? []).length;
    expect(badgeCount).toBe(3);
  });
});

describe("Faz DASHBOARD.1 — today's appointments, KPIs, and per-staff counts", () => {
  let owner: TestUser;
  let stylistUser: TestUser;
  let tenant: { id: string; slug: string; ownerRoleId: string };
  let branchId: string;
  let serviceId: string;
  let staffA: { id: string };
  let staffB: { id: string };
  let staffC: { id: string };
  let stylistMembershipId: string;
  const TENANT_TZ = "Europe/Istanbul";

  beforeAll(async () => {
    owner = await createTestUser("dashboard-owner");
    stylistUser = await createTestUser("dashboard-stylist");
    tenant = await createTestTenant("dashboard-main", owner.id);
    await testDb`update tenants set timezone = ${TENANT_TZ} where id = ${tenant.id}`;

    branchId = await createBranch(tenant.id, "Main Branch");
    const service = await createService(tenant.id, "Haircut", 30, 100);
    serviceId = service.id;
    await linkServiceBranch(serviceId, branchId);

    staffA = await createStaffMember(tenant.id, "Staff A");
    staffB = await createStaffMember(tenant.id, "Staff B");
    staffC = await createStaffMember(tenant.id, "Staff C (no schedule)");
    for (const s of [staffA, staffB, staffC]) {
      await linkStaffBranch(s.id, branchId);
      await linkStaffService(s.id, serviceId);
    }
    // Full-week schedules for A and B only — C deliberately has none, for
    // getActiveStaffRoster's hasSchedule flag.
    for (const s of [staffA, staffB]) {
      for (let weekday = 0; weekday <= 6; weekday++) {
        await createStaffSchedule(tenant.id, s.id, weekday, "00:00", "23:59");
      }
    }

    await createTestMembershipFromTemplate(tenant.id, stylistUser.id, "STYLIST");
    stylistMembershipId = (
      await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${stylistUser.id}`
    )[0]!.id;
    await testDb`update staff_members set tenant_membership_id = ${stylistMembershipId} where id = ${staffA.id}`;

    const cust1 = await createCustomer(tenant.id, "Customer One");
    const cust2 = await createCustomer(tenant.id, "Customer Two");
    const cust3 = await createCustomer(tenant.id, "Customer Three");

    const base = safeMorningStart(0); // today, tenant-local 08:00 (Europe/Istanbul, fixed UTC+3)
    const bookings = [
      { offsetMin: 60, staff: staffA, cust: cust1, status: "completed" }, // 09:00
      { offsetMin: 150, staff: staffB, cust: cust2, status: "confirmed" }, // 10:30
      { offsetMin: 300, staff: staffA, cust: cust3, status: "scheduled" }, // 13:00
      { offsetMin: 420, staff: staffB, cust: cust1, status: "cancelled" }, // 15:00
    ];
    for (const b of bookings) {
      const start = new Date(base.getTime() + b.offsetMin * 60000);
      const end = new Date(start.getTime() + 30 * 60000);
      const apptId = await insertAppointment({
        tenantId: tenant.id,
        branchId,
        customerId: b.cust.id,
        start,
        end,
        status: b.status,
        createdBy: owner.id,
      });
      await insertAppointmentItem({ tenantId: tenant.id, appointmentId: apptId, serviceId, staffMemberId: b.staff.id, start, end });
    }
  });

  afterAll(async () => {
    await cleanupTenants([tenant.id]);
    await cleanupUsers([owner.id, stylistUser.id]);
  });

  it("returns exactly today's 4 appointments, in ascending order, with no phone/email/notes fields present", async () => {
    const client = await signInAs(owner);
    const rows = await getTodayAppointments(client, tenant.id, TENANT_TZ);
    await client.auth.signOut();

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.status)).toEqual(["completed", "confirmed", "scheduled", "cancelled"]);
    for (const r of rows) {
      expect(r).not.toHaveProperty("phone");
      expect(r).not.toHaveProperty("email");
      expect(r).not.toHaveProperty("notes");
    }
  });

  it("computeTodayKpis: total 4, pending (scheduled+confirmed+in_progress) 2, completed 1, cancelled/no_show 1", async () => {
    const client = await signInAs(owner);
    const rows = await getTodayAppointments(client, tenant.id, TENANT_TZ);
    await client.auth.signOut();

    expect(computeTodayKpis(rows)).toEqual({ total: 4, pending: 2, completed: 1, cancelledOrNoShow: 1 });
  });

  it("per-staff today counts: Staff A has 2, Staff B has 2, Staff C (no bookings) has 0", async () => {
    const client = await signInAs(owner);
    const rows = await getTodayAppointments(client, tenant.id, TENANT_TZ);
    await client.auth.signOut();

    const counts = new Map<string, number>();
    for (const r of rows) for (const s of r.staff) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
    expect(counts.get(staffA.id)).toBe(2);
    expect(counts.get(staffB.id)).toBe(2);
    expect(counts.get(staffC.id) ?? 0).toBe(0);
  });

  it("getActiveStaffRoster reports hasSchedule correctly (true for A/B, false for C)", async () => {
    const client = await signInAs(owner);
    const roster = await getActiveStaffRoster(client, tenant.id);
    await client.auth.signOut();

    const byId = new Map(roster.map((s) => [s.id, s]));
    expect(byId.get(staffA.id)?.hasSchedule).toBe(true);
    expect(byId.get(staffB.id)?.hasSchedule).toBe(true);
    expect(byId.get(staffC.id)?.hasSchedule).toBe(false);
  });

  it("staff personal filtering: the stylist's own membership resolves to Staff A, and filtering today's rows to that id yields exactly their 2 appointments", async () => {
    const stylistClient = await signInAs(stylistUser);
    const membershipId = await getMyMembershipId(stylistClient, tenant.id, stylistUser.id);
    expect(membershipId).toBe(stylistMembershipId);

    const link = await getStaffLinkByMembership(stylistClient, tenant.id, membershipId!);
    expect(link?.id).toBe(staffA.id);

    const rows = await getTodayAppointments(stylistClient, tenant.id, TENANT_TZ);
    await stylistClient.auth.signOut();

    const mine = rows.filter((r) => r.staff.some((s) => s.id === link!.id));
    expect(mine).toHaveLength(2);
    expect(mine.map((r) => r.customerName).sort()).toEqual(["Customer One", "Customer Three"]);
  });

  it("getStaffLinkByMembership returns null for a membership with no linked staff row", async () => {
    const client = await signInAs(owner);
    const link = await getStaffLinkByMembership(client, tenant.id, "00000000-0000-0000-0000-000000000000");
    await client.auth.signOut();
    expect(link).toBeNull();
  });

  it("getMyTodayWorkingHours returns the widest span for today's real weekday, and null for a staff member with no schedule at all", async () => {
    const client = await signInAs(owner);
    const todayWeekday = new Date().getUTCDay();
    const hours = await getMyTodayWorkingHours(client, staffA.id, todayWeekday);
    const none = await getMyTodayWorkingHours(client, staffC.id, todayWeekday);
    await client.auth.signOut();

    expect(hours).toEqual({ startTime: "00:00:00", endTime: "23:59:00" });
    expect(none).toBeNull();
  });

  it("getMyFirstName returns null for a user with no profiles.full_name set (this project never fabricates a placeholder name)", async () => {
    const client = await signInAs(owner);
    const name = await getMyFirstName(client, owner.id);
    await client.auth.signOut();
    expect(name).toBeNull();
  });
});

describe("Faz DASHBOARD.1 — tenant-local 'today' boundary (never the server/UTC calendar date)", () => {
  let owner: TestUser;
  let tenant: { id: string; slug: string; ownerRoleId: string };
  let branchId: string;
  let customerId: string;
  const TENANT_TZ = "Europe/Istanbul"; // fixed UTC+3, no DST — isolates this test from the separately-tracked DST defect.

  beforeAll(async () => {
    owner = await createTestUser("dashboard-tz-owner");
    tenant = await createTestTenant("dashboard-tz", owner.id);
    await testDb`update tenants set timezone = ${TENANT_TZ} where id = ${tenant.id}`;
    branchId = await createBranch(tenant.id, "Branch");
    const cust = await createCustomer(tenant.id, "Early Bird Customer");
    customerId = cust.id;

    // "Today" (Europe/Istanbul) at 00:30 local. Computed independently of
    // lib/modules/appointments/timezone.ts (the module under test here,
    // via getTodayAppointments) so this fixture can never be tautological
    // with the code it's meant to catch a regression in. At UTC+3, this
    // instant's own UTC calendar date is YESTERDAY (21:30 UTC) — exactly
    // the case a "used the server's UTC day instead of tenant-local day"
    // bug would get wrong.
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TENANT_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = Number(parts.find((p) => p.type === "year")!.value);
    const m = Number(parts.find((p) => p.type === "month")!.value);
    const d = Number(parts.find((p) => p.type === "day")!.value);
    const earlyLocalMorningUtc = new Date(Date.UTC(y, m - 1, d, 0, 30) - 3 * 3600_000);

    await insertAppointment({
      tenantId: tenant.id,
      branchId,
      customerId,
      start: earlyLocalMorningUtc,
      end: new Date(earlyLocalMorningUtc.getTime() + 30 * 60000),
      status: "scheduled",
      createdBy: owner.id,
    });
  });

  afterAll(async () => {
    await cleanupTenants([tenant.id]);
    await cleanupUsers([owner.id]);
  });

  it("includes an appointment at tenant-local 00:30 today, even though its UTC instant falls on the previous UTC calendar date", async () => {
    const client = await signInAs(owner);
    const rows = await getTodayAppointments(client, tenant.id, TENANT_TZ);
    await client.auth.signOut();
    expect(rows.map((r) => r.customerName)).toContain("Early Bird Customer");
  });
});

describe("Faz DASHBOARD.1 — cross-tenant isolation", () => {
  let ownerA: TestUser;
  let ownerB: TestUser;
  let tenantA: { id: string; slug: string; ownerRoleId: string };
  let tenantB: { id: string; slug: string; ownerRoleId: string };
  const TZ = "Europe/Istanbul";

  beforeAll(async () => {
    ownerA = await createTestUser("dashboard-crossa");
    ownerB = await createTestUser("dashboard-crossb");
    tenantA = await createTestTenant("dashboard-cross-a", ownerA.id);
    tenantB = await createTestTenant("dashboard-cross-b", ownerB.id);
    await testDb`update tenants set timezone = ${TZ} where id in ${testDb([tenantA.id, tenantB.id])}`;

    const branchA = await createBranch(tenantA.id, "Branch A");
    const branchB = await createBranch(tenantB.id, "Branch B");
    const custA = await createCustomer(tenantA.id, "Tenant A Customer");
    const custB = await createCustomer(tenantB.id, "Tenant B Customer");

    const start = safeMorningStart(0);
    await insertAppointment({ tenantId: tenantA.id, branchId: branchA, customerId: custA.id, start, end: new Date(start.getTime() + 1800000), status: "scheduled", createdBy: ownerA.id });
    await insertAppointment({ tenantId: tenantB.id, branchId: branchB, customerId: custB.id, start, end: new Date(start.getTime() + 1800000), status: "scheduled", createdBy: ownerB.id });
  });

  afterAll(async () => {
    await cleanupTenants([tenantA.id, tenantB.id]);
    await cleanupUsers([ownerA.id, ownerB.id]);
  });

  it("tenant A's today-appointments never include tenant B's data, and vice versa", async () => {
    const clientA = await signInAs(ownerA);
    const rowsA = await getTodayAppointments(clientA, tenantA.id, TZ);
    await clientA.auth.signOut();

    const clientB = await signInAs(ownerB);
    const rowsB = await getTodayAppointments(clientB, tenantB.id, TZ);
    await clientB.auth.signOut();

    expect(rowsA.map((r) => r.customerName)).toEqual(["Tenant A Customer"]);
    expect(rowsB.map((r) => r.customerName)).toEqual(["Tenant B Customer"]);
  });

  it("owner A's client cannot read tenant B's appointments even if asked to (RLS, not just the tenant_id filter, is the real boundary)", async () => {
    const clientA = await signInAs(ownerA);
    const rows = await getTodayAppointments(clientA, tenantB.id, TZ);
    await clientA.auth.signOut();
    expect(rows).toEqual([]);
  });
});

describe("Faz DASHBOARD.1 — empty states (a genuinely fresh tenant, zero activity)", () => {
  let owner: TestUser;
  let tenant: { id: string; slug: string; ownerRoleId: string };
  const TZ = "Europe/Istanbul";

  beforeAll(async () => {
    owner = await createTestUser("dashboard-empty");
    tenant = await createTestTenant("dashboard-empty", owner.id);
    await testDb`update tenants set timezone = ${TZ} where id = ${tenant.id}`;
  });

  afterAll(async () => {
    await cleanupTenants([tenant.id]);
    await cleanupUsers([owner.id]);
  });

  it("getTodayAppointments returns an empty array, never an error, for a tenant with zero appointments", async () => {
    const client = await signInAs(owner);
    const rows = await getTodayAppointments(client, tenant.id, TZ);
    await client.auth.signOut();
    expect(rows).toEqual([]);
  });

  it("getMonthSummary returns all zeros for a tenant with zero activity this month", async () => {
    const client = await signInAs(owner);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    const summary = await getMonthSummary(client, tenant.id, TZ, today);
    await client.auth.signOut();
    expect(summary).toEqual({ total: 0, completed: 0, cancelled: 0, newCustomers: 0 });
  });

  it("getActiveStaffRoster returns an empty array for a tenant with no staff", async () => {
    const client = await signInAs(owner);
    const roster = await getActiveStaffRoster(client, tenant.id);
    await client.auth.signOut();
    expect(roster).toEqual([]);
  });

  it("the online-booking status the booking card would show defaults to off for a fresh tenant (via the same has_feature RPC getOnlineBookingEnabled itself wraps)", async () => {
    const client = await signInAs(owner);
    const { data, error } = await client.rpc("has_feature", { p_tenant_id: tenant.id, p_feature_key: "online_booking" });
    await client.auth.signOut();
    expect(error).toBeNull();
    expect(data).toBe(false);
  });
});

describe("Faz DASHBOARD.1 — the real permission catalog decides section visibility, not an invented one", () => {
  let owner: TestUser;
  let managerUser: TestUser;
  let receptionistUser: TestUser;
  let stylistUser: TestUser;
  let tenant: { id: string; slug: string; ownerRoleId: string };

  beforeAll(async () => {
    owner = await createTestUser("dashboard-perm-owner");
    managerUser = await createTestUser("dashboard-perm-manager");
    receptionistUser = await createTestUser("dashboard-perm-receptionist");
    stylistUser = await createTestUser("dashboard-perm-stylist");
    tenant = await createTestTenant("dashboard-perm", owner.id);
    await createTestMembershipFromTemplate(tenant.id, managerUser.id, "SALON_MANAGER");
    await createTestMembershipFromTemplate(tenant.id, receptionistUser.id, "RECEPTIONIST");
    await createTestMembershipFromTemplate(tenant.id, stylistUser.id, "STYLIST");
  });

  afterAll(async () => {
    await cleanupTenants([tenant.id]);
    await cleanupUsers([owner.id, managerUser.id, receptionistUser.id, stylistUser.id]);
  });

  async function hasPermissionAs(user: TestUser, key: string): Promise<boolean> {
    const client = await signInAs(user);
    const { data, error } = await client.rpc("has_permission", { p_tenant_id: tenant.id, p_permission_key: key });
    await client.auth.signOut();
    if (error) throw error;
    return data === true;
  }

  it("staff.manage — the dashboard's 'salon-wide management' discriminator — is true only for owner/manager", async () => {
    expect(await hasPermissionAs(owner, "staff.manage")).toBe(true);
    expect(await hasPermissionAs(managerUser, "staff.manage")).toBe(true);
    expect(await hasPermissionAs(receptionistUser, "staff.manage")).toBe(false);
    expect(await hasPermissionAs(stylistUser, "staff.manage")).toBe(false);
  });

  it("reports.basic — gates the 'Bu Ay' section — is true for owner/manager/receptionist, false for stylist", async () => {
    // Confirmed against the real role_template_permissions seed
    // (20260815120006_create_role_templates.sql): RECEPTIONIST is
    // deliberately granted reports.basic. The dashboard must show "Bu
    // Ay" to a receptionist for this reason — not because "receptionist"
    // sounds unprivileged, and not by inventing a stricter rule this
    // phase's spec examples didn't anticipate.
    expect(await hasPermissionAs(owner, "reports.basic")).toBe(true);
    expect(await hasPermissionAs(managerUser, "reports.basic")).toBe(true);
    expect(await hasPermissionAs(receptionistUser, "reports.basic")).toBe(true);
    expect(await hasPermissionAs(stylistUser, "reports.basic")).toBe(false);
  });

  it("customers.create — gates the 'Müşteri Ekle' quick action — is true for owner/manager/receptionist, false for stylist", async () => {
    expect(await hasPermissionAs(owner, "customers.create")).toBe(true);
    expect(await hasPermissionAs(managerUser, "customers.create")).toBe(true);
    expect(await hasPermissionAs(receptionistUser, "customers.create")).toBe(true);
    expect(await hasPermissionAs(stylistUser, "customers.create")).toBe(false);
  });

  it("services.manage — gates the 'Hizmet Ekle' quick action — is true only for owner/manager", async () => {
    expect(await hasPermissionAs(owner, "services.manage")).toBe(true);
    expect(await hasPermissionAs(managerUser, "services.manage")).toBe(true);
    expect(await hasPermissionAs(receptionistUser, "services.manage")).toBe(false);
    expect(await hasPermissionAs(stylistUser, "services.manage")).toBe(false);
  });

  // Faz DASHBOARD.1A — this same permission set is what quickActions'
  // array-building logic in page.tsx still filters on after the
  // responsive reorder (the reorder only moved WHERE <QuickActions>
  // renders in the JSX tree via CSS order/grid-placement; the boolean
  // computation feeding it — hasPermission(tenantId, "appointments.create")
  // etc. — was not touched). appointments.create was the one action
  // permission not yet covered above.
  it("appointments.create — gates the 'Randevu Ekle' quick action — is true for owner/manager/receptionist, false for stylist", async () => {
    expect(await hasPermissionAs(owner, "appointments.create")).toBe(true);
    expect(await hasPermissionAs(managerUser, "appointments.create")).toBe(true);
    expect(await hasPermissionAs(receptionistUser, "appointments.create")).toBe(true);
    expect(await hasPermissionAs(stylistUser, "appointments.create")).toBe(false);
  });
});

describe("Faz DASHBOARD.1 — no write/mutation behavior in the dashboard's own data layer", () => {
  it("lib/modules/dashboard/queries.ts contains no insert/update/delete/upsert/rpc calls anywhere — plain reads only", () => {
    const src = readFileSync(new URL("../lib/modules/dashboard/queries.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.insert\s*\(/);
    expect(src).not.toMatch(/\.update\s*\(/);
    expect(src).not.toMatch(/\.delete\s*\(/);
    expect(src).not.toMatch(/\.upsert\s*\(/);
    expect(src).not.toMatch(/\.rpc\s*\(/);
  });
});
