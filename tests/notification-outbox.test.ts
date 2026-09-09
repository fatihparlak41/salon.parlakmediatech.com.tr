import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  testDb,
  signInAs,
  createTestTenant,
  createTestUser,
  createBranch,
  createService,
  createStaffMember,
  createStaffSchedule,
  createCustomer,
  linkStaffBranch,
  linkStaffService,
  linkServiceBranch,
  safeMorningStart,
  cleanupTenants,
  cleanupUsers,
  type TestUser,
  type TestTenant,
} from "./helpers";

/**
 * Faz NOTIF.2B — transactional notification-event/outbox foundation.
 * Covers: creation (internal + guest), transactionality (rollback on
 * failure), cancellation (staff + customer), reschedule (time/staff/both/
 * neither), staff semantics (booked vs actual, multi-item diffs),
 * security (zero browser access, zero new booking_gateway privilege,
 * cross-tenant impossibility), PII absence, and immutability.
 *
 * Every mutation goes through the real RPC (create_appointment,
 * reschedule_appointment, update_appointment_status, cancel_my_appointment,
 * reschedule_my_appointment) or the real SECURITY DEFINER function
 * (create_guest_booking, called via testDb directly — same precedent
 * tests/appointment-snapshot-trust-boundary.test.ts already uses for
 * this exact function, since booking_gateway's own grant boundary is a
 * separate, already-covered concern in tests/future-booking-claim.test.ts
 * and tests/security-grants-regression.test.ts) — never a raw insert
 * into notification_events, which no role can do at all.
 *
 * One shared staff/service/branch pool, one shared signed-in owner
 * client, one shared signed-in customer-account client — reused across
 * tests to keep this file's own sign-in count low (Faz NOTIF.2A.2's own
 * lesson: personnel-performance-utilization.test.ts's ~1-sign-in-per-test
 * pattern is what makes it rate-limit-fragile; personnel-performance-
 * reports.test.ts's 3-sign-ins-for-28-tests pattern is what this file
 * follows instead). Every appointment gets its own dedicated future
 * time slot (nextSlot()) so no two tests can ever collide on
 * appointment_items_no_staff_overlap regardless of which staff member
 * they reuse from the shared pool.
 */

let owner: TestUser;
let tenant: TestTenant;
let branchId: string;
let serviceA: { id: string; name: string; durationMinutes: number; price: number };
let serviceB: { id: string; name: string; durationMinutes: number; price: number };
let staffA: { id: string; fullName: string };
let staffB: { id: string; fullName: string };
let staffC: { id: string; fullName: string };
let staffD: { id: string; fullName: string };
let customerId: string;
let ownerClient: SupabaseClient;

// Customer-account fixtures for cancel_my_appointment/reschedule_my_appointment
let custUser: TestUser;
let custClient: SupabaseClient;
let custCustomerId: string;

// Note: custUser's own cancel/reschedule actions below each write an
// audit_logs row (actor_user_id = custUser.id) via private.log_audit_
// event — the same FK shape root-caused in Faz NOTIF.2A.2. That phase's
// fix pattern (defer to the outer afterAll, after cleanupTenants) is
// what this file already does unconditionally for custUser — it is
// created once in beforeAll and only ever cleaned up in the outer
// afterAll below, never inline inside a test — so no extra per-test
// bookkeeping array is needed here the way those three files required.
let slotCounter = -1;
const SLOTS_PER_DAY = 4;
const HOURS_PER_SLOT = 4;
/** A fresh, never-reused future start time, so no two tests can collide
 * on the shared staff pool's overlap constraint. Every staff member
 * here is freshly created and uuid-keyed, unique to this file's own
 * tenant, so there is no CROSS-file collision risk regardless of which
 * day/hour is chosen (appointment_items_no_staff_overlap is keyed on
 * staff_member_id, never a shared calendar slot).
 *
 * Packs SLOTS_PER_DAY slots per day, HOURS_PER_SLOT apart (08:00, 12:00,
 * 16:00, 20:00) rather than one slot per calendar day — NOTIF.2B.1 grew
 * this file past 30 total call sites, and a plain one-day-per-call
 * counter silently exceeded reschedule_my_appointment's own 30-day
 * horizon cap (AC008) once a customer-reschedule test landed above day
 * 30 (caught by this phase's own fresh test run, not assumed). Hour
 * spacing is ample margin for every delta used in this file (the
 * largest is 2 hours plus a 30-60 min service duration); at 4
 * slots/day this file's ~35 call sites fit within 9 days total, far
 * under the 30-day ceiling. */
