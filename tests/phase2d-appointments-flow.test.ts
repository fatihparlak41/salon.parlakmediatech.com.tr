import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anonClient,
  cleanupTenants,
  cleanupUsers,
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
 * Phase 2D — covers what phase2-appointments.test.ts (31 tests, Phase
 * 2A/2A.1, unchanged) does NOT already prove:
 *  1. The stable AP0nn error codes added in 20260822090000 — that suite
 *     only asserts `error).not.toBeNull()`, never the code itself.
 *  2. public.check_appointment_availability (20260822091500) — entirely
 *     new, zero prior coverage.
 *  3. The fine-grained appointments.update vs appointments.cancel
 *     branching in update_appointment_status — the existing suite only
 *     proves the cancel branch requires appointments.cancel, never that
 *     a NON-cancel transition specifically requires appointments.update
 *     (a role holding create+cancel but not update is the only fixture
 *     that actually isolates this).
 *  4. Audit rows for create/reschedule/status-change/cancel — proven
 *     directly against audit_logs, no duplicates.
 *
 * Does NOT re-prove branch/eligibility/timezone/overlap/concurrency
 * business logic itself — that's 20260819052733's byte-for-byte-
 * unchanged logic, already exhaustively covered.
 */

const BASE = "2026-10-05T07:00:00.000Z"; // arbitrary future UTC instant, disjoint from phase2-appointments.test.ts's own BASE

function plusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let ownerB: TestUser;
let viewOnlyA: TestUser; // appointments.view only
let createCancelOnlyA: TestUser; // appointments.view + create + cancel, NOT update
let zeroPermA: TestUser; // tenant member, zero permissions

let ownerAClient: SupabaseClient;
let ownerBClient: SupabaseClient;
let viewOnlyAClient: SupabaseClient;
let createCancelOnlyAClient: SupabaseClient;
let zeroPermAClient: SupabaseClient;

let branchA: string;
let staffA1: { id: string; fullName: string };
let serviceA1: { id: string; name: string; durationMinutes: number; price: number };
let customerA: { id: string; fullName: string };

let serviceNoBranch: { id: string; name: string; durationMinutes: number; price: number };
let staffNoBranch: { id: string; fullName: string };
let serviceIneligible: { id: string; name: string; durationMinutes: number; price: number };
let staffNoSchedule: { id: string; fullName: string };
let inactiveService: { id: string; name: string; durationMinutes: number; price: number };
let inactiveStaff: { id: string; fullName: string };

// Phase 2D.1 — minimal tenantB booking fixture, for the p_exclude_appointment_id
// cross-tenant test only (tenantB previously only needed ownerB for the
// bare has_permission-false test above).
let branchB: string;
let staffB1: { id: string; fullName: string };
let serviceB1: { id: string; name: string; durationMinutes: number; price: number };
let customerB: { id: string; fullName: string };

