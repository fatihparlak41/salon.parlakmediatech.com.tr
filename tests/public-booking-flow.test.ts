import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient,
  createBranch,
  createCustomer,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  signInAs,
  testDb,
  cleanupTenants,
  cleanupUsers,
  type TestUser,
} from "./helpers";
import type {
  PublicBookingContext,
  PublicBookingStaffOption,
  GuestBookingConfirmation,
} from "@/lib/modules/public-booking/client-queries";

// The 4 public RPCs return jsonb, typed generically as Json by the
// generated Supabase types — cast to the same shapes the application
// code itself uses (lib/modules/public-booking/client-queries.ts),
// rather than re-declaring them here.
function asContext(data: unknown): PublicBookingContext {
  return data as PublicBookingContext;
}
function asStaffList(data: unknown): PublicBookingStaffOption[] {
  return data as PublicBookingStaffOption[];
}
function asSlots(data: unknown): string[] {
  return data as string[];
}
function asConfirmation(data: unknown): GuestBookingConfirmation {
  return data as GuestBookingConfirmation;
}

/**
 * Phase 2F — public guest booking. The 3 read RPCs are called through
 * anonClient() (the publishable/anon key, no session) exactly as the
 * browser calls them — the whole point of that surface is that none of
 * it requires auth.uid(). Fixtures use a non-Istanbul, DST-observing
 * timezone (America/New_York) for the timezone-correctness tests,
 * matching the rigor established for the calendar's own timezone tests
 * in Phase 2E.
 *
 * create_guest_booking is different as of Phase 2F.2: anon/authenticated
 * no longer have EXECUTE on it at all (20260822170000) — only the
 * booking_gateway role does, reached in production exclusively through
 * the Next.js server gateway (see tests/booking-gateway.test.ts for
 * those tests). The DB function's OWN correctness — idempotency,
 * contact validation, customer matching, concurrency, error taxonomy —
 * is still exactly what this file tests; createGuestBookingDirect below
 * calls it via testDb (an unrestricted Postgres connection, not subject
 * to any role's grants) purely so this coverage doesn't have to move,
 * with the same {data,error} shape anonClient().rpc(...) used to return
 * so every existing assertion below is unchanged.
 */
async function createGuestBookingDirect(
  params: Record<string, unknown>,
): Promise<{ data: unknown; error: { code: string; message: string } | null }> {
  try {
    const [row] = await testDb`
      select public.create_guest_booking(
        ${params.p_tenant_slug as string},
        ${params.p_branch_id as string}::uuid,
        ${params.p_service_id as string}::uuid,
        ${params.p_scheduled_start_at as string}::timestamptz,
        ${params.p_customer_full_name as string},
        ${params.p_customer_phone as string},
        ${(params.p_staff_member_id as string | undefined) ?? null}::uuid,
        ${(params.p_customer_email as string | undefined) ?? null},
        ${(params.p_idempotency_key as string | undefined) ?? null}::uuid
      ) as result
    `;
    return { data: row!.result, error: null };
  } catch (err) {
    const pgErr = err as { code?: string; message?: string };
    return { data: null, error: { code: pgErr.code ?? "UNKNOWN", message: pgErr.message ?? "unknown error" } };
  }
}

let tenantA: { id: string; slug: string };
let tenantB: { id: string; slug: string }; // isolation target
let tenantSuspended: { id: string; slug: string };
let tenantNoFeature: { id: string; slug: string };
let ownerA: TestUser;
let ownerB: TestUser;
let ownerSuspended: TestUser;
let ownerNoFeature: TestUser;

let branchA1: string;
let branchA2: string;
let staffA1: { id: string; fullName: string }; // branchA1, eligible for serviceA1 only
let staffA2: { id: string; fullName: string }; // branchA1, eligible for serviceA1 + serviceA2
let staffA3Inactive: { id: string; fullName: string }; // branchA1, eligible for serviceA1, but INACTIVE
let serviceA1: { id: string; name: string; durationMinutes: number; price: number };
let serviceA2: { id: string; name: string; durationMinutes: number; price: number };
let serviceA1Inactive: { id: string; name: string };
let branchB: string;
let customerAExisting: { id: string; fullName: string };