function nextSlot(): Date {
  slotCounter += 1;
  const day = 1 + Math.floor(slotCounter / SLOTS_PER_DAY);
  const hourOffset = (slotCounter % SLOTS_PER_DAY) * HOURS_PER_SLOT;
  return new Date(safeMorningStart(day).getTime() + hourOffset * 3600_000);
}

type AppointmentItemInput = {
  service_id: string;
  staff_member_id: string;
  scheduled_start_at: string;
  sequence?: number;
};

function makeItem(
  service: { id: string },
  staff: { id: string },
  start: Date,
  sequence?: number,
): AppointmentItemInput {
  const item: AppointmentItemInput = {
    service_id: service.id,
    staff_member_id: staff.id,
    scheduled_start_at: start.toISOString(),
  };
  if (sequence !== undefined) item.sequence = sequence;
  return item;
}

async function createInternalAppointment(
  items: AppointmentItemInput[],
  custId: string = customerId,
): Promise<string> {
  const { data, error } = await ownerClient.rpc("create_appointment", {
    p_tenant_id: tenant.id,
    p_branch_id: branchId,
    p_customer_id: custId,
    p_items: items,
  });
  if (error || !data) throw new Error(`createInternalAppointment failed: ${error?.message}`);
  return data as string;
}

type NotifEventRow = {
  id: string;
  tenant_id: string;
  appointment_id: string;
  event_type: string;
  actor_user_id: string | null;
  event_data: Record<string, unknown>;
  schema_version: number;
};

async function fetchEvents(appointmentId: string): Promise<NotifEventRow[]> {
  return testDb<NotifEventRow[]>`
    select id, tenant_id, appointment_id, event_type, actor_user_id, event_data, schema_version
    from notification_events
    where appointment_id = ${appointmentId}
    order by created_at asc
  `;
}

async function tenantEventCount(): Promise<number> {
  const [row] = await testDb<{ n: number }[]>`
    select count(*)::int as n from notification_events where tenant_id = ${tenant.id}
  `;
  return row!.n;
}

beforeAll(async () => {
  owner = await createTestUser("notifb-owner");
  const tenantRow = await createTestTenant("test-notifb-outbox", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug, ownerRoleId: tenantRow.ownerRoleId };
  branchId = await createBranch(tenant.id, "Outbox Branch");

  serviceA = await createService(tenant.id, "Outbox Service A", 30, 200);
  serviceB = await createService(tenant.id, "Outbox Service B", 30, 250);
  await testDb`insert into service_branches (service_id, branch_id) values (${serviceA.id}, ${branchId}), (${serviceB.id}, ${branchId})`;

  staffA = await createStaffMember(tenant.id, "Outbox Staff A");
  staffB = await createStaffMember(tenant.id, "Outbox Staff B");
  staffC = await createStaffMember(tenant.id, "Outbox Staff C");
  staffD = await createStaffMember(tenant.id, "Outbox Staff D");
  for (const s of [staffA, staffB, staffC, staffD]) {
    await linkStaffBranch(s.id, branchId);
    await linkStaffService(s.id, serviceA.id);
    await linkStaffService(s.id, serviceB.id);
    // Full-week, all-day availability, branch-agnostic — avoids any
    // weekday/midnight-crossing friction (see the Faz 2I.2D midnight
    // defect this project already has tracked separately); this file's
    // own tests are about the outbox, not availability edge cases.
    for (let weekday = 0; weekday <= 6; weekday++) {
      await createStaffSchedule(tenant.id, s.id, weekday, "00:00", "23:59", null);
    }
  }

  const customer = await createCustomer(tenant.id, "Outbox Customer");
  customerId = customer.id;

  ownerClient = await signInAs(owner);

  // Customer-account fixtures.
  custUser = await createTestUser("notifb-cust");
  const custCustomer = await createCustomer(tenant.id, "Outbox Cust Account Customer");
  custCustomerId = custCustomer.id;
  await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
    values (${custUser.id}, ${tenant.id}, ${custCustomerId}, 'future_booking', true)`;
  await testDb`update tenants set customer_cancellation_enabled = true, customer_cancellation_cutoff_minutes = 0,
    customer_reschedule_enabled = true, customer_reschedule_cutoff_minutes = 0 where id = ${tenant.id}`;
  custClient = await signInAs(custUser);
}, 60000);

afterAll(async () => {
  await ownerClient.auth.signOut();
  await custClient.auth.signOut();
  await cleanupTenants([tenant.id]);
  await cleanupUsers([owner.id, custUser.id]);
}, 60000);

describe("creation", () => {
  it("1/2. internal create → exactly one appointment.created event, actor_user_id = creating auth user", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start)]);
    const events = await fetchEvents(appointmentId);
    expect(events.length).toBe(1);
    expect(events[0]!.event_type).toBe("appointment.created");
    expect(events[0]!.actor_user_id).toBe(owner.id);
  });

  it("3/4. guest booking → exactly one appointment.created, actor_user_id IS NULL", async () => {
    const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
    await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${tenant.id}, ${feature!.id}, true) on conflict do nothing`;
    const start = nextSlot();
    const [result] = await testDb<{ create_guest_booking: Record<string, unknown> }[]>`
      select public.create_guest_booking(
        ${tenant.slug}, ${branchId}::uuid, ${serviceA.id}::uuid, ${start.toISOString()}::timestamptz,
        'Outbox Guest', '5559991111', ${staffB.id}::uuid, null, ${crypto.randomUUID()}::uuid, null
      )`;
    const confirmation = result!.create_guest_booking as { appointmentReference: string };
    const events = await fetchEvents(confirmation.appointmentReference);
    expect(events.length).toBe(1);
    expect(events[0]!.event_type).toBe("appointment.created");
    expect(events[0]!.actor_user_id).toBeNull();
  });

  it("5. event tenant_id/appointment_id correct", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start)]);
    const events = await fetchEvents(appointmentId);
    expect(events[0]!.tenant_id).toBe(tenant.id);
    expect(events[0]!.appointment_id).toBe(appointmentId);
  });

  it("6. booking_gateway receives no direct event-table DML privilege", async () => {
    const rows = await testDb<{ priv: string; can: boolean }[]>`
      select priv, has_table_privilege('booking_gateway', 'public.notification_events', priv) as can
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as priv
    `;
    for (const row of rows) expect(row.can).toBe(false);
  });
});

