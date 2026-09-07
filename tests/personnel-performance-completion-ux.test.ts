import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  signInAs,
  createTestTenant,
  createTestUser,
  createBranch,
  createService,
  createStaffMember,
  linkStaffBranch,
  linkStaffService,
  cleanupTenants,
  cleanupUsers,
  hoursFromNow,
  type TestUser,
  type TestTenant,
} from "./helpers";
import { APPOINTMENT_ERROR_MESSAGES } from "@/lib/modules/appointments/error-codes";

/**
 * Faz 5A.2 — covers the parts of the completion UX that aren't already
 * exercised by tests/personnel-performance-foundation.test.ts's RPC-level
 * suite: the solo-salon detection condition, the performer-candidate
 * rule the completion panel's dropdown relies on, the inactive-booked-
 * staff-at-completion edge case (Phase 5A.2 brief section 8 — tested and
 * reported, not guessed), and the data shape the completed-appointment
 * display (booked vs actual attribution) depends on. No component-
 * rendering harness exists in this project — the client-side query
 * shapes are mirrored here exactly (same convention
 * tests/calendar-flow.test.ts already uses for its own client-query
 * mirror) and exercised via real signed-in sessions; the actual rendered
 * UI is verified separately via live DEV browser E2E (see the Faz 5A.2
 * report).
 */

let owner: TestUser;
let tenant: TestTenant;
let branchId: string;
let serviceId: string;
let otherTenant: TestTenant;
let otherOwner: TestUser;

async function eligibleStaff(fullName: string, opts?: { branchId?: string; serviceId?: string }): Promise<string> {
  const staff = await createStaffMember(tenant.id, fullName);
  await linkStaffBranch(staff.id, opts?.branchId ?? branchId);
  await linkStaffService(staff.id, opts?.serviceId ?? serviceId);
  return staff.id;
}

async function createAppointmentWithItem(staffMemberId: string, status = "confirmed"): Promise<{ appointmentId: string; itemId: string }> {
  const [customer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'Completion UX Customer') returning id`;
  const start = hoursFromNow(24);
  const end = new Date(start.getTime() + 30 * 60_000);
  const [appt] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
    values (${tenant.id}, ${branchId}, ${customer!.id}, ${status}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
    returning id`;
  const [item] = await testDb<{ id: string }[]>`
    insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
    values (${tenant.id}, ${appt!.id}, ${serviceId}, ${staffMemberId}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, 30, 200, 1)
    returning id`;
  return { appointmentId: appt!.id, itemId: item!.id };
}

/** Mirrors client-queries.ts's fetchActiveStaffCount exactly, via a real
 * signed-in session — the actual browser code calls this same filter
 * shape through the same RLS, so exercising it this way proves the real
 * condition, not just the SQL in isolation. */
async function activeStaffCountAs(user: TestUser, tenantId: string): Promise<number> {
  const client = await signInAs(user);
  const { count } = await client
    .from("staff_members")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .is("deleted_at", null);
  await client.auth.signOut();
  return count ?? 0;
}

/** Mirrors client-queries.ts's fetchEligibleStaff exactly. */
async function eligibleStaffAs(user: TestUser, serviceIdArg: string, branchIdArg: string): Promise<{ id: string; fullName: string }[]> {
  const client = await signInAs(user);
  const [eligibleRes, branchRes] = await Promise.all([
    client.from("staff_services").select("staff_member_id").eq("service_id", serviceIdArg),
    client.from("staff_branches").select("staff_member_id").eq("branch_id", branchIdArg),
  ]);
  const eligibleIds = new Set((eligibleRes.data ?? []).map((r) => r.staff_member_id));
  const branchIds = new Set((branchRes.data ?? []).map((r) => r.staff_member_id));
  const candidateIds = [...eligibleIds].filter((id) => branchIds.has(id));
  await client.auth.signOut();
  if (candidateIds.length === 0) return [];
  const client2 = await signInAs(user);
  const { data } = await client2.from("staff_members").select("id, full_name").eq("status", "active").is("deleted_at", null).in("id", candidateIds);
  await client2.auth.signOut();
  return (data ?? []).map((s) => ({ id: s.id, fullName: s.full_name }));
}

beforeAll(async () => {
  owner = await createTestUser("p5a2-owner");
  otherOwner = await createTestUser("p5a2-other-owner");
  tenant = await createTestTenant("test-p5a2-completion", owner.id);
  branchId = await createBranch(tenant.id, "Completion UX Branch");
  const service = await createService(tenant.id, "Completion UX Service", 30, 200);
  serviceId = service.id;
  otherTenant = await createTestTenant("test-p5a2-other", otherOwner.id);
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenant.id, otherTenant.id]);
  await cleanupUsers([owner.id, otherOwner.id]);
});

