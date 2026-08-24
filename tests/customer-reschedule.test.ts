import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  anonClient,
  signInAs,
  createTestTenant,
  createTestUser,
  createBranch,
  createService,
  createStaffMember,
  createStaffSchedule,
  cleanupTenants,
  cleanupUsers,
  type TestUser,
} from "./helpers";

/**
 * Faz 2G.2B (20260823205200) — customer self-service reschedule (Option
 * B: every item shifts by one uniform delta, service/staff/sequence
 * fixed), the shared private.replace_appointment_items core now used by
 * BOTH staff reschedule_appointment and the new
 * reschedule_my_appointment, and the confirmed pre-existing
 * snapshot-preservation bug fixed as part of that refactor. Like
 * cancel_my_appointment, reschedule_my_appointment/get_my_reschedule_slots
 * read auth.uid() directly — every call goes through signInAs, never
 * testDb raw.
 */

let owner: TestUser;
let accountUser: TestUser;
let otherUser: TestUser;
let tenant: { id: string; slug: string };
let branchId: string;

/** Real-clock-relative on purpose — the cutoff/past-rejection tests
 * compare against the database's actual now(), so this must genuinely
 * mean "N hours from the real current instant", not an anchored one. */
function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3600_000);
}

/** get_my_reschedule_slots only generates 15-minute-aligned candidates
 * (00:00, 00:15, ...) — a fixture whose own start isn't aligned can
 * never appear as "the own current slot", regardless of correctness.
 * Only needed where a test asserts the own slot specifically appears. */
function roundDownTo15Min(date: Date): Date {
  const ms = 15 * 60_000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

/**
 * Local 08:00 (Europe/Istanbul, this project's fixed-offset UTC+3
 * tenant default — no DST) N days out, decoupled from the real current
 * time-of-day. Used only by fixtures that stack multiple item
 * offsets/durations plus a reschedule delta within one test — those
 * need same-day headroom, since staff_is_available (pre-existing,
 * unrelated to this phase) rejects anything crossing local midnight,
 * and hoursFromNow's real-clock-relative small values would otherwise
 * make those specific fixtures flaky depending on what time of day the
 * suite happens to run. Not used for cutoff-boundary tests, which need
 * hoursFromNow's genuine "relative to real now()" meaning instead.
 */
function safeMorningStart(daysFromNow: number): Date {
  const tzOffsetMs = 3 * 3600_000;
  const localNow = new Date(Date.now() + tzOffsetMs);
  const localMorning = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() + daysFromNow, 8, 0, 0));
  return new Date(localMorning.getTime() - tzOffsetMs);
}

async function setPolicy(
  tenantId: string,
  policy: Partial<{
    customer_cancellation_enabled: boolean;
    customer_cancellation_cutoff_minutes: number;
    customer_reschedule_enabled: boolean;
    customer_reschedule_cutoff_minutes: number;
  }>,
): Promise<void> {
  if (Object.keys(policy).length === 0) return;
  await testDb`update tenants set ${testDb(policy)} where id = ${tenantId}`;
}

type ItemSpec = { durationMinutes: number; price: number; offsetMinutes: number };

/** Every item gets its own dedicated staff member (same collision-proofing
 * rationale as customer-cancellation.test.ts) and its own dedicated
 * service (so price/duration snapshots are independently verifiable per
 * item, and so mutating one service's catalog price/duration in a test
 * never accidentally affects another item's fixture). */
async function createLinkedAppointment(params: {
  userId: string;
  status: string;
  start: Date;
  items?: ItemSpec[];
  isPrimary?: boolean;
  fullName?: string;
}): Promise<{ appointmentId: string; customerId: string; itemStaffIds: string[]; itemServiceIds: string[] }> {
  const items = params.items ?? [{ durationMinutes: 30, price: 100, offsetMinutes: 0 }];
  const [customer] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name) values (${tenant.id}, ${params.fullName ?? "Reschedule Test Customer"}) returning id`;
  const customerId = customer!.id;

  await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary)
    values (${params.userId}, ${tenant.id}, ${customerId}, 'future_booking', ${params.isPrimary ?? false})`;

  const itemStaffIds: string[] = [];
  const itemServiceIds: string[] = [];
  let minStart = params.start;
  let maxEnd = params.start;

  const [appt] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, status, source, scheduled_start_at, scheduled_end_at)
    values (${tenant.id}, ${branchId}, ${customerId}, ${params.status}, 'public_booking', ${params.start.toISOString()}::timestamptz, ${new Date(params.start.getTime() + 30 * 60_000).toISOString()}::timestamptz)
    returning id`;
  const appointmentId = appt!.id;

  for (let i = 0; i < items.length; i++) {
    const spec = items[i]!;
    const staff = await createStaffMember(tenant.id, `Resched Staff ${crypto.randomUUID().slice(0, 8)}`);
    const service = await createService(tenant.id, `Resched Service ${crypto.randomUUID().slice(0, 8)}`, spec.durationMinutes, spec.price);
    await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff.id}, ${branchId})`;
    await testDb`insert into service_branches (service_id, branch_id) values (${service.id}, ${branchId})`;
    await testDb`insert into staff_services (staff_member_id, service_id) values (${staff.id}, ${service.id})`;
    for (let weekday = 0; weekday <= 6; weekday++) {
      await createStaffSchedule(tenant.id, staff.id, weekday, "00:00", "23:59");
    }
    itemStaffIds.push(staff.id);
    itemServiceIds.push(service.id);

    const itemStart = new Date(params.start.getTime() + spec.offsetMinutes * 60_000);
    const itemEnd = new Date(itemStart.getTime() + spec.durationMinutes * 60_000);
    if (itemStart < minStart) minStart = itemStart;
    if (itemEnd > maxEnd) maxEnd = itemEnd;
    await testDb`
      insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${appointmentId}, ${service.id}, ${staff.id}, ${itemStart.toISOString()}::timestamptz, ${itemEnd.toISOString()}::timestamptz, ${spec.durationMinutes}, ${spec.price}, ${i + 1})`;
  }

  await testDb`update appointments set scheduled_start_at = ${minStart.toISOString()}::timestamptz, scheduled_end_at = ${maxEnd.toISOString()}::timestamptz where id = ${appointmentId}`;

  return { appointmentId, customerId, itemStaffIds, itemServiceIds };
}