describe("transactionality", () => {
  it("7. failed appointment creation → zero event", async () => {
    const before = await tenantEventCount();
    const { error } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: crypto.randomUUID(), // AP003: branch not found
      p_customer_id: customerId,
      p_items: [makeItem(serviceA, staffA, nextSlot())],
    });
    expect(error).not.toBeNull();
    const after = await tenantEventCount();
    expect(after).toBe(before);
  });

  it("8. failed reschedule → zero new event", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start)]);
    const before = await tenantEventCount();
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [], // AP005: at least one item required
    });
    expect(error).not.toBeNull();
    const after = await tenantEventCount();
    expect(after).toBe(before);
  });

  it("9. failed cancellation → zero new event", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start)]);
    await ownerClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });
    const before = await tenantEventCount();
    // Already cancelled — AP014, cannot cancel again.
    const { error } = await ownerClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });
    expect(error).not.toBeNull();
    const after = await tenantEventCount();
    expect(after).toBe(before);
  });
});

describe("cancellation", () => {
  it("10. staff cancel → one appointment.cancelled", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start)]);
    await ownerClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });
    const events = await fetchEvents(appointmentId);
    const cancelled = events.filter((e) => e.event_type === "appointment.cancelled");
    expect(cancelled.length).toBe(1);
  });

  it("11/12. customer cancel → one appointment.cancelled, actor semantics correct", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start)], custCustomerId);
    const { error } = await custClient.rpc("cancel_my_appointment", { p_appointment_id: appointmentId });
    expect(error).toBeNull();
    const events = await fetchEvents(appointmentId);
    const cancelled = events.filter((e) => e.event_type === "appointment.cancelled");
    expect(cancelled.length).toBe(1);
    expect(cancelled[0]!.actor_user_id).toBe(custUser.id);
  });

  it("13. no cancellation event for no_show", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start)]);
    const { error } = await ownerClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "no_show" });
    expect(error).toBeNull();
    const events = await fetchEvents(appointmentId);
    expect(events.some((e) => e.event_type === "appointment.cancelled")).toBe(false);
  });

  it("14. no cancellation event for completion", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start)]);
    const { error } = await ownerClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "in_progress" });
    expect(error).toBeNull();
    const { error: completeError } = await ownerClient.rpc("complete_appointment", { p_appointment_id: appointmentId, p_performer_overrides: [] });
    expect(completeError).toBeNull();
    const events = await fetchEvents(appointmentId);
    expect(events.some((e) => e.event_type === "appointment.cancelled")).toBe(false);
    // complete_appointment does not call enqueue_notification_event at
    // all — only the original creation event exists.
    expect(events.length).toBe(1);
  });
});

