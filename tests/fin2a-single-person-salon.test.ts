import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAuthenticatedUser,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  safeMorningStart,
  testDb,
  type TestUser,
} from "./helpers";

/**
 * Faz FIN.2A — single-person salon validation, modelled on the Emel Beauty Bar operating model.
 *
 * REAL business facts supplied by the Owner (used as given): the business name, ONE working person (Emel Kaynakkan, who is
 * also the Owner), and four services with prices: Kaş Laminasyonu 2,000; Kirpik Laminasyonu 2,000; Kaş Alımı 600;
 * Kaş Laminasyonu + Kaş Alımı 2,500 TRY.
 *
 * SYNTHETIC test facts (they did NOT happen at the real business): every appointment, its status and date, the payment
 * methods and amounts, the 1,000 outstanding balance, the 300 cash expense, and the 30-minute duration (the schema
 * requires a duration; real durations are not known and play no part in any finance figure).
 * Nothing here creates a real tenant or touches PROD/DEV: it runs on the local scratch database only.
 */

const TZ = "Europe/Nicosia";
const DAY = "2026-10-10";

type Overview = {
  appointments: { total: number; completed: number; confirmed: number; cancelled: number; noShow: number; scheduled: number };
  services: { completedAmount: number; completedWithCheckout: number; completedWithoutCheckout: number; discountTotal: number };
  payments: { totalCollected: number; count: number; cash: number; card: number; bankTransfer: number; other: number };
  outstanding: { amount: number; count: number; todayAmount: number };
  expenses: { accruedTotal: number; paidOutTotal: number; paidOutCash: number; paidOutCard: number };
  cash: { cashCollected: number; cashPaidOut: number; difference: number };
  staff: { displayName: string; completedAppointments: number; completedItems: number; serviceAmount: number }[];
  staffServiceAmountTotal: number;
};

const users: TestUser[] = [];
const tenants: string[] = [];
let emel: TestUser; // Owner AND the only working person
let otherOwner: TestUser;
let tenant: { id: string };
let other: { id: string };
let branchId: string;
let emelStaffId: string;
let svc: Record<"kasLam" | "kirpikLam" | "kasAlimi" | "kasLamKasAlimi", string>;
let result: Overview;
let counter = 0;

async function at(day: string, time: string): Promise<string> {
  const [row] = await testDb<{ ts: string }[]>`select (((${day}::date + ${time}::time) at time zone ${TZ}) at time zone 'UTC')::text || '+00' as ts`;
  return row!.ts;
}

async function overview(t: { id: string }, userId: string): Promise<Overview> {
  const [row] = await asAuthenticatedUser(userId, (sql) => sql<{ o: Overview }[]>`select public.get_daily_owner_overview(${t.id}, ${DAY}::date) as o`);
  return row!.o;
}

async function book(ownerId: string, t: { id: string }, bId: string, staffId: string, serviceId: string, time: string, final: "completed" | "confirmed"): Promise<string> {
  counter += 1;
  const [customer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${t.id}, 'Test Musterisi') returning id`;
  const future = safeMorningStart(3 + counter);
  const [row] = await asAuthenticatedUser(ownerId, (sql) =>
    sql<{ id: string }[]>`select public.create_appointment(${t.id}, ${bId}, ${customer!.id}, ${sql.json([{ service_id: serviceId, staff_member_id: staffId, scheduled_start_at: future.toISOString(), sequence: 1 }] as never)}) as id`,
  );
  const id = row!.id;
  const start = await at(DAY, time);
  await testDb`update appointment_items set scheduled_start_at = ${start}::text::timestamptz, scheduled_end_at = ${start}::text::timestamptz + interval '30 minutes' where appointment_id = ${id}`;
  await testDb`update appointments set scheduled_start_at = ${start}::text::timestamptz, scheduled_end_at = ${start}::text::timestamptz + interval '30 minutes' where id = ${id}`;
  if (final === "completed") await asAuthenticatedUser(ownerId, (sql) => sql`select public.complete_appointment(${id}, '[]'::jsonb)`);
  else await asAuthenticatedUser(ownerId, (sql) => sql`select public.update_appointment_status(${id}, 'confirmed')`);
  return id;
}

async function checkout(ownerId: string, appointmentId: string): Promise<string> {
  const [s] = await asAuthenticatedUser(ownerId, (sql) => sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`);
  return s!.id;
}

async function pay(ownerId: string, saleId: string, amount: number, method: "cash" | "card", time: string) {
  const paidAt = await at(DAY, time);
  await asAuthenticatedUser(ownerId, (sql) =>
    sql`select * from public.record_appointment_payment(${saleId}, ${amount}, ${method}, ${paidAt}::text::timestamptz, null, ${crypto.randomUUID()})`,
  );
}