beforeAll(async () => {
  ownerA = await createTestUser("p2d-owner-a");
  ownerB = await createTestUser("p2d-owner-b");
  viewOnlyA = await createTestUser("p2d-view-a");
  createCancelOnlyA = await createTestUser("p2d-createcancel-a");
  zeroPermA = await createTestUser("p2d-zeroperm-a");

  tenantA = await createTestTenant("test-p2d-a", ownerA.id);
  tenantB = await createTestTenant("test-p2d-b", ownerB.id);

  const viewOnlyRole = await createRoleForTenant(tenantA.id, "Yalnızca Görüntüleme", ["appointments.view"]);
  const createCancelRole = await createRoleForTenant(tenantA.id, "Oluştur ve İptal", [
    "appointments.view",
    "appointments.create",
    "appointments.cancel",
  ]);
  const zeroPermRole = await createRoleForTenant(tenantA.id, "Yetkisiz", []);
  await testDb`
    insert into tenant_memberships (tenant_id, user_id, role_id, status) values
    (${tenantA.id}, ${viewOnlyA.id}, ${viewOnlyRole}, 'active'),
    (${tenantA.id}, ${createCancelOnlyA.id}, ${createCancelRole}, 'active'),
    (${tenantA.id}, ${zeroPermA.id}, ${zeroPermRole}, 'active')
  `;

  const [branchARow] = await testDb<{ id: string }[]>`
    insert into branches (tenant_id, name) values (${tenantA.id}, 'Ana Şube') returning id
  `;
  branchA = branchARow!.id;

  staffA1 = await createStaffMember(tenantA.id, "Her Zaman Müsait");
  serviceA1 = await createService(tenantA.id, "Hizmet A1", 30, 100);
  customerA = await createCustomer(tenantA.id, "Müşteri A");
  await linkStaffBranch(staffA1.id, branchA);
  await linkServiceBranch(serviceA1.id, branchA);
  await linkStaffService(staffA1.id, serviceA1.id);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenantA.id, staffA1.id, weekday, "00:00", "23:59");
  }

  // AP007 fixture: eligible for staffA1, but never linked to branchA.
  serviceNoBranch = await createService(tenantA.id, "Şubesiz Hizmet", 30, 80);
  await linkStaffService(staffA1.id, serviceNoBranch.id);

  // AP009 fixture: eligible for serviceA1, has a schedule, but never
  // linked to branchA via staff_branches.
  staffNoBranch = await createStaffMember(tenantA.id, "Şubesiz Personel");
  await linkStaffService(staffNoBranch.id, serviceA1.id);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenantA.id, staffNoBranch.id, weekday, "00:00", "23:59");
  }

  // AP010 fixture: a service staffA1 is deliberately never linked to.
  serviceIneligible = await createService(tenantA.id, "Uygun Olmayan Hizmet", 30, 80);
  await linkServiceBranch(serviceIneligible.id, branchA);

  // AP011 fixture: assigned to branchA, eligible for serviceA1, zero staff_schedules rows.
  staffNoSchedule = await createStaffMember(tenantA.id, "Programsız Personel");
  await linkStaffBranch(staffNoSchedule.id, branchA);
  await linkStaffService(staffNoSchedule.id, serviceA1.id);

  // AP006 fixture: fully linked, then deactivated.
  inactiveService = await createService(tenantA.id, "Pasif Hizmet", 30, 80);
  await linkServiceBranch(inactiveService.id, branchA);
  await linkStaffService(staffA1.id, inactiveService.id);
  await testDb`update services set status = 'inactive' where id = ${inactiveService.id}`;

  // AP008 fixture: fully linked, then deactivated.
  inactiveStaff = await createStaffMember(tenantA.id, "Pasif Personel");
  await linkStaffBranch(inactiveStaff.id, branchA);
  await linkStaffService(inactiveStaff.id, serviceA1.id);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenantA.id, inactiveStaff.id, weekday, "00:00", "23:59");
  }
  await testDb`update staff_members set status = 'inactive' where id = ${inactiveStaff.id}`;

  const [branchBRow] = await testDb<{ id: string }[]>`
    insert into branches (tenant_id, name) values (${tenantB.id}, 'Ana Şube B') returning id
  `;
  branchB = branchBRow!.id;
  staffB1 = await createStaffMember(tenantB.id, "Personel B1");
  serviceB1 = await createService(tenantB.id, "Hizmet B1", 30, 100);
  customerB = await createCustomer(tenantB.id, "Müşteri B");
  await linkStaffBranch(staffB1.id, branchB);
  await linkServiceBranch(serviceB1.id, branchB);
  await linkStaffService(staffB1.id, serviceB1.id);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenantB.id, staffB1.id, weekday, "00:00", "23:59");
  }

  ownerAClient = await signInAs(ownerA);
  ownerBClient = await signInAs(ownerB);
  viewOnlyAClient = await signInAs(viewOnlyA);
  createCancelOnlyAClient = await signInAs(createCancelOnlyA);
  zeroPermAClient = await signInAs(zeroPermA);
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([ownerA.id, ownerB.id, viewOnlyA.id, createCancelOnlyA.id, zeroPermA.id]);
}, 60000);