describe("reschedule", () => {
  it("15. time-only internal reschedule → one appointment.rescheduled", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    const newStart = new Date(start.getTime() + 3600_000);
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [makeItem(serviceA, staffA, newStart, 1)],
    });
    expect(error).toBeNull();
    const events = await fetchEvents(appointmentId);
    const rescheduled = events.filter((e) => e.event_type === "appointment.rescheduled");
    const reassigned = events.filter((e) => e.event_type === "appointment.staff_reassigned");
    expect(rescheduled.length).toBe(1);
    expect(reassigned.length).toBe(0);
  });

  it("16. staff-only reassignment → one appointment.staff_reassigned", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [makeItem(serviceA, staffB, start, 1)], // same time, different staff
    });
    expect(error).toBeNull();
    const events = await fetchEvents(appointmentId);
    const rescheduled = events.filter((e) => e.event_type === "appointment.rescheduled");
    const reassigned = events.filter((e) => e.event_type === "appointment.staff_reassigned");
    expect(rescheduled.length).toBe(0);
    expect(reassigned.length).toBe(1);
    expect(reassigned[0]!.event_data.previousStaffMemberIds).toEqual([staffA.id]);
    expect(reassigned[0]!.event_data.newStaffMemberIds).toEqual([staffB.id]);
  });

  it("17. time + staff change → exactly two events in the same transaction", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    const newStart = new Date(start.getTime() + 3600_000);
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [makeItem(serviceA, staffC, newStart, 1)],
    });
    expect(error).toBeNull();
    const events = await fetchEvents(appointmentId);
    const rescheduled = events.filter((e) => e.event_type === "appointment.rescheduled");
    const reassigned = events.filter((e) => e.event_type === "appointment.staff_reassigned");
    expect(rescheduled.length).toBe(1);
    expect(reassigned.length).toBe(1);
  });

  it("18. neither time nor staff changed → no event (RPC permits the no-op)", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [makeItem(serviceA, staffA, start, 1)], // identical
    });
    expect(error).toBeNull();
    const events = await fetchEvents(appointmentId);
    expect(events.length).toBe(1); // only the original creation event
  });

  it("19/20. customer reschedule → appointment.rescheduled, never staff_reassigned", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)], custCustomerId);
    const newStart = new Date(start.getTime() + 3600_000);
    const { error } = await custClient.rpc("reschedule_my_appointment", {
      p_appointment_id: appointmentId,
      p_new_start_at: newStart.toISOString(),
    });
    expect(error).toBeNull();
    const events = await fetchEvents(appointmentId);
    const rescheduled = events.filter((e) => e.event_type === "appointment.rescheduled");
    const reassigned = events.filter((e) => e.event_type === "appointment.staff_reassigned");
    expect(rescheduled.length).toBe(1);
    expect(reassigned.length).toBe(0);
    expect(rescheduled[0]!.actor_user_id).toBe(custUser.id);
  });
});

describe("staff semantics", () => {
  it("21. event uses booked staff_member_id, never actual_staff_member_id", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    const [item] = await testDb<{ id: string }[]>`select id from appointment_items where appointment_id = ${appointmentId}`;
    // Manually set actual_staff_member_id to a DIFFERENT staff member —
    // ground-truth setup only, never through an RPC — to prove the
    // reschedule diff below cannot possibly be reading this column.
    await testDb`update appointment_items set actual_staff_member_id = ${staffD.id} where id = ${item!.id}`;

    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [makeItem(serviceA, staffB, start, 1)],
    });
    expect(error).toBeNull();
    const events = await fetchEvents(appointmentId);
    const reassigned = events.find((e) => e.event_type === "appointment.staff_reassigned")!;
    expect(reassigned.event_data.previousStaffMemberIds).toEqual([staffA.id]); // booked, not staffD (actual)
    expect(reassigned.event_data.newStaffMemberIds).toEqual([staffB.id]);
  });

  it("24. multi-service appointment diff represented correctly", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([
      makeItem(serviceA, staffA, start, 1),
      makeItem(serviceB, staffB, new Date(start.getTime() + 3600_000), 2),
    ]);
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [
        makeItem(serviceA, staffC, start, 1), // item 1 staff changes
        makeItem(serviceB, staffB, new Date(start.getTime() + 3600_000), 2), // item 2 unchanged
      ],
    });
    expect(error).toBeNull();
    const events = await fetchEvents(appointmentId);
    const reassigned = events.find((e) => e.event_type === "appointment.staff_reassigned")!;
    // staffB (unchanged, still on item 2) appears in NEITHER array.
    expect(reassigned.event_data.previousStaffMemberIds).toEqual([staffA.id]);
    expect(reassigned.event_data.newStaffMemberIds).toEqual([staffC.id]);
  });

  it("22/23/25. previous/new staff ids preserved and deduplicated across multiple items with the same staff", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([
      makeItem(serviceA, staffA, start, 1),
      makeItem(serviceB, staffA, new Date(start.getTime() + 3600_000), 2), // staffA on BOTH items
    ]);
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [
        makeItem(serviceA, staffD, start, 1),
        makeItem(serviceB, staffD, new Date(start.getTime() + 3600_000), 2), // staffD on BOTH items
      ],
    });
    expect(error).toBeNull();
    const events = await fetchEvents(appointmentId);
    const reassigned = events.find((e) => e.event_type === "appointment.staff_reassigned")!;
    // staffA appeared on 2 items before, staffD on 2 items after — each
    // must appear exactly ONCE in its array, not duplicated per item.
    expect(reassigned.event_data.previousStaffMemberIds).toEqual([staffA.id]);
    expect(reassigned.event_data.newStaffMemberIds).toEqual([staffD.id]);
  });
});

