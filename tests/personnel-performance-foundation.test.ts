import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  signInAs,
  createTestTenant,
  createTestUser,
  createBranch,
  createService,
  createStaffMember,
  createRoleForTenant,
  addMembership,
  cleanupTenants,
  cleanupUsers,
  hoursFromNow,
  type TestUser,
  type TestTenant,
} from "./helpers";

/**
 * Faz 5A.1 (20260905090000) + Faz 5A.1A (20260905100000) — Personnel
 * Performance data foundation, corrected. Covers:
 *   - appointment_items.actual_staff_member_id + the
 *     effective_performer_id fallback, now centralized in
 *     private.appointment_item_performance (moved out of public in
 *     5A.1A — see that migration's own comment for why a public,
 *     client-granted, security_invoker view could not remain the
 *     authorization mechanism)
 *   - private.complete_appointment / public.complete_appointment: the
 *     new, narrow, atomic completion path that records actual performers
 *   - reports.staff grants NO base-table SELECT access (5A.1's two
 *     additive policies were removed in 5A.1A for exactly that reason)
 *     — appointments.view remains the only way to read appointments/
 *     appointment_items directly, completely unchanged from before 5A.1
 *     ever existed
 *   - update_appointment_status regressing not at all (byte-for-byte
 *     untouched by either migration; remains a valid, but
 *     performer-blind, way to reach 'completed')
 *
 * No UI exists yet (Faz 5A.2) — every test here drives either the RPC
 * directly (via a real signed-in session, matching this project's
 * established RLS/permission-boundary testing convention) or reads
 * ground truth directly off testDb. testDb is a privileged direct
 * Postgres connection (see helpers.ts) that can see the private schema
 * for ground-truth/ setup purposes — a real client session never can,
 * which is the entire point being tested below.
 */

let owner: TestUser;
let tenant: TestTenant;
let branchId: string;
let serviceId: string;

/** A role holding exactly appointments.update — the minimal permission
 * complete_appointment actually requires, distinct from the owner's
 * full permission set, so "appointments.update is sufficient" and
 * "nothing less is" are both tested against a real, narrow grant rather
 * than only ever exercising the all-permissions owner. */
let updateOnlyUser: TestUser;

/** A role holding exactly reports.staff — no appointments.view, no
 * appointments.update. Faz 5A.1A's whole point: this role must NOT be
 * able to read appointments/appointment_items directly (that overreach
 * was removed), and must NOT be able to call complete_appointment
 * either (reports.staff was never a write permission). */
let reportsOnlyUser: TestUser;

/** A role holding exactly appointments.view — the permission that
 * actually governs direct table reads, unaffected by 5A.1A and unaware
 * reports.staff or personnel performance exist at all. Proves the
 * pre-existing read boundary is genuinely untouched, not just "still
 * present because reports.staff also happened to grant it". */
let viewOnlyUser: TestUser;

/** A second, fully independent tenant — cross-tenant isolation and
 * cross-tenant performer rejection both need a real staff member that
 * genuinely belongs to a DIFFERENT tenant. */
let otherTenant: TestTenant;
let otherOwner: TestUser;
let otherStaffId: string;
let otherBranchId: string;

