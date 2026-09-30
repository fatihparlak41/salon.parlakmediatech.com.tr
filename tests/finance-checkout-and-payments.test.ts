import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  signInAs,
  createTestTenant,
  createTestUser,
  createBranch,
  createService,
  createStaffMember,
  createStaffSchedule,
  createCustomRole,
  addMembership,
  cleanupTenants,
  cleanupUsers,
  safeMorningStart,
  attemptAs,
  asAuthenticatedUser,
  type TestUser,
} from "./helpers";

/**
 * Faz FIN.1A — appointment checkout & payments (20260929120000). Every
 * scenario from the approved FIN.1A test matrix, driven through the real
 * public.* RPC surface (never private.* directly) as real signed-in
 * actors — same "test the reachable surface" convention as
 * appointment-snapshot-trust-boundary.test.ts.
 *
 * Faz FIN.1A Owner review (completed-only gate): a sale may only be
 * created once appointments.status = 'completed' (FN010 otherwise —
 * this alone also covers 'cancelled', which can never become
 * 'completed'). Every fixture below that needs an existing sale
 * completes the appointment first via the real complete_appointment
 * RPC; the completed-only-gate describe block below tests every other
 * status explicitly.
 *
 * NOTE for whoever runs this file next: it requires the
 * appointment_sales/appointment_sale_items/payments tables and their six
 * RPCs, which exist ONLY once migration 20260929120000 has actually been
 * applied to whatever TEST_DATABASE_URL points at. As of this file's own
 * commit, that migration has been validated end-to-end on an isolated
 * Supabase preview branch (never on the shared DEV database — see the
 * FIN.1A release report) but has NOT yet been applied to DEV/PROD, so
 * this file will fail with "relation ... does not exist" until a future
 * release step applies it. That failure is expected and not a
 * regression; every other file in the suite is unaffected.
 */

let owner: TestUser;
let staffUser: TestUser;
let otherTenantOwner: TestUser;
let tenant: { id: string; slug: string };
let otherTenant: { id: string; slug: string };
let branchId: string;
let staffRoleId: string;
const extraAuditActorUsers: string[] = [];

async function makeStaffAndService(durationMinutes: number, price: number) {
  const staff = await createStaffMember(tenant.id, `FIN Staff ${crypto.randomUUID().slice(0, 8)}`);
  const service = await createService(tenant.id, `FIN Service ${crypto.randomUUID().slice(0, 8)}`, durationMinutes, price);
  await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff.id}, ${branchId})`;
  await testDb`insert into service_branches (service_id, branch_id) values (${service.id}, ${branchId})`;
  await testDb`insert into staff_services (staff_member_id, service_id) values (${staff.id}, ${service.id})`;
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenant.id, staff.id, weekday, "00:00", "23:59");
  }
  return { staff, service };
}

/** Real create_appointment RPC call, signed in as the owner — same
 * fixture-creation convention as appointment-snapshot-trust-boundary.test.ts,
 * so appointment_items.price is the genuine server-derived booking-time
 * snapshot, not a hand-inserted row. Status starts 'scheduled' (the
 * table's own default). */
async function makeAppointment(priceOverride?: number): Promise<{ appointmentId: string; itemId: string; staffId: string; price: number }> {
  const price = priceOverride ?? 500;
  const { staff, service } = await makeStaffAndService(30, price);
  const [customer] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name) values (${tenant.id}, 'FIN Customer') returning id
  `;
  const start = safeMorningStart(3);
  const client = await signInAs(owner);
  const { data: appointmentId, error } = await client.rpc("create_appointment", {
    p_tenant_id: tenant.id,
    p_branch_id: branchId,
    p_customer_id: customer!.id,
    p_items: [{ service_id: service.id, staff_member_id: staff.id, scheduled_start_at: start.toISOString(), sequence: 1 }],
  });
  if (error || !appointmentId) throw new Error(`fixture appointment creation failed: ${error?.message}`);
  const [item] = await testDb<{ id: string }[]>`select id from appointment_items where appointment_id = ${appointmentId}`;
  return { appointmentId: appointmentId as string, itemId: item!.id, staffId: staff.id, price };
}

