import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAuthenticatedUser,
  asDatabaseRole,
  attemptAs,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createCustomRole,
  createService,
  createStaffMember,
  createStaffSchedule,
  addMembership,
  createTestMembershipFromTemplate,
  createTestTenant,
  createTestUser,
  safeMorningStart,
  testDb,
  type TestUser,
} from "./helpers";

/**
 * Faz FIN.2A — the daily Owner overview (20261025090000), end to end against real FIN.1A / FIN.1B.1 data created
 * through the real RPCs. Every expected number below is calculated by hand in the comments, not read back from the
 * function. Appointments are created through the real create_appointment and then moved onto the test day with a
 * privileged UPDATE (the RPC only books the future); payments and expense payments for the boundary tests are
 * inserted directly with exact instants.
 */

const TZ = "Europe/Nicosia";
const DAY = "2026-10-10"; // EEST (UTC+3): the local day is [2026-10-09T21:00Z, 2026-10-10T21:00Z)
const PREV = "2026-10-09";

type Overview = {
  date: string;
  timezone: string;
  currency: string;
  currencyMixed: boolean;
  scope: string;
  appointments: { total: number; scheduled: number; confirmed: number; inProgress: number; completed: number; cancelled: number; noShow: number };
  services: { completedAmount: number; completedWithCheckout: number; completedWithoutCheckout: number; withoutCheckoutAmount: number; discountTotal: number };
  payments: { totalCollected: number; count: number; cash: number; card: number; bankTransfer: number; other: number; voidedCount: number; voidedAmount: number };
  outstanding: { supported: boolean; amount: number; count: number; todayAmount: number };
  expenses: { accruedTotal: number; accruedCount: number; paidOutTotal: number; paidOutCount: number; paidOutCash: number; paidOutCard: number; paidOutBankTransfer: number; paidOutOther: number };
  cash: { supported: boolean; cashCollected: number; cashPaidOut: number; difference: number };
  staff: { displayName: string; completedAppointments: number; completedItems: number; serviceAmount: number }[];
  staffServiceAmountTotal: number;
  unsupported: string[];
};

let owner: TestUser;
let manager: TestUser;
let receptionist: TestUser;
let stylist: TestUser;
let otherOwner: TestUser;
let customRoleUser: TestUser;
let tenant: { id: string; slug: string };
let other: { id: string; slug: string };
let branchId: string;
let otherBranchId: string;
const tenants: string[] = [];
const users: TestUser[] = [];

async function user(label: string): Promise<TestUser> {
  const u = await createTestUser(`f2a-${label}`);
  users.push(u);
  return u;
}

async function overview(t: { id: string }, userId: string, date: string | null = DAY): Promise<Overview> {
  const [row] = await asAuthenticatedUser(userId, (sql) => sql<{ o: Overview }[]>`select public.get_daily_owner_overview(${t.id}, ${date}) as o`);
  return row!.o;
}

/** the instant of a tenant-local wall-clock time */
async function at(day: string, time: string, tz = TZ): Promise<string> {
  const [row] = await testDb<{ ts: string }[]>`select (((${day}::date + ${time}::time) at time zone ${tz}) at time zone 'UTC')::text || '+00' as ts`;
  return row!.ts;
}

type Fx = { tenant: { id: string }; ownerId: string; branchId: string; ayse: string; mehmet: string; cut: string; color: string; nails: string };

async function fixture(t: { id: string }, ownerId: string, bId: string): Promise<Fx> {
  const ayse = await createStaffMember(t.id, "Ayşe Demir");
  const mehmet = await createStaffMember(t.id, "Mehmet Kaya");
  const cut = await createService(t.id, "Saç Kesimi", 30, 500);
  const color = await createService(t.id, "Boya", 30, 1500);
  const nails = await createService(t.id, "Manikür", 30, 600);
  for (const s of [ayse, mehmet]) {
    await testDb`insert into staff_branches (staff_member_id, branch_id) values (${s.id}, ${bId})`;
    for (const sv of [cut, color, nails]) await testDb`insert into staff_services (staff_member_id, service_id) values (${s.id}, ${sv.id})`;
    for (let w = 0; w <= 6; w++) await createStaffSchedule(t.id, s.id, w, "00:00", "23:59");
  }
  for (const sv of [cut, color, nails]) await testDb`insert into service_branches (service_id, branch_id) values (${sv.id}, ${bId})`;
  return { tenant: t, ownerId, branchId: bId, ayse: ayse.id, mehmet: mehmet.id, cut: cut.id, color: color.id, nails: nails.id };
}