describe("security", () => {
  it("26. authenticated direct table SELECT/INSERT/UPDATE/DELETE = zero", async () => {
    const rows = await testDb<{ priv: string; can: boolean }[]>`
      select priv, has_table_privilege('authenticated', 'public.notification_events', priv) as can
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as priv
    `;
    for (const row of rows) expect(row.can).toBe(false);
  });

  it("27. anon direct table access = zero", async () => {
    const rows = await testDb<{ priv: string; can: boolean }[]>`
      select priv, has_table_privilege('anon', 'public.notification_events', priv) as can
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as priv
    `;
    for (const row of rows) expect(row.can).toBe(false);
  });

  it("28. no authenticated/anon execute on private.enqueue_notification_event", async () => {
    const rows = await testDb<{ role: string; can: boolean }[]>`
      select role, has_function_privilege(role, 'private.enqueue_notification_event(uuid, text, uuid, jsonb)', 'EXECUTE') as can
      from unnest(array['authenticated', 'anon']) as role
    `;
    for (const row of rows) expect(row.can).toBe(false);
  });

  it("29. no public wrapper exists for enqueue_notification_event", async () => {
    const rows = await testDb<{ n: number }[]>`
      select count(*)::int as n from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'enqueue_notification_event'
    `;
    expect(rows[0]!.n).toBe(0);
  });

  it("30. booking_gateway's effective privilege surface is still exactly create_guest_booking", async () => {
    const rows = await testDb<{ schema: string; name: string; can_execute: boolean }[]>`
      select n.nspname as schema, p.proname as name, has_function_privilege('booking_gateway', p.oid, 'EXECUTE') as can_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`;
    const executable = rows.filter((r) => r.can_execute).map((r) => `${r.schema}.${r.name}`);
    expect(executable).toEqual(["public.create_guest_booking"]);
  });

  it("31. cross-tenant event fabrication impossible (tenant_id always derived from the appointment's own tenant)", async () => {
    const otherOwner = await createTestUser("notifb-other-owner");
    const otherTenantRow = await createTestTenant("test-notifb-other", otherOwner.id);
    const otherBranchId = await createBranch(otherTenantRow.id, "Other Branch");
    const otherService = await createService(otherTenantRow.id, "Other Service", 30, 100);
    await testDb`insert into service_branches (service_id, branch_id) values (${otherService.id}, ${otherBranchId})`;
    const otherStaff = await createStaffMember(otherTenantRow.id, "Other Staff");
    await linkStaffBranch(otherStaff.id, otherBranchId);
    await linkStaffService(otherStaff.id, otherService.id);
    for (let weekday = 0; weekday <= 6; weekday++) {
      await createStaffSchedule(otherTenantRow.id, otherStaff.id, weekday, "00:00", "23:59", null);
    }
    const otherOwnerClient = await signInAs(otherOwner);

    const start = nextSlot();
    const { data: otherAppointmentId } = await otherOwnerClient.rpc("create_appointment", {
      p_tenant_id: otherTenantRow.id,
      p_branch_id: otherBranchId,
      p_customer_id: (await createCustomer(otherTenantRow.id, "Other Customer")).id,
      p_items: [makeItem(otherService, otherStaff, start)],
    });
    await otherOwnerClient.auth.signOut();

    // Directly probe the enqueue function (as the DB superuser test
    // connection, bypassing any RPC) to prove it derives tenant_id from
    // the appointment row itself, ignoring the fact that this
    // appointment belongs to a DIFFERENT tenant than tenant.id above —
    // there is no p_tenant_id parameter to even attempt to spoof.
    const [row] = await testDb<{ enqueue_notification_event: string }[]>`
      select private.enqueue_notification_event(${otherAppointmentId}::uuid, 'appointment.created', null, '{}'::jsonb)
    `;
    const [event] = await testDb<{ tenant_id: string }[]>`
      select tenant_id from notification_events where id = ${row!.enqueue_notification_event}
    `;
    expect(event!.tenant_id).toBe(otherTenantRow.id);
    expect(event!.tenant_id).not.toBe(tenant.id);

    await cleanupTenants([otherTenantRow.id]);
    await cleanupUsers([otherOwner.id]);
  });
});