async function salon(label: string, owner: TestUser, staffName: string) {
  const t = await createTestTenant(`f2a-${label}-${Math.random().toString(36).slice(2, 8)}`, owner.id);
  tenants.push(t.id);
  await testDb`update tenants set timezone = ${TZ}, currency = 'TRY' where id = ${t.id}`;
  const b = await createBranch(t.id, "Merkez");
  const staff = await createStaffMember(t.id, staffName);
  await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff.id}, ${b})`;
  for (let w = 0; w <= 6; w++) await createStaffSchedule(t.id, staff.id, w, "00:00", "23:59");
  const mk = async (name: string, price: number) => {
    const s = await createService(t.id, name, 30, price); // 30 min: synthetic, test-only (the schema requires a duration)
    await testDb`insert into service_branches (service_id, branch_id) values (${s.id}, ${b})`;
    await testDb`insert into staff_services (staff_member_id, service_id) values (${staff.id}, ${s.id})`;
    return s.id;
  };
  return {
    t,
    b,
    staffId: staff.id,
    svc: {
      kasLam: await mk("Kaş Laminasyonu", 2000),
      kirpikLam: await mk("Kirpik Laminasyonu", 2000),
      kasAlimi: await mk("Kaş Alımı", 600),
      kasLamKasAlimi: await mk("Kaş Laminasyonu + Kaş Alımı", 2500),
    },
  };
}

beforeAll(async () => {
  emel = await createTestUser("f2a-emel");
  otherOwner = await createTestUser("f2a-emel-other");
  users.push(emel, otherOwner);

  const e = await salon("emel", emel, "Emel Kaynakkan");
  tenant = e.t;
  branchId = e.b;
  emelStaffId = e.staffId;
  svc = e.svc;
  await testDb`update tenants set name = 'Emel Beauty Bar (test fixture)' where id = ${tenant.id}`;
  // the Owner is ALSO the working person: the staff record is linked to the Owner's own membership
  await testDb`update staff_members set tenant_membership_id = (select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${emel.id}) where id = ${emelStaffId}`;

  // --- synthetic day ---
  const a = await book(emel.id, tenant, branchId, emelStaffId, svc.kasLam, "10:00", "completed");
  await pay(emel.id, await checkout(emel.id, a), 2000, "cash", "10:30");
  const b = await book(emel.id, tenant, branchId, emelStaffId, svc.kasAlimi, "11:00", "completed");
  await pay(emel.id, await checkout(emel.id, b), 600, "card", "11:20");
  const c = await book(emel.id, tenant, branchId, emelStaffId, svc.kasLamKasAlimi, "12:00", "completed");
  await pay(emel.id, await checkout(emel.id, c), 1500, "card", "12:40"); // 1,000 stays outstanding
  await book(emel.id, tenant, branchId, emelStaffId, svc.kirpikLam, "17:00", "confirmed"); // D: future, not done
  // synthetic cash expense of 300, paid in cash the same day
  const [exp] = await asAuthenticatedUser(emel.id, (sql) =>
    sql<{ r: { expenseId: string } }[]>`select (public.create_expense(${tenant.id}, 'supplies', 'Test gideri (sentetik)', ${DAY}::date, 300, ${crypto.randomUUID()})) as r`,
  );
  const expensePaidAt = await at(DAY, "15:00");
  await asAuthenticatedUser(emel.id, (sql) =>
    sql`select public.record_expense_payment(${exp!.r.expenseId}, 300, 'cash', ${expensePaidAt}::text::timestamptz, null, ${crypto.randomUUID()})`,
  );

  // --- another salon on the same day, with money, so isolation is real ---
  const o = await salon("emel-other", otherOwner, "Baska Kisi");
  other = o.t;
  const x = await book(otherOwner.id, o.t, o.b, o.staffId, o.svc.kasLam, "10:00", "completed");
  await pay(otherOwner.id, await checkout(otherOwner.id, x), 2000, "cash", "10:30");

  result = await overview(tenant, emel.id);
}, 240_000);

afterAll(async () => {
  await cleanupTenants(tenants);
  await cleanupUsers(users.map((u) => u.id));
}, 180_000);

describe("Single-person salon (Emel Beauty Bar model) — the dashboard for one working person who is also the Owner", () => {
  it("EXPECTED vs ACTUAL: completed 3 / 5,100; collected 4,100 (cash 2,000, card 2,100); outstanding 1,000; cash expense 300; cash difference 1,700", () => {
    expect(result.appointments).toMatchObject({ total: 4, completed: 3, confirmed: 1, cancelled: 0, noShow: 0 });
    expect(result.services).toMatchObject({ completedAmount: 5100, completedWithCheckout: 3, completedWithoutCheckout: 0, discountTotal: 0 });
    expect(result.payments).toMatchObject({ totalCollected: 4100, count: 3, cash: 2000, card: 2100, bankTransfer: 0, other: 0 });
    expect(result.outstanding).toEqual({ supported: true, amount: 1000, count: 1, todayAmount: 1000 });
    expect(result.expenses).toMatchObject({ accruedTotal: 300, paidOutTotal: 300, paidOutCash: 300, paidOutCard: 0 });
    expect(result.cash).toEqual({ supported: true, cashCollected: 2000, cashPaidOut: 300, difference: 1700 });
    console.log("EMEL_ACTUAL", JSON.stringify({
      completed: result.appointments.completed,
      completed_amount: result.services.completedAmount,
      collected: result.payments.totalCollected,
      outstanding: result.outstanding.amount,
      cash: result.payments.cash,
      card: result.payments.card,
      cash_difference: result.cash.difference,
      staff_count: result.staff.length,
      staff_service_amount: result.staff[0]?.serviceAmount,
    }));
  });

  it("1+2. the Owner is also the sole service-producing person, and a one-person salon needs no second employee", async () => {
    const [link] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_members sm join tenant_memberships m on m.id = sm.tenant_membership_id where sm.tenant_id = ${tenant.id} and m.user_id = ${emel.id}`;
    expect(link!.n).toBe("1"); // the staff member IS the Owner's own membership
    const [count] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_members where tenant_id = ${tenant.id}`;
    expect(count!.n).toBe("1");
    expect(result.staff).toHaveLength(1);
  });

  it("3. the staff breakdown is not empty and does not double-count Owner and staff identity: one row, 3 visits, 5,100", () => {
    expect(result.staff).toEqual([{ displayName: "Emel Kaynakkan", completedAppointments: 3, completedItems: 3, serviceAmount: 5100 }]);
    expect(result.staffServiceAmountTotal).toBe(5100);
    expect(result.staffServiceAmountTotal).toBe(result.services.completedAmount); // no discount in this day: equal, not 10,200
  });

  it("4. the future confirmed Kirpik Laminasyonu (2,000) is neither completed value nor collection nor staff revenue", () => {
    expect(result.appointments.confirmed).toBe(1);
    expect(result.services.completedAmount).toBe(5100); // not 7,100
    expect(result.payments.totalCollected).toBe(4100);
    expect(result.staff[0]!.serviceAmount).toBe(5100);
    expect(result.outstanding.amount).toBe(1000); // a future appointment has no checkout and is not a receivable
  });

  it("5+6. the partial payment contributes only what was received (1,500 of 2,500) and exactly 1,000 stays outstanding", async () => {
    expect(result.payments.card - 600).toBe(1500);
    expect(result.outstanding.amount).toBe(1000);
    // completed value counts the whole 2,500, collection only 1,500: they are different numbers
    expect(result.services.completedAmount - result.payments.totalCollected).toBe(result.outstanding.amount);
  });

  it("7. the split by method is exact and sums to the collection", () => {
    expect(result.payments.cash + result.payments.card + result.payments.bankTransfer + result.payments.other).toBe(result.payments.totalCollected);
    expect([result.payments.cash, result.payments.card, result.payments.bankTransfer, result.payments.other]).toEqual([2000, 2100, 0, 0]);
  });

  it("8. the cash difference is cash received minus cash paid out only (card money never enters it)", () => {
    expect(result.cash.difference).toBe(result.payments.cash - result.expenses.paidOutCash);
    expect(result.cash.difference).toBe(1700);
    expect(result.cash.difference).not.toBe(result.payments.totalCollected - result.expenses.paidOutTotal); // 3,800 would be wrong
  });

  it("collected money is not attributed to the person: the staff row carries service value only", () => {
    expect(Object.keys(result.staff[0]!).sort()).toEqual(["completedAppointments", "completedItems", "displayName", "serviceAmount"]);
  });

  it("9. tenant isolation: the other salon's identical-day cash does not enter, in either direction", async () => {
    const theirs = await overview(other, otherOwner.id);
    expect(theirs.payments).toMatchObject({ totalCollected: 2000, cash: 2000, card: 0 });
    expect(theirs.expenses.paidOutTotal).toBe(0);
    expect(theirs.staff.map((s) => s.displayName)).toEqual(["Baska Kisi"]);
    const mine = await overview(tenant, emel.id);
    expect(mine.payments.totalCollected).toBe(4100);
    // and the Owner of one salon cannot read the other
    await expect(asAuthenticatedUser(emel.id, (sql) => sql`select public.get_daily_owner_overview(${other.id}, ${DAY}::date)`)).rejects.toMatchObject({ code: "FN002" });
  });
});
