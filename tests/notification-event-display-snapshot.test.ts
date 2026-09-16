import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  testDb,
  signInAs,
  createTestUser,
  createTestTenant,
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
 * Faz NOTIF.2F.1 — write-side correctness of notification_event_display_
 * snapshots: does each of the 6 trusted appointment-mutation RPCs capture
 * the right customer name / ordered service names / appointment start /
 * tenant timezone, in the SAME transaction, and does it stay immutable
 * against later customer/service/tenant mutations. Driven entirely
 * through the real RPCs (never a direct notification_events insert —
 * that fixture-bypass style belongs to tests/notification-delivery-
 * worker.test.ts, which owns worker READ-side correctness instead; the
 * one deliberate exception here is the "old event, no snapshot" case,
 * which specifically needs to simulate a pre-2F.1 row).
 *
 * Rich-copy RENDERING (buildDeliveryPushPayload — one/multiple services,
 * fallbacks, sanitization, worked date examples) and the worker's own
 * claim_notification_delivery_targets read-path are both covered in
 * tests/notification-delivery-worker.test.ts instead, to avoid
 * duplicating that machinery here.
 */

let tenant: TestTenant;
let owner: TestUser;
let ownerClient: SupabaseClient;
let branchId: string;
let service1: { id: string; name: string };
let service2: { id: string; name: string };
let staff1: { id: string; fullName: string };
let staff2: { id: string; fullName: string };
let customerId: string;
let tenantTimezone: string;
const cleanupUserIds: string[] = [];

// Customer-facing (cancel_my_appointment / reschedule_my_appointment) fixture.
let accountUser: TestUser;
let accountCustomerId: string;
let accountClient: SupabaseClient;

let slotCounter = -1;
function nextSlot(): Date {
  slotCounter += 1;
  return new Date(safeMorningStart(1 + slotCounter).getTime());
}

type Item = { service_id: string; staff_member_id: string; scheduled_start_at: string; sequence: number };
function item(serviceId: string, staffId: string, start: Date, sequence: number): Item {
  return { service_id: serviceId, staff_member_id: staffId, scheduled_start_at: start.toISOString(), sequence };
}

type SnapshotRow = {
  event_id: string;
  tenant_id: string;
  customer_name: string | null;
  service_names: string[];
  appointment_start_at: string | null;
  tenant_timezone: string;
};
async function snapshotFor(eventId: string): Promise<SnapshotRow | undefined> {
  const [row] = await testDb<SnapshotRow[]>`
    select event_id, tenant_id, customer_name, service_names, appointment_start_at, tenant_timezone
    from notification_event_display_snapshots where event_id = ${eventId}
  `;
  return row;
}
async function latestEvent(appointmentId: string, eventType: string): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    select id from notification_events
    where appointment_id = ${appointmentId} and event_type = ${eventType}
    order by created_at desc limit 1
  `;
  if (!row) throw new Error(`no ${eventType} event found for appointment ${appointmentId}`);
  return row.id;
}

beforeAll(async () => {
  owner = await createTestUser("notif2f1-owner");
  const tenantRow = await createTestTenant("notif2f1-snapshot", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug, ownerRoleId: tenantRow.ownerRoleId };
  cleanupUserIds.push(owner.id);
  ownerClient = await signInAs(owner);

  branchId = await createBranch(tenant.id, "NOTIF.2F.1 Branch");
  const svc1 = await createService(tenant.id, "Saç Kesimi", 30, 200);
  const svc2 = await createService(tenant.id, "Sakal", 15, 100);
  service1 = { id: svc1.id, name: "Saç Kesimi" };
  service2 = { id: svc2.id, name: "Sakal" };
  await testDb`insert into service_branches (service_id, branch_id) values (${service1.id}, ${branchId})`;
  await testDb`insert into service_branches (service_id, branch_id) values (${service2.id}, ${branchId})`;

  const s1 = await createStaffMember(tenant.id, "Staff One");
  const s2 = await createStaffMember(tenant.id, "Staff Two");
  staff1 = { id: s1.id, fullName: s1.fullName };
  staff2 = { id: s2.id, fullName: s2.fullName };
  for (const s of [staff1, staff2]) {
    await linkStaffBranch(s.id, branchId);
    await linkStaffService(s.id, service1.id);
    await linkStaffService(s.id, service2.id);
    for (let weekday = 0; weekday <= 6; weekday++) {
      await createStaffSchedule(tenant.id, s.id, weekday, "00:00", "23:59", null);
    }
  }

  const customer = await createCustomer(tenant.id, "Ayşe Yılmaz");
  customerId = customer.id;

  const [tenantTzRow] = await testDb<{ timezone: string }[]>`select timezone from tenants where id = ${tenant.id}`;
  tenantTimezone = tenantTzRow!.timezone;

  // Customer-facing fixture: a second customer with its own portal
  // account, linked via customer_account_links — same setup pattern as
  // tests/customer-cancellation.test.ts / customer-reschedule.test.ts.
  accountUser = await createTestUser("notif2f1-account");
  cleanupUserIds.push(accountUser.id);
  const linkedCustomer = await createCustomer(tenant.id, "Mehmet Demir");
  accountCustomerId = linkedCustomer.id;
  await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
    values (${accountUser.id}, ${tenant.id}, ${accountCustomerId}, 'future_booking', true)`;
  accountClient = await signInAs(accountUser);

  // Fresh tenants default both to false (confirmed via tests/customer-
  // cancellation.test.ts's own assertion of that default) — enabled here
  // so the two customer-facing RPC tests below can actually exercise
  // cancel_my_appointment/reschedule_my_appointment.
  await testDb`update tenants set customer_cancellation_enabled = true, customer_reschedule_enabled = true where id = ${tenant.id}`;
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenant.id]);
  await cleanupUsers(cleanupUserIds);
}, 60000);