describe("PII", () => {
  it("32/33/34/35. event_data contains no customer name, phone, email, or notes", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    const newStart = new Date(start.getTime() + 3600_000);
    await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [makeItem(serviceA, staffB, newStart, 1)],
    });
    const events = await fetchEvents(appointmentId);
    const serialized = JSON.stringify(events.map((e) => e.event_data)).toLowerCase();
    expect(serialized).not.toContain("outbox customer"); // customer full_name
    expect(serialized).not.toContain("5559991111"); // any phone-shaped literal used elsewhere in this file
    expect(serialized).not.toContain("@example.com");
    expect(serialized).not.toContain("note");
  });
});

describe("immutability", () => {
  it("36. no browser event update/delete surface (covered structurally by security tests 26/27 — zero grants of any kind)", async () => {
    const rows = await testDb<{ priv: string; role: string; can: boolean }[]>`
      select priv, role, has_table_privilege(role, 'public.notification_events', priv) as can
      from unnest(array['UPDATE', 'DELETE']) as priv, unnest(array['authenticated', 'anon']) as role
    `;
    for (const row of rows) expect(row.can).toBe(false);
  });

  it("37. existing event facts unchanged by a later appointment mutation", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    const [createdEvent] = await fetchEvents(appointmentId);
    const snapshotBefore = { ...createdEvent };

    const newStart = new Date(start.getTime() + 3600_000);
    await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [makeItem(serviceA, staffB, newStart, 1)],
    });
    await ownerClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });

    const [createdEventAfter] = await fetchEvents(appointmentId);
    expect(createdEventAfter).toEqual(snapshotBefore);
  });
});

/**
 * Faz NOTIF.2B.1 — event contract hardening. Adds the tests that phase
 * explicitly required on top of the NOTIF.2B suite above: one canonical
 * appointment.rescheduled payload for both mutation paths, schema_version
 * on every event, deterministic staff-id array ordering, and the
 * corrected appointment_id FK contract (NO ACTION, not CASCADE).
 */