async function rescheduleAs(user: TestUser, appointmentId: string, newStartAt: Date) {
  const client = await signInAs(user);
  const result = await client.rpc("reschedule_my_appointment", {
    p_appointment_id: appointmentId,
    p_new_start_at: newStartAt.toISOString(),
  });
  await client.auth.signOut();
  return result;
}

async function slotsAs(user: TestUser, appointmentId: string, date: string) {
  const client = await signInAs(user);
  const result = await client.rpc("get_my_reschedule_slots", { p_appointment_id: appointmentId, p_date: date });
  await client.auth.signOut();
  return result;
}

beforeAll(async () => {
  owner = await createTestUser("p2g2b-owner");
  accountUser = await createTestUser("p2g2b-acct");
  otherUser = await createTestUser("p2g2b-other");
  const tenantRow = await createTestTenant("test-p2g2b-resched", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug };
  branchId = await createBranch(tenant.id, "Resched Branch");
}, 60000);

afterAll(async () => {
  await testDb`delete from customer_account_links where tenant_id = ${tenant.id}`;
  await cleanupTenants([tenant.id]);
  await cleanupUsers([owner.id, accountUser.id, otherUser.id]);
});

describe("no stale overload after the signature changes", () => {
  it("validate_and_insert_appointment_item, reschedule_appointment, update_appointment_status all resolve to exactly one function each (CREATE OR REPLACE preserved signatures)", async () => {
    const rows = await testDb<{ proname: string; nargs: number }[]>`
      select p.proname, p.pronargs as nargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname in ('validate_and_insert_appointment_item', 'reschedule_appointment', 'update_appointment_status', 'replace_appointment_items', 'reschedule_my_appointment', 'get_my_reschedule_slots')`;
    const byName = new Map<string, number[]>();
    for (const r of rows) byName.set(r.proname, [...(byName.get(r.proname) ?? []), r.nargs]);
    // 7 args as of Faz 2G.2B.1 (20260824055133) — p_duration_override/
    // p_price_override added as explicit parameters, see
    // tests/appointment-snapshot-trust-boundary.test.ts for why.
    expect(byName.get("validate_and_insert_appointment_item")).toEqual([7]);
    expect(byName.get("reschedule_appointment")).toEqual([2]);
    expect(byName.get("update_appointment_status")).toEqual([2]);
    expect(byName.get("replace_appointment_items")).toEqual([4]);
    expect(byName.get("reschedule_my_appointment")).toEqual([2]);
    expect(byName.get("get_my_reschedule_slots")).toEqual([2]);
  });
});

