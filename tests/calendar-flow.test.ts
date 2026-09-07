import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createCustomer,
  createRoleForTenant,
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
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Phase 2E — the operational calendar's own read query
 * (getCalendarItems / fetchCalendarItems in lib/modules/appointments/
 * {queries,client-queries}.ts) is a direct PostgREST range query, not an
 * RPC — there is nothing new to grant or authorize, so this exercises
 * the exact same select/filter shape those two functions use, via a
 * real signed-in client, the same "verify the actual query behavior,
 * not the TypeScript wrapper" convention every other test file in this
 * project already follows (queries.ts itself can't run outside a Next
 * request context anyway).
 */

// Bridge (compatibility): kept byte-identical to
// lib/modules/appointments/client-queries.ts's own CALENDAR_ITEM_SELECT
// (this test file's whole point) — see that file's comment for why the
// explicit FK name is required, not stylistic.
const CALENDAR_ITEM_SELECT = `
  id, appointment_id, sequence, scheduled_start_at, scheduled_end_at, appointment_status,
  services(name),
  staff_members!appointment_items_staff_member_id_fkey(id, full_name),
  appointments!inner(branch_id, customers(full_name))
`;

async function queryCalendarItems(
  client: SupabaseClient,
  tenantId: string,
  branchId: string,
  rangeStartUtc: string,
  rangeEndUtc: string,
) {
  return client
    .from("appointment_items")
    .select(CALENDAR_ITEM_SELECT)
    .eq("tenant_id", tenantId)
    .eq("appointments.branch_id", branchId)
    .neq("appointment_status", "cancelled")
    .lt("scheduled_start_at", rangeEndUtc)
    .gt("scheduled_end_at", rangeStartUtc)
    .order("scheduled_start_at", { ascending: true });
}

const BASE = "2026-11-02T07:00:00.000Z"; // arbitrary future UTC instant, disjoint from every other test file's own BASE

function plusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let ownerB: TestUser;
let viewOnlyA: TestUser;
let zeroPermA: TestUser;
let ownerAClient: SupabaseClient;
let ownerBClient: SupabaseClient;
let viewOnlyAClient: SupabaseClient;
let zeroPermAClient: SupabaseClient;

let branchA: string;
let branchA2: string;
let staffA1: { id: string; fullName: string };
let staffA2: { id: string; fullName: string };
let serviceA1: { id: string; name: string; durationMinutes: number; price: number };
let serviceA2: { id: string; name: string; durationMinutes: number; price: number };
let customerA: { id: string; fullName: string };

let branchB: string;
let staffB: { id: string; fullName: string };
let serviceB: { id: string; name: string; durationMinutes: number; price: number };
let customerB: { id: string; fullName: string };

beforeAll(async () => {
  ownerA = await createTestUser("p2e-owner-a");
  ownerB = await createTestUser("p2e-owner-b");
  viewOnlyA = await createTestUser("p2e-view-a");
  zeroPermA = await createTestUser("p2e-zeroperm-a");

  tenantA = await createTestTenant("test-p2e-a", ownerA.id);
  tenantB = await createTestTenant("test-p2e-b", ownerB.id);

  const viewOnlyRole = await createRoleForTenant(tenantA.id, "Yalnızca Görüntüleme", ["appointments.view"]);
  const zeroPermRole = await createRoleForTenant(tenantA.id, "Yetkisiz", []);
  await testDb`
    insert into tenant_memberships (tenant_id, user_id, role_id, status) values
    (${tenantA.id}, ${viewOnlyA.id}, ${viewOnlyRole}, 'active'),
    (${tenantA.id}, ${zeroPermA.id}, ${zeroPermRole}, 'active')
  `;

  branchA = await createBranch(tenantA.id, "Ana Şube");
  branchA2 = await createBranch(tenantA.id, "İkinci Şube");
  staffA1 = await createStaffMember(tenantA.id, "Ayşe Yılmaz");
  staffA2 = await createStaffMember(tenantA.id, "Mehmet Demir");
  serviceA1 = await createService(tenantA.id, "Saç Kesimi", 30, 250);
  serviceA2 = await createService(tenantA.id, "Boya", 90, 800);
  customerA = await createCustomer(tenantA.id, "Elif Şahin");

  await linkStaffBranch(staffA1.id, branchA);
  await linkStaffBranch(staffA1.id, branchA2); // needed for the branch-filtering test's branchA2 booking
  await linkStaffBranch(staffA2.id, branchA);
  await linkServiceBranch(serviceA1.id, branchA);
  await linkServiceBranch(serviceA2.id, branchA);
  await linkServiceBranch(serviceA1.id, branchA2);
  await linkStaffService(staffA1.id, serviceA1.id);
  await linkStaffService(staffA1.id, serviceA2.id);
  await linkStaffService(staffA2.id, serviceA1.id);
  for (const staff of [staffA1, staffA2]) {
    for (let weekday = 0; weekday <= 6; weekday++) {
      await createStaffSchedule(tenantA.id, staff.id, weekday, "00:00", "23:59");
    }
  }

  branchB = await createBranch(tenantB.id, "Ana Şube B");
  staffB = await createStaffMember(tenantB.id, "Personel B");
  serviceB = await createService(tenantB.id, "Hizmet B", 30, 100);
  customerB = await createCustomer(tenantB.id, "Müşteri B");
  await linkStaffBranch(staffB.id, branchB);
  await linkServiceBranch(serviceB.id, branchB);
  await linkStaffService(staffB.id, serviceB.id);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenantB.id, staffB.id, weekday, "00:00", "23:59");
  }

  ownerAClient = await signInAs(ownerA);
  ownerBClient = await signInAs(ownerB);
  viewOnlyAClient = await signInAs(viewOnlyA);
  zeroPermAClient = await signInAs(zeroPermA);
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([ownerA.id, ownerB.id, viewOnlyA.id, zeroPermA.id]);
}, 60000);