describe("canonical appointment.rescheduled contract", () => {
  it("1. internal reschedule payload shape exactly matches the V1 canonical schema", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    const newStart = new Date(start.getTime() + 3600_000);
    await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [makeItem(serviceA, staffA, newStart, 1)],
    });
    const events = await fetchEvents(appointmentId);
    const rescheduled = events.find((e) => e.event_type === "appointment.rescheduled")!;
    expect(Object.keys(rescheduled.event_data).sort()).toEqual(["after", "before"]);
    const before = rescheduled.event_data.before as Record<string, unknown>[];
    const after = rescheduled.event_data.after as Record<string, unknown>[];
    expect(Object.keys(before[0]!).sort()).toEqual(["scheduledStartAt", "sequence", "staffMemberId"]);
    expect(Object.keys(after[0]!).sort()).toEqual(["scheduledStartAt", "sequence", "staffMemberId"]);
  });

  it("2. customer reschedule payload shape exactly matches THE SAME schema", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)], custCustomerId);
    const newStart = new Date(start.getTime() + 3600_000);
    await custClient.rpc("reschedule_my_appointment", { p_appointment_id: appointmentId, p_new_start_at: newStart.toISOString() });
    const events = await fetchEvents(appointmentId);
    const rescheduled = events.find((e) => e.event_type === "appointment.rescheduled")!;
    expect(Object.keys(rescheduled.event_data).sort()).toEqual(["after", "before"]);
    const before = rescheduled.event_data.before as Record<string, unknown>[];
    const after = rescheduled.event_data.after as Record<string, unknown>[];
    expect(Object.keys(before[0]!).sort()).toEqual(["scheduledStartAt", "sequence", "staffMemberId"]);
    expect(Object.keys(after[0]!).sort()).toEqual(["scheduledStartAt", "sequence", "staffMemberId"]);
  });

  it("3. internal and customer appointment.rescheduled objects have identical top-level event_data keys", async () => {
    const start1 = nextSlot();
    const internalId = await createInternalAppointment([makeItem(serviceA, staffA, start1, 1)]);
    await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: internalId,
      p_items: [makeItem(serviceA, staffA, new Date(start1.getTime() + 3600_000), 1)],
    });
    const start2 = nextSlot();
    const customerId2 = await createInternalAppointment([makeItem(serviceA, staffA, start2, 1)], custCustomerId);
    await custClient.rpc("reschedule_my_appointment", { p_appointment_id: customerId2, p_new_start_at: new Date(start2.getTime() + 3600_000).toISOString() });

    const internalEvent = (await fetchEvents(internalId)).find((e) => e.event_type === "appointment.rescheduled")!;
    const customerEvent = (await fetchEvents(customerId2)).find((e) => e.event_type === "appointment.rescheduled")!;
    expect(Object.keys(internalEvent.event_data).sort()).toEqual(Object.keys(customerEvent.event_data).sort());
  });

  it("6/7/8/9. multi-item customer reschedule preserves every item's sequence, booked staff, and shifted time in before/after", async () => {
    const start = nextSlot();
    const item2Start = new Date(start.getTime() + 3600_000);
    const appointmentId = await createInternalAppointment(
      [makeItem(serviceA, staffA, start, 1), makeItem(serviceB, staffB, item2Start, 2)],
      custCustomerId,
    );
    const delta = 2 * 3600_000;
    const { error } = await custClient.rpc("reschedule_my_appointment", {
      p_appointment_id: appointmentId,
      p_new_start_at: new Date(start.getTime() + delta).toISOString(),
    });
    expect(error).toBeNull();

    const rescheduled = (await fetchEvents(appointmentId)).find((e) => e.event_type === "appointment.rescheduled")!;
    const before = rescheduled.event_data.before as { sequence: number; staffMemberId: string; scheduledStartAt: string }[];
    const after = rescheduled.event_data.after as { sequence: number; staffMemberId: string; scheduledStartAt: string }[];
    expect(before.length).toBe(2); // every item preserved, none dropped
    expect(after.length).toBe(2);

    const beforeBySeq = new Map(before.map((i) => [i.sequence, i]));
    const afterBySeq = new Map(after.map((i) => [i.sequence, i]));
    expect([...beforeBySeq.keys()].sort()).toEqual([1, 2]); // sequence preserved
    expect([...afterBySeq.keys()].sort()).toEqual([1, 2]);

    // booked staff unchanged per item (customer reschedule never changes staff)
    expect(afterBySeq.get(1)!.staffMemberId).toBe(staffA.id);
    expect(afterBySeq.get(1)!.staffMemberId).toBe(beforeBySeq.get(1)!.staffMemberId);
    expect(afterBySeq.get(2)!.staffMemberId).toBe(staffB.id);
    expect(afterBySeq.get(2)!.staffMemberId).toBe(beforeBySeq.get(2)!.staffMemberId);

    // every item shifted by the identical delta
    expect(new Date(afterBySeq.get(1)!.scheduledStartAt).getTime() - new Date(beforeBySeq.get(1)!.scheduledStartAt).getTime()).toBe(delta);
    expect(new Date(afterBySeq.get(2)!.scheduledStartAt).getTime() - new Date(beforeBySeq.get(2)!.scheduledStartAt).getTime()).toBe(delta);
  });
});

describe("schema_version", () => {
  it("4. schema_version = 1 for created, cancelled, rescheduled, and staff_reassigned", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [makeItem(serviceA, staffB, start, 1)], // staff-only -> staff_reassigned, no time change
    });
    await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [makeItem(serviceA, staffB, new Date(start.getTime() + 3600_000), 1)], // time-only -> rescheduled
    });
    await ownerClient.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });

    const events = await fetchEvents(appointmentId);
    const byType = new Map(events.map((e) => [e.event_type, e]));
    for (const type of ["appointment.created", "appointment.staff_reassigned", "appointment.rescheduled", "appointment.cancelled"]) {
      expect(byType.get(type)!.schema_version).toBe(1);
    }
  });

  it("5. no event can have NULL schema_version (NOT NULL enforced at the DB level)", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    await expect(
      testDb`insert into notification_events (tenant_id, appointment_id, event_type, event_data, schema_version)
        values (${tenant.id}, ${appointmentId}, 'appointment.created', '{}'::jsonb, null)`,
    ).rejects.toThrow();
  });
});