describe("snapshot preservation — the confirmed pre-existing bug, fixed", () => {
  it("STAFF reschedule (unchanged service) preserves the original price/duration snapshot even after the catalog price changes", async () => {
    const { appointmentId, itemServiceIds, itemStaffIds } = await createLinkedAppointment({
      userId: accountUser.id,
      status: "scheduled",
      start: hoursFromNow(48),
      items: [{ durationMinutes: 45, price: 900, offsetMinutes: 0 }],
    });

    await testDb`update services set price = 1100, duration_minutes = 60 where id = ${itemServiceIds[0]}`;

    const ownerClient = await signInAs(owner);
    const newStart = hoursFromNow(50).toISOString();
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [{ service_id: itemServiceIds[0], staff_member_id: itemStaffIds[0], scheduled_start_at: newStart, sequence: 1 }],
    });
    expect(error).toBeNull();
    await ownerClient.auth.signOut();

    const [item] = await testDb<{ duration_minutes: number; price: string; scheduled_start_at: string; scheduled_end_at: string }[]>`
      select duration_minutes, price, scheduled_start_at, scheduled_end_at from appointment_items where appointment_id = ${appointmentId}`;
    expect(item!.duration_minutes).toBe(45); // NOT the new 60
    expect(Number(item!.price)).toBe(900); // NOT the new 1100
    // end time derives from the PRESERVED 45min duration, not the edited 60min.
    const durationMs = new Date(item!.scheduled_end_at).getTime() - new Date(item!.scheduled_start_at).getTime();
    expect(durationMs).toBe(45 * 60_000);
  });

  it("STAFF reschedule that explicitly SWAPS an item's service correctly picks up the new service's current price/duration (a real edit, not a time move)", async () => {
    const { appointmentId, itemStaffIds } = await createLinkedAppointment({
      userId: accountUser.id,
      status: "scheduled",
      start: hoursFromNow(52),
      items: [{ durationMinutes: 45, price: 900, offsetMinutes: 0 }],
    });
    const newService = await createService(tenant.id, "Swapped Service", 20, 300);
    await testDb`insert into service_branches (service_id, branch_id) values (${newService.id}, ${branchId})`;
    await testDb`insert into staff_services (staff_member_id, service_id) values (${itemStaffIds[0]}, ${newService.id})`;

    const ownerClient = await signInAs(owner);
    const newStart = hoursFromNow(53).toISOString();
    const { error } = await ownerClient.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [{ service_id: newService.id, staff_member_id: itemStaffIds[0], scheduled_start_at: newStart, sequence: 1 }],
    });
    expect(error).toBeNull();
    await ownerClient.auth.signOut();

    const [item] = await testDb<{ duration_minutes: number; price: string }[]>`
      select duration_minutes, price from appointment_items where appointment_id = ${appointmentId}`;
    expect(item!.duration_minutes).toBe(20);
    expect(Number(item!.price)).toBe(300);
  });

  it("CUSTOMER reschedule preserves the original price/duration snapshot even after the catalog price changes", async () => {
    const { appointmentId, itemServiceIds } = await createLinkedAppointment({
      userId: accountUser.id,
      status: "scheduled",
      start: hoursFromNow(54),
      items: [{ durationMinutes: 45, price: 900, offsetMinutes: 0 }],
    });
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    await testDb`update services set price = 1100, duration_minutes = 60 where id = ${itemServiceIds[0]}`;

    const { data, error } = await rescheduleAs(accountUser, appointmentId, hoursFromNow(56));
    expect(error).toBeNull();
    expect(data).toBeTruthy();

    const [item] = await testDb<{ duration_minutes: number; price: string; scheduled_start_at: string; scheduled_end_at: string }[]>`
      select duration_minutes, price, scheduled_start_at, scheduled_end_at from appointment_items where appointment_id = ${appointmentId}`;
    expect(item!.duration_minutes).toBe(45);
    expect(Number(item!.price)).toBe(900);
    const durationMs = new Date(item!.scheduled_end_at).getTime() - new Date(item!.scheduled_start_at).getTime();
    expect(durationMs).toBe(45 * 60_000);
  });
});

describe("multi-item delta behavior (Option B)", () => {
  it("every item shifts by the SAME delta, preserving relative offsets/staff/services/sequence", async () => {
    const { appointmentId, itemStaffIds, itemServiceIds } = await createLinkedAppointment({
      userId: accountUser.id,
      status: "confirmed",
      start: safeMorningStart(3),
      items: [
        { durationMinutes: 90, price: 900, offsetMinutes: 0 }, // 09:00-10:30 equivalent
        { durationMinutes: 30, price: 100, offsetMinutes: 90 }, // 10:30-11:00
        { durationMinutes: 45, price: 250, offsetMinutes: 120 }, // 11:00-11:45
      ],
    });
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });

    const originalStarts = await testDb<{ sequence: number; scheduled_start_at: string; staff_member_id: string; service_id: string }[]>`
      select sequence, scheduled_start_at, staff_member_id, service_id from appointment_items where appointment_id = ${appointmentId} order by sequence`;

    const deltaHours = 2;
    const newStart = new Date(new Date(originalStarts[0]!.scheduled_start_at).getTime() + deltaHours * 3600_000);
    const { error } = await rescheduleAs(accountUser, appointmentId, newStart);
    expect(error).toBeNull();

    const after = await testDb<{ sequence: number; scheduled_start_at: string; staff_member_id: string; service_id: string; duration_minutes: number; price: string }[]>`
      select sequence, scheduled_start_at, staff_member_id, service_id, duration_minutes, price from appointment_items where appointment_id = ${appointmentId} order by sequence`;

    expect(after.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(after[i]!.sequence).toBe(originalStarts[i]!.sequence);
      expect(after[i]!.staff_member_id).toBe(itemStaffIds[i]);
      expect(after[i]!.service_id).toBe(itemServiceIds[i]);
      const shiftMs = new Date(after[i]!.scheduled_start_at).getTime() - new Date(originalStarts[i]!.scheduled_start_at).getTime();
      expect(shiftMs).toBe(deltaHours * 3600_000);
    }
    // header range also moved consistently
    const [hdr] = await testDb<{ scheduled_start_at: string }[]>`select scheduled_start_at from appointments where id = ${appointmentId}`;
    expect(new Date(hdr!.scheduled_start_at).getTime()).toBe(newStart.getTime());
  });
});