describe("create_appointment — stable AP0nn error codes", () => {
  it("AP002 — permission denied without appointments.create", async () => {
    const start = plusMinutes(BASE, 1 * 60);
    const { error } = await viewOnlyAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error?.code).toBe("AP002");
  });

  it("AP003 — branch not found", async () => {
    const start = plusMinutes(BASE, 2 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: crypto.randomUUID(),
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error?.code).toBe("AP003");
  });

  it("AP004 — customer not found", async () => {
    const start = plusMinutes(BASE, 3 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: crypto.randomUUID(),
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error?.code).toBe("AP004");
  });

  it("AP005 — at least one item required", async () => {
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [],
    });
    expect(error?.code).toBe("AP005");
  });

  it("AP006 — service not found or inactive", async () => {
    const start = plusMinutes(BASE, 4 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: inactiveService.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error?.code).toBe("AP006");
  });

  it("AP007 — service not offered at this branch", async () => {
    const start = plusMinutes(BASE, 5 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceNoBranch.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error?.code).toBe("AP007");
  });

  it("AP008 — staff member not found or inactive", async () => {
    const start = plusMinutes(BASE, 6 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: inactiveStaff.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error?.code).toBe("AP008");
  });

  it("AP009 — staff member does not work at this branch", async () => {
    const start = plusMinutes(BASE, 7 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffNoBranch.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error?.code).toBe("AP009");
  });

  it("AP010 — staff member not eligible for this service", async () => {
    const start = plusMinutes(BASE, 8 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceIneligible.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error?.code).toBe("AP010");
  });

  it("AP011 — staff member not available at the requested time", async () => {
    const start = plusMinutes(BASE, 9 * 60);
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffNoSchedule.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error?.code).toBe("AP011");
  });

  it("AP012 — overlapping booking", async () => {
    const start = plusMinutes(BASE, 10 * 60);
    const { error: firstError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(firstError).toBeNull();

    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: plusMinutes(start, 10), sequence: 1 }],
    });
    expect(error?.code).toBe("AP012");
  });
});

describe("reschedule_appointment / update_appointment_status — stable AP0nn error codes", () => {
  it("AP013 — reschedule on a nonexistent appointment", async () => {
    const { error } = await ownerAClient.rpc("reschedule_appointment", {
      p_appointment_id: crypto.randomUUID(),
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: plusMinutes(BASE, 11 * 60), sequence: 1 }],
    });
    expect(error?.code).toBe("AP013");
  });

  it("AP013 — status update on a nonexistent appointment (checked after AP015's status-shape validation)", async () => {
    const { error } = await ownerAClient.rpc("update_appointment_status", {
      p_appointment_id: crypto.randomUUID(),
      p_new_status: "confirmed",
    });
    expect(error?.code).toBe("AP013");
  });

  it("AP014 — cannot reschedule a completed appointment (checked before the permission gate)", async () => {
    const start = plusMinutes(BASE, 12 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    // Faz 5A.2: update_appointment_status no longer accepts 'completed'
    // (closed completion bypass, Option A) — this test cares about
    // reschedule's own AP014 terminal-state guard, not which RPC reached
    // 'completed', so complete_appointment is used for setup here.
    await ownerAClient.rpc("complete_appointment", { p_appointment_id: appointmentId });

    // Full-permission owner client — isolates the terminal-state check
    // (AP014) from the separate permission check (AP002), since
    // reschedule_appointment checks terminal status BEFORE permission.
    const { error } = await ownerAClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: plusMinutes(start, 60), sequence: 1 }],
    });
    expect(error?.code).toBe("AP014");
  });

  it("AP014 — cannot change the status of a cancelled appointment", async () => {
    const start = plusMinutes(BASE, 13 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    await ownerAClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });

    const { error } = await ownerAClient.rpc("update_appointment_status", {
      p_appointment_id: appointmentId,
      p_new_status: "confirmed",
    });
    expect(error?.code).toBe("AP014");
  });

  it("AP015 — invalid target status, checked even before the appointment lookup", async () => {
    const { error } = await ownerAClient.rpc("update_appointment_status", {
      p_appointment_id: crypto.randomUUID(),
      p_new_status: "not_a_real_status",
    });
    expect(error?.code).toBe("AP015");
  });
});