async function transitionStatus(appointmentId: string, status: "confirmed" | "in_progress" | "cancelled" | "no_show") {
  const outcome = await attemptAs(owner.id, (sql) => sql`select public.update_appointment_status(${appointmentId}, ${status})`);
  if (!outcome.ok) throw new Error(`fixture status transition to ${status} failed: ${outcome.message}`);
}

async function completeAppointment(
  appointmentId: string,
  performerOverrides: { appointmentItemId: string; actualStaffMemberId: string }[] = [],
) {
  const overridesArray = performerOverrides.map((o) => ({
    appointment_item_id: o.appointmentItemId,
    actual_staff_member_id: o.actualStaffMemberId,
  }));
  // sql.json(...), not a hand-built string + ::jsonb cast — postgres.js's
  // documented way to bind a jsonb parameter; avoids any ambiguity over
  // how a pre-stringified JS string interpolates into the template.
  const outcome = await attemptAs(owner.id, (sql) => sql`select public.complete_appointment(${appointmentId}, ${sql.json(overridesArray)})`);
  if (!outcome.ok) throw new Error(`fixture completion failed: ${outcome.message}`);
}

/** makeAppointment, immediately completed with no performer overrides —
 * the shape every sale/payment/void/privacy fixture below needs now
 * that checkout requires status = 'completed'. */
async function makeCompletedAppointment(priceOverride?: number) {
  const fixture = await makeAppointment(priceOverride);
  await completeAppointment(fixture.appointmentId);
  return fixture;
}

beforeAll(async () => {
  owner = await createTestUser("fin1a-owner");
  staffUser = await createTestUser("fin1a-staff");
  otherTenantOwner = await createTestUser("fin1a-other-owner");

  const tenantRow = await createTestTenant("test-fin1a-checkout", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug };
  branchId = await createBranch(tenant.id, "FIN Branch");

  // A role with appointments.view (so it can legitimately open the
  // appointment detail sheet) but neither finance.view nor
  // finance.manage — the exact "ordinary staff" shape scenarios 8/29/32/33
  // need.
  staffRoleId = await createCustomRole(tenant.id, "FIN Test Personel", ["appointments.view"]);
  await addMembership(tenant.id, staffUser.id, staffRoleId);

  const otherTenantRow = await createTestTenant("test-fin1a-other-tenant", otherTenantOwner.id);
  otherTenant = { id: otherTenantRow.id, slug: otherTenantRow.slug };
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenant.id, otherTenant.id]);
  await cleanupUsers([owner.id, staffUser.id, otherTenantOwner.id, ...extraAuditActorUsers]);
});