describe("solo-salon detection — the exact condition chosen", () => {
  it("a tenant with exactly one active, non-deleted staff member reports count=1 (the solo threshold)", async () => {
    const solo = await createTestUser("p5a2-solo-owner");
    const soloTenant = await createTestTenant("test-p5a2-solo", solo.id);
    await createStaffMember(soloTenant.id, "Emel Scenario Staff");

    const count = await activeStaffCountAs(solo, soloTenant.id);
    expect(count).toBe(1);

    await cleanupTenants([soloTenant.id]);
    await cleanupUsers([solo.id]);
  });

  it("a tenant with two active staff members reports count=2 — the completion panel is shown, not skipped", async () => {
    const s1 = await createStaffMember(tenant.id, "Multi Scenario Staff One");
    const s2 = await createStaffMember(tenant.id, "Multi Scenario Staff Two");
    const count = await activeStaffCountAs(owner, tenant.id);
    expect(count).toBeGreaterThanOrEqual(2);
    await testDb`delete from staff_members where id in (${s1.id}, ${s2.id})`;
  });

  it("an inactive or soft-deleted staff member never counts toward the solo threshold", async () => {
    const inactiveOwner = await createTestUser("p5a2-inactive-owner");
    const inactiveTenant = await createTestTenant("test-p5a2-inactive-count", inactiveOwner.id);
    const onlyStaff = await createStaffMember(inactiveTenant.id, "Only Staff Becomes Inactive");
    await testDb`update staff_members set status = 'inactive' where id = ${onlyStaff.id}`;

    // Zero ACTIVE staff — correctly not "solo" (there is nobody to
    // default-complete to); this tenant is a degenerate edge case the
    // completion UI does not need to specially handle (no appointment
    // could legitimately exist for zero active staff), but the count
    // itself must not miscount an inactive row as active.
    const count = await activeStaffCountAs(inactiveOwner, inactiveTenant.id);
    expect(count).toBe(0);

    await cleanupTenants([inactiveTenant.id]);
    await cleanupUsers([inactiveOwner.id]);
  });
});

describe("performer candidate rule — reuses the exact booking-eligibility query (active + this branch + this service)", () => {
  it("never includes another tenant's staff", async () => {
    const otherBranch = await createBranch(otherTenant.id, "Other Tenant Branch");
    const otherService = await createService(otherTenant.id, "Other Tenant Service", 30, 200);
    const otherStaff = await createStaffMember(otherTenant.id, "Other Tenant Candidate");
    await linkStaffBranch(otherStaff.id, otherBranch);
    await linkStaffService(otherStaff.id, otherService.id);

    const mine = await eligibleStaff("My Tenant Candidate");
    const candidates = await eligibleStaffAs(owner, serviceId, branchId);
    expect(candidates.map((c) => c.id)).toContain(mine);
    expect(candidates.map((c) => c.id)).not.toContain(otherStaff.id);
  });

  it("excludes a soft-deleted staff member even if still linked to the service/branch", async () => {
    const deleted = await eligibleStaff("Soft Deleted Candidate");
    await testDb`update staff_members set deleted_at = now() where id = ${deleted}`;
    const candidates = await eligibleStaffAs(owner, serviceId, branchId);
    expect(candidates.map((c) => c.id)).not.toContain(deleted);
  });

  it("excludes an inactive staff member from the candidate list, even though they may still be the CORRECT default (booked) selection the UI must add back in", async () => {
    const inactive = await eligibleStaff("Inactive Candidate");
    await testDb`update staff_members set status = 'inactive' where id = ${inactive}`;
    const candidates = await eligibleStaffAs(owner, serviceId, branchId);
    expect(candidates.map((c) => c.id)).not.toContain(inactive);
    // The completion panel's own merge logic (appointment-detail-sheet.tsx's
    // CompletionPanel) is what adds the booked staff back in when absent —
    // this test documents exactly why that merge step is necessary.
  });

  it("includes a legitimately eligible staff member for correction (the real Gökhan → Serdar case)", async () => {
    const serdar = await eligibleStaff("Correction Candidate Serdar");
    const candidates = await eligibleStaffAs(owner, serviceId, branchId);
    expect(candidates.map((c) => c.id)).toContain(serdar);
  });
});

describe("inactive booked staff at completion time (Faz 5A.2 brief section 8 — tested, not guessed)", () => {
  it("default (no-override) completion still succeeds when the BOOKED staff has since gone inactive, and correctly attributes them as the actual performer — historical accuracy is preserved, not blocked", async () => {
    const staffId = await eligibleStaff("Goes Inactive Before Completion");
    const { appointmentId, itemId } = await createAppointmentWithItem(staffId);
    await testDb`update staff_members set status = 'inactive' where id = ${staffId}`;

    const client = await signInAs(owner);
    const { error } = await client.rpc("complete_appointment", { p_appointment_id: appointmentId });
    await client.auth.signOut();
    expect(error).toBeNull();

    const [item] = await testDb<{ actual_staff_member_id: string | null }[]>`select actual_staff_member_id from appointment_items where id = ${itemId}`;
    expect(item!.actual_staff_member_id).toBe(staffId);
  });

  it("by contrast, an OVERRIDE naming that same now-inactive staff member is still rejected (AP008) — the default path forgives a since-changed booking, the correction path does not accept a currently-implausible performer", async () => {
    const bookedStaff = await eligibleStaff("Override Path Booked Staff");
    const inactiveTarget = await eligibleStaff("Override Path Inactive Target");
    await testDb`update staff_members set status = 'inactive' where id = ${inactiveTarget}`;
    const { appointmentId, itemId } = await createAppointmentWithItem(bookedStaff);

    const client = await signInAs(owner);
    const { error } = await client.rpc("complete_appointment", {
      p_appointment_id: appointmentId,
      p_performer_overrides: [{ appointment_item_id: itemId, actual_staff_member_id: inactiveTarget }],
    });
    await client.auth.signOut();
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AP008");
  });
});