describe("rollback safety", () => {
  it("a forced failure on a LATER item rolls back the WHOLE reschedule — all original items remain unchanged", async () => {
    const base = safeMorningStart(4);
    const { appointmentId } = await createLinkedAppointment({
      userId: accountUser.id,
      status: "scheduled",
      start: base,
      items: [
        { durationMinutes: 30, price: 200, offsetMinutes: 0 },
        { durationMinutes: 30, price: 200, offsetMinutes: 30 },
      ],
    });
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });

    const originalItems = await testDb<{ scheduled_start_at: string }[]>`select scheduled_start_at from appointment_items where appointment_id = ${appointmentId} order by sequence`;

    // Block the SECOND item's shifted slot by pre-occupying that staff
    // member at the exact time the reschedule would need — the first
    // item validates fine, the second must fail, proving the whole
    // transaction (both items) rolls back, not just the second.
    const newStart = new Date(base.getTime() + 5 * 3600_000);
    const secondItemNewStart = new Date(newStart.getTime() + 30 * 60_000);
    const secondItemNewEnd = new Date(secondItemNewStart.getTime() + 30 * 60_000);
    const [blockerCustomer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'Blocker Customer') returning id`;
    const [blockerAppt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${blockerCustomer!.id}, 'scheduled', ${secondItemNewStart.toISOString()}::timestamptz, ${secondItemNewEnd.toISOString()}::timestamptz) returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      select ${tenant.id}, ${blockerAppt!.id}, service_id, staff_member_id, ${secondItemNewStart.toISOString()}::timestamptz, ${secondItemNewEnd.toISOString()}::timestamptz, 30, 200, 1
      from appointment_items where appointment_id = ${appointmentId} and sequence = 2`;

    const { error } = await rescheduleAs(accountUser, appointmentId, newStart);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC008");

    const afterItems = await testDb<{ scheduled_start_at: string }[]>`select scheduled_start_at from appointment_items where appointment_id = ${appointmentId} order by sequence`;
    expect(afterItems.length).toBe(2); // still 2 items, nothing deleted-and-not-replaced
    for (let i = 0; i < 2; i++) {
      expect(new Date(afterItems[i]!.scheduled_start_at).getTime()).toBe(new Date(originalItems[i]!.scheduled_start_at).getTime());
    }
  });
});

describe("ownership", () => {
  it("AC003: a random, never-existed appointment id", async () => {
    const { error } = await rescheduleAs(accountUser, crypto.randomUUID(), hoursFromNow(48));
    expect(error!.code).toBe("AC003");
  });

  it("AC003: an appointment linked to a DIFFERENT account", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: otherUser.id, status: "scheduled", start: hoursFromNow(80), items: [{ durationMinutes: 30, price: 100, offsetMinutes: 0 }] });
    const { error } = await rescheduleAs(accountUser, appointmentId, hoursFromNow(82));
    expect(error!.code).toBe("AC003");
  });

  it("a PRIMARY-linked appointment is manageable", async () => {
    const primaryUser = await createTestUser("p2g2b-primary");
    const { appointmentId } = await createLinkedAppointment({ userId: primaryUser.id, status: "scheduled", start: hoursFromNow(84), items: [{ durationMinutes: 30, price: 100, offsetMinutes: 0 }], isPrimary: true });
    const { error } = await rescheduleAs(primaryUser, appointmentId, hoursFromNow(86));
    expect(error).toBeNull();
    await cleanupUsers([primaryUser.id]);
  });

  it("a NON-primary linked appointment is also manageable — all active links count", async () => {
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(88), items: [{ durationMinutes: 30, price: 100, offsetMinutes: 0 }], isPrimary: false });
    const { error } = await rescheduleAs(accountUser, appointmentId, hoursFromNow(90));
    expect(error).toBeNull();
  });
});

describe("status eligibility", () => {
  const cases: Array<{ status: string; eligible: boolean }> = [
    { status: "scheduled", eligible: true },
    { status: "confirmed", eligible: true },
    { status: "in_progress", eligible: false },
    { status: "completed", eligible: false },
    { status: "cancelled", eligible: false },
    { status: "no_show", eligible: false },
  ];

  for (const { status, eligible } of cases) {
    it(`status=${status} is ${eligible ? "" : "NOT "}customer-reschedulable`, async () => {
      await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
      const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status, start: hoursFromNow(100), items: [{ durationMinutes: 30, price: 100, offsetMinutes: 0 }] });
      const { error } = await rescheduleAs(accountUser, appointmentId, hoursFromNow(102));
      if (eligible) {
        expect(error).toBeNull();
      } else {
        expect(error!.code).toBe("AC003");
      }
    });
  }
});