let apptCounter = 0;
/** create via the real RPC, then move onto the wanted local time of `day` */
async function appt(
  fx: Fx,
  day: string,
  time: string,
  items: { staff: string; service: string }[],
  final: "scheduled" | "confirmed" | "completed" | "cancelled" | "no_show" = "completed",
  override?: { itemIndex: number; actual: string },
): Promise<{ id: string; itemIds: string[] }> {
  apptCounter += 1;
  const [customer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${fx.tenant.id}, 'Musteri') returning id`;
  const start = safeMorningStart(3 + apptCounter);
  const { rows } = { rows: await asAuthenticatedUser(fx.ownerId, (sql) =>
    sql<{ id: string }[]>`select public.create_appointment(${fx.tenant.id}, ${fx.branchId}, ${customer!.id}, ${sql.json(
      items.map((it, i) => ({ service_id: it.service, staff_member_id: it.staff, scheduled_start_at: start.toISOString(), sequence: i + 1 })) as never,
    )}) as id`,
  ) };
  const id = rows[0]!.id;
  const startTs = await at(day, time);
  await testDb`update appointment_items set scheduled_start_at = ${startTs}::text::timestamptz, scheduled_end_at = ${startTs}::text::timestamptz + interval '30 minutes' where appointment_id = ${id}`;
  await testDb`update appointments set scheduled_start_at = ${startTs}::text::timestamptz, scheduled_end_at = ${startTs}::text::timestamptz + interval '30 minutes' where id = ${id}`;
  const itemIds = (await testDb<{ id: string }[]>`select id from appointment_items where appointment_id = ${id} order by sequence`).map((r) => r.id);
  if (final === "completed") {
    const overrides = override ? [{ appointment_item_id: itemIds[override.itemIndex], actual_staff_member_id: override.actual }] : [];
    await asAuthenticatedUser(fx.ownerId, (sql) => sql`select public.complete_appointment(${id}, ${sql.json(overrides as never)})`);
  } else if (final !== "scheduled") {
    await asAuthenticatedUser(fx.ownerId, (sql) => sql`select public.update_appointment_status(${id}, ${final})`);
  }
  return { id, itemIds };
}

/** optional sale-level discount and an edited unit price for the FIRST item */
async function sale(fx: Fx, appointmentId: string, discount = 0, unit?: number): Promise<string> {
  const [s] = await asAuthenticatedUser(fx.ownerId, (sql) => sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`);
  if (discount > 0 || unit !== undefined) {
    const items = await testDb<{ id: string; unit_price: string }[]>`select id, unit_price::text from appointment_sale_items where sale_id = ${s!.id} order by id`;
    const priced = items.map((i, k) => ({ sale_item_id: i.id, unit_price: k === 0 && unit !== undefined ? unit : Number(i.unit_price) }));
    await asAuthenticatedUser(fx.ownerId, (sql) =>
      sql`select * from public.update_appointment_sale_pricing(${s!.id}, ${sql.json(priced as never)}, ${discount}, 'test')`,
    );
  }
  return s!.id;
}

async function pay(fx: Fx, saleId: string, amount: number, method: "cash" | "card" | "bank_transfer" | "other", paidAtIso: string): Promise<string> {
  const [p] = await asAuthenticatedUser(fx.ownerId, (sql) =>
    sql<{ id: string }[]>`select * from public.record_appointment_payment(${saleId}, ${amount}, ${method}, ${paidAtIso}::text::timestamptz, null, ${crypto.randomUUID()})`,
  );
  return p!.id;
}

async function expense(fx: Fx, day: string, category: string, amount: number): Promise<string> {
  const [e] = await asAuthenticatedUser(fx.ownerId, (sql) =>
    sql<{ r: { expenseId: string } }[]>`select (public.create_expense(${fx.tenant.id}, ${category}, ${"Gider " + category}, ${day}::date, ${amount}, ${crypto.randomUUID()})) as r`,
  );
  return e!.r.expenseId;
}

async function payExpense(fx: Fx, expenseId: string, amount: number, method: "cash" | "card" | "bank_transfer" | "other", paidAtIso: string): Promise<string> {
  const [r] = await asAuthenticatedUser(fx.ownerId, (sql) =>
    sql<{ r: { paymentId: string } }[]>`select (public.record_expense_payment(${expenseId}, ${amount}, ${method}, ${paidAtIso}::text::timestamptz, null, ${crypto.randomUUID()})) as r`,
  );
  return r!.r.paymentId;
}

let fx: Fx;
let otherFx: Fx;

beforeAll(async () => {
  owner = await user("owner");
  manager = await user("manager");
  receptionist = await user("recep");
  stylist = await user("stylist");
  otherOwner = await user("other-owner");
  customRoleUser = await user("custom");
  const t = await createTestTenant(`f2a-main-${Math.random().toString(36).slice(2, 8)}`, owner.id);
  tenant = { id: t.id, slug: t.slug };
  tenants.push(t.id);
  await testDb`update tenants set timezone = ${TZ}, currency = 'TRY' where id = ${t.id}`;
  branchId = await createBranch(t.id, "Merkez");
  await createTestMembershipFromTemplate(t.id, manager.id, "SALON_MANAGER");
  await createTestMembershipFromTemplate(t.id, receptionist.id, "RECEPTIONIST");
  await createTestMembershipFromTemplate(t.id, stylist.id, "STYLIST");
  await addMembership(t.id, customRoleUser.id, await createCustomRole(t.id, "Finans Goruntuleyen", ["finance.view"]));
  const o = await createTestTenant(`f2a-other-${Math.random().toString(36).slice(2, 8)}`, otherOwner.id);
  other = { id: o.id, slug: o.slug };
  tenants.push(o.id);
  await testDb`update tenants set timezone = ${TZ}, currency = 'TRY' where id = ${o.id}`;
  otherBranchId = await createBranch(o.id, "Diger");
  fx = await fixture(tenant, owner.id, branchId);
  otherFx = await fixture(other, otherOwner.id, otherBranchId);
}, 180_000);