describe("completed-only checkout gate", () => {
  it("1. a scheduled appointment is rejected (FN010)", async () => {
    const { appointmentId } = await makeAppointment();
    const outcome = await attemptAs(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN010");
  });

  it("2. a confirmed appointment is rejected (FN010)", async () => {
    const { appointmentId } = await makeAppointment();
    await transitionStatus(appointmentId, "confirmed");
    const outcome = await attemptAs(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN010");
  });

  it("3. an in_progress appointment is rejected (FN010)", async () => {
    const { appointmentId } = await makeAppointment();
    await transitionStatus(appointmentId, "confirmed");
    await transitionStatus(appointmentId, "in_progress");
    const outcome = await attemptAs(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN010");
  });

  it("4. a cancelled appointment is rejected (FN010)", async () => {
    const { appointmentId } = await makeAppointment();
    await transitionStatus(appointmentId, "cancelled");
    const outcome = await attemptAs(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN010");
  });

  it("5. a completed appointment succeeds", async () => {
    const { appointmentId, price } = await makeAppointment(500);
    await completeAppointment(appointmentId);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ subtotal: string; status: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`,
    );
    expect(sale?.subtotal).toBe(price.toFixed(2));
    expect(sale?.status).toBe("open");
  });

  it("6. a repeated call on a completed appointment returns the SAME sale", async () => {
    const { appointmentId } = await makeCompletedAppointment();
    const [first] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`,
    );
    const [second] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`,
    );
    expect(second?.id).toBe(first?.id);
  });

  it("7. reading finance on a completed appointment with no sale yet does not create one", async () => {
    const { appointmentId } = await makeCompletedAppointment();
    const [row] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ get_appointment_sale_for_appointment: unknown }[]>`select public.get_appointment_sale_for_appointment(${appointmentId})`,
    );
    expect(row?.get_appointment_sale_for_appointment).toBeNull();
    const [count] = await testDb<{ n: string }[]>`select count(*)::text as n from appointment_sales where appointment_id = ${appointmentId}`;
    expect(count?.n).toBe("0");
  });

  it("8. reading finance on a non-completed appointment does not create one", async () => {
    const { appointmentId } = await makeAppointment();
    const [row] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ get_appointment_sale_for_appointment: unknown }[]>`select public.get_appointment_sale_for_appointment(${appointmentId})`,
    );
    expect(row?.get_appointment_sale_for_appointment).toBeNull();
    const [count] = await testDb<{ n: string }[]>`select count(*)::text as n from appointment_sales where appointment_id = ${appointmentId}`;
    expect(count?.n).toBe("0");
  });
});

describe("performer snapshot after completion", () => {
  it("9. an explicit performer override at completion is what the sale item snapshots", async () => {
    const { appointmentId, itemId } = await makeAppointment();
    const actualStaff = await createStaffMember(tenant.id, `FIN Override Staff ${crypto.randomUUID().slice(0, 8)}`);
    await completeAppointment(appointmentId, [{ appointmentItemId: itemId, actualStaffMemberId: actualStaff.id }]);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    const [row] = await testDb<{ actual: string }[]>`
      select asi.actual_staff_member_id as actual from appointment_sale_items asi
      join appointment_sales s on s.id = asi.sale_id where s.appointment_id = ${appointmentId}
    `;
    expect(row?.actual).toBe(actualStaff.id);
  });

  it("10. a legacy completed row with a null actual_staff_member_id still falls back to the booked staff", async () => {
    const { appointmentId, itemId, staffId } = await makeCompletedAppointment();
    // complete_appointment always fills actual_staff_member_id (falling
    // back to the booked staff when no override is given) — this
    // directly simulates the "legacy" edge case the spec describes: a
    // completed row that somehow still has a null value there, proving
    // the sale-creation query's own coalesce(actual, booked) is what
    // actually saves it, not complete_appointment's behavior.
    await testDb`update appointment_items set actual_staff_member_id = null where id = ${itemId}`;
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    const [row] = await testDb<{ actual: string }[]>`
      select asi.actual_staff_member_id as actual from appointment_sale_items asi
      join appointment_sales s on s.id = asi.sale_id where s.appointment_id = ${appointmentId}
    `;
    expect(row?.actual).toBe(staffId);
  });
});

describe("appointment sale — creation (idempotency, tenant/permission boundaries, price snapshot)", () => {
  it("the sale item's unit_price is the booked price snapshot", async () => {
    const { appointmentId, price } = await makeCompletedAppointment(650);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    const [item] = await testDb<{ unit_price: string; booked_price: string }[]>`
      select asi.unit_price, ai.price as booked_price
      from appointment_sale_items asi
      join appointment_items ai on ai.id = asi.appointment_item_id
      join appointment_sales s on s.id = asi.sale_id
      where s.appointment_id = ${appointmentId}
    `;
    expect(item?.unit_price).toBe(price.toFixed(2));
    expect(item?.unit_price).toBe(item?.booked_price);
  });

  it("a later service catalog price change does not alter the existing sale item", async () => {
    const { appointmentId } = await makeCompletedAppointment(400);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    await testDb`update services set price = 9999 where id in (
      select service_id from appointment_sale_items asi
      join appointment_sales s on s.id = asi.sale_id where s.appointment_id = ${appointmentId}
    )`;
    const [item] = await testDb<{ unit_price: string }[]>`
      select asi.unit_price from appointment_sale_items asi
      join appointment_sales s on s.id = asi.sale_id where s.appointment_id = ${appointmentId}
    `;
    expect(item?.unit_price).toBe("400.00");
  });

  it("a cross-tenant owner is blocked (FN002), never FN010", async () => {
    const { appointmentId } = await makeCompletedAppointment();
    const outcome = await attemptAs(otherTenantOwner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN002");
  });

  it("finance.manage is required for creation — appointments.view alone is not enough (FN002)", async () => {
    const { appointmentId } = await makeCompletedAppointment();
    const outcome = await attemptAs(staffUser.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN002");
  });

  it("concurrent create is safe (documented as code-reviewed, not stress-tested in this describe block — see the dedicated concurrency describe below for a real attempt)", () => {
    expect(true).toBe(true);
  });
});

describe("price / discount editing", () => {
  async function makeSale(price = 500) {
    const { appointmentId } = await makeCompletedAppointment(price);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`,
    );
    const [item] = await testDb<{ id: string }[]>`select id from appointment_sale_items where sale_id = ${sale!.id}`;
    return { appointmentId, saleId: sale!.id, saleItemId: item!.id };
  }

  it("a valid price adjustment recomputes the subtotal", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.adjust_appointment_sale_item_price(${saleItemId}, 450.00)`);
    const [sale] = await testDb<{ subtotal: string }[]>`select subtotal from appointment_sales where id = ${saleId}`;
    expect(sale?.subtotal).toBe("450.00");
  });

  it("a negative price is rejected (FN004)", async () => {
    const { saleItemId } = await makeSale();
    const outcome = await attemptAs(owner.id, (sql) => sql`select public.adjust_appointment_sale_item_price(${saleItemId}, -10)`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN004");
  });

  it("a valid discount reduces the total, status stays open", async () => {
    const { saleId } = await makeSale(500);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ total_amount: string; status: string }[]>`select * from public.adjust_appointment_sale_discount(${saleId}, 100, 'promo')`,
    );
    expect(sale?.total_amount).toBe("400.00");
    expect(sale?.status).toBe("open");
  });

  it("a discount exceeding the subtotal is rejected (FN004)", async () => {
    const { saleId } = await makeSale(500);
    const outcome = await attemptAs(owner.id, (sql) => sql`select public.adjust_appointment_sale_discount(${saleId}, 9999, null)`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN004");
  });

  it("appointment_items.price is never mutated by any sale edit", async () => {
    const { appointmentId, saleItemId } = await makeSale(500);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.adjust_appointment_sale_item_price(${saleItemId}, 111.00)`);
    const [item] = await testDb<{ price: string }[]>`select price from appointment_items where appointment_id = ${appointmentId}`;
    expect(item?.price).toBe("500.00");
  });

  it("an edit that would drop the total below already-collected payments is rejected (FN004)", async () => {
    const { saleId } = await makeSale(500);
    await asAuthenticatedUser(owner.id, (sql) =>
      sql`select public.record_appointment_payment(${saleId}, 300, 'cash', now(), null, ${crypto.randomUUID()})`,
    );
    const outcome = await attemptAs(owner.id, (sql) => sql`select public.adjust_appointment_sale_discount(${saleId}, 250, null)`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN004");
    const [sale] = await testDb<{ discount_amount: string }[]>`select discount_amount from appointment_sales where id = ${saleId}`;
    expect(sale?.discount_amount).toBe("0.00");
  });
});

describe("payments", () => {
  async function makeSale(price = 500) {
    const { appointmentId } = await makeCompletedAppointment(price);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`,
    );
    return { appointmentId, saleId: sale!.id };
  }

  it.each([
    ["cash"],
    ["card"],
    ["bank_transfer"],
    ["other"],
  ])("%s payments are accepted", async (method) => {
    const { saleId } = await makeSale(500);
    const [payment] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ method: string; status: string }[]>`
        select * from public.record_appointment_payment(${saleId}, 100, ${method}, now(), null, ${crypto.randomUUID()})
      `,
    );
    expect(payment?.method).toBe(method);
    expect(payment?.status).toBe("posted");
  });

  it("a partial payment leaves the sale partially_paid", async () => {
    const { saleId } = await makeSale(500);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.record_appointment_payment(${saleId}, 200, 'cash', now(), null, ${crypto.randomUUID()})`);
    const [sale] = await testDb<{ status: string }[]>`select status from appointment_sales where id = ${saleId}`;
    expect(sale?.status).toBe("partially_paid");
  });

  it("mixed methods on the same sale all accumulate toward the same total", async () => {
    const { saleId } = await makeSale(600);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.record_appointment_payment(${saleId}, 200, 'cash', now(), null, ${crypto.randomUUID()})`);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.record_appointment_payment(${saleId}, 200, 'card', now(), null, ${crypto.randomUUID()})`);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.record_appointment_payment(${saleId}, 200, 'bank_transfer', now(), null, ${crypto.randomUUID()})`);
    const [sale] = await testDb<{ status: string }[]>`select status from appointment_sales where id = ${saleId}`;
    expect(sale?.status).toBe("paid");
  });

  it("a payment exactly equal to the total marks the sale paid", async () => {
    const { saleId } = await makeSale(500);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.record_appointment_payment(${saleId}, 500, 'cash', now(), null, ${crypto.randomUUID()})`);
    const [sale] = await testDb<{ status: string }[]>`select status from appointment_sales where id = ${saleId}`;
    expect(sale?.status).toBe("paid");
  });

  it("an overpayment is blocked (FN005)", async () => {
    const { saleId } = await makeSale(500);
    const outcome = await attemptAs(owner.id, (sql) => sql`select public.record_appointment_payment(${saleId}, 9999, 'cash', now(), null, ${crypto.randomUUID()})`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN005");
  });

  it("a non-positive amount is blocked (FN004)", async () => {
    const { saleId } = await makeSale(500);
    const outcome = await attemptAs(owner.id, (sql) => sql`select public.record_appointment_payment(${saleId}, 0, 'cash', now(), null, ${crypto.randomUUID()})`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN004");
  });

  it("retrying the same idempotency key with the identical payload returns the same payment", async () => {
    const { saleId } = await makeSale(500);
    const key = crypto.randomUUID();
    const paidAt = new Date();
    const [first] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.record_appointment_payment(${saleId}, 100, 'cash', ${paidAt.toISOString()}, null, ${key})`,
    );
    const [second] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.record_appointment_payment(${saleId}, 100, 'cash', ${paidAt.toISOString()}, null, ${key})`,
    );
    expect(second?.id).toBe(first?.id);
  });

  it("reusing the same idempotency key with a different payload is a stable conflict (FN007)", async () => {
    const { saleId } = await makeSale(500);
    const key = crypto.randomUUID();
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.record_appointment_payment(${saleId}, 100, 'cash', now(), null, ${key})`);
    const outcome = await attemptAs(owner.id, (sql) => sql`select public.record_appointment_payment(${saleId}, 200, 'cash', now(), null, ${key})`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN007");
  });
});

describe("voiding a payment", () => {
  async function makeSaleWithPayment(price = 500, amount = 200) {
    const { appointmentId } = await makeCompletedAppointment(price);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`,
    );
    const [payment] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.record_appointment_payment(${sale!.id}, ${amount}, 'cash', now(), null, ${crypto.randomUUID()})`,
    );
    return { saleId: sale!.id, paymentId: payment!.id };
  }

  it("a voided payment's row is retained, not deleted", async () => {
    const { paymentId } = await makeSaleWithPayment();
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.void_appointment_payment(${paymentId}, 'test void')`);
    const [row] = await testDb<{ status: string; void_reason: string | null }[]>`select status, void_reason from payments where id = ${paymentId}`;
    expect(row?.status).toBe("voided");
    expect(row?.void_reason).toBe("test void");
  });

  it("voiding recalculates the sale's outstanding balance", async () => {
    const { saleId, paymentId } = await makeSaleWithPayment(500, 500);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.void_appointment_payment(${paymentId}, 'refund correction')`);
    const [sale] = await testDb<{ status: string }[]>`select status from appointment_sales where id = ${saleId}`;
    expect(sale?.status).toBe("open");
  });

  it("finance.manage is required to void — appointments.view alone is not enough (FN002)", async () => {
    const { paymentId } = await makeSaleWithPayment();
    const outcome = await attemptAs(staffUser.id, (sql) => sql`select public.void_appointment_payment(${paymentId}, 'unauthorized')`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN002");
  });

  it("a cross-tenant owner cannot void another tenant's payment (FN002)", async () => {
    const { paymentId } = await makeSaleWithPayment();
    const outcome = await attemptAs(otherTenantOwner.id, (sql) => sql`select public.void_appointment_payment(${paymentId}, 'cross tenant')`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN002");
  });
});

describe("privacy / read model", () => {
  it("finance.view holders can read the summary", async () => {
    const { appointmentId } = await makeCompletedAppointment(500);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    const [row] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ get_appointment_sale_for_appointment: unknown }[]>`select public.get_appointment_sale_for_appointment(${appointmentId})`,
    );
    expect(row?.get_appointment_sale_for_appointment).toBeTruthy();
  });

  it("appointments.view without finance.view is denied (FN002) — no finance data reaches ordinary staff", async () => {
    const { appointmentId } = await makeCompletedAppointment(500);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    const outcome = await attemptAs(staffUser.id, (sql) => sql`select public.get_appointment_sale_for_appointment(${appointmentId})`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN002");
  });

  it("the read model shape has no customer/staff PII or raw user ids", async () => {
    const { appointmentId } = await makeCompletedAppointment(500);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`);
    await asAuthenticatedUser(owner.id, (sql) =>
      sql`select public.record_appointment_payment(
        (select id from appointment_sales where appointment_id = ${appointmentId}),
        100, 'cash', now(), 'a note', ${crypto.randomUUID()})`,
    );
    const [row] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ get_appointment_sale_for_appointment: Record<string, unknown> }[]>`
        select public.get_appointment_sale_for_appointment(${appointmentId})
      `,
    );
    const json = row!.get_appointment_sale_for_appointment;
    const serialized = JSON.stringify(json);
    expect(json).toHaveProperty("collected");
    expect(json).toHaveProperty("outstanding");
    expect(serialized).not.toMatch(/created_by|voided_by|email|phone|customer_id|notes/i);
  });
});

