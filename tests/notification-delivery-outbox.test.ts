import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  admin,
  anonClient,
  testDb,
  signInAs,
  createTestUser,
  createTestTenant,
  createTestMembershipFromTemplate,
  addMembership,
  createBranch,
  createService,
  createStaffMember,
  createStaffSchedule,
  createCustomer,
  linkStaffBranch,
  linkStaffService,
  safeMorningStart,
  cleanupTenants,
  cleanupUsers,
  type TestUser,
  type TestTenant,
} from "./helpers";

/**
 * Faz NOTIF.2E.1 — recipient-resolution + delivery-outbox foundation.
 *
 * One real appointment lifecycle (create -> reschedule time-only ->
 * reschedule staff-only -> cancel), driven entirely through the real
 * appointment-mutation RPCs (same precedent as notification-outbox.
 * test.ts), against one fixed recipient roster covering every gate in
 * the recipient contract at once:
 *
 *   receptionist      — eligible admin (appointments.create+view),
 *                        active, default prefs -> receives every event
 *   prefDisabledAdmin — eligible admin, but cancellation pref disabled
 *                        -> receives created/rescheduled/staff_reassigned,
 *                        NOT cancelled
 *   stockManager      — active membership, no appointments.view/create
 *                        at all -> never a recipient
 *   suspendedAdmin    — otherwise-eligible admin, status='suspended'
 *                        -> never a recipient
 *   staffEligible     — assigned staff, has a linked membership (STYLIST)
 *                        -> recipient while assigned, and as
 *                        "previousStaffMemberId" after reassignment
 *   staffNoMembership — assigned staff, tenant_membership_id IS NULL
 *                        -> never a recipient regardless of assignment
 *   newlyAssignedStaff — becomes assigned only via the staff_reassigned
 *                        step -> recipient only from that event onward
 *   owner             — performs every mutation (actor_user_id for
 *                        every event) -> excluded from every delivery
 *                        despite otherwise qualifying as an admin
 *
 * This does NOT send anything: no push_subscriptions read, no web-push
 * call. Only public.materialize_notification_deliveries is exercised.
 */

let tenant: TestTenant;
let owner: TestUser;
let receptionist: TestUser;
let prefDisabledAdmin: TestUser;
let stockManager: TestUser;
let suspendedAdmin: TestUser;
let staffEligibleUser: TestUser;
let newlyAssignedStaffUser: TestUser;

let ownerClient: SupabaseClient;
let prefDisabledAdminClient: SupabaseClient;

let branchId: string;
let service: { id: string; name: string; durationMinutes: number; price: number };
let staffEligible: { id: string; fullName: string };
let staffNoMembership: { id: string; fullName: string };
let newlyAssignedStaff: { id: string; fullName: string };
let customerId: string;

let slotCounter = -1;
function nextSlot(): Date {
  slotCounter += 1;
  return new Date(safeMorningStart(1 + slotCounter).getTime());
}

type Item = { service_id: string; staff_member_id: string; scheduled_start_at: string; sequence: number };
function item(staffMemberId: string, start: Date, sequence: number): Item {
  return { service_id: service.id, staff_member_id: staffMemberId, scheduled_start_at: start.toISOString(), sequence };
}