/** Mirrors the exact embed shape getAppointmentDetail/loadAppointmentDetail
 * use for the completed-appointment display (see appointment-detail-sheet.tsx) */
type DisplayShapeRow = {
  appointment_items: {
    id: string;
    staff_members: { id: string; full_name: string } | null;
    actual_staff_members: { id: string; full_name: string } | null;
  }[];
};

describe("completed-appointment display data shape (underlies J/K — rendering itself is verified via live browser E2E)", () => {
  it("J. booked == actual (no correction made): the actual-performer embed resolves to the SAME row as booked, matching the 'render normally, no duplication' rule", async () => {
    const staffId = await eligibleStaff("Display Match Staff");
    const { appointmentId, itemId } = await createAppointmentWithItem(staffId);
    const client = await signInAs(owner);
    await client.rpc("complete_appointment", { p_appointment_id: appointmentId });

    const { data, error } = await client
      .from("appointments")
      .select(
        `appointment_items(id, staff_members!appointment_items_staff_member_id_fkey(id, full_name),
           actual_staff_members:staff_members!appointment_items_actual_staff_member_id_fkey(id, full_name))`,
      )
      .eq("id", appointmentId)
      .maybeSingle();
    await client.auth.signOut();
    expect(error).toBeNull();

    const item = (data as unknown as DisplayShapeRow).appointment_items.find((i) => i.id === itemId)!;
    expect(item.actual_staff_members!.id).toBe(staffId);
    expect(item.actual_staff_members!.id).toBe(item.staff_members!.id);
  });

  it("K. booked != actual (corrected): the actual-performer embed resolves to the DIFFERENT, corrected staff member, matching the 'show both identities' rule", async () => {
    const booked = await eligibleStaff("Display Diff Booked");
    const actual = await eligibleStaff("Display Diff Actual");
    const { appointmentId, itemId } = await createAppointmentWithItem(booked);
    const client = await signInAs(owner);
    await client.rpc("complete_appointment", {
      p_appointment_id: appointmentId,
      p_performer_overrides: [{ appointment_item_id: itemId, actual_staff_member_id: actual }],
    });

    const { data } = await client
      .from("appointments")
      .select(
        `appointment_items(id, staff_members!appointment_items_staff_member_id_fkey(id, full_name),
           actual_staff_members:staff_members!appointment_items_actual_staff_member_id_fkey(id, full_name))`,
      )
      .eq("id", appointmentId)
      .maybeSingle();
    await client.auth.signOut();

    const item = (data as unknown as DisplayShapeRow).appointment_items.find((i) => i.id === itemId)!;
    expect(item.staff_members!.id).toBe(booked);
    expect(item.actual_staff_members!.id).toBe(actual);
    expect(item.actual_staff_members!.id).not.toBe(item.staff_members!.id);
  });

  it("not-yet-completed item: the actual-performer embed is null — the display must fall back to booked staff only, matching a not-yet-completed appointment's current (unchanged) look", async () => {
    const staffId = await eligibleStaff("Not Yet Completed Staff");
    const { appointmentId, itemId } = await createAppointmentWithItem(staffId, "confirmed");
    const client = await signInAs(owner);
    const { data } = await client
      .from("appointments")
      .select(
        `appointment_items(id, staff_members!appointment_items_staff_member_id_fkey(id, full_name),
           actual_staff_members:staff_members!appointment_items_actual_staff_member_id_fkey(id, full_name))`,
      )
      .eq("id", appointmentId)
      .maybeSingle();
    await client.auth.signOut();

    const item = (data as unknown as DisplayShapeRow).appointment_items.find((i) => i.id === itemId)!;
    expect(item.actual_staff_members).toBeNull();
  });
});

describe("N. completion Server Action error mapping", () => {
  it("AP017 (the new completion-bypass rejection) has a defined, non-empty Turkish message in the shared error-code map completeAppointmentAction/updateAppointmentStatusAction both use", () => {
    expect(APPOINTMENT_ERROR_MESSAGES.AP017).toBeTruthy();
    expect(typeof APPOINTMENT_ERROR_MESSAGES.AP017).toBe("string");
  });
});
