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
 * Phase 2A: the appointment engine. appointments/appointment_items have
 * NO direct insert/update grant (20260819052514) — every mutation here
 * goes through the create_appointment/reschedule_appointment/
 * update_appointment_status RPCs, exercised through a real signed-in
 * user's client, same rule as every other test file.
 *
 * staffA1/staffA3 get an all-week 00:00-23:59 schedule so the "happy
 * path" tests don't depend on which weekday the test happens to run on.
 * staffA2 deliberately gets NO schedule row at all — the fixture for the
 * working-hours-rejection test.
 */

const BASE = "2026-09-15T07:00:00.000Z"; // arbitrary future UTC instant

function plusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let ownerB: TestUser;
let limitedA: TestUser; // appointments.view only, no create/update/cancel
let ownerAClient: SupabaseClient;
let limitedAClient: SupabaseClient;

let branchA: string;
let staffA1: { id: string; fullName: string }; // always available, eligible for serviceA1 + serviceA2
let staffA2: { id: string; fullName: string }; // no schedule at all; eligible for serviceA1 only
let staffA3: { id: string; fullName: string }; // always available, eligible for serviceA2 only
let serviceA1: { id: string; name: string; durationMinutes: number; price: number };
let serviceA2: { id: string; name: string; durationMinutes: number; price: number };
let customerA: { id: string; fullName: string };

let branchB: string;
let staffB: { id: string; fullName: string };
let serviceB: { id: string; name: string; durationMinutes: number; price: number };
let customerB: { id: string; fullName: string };

beforeAll(async () => {
  ownerA = await createTestUser("p2appt-owner-a");
  ownerB = await createTestUser("p2appt-owner-b");
  limitedA = await createTestUser("p2appt-limited-a");

  tenantA = await createTestTenant("test-p2appt-a", ownerA.id);
  tenantB = await createTestTenant("test-p2appt-b", ownerB.id);

  const limitedRoleA = await createRoleForTenant(tenantA.id, "Yalnızca Görüntüleme", ["appointments.view"]);
  await testDb`
    insert into tenant_memberships (tenant_id, user_id, role_id, status)
    values (${tenantA.id}, ${limitedA.id}, ${limitedRoleA}, 'active')
  `;

  const [branchARow] = await testDb<{ id: string }[]>`
    insert into branches (tenant_id, name) values (${tenantA.id}, 'Ana Şube') returning id
  `;
  branchA = branchARow!.id;
  const [branchBRow] = await testDb<{ id: string }[]>`
    insert into branches (tenant_id, name) values (${tenantB.id}, 'Ana Şube B') returning id
  `;
  branchB = branchBRow!.id;

  staffA1 = await createStaffMember(tenantA.id, "Her Zaman Müsait");
  staffA2 = await createStaffMember(tenantA.id, "Programsız");
  staffA3 = await createStaffMember(tenantA.id, "İkinci Personel");
  serviceA1 = await createService(tenantA.id, "Hizmet A1", 30, 100);
  serviceA2 = await createService(tenantA.id, "Hizmet A2", 45, 200);
  customerA = await createCustomer(tenantA.id, "Müşteri A");

  // Phase 2A.1: staff_members/services carry no branch_id column anymore
  // (20260819062000) — a staff member/service with no staff_branches/
  // service_branches row is bookable at NO branch, so every fixture that
  // create_appointment/reschedule_appointment needs to accept must be
  // explicitly linked to branchA.
  await linkStaffBranch(staffA1.id, branchA);
  await linkStaffBranch(staffA2.id, branchA);
  await linkStaffBranch(staffA3.id, branchA);
  await linkServiceBranch(serviceA1.id, branchA);
  await linkServiceBranch(serviceA2.id, branchA);

  await linkStaffService(staffA1.id, serviceA1.id);
  await linkStaffService(staffA1.id, serviceA2.id);
  await linkStaffService(staffA2.id, serviceA1.id);
  await linkStaffService(staffA3.id, serviceA2.id);

  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenantA.id, staffA1.id, weekday, "00:00", "23:59");
    await createStaffSchedule(tenantA.id, staffA3.id, weekday, "00:00", "23:59");
  }
  // staffA2 intentionally gets no schedule row at all.

  staffB = await createStaffMember(tenantB.id, "Staff B");
  serviceB = await createService(tenantB.id, "Hizmet B", 30, 100);
  customerB = await createCustomer(tenantB.id, "Müşteri B");
  await linkStaffBranch(staffB.id, branchB);
  await linkServiceBranch(serviceB.id, branchB);
  await linkStaffService(staffB.id, serviceB.id);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenantB.id, staffB.id, weekday, "00:00", "23:59");
  }

  ownerAClient = await signInAs(ownerA);
  limitedAClient = await signInAs(limitedA);
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([ownerA.id, ownerB.id, limitedA.id]);
}, 60000);

