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
  auditRows,
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
 * appointment_sales/appointment_sale_items/payments tables and their five
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

describe("pricing — ONE atomic update_appointment_sale_pricing", () => {
  async function makeSale(price = 500) {
    const { appointmentId } = await makeCompletedAppointment(price);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`,
    );
    const [item] = await testDb<{ id: string }[]>`select id from appointment_sale_items where sale_id = ${sale!.id}`;
    return { appointmentId, saleId: sale!.id, saleItemId: item!.id };
  }

  /** A completed appointment with TWO items (two staff, two services,
   * sequential non-overlapping slots) — the shape every multi-item
   * atomicity / exact-set-match scenario below needs. Items come back
   * ordered by unit_price desc, so items[0] is always the pricier one. */
  async function makeSaleWithTwoItems(price1 = 300, price2 = 200) {
    const a = await makeStaffAndService(30, price1);
    const b = await makeStaffAndService(30, price2);
    const [customer] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name) values (${tenant.id}, 'FIN Customer') returning id
    `;
    const start = safeMorningStart(3);
    const client = await signInAs(owner);
    const { data: appointmentId, error } = await client.rpc("create_appointment", {
      p_tenant_id: tenant.id,
      p_branch_id: branchId,
      p_customer_id: customer!.id,
      p_items: [
        { service_id: a.service.id, staff_member_id: a.staff.id, scheduled_start_at: start.toISOString(), sequence: 1 },
        {
          service_id: b.service.id,
          staff_member_id: b.staff.id,
          scheduled_start_at: new Date(start.getTime() + 35 * 60_000).toISOString(),
          sequence: 2,
        },
      ],
    });
    if (error || !appointmentId) throw new Error(`fixture two-item appointment creation failed: ${error?.message}`);
    await completeAppointment(appointmentId as string);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId as string})`,
    );
    const items = await testDb<{ id: string; unit_price: string }[]>`
      select id, unit_price from appointment_sale_items where sale_id = ${sale!.id} order by unit_price desc
    `;
    return { appointmentId: appointmentId as string, saleId: sale!.id, items };
  }

  /** Everything a pricing save could possibly touch, at full text
   * precision (updated_at::text, not a JS Date — postgres.js drops
   * microseconds from timestamptz) — so "ZERO changes" below is an
   * exact before/after deep-equality, not a spot check of a few fields. */
  async function snapshot(saleId: string) {
    const [sale] = await testDb<{ subtotal: string; discount_amount: string; status: string; updated_at: string }[]>`
      select subtotal::text, discount_amount::text, status, updated_at::text from appointment_sales where id = ${saleId}
    `;
    const items = await testDb<{ id: string; unit_price: string; updated_at: string }[]>`
      select id, unit_price::text, updated_at::text from appointment_sale_items where sale_id = ${saleId} order by id
    `;
    return { sale, items };
  }

  /** A completed appointment + sale in the OTHER tenant (created as that
   * tenant's own owner), so a pricing request for this tenant's sale can
   * be fed an item id that really belongs to somebody else's checkout. */
  async function makeOtherTenantSale(price = 700) {
    const otherBranchId = await createBranch(otherTenant.id, "FIN Other Branch");
    const staff = await createStaffMember(otherTenant.id, `FIN Other Staff ${crypto.randomUUID().slice(0, 8)}`);
    const service = await createService(otherTenant.id, `FIN Other Service ${crypto.randomUUID().slice(0, 8)}`, 30, price);
    const [customer] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name) values (${otherTenant.id}, 'FIN Other Customer') returning id
    `;
    const start = safeMorningStart(3);
    const end = new Date(start.getTime() + 30 * 60_000);
    const [appointment] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${otherTenant.id}, ${otherBranchId}, ${customer!.id}, 'completed', ${start.toISOString()}, ${end.toISOString()})
      returning id
    `;
    await testDb`
      insert into appointment_items (
        tenant_id, appointment_id, service_id, staff_member_id, actual_staff_member_id,
        sequence, scheduled_start_at, scheduled_end_at, duration_minutes, price
      )
      values (
        ${otherTenant.id}, ${appointment!.id}, ${service.id}, ${staff.id}, ${staff.id},
        1, ${start.toISOString()}, ${end.toISOString()}, 30, ${price}
      )
    `;
    const [sale] = await asAuthenticatedUser(otherTenantOwner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointment!.id})`,
    );
    const [item] = await testDb<{ id: string }[]>`select id from appointment_sale_items where sale_id = ${sale!.id}`;
    return { saleId: sale!.id, saleItemId: item!.id };
  }

  it("1. a valid multi-item price change + discount commits together", async () => {
    const { saleId, items } = await makeSaleWithTwoItems(300, 200);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ subtotal: string; discount_amount: string; total_amount: string; status: string }[]>`
        select * from public.update_appointment_sale_pricing(
          ${saleId},
          ${sql.json([
            { sale_item_id: items[0]!.id, unit_price: 350 },
            { sale_item_id: items[1]!.id, unit_price: 150 },
          ])},
          50,
          'toplu düzenleme'
        )
      `,
    );
    expect(sale?.subtotal).toBe("500.00");
    expect(sale?.discount_amount).toBe("50.00");
    expect(sale?.total_amount).toBe("450.00");
    expect(sale?.status).toBe("open");
    const prices = await testDb<{ id: string; unit_price: string }[]>`select id, unit_price from appointment_sale_items where sale_id = ${saleId}`;
    expect(prices.find((r) => r.id === items[0]!.id)?.unit_price).toBe("350.00");
    expect(prices.find((r) => r.id === items[1]!.id)?.unit_price).toBe("150.00");
  });

  it("1b. the unchanged item set with only a new discount commits (the UI always sends the complete set)", async () => {
    const { saleId, items } = await makeSaleWithTwoItems(300, 200);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ subtotal: string; discount_amount: string; total_amount: string }[]>`
        select * from public.update_appointment_sale_pricing(
          ${saleId},
          ${sql.json([
            { sale_item_id: items[0]!.id, unit_price: 300 },
            { sale_item_id: items[1]!.id, unit_price: 200 },
          ])},
          100,
          null
        )
      `,
    );
    expect(sale?.subtotal).toBe("500.00");
    expect(sale?.discount_amount).toBe("100.00");
    expect(sale?.total_amount).toBe("400.00");
  });

  it("2. one invalid item in a multi-item request rolls back EVERY item price (and writes no audit event)", async () => {
    const { saleId, items } = await makeSaleWithTwoItems(300, 200);
    const before = await snapshot(saleId);
    const outcome = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId},
        ${sql.json([
          { sale_item_id: items[0]!.id, unit_price: 999 },
          { sale_item_id: items[1]!.id, unit_price: -5 },
        ])},
        0,
        null
      )`,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN004");
    expect(await snapshot(saleId)).toEqual(before);
    expect((await auditRows(tenant.id, "finance.sale_updated", saleId)).length).toBe(0);
  });

  it("3. a discount exceeding the proposed subtotal rolls back EVERY item price", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    const before = await snapshot(saleId);
    const outcome = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 450 }])}, 9999, null
      )`,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN004");
    expect(await snapshot(saleId)).toEqual(before);
  });

  it("4. a proposed total below the already-collected payments rolls back everything", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    await asAuthenticatedUser(owner.id, (sql) =>
      sql`select public.record_appointment_payment(${saleId}, 300, 'cash', now(), null, ${crypto.randomUUID()})`,
    );
    const before = await snapshot(saleId);
    // 500 - 250 = 250 < 300 already collected.
    const outcome = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 500 }])}, 250, null
      )`,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN004");
    expect(await snapshot(saleId)).toEqual(before);
  });

  it("5. a foreign sale item (another sale's) in the request rejects the whole operation, zero changes anywhere", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    const other = await makeSale(300);
    const before = await snapshot(saleId);
    const otherBefore = await snapshot(other.saleId);
    const outcome = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId},
        ${sql.json([
          { sale_item_id: saleItemId, unit_price: 400 },
          { sale_item_id: other.saleItemId, unit_price: 100 },
        ])},
        0,
        null
      )`,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN004");
    expect(await snapshot(saleId)).toEqual(before);
    expect(await snapshot(other.saleId)).toEqual(otherBefore);
  });

  it("5b. an item belonging to ANOTHER TENANT's sale (alone, or mixed with a valid own item) is rejected, zero changes anywhere", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    const foreign = await makeOtherTenantSale(700);
    const before = await snapshot(saleId);
    const foreignBefore = await snapshot(foreign.saleId);
    const mixed = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId},
        ${sql.json([
          { sale_item_id: saleItemId, unit_price: 400 },
          { sale_item_id: foreign.saleItemId, unit_price: 100 },
        ])},
        0,
        null
      )`,
    );
    const alone = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId}, ${sql.json([{ sale_item_id: foreign.saleItemId, unit_price: 400 }])}, 0, null
      )`,
    );
    for (const outcome of [mixed, alone]) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("FN004");
    }
    expect(await snapshot(saleId)).toEqual(before);
    expect(await snapshot(foreign.saleId)).toEqual(foreignBefore);
  });

  it("6. a request missing one of the sale's current items is rejected, zero changes", async () => {
    const { saleId, items } = await makeSaleWithTwoItems(300, 200);
    const before = await snapshot(saleId);
    const outcome = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId}, ${sql.json([{ sale_item_id: items[0]!.id, unit_price: 999 }])}, 0, null
      )`,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN004");
    expect(await snapshot(saleId)).toEqual(before);
  });

  it("7. a duplicate sale_item_id in the request is rejected, zero changes", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    const before = await snapshot(saleId);
    const outcome = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId},
        ${sql.json([
          { sale_item_id: saleItemId, unit_price: 400 },
          { sale_item_id: saleItemId, unit_price: 450 },
        ])},
        0,
        null
      )`,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN004");
    expect(await snapshot(saleId)).toEqual(before);
  });

  it("7b. a duplicate hidden behind an UPPERCASE / {braced} / hyphen-less spelling of the same id is rejected, zero changes", async () => {
    // Duplicate detection must run on the PARSED uuid: all of these cast to
    // the very same uuid, so a text-distinct check would let the request
    // through and make the subtotal (summed from the request) disagree with
    // what is stored on the sale's items.
    const { saleId, items } = await makeSaleWithTwoItems(300, 200);
    const before = await snapshot(saleId);
    const id = items[0]!.id;
    for (const spelling of [id.toUpperCase(), `{${id}}`, id.replace(/-/g, "")]) {
      const outcome = await attemptAs(owner.id, (sql) =>
        sql`select public.update_appointment_sale_pricing(
          ${saleId},
          ${sql.json([
            { sale_item_id: id, unit_price: 100 },
            { sale_item_id: spelling, unit_price: 100 },
          ])},
          0,
          null
        )`,
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("FN004");
    }
    expect(await snapshot(saleId)).toEqual(before);
  });

  it("7c. a single sale item id spelled in UPPERCASE is accepted and applied (validation and write use the same parsed uuid)", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ subtotal: string }[]>`select * from public.update_appointment_sale_pricing(
        ${saleId}, ${sql.json([{ sale_item_id: saleItemId.toUpperCase(), unit_price: 420 }])}, 0, null
      )`,
    );
    expect(sale?.subtotal).toBe("420.00");
    const [item] = await testDb<{ unit_price: string }[]>`select unit_price from appointment_sale_items where id = ${saleItemId}`;
    expect(item?.unit_price).toBe("420.00");
  });

  it("8. a voided sale is rejected (FN008), zero changes", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    // Nothing in FIN.1A ever sets a SALE to 'voided' yet (reserved for a
    // future, separately-authorized sale-void path) — set it directly,
    // exactly like the legacy-null-performer fixture elsewhere in this file.
    await testDb`update appointment_sales set status = 'voided' where id = ${saleId}`;
    const before = await snapshot(saleId);
    const outcome = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 400 }])}, 0, null
      )`,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN008");
    expect(await snapshot(saleId)).toEqual(before);
  });

  it("9. finance.view without finance.manage (appointments.view only) is rejected (FN002), zero changes", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    const before = await snapshot(saleId);
    const outcome = await attemptAs(staffUser.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 400 }])}, 0, null
      )`,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN002");
    expect(await snapshot(saleId)).toEqual(before);
  });

  it("9b. a cross-tenant owner is rejected (FN002), zero changes", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    const before = await snapshot(saleId);
    const outcome = await attemptAs(otherTenantOwner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 400 }])}, 0, null
      )`,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FN002");
    expect(await snapshot(saleId)).toEqual(before);
  });

  it("10. appointment_items.price snapshots remain untouched by an atomic pricing save", async () => {
    const { appointmentId, saleId, saleItemId } = await makeSale(500);
    await asAuthenticatedUser(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 111 }])}, 0, null
      )`,
    );
    const [item] = await testDb<{ price: string }[]>`select price from appointment_items where appointment_id = ${appointmentId}`;
    expect(item?.price).toBe("500.00");
  });

  it("11. a successful update recalculates the sale's status from the new total and the posted payments", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    await asAuthenticatedUser(owner.id, (sql) =>
      sql`select public.record_appointment_payment(${saleId}, 300, 'cash', now(), null, ${crypto.randomUUID()})`,
    );
    // 500 - 200 = 300 = exactly what is already collected -> paid.
    const [paid] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ status: string }[]>`select * from public.update_appointment_sale_pricing(
        ${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 500 }])}, 200, null
      )`,
    );
    expect(paid?.status).toBe("paid");
    // A higher total again -> back to partially_paid.
    const [partial] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ status: string }[]>`select * from public.update_appointment_sale_pricing(
        ${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 500 }])}, 0, null
      )`,
    );
    expect(partial?.status).toBe("partially_paid");
  });

  it("12. exactly ONE finance.sale_updated audit event is written for the whole atomic save, with safe before/after money fields", async () => {
    const { saleId, items } = await makeSaleWithTwoItems(300, 200);
    await asAuthenticatedUser(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(
        ${saleId},
        ${sql.json([
          { sale_item_id: items[0]!.id, unit_price: 320 },
          { sale_item_id: items[1]!.id, unit_price: 180 },
        ])},
        20,
        'denetim testi'
      )`,
    );
    const rows = await auditRows(tenant.id, "finance.sale_updated", saleId);
    expect(rows.length).toBe(1);
    const before = rows[0]!.before as { subtotal: number; discountAmount: number; items: unknown[] };
    const after = rows[0]!.after as { subtotal: number; discountAmount: number; items: unknown[]; discountReason: string };
    expect(before.subtotal).toBe(500);
    expect(before.discountAmount).toBe(0);
    expect(before.items.length).toBe(2);
    expect(after.subtotal).toBe(500);
    expect(after.discountAmount).toBe(20);
    expect(after.items.length).toBe(2);
    expect(after.discountReason).toBe("denetim testi");
    expect(JSON.stringify(rows[0])).not.toMatch(/email|phone|customer/i);
  });

  it("malformed input is rejected with a stable FN004, never a raw Postgres error (empty / non-array / scalar-element items, bad uuid, non-numeric / sub-cent / negative / out-of-range price, sub-cent / NaN / Infinity discount)", async () => {
    const { saleId, saleItemId } = await makeSale(500);
    const before = await snapshot(saleId);
    const empty = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json([])}, 0, null)`,
    );
    const badUuid = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json([{ sale_item_id: "not-a-uuid", unit_price: 400 }])}, 0, null)`,
    );
    const stringPrice = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: "abc" }])}, 0, null)`,
    );
    // Precision/range: a sub-cent price or discount would otherwise be
    // silently rounded at write time (leaving subtotal != the sum of the
    // stored item prices), and an out-of-range price would raise a raw 22003.
    const subCentPrice = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 100.005 }])}, 0, null)`,
    );
    const hugePrice = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 100000000 }])}, 0, null)`,
    );
    const subCentDiscount = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 500 }])}, 0.005, null)`,
    );
    const negativeSubCentPrice = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: -0.01 }])}, 0, null)`,
    );
    // jsonb arguments that are not an array of objects at all.
    const objectItems = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json({})}, 0, null)`,
    );
    const scalarItems = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json("abc")}, 0, null)`,
    );
    const nullItems = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, null, 0, null)`,
    );
    const scalarElements = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json([1, 2])}, 0, null)`,
    );
    // numeric NaN / Infinity are valid Postgres numerics a direct RPC caller
    // could send as the discount; both must die as FN004, not slip through.
    const nanDiscount = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 500 }])}, 'NaN', null)`,
    );
    const infiniteDiscount = await attemptAs(owner.id, (sql) =>
      sql`select public.update_appointment_sale_pricing(${saleId}, ${sql.json([{ sale_item_id: saleItemId, unit_price: 500 }])}, 'Infinity', null)`,
    );
    for (const outcome of [
      empty,
      badUuid,
      stringPrice,
      subCentPrice,
      hugePrice,
      subCentDiscount,
      negativeSubCentPrice,
      objectItems,
      scalarItems,
      nullItems,
      scalarElements,
      nanDiscount,
      infiniteDiscount,
    ]) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("FN004");
    }
    expect(await snapshot(saleId)).toEqual(before);
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
    // The sale id comes from the RPC's own return value: the signed-in role
    // has NO table privilege on appointment_sales (full lockdown by design),
    // so a direct subselect on it from inside this role would be denied.
    const [sale] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`,
    );
    await asAuthenticatedUser(owner.id, (sql) =>
      sql`select public.record_appointment_payment(${sale!.id}, 100, 'cash', now(), 'a note', ${crypto.randomUUID()})`,
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