describe("update_appointment_status — appointments.update vs appointments.cancel branching", () => {
  it("a role with create+cancel but not update cannot confirm (non-cancel transition)", async () => {
    const start = plusMinutes(BASE, 20 * 60);
    const { data: appointmentId, error: createError } = await createCancelOnlyAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(createError).toBeNull();

    const { error } = await createCancelOnlyAClient.rpc("update_appointment_status", {
      p_appointment_id: appointmentId,
      p_new_status: "confirmed",
    });
    expect(error?.code).toBe("AP002");
  });

  it("that same role CAN cancel — proving the gate is specifically appointments.update, not a blanket deny", async () => {
    const start = plusMinutes(BASE, 21 * 60);
    const { data: appointmentId } = await createCancelOnlyAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });

    const { error } = await createCancelOnlyAClient.rpc("update_appointment_status", {
      p_appointment_id: appointmentId,
      p_new_status: "cancelled",
    });
    expect(error).toBeNull();

    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(row!.status).toBe("cancelled");
  });

  it("that same role cannot reschedule (also gated by appointments.update)", async () => {
    const start = plusMinutes(BASE, 22 * 60);
    const { data: appointmentId } = await createCancelOnlyAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });

    const { error } = await createCancelOnlyAClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: plusMinutes(start, 60), sequence: 1 }],
    });
    expect(error?.code).toBe("AP002");
  });
});