// PostgREST serializes timestamptz as "...+00:00", never matching a
// JS toISOString() "...Z" string byte-for-byte even for the identical
// instant — confirmed directly against DEV before writing these tests.
// Every check below therefore keys on appointment_id (returned by
// create_appointment itself), never on a raw scheduled_start_at string
// comparison.
type CalendarRow = { appointment_id: string };

describe("calendar range query — overlap and exclusion", () => {
  it("an item starting before the range but ending inside it IS included (overlap, not BETWEEN)", async () => {
    const start = plusMinutes(BASE, 0 * 60);
    const { data: appointmentId, error: bookError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(bookError).toBeNull();

    // Item occupies [start, start+30). Range window starts 10 minutes
    // into that item and would miss it entirely under a naive
    // "start BETWEEN rangeStart AND rangeEnd" query.
    const rangeStart = plusMinutes(start, 10);
    const rangeEnd = plusMinutes(start, 60);
    const { data, error } = await queryCalendarItems(ownerAClient, tenantA.id, branchA, rangeStart, rangeEnd);
    expect(error).toBeNull();
    expect((data as unknown as CalendarRow[]).some((r) => r.appointment_id === appointmentId)).toBe(true);
  });

  it("an item entirely outside the range is excluded", async () => {
    const start = plusMinutes(BASE, 1 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });

    // A range window well after this item's [start, start+30) end.
    const rangeStart = plusMinutes(start, 120);
    const rangeEnd = plusMinutes(start, 180);
    const { data } = await queryCalendarItems(ownerAClient, tenantA.id, branchA, rangeStart, rangeEnd);
    expect((data as unknown as CalendarRow[]).some((r) => r.appointment_id === appointmentId)).toBe(false);
  });

  it("branch filtering: an appointment at branchA2 never appears in branchA's calendar query", async () => {
    const start = plusMinutes(BASE, 2 * 60);
    const { data: appointmentId, error: bookError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA2,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(bookError).toBeNull();

    const rangeStart = plusMinutes(start, -30);
    const rangeEnd = plusMinutes(start, 60);
    const { data: branchAResults } = await queryCalendarItems(ownerAClient, tenantA.id, branchA, rangeStart, rangeEnd);
    expect((branchAResults as unknown as CalendarRow[]).some((r) => r.appointment_id === appointmentId)).toBe(false);

    const { data: branchA2Results } = await queryCalendarItems(ownerAClient, tenantA.id, branchA2, rangeStart, rangeEnd);
    expect((branchA2Results as unknown as CalendarRow[]).some((r) => r.appointment_id === appointmentId)).toBe(true);
  });

  it("tenant isolation: a tenantB appointment never appears in a tenantA-scoped query, even for the same UTC window", async () => {
    const start = plusMinutes(BASE, 3 * 60);
    await ownerBClient.rpc("create_appointment", {
      p_tenant_id: tenantB.id,
      p_branch_id: branchB,
      p_customer_id: customerB.id,
      p_items: [{ service_id: serviceB.id, staff_member_id: staffB.id, scheduled_start_at: start, sequence: 1 }],
    });

    const rangeStart = plusMinutes(start, -30);
    const rangeEnd = plusMinutes(start, 60);
    // ownerA has no membership in tenantB — RLS must return nothing
    // regardless of which tenant_id/branch_id is requested.
    const { data } = await queryCalendarItems(ownerAClient, tenantB.id, branchB, rangeStart, rangeEnd);
    expect(data ?? []).toHaveLength(0);
  });
});

describe("calendar item model — appointment_items, not headers", () => {
  it("a multi-service appointment with different staff produces multiple rows sharing one appointment_id", async () => {
    const start = plusMinutes(BASE, 10 * 60);
    const { data: appointmentId, error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [
        { service_id: serviceA2.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 },
        { service_id: serviceA1.id, staff_member_id: staffA2.id, scheduled_start_at: plusMinutes(start, 90), sequence: 2 },
      ],
    });
    expect(error).toBeNull();

    const rangeStart = plusMinutes(start, -30);
    const rangeEnd = plusMinutes(start, 180);
    const { data } = await queryCalendarItems(ownerAClient, tenantA.id, branchA, rangeStart, rangeEnd);
    type Row = { appointment_id: string; staff_members: { id: string; full_name: string } | null; appointments: { customers: { full_name: string } | null } | null };
    const rows = (data as unknown as Row[]).filter((r) => r.appointment_id === appointmentId);

    expect(rows).toHaveLength(2);
    // Different staff members...
    const staffIds = new Set(rows.map((r) => r.staff_members?.id));
    expect(staffIds.size).toBe(2);
    expect(staffIds.has(staffA1.id)).toBe(true);
    expect(staffIds.has(staffA2.id)).toBe(true);
    // ...but the same appointment_id and the same grouped customer —
    // this is the "same customer journey, one appointment, two staff
    // columns" shape the calendar's grouping (appointmentItemCounts in
    // day-view.tsx/week-view.tsx) depends on.
    for (const row of rows) {
      expect(row.appointments?.customers?.full_name).toBe(customerA.fullName);
    }
  });
});