afterAll(async () => {
  await cleanupTenants(tenants);
  await cleanupUsers(users.map((u) => u.id));
}, 180_000);

describe("one realistic synthetic salon day, calculated by hand", () => {
  let result: Overview;

  beforeAll(async () => {
    // --- the day D (all times tenant-local) ---
    // A1 10:00 Ayse Cut 500, checkout 500, paid CASH 500 at 10:30
    const a1 = await appt(fx, DAY, "10:00", [{ staff: fx.ayse, service: fx.cut }]);
    const s1 = await sale(fx, a1.id);
    await pay(fx, s1, 500, "cash", await at(DAY, "10:30"));
    // A2 11:00 booked Mehmet / performed by Ayse (completion override) Color 1500, paid CARD 1500
    const a2 = await appt(fx, DAY, "11:00", [{ staff: fx.mehmet, service: fx.color }], "completed", { itemIndex: 0, actual: fx.ayse });
    const s2 = await sale(fx, a2.id);
    await pay(fx, s2, 1500, "card", await at(DAY, "11:40"));
    // A3 12:00 Ayse Cut 500 + Mehmet Nails 600 = 1100, discount 100 -> total 1000, SPLIT cash 600 + card 400
    const a3 = await appt(fx, DAY, "12:00", [{ staff: fx.ayse, service: fx.cut }, { staff: fx.mehmet, service: fx.nails }]);
    const s3 = await sale(fx, a3.id, 100);
    await pay(fx, s3, 600, "cash", await at(DAY, "12:40"));
    await pay(fx, s3, 400, "card", await at(DAY, "12:41"));
    // A4 13:00 Ayse Color 1500, PARTIAL: cash 500 + transfer 200 = 700 -> outstanding 800; plus a payment of 50 that is voided
    const a4 = await appt(fx, DAY, "13:00", [{ staff: fx.ayse, service: fx.color }]);
    const s4 = await sale(fx, a4.id);
    await pay(fx, s4, 500, "cash", await at(DAY, "13:30"));
    await pay(fx, s4, 200, "bank_transfer", await at(DAY, "13:31"));
    const voided = await pay(fx, s4, 50, "other", await at(DAY, "13:32"));
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.void_appointment_payment(${voided}, 'yanlis giris')`);
    // the void really happened "now"; for a deterministic past day it is dated inside the day
    await testDb`update payments set voided_at = ${await at(DAY, "14:00")}::text::timestamptz where id = ${voided}`;
    // A5 14:00 Mehmet Cut 500, completed, NO checkout
    await appt(fx, DAY, "14:00", [{ staff: fx.mehmet, service: fx.cut }]);
    // A6 confirmed (not done), A7 cancelled, A8 no-show, A9 scheduled
    await appt(fx, DAY, "18:00", [{ staff: fx.mehmet, service: fx.cut }], "confirmed");
    await appt(fx, DAY, "15:00", [{ staff: fx.ayse, service: fx.cut }], "cancelled");
    await appt(fx, DAY, "16:00", [{ staff: fx.mehmet, service: fx.nails }], "no_show");
    await appt(fx, DAY, "19:00", [{ staff: fx.ayse, service: fx.cut }], "scheduled");
    // --- the day before: a fully paid sale (cash on the day before), a sale paid TODAY (cash 400), an unpaid one (300 left) ---
    const p1 = await appt(fx, PREV, "10:00", [{ staff: fx.ayse, service: fx.color }]);
    const sp1 = await sale(fx, p1.id, 700); // total 800
    await pay(fx, sp1, 800, "cash", await at(PREV, "10:30"));
    const p2 = await appt(fx, PREV, "11:00", [{ staff: fx.mehmet, service: fx.cut }]);
    const sp2 = await sale(fx, p2.id, 100); // total 400
    await pay(fx, sp2, 400, "cash", await at(DAY, "09:00")); // received TODAY for yesterday's work
    const p3 = await appt(fx, PREV, "12:00", [{ staff: fx.mehmet, service: fx.nails }]);
    await sale(fx, p3.id, 150, 450); // unit price edited 600 -> 450, discount 150: total 300, nothing paid
    const p4 = await appt(fx, PREV, "13:00", [{ staff: fx.ayse, service: fx.cut }, { staff: fx.mehmet, service: fx.nails }]);
    // both items by the SAME person, back to back (the RPC cannot book one person twice at one instant)
    await testDb`update appointment_items set staff_member_id = ${fx.ayse}, actual_staff_member_id = ${fx.ayse},
                 scheduled_start_at = scheduled_start_at + interval '30 minutes', scheduled_end_at = scheduled_end_at + interval '30 minutes'
                 where id = ${p4.itemIds[1]!}`;
    const sp4 = await sale(fx, p4.id); // 500 + 600 = 1100, two items by the same person
    await pay(fx, sp4, 1100, "cash", await at(PREV, "13:30"));
    // --- expenses ---
    const e1 = await expense(fx, DAY, "rent", 3000);
    await payExpense(fx, e1, 1000, "cash", await at(DAY, "09:30"));
    const e2 = await expense(fx, DAY, "supplies", 450);
    await payExpense(fx, e2, 450, "card", await at(DAY, "15:00"));
    const e3 = await expense(fx, DAY, "cleaning", 200);
    const e3p = await payExpense(fx, e3, 80, "cash", await at(DAY, "16:00"));
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.void_expense_payment(${e3p}, 'yanlis')`); // voided: never paid out
    const e4 = await expense(fx, PREV, "supplies", 500);
    await payExpense(fx, e4, 500, "cash", await at(DAY, "17:00")); // yesterday's obligation paid today
    const e5 = await expense(fx, DAY, "rent", 9999);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.cancel_expense(${e5}, 'iptal')`);
    // --- another salon, same day, with plenty of money: must contribute nothing ---
    const x = await appt(otherFx, DAY, "10:00", [{ staff: otherFx.ayse, service: otherFx.color }]);
    const sx = await sale(otherFx, x.id);
    await pay(otherFx, sx, 1500, "cash", await at(DAY, "10:30"));
    const x2 = await appt(otherFx, DAY, "11:00", [{ staff: otherFx.mehmet, service: otherFx.cut }]);
    await sale(otherFx, x2.id); // 500 completed, unpaid
    await expense(otherFx, DAY, "rent", 7777);
    result = await overview(tenant, owner.id);
  }, 240_000);

  it("appointments by canonical status: 9 on the day, 5 completed, 1 confirmed, 1 scheduled, 1 cancelled, 1 no-show", () => {
    expect(result.appointments).toEqual({ total: 9, scheduled: 1, confirmed: 1, inProgress: 0, completed: 5, cancelled: 1, noShow: 1 });
  });

  it("completed work value: 500 + 1500 + (1100-100) + 1500 + 500 (no checkout, list price) = 5000", () => {
    expect(result.services).toEqual({ completedAmount: 5000, completedWithCheckout: 4, completedWithoutCheckout: 1, withoutCheckoutAmount: 500, discountTotal: 100 });
  });

  it("money received today by method: cash 500+600+500+400(old work) = 2000, card 1500+400 = 1900, transfer 200, other 0 (the voided 50 never counts) = 4100", () => {
    expect(result.payments).toMatchObject({ totalCollected: 4100, count: 7, cash: 2000, card: 1900, bankTransfer: 200, other: 0, voidedCount: 1, voidedAmount: 50 });
  });

  it("outstanding comes from checkouts only: A4 1500-700 = 800 (today), yesterday's unpaid 300 -> 1100 in 2 checkouts; the no-checkout A5 is not guessed", () => {
    expect(result.outstanding).toEqual({ supported: true, amount: 1100, count: 2, todayAmount: 800 });
  });

  it("expenses: obligations dated today 3000+450+200 = 3650 (cancelled 9999 and yesterday's 500 excluded); paid out today cash 1000+500, card 450", () => {
    expect(result.expenses).toEqual({
      accruedTotal: 3650, accruedCount: 3, paidOutTotal: 1950, paidOutCount: 3, paidOutCash: 1500, paidOutCard: 450, paidOutBankTransfer: 0, paidOutOther: 0,
    });
  });

  it("daily cash difference = cash received 2000 - cash paid out 1500 = 500 (card/transfer never enter it)", () => {
    expect(result.cash).toEqual({ supported: true, cashCollected: 2000, cashPaidOut: 1500, difference: 500 });
  });

  it("staff by ITEM with the ACTUAL performer: Ayse 500+1500(override)+500+1500 = 4000 in 4 visits, Mehmet 600+500 = 1100 in 2; the discount is not split", () => {
    expect(result.staff).toEqual([
      { displayName: "Ayşe Demir", completedAppointments: 4, completedItems: 4, serviceAmount: 4000 },
      { displayName: "Mehmet Kaya", completedAppointments: 2, completedItems: 2, serviceAmount: 1100 },
    ]);
    expect(result.staffServiceAmountTotal).toBe(5100);
    // 5100 before discount - 100 discount = 5000 = completedAmount
    expect(result.staffServiceAmountTotal - result.services.discountTotal).toBe(result.services.completedAmount);
  });

  it("shape: tenant scope, local date, timezone, currency, honestly unsupported items, and no identifiers or personal data", () => {
    expect(result).toMatchObject({ date: DAY, timezone: TZ, currency: "TRY", currencyMixed: false, scope: "tenant" });
    expect(result.unsupported).toEqual(["refunds", "personnelPayments", "profit"]);
    const text = JSON.stringify(result);
    for (const secret of [owner.id, manager.id, tenant.id, branchId, fx.ayse, fx.mehmet, "Musteri"]) expect(text).not.toContain(secret);
    expect(Object.keys(result).sort()).toEqual(
      ["appointments", "cash", "currency", "currencyMixed", "date", "expenses", "outstanding", "payments", "scope", "services", "staff", "staffServiceAmountTotal", "timezone", "unsupported"].sort(),
    );
  });

  it("the other salon's identical-day money never leaks in, in either direction", async () => {
    const mine = await overview(tenant, owner.id);
    expect(mine.payments.totalCollected).toBe(4100);
    expect(mine.expenses.accruedTotal).toBe(3650);
    const theirs = await overview(other, otherOwner.id);
    expect(theirs.payments.totalCollected).toBe(1500);
    expect(theirs.expenses.accruedTotal).toBe(7777);
    expect(theirs.services.completedAmount).toBe(2000);
    expect(theirs.appointments.total).toBe(2);
    expect(theirs.outstanding).toMatchObject({ amount: 500, count: 1, todayAmount: 500 });
    expect(theirs.staff.map((s) => s.displayName)).toEqual(["Ayşe Demir", "Mehmet Kaya"]);
  });

  it("another day shows none of it (the day before has its own completed work and the 800 cash)", async () => {
    const prev = await overview(tenant, owner.id, PREV);
    expect(prev.appointments).toMatchObject({ total: 4, completed: 4 });
    expect(prev.services).toMatchObject({ completedAmount: 800 + 400 + 300 + 1100, discountTotal: 700 + 100 + 150 });
    expect(prev.payments).toMatchObject({ totalCollected: 800 + 1100, cash: 800 + 1100 });
    // item-level attribution: Mehmet's manicure was charged 450 (edited), not the 600 list price; one appointment with two
    // items by the same person counts as ONE visit with two items
    expect(prev.staff).toEqual([
      { displayName: "Ayşe Demir", completedAppointments: 2, completedItems: 3, serviceAmount: 1500 + 500 + 600 },
      { displayName: "Mehmet Kaya", completedAppointments: 2, completedItems: 2, serviceAmount: 500 + 450 },
    ]);
    expect(prev.staffServiceAmountTotal - prev.services.discountTotal).toBe(prev.services.completedAmount);
    const empty = await overview(tenant, owner.id, "2026-10-11");
    expect(empty.appointments.total).toBe(0);
    expect(empty.payments.totalCollected).toBe(0);
    expect(empty.cash.difference).toBe(0);
    expect(empty.staff).toEqual([]);
  });
});

describe("tenant-local day boundaries", () => {
  let tzTenant: { id: string };
  let tzOwner: TestUser;
  let tzFx: Fx;
  let tzSale: string;

  async function setTz(tz: string) {
    await testDb`update tenants set timezone = ${tz} where id = ${tzTenant.id}`;
  }
  async function insertPayment(iso: string, amount = 1, method = "cash") {
    await testDb`insert into payments (tenant_id, branch_id, appointment_sale_id, amount, method, paid_at, idempotency_key)
                 values (${tzTenant.id}, ${tzFx.branchId}, ${tzSale}, ${amount}, ${method}, ${iso}::text::timestamptz, ${crypto.randomUUID()})`;
  }
  async function insertExpensePayment(expenseId: string, iso: string, amount = 1, method = "cash") {
    await testDb`insert into expense_payments (tenant_id, expense_id, amount, method, paid_at, idempotency_key)
                 values (${tzTenant.id}, ${expenseId}, ${amount}, ${method}, ${iso}::text::timestamptz, ${crypto.randomUUID()})`;
  }
  async function insertAppointmentAt(iso: string) {
    const a = await appt(tzFx, "2026-10-10", "09:00", [{ staff: tzFx.ayse, service: tzFx.cut }], "completed");
    await testDb`update appointment_items set scheduled_start_at = ${iso}::text::timestamptz, scheduled_end_at = ${iso}::text::timestamptz + interval '30 minutes' where appointment_id = ${a.id}`;
    await testDb`update appointments set scheduled_start_at = ${iso}::text::timestamptz, scheduled_end_at = ${iso}::text::timestamptz + interval '30 minutes' where id = ${a.id}`;
    return a.id;
  }
  const collected = async (day: string) => (await overview(tzTenant, tzOwner.id, day)).payments.totalCollected;

  beforeAll(async () => {
    tzOwner = await user("tz-owner");
    const t = await createTestTenant(`f2a-tz-${Math.random().toString(36).slice(2, 8)}`, tzOwner.id);
    tzTenant = { id: t.id };
    tenants.push(t.id);
    const b = await createBranch(t.id, "TZ");
    tzFx = await fixture(tzTenant, tzOwner.id, b);
    await setTz(TZ);
    const a = await appt(tzFx, "2026-10-10", "09:00", [{ staff: tzFx.ayse, service: tzFx.color }]);
    tzSale = await sale(tzFx, a.id); // total 1500, room for ~1400 one-lira payments
  }, 120_000);

  it("PREVIOUS UTC DAY / CURRENT SALON DAY: 23:30Z on the 9th is 02:30 on the 10th in Nicosia and belongs to the 10th", async () => {
    await insertPayment("2026-11-09T23:30:00+00", 7);
    expect(await collected("2026-11-10")).toBe(7);
    expect(await collected("2026-11-09")).toBe(0);
  });

  it("MIDNIGHT: the local day is half-open [00:00, next 00:00) in the tenant zone (EET, UTC+2 in November)", async () => {
    await insertPayment("2026-11-14T21:59:59+00", 1); // local 23:59:59 on the 14th
    await insertPayment("2026-11-14T22:00:00+00", 10); // local 00:00:00 on the 15th
    await insertPayment("2026-11-15T21:59:59+00", 100); // local 23:59:59 on the 15th
    await insertPayment("2026-11-15T22:00:00+00", 1000); // local 00:00:00 on the 16th
    expect(await collected("2026-11-14")).toBe(1);
    expect(await collected("2026-11-15")).toBe(110);
    expect(await collected("2026-11-16")).toBe(1000);
  });

  it("DST fall-back (25-hour local day, 2026-10-25): [2026-10-24T21:00Z, 2026-10-25T22:00Z)", async () => {
    await insertPayment("2026-10-24T20:59:59+00", 1);
    await insertPayment("2026-10-24T21:00:00+00", 10);
    await insertPayment("2026-10-25T00:30:00+00", 100); // 03:30 EEST->... still the 25th
    await insertPayment("2026-10-25T21:59:59+00", 1000); // 23:59:59 EET
    await insertPayment("2026-10-25T22:00:00+00", 5); // 00:00 on the 26th
    expect(await collected("2026-10-25")).toBe(1110);
    expect(await collected("2026-10-24")).toBe(1);
    expect(await collected("2026-10-26")).toBe(5);
  });

  it("DST spring-forward (23-hour local day, 2027-03-28): [2027-03-27T22:00Z, 2027-03-28T21:00Z)", async () => {
    await insertPayment("2027-03-27T21:59:59+00", 1);
    await insertPayment("2027-03-27T22:00:00+00", 10);
    await insertPayment("2027-03-28T20:59:59+00", 100); // 23:59:59 EEST
    await insertPayment("2027-03-28T21:00:00+00", 5); // 00:00 on the 29th
    expect(await collected("2027-03-28")).toBe(110);
    expect(await collected("2027-03-29")).toBe(5);
  });

  it("the zone is the TENANT's: the same instants fall on a different day for a UTC+3 salon (Istanbul)", async () => {
    await setTz("Europe/Istanbul");
    try {
      // 2026-11-09T21:00Z..2026-11-10T21:00Z is the Istanbul 10th; 23:30Z on the 9th is 02:30 on the 10th there too
      await insertPayment("2026-12-09T21:00:00+00", 3);
      await insertPayment("2026-12-09T20:59:59+00", 30);
      expect(await collected("2026-12-10")).toBe(3);
      expect(await collected("2026-12-09")).toBe(30);
    } finally {
      await setTz(TZ);
    }
  });

  it("appointments and expense payments use the same boundaries; expense_date is a plain local date", async () => {
    await insertAppointmentAt("2027-01-12T21:59:59+00"); // local 23:59:59 on the 12th (EET)
    await insertAppointmentAt("2027-01-12T22:00:00+00"); // local 00:00 on the 13th
    const jan12 = await overview(tzTenant, tzOwner.id, "2027-01-12");
    const jan13 = await overview(tzTenant, tzOwner.id, "2027-01-13");
    expect(jan12.appointments.completed).toBe(1);
    expect(jan13.appointments.completed).toBe(1);
    const [e] = await testDb<{ id: string }[]>`
      insert into expenses (tenant_id, category_key, description, expense_date, amount, currency)
      values (${tzTenant.id}, 'rent', 'x', '2027-01-12', 50, 'TRY') returning id`;
    await insertExpensePayment(e!.id, "2027-01-12T21:59:59+00", 20);
    await insertExpensePayment(e!.id, "2027-01-12T22:00:00+00", 30);
    expect((await overview(tzTenant, tzOwner.id, "2027-01-12")).expenses).toMatchObject({ accruedTotal: 50, accruedCount: 1, paidOutTotal: 20, paidOutCash: 20 });
    expect((await overview(tzTenant, tzOwner.id, "2027-01-13")).expenses).toMatchObject({ accruedTotal: 0, paidOutTotal: 30 });
  });

  it("with no date given the day is the tenant's local today, never the server's UTC date (checked in three zones so the UTC date differs from the local one at any hour)", async () => {
    try {
      for (const zone of [TZ, "Pacific/Kiritimati", "Etc/GMT+12"]) {
        await setTz(zone);
        const [{ today }] = await testDb<{ today: string }[]>`select (now() at time zone ${zone})::date::text as today`;
        expect((await overview(tzTenant, tzOwner.id, null)).date, zone).toBe(today);
      }
    } finally {
      await setTz(TZ);
    }
  });
});

describe("invariants", () => {
  it("a cancelled appointment contributes no completed value; an unfinished one neither; an unpaid completed one adds value but no collection", async () => {
    const o = await overview(tenant, owner.id);
    expect(o.appointments.cancelled).toBe(1);
    expect(o.services.completedAmount).toBe(5000); // none of 500 cancelled / 600 no-show / 500 confirmed / 500 scheduled
  });

  it("a completed appointment without a checkout carries value but is never reported as outstanding", async () => {
    const o = await overview(tenant, owner.id);
    expect(o.services.withoutCheckoutAmount).toBe(500);
    expect(o.outstanding.amount).toBe(1100);
  });

  it("each payment and each expense counts exactly once however many appointments / expenses surround it", async () => {
    const o = await overview(tenant, owner.id);
    const [direct] = await testDb<{ n: string; s: string }[]>`
      select count(*)::text as n, coalesce(sum(amount),0)::text as s from payments
      where tenant_id = ${tenant.id} and status = 'posted' and paid_at >= ${await at(DAY, "00:00")}::text::timestamptz and paid_at < ${await at("2026-10-11", "00:00")}::text::timestamptz`;
    expect(Number(direct!.s)).toBe(o.payments.totalCollected);
    expect(Number(direct!.n)).toBe(o.payments.count);
  });

  it("a multi-person appointment is split by item: neither person gets the whole 1100", async () => {
    const o = await overview(tenant, owner.id);
    const ayse = o.staff.find((s) => s.displayName === "Ayşe Demir")!;
    const mehmet = o.staff.find((s) => s.displayName === "Mehmet Kaya")!;
    expect(ayse.serviceAmount + mehmet.serviceAmount).toBe(o.staffServiceAmountTotal);
    expect(mehmet.serviceAmount).toBe(600 + 500); // his nails + his cut; not the 1100 appointment
  });

  it("voiding a payment moves it out of the collection (the model has void, not refund)", async () => {
    const before = await overview(tenant, owner.id);
    const [s4] = await testDb<{ id: string }[]>`select s.id from appointment_sales s join appointments a on a.id = s.appointment_id where a.tenant_id = ${tenant.id} and s.total_amount = 1500 and a.scheduled_start_at >= ${await at(DAY, "13:00")}::text::timestamptz and a.scheduled_start_at < ${await at(DAY, "14:00")}::text::timestamptz`;
    const id = await pay(fx, s4!.id, 25, "other", await at(DAY, "20:00"));
    const during = await overview(tenant, owner.id);
    expect(during.payments.totalCollected).toBe(before.payments.totalCollected + 25);
    expect(during.outstanding.amount).toBe(before.outstanding.amount - 25);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.void_appointment_payment(${id}, 'geri')`);
    const after = await overview(tenant, owner.id);
    expect(after.payments.totalCollected).toBe(before.payments.totalCollected);
    expect(after.outstanding.amount).toBe(before.outstanding.amount);
    // the void happened today (real now), not on the test day: the test day's voided list is unchanged ...
    expect(after.payments.voidedCount).toBe(before.payments.voidedCount);
    // ... until its void is dated inside the day
    await testDb`update payments set voided_at = ${await at(DAY, "14:30")}::text::timestamptz where id = ${id}`;
    const dated = await overview(tenant, owner.id);
    expect(dated.payments.voidedCount).toBe(before.payments.voidedCount + 1);
    expect(dated.payments.voidedAmount).toBe(before.payments.voidedAmount + 25);
    expect(dated.payments.totalCollected).toBe(before.payments.totalCollected);
  });

  it("a payment received yesterday but cancelled today is listed as cancelled TODAY (by when it was voided), never as collected on either day", async () => {
    const [s4] = await testDb<{ id: string }[]>`select s.id from appointment_sales s join appointments a on a.id = s.appointment_id where a.tenant_id = ${tenant.id} and s.total_amount = 1500 and a.scheduled_start_at >= ${await at(DAY, "13:00")}::text::timestamptz and a.scheduled_start_at < ${await at(DAY, "14:00")}::text::timestamptz`;
    const before = await overview(tenant, owner.id);
    const beforePrev = await overview(tenant, owner.id, PREV);
    const id = await pay(fx, s4!.id, 11, "other", await at(PREV, "12:00"));
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.void_appointment_payment(${id}, 'geri')`);
    await testDb`update payments set voided_at = ${await at(DAY, "15:00")}::text::timestamptz where id = ${id}`;
    const after = await overview(tenant, owner.id);
    expect(after.payments.voidedCount).toBe(before.payments.voidedCount + 1);
    expect(after.payments.voidedAmount).toBe(before.payments.voidedAmount + 11);
    expect((await overview(tenant, owner.id, PREV)).payments).toEqual(beforePrev.payments);
  });

  it("a voided checkout (a reserved state) is neither a checkout nor an outstanding balance", async () => {
    const before = await overview(other, otherOwner.id);
    expect(before.outstanding.amount).toBe(500);
    await testDb`update appointment_sales set status = 'voided' where tenant_id = ${other.id} and total_amount = 500`;
    try {
      const during = await overview(other, otherOwner.id);
      expect(during.outstanding).toMatchObject({ amount: 0, count: 0, todayAmount: 0 });
      expect(during.services.completedWithoutCheckout).toBe(before.services.completedWithoutCheckout + 1);
      expect(during.services.completedAmount).toBe(before.services.completedAmount);
    } finally {
      await testDb`update appointment_sales set status = 'open' where tenant_id = ${other.id} and total_amount = 500 and status = 'voided'`;
    }
  });

  it("a sale in another currency than the tenant's is flagged, not silently mixed", async () => {
    const o = await overview(other, otherOwner.id);
    expect(o.currencyMixed).toBe(false);
    await testDb`update appointment_sales set currency = 'EUR' where tenant_id = ${other.id}`;
    try {
      expect((await overview(other, otherOwner.id)).currencyMixed).toBe(true);
    } finally {
      await testDb`update appointment_sales set currency = 'TRY' where tenant_id = ${other.id}`;
    }
  });
});

describe("authorization", () => {
  it("the Owner may read; a custom role holding finance.view may read (the permission, not the role name, decides)", async () => {
    expect((await overview(tenant, owner.id)).scope).toBe("tenant");
    expect((await overview(tenant, customRoleUser.id)).scope).toBe("tenant");
  });

  it("Yönetici, Resepsiyon and Personel hold no finance.view by default and are refused (FN002)", async () => {
    for (const u of [manager, receptionist, stylist]) {
      expect(await attemptAs(u.id, (sql) => sql`select public.get_daily_owner_overview(${tenant.id}, ${DAY}::date)`), u.email).toMatchObject({ ok: false, code: "FN002" });
    }
  });

  it("another salon's Owner is refused on this salon and the answer says nothing about it; so is a non-existent salon", async () => {
    expect(await attemptAs(otherOwner.id, (sql) => sql`select public.get_daily_owner_overview(${tenant.id}, ${DAY}::date)`)).toMatchObject({ ok: false, code: "FN002" });
    expect(await attemptAs(owner.id, (sql) => sql`select public.get_daily_owner_overview('00000000-0000-4000-8000-000000000000'::uuid, ${DAY}::date)`)).toMatchObject({ ok: false, code: "FN002" });
  });

  it("no session is FN001; anon and service_role cannot execute; the private function is executable by no API role", async () => {
    await expect(asDatabaseRole("authenticated", null, (sql) => sql`select public.get_daily_owner_overview(${tenant.id}, ${DAY}::date)`)).rejects.toMatchObject({ code: "FN001" });
    for (const role of ["anon", "service_role"] as const) {
      await expect(asDatabaseRole(role, null, (sql) => sql`select public.get_daily_owner_overview(${tenant.id}, ${DAY}::date)`)).rejects.toMatchObject({ code: "42501" });
    }
    const [row] = await testDb<{ a: boolean; b: boolean; c: boolean }[]>`
      select has_function_privilege('authenticated', 'private.daily_owner_overview(uuid, date)', 'execute') as a,
             has_function_privilege('anon', 'private.daily_owner_overview(uuid, date)', 'execute') as b,
             has_function_privilege('service_role', 'private.daily_owner_overview(uuid, date)', 'execute') as c`;
    expect(row).toEqual({ a: false, b: false, c: false });
  });

  it("an absurd date is refused, and the read writes nothing (row counts and audit unchanged)", async () => {
    expect(await attemptAs(owner.id, (sql) => sql`select public.get_daily_owner_overview(${tenant.id}, '1999-01-01'::date)`)).toMatchObject({ ok: false, code: "FN004" });
    expect(await attemptAs(owner.id, (sql) => sql`select public.get_daily_owner_overview(${tenant.id}, '2101-01-01'::date)`)).toMatchObject({ ok: false, code: "FN004" });
    const snap = async () => ({
      payments: await testDb`select count(*)::int as n from payments where tenant_id = ${tenant.id}`,
      expenses: await testDb`select count(*)::int as n from expenses where tenant_id = ${tenant.id}`,
      sales: await testDb`select count(*)::int as n from appointment_sales where tenant_id = ${tenant.id}`,
      audit: await testDb`select count(*)::int as n from audit_logs where tenant_id = ${tenant.id}`,
    });
    const before = await snap();
    await overview(tenant, owner.id);
    expect(await snap()).toEqual(before);
  });
});