describe("event-time display snapshot capture (Faz NOTIF.2F.1)", () => {
  it("1. appointment.created captures an immutable display snapshot", async () => {
    const start = nextSlot();
    const { data: appointmentId, error } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customerId,
      p_items: [item(service1.id, staff1.id, start, 1)],
    });
    expect(error).toBeNull();

    const eventId = await latestEvent(appointmentId as string, "appointment.created");
    const snapshot = await snapshotFor(eventId);
    expect(snapshot).toBeDefined();
    expect(snapshot!.customer_name).toBe("Ayşe Yılmaz");
    expect(snapshot!.service_names).toEqual(["Saç Kesimi"]);
    expect(new Date(snapshot!.appointment_start_at!).getTime()).toBe(start.getTime());
    expect(snapshot!.tenant_timezone).toBe(tenantTimezone);
  });

  it("2. appointment.cancelled captures a display snapshot (staff-facing update_appointment_status)", async () => {
    const start = nextSlot();
    const { data: appointmentId } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customerId,
      p_items: [item(service1.id, staff1.id, start, 1)],
    });
    const { error } = await ownerClient.rpc("update_appointment_status", {
      p_appointment_id: appointmentId,
      p_new_status: "cancelled",
    });
    expect(error).toBeNull();

    const eventId = await latestEvent(appointmentId as string, "appointment.cancelled");
    const snapshot = await snapshotFor(eventId);
    expect(snapshot).toBeDefined();
    expect(snapshot!.customer_name).toBe("Ayşe Yılmaz");
    expect(snapshot!.service_names).toEqual(["Saç Kesimi"]);
    expect(new Date(snapshot!.appointment_start_at!).getTime()).toBe(start.getTime());
  });

  it("3. appointment.rescheduled captures the NEW appointment_start_at, not the old one", async () => {
    const originalStart = nextSlot();
    const newStart = nextSlot();
    const { data: appointmentId } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customerId,
      p_items: [item(service1.id, staff1.id, originalStart, 1)],
    });
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [item(service1.id, staff1.id, newStart, 1)],
    });
    expect(error).toBeNull();

    const eventId = await latestEvent(appointmentId as string, "appointment.rescheduled");
    const snapshot = await snapshotFor(eventId);
    expect(snapshot).toBeDefined();
    const capturedStart = new Date(snapshot!.appointment_start_at!).getTime();
    expect(capturedStart).toBe(newStart.getTime());
    expect(capturedStart).not.toBe(originalStart.getTime());
  });

  it("4. appointment.staff_reassigned captures the current customer/service/start after reassignment", async () => {
    const start = nextSlot();
    const { data: appointmentId } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customerId,
      p_items: [item(service1.id, staff1.id, start, 1)],
    });
    // Same time, different staff -> pure reassignment, no rescheduled event.
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [item(service1.id, staff2.id, start, 1)],
    });
    expect(error).toBeNull();

    const eventId = await latestEvent(appointmentId as string, "appointment.staff_reassigned");
    const snapshot = await snapshotFor(eventId);
    expect(snapshot).toBeDefined();
    expect(snapshot!.customer_name).toBe("Ayşe Yılmaz");
    expect(snapshot!.service_names).toEqual(["Saç Kesimi"]);
    expect(new Date(snapshot!.appointment_start_at!).getTime()).toBe(start.getTime());
  });

  it("5. service_names preserve stable appointment-item sequence order, not creation/id order", async () => {
    const start = nextSlot();
    const laterStart = new Date(start.getTime() + 30 * 60_000);
    // service2 ("Sakal") deliberately given sequence 1, service1 ("Saç
    // Kesimi") sequence 2 — the reverse of this file's usual ordering —
    // to prove the capture follows `sequence`, not array/creation order.
    const { data: appointmentId, error } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customerId,
      p_items: [item(service2.id, staff1.id, start, 1), item(service1.id, staff1.id, laterStart, 2)],
    });
    expect(error).toBeNull();

    const eventId = await latestEvent(appointmentId as string, "appointment.created");
    const snapshot = await snapshotFor(eventId);
    expect(snapshot!.service_names).toEqual(["Sakal", "Saç Kesimi"]);
  });

  it("6. customer name is captured exactly as it existed at event time", async () => {
    const distinctCustomer = await createCustomer(tenant.id, "Zeynep Kaya");
    const start = nextSlot();
    const { data: appointmentId } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: distinctCustomer.id,
      p_items: [item(service1.id, staff1.id, start, 1)],
    });
    const eventId = await latestEvent(appointmentId as string, "appointment.created");
    const snapshot = await snapshotFor(eventId);
    expect(snapshot!.customer_name).toBe("Zeynep Kaya");
  });

  it("7. a later customer rename does NOT change an already-queued event's display snapshot", async () => {
    const renamedCustomer = await createCustomer(tenant.id, "Original Name");
    const start = nextSlot();
    const { data: appointmentId } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: renamedCustomer.id,
      p_items: [item(service1.id, staff1.id, start, 1)],
    });
    const eventId = await latestEvent(appointmentId as string, "appointment.created");
    expect((await snapshotFor(eventId))!.customer_name).toBe("Original Name");

    await testDb`update customers set full_name = 'Renamed Later' where id = ${renamedCustomer.id}`;

    const snapshotAfterRename = await snapshotFor(eventId);
    expect(snapshotAfterRename!.customer_name).toBe("Original Name");
  });

  it("8. a later service rename does NOT change an already-queued event's display snapshot", async () => {
    const renamableService = await createService(tenant.id, "Original Service Name", 20, 150);
    await testDb`insert into service_branches (service_id, branch_id) values (${renamableService.id}, ${branchId})`;
    await linkStaffService(staff1.id, renamableService.id);

    const start = nextSlot();
    const { data: appointmentId } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customerId,
      p_items: [item(renamableService.id, staff1.id, start, 1)],
    });
    const eventId = await latestEvent(appointmentId as string, "appointment.created");
    expect((await snapshotFor(eventId))!.service_names).toEqual(["Original Service Name"]);

    await testDb`update services set name = 'Renamed Service Later' where id = ${renamableService.id}`;

    const snapshotAfterRename = await snapshotFor(eventId);
    expect(snapshotAfterRename!.service_names).toEqual(["Original Service Name"]);
  });

  it("9. a later tenant timezone change does NOT alter an already-queued event's display timezone", async () => {
    const [before] = await testDb<{ timezone: string }[]>`select timezone from tenants where id = ${tenant.id}`;
    const start = nextSlot();
    const { data: appointmentId } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customerId,
      p_items: [item(service1.id, staff1.id, start, 1)],
    });
    const eventId = await latestEvent(appointmentId as string, "appointment.created");
    expect((await snapshotFor(eventId))!.tenant_timezone).toBe(before!.timezone);

    await testDb`update tenants set timezone = 'Pacific/Auckland' where id = ${tenant.id}`;
    try {
      const snapshotAfterChange = await snapshotFor(eventId);
      expect(snapshotAfterChange!.tenant_timezone).toBe(before!.timezone);
      expect(snapshotAfterChange!.tenant_timezone).not.toBe("Pacific/Auckland");
    } finally {
      await testDb`update tenants set timezone = ${before!.timezone} where id = ${tenant.id}`;
    }
  });

  it("10. an event with no NOTIF.2F.1 display snapshot (simulated legacy row) has no snapshot row at all", async () => {
    const start = nextSlot();
    const { data: appointmentId } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customerId,
      p_items: [item(service1.id, staff1.id, start, 1)],
    });
    // Deliberately bypasses every RPC — simulates a pre-2F.1 row, the
    // only place in this file that does so (see this file's own header).
    const [legacyEvent] = await testDb<{ id: string }[]>`
      insert into notification_events (tenant_id, appointment_id, event_type, actor_user_id, event_data)
      values (${tenant.id}, ${appointmentId as string}, 'appointment.created', ${owner.id}, ${testDb.json({})})
      returning id
    `;
    const snapshot = await snapshotFor(legacyEvent!.id);
    expect(snapshot).toBeUndefined();
  });

  it("customer-facing cancel_my_appointment also captures a correct display snapshot", async () => {
    const start = nextSlot();
    const { data: appointmentId } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: accountCustomerId,
      p_items: [item(service1.id, staff1.id, start, 1)],
    });
    const { error } = await accountClient.rpc("cancel_my_appointment", { p_appointment_id: appointmentId });
    expect(error).toBeNull();

    const eventId = await latestEvent(appointmentId as string, "appointment.cancelled");
    const snapshot = await snapshotFor(eventId);
    expect(snapshot!.customer_name).toBe("Mehmet Demir");
    expect(snapshot!.service_names).toEqual(["Saç Kesimi"]);
  });

  it("customer-facing reschedule_my_appointment also captures the NEW appointment_start_at", async () => {
    const originalStart = nextSlot();
    const { data: appointmentId } = await ownerClient.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: accountCustomerId,
      p_items: [item(service1.id, staff1.id, originalStart, 1)],
    });
    const newStart = new Date(originalStart.getTime() + 60 * 60_000);
    const { error } = await accountClient.rpc("reschedule_my_appointment", {
      p_appointment_id: appointmentId,
      p_new_start_at: newStart.toISOString(),
    });
    expect(error).toBeNull();

    const eventId = await latestEvent(appointmentId as string, "appointment.rescheduled");
    const snapshot = await snapshotFor(eventId);
    expect(snapshot!.customer_name).toBe("Mehmet Demir");
    expect(new Date(snapshot!.appointment_start_at!).getTime()).toBe(newStart.getTime());
  });
});