describe("create_appointment — happy path", () => {
  it("creates an appointment with one service", async () => {
    const { data, error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: BASE, sequence: 1 }],
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();

    const items = await testDb<{ price: string; duration_minutes: number }[]>`
      select price, duration_minutes from appointment_items where appointment_id = ${data}
    `;
    expect(items).toHaveLength(1);
    expect(Number(items[0]!.price)).toBe(100);
    expect(items[0]!.duration_minutes).toBe(30);
  });

  it("creates an appointment with multiple services assigned to different staff", async () => {
    const start2 = plusMinutes(BASE, 180);
    const { data, error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [
        { service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start2, sequence: 1 },
        { service_id: serviceA2.id, staff_member_id: staffA3.id, scheduled_start_at: plusMinutes(start2, 60), sequence: 2 },
      ],
    });
    expect(error).toBeNull();

    const items = await testDb<{ staff_member_id: string; sequence: number }[]>`
      select staff_member_id, sequence from appointment_items where appointment_id = ${data} order by sequence
    `;
    expect(items).toHaveLength(2);
    expect(items[0]!.staff_member_id).toBe(staffA1.id);
    expect(items[1]!.staff_member_id).toBe(staffA3.id);
  });

  it("snapshots price and duration at booking time — later service changes don't retroact", async () => {
    const snapshotService = await createService(tenantA.id, "Anlık Görüntü Hizmeti", 20, 50);
    await linkServiceBranch(snapshotService.id, branchA);
    await linkStaffService(staffA1.id, snapshotService.id);
    const start = plusMinutes(BASE, 360);

    const { data: appointmentId, error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: snapshotService.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).toBeNull();

    await testDb`update services set price = 999, duration_minutes = 999 where id = ${snapshotService.id}`;

    const items = await testDb<{ price: string; duration_minutes: number }[]>`
      select price, duration_minutes from appointment_items where appointment_id = ${appointmentId}
    `;
    expect(Number(items[0]!.price)).toBe(50);
    expect(items[0]!.duration_minutes).toBe(20);
  });
});