type DeliveryRow = { tenant_membership_id: string; status: string; channel: string };
async function deliveriesFor(eventId: string): Promise<DeliveryRow[]> {
  return testDb<DeliveryRow[]>`
    select tenant_membership_id, status, channel from notification_deliveries where notification_event_id = ${eventId}
  `;
}
async function latestEvent(appointmentId: string, eventType: string): Promise<{ id: string }> {
  const [row] = await testDb<{ id: string }[]>`
    select id from notification_events
    where appointment_id = ${appointmentId} and event_type = ${eventType}
    order by created_at desc limit 1
  `;
  if (!row) throw new Error(`no ${eventType} event found for appointment ${appointmentId}`);
  return row;
}
async function membershipIdFor(userId: string): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${userId}
  `;
  if (!row) throw new Error(`no membership found for user ${userId}`);
  return row.id;
}

beforeAll(async () => {
  owner = await createTestUser("notif2e1-owner");
  const tenantRow = await createTestTenant("notif2e1-outbox", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug, ownerRoleId: tenantRow.ownerRoleId };

  branchId = await createBranch(tenant.id, "NOTIF.2E.1 Branch");
  service = await createService(tenant.id, "NOTIF.2E.1 Service", 30, 200);
  await testDb`insert into service_branches (service_id, branch_id) values (${service.id}, ${branchId})`;

  staffEligible = await createStaffMember(tenant.id, "Staff Eligible");
  staffNoMembership = await createStaffMember(tenant.id, "Staff No Membership");
  newlyAssignedStaff = await createStaffMember(tenant.id, "Newly Assigned Staff");
  for (const s of [staffEligible, staffNoMembership, newlyAssignedStaff]) {
    await linkStaffBranch(s.id, branchId);
    await linkStaffService(s.id, service.id);
    for (let weekday = 0; weekday <= 6; weekday++) {
      await createStaffSchedule(tenant.id, s.id, weekday, "00:00", "23:59", null);
    }
  }

  const customer = await createCustomer(tenant.id, "NOTIF.2E.1 Customer");
  customerId = customer.id;

  // --- Recipient roster -------------------------------------------------
  // roles has a UNIQUE(tenant_id, name) constraint — cloning the same
  // template twice for the same tenant collides on it, so the
  // RECEPTIONIST role is cloned ONCE and both admin-path users are
  // added as members of that one role.
  receptionist = await createTestUser("notif2e1-receptionist");
  const { roleId: receptionistRoleId } = await createTestMembershipFromTemplate(
    tenant.id,
    receptionist.id,
    "RECEPTIONIST",
  );

  prefDisabledAdmin = await createTestUser("notif2e1-prefdisabled");
  await addMembership(tenant.id, prefDisabledAdmin.id, receptionistRoleId);

  stockManager = await createTestUser("notif2e1-stockmanager");
  await createTestMembershipFromTemplate(tenant.id, stockManager.id, "STOCK_MANAGER");

  // SALON_OWNER was already cloned once by createTestTenant itself (for
  // `owner`) — reuse that same role id (tenant.ownerRoleId) rather than
  // cloning the template again, which would collide on
  // roles' UNIQUE(tenant_id, name) the same way RECEPTIONIST/STYLIST did
  // above.
  suspendedAdmin = await createTestUser("notif2e1-suspended");
  await addMembership(tenant.id, suspendedAdmin.id, tenant.ownerRoleId);
  await testDb`update tenant_memberships set status = 'suspended' where tenant_id = ${tenant.id} and user_id = ${suspendedAdmin.id}`;

  // Same UNIQUE(tenant_id, name) reasoning as RECEPTIONIST above — STYLIST
  // is cloned once, both staff-path users join that one role.
  staffEligibleUser = await createTestUser("notif2e1-staffeligible");
  const { roleId: stylistRoleId } = await createTestMembershipFromTemplate(tenant.id, staffEligibleUser.id, "STYLIST");
  const staffEligibleMembershipId = await membershipIdFor(staffEligibleUser.id);
  await testDb`update staff_members set tenant_membership_id = ${staffEligibleMembershipId} where id = ${staffEligible.id}`;

  // staffNoMembership deliberately gets NO linked user/membership at all
  // — tenant_membership_id stays NULL, per this phase's own rule.

  newlyAssignedStaffUser = await createTestUser("notif2e1-newlyassigned");
  await addMembership(tenant.id, newlyAssignedStaffUser.id, stylistRoleId);
  const newlyAssignedMembershipId = await membershipIdFor(newlyAssignedStaffUser.id);
  await testDb`update staff_members set tenant_membership_id = ${newlyAssignedMembershipId} where id = ${newlyAssignedStaff.id}`;

  ownerClient = await signInAs(owner);
  prefDisabledAdminClient = await signInAs(prefDisabledAdmin);

  // Disable ONLY the cancellation preference for prefDisabledAdmin —
  // isolates the "preference disabled for this event type only" case
  // without affecting created/rescheduled/staff_reassigned for the same
  // person.
  const { error: prefError } = await prefDisabledAdminClient.rpc("update_my_notification_preferences", {
    p_tenant_id: tenant.id,
    p_cancellation: false,
  });
  if (prefError) throw new Error("failed to disable cancellation preference: " + prefError.message);
}, 60000);

afterAll(async () => {
  await ownerClient.auth.signOut();
  await prefDisabledAdminClient.auth.signOut();
  await cleanupTenants([tenant.id]);
  await cleanupUsers([
    owner.id,
    receptionist.id,
    prefDisabledAdmin.id,
    stockManager.id,
    suspendedAdmin.id,
    staffEligibleUser.id,
    newlyAssignedStaffUser.id,
  ]);
}, 60000);

describe("appointment.created", () => {
  let appointmentId: string;
  let eventId: string;

  it("materializes exactly the eligible recipients — receptionist + prefDisabledAdmin (admin) + staffEligible (assigned); NOT owner (actor), stockManager (no view), suspendedAdmin (inactive), staffNoMembership (no membership)", async () => {
    const start = nextSlot();
    const { data, error } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customerId,
      p_items: [item(staffEligible.id, start, 1), item(staffNoMembership.id, start, 2)],
    });
    expect(error).toBeNull();
    appointmentId = data as string;
    const event = await latestEvent(appointmentId, "appointment.created");
    eventId = event.id;

    const { data: result, error: rpcError } = await admin.rpc("materialize_notification_deliveries", {
      p_event_id: eventId,
    });
    expect(rpcError).toBeNull();
    expect((result as { created: number }).created).toBe(3);

    const rows = await deliveriesFor(eventId);
    const membershipIds = new Set(rows.map((r) => r.tenant_membership_id));
    expect(membershipIds.has(await membershipIdFor(receptionist.id))).toBe(true);
    expect(membershipIds.has(await membershipIdFor(prefDisabledAdmin.id))).toBe(true);
    expect(membershipIds.has(await membershipIdFor(staffEligibleUser.id))).toBe(true);
    expect(membershipIds.has(await membershipIdFor(owner.id))).toBe(false);
    expect(membershipIds.has(await membershipIdFor(stockManager.id))).toBe(false);
    expect(membershipIds.has(await membershipIdFor(suspendedAdmin.id))).toBe(false);
    expect(membershipIds.has(await membershipIdFor(newlyAssignedStaffUser.id))).toBe(false);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.channel === "web_push" && r.status === "pending")).toBe(true);
  });

  it("duplicate materialization call creates zero additional rows", async () => {
    const { data: result } = await admin.rpc("materialize_notification_deliveries", { p_event_id: eventId });
    expect((result as { created: number }).created).toBe(0);
    const rows = await deliveriesFor(eventId);
    expect(rows.length).toBe(3);
  });
});

describe("appointment.rescheduled (time-only — staff unchanged)", () => {
  let appointmentId: string;
  let eventId: string;
  let rescheduledStart: Date;

  it("materializes the same admin+staff set as created, keyed off the event's OWN after-snapshot", async () => {
    const [row] = await testDb<{ appointment_id: string }[]>`
      select appointment_id from notification_events
      where tenant_id = ${tenant.id} and event_type = 'appointment.created'
      order by created_at asc limit 1
    `;
    appointmentId = row!.appointment_id;

    rescheduledStart = nextSlot();
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [item(staffEligible.id, rescheduledStart, 1), item(staffNoMembership.id, rescheduledStart, 2)],
    });
    expect(error).toBeNull();

    const event = await latestEvent(appointmentId, "appointment.rescheduled");
    eventId = event.id;
    const { data: result } = await admin.rpc("materialize_notification_deliveries", { p_event_id: eventId });
    expect((result as { created: number }).created).toBe(3);

    const rows = await deliveriesFor(eventId);
    const membershipIds = new Set(rows.map((r) => r.tenant_membership_id));
    expect(membershipIds.has(await membershipIdFor(receptionist.id))).toBe(true);
    expect(membershipIds.has(await membershipIdFor(prefDisabledAdmin.id))).toBe(true);
    expect(membershipIds.has(await membershipIdFor(staffEligibleUser.id))).toBe(true);
    expect(membershipIds.has(await membershipIdFor(owner.id))).toBe(false);
    expect(rows.length).toBe(3);
  });

  it("duplicate materialization call creates zero additional rows", async () => {
    const { data: result } = await admin.rpc("materialize_notification_deliveries", { p_event_id: eventId });
    expect((result as { created: number }).created).toBe(0);
    expect((await deliveriesFor(eventId)).length).toBe(3);
  });

  it("no appointment.staff_reassigned event was emitted for a time-only reschedule", async () => {
    const events = await testDb<{ event_type: string }[]>`
      select event_type from notification_events where appointment_id = ${appointmentId} and event_type = 'appointment.staff_reassigned'
    `;
    expect(events.length).toBe(0);
  });
});

describe("appointment.staff_reassigned (staff-only — time unchanged)", () => {
  let appointmentId: string;
  let eventId: string;

  it("materializes admins + BOTH previously and newly assigned staff, never the never-linked staffNoMembership", async () => {
    const [row] = await testDb<{ appointment_id: string; start: string }[]>`
      select ai.appointment_id, ai.scheduled_start_at::text as start
      from appointment_items ai
      join notification_events ne on ne.appointment_id = ai.appointment_id
      where ne.tenant_id = ${tenant.id} and ne.event_type = 'appointment.rescheduled'
      order by ne.created_at desc limit 1
    `;
    appointmentId = row!.appointment_id;
    const sameStart = new Date(row!.start);

    // staffEligible (item 1) -> newlyAssignedStaff; staffNoMembership
    // (item 2) unchanged. Time held fixed so only staff_reassigned fires.
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [item(newlyAssignedStaff.id, sameStart, 1), item(staffNoMembership.id, sameStart, 2)],
    });
    expect(error).toBeNull();

    const event = await latestEvent(appointmentId, "appointment.staff_reassigned");
    eventId = event.id;
    const eventData = await testDb<{ event_data: { previousStaffMemberIds: string[]; newStaffMemberIds: string[] } }[]>`
      select event_data from notification_events where id = ${eventId}
    `;
    expect(eventData[0]!.event_data.previousStaffMemberIds).toEqual([staffEligible.id]);
    expect(eventData[0]!.event_data.newStaffMemberIds).toEqual([newlyAssignedStaff.id]);

    const { data: result } = await admin.rpc("materialize_notification_deliveries", { p_event_id: eventId });
    expect((result as { created: number }).created).toBe(4);

    const rows = await deliveriesFor(eventId);
    const membershipIds = new Set(rows.map((r) => r.tenant_membership_id));
    expect(membershipIds.has(await membershipIdFor(receptionist.id))).toBe(true);
    expect(membershipIds.has(await membershipIdFor(prefDisabledAdmin.id))).toBe(true);
    expect(membershipIds.has(await membershipIdFor(staffEligibleUser.id))).toBe(true); // previously assigned
    expect(membershipIds.has(await membershipIdFor(newlyAssignedStaffUser.id))).toBe(true); // newly assigned
    expect(membershipIds.has(await membershipIdFor(owner.id))).toBe(false);
    expect(rows.length).toBe(4);
  });

  it("duplicate materialization call creates zero additional rows", async () => {
    const { data: result } = await admin.rpc("materialize_notification_deliveries", { p_event_id: eventId });
    expect((result as { created: number }).created).toBe(0);
    expect((await deliveriesFor(eventId)).length).toBe(4);
  });

  it("no appointment.rescheduled event was emitted for a staff-only reassignment", async () => {
    const events = await testDb<{ id: string }[]>`
      select id from notification_events where appointment_id = ${appointmentId} and event_type = 'appointment.rescheduled'
    `;
    // Exactly one — the earlier time-only reschedule from the previous
    // describe block — never a second one from this staff-only change.
    expect(events.length).toBe(1);
  });
});

describe("appointment.cancelled", () => {
  let appointmentId: string;
  let eventId: string;

  it("materializes admins (minus prefDisabledAdmin, whose cancellation preference is disabled) + the CURRENTLY assigned staff at cancellation time", async () => {
    const [row] = await testDb<{ appointment_id: string }[]>`
      select appointment_id from notification_events
      where tenant_id = ${tenant.id} and event_type = 'appointment.staff_reassigned'
      order by created_at desc limit 1
    `;
    appointmentId = row!.appointment_id;

    const { error } = await ownerClient.rpc("update_appointment_status", {
      p_appointment_id: appointmentId,
      p_new_status: "cancelled",
    });
    expect(error).toBeNull();

    const event = await latestEvent(appointmentId, "appointment.cancelled");
    eventId = event.id;
    const { data: result } = await admin.rpc("materialize_notification_deliveries", { p_event_id: eventId });
    expect((result as { created: number }).created).toBe(2);

    const rows = await deliveriesFor(eventId);
    const membershipIds = new Set(rows.map((r) => r.tenant_membership_id));
    expect(membershipIds.has(await membershipIdFor(receptionist.id))).toBe(true);
    expect(membershipIds.has(await membershipIdFor(newlyAssignedStaffUser.id))).toBe(true); // assigned at cancel time
    expect(membershipIds.has(await membershipIdFor(prefDisabledAdmin.id))).toBe(false); // preference disabled
    expect(membershipIds.has(await membershipIdFor(staffEligibleUser.id))).toBe(false); // no longer assigned
    expect(membershipIds.has(await membershipIdFor(owner.id))).toBe(false); // actor
    expect(rows.length).toBe(2);
  });

  it("duplicate materialization call creates zero additional rows", async () => {
    const { data: result } = await admin.rpc("materialize_notification_deliveries", { p_event_id: eventId });
    expect((result as { created: number }).created).toBe(0);
    expect((await deliveriesFor(eventId)).length).toBe(2);
  });
});

describe("materialize_notification_deliveries — robustness", () => {
  it("unknown event id is a safe no-op, not an error", async () => {
    const { data, error } = await admin.rpc("materialize_notification_deliveries", {
      p_event_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(error).toBeNull();
    expect((data as { created: number; reason?: string }).created).toBe(0);
    expect((data as { reason?: string }).reason).toBe("event_not_found");
  });
});

// ================ NOTIF.2E.1A — historical recipient correctness ================
// A separate, dedicated fixture (its own tenant) — this needs a precise
// create -> reassign-BEFORE-materializing -> materialize-the-OLD-event
// sequence that would be awkward to interleave with the shared lifecycle
// fixture above.

describe("NOTIF.2E.1A — event-time staff snapshots + materialization completion state", () => {
  let tenant2: TestTenant;
  let owner2: TestUser;
  let branchId2: string;
  let service2: { id: string; name: string; durationMinutes: number; price: number };
  let staffA: { id: string; fullName: string };
  let staffB: { id: string; fullName: string };
  let staffAUser: TestUser;
  let staffBUser: TestUser;
  let customer2: string;
  let ownerClient2: SupabaseClient;
  let slot2 = -1;
  function nextSlot2(): Date {
    slot2 += 1;
    return new Date(safeMorningStart(1 + slot2).getTime());
  }

  beforeAll(async () => {
    owner2 = await createTestUser("notif2e1a-owner");
    const t = await createTestTenant("notif2e1a-histcorrect", owner2.id);
    tenant2 = { id: t.id, slug: t.slug, ownerRoleId: t.ownerRoleId };
    branchId2 = await createBranch(tenant2.id, "NOTIF.2E.1A Branch");
    service2 = await createService(tenant2.id, "NOTIF.2E.1A Service", 30, 100);
    await testDb`insert into service_branches (service_id, branch_id) values (${service2.id}, ${branchId2})`;

    staffA = await createStaffMember(tenant2.id, "2E1A Staff A");
    staffB = await createStaffMember(tenant2.id, "2E1A Staff B");
    for (const s of [staffA, staffB]) {
      await linkStaffBranch(s.id, branchId2);
      await linkStaffService(s.id, service2.id);
      for (let weekday = 0; weekday <= 6; weekday++) {
        await createStaffSchedule(tenant2.id, s.id, weekday, "00:00", "23:59", null);
      }
    }

    staffAUser = await createTestUser("notif2e1a-staffA");
    const { roleId } = await createTestMembershipFromTemplate(tenant2.id, staffAUser.id, "STYLIST");
    const staffAMembership = await membershipIdFor2(tenant2.id, staffAUser.id);
    await testDb`update staff_members set tenant_membership_id = ${staffAMembership} where id = ${staffA.id}`;

    staffBUser = await createTestUser("notif2e1a-staffB");
    await addMembership(tenant2.id, staffBUser.id, roleId);
    const staffBMembership = await membershipIdFor2(tenant2.id, staffBUser.id);
    await testDb`update staff_members set tenant_membership_id = ${staffBMembership} where id = ${staffB.id}`;

    const cust = await createCustomer(tenant2.id, "NOTIF.2E.1A Customer");
    customer2 = cust.id;
    ownerClient2 = await signInAs(owner2);
  }, 60000);

  afterAll(async () => {
    await ownerClient2.auth.signOut();
    await cleanupTenants([tenant2.id]);
    await cleanupUsers([owner2.id, staffAUser.id, staffBUser.id]);
  }, 60000);

  async function membershipIdFor2(tenantId: string, userId: string): Promise<string> {
    const [row] = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${tenantId} and user_id = ${userId}
    `;
    if (!row) throw new Error(`no membership for ${userId}`);
    return row.id;
  }

  it("A. CREATED: the appointment.created event carries a staffMemberIds snapshot equal to Staff A", async () => {
    const start = nextSlot2();
    const { data: appointmentId, error } = await ownerClient2.rpc("create_appointment", {
      p_tenant_id: tenant2.id,
      p_branch_id: branchId2,
      p_customer_id: customer2,
      p_items: [{ service_id: service2.id, staff_member_id: staffA.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
    });
    expect(error).toBeNull();
    const [event] = await testDb<{ id: string; event_data: { staffMemberIds: string[] } }[]>`
      select id, event_data from notification_events
      where appointment_id = ${appointmentId as string} and event_type = 'appointment.created'
    `;
    expect(event!.event_data.staffMemberIds).toEqual([staffA.id]);
  });

  it("A. CREATED: reassigning to Staff B BEFORE materializing the ORIGINAL created event still resolves Staff A, never Staff B — the exact bug reproduced live on DEV before this fix existed", async () => {
    const start = nextSlot2();
    const { data: appointmentId, error: createError } = await ownerClient2.rpc("create_appointment", {
      p_tenant_id: tenant2.id,
      p_branch_id: branchId2,
      p_customer_id: customer2,
      p_items: [{ service_id: service2.id, staff_member_id: staffA.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
    });
    expect(createError).toBeNull();

    const [createdEvent] = await testDb<{ id: string }[]>`
      select id from notification_events where appointment_id = ${appointmentId as string} and event_type = 'appointment.created'
    `;

    // Reassign to Staff B BEFORE the original created event is ever
    // materialized — live appointment_items now shows Staff B.
    const { error: reassignError } = await ownerClient2.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [{ service_id: service2.id, staff_member_id: staffB.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
    });
    expect(reassignError).toBeNull();
    const liveStaff = await testDb<{ staff_member_id: string }[]>`
      select staff_member_id from appointment_items where appointment_id = ${appointmentId as string}
    `;
    expect(liveStaff[0]!.staff_member_id).toBe(staffB.id); // confirms live state has genuinely diverged

    const { data: result, error: materializeError } = await admin.rpc("materialize_notification_deliveries", {
      p_event_id: createdEvent!.id,
    });
    expect(materializeError).toBeNull();
    expect((result as { created: number }).created).toBeGreaterThan(0);

    const rows = await testDb<{ tenant_membership_id: string }[]>`
      select tenant_membership_id from notification_deliveries where notification_event_id = ${createdEvent!.id}
    `;
    const membershipIds = new Set(rows.map((r) => r.tenant_membership_id));
    expect(membershipIds.has(await membershipIdFor2(tenant2.id, staffAUser.id))).toBe(true);
    expect(membershipIds.has(await membershipIdFor2(tenant2.id, staffBUser.id))).toBe(false);
  });

  it("B. CANCELLED: the appointment.cancelled event carries a staffMemberIds snapshot, and materialization resolves it from that snapshot", async () => {
    const start = nextSlot2();
    const { data: appointmentId, error: createError } = await ownerClient2.rpc("create_appointment", {
      p_tenant_id: tenant2.id,
      p_branch_id: branchId2,
      p_customer_id: customer2,
      p_items: [{ service_id: service2.id, staff_member_id: staffA.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
    });
    expect(createError).toBeNull();

    const { error: cancelError } = await ownerClient2.rpc("update_appointment_status", {
      p_appointment_id: appointmentId,
      p_new_status: "cancelled",
    });
    expect(cancelError).toBeNull();

    const [cancelledEvent] = await testDb<{ id: string; event_data: { staffMemberIds: string[] } }[]>`
      select id, event_data from notification_events where appointment_id = ${appointmentId as string} and event_type = 'appointment.cancelled'
    `;
    expect(cancelledEvent!.event_data.staffMemberIds).toEqual([staffA.id]);

    const { data: result } = await admin.rpc("materialize_notification_deliveries", { p_event_id: cancelledEvent!.id });
    expect((result as { created: number }).created).toBeGreaterThan(0);
    const rows = await testDb<{ tenant_membership_id: string }[]>`
      select tenant_membership_id from notification_deliveries where notification_event_id = ${cancelledEvent!.id}
    `;
    const staffAMembershipId = await membershipIdFor2(tenant2.id, staffAUser.id);
    expect(rows.some((r) => r.tenant_membership_id === staffAMembershipId)).toBe(true);
  });

  it("legacy fallback: a hand-inserted event_data={} row (simulating a pre-NOTIF.2E.1A row) still resolves from LIVE appointment_items, exactly the 20260914130000 behavior", async () => {
    const start = nextSlot2();
    const { data: appointmentId, error: createError } = await ownerClient2.rpc("create_appointment", {
      p_tenant_id: tenant2.id,
      p_branch_id: branchId2,
      p_customer_id: customer2,
      p_items: [{ service_id: service2.id, staff_member_id: staffA.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
    });
    expect(createError).toBeNull();

    // Hand-inserted, simulating a genuinely legacy row — testDb is the
    // same trusted direct-Postgres path every other adversarial/legacy-
    // shape test in this project's suite uses; notification_events has
    // no INSERT grant to any browser role regardless of this insert's
    // origin.
    const [legacyEvent] = await testDb<{ id: string }[]>`
      insert into notification_events (tenant_id, appointment_id, event_type, actor_user_id, event_data)
      values (${tenant2.id}, ${appointmentId as string}, 'appointment.created', null, '{}'::jsonb)
      returning id
    `;

    const { data: result, error } = await admin.rpc("materialize_notification_deliveries", {
      p_event_id: legacyEvent!.id,
    });
    expect(error).toBeNull();
    expect((result as { created: number }).created).toBeGreaterThan(0);
    const rows = await testDb<{ tenant_membership_id: string }[]>`
      select tenant_membership_id from notification_deliveries where notification_event_id = ${legacyEvent!.id}
    `;
    // Staff A is still live-current here (nothing reassigned this
    // appointment in this test) — the fallback correctly reaches the
    // same right answer via the old mechanism, proving the fallback
    // path itself works, not just that it's unreachable.
    const staffAMembershipId = await membershipIdFor2(tenant2.id, staffAUser.id);
    expect(rows.some((r) => r.tenant_membership_id === staffAMembershipId)).toBe(true);
  });

  it("zero-recipient event still gets a durable completion marker with recipient_count = 0, not zero deliveries and no marker", async () => {
    // The actor (owner2) is the only otherwise-eligible admin in this
    // tenant, and is excluded as the actor — engineering a genuine
    // zero-eligible-recipient event without inventing a new tenant.
    const start = nextSlot2();
    const { data: appointmentId, error: createError } = await ownerClient2.rpc("create_appointment", {
      p_tenant_id: tenant2.id,
      p_branch_id: branchId2,
      p_customer_id: customer2,
      p_items: [{ service_id: service2.id, staff_member_id: staffA.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
    });
    expect(createError).toBeNull();
    // Disable staffA's own new_appointment preference so the only
    // otherwise-eligible person besides the (excluded) actor is gone too.
    const staffAClient = await signInAs(staffAUser);
    await staffAClient.rpc("update_my_notification_preferences", { p_tenant_id: tenant2.id, p_new_appointment: false });
    await staffAClient.auth.signOut();

    const [event] = await testDb<{ id: string }[]>`
      select id from notification_events where appointment_id = ${appointmentId as string} and event_type = 'appointment.created'
    `;

    const { data: result, error } = await admin.rpc("materialize_notification_deliveries", { p_event_id: event!.id });
    expect(error).toBeNull();
    expect((result as { created: number; recipientCount: number }).created).toBe(0);
    expect((result as { recipientCount: number }).recipientCount).toBe(0);

    const deliveries = await testDb<{ id: string }[]>`select id from notification_deliveries where notification_event_id = ${event!.id}`;
    expect(deliveries.length).toBe(0);

    const marker = await testDb<{ recipient_count: number }[]>`
      select recipient_count from notification_event_materializations where notification_event_id = ${event!.id}
    `;
    expect(marker.length).toBe(1);
    expect(marker[0]!.recipient_count).toBe(0);

    // Repeated call: must short-circuit via the marker, not recompute
    // and not error.
    const { data: result2, error: error2 } = await admin.rpc("materialize_notification_deliveries", { p_event_id: event!.id });
    expect(error2).toBeNull();
    expect((result2 as { alreadyMaterialized: boolean }).alreadyMaterialized).toBe(true);
    const markerCountAfter = await testDb<{ n: number }[]>`
      select count(*)::int as n from notification_event_materializations where notification_event_id = ${event!.id}
    `;
    expect(markerCountAfter[0]!.n).toBe(1); // still exactly one marker, never duplicated

    // Restore the preference so this tenant's fixture stays in the
    // expected default state for any later test in this describe block.
    const staffAClient2 = await signInAs(staffAUser);
    await staffAClient2.rpc("update_my_notification_preferences", { p_tenant_id: tenant2.id, p_new_appointment: true });
    await staffAClient2.auth.signOut();
  });

  it("cross-tenant snapshot poisoning: a hand-forged created event with a real-but-wrong-tenant staffMemberIds entry never creates a foreign-tenant recipient", async () => {
    const outsiderOwner = await createTestUser("notif2e1a-outsider-owner");
    const outsiderTenant = await createTestTenant("notif2e1a-outsider", outsiderOwner.id);
    const outsiderStaff = await createStaffMember(outsiderTenant.id, "Outsider Staff");
    const outsiderMembershipId = await membershipIdFor2(outsiderTenant.id, outsiderOwner.id);
    await testDb`update staff_members set tenant_membership_id = ${outsiderMembershipId} where id = ${outsiderStaff.id}`;

    const start = nextSlot2();
    const { data: appointmentId } = await ownerClient2.rpc("create_appointment", {
      p_tenant_id: tenant2.id,
      p_branch_id: branchId2,
      p_customer_id: customer2,
      p_items: [{ service_id: service2.id, staff_member_id: staffA.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
    });

    const [forgedEvent] = await testDb<{ id: string }[]>`
      insert into notification_events (tenant_id, appointment_id, event_type, actor_user_id, event_data)
      values (
        ${tenant2.id}, ${appointmentId as string}, 'appointment.created', null,
        ${testDb.json({ staffMemberIds: [outsiderStaff.id] })}
      )
      returning id
    `;

    const { data: result, error } = await admin.rpc("materialize_notification_deliveries", { p_event_id: forgedEvent!.id });
    expect(error).toBeNull();
    void result;

    const rows = await testDb<{ tenant_membership_id: string }[]>`
      select tenant_membership_id from notification_deliveries where notification_event_id = ${forgedEvent!.id}
    `;
    expect(rows.some((r) => r.tenant_membership_id === outsiderMembershipId)).toBe(false);

    await cleanupTenants([outsiderTenant.id]);
    await cleanupUsers([outsiderOwner.id]);
  });

  it("notification_event_materializations: zero DATA-ACCESS grants to anon/authenticated/service_role — reachable ONLY through the SECURITY DEFINER RPC, which needs no table grant of its own (it runs as the function owner)", async () => {
    // TRUNCATE/REFERENCES/TRIGGER are Postgres's own schema-maintenance
    // defaults on every table (20260817104813's documented, intentional
    // carve-out — not data access) and are correctly excluded from this
    // check, same convention as push_subscriptions/notification_
    // deliveries' own equivalent tests.
    const rows = await testDb<{ grantee: string; privilege_type: string }[]>`
      select grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'notification_event_materializations'
        and grantee in ('anon', 'authenticated', 'service_role')
        and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    `;
    expect(rows).toEqual([]);
  });
});

describe("cross-tenant security", () => {
  let tenantB: TestTenant;
  let ownerB: TestUser;
  let receptionistB: TestUser;

  beforeAll(async () => {
    ownerB = await createTestUser("notif2e1-ownerB");
    const tenantBRow = await createTestTenant("notif2e1-outbox-b", ownerB.id);
    tenantB = { id: tenantBRow.id, slug: tenantBRow.slug, ownerRoleId: tenantBRow.ownerRoleId };
    receptionistB = await createTestUser("notif2e1-receptionistB");
    await createTestMembershipFromTemplate(tenantB.id, receptionistB.id, "RECEPTIONIST");
  }, 30000);

  afterAll(async () => {
    await cleanupTenants([tenantB.id]);
    await cleanupUsers([ownerB.id, receptionistB.id]);
  });

  it("an event from tenant A never creates a delivery for a membership in tenant B", async () => {
    const [row] = await testDb<{ id: string }[]>`
      select id from notification_events where tenant_id = ${tenant.id} and event_type = 'appointment.created' limit 1
    `;
    const rows = await deliveriesFor(row!.id);
    const receptionistBMembershipId = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${tenantB.id} and user_id = ${receptionistB.id}
    `;
    expect(rows.some((r) => r.tenant_membership_id === receptionistBMembershipId[0]!.id)).toBe(false);
  });

  it("a spoofed/corrupt event_data staff id from tenant B can never escape the tenant boundary — even a staff_member row that legitimately exists in tenant B is silently dropped, not an error", async () => {
    // A hand-inserted event (via testDb, the same trusted direct-Postgres
    // path every other adversarial-input test in this project's suite
    // uses — notification_events has no INSERT grant to any browser
    // role regardless) simulating corrupt/forged event_data: a real
    // appointment in tenant A, but newStaffMemberIds pointing at a real
    // staff_member that belongs to tenant B.
    const [apptRow] = await testDb<{ appointment_id: string }[]>`
      select appointment_id from notification_events where tenant_id = ${tenant.id} limit 1
    `;
    const staffB = await createStaffMember(tenantB.id, "Tenant B Staff");
    const [linkedMembership] = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${tenantB.id} and user_id = ${receptionistB.id}
    `;
    await testDb`update staff_members set tenant_membership_id = ${linkedMembership!.id} where id = ${staffB.id}`;

    const [forgedEvent] = await testDb<{ id: string }[]>`
      insert into notification_events (tenant_id, appointment_id, event_type, actor_user_id, event_data)
      values (
        ${tenant.id}, ${apptRow!.appointment_id}, 'appointment.staff_reassigned', null,
        ${testDb.json({ previousStaffMemberIds: [], newStaffMemberIds: [staffB.id] })}
      )
      returning id
    `;

    const { data: result, error } = await admin.rpc("materialize_notification_deliveries", {
      p_event_id: forgedEvent!.id,
    });
    expect(error).toBeNull();
    // staffB's membership must never appear as a recipient of tenant
    // A's event, despite being a real, linked, otherwise-eligible
    // membership — only real in the WRONG tenant.
    const rows = await deliveriesFor(forgedEvent!.id);
    expect(rows.some((r) => r.tenant_membership_id === linkedMembership!.id)).toBe(false);
    void result;
  });

  it("authenticated cannot call materialize_notification_deliveries directly", async () => {
    const { error } = await ownerClient.rpc("materialize_notification_deliveries", {
      p_event_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(error).not.toBeNull();
  });

  it("anon cannot call materialize_notification_deliveries directly", async () => {
    const { error } = await anonClient().rpc("materialize_notification_deliveries", {
      p_event_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(error).not.toBeNull();
  });

  it("authenticated cannot read notification_deliveries directly", async () => {
    const { error } = await ownerClient.from("notification_deliveries").select("*").limit(1);
    expect(error).not.toBeNull();
  });

  it("anon cannot read notification_deliveries directly", async () => {
    const { error } = await anonClient().from("notification_deliveries").select("*").limit(1);
    expect(error).not.toBeNull();
  });
});

describe("security — grants", () => {
  it("notification_deliveries has zero table grants to authenticated/anon", async () => {
    const rows = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'notification_deliveries'
        and grantee in ('authenticated', 'anon')
    `;
    expect(rows).toEqual([]);
  });

  it("public.materialize_notification_deliveries is granted to service_role only, never anon/authenticated/PUBLIC", async () => {
    const rows = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'materialize_notification_deliveries'
    `;
    const grantees = new Set(rows.map((r) => r.grantee));
    expect(grantees.has("service_role")).toBe(true);
    expect(grantees.has("authenticated")).toBe(false);
    expect(grantees.has("anon")).toBe(false);
    expect(grantees.has("PUBLIC")).toBe(false);
  });

  it("private.materialize_notification_deliveries has zero grants to any named role", async () => {
    const rows = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.role_routine_grants
      where routine_schema = 'private' and routine_name = 'materialize_notification_deliveries'
        and grantee in ('authenticated', 'anon', 'PUBLIC', 'service_role')
    `;
    expect(rows).toEqual([]);
  });

  it("notification_events remains insert-only for the trusted internal path — this migration added no new browser-facing write path", async () => {
    const rows = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'notification_events'
        and grantee in ('authenticated', 'anon')
    `;
    expect(rows).toEqual([]);
  });
});
