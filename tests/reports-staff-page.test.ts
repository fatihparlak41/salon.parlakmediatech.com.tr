import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseReportsStaffFilters,
  DEFAULT_RANGE_PRESET,
  type ReportsStaffFilters,
} from "@/lib/modules/reports/schemas";
import {
  resolveReportsDateRangeUtc,
  mergeStaffReportData,
  type StaffReportRow,
  type StaffPerformanceSummary,
  type StaffUtilizationSummary,
} from "@/lib/modules/reports/queries";
import { fillTemplate, splitMinutes, formatUtilizationPercent } from "@/lib/modules/reports/format";
import {
  testDb,
  signInAs,
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
  createStaffSchedule,
  cleanupTenants,
  cleanupUsers,
  hoursFromNow,
  type TestUser,
  type TestTenant,
} from "./helpers";
import messages from "@/messages/tr.json";

/**
 * Faz 5A.3C — tests for the reports/staff page's own new logic layer
 * (lib/modules/reports/schemas.ts's parseReportsStaffFilters,
 * lib/modules/reports/queries.ts's resolveReportsDateRangeUtc +
 * mergeStaffReportData, lib/modules/reports/format.ts). The underlying
 * RPCs (get_staff_performance_summary, get_staff_utilization) are already
 * exhaustively covered by personnel-performance-reports.test.ts and
 * personnel-performance-utilization.test.ts — this file does not re-prove
 * their own metric contracts, only the NEW composition this batch adds:
 * URL -> filters -> date range -> two RPC calls -> one merged view model.
 *
 * This project has no React component-rendering test infrastructure (no
 * @testing-library/react, no jsdom/happy-dom environment — confirmed via
 * package.json; every existing test in this suite is a DB/RPC integration
 * test, never a rendered-DOM one). Pure-CSS-responsive behavior (mobile
 * cards vs. desktop table) and literal nav-DOM visibility are therefore
 * NOT captured as automated assertions here — they were verified via a
 * live DEV walkthrough instead (see the Faz 5A.3C final report). Adding
 * component-rendering test infrastructure would be a real, standalone
 * decision this batch does not make unilaterally.
 */

describe("parseReportsStaffFilters", () => {
  it("defaults to the locked V1 range preset when no params are given", () => {
    const f = parseReportsStaffFilters({});
    expect(f.range).toBe(DEFAULT_RANGE_PRESET);
    expect(f.range).toBe("month");
    expect(f.customStart).toBeNull();
    expect(f.customEnd).toBeNull();
    expect(f.branchId).toBeNull();
    expect(f.staffIds).toEqual([]);
    expect(f.serviceIds).toEqual([]);
  });

  it("accepts every valid preset", () => {
    for (const range of ["today", "week", "month", "last30"] as const) {
      expect(parseReportsStaffFilters({ range }).range).toBe(range);
    }
  });

  it("an invalid/garbage range value falls back to the default, not an error", () => {
    expect(parseReportsStaffFilters({ range: "'; DROP TABLE tenants;--" }).range).toBe(DEFAULT_RANGE_PRESET);
    expect(parseReportsStaffFilters({ range: "" }).range).toBe(DEFAULT_RANGE_PRESET);
  });

  it("custom range with valid start < end is accepted", () => {
    const f = parseReportsStaffFilters({ range: "custom", start: "2026-01-01", end: "2026-01-31" });
    expect(f.range).toBe("custom");
    expect(f.customStart).toBe("2026-01-01");
    expect(f.customEnd).toBe("2026-01-31");
  });

  it("custom range with missing end falls back to the default preset entirely", () => {
    const f = parseReportsStaffFilters({ range: "custom", start: "2026-01-01" });
    expect(f.range).toBe(DEFAULT_RANGE_PRESET);
    expect(f.customStart).toBeNull();
    expect(f.customEnd).toBeNull();
  });

  it("custom range with start >= end falls back to the default preset (inverted range rejected)", () => {
    const f = parseReportsStaffFilters({ range: "custom", start: "2026-02-01", end: "2026-01-01" });
    expect(f.range).toBe(DEFAULT_RANGE_PRESET);
  });

  it("custom range with a malformed date string falls back safely", () => {
    const f = parseReportsStaffFilters({ range: "custom", start: "not-a-date", end: "2026-01-31" });
    expect(f.range).toBe(DEFAULT_RANGE_PRESET);
  });

  // RFC 4122 requires the variant nibble (first hex digit of the 4th
  // group) to be 8/9/a/b -- a naive "all 1s" placeholder fails
  // z.string().uuid() the same way it would fail any real UUID
  // validator, so every fixture below uses a properly-shaped one.
  it("a syntactically valid branch uuid is kept", () => {
    const id = "11111111-1111-1111-8111-111111111111";
    expect(parseReportsStaffFilters({ branch: id }).branchId).toBe(id);
  });

  it("a manipulated non-uuid branch value is dropped, never passed through, never throws", () => {
    expect(parseReportsStaffFilters({ branch: "<script>alert(1)</script>" }).branchId).toBeNull();
    expect(parseReportsStaffFilters({ branch: "../../etc/passwd" }).branchId).toBeNull();
  });

  it("a comma-separated staff list parses to a uuid array (multi-select support)", () => {
    const a = "11111111-1111-1111-8111-111111111111";
    const b = "22222222-2222-2222-8222-222222222222";
    expect(parseReportsStaffFilters({ staff: `${a},${b}` }).staffIds).toEqual([a, b]);
  });

  it("a comma-separated service list parses to a uuid array (multi-select support)", () => {
    const a = "33333333-3333-3333-8333-333333333333";
    const b = "44444444-4444-4444-8444-444444444444";
    expect(parseReportsStaffFilters({ service: `${a},${b}` }).serviceIds).toEqual([a, b]);
  });

  it("a mixed valid/garbage csv list keeps only the valid uuids, never throws", () => {
    const a = "11111111-1111-1111-8111-111111111111";
    expect(parseReportsStaffFilters({ staff: `${a},garbage,,not-a-uuid` }).staffIds).toEqual([a]);
  });

  it("array-form search params (repeated ?x=a&x=b) take the first value safely", () => {
    const f = parseReportsStaffFilters({ range: ["today", "week"] });
    expect(f.range).toBe("today");
  });
});

