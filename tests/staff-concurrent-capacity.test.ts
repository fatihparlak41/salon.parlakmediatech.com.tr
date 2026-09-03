import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anonClient,
  cleanupTenants,
  cleanupUsers,
  createCustomer,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  safeMorningStart,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Phase 2I.2B — a staff member may hold more than one active appointment
 * at once (staff_members.concurrent_capacity, 20260902090000). Replaces
 * appointment_items_no_staff_overlap (a pairwise GiST EXCLUDE constraint
 * that could only express "zero tolerance", never "up to N") with a
 * count-based check guarded by an advisory xact lock, at the same single
 * write point as before: private.validate_and_insert_appointment_item.
 * Every read-path availability function (check_appointment_availability,
 * get_public_availability_slots, get_my_reschedule_slots) got the
 * matching count-vs-capacity swap so previews agree with write-time
 * enforcement. capacity=1 (the default, unchanged for every pre-existing
 * staff member) reproduces the old zero-overlap behavior exactly — see
 * tests/phase2-appointments.test.ts's own "concurrent double-booking...
 * exactly one succeeds" test, re-run unchanged as part of this same
 * suite, for that backward-compatibility proof.
 */

function plusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

async function fullWeekSchedule(tenantId: string, staffMemberId: string) {
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenantId, staffMemberId, weekday, "00:00", "23:59");
  }
}

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let ownerB: TestUser;
let ownerAClient: SupabaseClient;

let branchA: string;
let branchB: string;
let serviceA: { id: string; name: string; durationMinutes: number; price: number };
let serviceA2: { id: string; name: string; durationMinutes: number; price: number };
let serviceB: { id: string; name: string; durationMinutes: number; price: number };

beforeAll(async () => {
  ownerA = await createTestUser("p2i2b-owner-a");
  ownerB = await createTestUser("p2i2b-owner-b");
  tenantA = await createTestTenant("test-p2i2b-a", ownerA.id);
  tenantB = await createTestTenant("test-p2i2b-b", ownerB.id);
  ownerAClient = await signInAs(ownerA);

  const [branchARow] = await testDb<{ id: string }[]>`
    insert into branches (tenant_id, name) values (${tenantA.id}, 'Ana Şube') returning id
  `;
  branchA = branchARow!.id;
  const [branchBRow] = await testDb<{ id: string }[]>`
    insert into branches (tenant_id, name) values (${tenantB.id}, 'Ana Şube B') returning id
  `;
  branchB = branchBRow!.id;

  serviceA = await createService(tenantA.id, "Kapasite Hizmeti", 30, 100);
  serviceA2 = await createService(tenantA.id, "Kapasite Hizmeti 2", 30, 150);
  await linkServiceBranch(serviceA.id, branchA);
  await linkServiceBranch(serviceA2.id, branchA);

  serviceB = await createService(tenantB.id, "Hizmet B", 30, 100);
  await linkServiceBranch(serviceB.id, branchB);
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([ownerA.id, ownerB.id]);
});