describe("check_appointment_availability", () => {
  it("returns is_available=true for a genuinely open slot, with the correctly computed end time", async () => {
    const start = plusMinutes(BASE, 30 * 60);
    const { data, error } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
    });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]!.is_available).toBe(true);
    expect(data![0]!.reason).toBeNull();
    expect(new Date(data![0]!.scheduled_end_at!).toISOString()).toBe(plusMinutes(start, serviceA1.durationMinutes));
  });

  it("response shape carries no PII — exactly is_available/reason/scheduled_end_at, nothing else", async () => {
    const start = plusMinutes(BASE, 31 * 60);
    const { data } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
    });
    expect(Object.keys(data![0]!).sort()).toEqual(["is_available", "reason", "scheduled_end_at"]);
  });

  it("is advisory only — a successful check does not itself create a booking", async () => {
    const start = plusMinutes(BASE, 32 * 60);
    const [{ count: before }] = await testDb<{ count: string }[]>`
      select count(*)::text from appointment_items where staff_member_id = ${staffA1.id} and scheduled_start_at = ${start}
    `;
    const { data } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
    });
    expect(data![0]!.is_available).toBe(true);

    const [{ count: after }] = await testDb<{ count: string }[]>`
      select count(*)::text from appointment_items where staff_member_id = ${staffA1.id} and scheduled_start_at = ${start}
    `;
    expect(after).toBe(before);
    expect(after).toBe("0");
  });

  it("returns is_available=false with AP007 for a service not offered at the branch", async () => {
    const start = plusMinutes(BASE, 33 * 60);
    const { data } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceNoBranch.id,
      p_scheduled_start_at: start,
    });
    expect(data![0]!.is_available).toBe(false);
    expect(data![0]!.reason).toBe("AP007");
  });

  it("returns is_available=false with AP009 for staff not assigned to the branch", async () => {
    const start = plusMinutes(BASE, 34 * 60);
    const { data } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffNoBranch.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
    });
    expect(data![0]!.is_available).toBe(false);
    expect(data![0]!.reason).toBe("AP009");
  });

  it("returns is_available=false with AP010 for staff not eligible for the service", async () => {
    const start = plusMinutes(BASE, 35 * 60);
    const { data } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceIneligible.id,
      p_scheduled_start_at: start,
    });
    expect(data![0]!.is_available).toBe(false);
    expect(data![0]!.reason).toBe("AP010");
  });

  it("returns is_available=false with AP011 outside working hours", async () => {
    const start = plusMinutes(BASE, 36 * 60);
    const { data } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffNoSchedule.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
    });
    expect(data![0]!.is_available).toBe(false);
    expect(data![0]!.reason).toBe("AP011");
  });

  it("returns is_available=false with AP012 for a slot already booked", async () => {
    const start = plusMinutes(BASE, 37 * 60);
    const { error: bookError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(bookError).toBeNull();

    const { data } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: plusMinutes(start, 10),
    });
    expect(data![0]!.is_available).toBe(false);
    expect(data![0]!.reason).toBe("AP012");
  });

  it("requires appointments.view — a member with zero permissions is rejected", async () => {
    const start = plusMinutes(BASE, 38 * 60);
    const { error } = await zeroPermAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
    });
    expect(error?.code).toBe("AP002");
  });

  it("cross-tenant: a user with no membership in tenantA is rejected, not given a false/true row", async () => {
    const start = plusMinutes(BASE, 39 * 60);
    const { data, error } = await ownerBClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
    });
    expect(error?.code).toBe("AP002");
    expect(data).toBeNull();
  });

  it("anon cannot call it at all", async () => {
    const start = plusMinutes(BASE, 40 * 60);
    const { error } = await anonClient().rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
    });
    expect(error).not.toBeNull();
  });
});