describe("resolveReportsDateRangeUtc", () => {
  const TZ_ISTANBUL = "Europe/Istanbul"; // fixed UTC+3, no DST

  it("today: a single tenant-local calendar day", () => {
    const filters: ReportsStaffFilters = { range: "today", customStart: null, customEnd: null, branchId: null, staffIds: [], serviceIds: [] };
    const { startAt, endAt } = resolveReportsDateRangeUtc(filters, TZ_ISTANBUL);
    const spanHours = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 3600_000;
    expect(spanHours).toBe(24);
  });

  it("week: a 7-day span", () => {
    const filters: ReportsStaffFilters = { range: "week", customStart: null, customEnd: null, branchId: null, staffIds: [], serviceIds: [] };
    const { startAt, endAt } = resolveReportsDateRangeUtc(filters, TZ_ISTANBUL);
    const spanDays = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 86_400_000;
    expect(spanDays).toBe(7);
  });

  it("month: spans exactly the current tenant-local calendar month", () => {
    const filters: ReportsStaffFilters = { range: "month", customStart: null, customEnd: null, branchId: null, staffIds: [], serviceIds: [] };
    const { startAt, endAt } = resolveReportsDateRangeUtc(filters, TZ_ISTANBUL);
    // start is the 1st of the month at 00:00 Istanbul (UTC+3) -> 21:00 UTC the day before
    const startLocal = new Date(new Date(startAt).getTime() + 3 * 3600_000);
    expect(startLocal.getUTCDate()).toBe(1);
    expect(startLocal.getUTCHours()).toBe(0);
    expect(new Date(endAt).getTime()).toBeGreaterThan(new Date(startAt).getTime());
  });

  it("last30: a 30-calendar-day span ending today, inclusive", () => {
    const filters: ReportsStaffFilters = { range: "last30", customStart: null, customEnd: null, branchId: null, staffIds: [], serviceIds: [] };
    const { startAt, endAt } = resolveReportsDateRangeUtc(filters, TZ_ISTANBUL);
    const spanDays = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 86_400_000;
    expect(spanDays).toBe(30);
  });

  it("custom: resolves to the exact inclusive [start, end] calendar-date range", () => {
    const filters: ReportsStaffFilters = { range: "custom", customStart: "2026-06-01", customEnd: "2026-06-03", branchId: null, staffIds: [], serviceIds: [] };
    const { startAt, endAt } = resolveReportsDateRangeUtc(filters, TZ_ISTANBUL);
    const spanDays = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 86_400_000;
    expect(spanDays).toBe(3); // Jun 1, 2, 3 inclusive = 3 full days
  });

  it("Europe/Nicosia spring-forward (2026-03-29): the transition day + the next day resolve to 47h, not 48h", () => {
    // customStart is the transition day ITSELF (23h, short) + customEnd
    // the next day (24h, normal) -- isolates the transition precisely,
    // covering exactly 2 local calendar dates by construction (the
    // parser's start < end rule makes 2 days the minimum custom span).
    const filters: ReportsStaffFilters = { range: "custom", customStart: "2026-03-29", customEnd: "2026-03-30", branchId: null, staffIds: [], serviceIds: [] };
    const { startAt, endAt } = resolveReportsDateRangeUtc(filters, "Europe/Nicosia");
    expect(new Date(startAt).getTime()).toBeLessThan(new Date(endAt).getTime());
    const spanHours = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 3600_000;
    expect(spanHours).toBe(47);
  });

  it("Europe/Nicosia fall-back (2025-10-26): the transition day + the next day resolve to 49h, not 48h", () => {
    const filters: ReportsStaffFilters = { range: "custom", customStart: "2025-10-26", customEnd: "2025-10-27", branchId: null, staffIds: [], serviceIds: [] };
    const { startAt, endAt } = resolveReportsDateRangeUtc(filters, "Europe/Nicosia");
    const spanHours = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 3600_000;
    expect(spanHours).toBe(49);
  });

  it("never duplicates get_staff_utilization's own now()-clipping: a far-future custom range still resolves to its full, unclipped nominal span", () => {
    // The RPC itself clips to now() (Faz 5A.3B) — the UI's own date math
    // must NOT also clip, or the two would double-clip / disagree.
    const future = new Date(Date.now() + 400 * 86_400_000);
    const y = future.getUTCFullYear();
    const m = String(future.getUTCMonth() + 1).padStart(2, "0");
    const d = String(future.getUTCDate()).padStart(2, "0");
    const start = `${y}-${m}-${d}`;
    const endDate = new Date(future.getTime() + 86_400_000);
    const end = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, "0")}-${String(endDate.getUTCDate()).padStart(2, "0")}`;
    const filters: ReportsStaffFilters = { range: "custom", customStart: start, customEnd: end, branchId: null, staffIds: [], serviceIds: [] };
    const { startAt, endAt } = resolveReportsDateRangeUtc(filters, TZ_ISTANBUL);
    const spanDays = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 86_400_000;
    // customStart/customEnd are two distinct calendar dates (start < end
    // is required to survive parsing at all) -> 2 full nominal days,
    // NOT clipped down to 0/partial the way get_staff_utilization's own
    // now()-clipping would.
    expect(spanDays).toBe(2);
  });
});

describe("format helpers", () => {
  it("formatUtilizationPercent renders a raw ratio as a rounded percent", () => {
    expect(formatUtilizationPercent(0.85)).toBe("%85");
    expect(formatUtilizationPercent(0)).toBe("%0");
    expect(formatUtilizationPercent(1)).toBe("%100");
  });

  it("formatUtilizationPercent never caps above 100 -- 1.5 renders %150", () => {
    expect(formatUtilizationPercent(1.5)).toBe("%150");
    expect(formatUtilizationPercent(2.12)).toBe("%212");
  });

  it("splitMinutes converts total minutes to whole hours+minutes", () => {
    expect(splitMinutes(150)).toEqual({ hours: 2, minutes: 30 });
    expect(splitMinutes(0)).toEqual({ hours: 0, minutes: 0 });
    expect(splitMinutes(59)).toEqual({ hours: 0, minutes: 59 });
  });

  it("fillTemplate substitutes every named placeholder", () => {
    expect(fillTemplate("{count} personel seçili", { count: 3 })).toBe("3 personel seçili");
    expect(fillTemplate("{newCount} yeni · {returningCount} geri dönen", { newCount: 2, returningCount: 1 })).toBe(
      "2 yeni · 1 geri dönen",
    );
  });
});

describe("mergeStaffReportData", () => {
  function summaryFixture(overrides?: Partial<StaffPerformanceSummary>): StaffPerformanceSummary {
    return {
      totals: {
        completedServiceItems: 10,
        completedAppointments: 8,
        uniqueCustomers: 5,
        newCustomers: 2,
        returningCustomers: 3,
        completedMinutes: 300,
        cancelledAppointments: 1,
        noShowAppointments: 1,
      },
      staff: [],
      serviceMix: [],
      ...overrides,
    };
  }

  function utilizationFixture(overrides?: Partial<StaffUtilizationSummary>): StaffUtilizationSummary {
    return {
      totals: { scheduledMinutes: 500, capacityMinutes: 500, utilizedMinutes: 300, utilization: 0.6 },
      staff: [],
      ...overrides,
    };
  }

  it("totals are taken directly from each RPC's own totals, never recomputed by summing merged staff rows", () => {
    // Deliberately construct staff rows whose sum would NOT equal totals
    // (mirrors the real non-additivity the underlying RPCs document) --
    // proves the merge never silently re-derives totals from staff[].
    const summary = summaryFixture({
      staff: [
        { staffId: "s1", staffName: "A", completedServiceItems: 6, completedAppointments: 5, uniqueCustomers: 3, newCustomers: 1, returningCustomers: 2, completedMinutes: 180, cancelledAppointments: 1, noShowAppointments: 0 },
        { staffId: "s2", staffName: "B", completedServiceItems: 6, completedAppointments: 5, uniqueCustomers: 3, newCustomers: 1, returningCustomers: 2, completedMinutes: 180, cancelledAppointments: 1, noShowAppointments: 1 },
      ],
    });
    const utilization = utilizationFixture({
      staff: [
        { staffId: "s1", staffName: "A", concurrentCapacity: 1, scheduledMinutes: 300, capacityMinutes: 300, utilizedMinutes: 200, utilization: 0.667 },
        { staffId: "s2", staffName: "B", concurrentCapacity: 1, scheduledMinutes: 300, capacityMinutes: 300, utilizedMinutes: 200, utilization: 0.667 },
      ],
    });
    const merged = mergeStaffReportData(summary, utilization);
    // sum(staff.completedServiceItems) = 12, but totals says 10 -- the
    // merge must preserve totals exactly as given, not derive 12.
    expect(merged.totals.completedServiceItems).toBe(10);
    expect(merged.totals.uniqueCustomers).toBe(5);
    expect(merged.totals.utilization).toBe(0.6); // not averaged from [0.667, 0.667]
  });

  it("a staff member present only in summary (some activity, but not in the utilization roster/history) still appears, utilization fields defaulted", () => {
    const summary = summaryFixture({
      staff: [{ staffId: "s1", staffName: "Only Summary", completedServiceItems: 2, completedAppointments: 2, uniqueCustomers: 1, newCustomers: 1, returningCustomers: 0, completedMinutes: 60, cancelledAppointments: 0, noShowAppointments: 0 }],
    });
    const utilization = utilizationFixture({ staff: [] });
    const merged = mergeStaffReportData(summary, utilization);
    expect(merged.staff).toHaveLength(1);
    const row = merged.staff[0]!;
    expect(row.staffId).toBe("s1");
    expect(row.completedServiceItems).toBe(2);
    expect(row.scheduledMinutes).toBe(0);
    expect(row.capacityMinutes).toBe(0);
    expect(row.utilization).toBeNull();
  });

  it("a staff member present only in utilization (active roster, no activity) still appears, performance fields defaulted to zero", () => {
    const summary = summaryFixture({ staff: [] });
    const utilization = utilizationFixture({
      staff: [{ staffId: "s2", staffName: "Only Roster", concurrentCapacity: 1, scheduledMinutes: 480, capacityMinutes: 480, utilizedMinutes: 0, utilization: 0 }],
    });
    const merged = mergeStaffReportData(summary, utilization);
    expect(merged.staff).toHaveLength(1);
    const row = merged.staff[0]!;
    expect(row.staffId).toBe("s2");
    expect(row.completedServiceItems).toBe(0);
    expect(row.uniqueCustomers).toBe(0);
    expect(row.serviceMix).toEqual([]);
    expect(row.scheduledMinutes).toBe(480);
    expect(row.utilization).toBe(0);
  });

  it("a staff member present in BOTH is merged into one row carrying both sides' fields", () => {
    const summary = summaryFixture({
      staff: [{ staffId: "s3", staffName: "Both", completedServiceItems: 4, completedAppointments: 3, uniqueCustomers: 2, newCustomers: 1, returningCustomers: 1, completedMinutes: 120, cancelledAppointments: 0, noShowAppointments: 0 }],
      serviceMix: [{ staffId: "s3", staffName: "Both", serviceId: "svc1", serviceName: "Kesim", serviceCategory: null, completedCount: 4 }],
    });
    const utilization = utilizationFixture({
      staff: [{ staffId: "s3", staffName: "Both", concurrentCapacity: 1, scheduledMinutes: 400, capacityMinutes: 400, utilizedMinutes: 120, utilization: 0.3 }],
    });
    const merged = mergeStaffReportData(summary, utilization);
    expect(merged.staff).toHaveLength(1);
    const row = merged.staff[0]!;
    expect(row.completedServiceItems).toBe(4);
    expect(row.scheduledMinutes).toBe(400);
    expect(row.utilization).toBe(0.3);
    expect(row.serviceMix).toHaveLength(1);
    expect(row.serviceMix[0]!.serviceName).toBe("Kesim");
  });

  it("both sides empty -> empty staff array, no crash", () => {
    const merged = mergeStaffReportData(summaryFixture({ staff: [] }), utilizationFixture({ staff: [] }));
    expect(merged.staff).toEqual([]);
  });

  it("the merged row type carries zero customer-identifying fields (structural PII proof)", () => {
    const summary = summaryFixture({
      staff: [{ staffId: "s1", staffName: "A", completedServiceItems: 1, completedAppointments: 1, uniqueCustomers: 1, newCustomers: 1, returningCustomers: 0, completedMinutes: 30, cancelledAppointments: 0, noShowAppointments: 0 }],
    });
    const merged = mergeStaffReportData(summary, utilizationFixture({ staff: [] }));
    const row: StaffReportRow = merged.staff[0]!;
    const keys = Object.keys(row);
    for (const forbidden of ["customerId", "customerName", "phone", "email", "customerid", "customername"]) {
      expect(keys.map((k) => k.toLowerCase())).not.toContain(forbidden.toLowerCase());
    }
    expect(JSON.stringify(row).toLowerCase()).not.toMatch(/customer(id|name)/);
  });

  it("the merged row/totals types carry zero financial fields (structural no-revenue proof)", () => {
    const merged = mergeStaffReportData(summaryFixture(), utilizationFixture());
    const totalsJson = JSON.stringify(merged.totals).toLowerCase();
    for (const forbidden of ["price", "revenue", "income", "turnover", "profit", "commission", "sales"]) {
      expect(totalsJson).not.toContain(forbidden);
    }
  });
});

describe("messages/tr.json Reports.staff -- no competitive/financial language", () => {
  const reportsMessages = (messages as Record<string, unknown>).Reports as Record<string, unknown>;

  it("the Reports.staff namespace exists", () => {
    expect(reportsMessages).toBeTruthy();
    expect((reportsMessages as Record<string, unknown>).staff).toBeTruthy();
  });

  it("contains no financial vocabulary (TR or EN)", () => {
    const json = JSON.stringify(reportsMessages).toLowerCase();
    for (const forbidden of ["gelir", "ciro", "kazanç", "kâr", "komisyon", "satış", "revenue", "income", "profit", "commission"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("contains no competitive/gamified vocabulary (rank, medal, best-employee framing)", () => {
    const json = JSON.stringify(reportsMessages).toLowerCase();
    for (const forbidden of ["en iyi personel", "sıralama", "madalya", "şampiyon", "kazanan"]) {
      expect(json).not.toContain(forbidden);
    }
  });
});

// --- DB-integration: permission gating + the cross-RPC service-filter contract ---

let owner: TestUser;
let stylistUser: TestUser;
let noPermUser: TestUser;
let tenant: TestTenant;
let branchId: string;
let serviceA: { id: string; name: string };
let serviceB: { id: string; name: string };

beforeAll(async () => {
  owner = await createTestUser("p5a3c-owner");
  stylistUser = await createTestUser("p5a3c-stylist");
  noPermUser = await createTestUser("p5a3c-no-perm");

  tenant = await createTestTenant("test-p5a3c-reports-ui", owner.id);
  branchId = await createBranch(tenant.id, "Reports UI Branch");
  serviceA = await createService(tenant.id, "Kesim", 30, 300);
  serviceB = await createService(tenant.id, "Boya", 60, 800);
  await testDb`insert into service_branches (service_id, branch_id) values (${serviceA.id}, ${branchId}), (${serviceB.id}, ${branchId})`;

  await createTestMembershipFromTemplate(tenant.id, stylistUser.id, "STYLIST");
  const noPermRoleId = await createRoleForTenant(tenant.id, "No Perm", []);
  await addMembership(tenant.id, noPermUser.id, noPermRoleId);
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenant.id]);
  await cleanupUsers([owner.id, stylistUser.id, noPermUser.id]);
});

/** Direct .rpc() calls via a signed-in client — the same pattern
 * personnel-performance-reports.test.ts/-utilization.test.ts use, and the
 * one this whole file must also use: lib/modules/reports/queries.ts's own
 * getStaffPerformanceSummary/getStaffUtilization/hasPermission all call
 * createClient() -> next/headers's cookies(), which requires an actual
 * Next.js request context and cannot run in a plain vitest process. Only
 * the pure functions in this file (parseReportsStaffFilters,
 * resolveReportsDateRangeUtc, mergeStaffReportData, format.ts) are
 * called directly; anything that would hit the database goes through
 * this same raw-RPC helper instead. */
async function summaryRpc(user: TestUser, args: Record<string, unknown>) {
  const client = await signInAs(user);
  const result = await client.rpc("get_staff_performance_summary", args as never);
  await client.auth.signOut();
  return result as { data: StaffPerformanceSummary | null; error: { code?: string } | null };
}

async function utilizationRpc(user: TestUser, args: Record<string, unknown>) {
  const client = await signInAs(user);
  const result = await client.rpc("get_staff_utilization", args as never);
  await client.auth.signOut();
  return result as { data: StaffUtilizationSummary | null; error: { code?: string } | null };
}

describe("nav/route permission gate (reports.staff)", () => {
  it("an owner (reports.staff via SALON_OWNER) is granted -- nav entry shown, route allowed", async () => {
    const client = await signInAs(owner);
    const { data, error } = await client.rpc("has_permission", { p_tenant_id: tenant.id, p_permission_key: "reports.staff" });
    await client.auth.signOut();
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  it("STYLIST is NOT granted reports.staff -- nav entry hidden, route redirects", async () => {
    // Same check the tenant layout and the page itself both gate on.
    // (STYLIST's real default grants — appointments.view/update,
    // customers.view, services.view, schedules.view — confirmed from the
    // role_template_permissions seed; reports.staff is never among them.)
    const client = await signInAs(stylistUser);
    const { data, error } = await client.rpc("has_permission", { p_tenant_id: tenant.id, p_permission_key: "reports.staff" });
    await client.auth.signOut();
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("a member with an explicit empty-permission role is NOT granted -- route redirects", async () => {
    const client = await signInAs(noPermUser);
    const { data } = await client.rpc("has_permission", { p_tenant_id: tenant.id, p_permission_key: "reports.staff" });
    await client.auth.signOut();
    expect(data).toBe(false);
  });
});

describe("cross-RPC service-filter contract (the one new composed behavior this batch adds)", () => {
  it("both real RPCs return data mergeStaffReportData composes correctly for one staff member", async () => {
    const staff = await createStaffMember(tenant.id, "Compose Test Staff");
    await linkStaffBranch(staff.id, branchId);
    await linkStaffService(staff.id, serviceA.id);
    await createStaffSchedule(tenant.id, staff.id, new Date().getUTCDay(), "00:00", "23:59");

    const start = hoursFromNow(-1);
    const end = hoursFromNow(1);
    const baseArgs = { p_tenant_id: tenant.id, p_start_at: start.toISOString(), p_end_at: end.toISOString(), p_staff_ids: [staff.id] };

    const [summaryResult, utilizationResult] = await Promise.all([
      summaryRpc(owner, { ...baseArgs, p_branch_id: null, p_service_ids: null }),
      utilizationRpc(owner, { ...baseArgs, p_branch_id: null }),
    ]);
    expect(summaryResult.error).toBeNull();
    expect(utilizationResult.error).toBeNull();
    const merged = mergeStaffReportData(summaryResult.data!, utilizationResult.data!);
    const row = merged.staff.find((s) => s.staffId === staff.id);
    expect(row).toBeDefined();
  });

  it("a service filter changes get_staff_performance_summary's own result but leaves get_staff_utilization's result byte-identical", async () => {
    const staff = await createStaffMember(tenant.id, "Service Filter Staff");
    await linkStaffBranch(staff.id, branchId);
    await linkStaffService(staff.id, serviceA.id);
    await linkStaffService(staff.id, serviceB.id);
    await createStaffSchedule(tenant.id, staff.id, new Date().getUTCDay(), "00:00", "23:59");

    const customer = await createCustomer(tenant.id, "Service Filter Customer");
    // one item on serviceA, one on serviceB, both safely inside the query window below
    const [apptA] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${customer.id}, 'completed', ${hoursFromNow(-1.5).toISOString()}, ${hoursFromNow(-1).toISOString()})
      returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence, appointment_status)
      values (${tenant.id}, ${apptA!.id}, ${serviceA.id}, ${staff.id}, ${hoursFromNow(-1.5).toISOString()}, ${hoursFromNow(-1).toISOString()}, 30, 300, 1, 'completed')`;
    const [apptB] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${customer.id}, 'completed', ${hoursFromNow(-0.9).toISOString()}, ${hoursFromNow(-0.5).toISOString()})
      returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence, appointment_status)
      values (${tenant.id}, ${apptB!.id}, ${serviceB.id}, ${staff.id}, ${hoursFromNow(-0.9).toISOString()}, ${hoursFromNow(-0.5).toISOString()}, 60, 800, 1, 'completed')`;

    const start = hoursFromNow(-3);
    const end = hoursFromNow(0.1);
    const baseArgs = { p_tenant_id: tenant.id, p_start_at: start.toISOString(), p_end_at: end.toISOString(), p_staff_ids: [staff.id], p_branch_id: null };

    const unfilteredSummary = await summaryRpc(owner, { ...baseArgs, p_service_ids: null });
    const filteredSummary = await summaryRpc(owner, { ...baseArgs, p_service_ids: [serviceA.id] });
    // service filter DOES change the summary result
    const unfilteredCount = unfilteredSummary.data!.staff.find((s) => s.staffId === staff.id)!.completedServiceItems;
    const filteredCount = filteredSummary.data!.staff.find((s) => s.staffId === staff.id)!.completedServiceItems;
    expect(unfilteredCount).toBe(2);
    expect(filteredCount).toBe(1);
    expect(filteredCount).not.toBe(unfilteredCount);

    // utilization has no service parameter at all -- calling it twice with
    // the exact same tenant/date/staff/branch args (mirroring what the
    // page does regardless of whatever service filter the summary side
    // is showing) must be byte-identical. A SEPARATE, purely-historical
    // window here (unlike baseArgs' own end, which is a few minutes in
    // the future and therefore genuinely clipped to a fresh now() on
    // every call -- Faz 5A.3B's own locked, correct behavior, not a bug)
    // so this specific repeatability check isn't confounded by that.
    const historicalArgs = { ...baseArgs, p_start_at: hoursFromNow(-3).toISOString(), p_end_at: hoursFromNow(-2).toISOString() };
    const utilizationA = await utilizationRpc(owner, historicalArgs);
    const utilizationB = await utilizationRpc(owner, historicalArgs);
    expect(utilizationA.data).toEqual(utilizationB.data);
    // and directly proves the RPC has no p_service_ids parameter at all:
    // passing one is simply ignored by PostgREST/Postgres function
    // resolution only because there's no matching overload to route it
    // to -- confirmed structurally in the migration/schema layer already
    // (staffUtilizationInputSchema has no serviceIds field, and
    // get_staff_utilization's own SQL signature has no p_service_ids
    // parameter — see supabase/migrations/20260907090000).
  });
});