async function eligibleStaff(fullName: string): Promise<string> {
  const staff = await createStaffMember(tenant.id, fullName);
  await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff.id}, ${branchId})`;
  await testDb`insert into staff_services (staff_member_id, service_id) values (${staff.id}, ${serviceId})`;
  return staff.id;
}

/** Inserts an appointment header + N items directly (bypassing
 * create_appointment — this file is testing completion, not creation).
 * Each item gets its own start offset so distinct staff members are
 * never required purely to dodge appointment_items_no_staff_overlap,
 * though callers are still free to pass distinct staffMemberIds. */
async function createAppointmentWithItems(params: {
  status?: string;
  items: { staffMemberId: string }[];
}): Promise<{ appointmentId: string; itemIds: string[] }> {
  const [customer] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name) values (${tenant.id}, 'Perf Foundation Customer') returning id`;
  const base = hoursFromNow(24);
  const totalEnd = new Date(base.getTime() + params.items.length * 30 * 60_000);
  const [appt] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
    values (${tenant.id}, ${branchId}, ${customer!.id}, ${params.status ?? "confirmed"}, ${base.toISOString()}::timestamptz, ${totalEnd.toISOString()}::timestamptz)
    returning id`;
  const appointmentId = appt!.id;
  const itemIds: string[] = [];
  for (let i = 0; i < params.items.length; i++) {
    const start = new Date(base.getTime() + i * 30 * 60_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    const [row] = await testDb<{ id: string }[]>`
      insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${appointmentId}, ${serviceId}, ${params.items[i]!.staffMemberId}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, 30, 200, ${i + 1})
      returning id`;
    itemIds.push(row!.id);
  }
  return { appointmentId, itemIds };
}

async function completeAs(user: TestUser, appointmentId: string, overrides: { appointmentItemId: string; actualStaffMemberId: string }[] = []) {
  const client = await signInAs(user);
  const result = await client.rpc("complete_appointment", {
    p_appointment_id: appointmentId,
    p_performer_overrides: overrides.map((o) => ({
      appointment_item_id: o.appointmentItemId,
      actual_staff_member_id: o.actualStaffMemberId,
    })),
  });
  await client.auth.signOut();
  return result;
}

beforeAll(async () => {
  owner = await createTestUser("p5a1-owner");
  updateOnlyUser = await createTestUser("p5a1-update-only");
  reportsOnlyUser = await createTestUser("p5a1-reports-only");
  viewOnlyUser = await createTestUser("p5a1a-view-only");
  otherOwner = await createTestUser("p5a1-other-owner");

  const tenantRow = await createTestTenant("test-p5a1-perf", owner.id);
  tenant = tenantRow;
  branchId = await createBranch(tenant.id, "Perf Branch");
  const service = await createService(tenant.id, "Perf Service", 30, 200);
  serviceId = service.id;
  await testDb`insert into service_branches (service_id, branch_id) values (${serviceId}, ${branchId})`;

  const updateOnlyRoleId = await createRoleForTenant(tenant.id, "Update Only", ["appointments.update"]);
  await addMembership(tenant.id, updateOnlyUser.id, updateOnlyRoleId);

  const reportsOnlyRoleId = await createRoleForTenant(tenant.id, "Reports Only", ["reports.staff"]);
  await addMembership(tenant.id, reportsOnlyUser.id, reportsOnlyRoleId);

  const viewOnlyRoleId = await createRoleForTenant(tenant.id, "View Only", ["appointments.view"]);
  await addMembership(tenant.id, viewOnlyUser.id, viewOnlyRoleId);

  otherTenant = await createTestTenant("test-p5a1-other", otherOwner.id);
  otherBranchId = await createBranch(otherTenant.id, "Other Tenant Branch");
  otherStaffId = await eligibleStaffFor(otherTenant.id, "Other Tenant Staff");
}, 60000);

/** Same shape as eligibleStaff but parameterized by tenant, for the
 * one fixture (otherStaffId) that must belong to a DIFFERENT tenant
 * than the module-level `tenant`. */
async function eligibleStaffFor(tenantId: string, fullName: string): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    insert into staff_members (tenant_id, full_name) values (${tenantId}, ${fullName}) returning id`;
  return row!.id;
}

afterAll(async () => {
  await cleanupTenants([tenant.id, otherTenant.id]);
  await cleanupUsers([owner.id, updateOnlyUser.id, reportsOnlyUser.id, viewOnlyUser.id, otherOwner.id]);
});