async function enableOnlineBooking(tenantId: string) {
  const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
  if (!feature) throw new Error("online_booking feature missing from catalog");
  await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${tenantId}, ${feature.id}, true)`;
}

beforeAll(async () => {
  ownerA = await createTestUser("p2f-owner-a");
  ownerB = await createTestUser("p2f-owner-b");
  ownerSuspended = await createTestUser("p2f-owner-susp");
  ownerNoFeature = await createTestUser("p2f-owner-nofeat");

  const tenantARow = await createTestTenant("test-p2f-a", ownerA.id);
  const tenantBRow = await createTestTenant("test-p2f-b", ownerB.id);
  const tenantSuspendedRow = await createTestTenant("test-p2f-susp", ownerSuspended.id);
  const tenantNoFeatureRow = await createTestTenant("test-p2f-nofeat", ownerNoFeature.id);
  tenantA = { id: tenantARow.id, slug: tenantARow.slug };
  tenantB = { id: tenantBRow.id, slug: tenantBRow.slug };
  tenantSuspended = { id: tenantSuspendedRow.id, slug: tenantSuspendedRow.slug };
  tenantNoFeature = { id: tenantNoFeatureRow.id, slug: tenantNoFeatureRow.slug };

  await enableOnlineBooking(tenantA.id);
  await enableOnlineBooking(tenantB.id);
  await enableOnlineBooking(tenantSuspended.id);
  // tenantNoFeature deliberately gets no tenant_features row at all.

  await testDb`update tenants set status = 'suspended' where id = ${tenantSuspended.id}`;
  // America/New_York: DST-observing, never the workstation/CI runner's
  // own zone — matches Phase 2E's timezone-test rigor.
  await testDb`update tenants set timezone = 'America/New_York' where id = ${tenantA.id}`;

  branchA1 = await createBranch(tenantA.id, "Branch A1");
  branchA2 = await createBranch(tenantA.id, "Branch A2");
  branchB = await createBranch(tenantB.id, "Branch B1");

  staffA1 = await createStaffMember(tenantA.id, "Staff A1");
  staffA2 = await createStaffMember(tenantA.id, "Staff A2");
  staffA3Inactive = await createStaffMember(tenantA.id, "Staff A3 Inactive");
  await testDb`update staff_members set status = 'inactive' where id = ${staffA3Inactive.id}`;

  serviceA1 = await createService(tenantA.id, "Service A1", 30, 200);
  serviceA2 = await createService(tenantA.id, "Service A2", 60, 400);
  serviceA1Inactive = await createService(tenantA.id, "Service A1 Inactive", 30, 200);
  await testDb`update services set status = 'inactive' where id = ${serviceA1Inactive.id}`;

  await linkStaffBranch(staffA1.id, branchA1);
  await linkStaffBranch(staffA2.id, branchA1);
  await linkStaffBranch(staffA3Inactive.id, branchA1);
  await linkServiceBranch(serviceA1.id, branchA1);
  await linkServiceBranch(serviceA2.id, branchA1);
  await linkServiceBranch(serviceA1Inactive.id, branchA1);
  // serviceA1 is ALSO offered at branchA2 (but no staff is linked to
  // branchA2 at all) — isolates the same-tenant cross-branch isolation
  // test below to the staff_branches dimension specifically, rather than
  // failing for the unrelated reason of the service itself not being on
  // that branch.
  await linkServiceBranch(serviceA1.id, branchA2);

  await linkStaffService(staffA1.id, serviceA1.id);
  await linkStaffService(staffA2.id, serviceA1.id);
  await linkStaffService(staffA2.id, serviceA2.id);
  await linkStaffService(staffA3Inactive.id, serviceA1.id);

  for (const staff of [staffA1, staffA2, staffA3Inactive]) {
    for (let weekday = 0; weekday <= 6; weekday++) {
      await createStaffSchedule(tenantA.id, staff.id, weekday, "09:00", "17:00");
    }
  }

  customerAExisting = await createCustomer(tenantA.id, "Existing Customer");
  await testDb`
    update customers set phone = '5550001111' where id = ${customerAExisting.id}
  `;
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id, tenantSuspended.id, tenantNoFeature.id]);
  await cleanupUsers([ownerA.id, ownerB.id, ownerSuspended.id, ownerNoFeature.id]);
});

// A date comfortably inside the horizon, weekday known-safe against the
// 09:00-17:00 schedule above regardless of which day "today" happens to
// be — always +5 days out.
function futureDateStr(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

describe("public booking context", () => {
  it("active tenant with online_booking enabled returns full context", async () => {
    const { data: raw, error } = await anonClient().rpc("get_public_booking_context", { p_tenant_slug: tenantA.slug });
    expect(error).toBeNull();
    const data = asContext(raw);
    if (!data.bookable) throw new Error("expected bookable:true");
    expect(data.salon.slug).toBe(tenantA.slug);
    expect(data.salon.timezone).toBe("America/New_York");
    const branchIds = data.branches.map((b) => b.id);
    expect(branchIds).toContain(branchA1);
    const b1 = data.branches.find((b) => b.id === branchA1)!;
    const serviceNames = b1.services.map((s) => s.name);
    expect(serviceNames).toContain("Service A1");
    expect(serviceNames).toContain("Service A2");
    expect(serviceNames).not.toContain("Service A1 Inactive");
  });

  it("unknown tenant slug returns only bookable:false", async () => {
    const { data, error } = await anonClient().rpc("get_public_booking_context", { p_tenant_slug: "no-such-salon-slug-xyz" });
    expect(error).toBeNull();
    expect(data).toEqual({ bookable: false });
  });

  it("suspended tenant returns only bookable:false (indistinguishable from unknown)", async () => {
    const { data, error } = await anonClient().rpc("get_public_booking_context", { p_tenant_slug: tenantSuspended.slug });
    expect(error).toBeNull();
    expect(data).toEqual({ bookable: false });
  });

  it("tenant without online_booking enabled returns only bookable:false", async () => {
    const { data, error } = await anonClient().rpc("get_public_booking_context", { p_tenant_slug: tenantNoFeature.slug });
    expect(error).toBeNull();
    expect(data).toEqual({ bookable: false });
  });

  it("branch/service objects expose only booking-safe fields", async () => {
    const { data: raw } = await anonClient().rpc("get_public_booking_context", { p_tenant_slug: tenantA.slug });
    const data = asContext(raw);
    if (!data.bookable) throw new Error("expected bookable:true");
    const b1 = data.branches.find((b) => b.id === branchA1)!;
    expect(Object.keys(b1).sort()).toEqual(["address", "id", "name", "services"].sort());
    const svc = b1.services[0]!;
    expect(Object.keys(svc).sort()).toEqual(["category", "durationMinutes", "id", "name", "price"].sort());
  });
});

describe("public eligible staff", () => {
  it("returns only active, branch-linked, service-eligible staff", async () => {
    const { data: raw } = await anonClient().rpc("get_public_eligible_staff", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
    });
    const ids = asStaffList(raw).map((s) => s.id);
    expect(ids).toContain(staffA1.id);
    expect(ids).toContain(staffA2.id);
    expect(ids).not.toContain(staffA3Inactive.id); // inactive
  });

  it("excludes staff not eligible for the given service", async () => {
    const { data: raw } = await anonClient().rpc("get_public_eligible_staff", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA2.id,
    });
    const ids = asStaffList(raw).map((s) => s.id);
    expect(ids).toContain(staffA2.id);
    expect(ids).not.toContain(staffA1.id); // not linked to serviceA2
  });

  it("returns only id/fullName — no private staff fields leak", async () => {
    const { data: raw } = await anonClient().rpc("get_public_eligible_staff", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
    });
    for (const row of asStaffList(raw)) {
      expect(Object.keys(row).sort()).toEqual(["fullName", "id"]);
    }
  });

  it("invalid branch/service pairing resolves to an empty array, never an error", async () => {
    const { data, error } = await anonClient().rpc("get_public_eligible_staff", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchB, // wrong tenant's branch
      p_service_id: serviceA1.id,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("same-tenant cross-branch isolation: staff linked only to branchA1 never appears for branchA2", async () => {
    // Distinct from the cross-tenant check above — branchA2 belongs to
    // the SAME tenant as branchA1, so this proves the branch scoping
    // itself (staff_branches), not just tenant scoping.
    const { data, error } = await anonClient().rpc("get_public_eligible_staff", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA2,
      p_service_id: serviceA1.id,
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe("public availability slots", () => {
  it("respects tenant timezone (America/New_York), not server/UTC wall clock", async () => {
    const dateStr = futureDateStr(5);
    const { data: raw } = await anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_date: dateStr,
      p_staff_member_id: staffA1.id,
    });
    const data = asSlots(raw);
    expect(data).toContain("09:00");
    expect(data).not.toContain("08:45"); // before schedule start
    expect(data).not.toContain("17:00"); // 09:00-17:00 schedule, 30min service, last valid start is 16:30
  });

  it("existing appointment_item removes exactly its window, nothing else", async () => {
    const dateStr = futureDateStr(6);
    const startAt = `${dateStr}T14:00:00.000Z`; // arbitrary UTC instant inside the schedule window either offset
    const owner = await signInAs(ownerA);
    const { error: apptErr } = await owner.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA1,
      p_customer_id: customerAExisting.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: startAt, sequence: 1 }],
    });
    expect(apptErr).toBeNull();

    const { data: raw } = await anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_date: dateStr,
      p_staff_member_id: staffA1.id,
    });
    const data = asSlots(raw);

    // The booked item's local start time must be absent; staffA2 (not
    // booked) is untouched by this — proven separately by the any-staff
    // union test below.
    const bookedLocal = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(startAt));
    expect(data).not.toContain(bookedLocal);
  });

  it("day-off exception removes the entire date for that staff member", async () => {
    const dateStr = futureDateStr(7);
    await testDb`
      insert into staff_schedule_exceptions (tenant_id, staff_member_id, exception_date, type, reason)
      values (${tenantA.id}, ${staffA2.id}, ${dateStr}, 'unavailable', 'test day off')
    `;
    const { data } = await anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_date: dateStr,
      p_staff_member_id: staffA2.id,
    });
    expect(data).toEqual([]);
  });

  it("any-staff (no p_staff_member_id) unions availability across eligible staff", async () => {
    const dateStr = futureDateStr(8);
    // staffA2 has no service A1 conflict on this date; staffA1 does not either.
    const { data: raw } = await anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_date: dateStr,
    });
    expect(asSlots(raw)).toContain("09:00");
  });

  it("past date returns empty", async () => {
    const { data } = await anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_date: "2020-01-01",
    });
    expect(data).toEqual([]);
  });

  it("date beyond the 30-day horizon returns empty", async () => {
    const { data } = await anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_date: futureDateStr(45),
    });
    expect(data).toEqual([]);
  });

  it("response is a flat array of time strings — no staff/appointment/customer detail leaks", async () => {
    const { data: raw } = await anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_date: futureDateStr(9),
    });
    const data = asSlots(raw);
    expect(Array.isArray(data)).toBe(true);
    for (const slot of data) {
      expect(typeof slot).toBe("string");
      expect(slot).toMatch(/^\d{2}:\d{2}$/);
    }
  });
});

describe("guest booking creation", () => {
  it("creates a booking with no auth.uid() and no tenant membership", async () => {
    const dateStr = futureDateStr(10);
    const { data: raw, error } = await createGuestBookingDirect({
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: `${dateStr}T13:00:00.000Z`,
      p_customer_full_name: "Guest Create Test",
      p_customer_phone: "5551110001",
      p_staff_member_id: staffA1.id,
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(error).toBeNull();
    const data = asConfirmation(raw);
    expect(data.appointmentReference).toBeTruthy();
    expect(data.staffName).toBe("Staff A1");
    expect(data.price).toBe(200);
    expect(data.durationMinutes).toBe(30);

    const [row] = await testDb<{ source: string; created_by: string | null; customer_id: string }[]>`
      select source, created_by, customer_id from appointments where id = ${data.appointmentReference}
    `;
    expect(row!.source).toBe("public_booking");
    expect(row!.created_by).toBeNull();

    // The customer this booking created is never a tenant_memberships
    // row — guest bookings never grant any kind of salon access.
    const memberships = await testDb`select 1 from tenant_memberships where user_id = ${row!.customer_id}`;
    expect(memberships).toEqual([]);
  });

  it("reuses an existing customer only on unambiguous phone+name match", async () => {
    const dateStr = futureDateStr(11);
    const { data: raw, error } = await createGuestBookingDirect({
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: `${dateStr}T13:00:00.000Z`,
      p_customer_full_name: "Existing Customer",
      p_customer_phone: "5550001111",
      p_staff_member_id: staffA1.id,
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(error).toBeNull();
    const data = asConfirmation(raw);
    const [row] = await testDb<{ customer_id: string }[]>`select customer_id from appointments where id = ${data.appointmentReference}`;
    expect(row!.customer_id).toBe(customerAExisting.id);
  });

  it("does not reuse a customer on phone match with a different name (ambiguous -> new customer)", async () => {
    const dateStr = futureDateStr(12);
    const { data: raw, error } = await createGuestBookingDirect({
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: `${dateStr}T13:00:00.000Z`,
      p_customer_full_name: "A Totally Different Name",
      p_customer_phone: "5550001111", // same phone as customerAExisting
      p_staff_member_id: staffA1.id,
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(error).toBeNull();
    const data = asConfirmation(raw);
    const [row] = await testDb<{ customer_id: string }[]>`select customer_id from appointments where id = ${data.appointmentReference}`;
    expect(row!.customer_id).not.toBe(customerAExisting.id);
  });

  it("any-staff resolution picks a real, eligible, deterministic staff member", async () => {
    const dateStr = futureDateStr(13);
    const { data: raw, error } = await createGuestBookingDirect({
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: `${dateStr}T13:00:00.000Z`,
      p_customer_full_name: "Any Staff Test",
      p_customer_phone: "5551110002",
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(error).toBeNull();
    const data = asConfirmation(raw);
    const [row] = await testDb<{ staff_member_id: string }[]>`
      select ai.staff_member_id from appointment_items ai where ai.appointment_id = ${data.appointmentReference}
    `;
    expect([staffA1.id, staffA2.id]).toContain(row!.staff_member_id);
  });

  it("response never includes customer_id, raw SQL text, or any internal-only field", async () => {
    const dateStr = futureDateStr(14);
    const { data: raw } = await createGuestBookingDirect({
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: `${dateStr}T13:00:00.000Z`,
      p_customer_full_name: "Shape Check",
      p_customer_phone: "5551110003",
      p_staff_member_id: staffA1.id,
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(Object.keys(asConfirmation(raw)).sort()).toEqual(
      // claimIssued (Faz 2G.3.1) and claimRef (Faz 2G.3.1A) are both
      // always present in the RAW database response — always false/null
      // here since this call passes no claim secret hash at all.
      // claimIssued is safe to expose (see client-queries.ts's own
      // GuestBookingConfirmation comment); claimRef is stripped out by
      // gateway.ts before anything reaches the browser (this test calls
      // the database directly, bypassing that stripping step on
      // purpose, so it still sees the raw field here).
      [
        "appointmentReference",
        "branchName",
        "claimIssued",
        "claimRef",
        "durationMinutes",
        "price",
        "scheduledStartAt",
        "serviceName",
        "staffName",
        "tenantTimezone",
      ].sort(),
    );
  });

  it("produces exactly one audit_logs row with a null actor", async () => {
    const dateStr = futureDateStr(15);
    const { data: raw } = await createGuestBookingDirect({
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: `${dateStr}T13:00:00.000Z`,
      p_customer_full_name: "Audit Check",
      p_customer_phone: "5551110004",
      p_staff_member_id: staffA1.id,
      p_idempotency_key: crypto.randomUUID(),
    });
    const data = asConfirmation(raw);
    const rows = await testDb`
      select actor_user_id, actor_type, action from audit_logs
      where entity_id = ${data.appointmentReference} and entity_type = 'appointment'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_user_id).toBeNull();
    expect(rows[0]!.action).toBe("appointment.created");
  });

  describe("idempotency — canonical fingerprint (Phase 2F.1)", () => {
    // Base payload every scenario starts from and mutates exactly one
    // field of, matching the 9 required scenarios: branch, service,
    // start, phone, name, email, staff-preference, and a formatting-only
    // variant that must still collapse to the same fingerprint.
    function basePayload(dateStr: string, key: string) {
      return {
        p_tenant_slug: tenantA.slug,
        p_branch_id: branchA1,
        p_service_id: serviceA1.id,
        p_scheduled_start_at: `${dateStr}T13:00:00.000Z`,
        p_customer_full_name: "Fingerprint Test",
        p_customer_phone: "5551110020",
        p_customer_email: "fingerprint@example.com",
        p_staff_member_id: staffA1.id,
        p_idempotency_key: key,
      };
    }

    it("1. same key + identical canonical payload -> same booking, exactly one appointment", async () => {
      const dateStr = futureDateStr(25);
      const key = crypto.randomUUID();
      const input = basePayload(dateStr, key);
      const first = await createGuestBookingDirect(input);
      const second = await createGuestBookingDirect(input);
      expect(first.error).toBeNull();
      expect(second.error).toBeNull();
      expect(asConfirmation(second.data).appointmentReference).toBe(asConfirmation(first.data).appointmentReference);
      const rows = await testDb`select id from appointments where idempotency_key = ${key}`;
      expect(rows.length).toBe(1);
    });

    it("2. same key + different branch -> BK007, original untouched", async () => {
      const dateStr = futureDateStr(26);
      const key = crypto.randomUUID();
      const first = await createGuestBookingDirect(basePayload(dateStr, key));
      expect(first.error).toBeNull();
      const second = await createGuestBookingDirect({ ...basePayload(dateStr, key), p_branch_id: branchA2, p_service_id: serviceA1.id, p_staff_member_id: undefined });
      expect(second.error?.code).toBe("BK007");
      const rows = await testDb`select id from appointments where idempotency_key = ${key}`;
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toBe(asConfirmation(first.data).appointmentReference);
    });

    it("3. same key + different service -> BK007", async () => {
      const dateStr = futureDateStr(27);
      const key = crypto.randomUUID();
      const first = await createGuestBookingDirect(basePayload(dateStr, key));
      expect(first.error).toBeNull();
      const second = await createGuestBookingDirect({ ...basePayload(dateStr, key), p_service_id: serviceA2.id, p_staff_member_id: staffA2.id });
      expect(second.error?.code).toBe("BK007");
      const rows = await testDb`select id from appointments where idempotency_key = ${key}`;
      expect(rows.length).toBe(1);
    });

    it("4. same key + different start -> BK007", async () => {
      const dateStr = futureDateStr(28);
      const key = crypto.randomUUID();
      const first = await createGuestBookingDirect(basePayload(dateStr, key));
      expect(first.error).toBeNull();
      const second = await createGuestBookingDirect({ ...basePayload(dateStr, key), p_scheduled_start_at: `${dateStr}T14:00:00.000Z` });
      expect(second.error?.code).toBe("BK007");
      const rows = await testDb`select id from appointments where idempotency_key = ${key}`;
      expect(rows.length).toBe(1);
    });

    it("5. same key + different phone -> BK007", async () => {
      const dateStr = futureDateStr(29);
      const key = crypto.randomUUID();
      const first = await createGuestBookingDirect(basePayload(dateStr, key));
      expect(first.error).toBeNull();
      const second = await createGuestBookingDirect({ ...basePayload(dateStr, key), p_customer_phone: "5559998888" });
      expect(second.error?.code).toBe("BK007");
      const rows = await testDb`select id from appointments where idempotency_key = ${key}`;
      expect(rows.length).toBe(1);
    });

    it("6. same key + different normalized name -> BK007", async () => {
      const dateStr = futureDateStr(30);
      const key = crypto.randomUUID();
      const first = await createGuestBookingDirect(basePayload(dateStr, key));
      expect(first.error).toBeNull();
      const second = await createGuestBookingDirect({ ...basePayload(dateStr, key), p_customer_full_name: "A Totally Different Person" });
      expect(second.error?.code).toBe("BK007");
      const rows = await testDb`select id from appointments where idempotency_key = ${key}`;
      expect(rows.length).toBe(1);
    });

    it("7. same key + different email -> BK007", async () => {
      const dateStr = futureDateStr(31);
      const key = crypto.randomUUID();
      const first = await createGuestBookingDirect(basePayload(dateStr, key));
      expect(first.error).toBeNull();
      const second = await createGuestBookingDirect({ ...basePayload(dateStr, key), p_customer_email: "different@example.com" });
      expect(second.error?.code).toBe("BK007");
      const rows = await testDb`select id from appointments where idempotency_key = ${key}`;
      expect(rows.length).toBe(1);
    });

    it("8. same key: original ANY_STAFF, retry with the explicitly-assigned staff -> BK007", async () => {
      const dateStr = futureDateStr(32);
      const key = crypto.randomUUID();
      const anyStaffInput = { ...basePayload(dateStr, key), p_staff_member_id: undefined };
      const first = await createGuestBookingDirect(anyStaffInput);
      expect(first.error).toBeNull();
      const assignedStaffId = asConfirmation(first.data).staffName === "Staff A1" ? staffA1.id : staffA2.id;
      // Retry with the SAME staff any-staff actually resolved to,
      // supplied explicitly this time — must still be treated as a
      // different request, per the explicit ANY_STAFF != explicit-id rule.
      const second = await createGuestBookingDirect({ ...basePayload(dateStr, key), p_staff_member_id: assignedStaffId });
      expect(second.error?.code).toBe("BK007");
      const rows = await testDb`select id from appointments where idempotency_key = ${key}`;
      expect(rows.length).toBe(1);
    });

    it("9. formatting-only differences (whitespace/case/phone punctuation) normalize identically -> idempotent replay, not BK007", async () => {
      const dateStr = futureDateStr(33);
      const key = crypto.randomUUID();
      const first = await createGuestBookingDirect({
        ...basePayload(dateStr, key),
        p_customer_full_name: "  Fingerprint Test  ",
        p_customer_phone: "(555) 111-0020",
      });
      expect(first.error).toBeNull();
      const second = await createGuestBookingDirect({
        ...basePayload(dateStr, key),
        p_customer_full_name: "FINGERPRINT TEST",
        p_customer_phone: "5551110020",
      });
      expect(second.error).toBeNull();
      expect(asConfirmation(second.data).appointmentReference).toBe(asConfirmation(first.data).appointmentReference);
      const rows = await testDb`select id from appointments where idempotency_key = ${key}`;
      expect(rows.length).toBe(1);
    });

    it("idempotency_fingerprint is never returned in the public response", async () => {
      const dateStr = futureDateStr(34);
      const { data: raw } = await createGuestBookingDirect(basePayload(dateStr, crypto.randomUUID()));
      expect(Object.keys(asConfirmation(raw))).not.toContain("idempotencyFingerprint");
      expect(Object.keys(asConfirmation(raw))).not.toContain("fingerprint");
    });
  });

  describe("concurrency", () => {
    it("exactly one of two simultaneous bookings for the same specific staff+slot succeeds", async () => {
      const dateStr = futureDateStr(20);
      const startAt = `${dateStr}T13:00:00.000Z`;
      const [r1, r2] = await Promise.all([
        createGuestBookingDirect({
          p_tenant_slug: tenantA.slug,
          p_branch_id: branchA1,
          p_service_id: serviceA1.id,
          p_scheduled_start_at: startAt,
          p_customer_full_name: "Race One",
          p_customer_phone: "5551110010",
          p_staff_member_id: staffA1.id,
          p_idempotency_key: crypto.randomUUID(),
        }),
        createGuestBookingDirect({
          p_tenant_slug: tenantA.slug,
          p_branch_id: branchA1,
          p_service_id: serviceA1.id,
          p_scheduled_start_at: startAt,
          p_customer_full_name: "Race Two",
          p_customer_phone: "5551110011",
          p_staff_member_id: staffA1.id,
          p_idempotency_key: crypto.randomUUID(),
        }),
      ]);
      const successes = [r1, r2].filter((r) => !r.error);
      const failures = [r1, r2].filter((r) => r.error);
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      expect(failures[0]!.error!.code).toBe("BK005");
    });

    it("any-staff race with two eligible staff: both bookings succeed, against different staff", async () => {
      const dateStr = futureDateStr(21);
      const startAt = `${dateStr}T13:00:00.000Z`;
      const [r1, r2] = await Promise.all([
        createGuestBookingDirect({
          p_tenant_slug: tenantA.slug,
          p_branch_id: branchA1,
          p_service_id: serviceA1.id, // staffA1 + staffA2 both eligible
          p_scheduled_start_at: startAt,
          p_customer_full_name: "Any Race One",
          p_customer_phone: "5551110012",
          p_idempotency_key: crypto.randomUUID(),
        }),
        createGuestBookingDirect({
          p_tenant_slug: tenantA.slug,
          p_branch_id: branchA1,
          p_service_id: serviceA1.id,
          p_scheduled_start_at: startAt,
          p_customer_full_name: "Any Race Two",
          p_customer_phone: "5551110013",
          p_idempotency_key: crypto.randomUUID(),
        }),
      ]);
      expect(r1.error).toBeNull();
      expect(r2.error).toBeNull();
      const ref1 = asConfirmation(r1.data).appointmentReference;
      const ref2 = asConfirmation(r2.data).appointmentReference;
      const [row1] = await testDb<{ staff_member_id: string }[]>`select staff_member_id from appointment_items where appointment_id = ${ref1}`;
      const [row2] = await testDb<{ staff_member_id: string }[]>`select staff_member_id from appointment_items where appointment_id = ${ref2}`;
      expect(row1!.staff_member_id).not.toBe(row2!.staff_member_id);
      expect([staffA1.id, staffA2.id]).toContain(row1!.staff_member_id);
      expect([staffA1.id, staffA2.id]).toContain(row2!.staff_member_id);
    });
  });
});