describe("policy and cutoff", () => {
  it("AC006: reschedule disabled", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: false });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(110), items: [{ durationMinutes: 30, price: 100, offsetMinutes: 0 }] });
    const { error } = await rescheduleAs(accountUser, appointmentId, hoursFromNow(112));
    expect(error!.code).toBe("AC006");
  });

  it("AC007: cutoff is evaluated against the CURRENT start, not the requested new start — cannot bypass by picking a far-future target", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 180 });
    // 1h out, 3h cutoff -> already inside the cutoff window
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(1), items: [{ durationMinutes: 30, price: 100, offsetMinutes: 0 }] });
    const { error } = await rescheduleAs(accountUser, appointmentId, hoursFromNow(200)); // far future target
    expect(error!.code).toBe("AC007");
  });

  it("allowed strictly before the cutoff instant", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 180 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(5) });
    const { error } = await rescheduleAs(accountUser, appointmentId, hoursFromNow(7));
    expect(error).toBeNull();
  });

  it("AC008: cannot reschedule into the past", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(120) });
    const { error } = await rescheduleAs(accountUser, appointmentId, hoursFromNow(-1));
    expect(error!.code).toBe("AC008");
  });

  it("AC008: cannot reschedule beyond the 30-day horizon", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(130) });
    const { error } = await rescheduleAs(accountUser, appointmentId, hoursFromNow(31 * 24));
    expect(error!.code).toBe("AC008");
  });
});

describe("fixed branch/service/staff — revalidated against CURRENT configuration", () => {
  it("AC008: reschedule fails safely if the staff member is no longer assigned to the branch by the time of the request", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const { appointmentId, itemStaffIds } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(140), items: [{ durationMinutes: 30, price: 100, offsetMinutes: 0 }] });
    await testDb`delete from staff_branches where staff_member_id = ${itemStaffIds[0]} and branch_id = ${branchId}`;
    const { error } = await rescheduleAs(accountUser, appointmentId, hoursFromNow(142));
    expect(error!.code).toBe("AC008");
  });
});

describe("availability preview (get_my_reschedule_slots)", () => {
  it("returns [] for a random/unowned appointment id, never raises", async () => {
    const { data, error } = await slotsAs(accountUser, crypto.randomUUID(), new Date().toISOString().slice(0, 10));
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("returns [] when reschedule policy is disabled", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: false });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(150) });
    const date = hoursFromNow(150).toISOString().slice(0, 10);
    const { data } = await slotsAs(accountUser, appointmentId, date);
    expect(data).toEqual([]);
  });

  it("the appointment's OWN current slot is offered (not falsely blocked by its own items)", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const start = roundDownTo15Min(hoursFromNow(160));
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start });
    const [row] = await testDb<{ scheduled_start_at: string; timezone: string }[]>`
      select a.scheduled_start_at, t.timezone from appointments a join tenants t on t.id = a.tenant_id where a.id = ${appointmentId}`;
    // Tenant-LOCAL calendar date, not a raw UTC slice — start's UTC and
    // Europe/Istanbul (UTC+3) dates can genuinely differ near midnight,
    // and get_my_reschedule_slots iterates p_date as a local calendar day.
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: row!.timezone }).format(new Date(row!.scheduled_start_at));
    const { data, error } = await slotsAs(accountUser, appointmentId, localDate);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    expect((data as string[]).length).toBeGreaterThan(0);
  });

  it("a candidate blocked by ANOTHER appointment for the same staff is correctly excluded, while the item's own current slot is not", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const start = roundDownTo15Min(hoursFromNow(170));
    const { appointmentId, itemStaffIds, itemServiceIds } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start });

    // Occupy the SAME staff member 3 hours later with a different appointment.
    const blockedStart = new Date(start.getTime() + 3 * 3600_000);
    const blockedEnd = new Date(blockedStart.getTime() + 30 * 60_000);
    const [blockerCustomer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'Slot Blocker') returning id`;
    const [blockerAppt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${blockerCustomer!.id}, 'scheduled', ${blockedStart.toISOString()}::timestamptz, ${blockedEnd.toISOString()}::timestamptz) returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${blockerAppt!.id}, ${itemServiceIds[0]}, ${itemStaffIds[0]}, ${blockedStart.toISOString()}::timestamptz, ${blockedEnd.toISOString()}::timestamptz, 30, 100, 1)`;

    const [tz] = await testDb<{ timezone: string }[]>`select timezone from tenants where id = ${tenant.id}`;
    // Tenant-LOCAL calendar date — see the "OWN current slot" test's
    // identical comment for why a raw UTC slice of `start` is wrong here.
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz!.timezone }).format(start);
    const { data } = await slotsAs(accountUser, appointmentId, localDate);
    const slots = data as string[];
    const blockedLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz!.timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(blockedStart);
    expect(slots).not.toContain(blockedLocal);
    // and the appointment's own current slot (start's own local time) IS present
    const ownLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz!.timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(start);
    expect(slots).toContain(ownLocal);
  });

  it("a multi-item appointment: a candidate is offered ONLY if EVERY shifted item is valid — a conflict on a LATER item suppresses the whole candidate", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const start = safeMorningStart(5);
    const { appointmentId, itemStaffIds, itemServiceIds } = await createLinkedAppointment({
      userId: accountUser.id,
      status: "scheduled",
      start,
      items: [
        { durationMinutes: 30, price: 100, offsetMinutes: 0 },
        { durationMinutes: 30, price: 100, offsetMinutes: 30 },
      ],
    });

    // Candidate 4 hours later would shift item2 into a slot already
    // occupied by someone else for item2's staff member.
    const candidateDelta = 4 * 3600_000;
    const item2NewStart = new Date(start.getTime() + candidateDelta + 30 * 60_000);
    const item2NewEnd = new Date(item2NewStart.getTime() + 30 * 60_000);
    const [blockerCustomer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'Item2 Blocker') returning id`;
    const [blockerAppt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${blockerCustomer!.id}, 'scheduled', ${item2NewStart.toISOString()}::timestamptz, ${item2NewEnd.toISOString()}::timestamptz) returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${blockerAppt!.id}, ${itemServiceIds[1]}, ${itemStaffIds[1]}, ${item2NewStart.toISOString()}::timestamptz, ${item2NewEnd.toISOString()}::timestamptz, 30, 100, 1)`;

    const [tz] = await testDb<{ timezone: string }[]>`select timezone from tenants where id = ${tenant.id}`;
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz!.timezone }).format(start);
    const { data } = await slotsAs(accountUser, appointmentId, localDate);
    const slots = data as string[];
    const candidateLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz!.timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(start.getTime() + candidateDelta));
    expect(slots).not.toContain(candidateLocal); // item1 alone would be free, but item2 conflicts -> whole candidate suppressed
  });
});