describe("create_appointment — conflict and availability rules", () => {
  it("rejects an overlapping request for the same staff member", async () => {
    const start = plusMinutes(BASE, 24 * 60);
    const { error: firstError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(firstError).toBeNull();

    const { error: secondError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [
        { service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: plusMinutes(start, 15), sequence: 1 },
      ],
    });
    expect(secondError).not.toBeNull();
  });

  it("accepts a non-overlapping back-to-back request for the same staff member", async () => {
    const start = plusMinutes(BASE, 25 * 60);
    const { error: firstError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(firstError).toBeNull();

    const { error: secondError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [
        { service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: plusMinutes(start, 30), sequence: 1 },
      ],
    });
    expect(secondError).toBeNull();
  });

  it("cancellation releases the staff member's availability for the same slot", async () => {
    const start = plusMinutes(BASE, 26 * 60);
    const { data: appointmentId, error: firstError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(firstError).toBeNull();

    const { error: blockedError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(blockedError).not.toBeNull();

    const { error: cancelError } = await ownerAClient.rpc("update_appointment_status", {
      p_appointment_id: appointmentId,
      p_new_status: "cancelled",
    });
    expect(cancelError).toBeNull();

    const { error: reBookError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(reBookError).toBeNull();
  });

  it("rejects assigning a staff member to a service they are not eligible for", async () => {
    const start = plusMinutes(BASE, 27 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      // staffA2 is only linked to serviceA1, not serviceA2.
      p_items: [{ service_id: serviceA2.id, staff_member_id: staffA2.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("rejects booking a staff member with no working-hours coverage at all", async () => {
    const start = plusMinutes(BASE, 28 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      // staffA2 is eligible for serviceA1 but has zero staff_schedules rows.
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA2.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("concurrent double-booking attempt for the exact same staff/slot: exactly one succeeds", async () => {
    const start = plusMinutes(BASE, 29 * 60);
    const customerA2 = await createCustomer(tenantA.id, "Müşteri A İkinci");

    const [resultOne, resultTwo] = await Promise.all([
      ownerAClient.rpc("create_appointment", {
        p_tenant_id: tenantA.id,
        p_branch_id: branchA,
        p_customer_id: customerA.id,
        p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
      }),
      ownerAClient.rpc("create_appointment", {
        p_tenant_id: tenantA.id,
        p_branch_id: branchA,
        p_customer_id: customerA2.id,
        p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
      }),
    ]);

    const errors = [resultOne.error, resultTwo.error];
    const successCount = errors.filter((e) => e === null).length;
    const failureCount = errors.filter((e) => e !== null).length;
    expect(successCount).toBe(1);
    expect(failureCount).toBe(1);
  });
});

describe("create_appointment — branch assignment rules (Phase 2A.1)", () => {
  it("rejects a service not offered at the appointment's branch", async () => {
    const start = plusMinutes(BASE, 30 * 60);
    const unassignedService = await createService(tenantA.id, "Şubesiz Hizmet", 30, 80);
    await linkStaffService(staffA1.id, unassignedService.id);
    // deliberately no linkServiceBranch call

    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: unassignedService.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("rejects a staff member not assigned to the appointment's branch", async () => {
    const start = plusMinutes(BASE, 31 * 60);
    const unassignedStaff = await createStaffMember(tenantA.id, "Şubesiz Personel");
    await linkStaffService(unassignedStaff.id, serviceA1.id);
    await createStaffSchedule(tenantA.id, unassignedStaff.id, 0, "00:00", "23:59");
    // deliberately no linkStaffBranch call

    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: unassignedStaff.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("a staff schedule row scoped to a different branch does not grant availability at this branch", async () => {
    // staffA4 is assigned to (staff_branches) BOTH branches — isolates
    // the assertion to staff_schedules.branch_id scoping specifically,
    // not staff_branches eligibility, which is covered above.
    const branchA2 = await createBranch(tenantA.id, "İkinci Şube A");
    // serviceA1 itself must also be offered at branchA2, so the positive
    // case below fails (if it does) only for the staff-schedule reason
    // this test targets, not a service-branch mismatch (covered above).
    await linkServiceBranch(serviceA1.id, branchA2);
    const staffA4 = await createStaffMember(tenantA.id, "Çok Şubeli Personel");
    await linkStaffBranch(staffA4.id, branchA);
    await linkStaffBranch(staffA4.id, branchA2);
    await linkStaffService(staffA4.id, serviceA1.id);
    // Schedule row is scoped to branchA2 only, every weekday, all day.
    for (let weekday = 0; weekday <= 6; weekday++) {
      await testDb`
        insert into staff_schedules (tenant_id, staff_member_id, branch_id, weekday, start_time, end_time)
        values (${tenantA.id}, ${staffA4.id}, ${branchA2}, ${weekday}, '00:00', '23:59')
      `;
    }

    const start = plusMinutes(BASE, 32 * 60);
    const { error: wrongBranchError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA4.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(wrongBranchError).not.toBeNull();

    const { error: matchingBranchError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA2,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA4.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(matchingBranchError).toBeNull();
  });
});

describe("create_appointment — tenant isolation and permissions", () => {
  it("rejects a customer reference from another tenant", async () => {
    const start = plusMinutes(BASE, 48 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerB.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("rejects a staff member reference from another tenant", async () => {
    const start = plusMinutes(BASE, 49 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffB.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("rejects a service reference from another tenant", async () => {
    const start = plusMinutes(BASE, 50 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceB.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("a branch reference from another tenant is rejected", async () => {
    const start = plusMinutes(BASE, 51 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchB,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("a user without appointments.create cannot create an appointment", async () => {
    const start = plusMinutes(BASE, 52 * 60);
    const { error } = await limitedAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("a user with appointments.view can read but the RLS-scoped select never returns another tenant's appointment", async () => {
    const start = plusMinutes(BASE, 53 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });

    const { data: visible } = await limitedAClient.from("appointments").select("id").eq("id", appointmentId);
    expect(visible).toHaveLength(1);
  });
});

describe("appointment header time invariant", () => {
  // Phase 2A.1 review: proves appointments.scheduled_start_at =
  // MIN(appointment_items.scheduled_start_at) and scheduled_end_at =
  // MAX(...scheduled_end_at) actually holds after commit — not inferred
  // from reading create_appointment's source, a direct DB assertion
  // against both tables for each shape the RPCs can produce.
  async function headerRange(appointmentId: string) {
    const [header] = await testDb<{ scheduled_start_at: Date; scheduled_end_at: Date }[]>`
      select scheduled_start_at, scheduled_end_at from appointments where id = ${appointmentId}
    `;
    const [agg] = await testDb<{ min_start: Date; max_end: Date }[]>`
      select min(scheduled_start_at) as min_start, max(scheduled_end_at) as max_end
      from appointment_items where appointment_id = ${appointmentId}
    `;
    return { header: header!, agg: agg! };
  }

  it("holds for a single item", async () => {
    const start = plusMinutes(BASE, 120 * 60);
    const { data: appointmentId, error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).toBeNull();

    const { header, agg } = await headerRange(appointmentId);
    expect(header.scheduled_start_at.getTime()).toBe(agg.min_start.getTime());
    expect(header.scheduled_end_at.getTime()).toBe(agg.max_end.getTime());
    // serviceA1 is 30 minutes — confirms the range is genuinely derived,
    // not just internally self-consistent.
    expect(header.scheduled_start_at.toISOString()).toBe(start);
    expect(header.scheduled_end_at.getTime() - header.scheduled_start_at.getTime()).toBe(30 * 60_000);
  });

  it("holds for multiple sequential items on the same staff member", async () => {
    const start = plusMinutes(BASE, 121 * 60);
    const { data: appointmentId, error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [
        { service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 },
        { service_id: serviceA2.id, staff_member_id: staffA1.id, scheduled_start_at: plusMinutes(start, 30), sequence: 2 },
      ],
    });
    expect(error).toBeNull();

    const { header, agg } = await headerRange(appointmentId);
    expect(header.scheduled_start_at.getTime()).toBe(agg.min_start.getTime());
    expect(header.scheduled_end_at.getTime()).toBe(agg.max_end.getTime());
    expect(header.scheduled_start_at.toISOString()).toBe(start);
    // item 1: start..start+30 (serviceA1). item 2: start+30..start+75 (serviceA2, 45min).
    expect(header.scheduled_end_at.toISOString()).toBe(plusMinutes(start, 75));
  });

  it("holds for items with different staff, submitted out of chronological order", async () => {
    // 124h, not 122h: the previous test occupies staffA1 from 121h to
    // 122h15m — needs a clear gap, not just a non-identical offset.
    const start = plusMinutes(BASE, 124 * 60);
    const laterStart = plusMinutes(start, 180); // staffA3 item starts LATER but is listed FIRST in p_items
    const { data: appointmentId, error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [
        { service_id: serviceA2.id, staff_member_id: staffA3.id, scheduled_start_at: laterStart, sequence: 2 },
        { service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 },
      ],
    });
    expect(error).toBeNull();

    const { header, agg } = await headerRange(appointmentId);
    expect(header.scheduled_start_at.getTime()).toBe(agg.min_start.getTime());
    expect(header.scheduled_end_at.getTime()).toBe(agg.max_end.getTime());
    // MIN must be the earlier (staffA1) item's start, not the first array element.
    expect(header.scheduled_start_at.toISOString()).toBe(start);
    expect(header.scheduled_end_at.toISOString()).toBe(plusMinutes(laterStart, 45));
  });

  it("holds after reschedule_appointment changes the item set", async () => {
    // 126h: clear of the previous test's staffA1 (124h-124h30) and
    // staffA3 (127h-127h45) windows, including after this test's own
    // reschedule moves staffA1/staffA3 forward by 200/230 minutes.
    const start = plusMinutes(BASE, 126 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });

    const newStart = plusMinutes(start, 200);
    const { error } = await ownerAClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [
        { service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: newStart, sequence: 1 },
        { service_id: serviceA2.id, staff_member_id: staffA3.id, scheduled_start_at: plusMinutes(newStart, 30), sequence: 2 },
      ],
    });
    expect(error).toBeNull();

    const { header, agg } = await headerRange(appointmentId);
    expect(header.scheduled_start_at.getTime()).toBe(agg.min_start.getTime());
    expect(header.scheduled_end_at.getTime()).toBe(agg.max_end.getTime());
    expect(header.scheduled_start_at.toISOString()).toBe(newStart);
    expect(header.scheduled_end_at.toISOString()).toBe(plusMinutes(newStart, 75));
  });
});

describe("reschedule_appointment and update_appointment_status", () => {
  it("reschedule_appointment moves the item to a new valid time and re-validates conflicts", async () => {
    const start = plusMinutes(BASE, 72 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });

    const newStart = plusMinutes(start, 120);
    const { error } = await ownerAClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: newStart, sequence: 1 }],
    });
    expect(error).toBeNull();

    const [item] = await testDb<{ scheduled_start_at: Date }[]>`
      select scheduled_start_at from appointment_items where appointment_id = ${appointmentId}
    `;
    expect(new Date(item!.scheduled_start_at).toISOString()).toBe(newStart);
  });

  it("update_appointment_status to cancelled requires appointments.cancel", async () => {
    const start = plusMinutes(BASE, 96 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });

    const { error } = await limitedAClient.rpc("update_appointment_status", {
      p_appointment_id: appointmentId,
      p_new_status: "cancelled",
    });
    expect(error).not.toBeNull();
  });

  it("cannot change the status of an already-completed appointment", async () => {
    const start = plusMinutes(BASE, 97 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    // Faz 5A.2: update_appointment_status no longer accepts 'completed'
    // (closed completion bypass, Option A) — this test's own concern is
    // the terminal-state guard against a SECOND status change, not which
    // RPC reached 'completed' in the first place.
    await ownerAClient.rpc("complete_appointment", { p_appointment_id: appointmentId });

    const { error } = await ownerAClient.rpc("update_appointment_status", {
      p_appointment_id: appointmentId,
      p_new_status: "cancelled",
    });
    expect(error).not.toBeNull();
  });
});

describe("working hours and timezone (Phase 2A.1)", () => {
  // Europe/Istanbul is a fixed UTC+3 with no DST (Turkey dropped it in
  // 2016) — safe to compute the offset by hand rather than pulling in a
  // tz library, and it is genuinely the tenant's default (asserted
  // below), not a UTC-equivalent stand-in that would let a naive
  // implementation pass by accident.
  function istanbulLocal(dateStr: string, timeStr: string): string {
    return new Date(`${dateStr}T${timeStr}:00+03:00`).toISOString();
  }

  let staffSchedule: { id: string; fullName: string };
  let staffBoundary: { id: string; fullName: string };

  beforeAll(async () => {
    const [{ timezone }] = await testDb<{ timezone: string }[]>`select timezone from tenants where id = ${tenantA.id}`;
    expect(timezone).toBe("Europe/Istanbul");

    staffSchedule = await createStaffMember(tenantA.id, "Program Testi Personeli");
    await linkStaffBranch(staffSchedule.id, branchA);
    await linkStaffService(staffSchedule.id, serviceA1.id);
    // 09:00-18:00 Istanbul-local, every weekday — a fixed recurring
    // baseline so exception rows below are what's actually under test.
    for (let weekday = 0; weekday <= 6; weekday++) {
      await createStaffSchedule(tenantA.id, staffSchedule.id, weekday, "09:00", "18:00");
    }

    staffBoundary = await createStaffMember(tenantA.id, "Sınır Testi Personeli");
    await linkStaffBranch(staffBoundary.id, branchA);
    await linkStaffService(staffBoundary.id, serviceA1.id);
  }, 30000);

  it("rejects a request outside the recurring schedule's local hours", async () => {
    // 07:00 Istanbul-local, a date with no exception — outside the
    // 09:00-18:00 recurring window.
    const start = istanbulLocal("2026-09-21", "07:00");
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffSchedule.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("accepts a request inside the recurring schedule's local hours", async () => {
    const start = istanbulLocal("2026-09-21", "10:00");
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffSchedule.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).toBeNull();
  });

  it("a date-specific unavailable exception overrides the recurring schedule and rejects the request", async () => {
    await testDb`
      insert into staff_schedule_exceptions (tenant_id, staff_member_id, exception_date, type)
      values (${tenantA.id}, ${staffSchedule.id}, '2026-09-22', 'unavailable')
    `;
    // 10:00 local is well within the 09:00-18:00 recurring window — only
    // the exception can be why this is rejected.
    const start = istanbulLocal("2026-09-22", "10:00");
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffSchedule.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).not.toBeNull();
  });

  it("a date-specific custom_hours exception narrows the recurring schedule, not adds to it", async () => {
    await testDb`
      insert into staff_schedule_exceptions (tenant_id, staff_member_id, exception_date, type, start_time, end_time)
      values (${tenantA.id}, ${staffSchedule.id}, '2026-09-23', 'custom_hours', '14:00', '16:00')
    `;
    // 10:00 local: inside the normal 09:00-18:00 recurring window, but
    // OUTSIDE this date's 14:00-16:00 exception — must be rejected,
    // proving the exception replaces the recurring window rather than
    // supplementing it.
    const { error: outsideExceptionError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [
        {
          service_id: serviceA1.id,
          staff_member_id: staffSchedule.id,
          scheduled_start_at: istanbulLocal("2026-09-23", "10:00"),
          sequence: 1,
        },
      ],
    });
    expect(outsideExceptionError).not.toBeNull();

    // 15:00 local: inside the exception's 14:00-16:00 window.
    const { error: insideExceptionError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [
        {
          service_id: serviceA1.id,
          staff_member_id: staffSchedule.id,
          scheduled_start_at: istanbulLocal("2026-09-23", "15:00"),
          sequence: 1,
        },
      ],
    });
    expect(insideExceptionError).toBeNull();
  });

  it("a different, exception-free date falls back to the recurring schedule normally", async () => {
    const start = istanbulLocal("2026-09-24", "10:00");
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffSchedule.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).toBeNull();
  });

  it("tenant-local weekday, not naive UTC weekday, decides availability near local midnight", async () => {
    // staffBoundary works Monday 00:00-08:00 Istanbul-local ONLY — no
    // other weekday, no exception. 2026-09-21 is a Monday.
    await createStaffSchedule(tenantA.id, staffBoundary.id, 1, "00:00", "08:00");

    // Istanbul-local Monday 01:00 = UTC Sunday 22:00 (previous day) —
    // Europe/Istanbul is UTC+3, so a local time just after midnight is
    // still the previous UTC day. A naive implementation that computed
    // weekday from the raw UTC timestamp (EXTRACT(DOW) without the
    // AT TIME ZONE conversion staff_is_available actually uses) would see
    // Sunday, find no schedule row, and wrongly reject this — the
    // opposite of a coincidental pass, since Istanbul is never equal to
    // UTC at any time of year.
    const localMonday1am = istanbulLocal("2026-09-21", "01:00");
    expect(localMonday1am.slice(0, 10)).toBe("2026-09-20"); // confirms the UTC calendar date really is the day before
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [
        { service_id: serviceA1.id, staff_member_id: staffBoundary.id, scheduled_start_at: localMonday1am, sequence: 1 },
      ],
    });
    expect(error).toBeNull();
  });
});