describe("staff_reassigned determinism", () => {
  it("10. deterministic ordering — output arrays are sorted ascending, independent of input item order", async () => {
    const start = nextSlot();
    // Two distinct staff before, two distinct staff after — a real
    // multi-element reassignment, unlike every NOTIF.2B-era test (which
    // only ever exercised a single-element array, incapable of proving
    // ordering either way).
    const appointmentId = await createInternalAppointment([
      makeItem(serviceA, staffA, start, 1),
      makeItem(serviceB, staffB, new Date(start.getTime() + 3600_000), 2),
    ]);
    await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      // Deliberately reversed item order vs. creation, and deliberately
      // whichever of staffC/staffD sorts LOWER goes on sequence 2 (so a
      // naive "preserve input/creation order" bug would fail this).
      p_items: [
        makeItem(serviceB, staffD, new Date(start.getTime() + 3600_000), 2),
        makeItem(serviceA, staffC, start, 1),
      ],
    });
    const reassigned = (await fetchEvents(appointmentId)).find((e) => e.event_type === "appointment.staff_reassigned")!;
    const previous = reassigned.event_data.previousStaffMemberIds as string[];
    const created = reassigned.event_data.newStaffMemberIds as string[];
    expect(previous).toEqual([...previous].sort());
    expect(created).toEqual([...created].sort());
    expect(previous).toEqual([staffA.id, staffB.id].sort());
    expect(created).toEqual([staffC.id, staffD.id].sort());
  });
});

describe("actual_staff_member_id exclusion (canonical rescheduled payload)", () => {
  it("11. actual_staff_member_id never enters appointment.rescheduled event_data", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    const [item] = await testDb<{ id: string }[]>`select id from appointment_items where appointment_id = ${appointmentId}`;
    await testDb`update appointment_items set actual_staff_member_id = ${staffD.id} where id = ${item!.id}`;

    await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [makeItem(serviceA, staffA, new Date(start.getTime() + 3600_000), 1)], // time-only
    });
    const rescheduled = (await fetchEvents(appointmentId)).find((e) => e.event_type === "appointment.rescheduled")!;
    const serialized = JSON.stringify(rescheduled.event_data);
    expect(serialized).not.toContain(staffD.id);
  });

  it("12. canonical rescheduled payload still contains zero customer PII", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)], custCustomerId);
    const newStart = new Date(start.getTime() + 3600_000);
    await custClient.rpc("reschedule_my_appointment", { p_appointment_id: appointmentId, p_new_start_at: newStart.toISOString() });
    const rescheduled = (await fetchEvents(appointmentId)).find((e) => e.event_type === "appointment.rescheduled")!;
    const serialized = JSON.stringify(rescheduled.event_data).toLowerCase();
    expect(serialized).not.toContain("outbox cust account customer");
    expect(serialized).not.toContain("@example.com");
    expect(serialized).not.toContain("note");
  });
});

describe("appointment FK contract (NO ACTION, not CASCADE)", () => {
  it("13/14. hard-deleting an appointment with existing events fails, and event history survives the failed attempt", async () => {
    const start = nextSlot();
    const appointmentId = await createInternalAppointment([makeItem(serviceA, staffA, start, 1)]);
    const before = await fetchEvents(appointmentId);
    expect(before.length).toBe(1); // the creation event exists

    await expect(testDb`delete from public.appointments where id = ${appointmentId}`).rejects.toThrow();

    const after = await fetchEvents(appointmentId);
    expect(after).toEqual(before); // nothing was silently lost
    const [stillThere] = await testDb<{ id: string }[]>`select id from public.appointments where id = ${appointmentId}`;
    expect(stillThere).toBeDefined(); // the appointment itself also survived (delete never committed)
  });

  it("create_guest_booking's own internal rollback-delete path is unaffected (deletes an appointment with zero events, before any is ever enqueued)", async () => {
    const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
    await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${tenant.id}, ${feature!.id}, true) on conflict do nothing`;
    const start = nextSlot();
    // serviceA IS offered at this brand-new branch (so create_guest_
    // booking gets past its own BK003 service-at-branch check and
    // actually inserts the appointment header), but staffA is
    // deliberately NOT linked to it via staff_branches -> AP009 inside
    // create_guest_booking's own explicit-staff branch -> its internal
    // delete-on-failure fires, then re-raises as BK004.
    const lonelyBranchId = await createBranch(tenant.id, "Lonely Branch");
    await linkServiceBranch(serviceA.id, lonelyBranchId);
    const before = await tenantEventCount();
    await expect(
      testDb`select public.create_guest_booking(
        ${tenant.slug}, ${lonelyBranchId}::uuid, ${serviceA.id}::uuid, ${start.toISOString()}::timestamptz,
        'Lonely Guest', '5559993333', ${staffA.id}::uuid, null, ${crypto.randomUUID()}::uuid, null
      )`,
    ).rejects.toThrow();
    const after = await tenantEventCount();
    expect(after).toBe(before); // no orphaned event, no leftover appointment either (rolled back)
  });
});