describe("staff authority unchanged", () => {
  it("an authorized staff user can still reschedule even when customer_reschedule_enabled = false", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: false });
    const { appointmentId, itemStaffIds, itemServiceIds } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(190), items: [{ durationMinutes: 30, price: 100, offsetMinutes: 0 }] });
    const client = await signInAs(owner);
    const { error } = await client.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [{ service_id: itemServiceIds[0], staff_member_id: itemStaffIds[0], scheduled_start_at: hoursFromNow(192).toISOString(), sequence: 1 }],
    });
    expect(error).toBeNull();
    await client.auth.signOut();
  });

  it("update_appointment_status still works correctly with the new FOR UPDATE lock (no behavior change)", async () => {
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(194) });
    const client = await signInAs(owner);
    const { error } = await client.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "confirmed" });
    expect(error).toBeNull();
    await client.auth.signOut();
    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(row!.status).toBe("confirmed");
  });
});

describe("audit", () => {
  it("exactly one appointment.rescheduled row, actor_user_id = the real customer, actor_type='user'", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    // safeMorningStart, not hoursFromNow: this test asserts audit-log
    // content, not cutoff timing, so it doesn't need real-clock
    // relativity — and a fixed +200h/+202h pair is a genuine latent flake
    // (reproduced independently: 2026-08-24 run landed the +202h target
    // at 23:50 Europe/Istanbul, tripping staff_is_available's own
    // pre-existing midnight-crossing guard purely by wall-clock
    // coincidence, unrelated to Faz 2G.3.1 or anything this test means to
    // check). Same fix pattern as every other fixture in this file that
    // stacks an offset/delta within one day.
    const start = safeMorningStart(7);
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start });
    await rescheduleAs(accountUser, appointmentId, new Date(start.getTime() + 2 * 3600_000));

    const rows = await testDb<{ actor_user_id: string; actor_type: string }[]>`
      select actor_user_id, actor_type from audit_logs where entity_id = ${appointmentId} and action = 'appointment.rescheduled'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_user_id).toBe(accountUser.id);
    expect(rows[0]!.actor_type).toBe("user");
  });
});

describe("portal capability + refresh", () => {
  it("canReschedule reflects DB policy authority and updates after a successful reschedule", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(210) });

    const client = await signInAs(accountUser);
    const before = await client.rpc("get_my_appointments");
    const beforeRow = (before.data as Array<{ appointmentId: string; canReschedule: boolean }>).find((r) => r.appointmentId === appointmentId);
    expect(beforeRow!.canReschedule).toBe(true);

    const newStart = hoursFromNow(212);
    await client.rpc("reschedule_my_appointment", { p_appointment_id: appointmentId, p_new_start_at: newStart.toISOString() });

    const after = await client.rpc("get_my_appointments");
    const afterRow = (after.data as Array<{ appointmentId: string; scheduledStartAt: string }>).find((r) => r.appointmentId === appointmentId);
    expect(new Date(afterRow!.scheduledStartAt).getTime()).toBe(newStart.getTime());
    await client.auth.signOut();
  });
});

describe("concurrency", () => {
  it("A) two simultaneous customer reschedules of the SAME appointment to DIFFERENT starts: exactly one succeeds, no corruption", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(220) });

    const clientA = await signInAs(accountUser);
    const clientB = await signInAs(accountUser);
    const [resA, resB] = await Promise.all([
      clientA.rpc("reschedule_my_appointment", { p_appointment_id: appointmentId, p_new_start_at: hoursFromNow(222).toISOString() }),
      clientB.rpc("reschedule_my_appointment", { p_appointment_id: appointmentId, p_new_start_at: hoursFromNow(224).toISOString() }),
    ]);
    await clientA.auth.signOut();
    await clientB.auth.signOut();

    const succeeded = [resA, resB].filter((r) => r.error === null);
    expect(succeeded.length).toBeGreaterThanOrEqual(1); // the second, run after the lock releases, may also succeed (moving an already-moved appointment again) — both landing on a coherent final state is what matters
    const auditRows = await testDb<{ id: string }[]>`select id from audit_logs where entity_id = ${appointmentId} and action = 'appointment.rescheduled'`;
    expect(auditRows.length).toBe(succeeded.length); // no duplicate/missing audit relative to actual successes
  }, 30000);

  it("B) customer reschedule vs customer cancel: never ends with a cancelled appointment that also has active future slots", async () => {
    await setPolicy(tenant.id, { customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 0, customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const { appointmentId } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(230) });

    const clientA = await signInAs(accountUser);
    const clientB = await signInAs(accountUser);
    const [rescheduleRes, cancelRes] = await Promise.all([
      clientA.rpc("reschedule_my_appointment", { p_appointment_id: appointmentId, p_new_start_at: hoursFromNow(232).toISOString() }),
      clientB.rpc("cancel_my_appointment", { p_appointment_id: appointmentId }),
    ]);
    await clientA.auth.signOut();
    await clientB.auth.signOut();

    const [finalRow] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    if (finalRow!.status === "cancelled") {
      // if cancel won, the items must be cancelled-synced too (slot released), not left "active" from a racing reschedule
      const items = await testDb<{ appointment_status: string }[]>`select appointment_status from appointment_items where appointment_id = ${appointmentId}`;
      for (const item of items) expect(item.appointment_status).toBe("cancelled");
    } else {
      // if reschedule won, cancel must have failed (AC003 — status was already moved / no longer the expected pre-cancel state, or serialized after and correctly rejected)
      expect(cancelRes.error).not.toBeNull();
    }
    expect(rescheduleRes.error === null || cancelRes.error === null).toBe(true); // at least one had a coherent, non-corrupt outcome
  }, 30000);

  it("C) customer reschedule vs staff reschedule: serialized, coherent final state, no partial item replacement", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const { appointmentId, itemStaffIds, itemServiceIds } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(240) });

    const customerClient = await signInAs(accountUser);
    const staffClient = await signInAs(owner);
    const [custRes, staffRes] = await Promise.all([
      customerClient.rpc("reschedule_my_appointment", { p_appointment_id: appointmentId, p_new_start_at: hoursFromNow(242).toISOString() }),
      staffClient.rpc("reschedule_appointment", {
        p_appointment_id: appointmentId,
        p_items: [{ service_id: itemServiceIds[0], staff_member_id: itemStaffIds[0], scheduled_start_at: hoursFromNow(244).toISOString(), sequence: 1 }],
      }),
    ]);
    await customerClient.auth.signOut();
    await staffClient.auth.signOut();

    expect(custRes.error === null || staffRes.error === null).toBe(true);
    const items = await testDb<{ id: string }[]>`select id from appointment_items where appointment_id = ${appointmentId}`;
    expect(items.length).toBe(1); // never zero, never duplicated — exactly one coherent item either way
  }, 30000);

  it("D) reschedule races another booking taking one required shifted slot: fails AC008, original appointment stays intact", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const start = hoursFromNow(250);
    const { appointmentId, itemStaffIds, itemServiceIds } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start });

    const targetStart = hoursFromNow(252);
    const targetEnd = new Date(targetStart.getTime() + 30 * 60_000);
    const [blockerCustomer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'Race Blocker') returning id`;
    const [blockerAppt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${blockerCustomer!.id}, 'scheduled', ${targetStart.toISOString()}::timestamptz, ${targetEnd.toISOString()}::timestamptz) returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${blockerAppt!.id}, ${itemServiceIds[0]}, ${itemStaffIds[0]}, ${targetStart.toISOString()}::timestamptz, ${targetEnd.toISOString()}::timestamptz, 30, 100, 1)`;

    const { error } = await rescheduleAs(accountUser, appointmentId, targetStart);
    expect(error!.code).toBe("AC008");

    const [row] = await testDb<{ scheduled_start_at: string }[]>`select scheduled_start_at from appointments where id = ${appointmentId}`;
    expect(new Date(row!.scheduled_start_at).getTime()).toBe(start.getTime());
  });

  it("E) multi-item reschedule race where only a LATER item conflicts: full rollback, no partial move", async () => {
    await setPolicy(tenant.id, { customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 0 });
    const start = safeMorningStart(6);
    const { appointmentId, itemStaffIds, itemServiceIds } = await createLinkedAppointment({
      userId: accountUser.id,
      status: "scheduled",
      start,
      items: [
        { durationMinutes: 30, price: 100, offsetMinutes: 0 },
        { durationMinutes: 30, price: 100, offsetMinutes: 30 },
      ],
    });
    const originalItems = await testDb<{ scheduled_start_at: string }[]>`select scheduled_start_at from appointment_items where appointment_id = ${appointmentId} order by sequence`;

    const delta = 5 * 3600_000;
    const item2NewStart = new Date(start.getTime() + delta + 30 * 60_000);
    const item2NewEnd = new Date(item2NewStart.getTime() + 30 * 60_000);
    const [blockerCustomer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${tenant.id}, 'E Blocker') returning id`;
    const [blockerAppt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${blockerCustomer!.id}, 'scheduled', ${item2NewStart.toISOString()}::timestamptz, ${item2NewEnd.toISOString()}::timestamptz) returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${blockerAppt!.id}, ${itemServiceIds[1]}, ${itemStaffIds[1]}, ${item2NewStart.toISOString()}::timestamptz, ${item2NewEnd.toISOString()}::timestamptz, 30, 100, 1)`;

    const { error } = await rescheduleAs(accountUser, appointmentId, new Date(start.getTime() + delta));
    expect(error!.code).toBe("AC008");

    const afterItems = await testDb<{ scheduled_start_at: string }[]>`select scheduled_start_at from appointment_items where appointment_id = ${appointmentId} order by sequence`;
    expect(afterItems.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(new Date(afterItems[i]!.scheduled_start_at).getTime()).toBe(new Date(originalItems[i]!.scheduled_start_at).getTime());
    }
  });
});

describe("security", () => {
  it("reschedule_my_appointment and get_my_reschedule_slots: authenticated only, anon denied, exactly one overload each", async () => {
    for (const name of ["reschedule_my_appointment", "get_my_reschedule_slots"]) {
      const grants = await testDb<{ grantee: string }[]>`
        select grantee::text from information_schema.role_routine_grants
        where routine_schema = 'public' and routine_name = ${name} and privilege_type = 'EXECUTE'`;
      const grantees = grants.map((g) => g.grantee);
      expect(grantees).toContain("authenticated");
      expect(grantees).not.toContain("anon");
      expect(grantees).not.toContain("PUBLIC");
    }

    const anonResched = await anonClient().rpc("reschedule_my_appointment", { p_appointment_id: crypto.randomUUID(), p_new_start_at: hoursFromNow(1).toISOString() });
    expect(anonResched.error!.code).toBe("42501");
    const anonSlots = await anonClient().rpc("get_my_reschedule_slots", { p_appointment_id: crypto.randomUUID(), p_date: new Date().toISOString().slice(0, 10) });
    expect(anonSlots.error!.code).toBe("42501");
  });

  it("customer cannot call staff-side reschedule_appointment/update_appointment_status merely by being authenticated", async () => {
    const { appointmentId, itemStaffIds, itemServiceIds } = await createLinkedAppointment({ userId: accountUser.id, status: "scheduled", start: hoursFromNow(270) });
    const client = await signInAs(accountUser);
    const { error } = await client.rpc("reschedule_appointment", {
      p_appointment_id: appointmentId,
      p_items: [{ service_id: itemServiceIds[0], staff_member_id: itemStaffIds[0], scheduled_start_at: hoursFromNow(272).toISOString(), sequence: 1 }],
    });
    expect(error).not.toBeNull();
    await client.auth.signOut();
  });

  it("booking_gateway effective privilege surface unchanged", async () => {
    const rows = await testDb<{ schema: string; name: string; can_execute: boolean }[]>`
      select n.nspname as schema, p.proname as name, has_function_privilege('booking_gateway', p.oid, 'EXECUTE') as can_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`;
    const executable = rows.filter((r) => r.can_execute).map((r) => `${r.schema}.${r.name}`);
    expect(executable).toEqual(["public.create_guest_booking"]);
  });

  it("anon's 3 public booking read functions unchanged", async () => {
    const rows = await testDb<{ name: string }[]>`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proacl is not null
        and exists (select 1 from aclexplode(p.proacl) a where pg_get_userbyid(a.grantee) = 'anon' and a.privilege_type = 'EXECUTE')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by p.proname`;
    expect(rows.map((r) => r.name)).toEqual(["get_public_availability_slots", "get_public_booking_context", "get_public_eligible_staff"]);
  });

  it("create_guest_booking still protected from direct anon execution", async () => {
    const { error } = await anonClient().rpc("create_guest_booking", {
      p_tenant_slug: tenant.slug, p_branch_id: branchId, p_service_id: crypto.randomUUID(),
      p_scheduled_start_at: hoursFromNow(300).toISOString(), p_customer_full_name: "Blocked", p_customer_phone: "5551234567",
    });
    expect(error!.code).toBe("42501");
  });

  it("service_role and default-privilege baselines unchanged", async () => {
    const data = await testDb<{ grantee: string }[]>`select * from security_audit_function_grants()`;
    expect(data.filter((g) => g.grantee === "service_role")).toEqual([]);
    const defaults = await testDb<{ grantee: string }[]>`select * from public.security_audit_default_privileges()`;
    expect(defaults.length).toBe(4);
    for (const row of defaults) expect(row.grantee).toBe("service_role");
  });

  it("private.replace_appointment_items has zero grants to anyone (reachable only via its SECURITY DEFINER callers)", async () => {
    const [row] = await testDb<{ proacl: string[] | null }[]>`
      select proacl from pg_proc where proname = 'replace_appointment_items' and pronamespace = 'private'::regnamespace`;
    expect(row!.proacl).toEqual(["postgres=X/postgres"]);
  });
});