describe("calendar status behavior", () => {
  it("a cancelled appointment's items are excluded from the default calendar query", async () => {
    const start = plusMinutes(BASE, 20 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    await ownerAClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });

    const rangeStart = plusMinutes(start, -30);
    const rangeEnd = plusMinutes(start, 60);
    const { data } = await queryCalendarItems(ownerAClient, tenantA.id, branchA, rangeStart, rangeEnd);
    type Row = { appointment_id: string };
    expect((data as unknown as Row[]).some((r) => r.appointment_id === appointmentId)).toBe(false);
  });

  it("a completed appointment's items remain visible in the calendar query", async () => {
    const start = plusMinutes(BASE, 21 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    await ownerAClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "completed" });

    const rangeStart = plusMinutes(start, -30);
    const rangeEnd = plusMinutes(start, 60);
    const { data } = await queryCalendarItems(ownerAClient, tenantA.id, branchA, rangeStart, rangeEnd);
    type Row = { appointment_id: string; appointment_status: string };
    const row = (data as unknown as Row[]).find((r) => r.appointment_id === appointmentId);
    expect(row).toBeTruthy();
    expect(row!.appointment_status).toBe("completed");
  });
});

describe("calendar permissions", () => {
  it("appointments.view can read the calendar range", async () => {
    const start = plusMinutes(BASE, 30 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    const rangeStart = plusMinutes(start, -30);
    const rangeEnd = plusMinutes(start, 60);
    const { data, error } = await queryCalendarItems(viewOnlyAClient, tenantA.id, branchA, rangeStart, rangeEnd);
    expect(error).toBeNull();
    expect((data as unknown as CalendarRow[]).some((r) => r.appointment_id === appointmentId)).toBe(true);
  });

  it("a member with no appointments.view permission reads an empty calendar range (RLS, not an error)", async () => {
    const start = plusMinutes(BASE, 31 * 60);
    await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    const rangeStart = plusMinutes(start, -30);
    const rangeEnd = plusMinutes(start, 60);
    const { data, error } = await queryCalendarItems(zeroPermAClient, tenantA.id, branchA, rangeStart, rangeEnd);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("view-only still cannot create an appointment from a calendar quick-create (mutation permission unchanged)", async () => {
    const start = plusMinutes(BASE, 32 * 60);
    const { error } = await viewOnlyAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error?.code).toBe("AP002");
  });
});

describe("quick-create-from-calendar correctness", () => {
  it("a staff member clicked on the calendar who is NOT eligible for the operator's chosen service is still rejected — DB remains authoritative", async () => {
    // Mirrors the calendar's own quick-create flow: the operator clicked
    // staffA2's column, but staffA2 is only eligible for serviceA1, not
    // serviceA2. The client-side "preferred staff" convenience (see
    // AppointmentItemsEditor's preferredStaffMemberId) never applies an
    // ineligible pairing — but this proves the actual safety net is the
    // RPC itself, independent of whatever the client attempted.
    const start = plusMinutes(BASE, 40 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA2.id, staff_member_id: staffA2.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error?.code).toBe("AP010");
  });

  it("a staff member clicked on the calendar who IS eligible for the chosen service succeeds normally", async () => {
    const start = plusMinutes(BASE, 41 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA2.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).toBeNull();
  });
});