describe("schema and security (Faz NOTIF.2F.1)", () => {
  it("16. the table's own columns contain no phone/email/notes/endpoint/p256dh/auth key/customer id/appointment id", async () => {
    const columns = await testDb<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'notification_event_display_snapshots'
      order by column_name
    `;
    const names = columns.map((c) => c.column_name).sort();
    expect(names).toEqual(
      ["appointment_start_at", "created_at", "customer_name", "event_id", "service_names", "tenant_id", "tenant_timezone"].sort(),
    );
    for (const forbidden of ["phone", "email", "notes", "endpoint", "p256dh", "auth_key", "customer_id", "appointment_id"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("17. RLS is enabled; anon/authenticated have zero grants; service_role is limited to the schema-maintenance baseline every table gets", async () => {
    const [rls] = await testDb<{ rls_enabled: boolean; policy_count: number }[]>`
      select rls_enabled, policy_count from security_audit_rls_status() where table_name = 'notification_event_display_snapshots'
    `;
    expect(rls).toBeDefined();
    expect(rls!.rls_enabled).toBe(true);

    const grants = await testDb<{ grantee: string; privilege_type: string }[]>`
      select grantee, privilege_type from security_audit_table_grants() where table_name = 'notification_event_display_snapshots'
    `;
    // Browser-reachable roles: zero grants, full stop — the actual
    // security boundary this table depends on.
    const browserGrants = grants.filter((g) => g.grantee === "anon" || g.grantee === "authenticated");
    expect(browserGrants).toEqual([]);

    // service_role: same MAINTAIN/REFERENCES/TRIGGER/TRUNCATE schema-
    // maintenance baseline every table in this project carries (see
    // tests/security-grants-regression.test.ts's own EXPECTED_DEFAULT_
    // PRIVILEGES and "service_role has zero table grants beyond the
    // schema-maintenance baseline") — never SELECT/INSERT/UPDATE/DELETE.
    const serviceRoleDataGrants = grants.filter(
      (g) => g.grantee === "service_role" && !["MAINTAIN", "REFERENCES", "TRIGGER", "TRUNCATE"].includes(g.privilege_type),
    );
    expect(serviceRoleDataGrants).toEqual([]);
  });
});