describe("staff_members.concurrent_capacity — column shape", () => {
  it("defaults to 1 when not passed explicitly", async () => {
    const [row] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name) values (${tenantA.id}, 'Varsayılan Kapasite') returning id
    `;
    const [capRow] = await testDb<{ concurrent_capacity: number }[]>`
      select concurrent_capacity from staff_members where id = ${row!.id}
    `;
    expect(capRow!.concurrent_capacity).toBe(1);
  });

  it("rejects 0 and values above the upper bound with a check-constraint violation", async () => {
    await expect(
      testDb`insert into staff_members (tenant_id, full_name, concurrent_capacity) values (${tenantA.id}, 'Sıfır Kapasite', 0)`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      testDb`insert into staff_members (tenant_id, full_name, concurrent_capacity) values (${tenantA.id}, 'Aşırı Kapasite', 21)`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("create_appointment — write-time capacity enforcement", () => {
  it("capacity 1 (default): a second overlapping booking is rejected with AP012", async () => {
    const staff = await createStaffMember(tenantA.id, "Kapasite 1");
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staff.id);
    const start = safeMorningStart(30).toISOString();
    const custOne = await createCustomer(tenantA.id, "Müşteri Kap1 Bir");
    const custTwo = await createCustomer(tenantA.id, "Müşteri Kap1 İki");

    const first = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custOne.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(first.error).toBeNull();

    const second = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custTwo.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: plusMinutes(start, 10), sequence: 1 }],
    });
    expect(second.error?.code).toBe("AP012");
  });

  it("capacity 2: two overlapping bookings succeed, a third is rejected with AP012", async () => {
    const staff = await createStaffMember(tenantA.id, "Kapasite 2", 2);
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staff.id);
    const start = safeMorningStart(31).toISOString();
    const customers = await Promise.all([1, 2, 3].map((n) => createCustomer(tenantA.id, `Müşteri Kap2 ${n}`)));

    for (let i = 0; i < 2; i++) {
      const { error } = await ownerAClient.rpc("create_appointment", {
        p_tenant_id: tenantA.id,
        p_branch_id: branchA,
        p_customer_id: customers[i]!.id,
        p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: plusMinutes(start, i), sequence: 1 }],
      });
      expect(error).toBeNull();
    }

    const third = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customers[2]!.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: plusMinutes(start, 5), sequence: 1 }],
    });
    expect(third.error?.code).toBe("AP012");
  });

  it("capacity 3 (Gökhan-like): three overlapping bookings succeed, a fourth is rejected with AP012", async () => {
    const staff = await createStaffMember(tenantA.id, "Kapasite 3", 3);
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staff.id);
    const start = safeMorningStart(32).toISOString();
    const customers = await Promise.all([1, 2, 3, 4].map((n) => createCustomer(tenantA.id, `Müşteri Kap3 ${n}`)));

    for (let i = 0; i < 3; i++) {
      const { error } = await ownerAClient.rpc("create_appointment", {
        p_tenant_id: tenantA.id,
        p_branch_id: branchA,
        p_customer_id: customers[i]!.id,
        p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: plusMinutes(start, i), sequence: 1 }],
      });
      expect(error).toBeNull();
    }

    const fourth = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customers[3]!.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: plusMinutes(start, 8), sequence: 1 }],
    });
    expect(fourth.error?.code).toBe("AP012");
  });

  it("real concurrent race, capacity 3: exactly 3 of 4 simultaneous attempts for the same slot succeed", async () => {
    const staff = await createStaffMember(tenantA.id, "Kapasite 3 Yarış", 3);
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staff.id);
    const start = safeMorningStart(33).toISOString();
    const customers = await Promise.all([1, 2, 3, 4].map((n) => createCustomer(tenantA.id, `Müşteri Yarış3 ${n}`)));

    const results = await Promise.all(
      customers.map((c) =>
        ownerAClient.rpc("create_appointment", {
          p_tenant_id: tenantA.id,
          p_branch_id: branchA,
          p_customer_id: c.id,
          p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start, sequence: 1 }],
        }),
      ),
    );

    const errors = results.map((r) => r.error);
    expect(errors.filter((e) => e === null).length).toBe(3);
    expect(errors.filter((e) => e !== null).length).toBe(1);
    expect(errors.find((e) => e !== null)?.code).toBe("AP012");
  });

  it("real concurrent race, capacity 2: exactly 2 of 3 simultaneous attempts for the same slot succeed", async () => {
    const staff = await createStaffMember(tenantA.id, "Kapasite 2 Yarış", 2);
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staff.id);
    const start = safeMorningStart(34).toISOString();
    const customers = await Promise.all([1, 2, 3].map((n) => createCustomer(tenantA.id, `Müşteri Yarış2 ${n}`)));

    const results = await Promise.all(
      customers.map((c) =>
        ownerAClient.rpc("create_appointment", {
          p_tenant_id: tenantA.id,
          p_branch_id: branchA,
          p_customer_id: c.id,
          p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start, sequence: 1 }],
        }),
      ),
    );

    const errors = results.map((r) => r.error);
    expect(errors.filter((e) => e === null).length).toBe(2);
    expect(errors.filter((e) => e !== null).length).toBe(1);
  });

  it("non-overlapping bookings for a capacity-1 staff member never conflict with each other", async () => {
    const staff = await createStaffMember(tenantA.id, "Kapasite 1 Ardışık");
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staff.id);
    const start = safeMorningStart(35).toISOString();
    const custOne = await createCustomer(tenantA.id, "Ardışık Bir");
    const custTwo = await createCustomer(tenantA.id, "Ardışık İki");

    const first = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custOne.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(first.error).toBeNull();

    // Fully after the first item ends (30 min service, 60 min later starts).
    const second = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custTwo.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: plusMinutes(start, 60), sequence: 1 }],
    });
    expect(second.error).toBeNull();
  });

  it("cancelling one of N active appointments frees a capacity slot for a new booking", async () => {
    const staff = await createStaffMember(tenantA.id, "Kapasite 2 İptal", 2);
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staff.id);
    const start = safeMorningStart(36).toISOString();
    const [custOne, custTwo, custThree] = await Promise.all([1, 2, 3].map((n) => createCustomer(tenantA.id, `Müşteri İptal ${n}`)));

    const first = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custOne!.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(first.error).toBeNull();
    const firstAppointmentId = first.data as unknown as string;

    const second = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custTwo!.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: plusMinutes(start, 5), sequence: 1 }],
    });
    expect(second.error).toBeNull();

    // At capacity now — a third is rejected.
    const blocked = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custThree!.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: plusMinutes(start, 10), sequence: 1 }],
    });
    expect(blocked.error?.code).toBe("AP012");

    const { error: cancelError } = await ownerAClient.rpc("update_appointment_status", {
      p_appointment_id: firstAppointmentId,
      p_new_status: "cancelled",
    });
    expect(cancelError).toBeNull();

    // The freed slot now accepts the same booking that was just rejected.
    const retried = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custThree!.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: plusMinutes(start, 10), sequence: 1 }],
    });
    expect(retried.error).toBeNull();
  });

  it("a multi-service appointment cannot double-book its OWN staff member beyond capacity", async () => {
    const staff = await createStaffMember(tenantA.id, "Kapasite 1 Çoklu Hizmet");
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await linkStaffService(staff.id, serviceA2.id);
    await fullWeekSchedule(tenantA.id, staff.id);
    const start = safeMorningStart(37).toISOString();
    const cust = await createCustomer(tenantA.id, "Çoklu Hizmet Müşteri");

    // Same staff member, two overlapping items, ONE appointment, ONE
    // transaction — proves the advisory lock is reentrant (no
    // self-deadlock) and the second item's count query sees the first
    // item already inserted earlier in the SAME transaction.
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: cust.id,
      p_items: [
        { service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start, sequence: 1 },
        { service_id: serviceA2.id, staff_member_id: staff.id, scheduled_start_at: start, sequence: 2 },
      ],
    });
    expect(error?.code).toBe("AP012");
  });

  it("a forged/nonexistent staff_member_id still returns AP008, never a capacity-related error", async () => {
    const cust = await createCustomer(tenantA.id, "Sahte Personel Müşteri");
    const { error } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: cust.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: crypto.randomUUID(), scheduled_start_at: safeMorningStart(38).toISOString(), sequence: 1 }],
    });
    expect(error?.code).toBe("AP008");
  });

  it("cross-tenant: tenant B's staff capacity is completely unaffected by tenant A's bookings at the same instant", async () => {
    const staffA = await createStaffMember(tenantA.id, "Kapasite 3 İzolasyon A", 3);
    await linkStaffBranch(staffA.id, branchA);
    await linkStaffService(staffA.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staffA.id);

    const staffB = await createStaffMember(tenantB.id, "Kapasite 3 İzolasyon B", 3);
    await linkStaffBranch(staffB.id, branchB);
    await linkStaffService(staffB.id, serviceB.id);
    await fullWeekSchedule(tenantB.id, staffB.id);

    const start = safeMorningStart(39).toISOString();
    const customersA = await Promise.all([1, 2, 3].map((n) => createCustomer(tenantA.id, `İzolasyon A ${n}`)));
    for (const c of customersA) {
      const { error } = await ownerAClient.rpc("create_appointment", {
        p_tenant_id: tenantA.id,
        p_branch_id: branchA,
        p_customer_id: c.id,
        p_items: [{ service_id: serviceA.id, staff_member_id: staffA.id, scheduled_start_at: start, sequence: 1 }],
      });
      expect(error).toBeNull();
    }
    // Tenant A's staffA is now fully at capacity.

    const ownerBClient = await signInAs(ownerB);
    const custB = await createCustomer(tenantB.id, "İzolasyon B");
    const { error } = await ownerBClient.rpc("create_appointment", {
      p_tenant_id: tenantB.id,
      p_branch_id: branchB,
      p_customer_id: custB.id,
      p_items: [{ service_id: serviceB.id, staff_member_id: staffB.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(error).toBeNull();
    await ownerBClient.auth.signOut();
  });
});

describe("check_appointment_availability — capacity-aware preview", () => {
  it("capacity 3: is_available flips to false only once the 3rd overlapping booking lands", async () => {
    const staff = await createStaffMember(tenantA.id, "Önizleme Kapasite 3", 3);
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staff.id);
    const start = safeMorningStart(40).toISOString();
    const customers = await Promise.all([1, 2, 3].map((n) => createCustomer(tenantA.id, `Önizleme ${n}`)));

    for (let i = 0; i < 2; i++) {
      const preview = await ownerAClient.rpc("check_appointment_availability", {
        p_tenant_id: tenantA.id,
        p_branch_id: branchA,
        p_staff_member_id: staff.id,
        p_service_id: serviceA.id,
        p_scheduled_start_at: start,
      });
      expect(preview.data![0]!.is_available).toBe(true);

      const { error } = await ownerAClient.rpc("create_appointment", {
        p_tenant_id: tenantA.id,
        p_branch_id: branchA,
        p_customer_id: customers[i]!.id,
        p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start, sequence: 1 }],
      });
      expect(error).toBeNull();
    }

    // 2 active bookings now occupy the slot — capacity 3 still has room.
    const stillAvailable = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staff.id,
      p_service_id: serviceA.id,
      p_scheduled_start_at: start,
    });
    expect(stillAvailable.data![0]!.is_available).toBe(true);

    const { error: thirdError } = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: customers[2]!.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(thirdError).toBeNull();

    const nowFull = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staff.id,
      p_service_id: serviceA.id,
      p_scheduled_start_at: start,
    });
    expect(nowFull.data![0]!.is_available).toBe(false);
    expect(nowFull.data![0]!.reason).toBe("AP012");
  });

  it("p_exclude_appointment_id still excludes the appointment's own item from its own capacity count", async () => {
    const staff = await createStaffMember(tenantA.id, "Önizleme Hariç Tut", 2);
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staff.id);
    const start = safeMorningStart(41).toISOString();
    const [custOne, custTwo] = await Promise.all([1, 2].map((n) => createCustomer(tenantA.id, `Hariç Tut ${n}`)));

    const first = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custOne!.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(first.error).toBeNull();
    const firstAppointmentId = first.data as unknown as string;

    const second = await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custTwo!.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start, sequence: 1 }],
    });
    expect(second.error).toBeNull();

    // Capacity 2, both slots taken — without exclusion, full.
    const withoutExclusion = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staff.id,
      p_service_id: serviceA.id,
      p_scheduled_start_at: start,
    });
    expect(withoutExclusion.data![0]!.is_available).toBe(false);

    // Excluding the first appointment's own item leaves only 1 of 2 —
    // available again, matching a reschedule preview of that same slot.
    const withExclusion = await ownerAClient.rpc("check_appointment_availability", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_staff_member_id: staff.id,
      p_service_id: serviceA.id,
      p_scheduled_start_at: start,
      p_exclude_appointment_id: firstAppointmentId,
    });
    expect(withExclusion.data![0]!.is_available).toBe(true);
  });
});

describe("get_public_availability_slots — capacity-aware", () => {
  async function enableOnlineBooking(tenantId: string) {
    const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
    if (!feature) throw new Error("online_booking feature missing from catalog");
    await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${tenantId}, ${feature.id}, true)`;
  }

  it("capacity 2: a slot stays listed until the 2nd overlapping booking lands, then disappears", async () => {
    await enableOnlineBooking(tenantA.id);
    const staff = await createStaffMember(tenantA.id, "Genel Müsaitlik Kapasite 2", 2);
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staff.id);

    const start = safeMorningStart(20);
    // get_public_availability_slots returns TENANT-LOCAL "HH:MM" strings,
    // not UTC — derive both from the DB the same way the RPC itself does
    // (to_char(... at time zone tenant.timezone, ...)) rather than
    // hand-rolling the offset, so this can never drift from whatever the
    // test tenant's actual timezone is.
    const [localParts] = await testDb<{ local_date: string; local_hhmm: string }[]>`
      select to_char(${start.toISOString()}::timestamptz at time zone t.timezone, 'YYYY-MM-DD') as local_date,
             to_char(${start.toISOString()}::timestamptz at time zone t.timezone, 'HH24:MI') as local_hhmm
      from tenants t where t.id = ${tenantA.id}`;
    const dateStr = localParts!.local_date;
    const hhmm = localParts!.local_hhmm;

    const slotsBefore = await anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA,
      p_service_id: serviceA.id,
      p_date: dateStr,
      p_staff_member_id: staff.id,
    });
    expect((slotsBefore.data as string[]) ?? []).toContain(hhmm);

    const custOne = await createCustomer(tenantA.id, "Genel Müsaitlik Bir");
    await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custOne.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
    });

    // 1 of 2 taken — still listed.
    const slotsOneTaken = await anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA,
      p_service_id: serviceA.id,
      p_date: dateStr,
      p_staff_member_id: staff.id,
    });
    expect((slotsOneTaken.data as string[]) ?? []).toContain(hhmm);

    const custTwo = await createCustomer(tenantA.id, "Genel Müsaitlik İki");
    await ownerAClient.rpc("create_appointment", {
      p_tenant_id: tenantA.id,
      p_branch_id: branchA,
      p_customer_id: custTwo.id,
      p_items: [{ service_id: serviceA.id, staff_member_id: staff.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
    });

    // 2 of 2 taken — no longer listed.
    const slotsFull = await anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenantA.slug,
      p_branch_id: branchA,
      p_service_id: serviceA.id,
      p_date: dateStr,
      p_staff_member_id: staff.id,
    });
    expect((slotsFull.data as string[]) ?? []).not.toContain(hhmm);
  });
});