describe("legacy fallback & view shape", () => {
  it("1. a row with actual_staff_member_id left null (simulating a legacy/pre-existing completed item) reports effective_performer_id = staff_member_id via the private view", async () => {
    const staffId = await eligibleStaff("Legacy Fallback Staff");
    const { itemIds } = await createAppointmentWithItems({ status: "completed", items: [{ staffMemberId: staffId }] });

    const [row] = await testDb<{
      staff_member_id: string;
      actual_staff_member_id: string | null;
      effective_performer_id: string;
      service_name: string | null;
      service_category: string | null;
    }[]>`
      select staff_member_id, actual_staff_member_id, effective_performer_id, service_name, service_category
      from private.appointment_item_performance where appointment_item_id = ${itemIds[0]}`;

    expect(row!.actual_staff_member_id).toBeNull();
    expect(row!.effective_performer_id).toBe(staffId);
    expect(row!.staff_member_id).toBe(staffId);
    // Service mix stays service-based: name/category come through as
    // distinct, un-merged columns rather than a pre-computed bucket.
    expect(row!.service_name).toBe("Perf Service");
  });

  it("2. no customer PII (name/phone/email) is exposed by the view — asserted at the schema level, not just by what a query happens to select", async () => {
    const columns = await testDb<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'private' and table_name = 'appointment_item_performance'`;
    const names = columns.map((c) => c.column_name);
    expect(names).toContain("customer_id");
    expect(names).not.toContain("full_name");
    expect(names).not.toContain("phone");
    expect(names).not.toContain("email");
    expect(names).not.toContain("price"); // no financial data either — Phase 5B's concern, not 5A's
  });

  it("Faz 5A.1A: the view lives in private (not public), and public.appointment_item_performance no longer exists at all", async () => {
    const inPrivate = await testDb`select 1 from pg_views where schemaname = 'private' and viewname = 'appointment_item_performance'`;
    expect(inPrivate.length).toBe(1);
    const inPublic = await testDb`select 1 from pg_views where schemaname = 'public' and viewname = 'appointment_item_performance'`;
    expect(inPublic.length).toBe(0);
  });

  it("Faz 5A.1A: the private view has zero SELECT grant to authenticated, anon, or PUBLIC — not merely inaccessible via PostgREST, genuinely ungranted", async () => {
    const grants = await testDb<{ grantee: string }[]>`
      select grantee::text from information_schema.role_table_grants
      where table_schema = 'private' and table_name = 'appointment_item_performance' and privilege_type = 'SELECT'`;
    const grantees = grants.map((g) => g.grantee);
    expect(grantees).not.toContain("authenticated");
    expect(grantees).not.toContain("anon");
    expect(grantees).not.toContain("PUBLIC");
  });
});

describe("complete_appointment — permission & tenant-integrity validation", () => {
  it("7. a user with no relevant permission at all is rejected (AP002)", async () => {
    const staffId = await eligibleStaff("Unauthorized Test Staff");
    const { appointmentId } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });
    const { error } = await completeAs(reportsOnlyUser, appointmentId);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AP002");

    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(row!.status).toBe("confirmed"); // unchanged
  });

  it("8. a user with exactly appointments.update (nothing more) is accepted", async () => {
    const staffId = await eligibleStaff("Update Only Positive Staff");
    const { appointmentId } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });
    const { error } = await completeAs(updateOnlyUser, appointmentId);
    expect(error).toBeNull();

    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(row!.status).toBe("completed");
  });

  it("5. a performer belonging to a DIFFERENT tenant is rejected with the same AP008 used for 'does not exist' — never a distinguishable error", async () => {
    const staffId = await eligibleStaff("Cross Tenant Booked Staff");
    const { appointmentId, itemIds } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });
    const { error } = await completeAs(owner, appointmentId, [{ appointmentItemId: itemIds[0]!, actualStaffMemberId: otherStaffId }]);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AP008");

    const [item] = await testDb<{ actual_staff_member_id: string | null }[]>`select actual_staff_member_id from appointment_items where id = ${itemIds[0]}`;
    expect(item!.actual_staff_member_id).toBeNull();
  });

  it("6. a performer that does not exist at all gets the identical AP008 as the cross-tenant case", async () => {
    const staffId = await eligibleStaff("Nonexistent Performer Booked Staff");
    const { appointmentId, itemIds } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });
    const { error } = await completeAs(owner, appointmentId, [{ appointmentItemId: itemIds[0]!, actualStaffMemberId: crypto.randomUUID() }]);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AP008");
  });

  it("an override naming an appointment_item from a DIFFERENT appointment is rejected (AP016)", async () => {
    const staffA = await eligibleStaff("Cross Appointment A");
    const staffB = await eligibleStaff("Cross Appointment B");
    const a = await createAppointmentWithItems({ items: [{ staffMemberId: staffA }] });
    const b = await createAppointmentWithItems({ items: [{ staffMemberId: staffB }] });
    // Valid staff member, wrong appointment's item id.
    const { error } = await completeAs(owner, a.appointmentId, [{ appointmentItemId: b.itemIds[0]!, actualStaffMemberId: staffA }]);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AP016");

    const [statusA] = await testDb<{ status: string }[]>`select status from appointments where id = ${a.appointmentId}`;
    const [statusB] = await testDb<{ status: string }[]>`select status from appointments where id = ${b.appointmentId}`;
    expect(statusA!.status).toBe("confirmed");
    expect(statusB!.status).toBe("confirmed");
  });

  it("9. atomic rollback: one valid + one invalid override in the same call leaves BOTH appointment_items untouched and the appointment NOT completed", async () => {
    const staffValid = await eligibleStaff("Atomic Valid Staff");
    const staffBooked1 = await eligibleStaff("Atomic Booked One");
    const staffBooked2 = await eligibleStaff("Atomic Booked Two");
    const { appointmentId, itemIds } = await createAppointmentWithItems({
      items: [{ staffMemberId: staffBooked1 }, { staffMemberId: staffBooked2 }],
    });

    const { error } = await completeAs(owner, appointmentId, [
      { appointmentItemId: itemIds[0]!, actualStaffMemberId: staffValid }, // valid
      { appointmentItemId: itemIds[1]!, actualStaffMemberId: crypto.randomUUID() }, // invalid
    ]);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AP008");

    const items = await testDb<{ id: string; actual_staff_member_id: string | null }[]>`
      select id, actual_staff_member_id from appointment_items where appointment_id = ${appointmentId} order by sequence`;
    expect(items.map((i) => i.actual_staff_member_id)).toEqual([null, null]); // neither item written, including the valid one
    const [appt] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(appt!.status).toBe("confirmed"); // status transition also rolled back
  });

  it("10. an already-completed appointment cannot be completed again (AP014) — actual performer cannot be changed after the fact via this path", async () => {
    const staffId = await eligibleStaff("Already Completed Staff");
    const otherPerformer = await eligibleStaff("Attempted Post-Hoc Performer");
    const { appointmentId, itemIds } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });
    const first = await completeAs(owner, appointmentId);
    expect(first.error).toBeNull();

    const second = await completeAs(owner, appointmentId, [{ appointmentItemId: itemIds[0]!, actualStaffMemberId: otherPerformer }]);
    expect(second.error).not.toBeNull();
    expect(second.error!.code).toBe("AP014");

    const [item] = await testDb<{ actual_staff_member_id: string | null }[]>`select actual_staff_member_id from appointment_items where id = ${itemIds[0]}`;
    expect(item!.actual_staff_member_id).toBe(staffId); // unchanged from the first, successful call
  });

  it("a cancelled appointment cannot be completed either (same AP014 terminal-state guard)", async () => {
    const staffId = await eligibleStaff("Cancelled Guard Staff");
    const { appointmentId } = await createAppointmentWithItems({ status: "cancelled", items: [{ staffMemberId: staffId }] });
    const { error } = await completeAs(owner, appointmentId);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AP014");
  });
});

describe("complete_appointment — performer assignment logic", () => {
  it("2. completion with no override at all: every item's actual_staff_member_id becomes its own booked staff_member_id, never left null", async () => {
    const staffId = await eligibleStaff("No Override Staff");
    const { appointmentId, itemIds } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });
    const { error } = await completeAs(owner, appointmentId);
    expect(error).toBeNull();

    const [item] = await testDb<{ actual_staff_member_id: string | null }[]>`select actual_staff_member_id from appointment_items where id = ${itemIds[0]}`;
    expect(item!.actual_staff_member_id).toBe(staffId);
  });

  it("3. completion WITH an override: the override wins over the booked staff", async () => {
    const bookedStaff = await eligibleStaff("Override Booked Staff");
    const actualStaff = await eligibleStaff("Override Actual Staff");
    const { appointmentId, itemIds } = await createAppointmentWithItems({ items: [{ staffMemberId: bookedStaff }] });
    const { error } = await completeAs(owner, appointmentId, [{ appointmentItemId: itemIds[0]!, actualStaffMemberId: actualStaff }]);
    expect(error).toBeNull();

    const [item] = await testDb<{ staff_member_id: string; actual_staff_member_id: string | null }[]>`
      select staff_member_id, actual_staff_member_id from appointment_items where id = ${itemIds[0]}`;
    expect(item!.staff_member_id).toBe(bookedStaff); // booked staff itself is never rewritten
    expect(item!.actual_staff_member_id).toBe(actualStaff);
  });

  it("4. multi-service appointment: one item overridden, one left to its booked default, in the same call — exactly the Gökhan/Serdar scenario", async () => {
    const gokhanBooked = await eligibleStaff("Gokhan Scenario Booked");
    const serdarActual = await eligibleStaff("Serdar Scenario Actual");
    const secondBooked = await eligibleStaff("Second Item Booked");
    const { appointmentId, itemIds } = await createAppointmentWithItems({
      items: [{ staffMemberId: gokhanBooked }, { staffMemberId: secondBooked }],
    });

    const { error } = await completeAs(owner, appointmentId, [{ appointmentItemId: itemIds[0]!, actualStaffMemberId: serdarActual }]);
    expect(error).toBeNull();

    const items = await testDb<{ id: string; actual_staff_member_id: string | null }[]>`
      select id, actual_staff_member_id from appointment_items where appointment_id = ${appointmentId} order by sequence`;
    expect(items[0]!.actual_staff_member_id).toBe(serdarActual); // corrected
    expect(items[1]!.actual_staff_member_id).toBe(secondBooked); // defaulted to its own booked staff, not left null
  });

  it("exactly one audit row is written per completion, capturing both the status change and the item performer delta", async () => {
    const staffId = await eligibleStaff("Audit Row Staff");
    const actualStaff = await eligibleStaff("Audit Row Actual");
    const { appointmentId, itemIds } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });
    await completeAs(owner, appointmentId, [{ appointmentItemId: itemIds[0]!, actualStaffMemberId: actualStaff }]);

    const rows = await testDb<{ before: { items: { actual_staff_member_id: string | null }[] }; after: { items: { actual_staff_member_id: string | null }[] } }[]>`
      select before, after from audit_logs where entity_id = ${appointmentId} and action = 'appointment.status_changed'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.before.items[0]!.actual_staff_member_id).toBeNull();
    expect(rows[0]!.after.items[0]!.actual_staff_member_id).toBe(actualStaff);
  });
});