// Phase 2D.1 — 20260822120000 adds an optional, tenant-verified
// p_exclude_appointment_id so a reschedule preview stops reporting a
// false AP012 against the appointment's own current slot.
describe("check_appointment_availability — p_exclude_appointment_id", () => {
  it("A) an appointment's own current slot, excluded by its own valid id, is available", async () => {
    const start = plusMinutes(BASE, 60 * 60);
    const { data: appointmentId, error: bookError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(bookError).toBeNull();

    // Without exclusion: the appointment's own slot correctly conflicts
    // with itself (the pre-2D.1 behavior being fixed here).
    const withoutExclusion = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
    });
    expect(withoutExclusion.data![0]!.is_available).toBe(false);
    expect(withoutExclusion.data![0]!.reason).toBe("AP012");

    // With its own id excluded: available.
    const withExclusion = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
      p_exclude_appointment_id: appointmentId,
    });
    expect(withExclusion.data![0]!.is_available).toBe(true);
    expect(withExclusion.data![0]!.reason).toBeNull();
  });

  it("B) a slot occupied by a DIFFERENT appointment still conflicts, even with an unrelated exclusion id", async () => {
    const start = plusMinutes(BASE, 61 * 60);
    const { data: occupyingAppointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });

    // A second, unrelated appointment (different time, same staff) — only
    // used to obtain a real, valid, but IRRELEVANT exclusion id.
    const { data: unrelatedAppointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: plusMinutes(start, 60), sequence: 1 }],
    });
    expect(unrelatedAppointmentId).not.toBe(occupyingAppointmentId);

    const { data } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
      p_exclude_appointment_id: unrelatedAppointmentId,
    });
    expect(data![0]!.is_available).toBe(false);
    expect(data![0]!.reason).toBe("AP012");
  });

  it("C) a cross-tenant appointment id supplied as exclusion must not suppress anything", async () => {
    // 63h, not 62h: test B's "unrelated" booking above occupies staffA1 at
    // exactly 62h (start + 60min offset from its own 61h start).
    const start = plusMinutes(BASE, 63 * 60);
    const { data: appointmentIdA } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(appointmentIdA).toBeTruthy();

    // A genuinely real, valid appointment — but it belongs to tenantB.
    const { data: appointmentIdB, error: bookBError } = await ownerBClient.rpc("create_appointment", {
      p_tenant_id: tenantB.id,
      p_branch_id: branchB,
      p_customer_id: customerB.id,
      p_items: [{ service_id: serviceB1.id, staff_member_id: staffB1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(bookBError).toBeNull();

    // Passing tenantB's real appointment id as the exclusion for a
    // tenantA availability check must not suppress tenantA's own
    // conflict — the id is looked up scoped to p_tenant_id and, not
    // matching, is silently ignored.
    const { data } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
      p_exclude_appointment_id: appointmentIdB,
    });
    expect(data![0]!.is_available).toBe(false);
    expect(data![0]!.reason).toBe("AP012");
  });

  it("D) a forged/random exclusion id degrades safely to a normal check, never suppressing a real conflict", async () => {
    const start = plusMinutes(BASE, 70 * 60);
    const { error: bookError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(bookError).toBeNull();

    const { data, error } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
      p_exclude_appointment_id: crypto.randomUUID(),
    });
    expect(error).toBeNull();
    expect(data![0]!.is_available).toBe(false);
    expect(data![0]!.reason).toBe("AP012");
  });

  it("E) omitting the parameter entirely still behaves exactly as before (backward compatible)", async () => {
    const start = plusMinutes(BASE, 64 * 60);
    const { data, error } = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
    });
    expect(error).toBeNull();
    expect(data![0]!.is_available).toBe(true);
  });

  it("F) anon still cannot call the (now 6-parameter) function", async () => {
    const start = plusMinutes(BASE, 65 * 60);
    const { error } = await anonClient().rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staffA1.id,
      p_service_id: serviceA1.id,
      p_scheduled_start_at: start,
      p_exclude_appointment_id: crypto.randomUUID(),
    });
    expect(error).not.toBeNull();
  });
});

describe("audit trail for appointment actions", () => {
  async function auditRowsFor(entityId: string) {
    return testDb<{ action: string }[]>`
      select action from audit_logs where entity_type = 'appointment' and entity_id = ${entityId} order by created_at asc
    `;
  }

  it("create_appointment produces exactly one appointment.created row", async () => {
    const start = plusMinutes(BASE, 50 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });

    const rows = await auditRowsFor(appointmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("appointment.created");
  });

  it("update_appointment_status(cancelled) logs appointment.cancelled, not appointment.status_changed", async () => {
    const start = plusMinutes(BASE, 51 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    await ownerAClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });

    const rows = await auditRowsFor(appointmentId);
    expect(rows.map((r) => r.action)).toEqual(["appointment.created", "appointment.cancelled"]);
  });

  it("update_appointment_status(confirmed) logs appointment.status_changed, not appointment.cancelled", async () => {
    const start = plusMinutes(BASE, 52 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    await ownerAClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "confirmed" });

    const rows = await auditRowsFor(appointmentId);
    expect(rows.map((r) => r.action)).toEqual(["appointment.created", "appointment.status_changed"]);
  });

  it("a create + reschedule + cancel sequence produces exactly 3 rows in order, no duplicates", async () => {
    const start = plusMinutes(BASE, 53 * 60);
    const { data: appointmentId } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customerA.id,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: start, sequence: 1 }],
    });
    await ownerAClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [{ service_id: serviceA1.id, staff_member_id: staffA1.id, scheduled_start_at: plusMinutes(start, 60), sequence: 1 }],
    });
    await ownerAClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });

    const rows = await auditRowsFor(appointmentId);
    expect(rows.map((r) => r.action)).toEqual(["appointment.created", "appointment.rescheduled", "appointment.cancelled"]);
  });
});