describe("get_my_reschedule_slots — capacity-aware (customer self-service preview)", () => {
  async function setPolicy(tenantId: string, policy: { customer_reschedule_enabled: boolean; customer_reschedule_cutoff_minutes: number }) {
    await testDb`update tenants set ${testDb(policy)} where id = ${tenantId}`;
  }

  it("capacity 2: a candidate slot is withheld once 2 other bookings occupy it, then re-offered after one is cancelled", async () => {
    await setPolicy(tenantA.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });

    const accountUser = await createTestUser("p2i2b-resched-acct");
    const staff = await createStaffMember(tenantA.id, "Değiştirme Kapasite 2", 2);
    await linkStaffBranch(staff.id, branchA);
    await linkStaffService(staff.id, serviceA.id);
    await fullWeekSchedule(tenantA.id, staff.id);

    const ownStart = safeMorningStart(21);
    const [customer] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name) values (${tenantA.id}, 'Değiştirme Müşteri') returning id`;
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
      values (${accountUser.id}, ${tenantA.id}, ${customer!.id}, 'future_booking', true)`;
    const [appt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, source, scheduled_start_at, scheduled_end_at)
      values (${tenantA.id}, ${branchA}, ${customer!.id}, 'scheduled', 'public_booking', ${ownStart.toISOString()}::timestamptz, ${plusMinutes(ownStart.toISOString(), 30)}::timestamptz)
      returning id`;
    const appointmentId = appt!.id;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenantA.id}, ${appointmentId}, ${serviceA.id}, ${staff.id}, ${ownStart.toISOString()}::timestamptz, ${plusMinutes(ownStart.toISOString(), 30)}::timestamptz, 30, 100, 1)`;

    // The candidate target slot: 3 hours after the appointment's own
    // current start, same tenant-local calendar day.
    const targetStart = new Date(ownStart.getTime() + 3 * 3600_000);
    const targetEnd = new Date(targetStart.getTime() + 30 * 60_000);
    const [tzRow] = await testDb<{ local_date: string; local_hhmm: string }[]>`
      select to_char(${targetStart.toISOString()}::timestamptz at time zone t.timezone, 'YYYY-MM-DD') as local_date,
             to_char(${targetStart.toISOString()}::timestamptz at time zone t.timezone, 'HH24:MI') as local_hhmm
      from tenants t where t.id = ${tenantA.id}`;
    const targetDate = tzRow!.local_date;
    const targetHhmm = tzRow!.local_hhmm;

    async function blockerAppointment(): Promise<string> {
      const [blockerCustomer] = await testDb<{ id: string }[]>`
        insert into customers (tenant_id, full_name) values (${tenantA.id}, 'Değiştirme Engelleyici') returning id`;
      const [blockerAppt] = await testDb<{ id: string }[]>`
        insert into appointments (tenant_id, branch_id, customer_id, status, source, scheduled_start_at, scheduled_end_at)
        values (${tenantA.id}, ${branchA}, ${blockerCustomer!.id}, 'scheduled', 'walk_in', ${targetStart.toISOString()}::timestamptz, ${targetEnd.toISOString()}::timestamptz)
        returning id`;
      await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
        values (${tenantA.id}, ${blockerAppt!.id}, ${serviceA.id}, ${staff.id}, ${targetStart.toISOString()}::timestamptz, ${targetEnd.toISOString()}::timestamptz, 30, 100, 1)`;
      return blockerAppt!.id;
    }

    const blockerOne = await blockerAppointment();
    const client = await signInAs(accountUser);

    // 1 of 2 capacity taken by a blocker — still offered.
    const slotsOneBlocker = await client.rpc("get_my_reschedule_slots", { p_appointment_id: appointmentId, p_date: targetDate });
    expect((slotsOneBlocker.data as string[]) ?? []).toContain(targetHhmm);

    const blockerTwo = await blockerAppointment();

    // 2 of 2 capacity taken — withheld.
    const slotsFull = await client.rpc("get_my_reschedule_slots", { p_appointment_id: appointmentId, p_date: targetDate });
    expect((slotsFull.data as string[]) ?? []).not.toContain(targetHhmm);

    await testDb`update appointments set status = 'cancelled' where id = ${blockerOne}`;

    // Freed back to 1 of 2 — offered again.
    const slotsFreed = await client.rpc("get_my_reschedule_slots", { p_appointment_id: appointmentId, p_date: targetDate });
    expect((slotsFreed.data as string[]) ?? []).toContain(targetHhmm);

    await client.auth.signOut();
    await testDb`update appointments set status = 'cancelled' where id = ${blockerTwo}`;
    await cleanupUsers([accountUser.id]);
  });
});