describe("Faz 5A.1A — reports.staff grants no base-table access", () => {
  it("1. a reports.staff-only user CANNOT select appointments directly — RLS silently matches zero rows, not a thrown error (same convention as every other RLS denial in this codebase)", async () => {
    const staffId = await eligibleStaff("Reports Only Appointments Staff");
    const { appointmentId } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });

    const client = await signInAs(reportsOnlyUser);
    const { data, error } = await client.from("appointments").select("id").eq("id", appointmentId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    await client.auth.signOut();
  });

  it("2. a reports.staff-only user CANNOT select appointment_items directly", async () => {
    const staffId = await eligibleStaff("Reports Only Items Staff");
    const { itemIds } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });

    const client = await signInAs(reportsOnlyUser);
    const { data, error } = await client.from("appointment_items").select("id").eq("id", itemIds[0]);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    await client.auth.signOut();
  });

  it("3. a reports.staff-only user cannot reach the internal performance relation at all — it isn't part of the exposed API surface, so PostgREST errors rather than silently filtering", async () => {
    const client = await signInAs(reportsOnlyUser);
    // appointment_item_performance no longer appears in the generated
    // types at all (it moved to `private`, which codegen never sees), so
    // the typed client correctly refuses to even construct this call —
    // there is no well-typed way to ask for it. A raw, unauthenticated-
    // by-our-types fetch against the same REST endpoint is the honest
    // way to prove the SERVER (PostgREST) itself rejects the relation,
    // not merely that our own generated types would have stopped a
    // well-behaved caller from asking.
    const {
      data: { session },
    } = await client.auth.getSession();
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/appointment_item_performance?select=appointment_item_id&limit=1`,
      {
        headers: {
          apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
          Authorization: `Bearer ${session!.access_token}`,
        },
      },
    );
    expect(response.ok).toBe(false); // PostgREST 404s — the relation is unknown to it, not merely RLS-filtered to empty
    await client.auth.signOut();
  });

  it("4. existing appointments.view behavior is completely unchanged — a role holding ONLY appointments.view (never touched by 5A.1/5A.1A) reads exactly what it always could", async () => {
    const staffId = await eligibleStaff("View Only Behavior Staff");
    const { appointmentId, itemIds } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });

    const client = await signInAs(viewOnlyUser);
    const [appointmentRes, itemRes] = await Promise.all([
      client.from("appointments").select("id").eq("id", appointmentId),
      client.from("appointment_items").select("id").eq("id", itemIds[0]),
    ]);
    expect(appointmentRes.error).toBeNull();
    expect(appointmentRes.data).toHaveLength(1);
    expect(itemRes.error).toBeNull();
    expect(itemRes.data).toHaveLength(1);
    await client.auth.signOut();
  });

  it("5. tenant isolation remains intact on the base tables for a role with appointments.view, and the private view's own rows still carry the correct tenant_id for a future consumer to filter on", async () => {
    const mineStaff = await eligibleStaff("Isolation Mine Staff");
    const { itemIds: mineItems } = await createAppointmentWithItems({ status: "completed", items: [{ staffMemberId: mineStaff }] });

    const [otherCustomer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${otherTenant.id}, 'Other Tenant Customer') returning id`;
    const start = hoursFromNow(24);
    const end = new Date(start.getTime() + 30 * 60_000);
    const [otherService] = await testDb<{ id: string }[]>`insert into services (tenant_id, name, duration_minutes, price) values (${otherTenant.id}, 'Other Service', 30, 200) returning id`;
    const [otherAppt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${otherTenant.id}, ${otherBranchId}, ${otherCustomer!.id}, 'completed', ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
      returning id`;
    const [otherItem] = await testDb<{ id: string }[]>`
      insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${otherTenant.id}, ${otherAppt!.id}, ${otherService!.id}, ${otherStaffId}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, 30, 200, 1)
      returning id`;

    // Base-table isolation, via the real (unchanged) appointments.view policy.
    const client = await signInAs(viewOnlyUser);
    const { data } = await client.from("appointment_items").select("id, tenant_id");
    const ids = (data ?? []).map((r) => r.id);
    expect(ids).toContain(mineItems[0]);
    expect(ids).not.toContain(otherItem!.id);
    expect((data ?? []).every((r) => r.tenant_id === tenant.id)).toBe(true);
    await client.auth.signOut();

    // The private view itself provides NO isolation on its own (it has no
    // RLS/security_invoker — see the 5A.1A migration comment) — querying it
    // via the privileged testDb connection with an explicit tenant filter
    // must return only that tenant's rows, proving the view's own tenant_id
    // column is correct and ready for a future SECURITY DEFINER function
    // to filter on; querying it WITHOUT a filter returns both tenants',
    // which is the exact reason such a function's own filter is mandatory.
    const filtered = await testDb<{ appointment_item_id: string }[]>`
      select appointment_item_id from private.appointment_item_performance where tenant_id = ${tenant.id}`;
    expect(filtered.map((r) => r.appointment_item_id)).toContain(mineItems[0]);
    expect(filtered.map((r) => r.appointment_item_id)).not.toContain(otherItem!.id);

    const unfiltered = await testDb<{ tenant_id: string }[]>`
      select distinct tenant_id from private.appointment_item_performance where appointment_item_id in (${mineItems[0]}, ${otherItem!.id})`;
    expect(unfiltered.map((r) => r.tenant_id).sort()).toEqual([tenant.id, otherTenant.id].sort());
  });

  it("6. no broad authenticated/public grant was introduced — the two Faz 5A.1 policies are gone by name, and appointments/appointment_items carry no new SELECT policy beyond the original appointments.view-gated one", async () => {
    const policies = await testDb<{ tablename: string; policyname: string }[]>`
      select tablename, policyname from pg_policies
      where schemaname = 'public' and tablename in ('appointments', 'appointment_items')`;
    const names = policies.map((p) => p.policyname);
    expect(names).not.toContain("appointments_select_reports_staff");
    expect(names).not.toContain("appointment_items_select_reports_staff");
    expect(names).toEqual(
      expect.arrayContaining(["appointments_select_appointments_view", "appointment_items_select_appointments_view"]),
    );
    // Exactly one SELECT policy per table now — back to the pre-5A.1 shape.
    expect(policies.filter((p) => p.tablename === "appointments")).toHaveLength(1);
    expect(policies.filter((p) => p.tablename === "appointment_items")).toHaveLength(1);
  });
});

describe("Faz 5A.2 — completion bypass closed (Option A)", () => {
  it("A. update_appointment_status rejects 'completed' with AP017, regardless of whether the appointment exists or the caller has permission (same precedence as AP015)", async () => {
    const staffId = await eligibleStaff("Bypass Closed Staff");
    const { appointmentId } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });
    const client = await signInAs(owner);

    const { error } = await client.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "completed" });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AP017");

    // Rejected before ever touching the row — status is whatever it was,
    // never silently advanced to 'completed' anyway.
    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(row!.status).toBe("confirmed");

    // Checked even for a nonexistent appointment — same "shape validation
    // before existence" precedence AP015 already had.
    const nonexistent = await client.rpc("update_appointment_status", { p_appointment_id: crypto.randomUUID(), p_new_status: "completed" });
    expect(nonexistent.error!.code).toBe("AP017");
    await client.auth.signOut();
  });

  it("B. every non-completion transition still works exactly as before — confirmed/in_progress/no_show/cancelled are completely untouched", async () => {
    const staffId = await eligibleStaff("Regression Staff");
    const { appointmentId } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });
    const client = await signInAs(owner);

    const toInProgress = await client.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "in_progress" });
    expect(toInProgress.error).toBeNull();

    const toNoShow = await client.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "no_show" });
    expect(toNoShow.error).toBeNull();
    await client.auth.signOut();

    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(row!.status).toBe("no_show");
  });

  it("cancellation via update_appointment_status is unaffected by this migration", async () => {
    const staffId = await eligibleStaff("Regression Cancel Staff");
    const { appointmentId } = await createAppointmentWithItems({ items: [{ staffMemberId: staffId }] });
    const client = await signInAs(owner);
    const { error } = await client.rpc("update_appointment_status", { p_appointment_id: appointmentId, p_new_status: "cancelled" });
    expect(error).toBeNull();
    await client.auth.signOut();
    const [row] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(row!.status).toBe("cancelled");
  });
});

describe("security — grants and overload surface", () => {
  it("complete_appointment: authenticated only, anon and public denied, exactly one overload", async () => {
    const grants = await testDb<{ grantee: string }[]>`
      select grantee::text from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'complete_appointment' and privilege_type = 'EXECUTE'`;
    const grantees = grants.map((g) => g.grantee);
    expect(grantees).toContain("authenticated");
    expect(grantees).not.toContain("anon");
    expect(grantees).not.toContain("PUBLIC");

    const overloads = await testDb<{ nargs: number }[]>`
      select p.pronargs as nargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'complete_appointment'`;
    expect(overloads.length).toBe(1);
    expect(overloads[0]!.nargs).toBe(2);
  });

  it("private.complete_appointment itself has no direct grant to authenticated/anon/public — reachable only through the public wrapper", async () => {
    const grants = await testDb<{ grantee: string }[]>`
      select grantee::text from information_schema.role_routine_grants
      where routine_schema = 'private' and routine_name = 'complete_appointment' and privilege_type = 'EXECUTE'`;
    expect(grants.map((g) => g.grantee)).not.toContain("authenticated");
    expect(grants.map((g) => g.grantee)).not.toContain("anon");
    expect(grants.map((g) => g.grantee)).not.toContain("PUBLIC");
  });

  it("7. the actual-performer tenant-safety composite FK is still intact — a schema-level regression guard, independent of the behavioral cross-tenant/nonexistent-performer tests above", async () => {
    const constraints = await testDb<{ conname: string; contype: string }[]>`
      select conname, contype::text from pg_constraint
      where conname = 'appointment_items_actual_staff_same_tenant'`;
    expect(constraints).toHaveLength(1);
    expect(constraints[0]!.contype).toBe("f"); // foreign key, not merely a same-named check/unique constraint

    const cols = await testDb<{ column_name: string }[]>`
      select a.attname as column_name
      from pg_constraint c
      join unnest(c.conkey) with ordinality as k(attnum, ord) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.conname = 'appointment_items_actual_staff_same_tenant'
      order by k.ord`;
    expect(cols.map((c) => c.column_name)).toEqual(["actual_staff_member_id", "tenant_id"]);
  });
});