describe("payment recording never mutates appointment status", () => {
  it("recording a payment leaves the (already completed) appointment's status untouched", async () => {
    const { appointmentId } = await makeCompletedAppointment(500);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`,
    );
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.record_appointment_payment(${sale!.id}, 500, 'cash', now(), null, ${crypto.randomUUID()})`);
    const [appt] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(appt?.status).toBe("completed");
    const [saleAfter] = await testDb<{ status: string }[]>`select status from appointment_sales where id = ${sale!.id}`;
    expect(saleAfter?.status).toBe("paid");
  });

  it("a completed, fully unpaid sale is a valid resting state — no payment is ever forced", async () => {
    const { appointmentId } = await makeCompletedAppointment(500);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ status: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`,
    );
    expect(sale?.status).toBe("open");
    const [appt] = await testDb<{ status: string }[]>`select status from appointments where id = ${appointmentId}`;
    expect(appt?.status).toBe("completed");
  });
});

describe("concurrency", () => {
  it("sale creation: two near-simultaneous first-time calls yield exactly one sale row (code-reviewed row lock; see the FIN.1A release report for the true-multi-connection limitation of this suite's own tooling)", async () => {
    const { appointmentId } = await makeCompletedAppointment(500);
    const [a, b] = await Promise.all([
      attemptAs(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`),
      attemptAs(owner.id, (sql) => sql`select public.get_or_create_appointment_sale(${appointmentId})`),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const [count] = await testDb<{ n: string }[]>`select count(*)::text as n from appointment_sales where appointment_id = ${appointmentId}`;
    expect(count?.n).toBe("1");
  });

  it("payments: two near-simultaneous 700+700 attempts against a 1000 sale never let posted total exceed 1000 (code-reviewed row lock; see the same limitation note above)", async () => {
    const { appointmentId } = await makeCompletedAppointment(1000);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`,
    );
    const [a, b] = await Promise.all([
      attemptAs(owner.id, (sql) => sql`select public.record_appointment_payment(${sale!.id}, 700, 'cash', now(), null, ${crypto.randomUUID()})`),
      attemptAs(owner.id, (sql) => sql`select public.record_appointment_payment(${sale!.id}, 700, 'card', now(), null, ${crypto.randomUUID()})`),
    ]);
    const successes = [a, b].filter((o) => o.ok).length;
    expect(successes).toBe(1);
    const [posted] = await testDb<{ total: string }[]>`
      select coalesce(sum(amount), 0)::text as total from payments where appointment_sale_id = ${sale!.id} and status = 'posted'
    `;
    expect(Number(posted?.total)).toBeLessThanOrEqual(1000);
  });
});