describe("customer-facing error taxonomy", () => {
  it("invalid branch maps to BK002", async () => {
    const { error } = await createGuestBookingDirect({
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchB, // wrong tenant
      p_service_id: serviceA1.id,
      p_scheduled_start_at: `${futureDateStr(18)}T13:00:00.000Z`,
      p_customer_full_name: "Err Test",
      p_customer_phone: "5551110007",
      p_staff_member_id: staffA1.id,
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(error!.code).toBe("BK002");
  });

  it("invalid service maps to BK003", async () => {
    const { error } = await createGuestBookingDirect({
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1Inactive.id,
      p_scheduled_start_at: `${futureDateStr(18)}T13:00:00.000Z`,
      p_customer_full_name: "Err Test",
      p_customer_phone: "5551110008",
      p_staff_member_id: staffA1.id,
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(error!.code).toBe("BK003");
  });

  it("unbookable tenant maps to BK001", async () => {
    const { error } = await createGuestBookingDirect({
      p_tenant_slug: tenantNoFeature.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: `${futureDateStr(18)}T13:00:00.000Z`,
      p_customer_full_name: "Err Test",
      p_customer_phone: "5551110009",
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(error!.code).toBe("BK001");
  });
});

describe("contact validation policy (BK006) — Phase 2F.1", () => {
  // One shared helper: every scenario only varies name/phone/email
  // against otherwise-valid booking parameters, on its own date so a
  // rejected call never collides with another test's slot.
  async function attempt(dateOffset: number, overrides: { name?: string; phone?: string; email?: string | null }) {
    return createGuestBookingDirect({
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA1,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: `${futureDateStr(dateOffset)}T13:00:00.000Z`,
      p_customer_full_name: overrides.name ?? "Valid Name",
      p_customer_phone: overrides.phone ?? "5551234567",
      p_customer_email: overrides.email ?? undefined,
      p_staff_member_id: staffA1.id,
      p_idempotency_key: crypto.randomUUID(),
    });
  }

  it("blank name is rejected", async () => {
    const { error } = await attempt(40, { name: "" });
    expect(error!.code).toBe("BK006");
  });

  it("whitespace-only name is rejected", async () => {
    const { error } = await attempt(41, { name: "   " });
    expect(error!.code).toBe("BK006");
  });

  it("blank phone is rejected", async () => {
    const { error } = await attempt(42, { phone: "" });
    expect(error!.code).toBe("BK006");
  });

  it("phone that normalizes to empty (letters/punctuation only) is rejected", async () => {
    const { error } = await attempt(43, { phone: "abc-def" });
    expect(error!.code).toBe("BK006");
  });

  it("phone below the 7-digit country-neutral floor is rejected", async () => {
    const { error } = await attempt(44, { phone: "123456" }); // 6 digits
    expect(error!.code).toBe("BK006");
  });

  it("phone above the 15-digit E.164 ceiling is rejected", async () => {
    const { error } = await attempt(45, { phone: "1234567890123456" }); // 16 digits
    expect(error!.code).toBe("BK006");
  });

  it("phone with '+' in a non-leading position is rejected", async () => {
    const { error } = await attempt(46, { phone: "555+1234567" });
    expect(error!.code).toBe("BK006");
  });

  it("a 7-digit phone at the floor is accepted (not overly strict)", async () => {
    const { error } = await attempt(47, { phone: "5551234" });
    expect(error).toBeNull();
  });

  it("a leading '+' with a valid digit count is accepted", async () => {
    const { error } = await attempt(48, { phone: "+15551234567" });
    expect(error).toBeNull();
  });

  it("malformed non-empty email is rejected", async () => {
    const { error } = await attempt(49, { email: "not-an-email" });
    expect(error!.code).toBe("BK006");
  });

  it("email missing a domain dot is rejected", async () => {
    const { error } = await attempt(50, { email: "foo@bar" });
    expect(error!.code).toBe("BK006");
  });

  it("a well-formed email is accepted", async () => {
    const { error } = await attempt(51, { email: "valid@example.com" });
    expect(error).toBeNull();
  });

  it("omitted email (null) is accepted — email stays optional", async () => {
    const { error } = await attempt(52, { email: null });
    expect(error).toBeNull();
  });
});

describe("privacy: anon cannot read salon operational tables directly", () => {
  const tables = ["customers", "appointments", "appointment_items", "staff_members", "staff_schedules", "staff_schedule_exceptions", "tenant_memberships", "profiles", "audit_logs"];

  for (const table of tables) {
    it(`anon SELECT on ${table} is denied`, async () => {
      // Table name is deliberately dynamic (looping over the whole
      // sensitive-table list) — narrowed to the client's known table
      // union isn't practical here, hence the one local cast.
      const { error } = await anonClient()
        .from(table as Parameters<ReturnType<typeof anonClient>["from"]>[0])
        .select("*")
        .limit(1);
      expect(error).not.toBeNull();
      expect(error!.code).toBe("42501");
    });
  }
});

describe("anon function allowlist — exact signatures, no unexpected overload", () => {
  it("exactly 3 public.* functions are anon-executable, no more, no less", async () => {
    // create_guest_booking was here through Phase 2F.1 — Phase 2F.2
    // (20260822170000) revoked anon's execute on it and granted the
    // booking_gateway role instead. That grant is covered by
    // tests/security-grants-regression.test.ts's own booking_gateway
    // describe block, not here — this test is scoped to anon only.
    const rows = await testDb<{ name: string }[]>`
      select p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proacl is not null
        and exists (
          select 1 from aclexplode(p.proacl) a where pg_get_userbyid(a.grantee) = 'anon' and a.privilege_type = 'EXECUTE'
        )
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by p.proname
    `;
    expect(rows.map((r) => r.name)).toEqual([
      "get_public_availability_slots",
      "get_public_booking_context",
      "get_public_eligible_staff",
    ]);
  });

  it("each anon-executable function has exactly the expected signature", async () => {
    const expected: Record<string, string> = {
      get_public_booking_context: "p_tenant_slug text",
      get_public_eligible_staff: "p_tenant_slug text, p_branch_id uuid, p_service_id uuid",
      get_public_availability_slots: "p_tenant_slug text, p_branch_id uuid, p_service_id uuid, p_date date, p_staff_member_id uuid DEFAULT NULL::uuid",
    };
    for (const [name, sig] of Object.entries(expected)) {
      const rows = await testDb<{ args: string }[]>`
        select pg_get_function_arguments(p.oid) as args
        from pg_proc p where p.proname = ${name} and p.pronamespace = 'public'::regnamespace
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.args).toBe(sig);
    }
  });

  it("private helper functions have zero anon/authenticated/PUBLIC grants", async () => {
    const names = ["resolve_bookable_tenant", "is_public_branch_valid", "is_public_service_valid", "public_booking_confirmation", "create_guest_booking"];
    const rows = await testDb<{ name: string; proacl: string[] | null }[]>`
      select p.proname as name, p.proacl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname in ${testDb(names)}
    `;
    expect(rows.length).toBe(names.length);
    for (const row of rows) {
      expect(row.proacl).toEqual(["postgres=X/postgres"]);
    }
  });

  it("default privileges audit remains at its established baseline (no new leak)", async () => {
    const rows = await testDb<{ grantee: string }[]>`select * from public.security_audit_default_privileges()`;
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.grantee).toBe("service_role");
    }
  });
});
