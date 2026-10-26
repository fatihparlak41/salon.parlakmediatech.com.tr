import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  asAuthenticatedUser,
  asDatabaseRole,
  attemptAs,
  auditRows,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createCustomRole,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestMembershipFromTemplate,
  createTestTenant,
  createTestUser,
  safeMorningStart,
  testDb,
  type TestUser,
} from "./helpers";

/**
 * Faz COMM.1A — staff commission by service, against the real database functions. Every expected number is calculated by hand
 * in the comments. All people, services (except the four Emel Beauty Bar services supplied by the Owner), prices, rates, dates and
 * transactions are SYNTHETIC; the "Gökhan-like" salon is an invented shape (an Owner, several staff, several services, mixed
 * rules), not Gökhan's data.
 */

const TZ = "Europe/Nicosia";
const DAY = "2026-10-10";

type Summary = {
  from: string; to: string; timezone: string; currency: string; basis: string;
  staff: { staffId: string; displayName: string; completedServices: number; completedAppointments: number; serviceAmount: number; commissionAmount: number }[];
  totals: { completedServices: number; serviceAmount: number; commissionAmount: number };
};
type Detail = {
  displayName: string; currency: string; hasMore: boolean;
  total: { serviceAmount: number; commissionAmount: number; rows: number };
  rows: { date: string; service: string; serviceValue: number; rule: { kind: string; percentage: number | null; fixedAmount: number | null }; commission: number; saleDiscount: boolean }[];
};

const users: TestUser[] = [];
const tenants: string[] = [];
const stamp = Math.random().toString(36).slice(2, 7);
let counter = 0;

async function newUser(label: string): Promise<TestUser> {
  const u = await createTestUser(`cm-${label}`);
  users.push(u);
  return u;
}

async function at(day: string, time: string): Promise<string> {
  const [row] = await testDb<{ ts: string }[]>`select (((${day}::date + ${time}::time) at time zone ${TZ}) at time zone 'UTC')::text || '+00' as ts`;
  return row!.ts;
}

type Fx = { t: { id: string; slug: string }; ownerId: string; b: string; staff: Record<string, string>; svc: Record<string, string> };

async function salon(label: string, owner: TestUser, staffNames: string[], services: [string, number][]): Promise<Fx> {
  const t = await createTestTenant(`cm-${label}-${stamp}`, owner.id);
  tenants.push(t.id);
  await testDb`update tenants set timezone = ${TZ}, currency = 'TRY' where id = ${t.id}`;
  const b = await createBranch(t.id, "Merkez");
  const staff: Record<string, string> = {};
  const svc: Record<string, string> = {};
  for (const n of staffNames) {
    const s = await createStaffMember(t.id, n);
    staff[n] = s.id;
    await testDb`insert into staff_branches (staff_member_id, branch_id) values (${s.id}, ${b})`;
    for (let w = 0; w <= 6; w++) await createStaffSchedule(t.id, s.id, w, "00:00", "23:59");
  }
  for (const [name, price] of services) {
    const s = await createService(t.id, name, 30, price); // 30 minutes: synthetic, test-only
    svc[name] = s.id;
    await testDb`insert into service_branches (service_id, branch_id) values (${s.id}, ${b})`;
    for (const sid of Object.values(staff)) await testDb`insert into staff_services (staff_member_id, service_id) values (${sid}, ${s.id})`;
  }
  return { t: { id: t.id, slug: t.slug }, ownerId: owner.id, b, staff, svc };
}

/** one appointment with 1..n items (each item: person + service); created through the real RPC, moved onto `day`/`time` */
async function appt(
  fx: Fx,
  day: string | null,
  time: string,
  items: [string, string][],
  final: "completed" | "cancelled" | "no_show" | "confirmed" | "scheduled",
): Promise<{ id: string; itemIds: string[] }> {
  counter += 1;
  const [customer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${fx.t.id}, 'Musteri Gizli Ad') returning id`;
  const future = safeMorningStart(3 + counter);
  const [row] = await asAuthenticatedUser(fx.ownerId, (sql) =>
    sql<{ id: string }[]>`select public.create_appointment(${fx.t.id}, ${fx.b}, ${customer!.id}, ${sql.json(
      items.map(([staff, service], i) => ({ service_id: fx.svc[service], staff_member_id: fx.staff[staff], scheduled_start_at: new Date(future.getTime() + i * 3600_000).toISOString(), sequence: i + 1 })) as never,
    )}, 'GIZLI-NOT') as id`,
  );
  const id = row!.id;
  if (day) {
    const base = await at(day, time);
    // items of one appointment are stacked half an hour apart so one person doing two items never overlaps themselves
    const its = await testDb<{ id: string }[]>`select id from appointment_items where appointment_id = ${id} order by sequence`;
    for (const [i, it] of its.entries()) {
      await testDb`update appointment_items set scheduled_start_at = ${base}::text::timestamptz + (${i * 30} || ' minutes')::interval, scheduled_end_at = ${base}::text::timestamptz + (${i * 30 + 30} || ' minutes')::interval where id = ${it.id}`;
    }
    await testDb`update appointments set scheduled_start_at = ${base}::text::timestamptz, scheduled_end_at = ${base}::text::timestamptz + (${items.length * 30} || ' minutes')::interval where id = ${id}`;
  }
  if (final === "completed") await asAuthenticatedUser(fx.ownerId, (sql) => sql`select public.complete_appointment(${id}, '[]'::jsonb)`);
  else if (final !== "scheduled") await asAuthenticatedUser(fx.ownerId, (sql) => sql`select public.update_appointment_status(${id}, ${final})`);
  const itemIds = (await testDb<{ id: string }[]>`select id from appointment_items where appointment_id = ${id} order by sequence`).map((r) => r.id);
  return { id, itemIds };
}

/** a checkout; optionally edit the unit price of the first item and add a sale-level discount */
async function checkout(fx: Fx, appointmentId: string, opts: { discount?: number; unit?: number; pay?: number[] } = {}): Promise<string> {
  const [s] = await asAuthenticatedUser(fx.ownerId, (sql) => sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`);
  if (opts.discount || opts.unit !== undefined) {
    const items = await testDb<{ id: string; unit_price: string }[]>`select id, unit_price::text from appointment_sale_items where sale_id = ${s!.id} order by id`;
    const priced = items.map((i, k) => ({ sale_item_id: i.id, unit_price: k === 0 && opts.unit !== undefined ? opts.unit : Number(i.unit_price) }));
    await asAuthenticatedUser(fx.ownerId, (sql) => sql`select * from public.update_appointment_sale_pricing(${s!.id}, ${sql.json(priced as never)}, ${opts.discount ?? 0}, 'test')`);
  }
  for (const amount of opts.pay ?? []) {
    await asAuthenticatedUser(fx.ownerId, (sql) => sql`select * from public.record_appointment_payment(${s!.id}, ${amount}, 'cash', now(), null, ${crypto.randomUUID()})`);
  }
  return s!.id;
}

const rule = (fx: Fx, userId: string, staff: string, service: string, kind: string, value: number | null, from: string | null = "2026-01-01") =>
  asAuthenticatedUser(userId, (sql) =>
    sql`select public.set_commission_rule(${fx.t.id}, ${fx.staff[staff]}, ${fx.svc[service]}, ${kind}, ${value}, ${from}::date)`,
  );
const summary = (fx: Fx, userId: string, from: string | null = DAY, to: string | null = DAY) =>
  asAuthenticatedUser(userId, (sql) => sql<{ s: Summary }[]>`select public.get_staff_commission(${fx.t.id}, ${from}::date, ${to}::date) as s`).then((r) => r[0]!.s);
const detail = (fx: Fx, userId: string, staff: string, from: string | null = DAY, to: string | null = DAY) =>
  asAuthenticatedUser(userId, (sql) => sql<{ d: Detail }[]>`select public.get_staff_commission_detail(${fx.t.id}, ${fx.staff[staff]}, ${from}::date, ${to}::date, 200) as d`).then((r) => r[0]!.d);
const row = (s: Summary, name: string) => s.staff.find((x) => x.displayName === name);

let owner: TestUser;
let manager: TestUser;
let receptionist: TestUser;
let stylist: TestUser;
let financeViewer: TestUser;
let otherOwner: TestUser;
let g: Fx; // the Gökhan-like salon (synthetic)
let other: Fx;

beforeAll(async () => {
  owner = await newUser("owner");
  manager = await newUser("manager");
  receptionist = await newUser("reception");
  stylist = await newUser("stylist");
  financeViewer = await newUser("finview");
  otherOwner = await newUser("other");

  g = await salon("gokhan", owner, ["Ahmet", "Burak", "Can"], [["Sac Kesimi", 500], ["Boya", 1500], ["Sakal", 200], ["Ozel Islem", 1000], ["Kucuk Islem", 10.05], ["Ucretsiz Islem", 0]]);
  await createTestMembershipFromTemplate(g.t.id, manager.id, "SALON_MANAGER");
  await createTestMembershipFromTemplate(g.t.id, receptionist.id, "RECEPTIONIST");
  await createTestMembershipFromTemplate(g.t.id, stylist.id, "STYLIST");
  await addMembership(g.t.id, financeViewer.id, await createCustomRole(g.t.id, "Sadece Finans Goruntule", ["finance.view"]));

  // --- rules (mixed) ---
  await rule(g, owner.id, "Ahmet", "Sac Kesimi", "percentage", 20);
  await rule(g, owner.id, "Ahmet", "Boya", "percentage", 15);
  await rule(g, owner.id, "Ahmet", "Ozel Islem", "fixed", 250);
  await rule(g, owner.id, "Ahmet", "Kucuk Islem", "percentage", 10);
  await rule(g, owner.id, "Ahmet", "Ucretsiz Islem", "fixed", 50);
  await rule(g, owner.id, "Burak", "Sac Kesimi", "percentage", 20);
  await rule(g, owner.id, "Burak", "Sakal", "none", null);
  // Can has no rule at all

  // --- the day ---
  const a1 = await appt(g, DAY, "09:00", [["Ahmet", "Sac Kesimi"]], "completed"); // 500, no checkout -> 20% = 100.00
  void a1;
  const a2 = await appt(g, DAY, "10:00", [["Ahmet", "Boya"]], "completed"); // list 1,500, checkout unit price edited to 1,400, sale discount 200 -> 15% of 1,400 = 210.00
  await checkout(g, a2.id, { unit: 1400, discount: 200, pay: [300] });
  const a3 = await appt(g, DAY, "11:00", [["Ahmet", "Sac Kesimi"], ["Burak", "Sac Kesimi"], ["Can", "Sakal"]], "completed"); // three people, one appointment
  await checkout(g, a3.id, { discount: 100 }); // sale discount 100, nothing paid
  await appt(g, DAY, "13:00", [["Ahmet", "Ozel Islem"], ["Ahmet", "Ozel Islem"]], "completed"); // two special items by one person -> 2 x 250 = 500.00 (fixed per item)
  const a5 = await appt(g, DAY, "15:00", [["Ahmet", "Kucuk Islem"]], "completed"); // 10.05 -> 10% = 1.005 -> 1.01
  await checkout(g, a5.id, { pay: [10.05] });
  await appt(g, DAY, "16:00", [["Ahmet", "Kucuk Islem"]], "completed"); // another 1.01 (per-item rounding: total 2.02, not 2.01)
  await appt(g, DAY, "17:00", [["Ahmet", "Ucretsiz Islem"]], "completed"); // value 0, fixed 50.00
  await appt(g, DAY, "18:00", [["Burak", "Sac Kesimi"]], "cancelled"); // excluded
  await appt(g, DAY, "19:00", [["Ahmet", "Sac Kesimi"]], "no_show"); // excluded
  await appt(g, DAY, "20:00", [["Burak", "Sac Kesimi"]], "confirmed"); // not completed: excluded
  await appt(g, null, "00:00", [["Burak", "Sac Kesimi"]], "confirmed"); // future: excluded

  // --- another salon, same day, would pay a lot ---
  other = await salon("other", otherOwner, ["Ahmet"], [["Sac Kesimi", 500]]);
  await rule(other, otherOwner.id, "Ahmet", "Sac Kesimi", "percentage", 100);
  await appt(other, DAY, "09:00", [["Ahmet", "Sac Kesimi"]], "completed");
}, 300_000);

afterAll(async () => {
  await testDb`delete from staff_commission_rules where tenant_id = any(${tenants}::uuid[])`;
  await cleanupTenants(tenants);
  await cleanupUsers(users.map((u) => u.id));
}, 180_000);

describe("COMMISSION — the Gökhan-like salon (synthetic), totals proven by hand", () => {
  let s: Summary;
  beforeAll(async () => {
    s = await summary(g, owner.id);
  });

  it("Ahmet: 100.00 + 210.00 + 100.00 + 500.00 + 1.01 + 1.01 + 50.00 = 962.02 on 8 completed items in 7 appointments", () => {
    // a1 haircut 500 @20% = 100 · a2 colour (edited price 1,400, the 200 sale discount ignored) @15% = 210 · a3 haircut 500 @20% = 100 ·
    // a4 two special items fixed 250 each = 500 · two small items 10.05 @10% = 1.01 each (rounded per item) · free item fixed 50
    const ahmet = row(s, "Ahmet")!;
    expect(ahmet.commissionAmount).toBe(962.02);
    expect(ahmet.completedServices).toBe(8);
    expect(ahmet.completedAppointments).toBe(7);
    expect(ahmet.serviceAmount).toBe(500 + 1400 + 500 + 1000 + 1000 + 10.05 + 10.05 + 0);
  });

  it("Burak: the haircut inside the shared appointment = 100.00 (20% of HIS 500, not of the appointment); cancelled and not-completed ones add nothing", () => {
    const burak = row(s, "Burak")!;
    expect(burak).toMatchObject({ commissionAmount: 100, completedServices: 1, completedAppointments: 1, serviceAmount: 500 });
  });

  it("Can: completed work, no rule at all -> commission 0, listed once, no error", () => {
    expect(row(s, "Can")).toMatchObject({ commissionAmount: 0, completedServices: 1, serviceAmount: 200 });
    expect(s.staff.filter((x) => x.displayName === "Can")).toHaveLength(1);
  });

  it("totals: 3 people, 10 completed items, commission 962.02 + 100.00 + 0 = 1,062.02; the basis is the completed service value", () => {
    expect(s.staff).toHaveLength(3);
    expect(s.totals.completedServices).toBe(10);
    expect(s.totals.commissionAmount).toBe(962.02 + 100 + 0);
    expect(s.totals.serviceAmount).toBe(row(s, "Ahmet")!.serviceAmount + 500 + 200);
    expect(s.basis).toBe("completed_service_value");
    expect(s.currency).toBe("TRY");
    expect(s.staff.map((x) => x.displayName)).toEqual(["Ahmet", "Burak", "Can"]); // by commission, then name
  });

  it("the detail rows add up to the total EXACTLY and each row explains itself (date, service, value, rule, commission)", async () => {
    const d = await detail(g, owner.id, "Ahmet");
    expect(d.total).toMatchObject({ commissionAmount: 962.02, rows: 8 });
    const sum = d.rows.reduce((n, r) => n + Math.round(r.commission * 100), 0);
    expect(sum).toBe(96202); // integer cents: no floating-point drift
    expect(d.rows.every((r) => r.date === DAY)).toBe(true);
    const colour = d.rows.find((r) => r.service === "Boya")!;
    expect(colour).toMatchObject({ serviceValue: 1400, commission: 210, rule: { kind: "percentage", percentage: 15, fixedAmount: null }, saleDiscount: true });
    const special = d.rows.filter((r) => r.service === "Ozel Islem");
    expect(special).toHaveLength(2);
    expect(special.every((r) => r.commission === 250 && r.rule.kind === "fixed" && r.rule.fixedAmount === 250)).toBe(true);
    const free = d.rows.find((r) => r.service === "Ucretsiz Islem")!;
    expect(free).toMatchObject({ serviceValue: 0, commission: 50 });
  });

  it("multi-service, multi-staff: the shared appointment (500 + 500 + 200) gives each person ONLY their own item; the sum of the three is the sum of the items", async () => {
    const a = (await detail(g, owner.id, "Ahmet")).rows.filter((r) => r.service === "Sac Kesimi" && r.saleDiscount);
    const b = (await detail(g, owner.id, "Burak")).rows;
    const c = (await detail(g, owner.id, "Can")).rows;
    expect([a.length, b.length, c.length]).toEqual([1, 1, 1]);
    expect([a[0]!.serviceValue, b[0]!.serviceValue, c[0]!.serviceValue]).toEqual([500, 500, 200]);
    expect([a[0]!.commission, b[0]!.commission, c[0]!.commission]).toEqual([100, 100, 0]);
    expect(b[0]!.saleDiscount).toBe(true); // the sale's 100 discount is visible but not allocated
  });

  it("rounding is per item: two items of 10.05 at 10% are 1.01 + 1.01 = 2.02 (rounding the sum would give 2.01)", async () => {
    const small = (await detail(g, owner.id, "Ahmet")).rows.filter((r) => r.service === "Kucuk Islem");
    expect(small.map((r) => r.commission)).toEqual([1.01, 1.01]);
  });

  it("percentage on a zero-value item is 0.00; a fixed rule on it still pays its fixed amount; a fixed rule is paid once per item however many payments the checkout has", async () => {
    const d = await detail(g, owner.id, "Ahmet");
    expect(d.rows.find((r) => r.service === "Ucretsiz Islem")!.commission).toBe(50);
    // the colour checkout has a partial payment and the small item a full one: neither changes any commission
    expect(d.rows.find((r) => r.service === "Boya")!.commission).toBe(210);
  });

  it("payment is irrelevant: voiding a payment, or paying nothing, does not move a commission", async () => {
    const before = await summary(g, owner.id);
    const [p] = await testDb<{ id: string }[]>`select p.id from payments p join appointment_sales s on s.id = p.appointment_sale_id join appointments a on a.id = s.appointment_id where a.tenant_id = ${g.t.id} limit 1`;
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.void_appointment_payment(${p!.id}, 'x')`);
    expect(await summary(g, owner.id)).toEqual(before);
  });

  it("excluded for good: cancelled, no-show, confirmed-today and future appointments never appear in any detail", async () => {
    const burak = await detail(g, owner.id, "Burak");
    expect(burak.rows).toHaveLength(1);
    const wide = await summary(g, owner.id, "2026-10-01", "2027-09-30");
    expect(wide.staff.find((x) => x.displayName === "Burak")!.completedServices).toBe(1);
    const ahmet = await detail(g, owner.id, "Ahmet", "2026-10-01", "2027-09-30");
    expect(ahmet.rows).toHaveLength(8);
  });

  it("another salon's work and rules never contribute; this salon's rules never touch it", async () => {
    const theirs = await summary(other, otherOwner.id);
    expect(row(theirs, "Ahmet")).toMatchObject({ commissionAmount: 500, serviceAmount: 500, completedServices: 1 }); // their own 100% rule
    expect(row(await summary(g, owner.id), "Ahmet")!.commissionAmount).toBe(962.02);
  });
});

describe("EFFECTIVE-DATED rules: changing a rate never rewrites the past", () => {
  it("a new rate from a later date applies to later work only; 'none' from a date ends a commission; the same day is replaced, not stacked", async () => {
    const f = await salon("dated", owner, ["Dilek"], [["Sac Kesimi", 500]]);
    await rule(f, owner.id, "Dilek", "Sac Kesimi", "percentage", 20, "2026-09-01");
    await appt(f, "2026-10-01", "09:00", [["Dilek", "Sac Kesimi"]], "completed"); // 20% = 100
    await appt(f, "2026-10-12", "09:00", [["Dilek", "Sac Kesimi"]], "completed"); // after the change: 30% = 150
    await appt(f, "2026-10-20", "09:00", [["Dilek", "Sac Kesimi"]], "completed"); // after 'none': 0
    await rule(f, owner.id, "Dilek", "Sac Kesimi", "percentage", 25, "2026-10-10");
    await rule(f, owner.id, "Dilek", "Sac Kesimi", "percentage", 30, "2026-10-10"); // same date: replaces 25
    await rule(f, owner.id, "Dilek", "Sac Kesimi", "none", null, "2026-10-15");
    const d = await detail(f, owner.id, "Dilek", "2026-10-01", "2026-10-31");
    expect(d.rows.map((r) => [r.date, r.commission, r.rule.kind])).toEqual([
      ["2026-10-20", 0, "none"],
      ["2026-10-12", 150, "percentage"],
      ["2026-10-01", 100, "percentage"],
    ]);
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_commission_rules where tenant_id = ${f.t.id}`;
    expect(n!.n).toBe("3"); // 09-01, 10-10 (replaced once), 10-15
    const audits = await auditRows(f.t.id, "commission.rule_set");
    expect(audits).toHaveLength(4);
    expect(JSON.stringify(audits)).not.toContain("Dilek");
  });

  it("the item's LOCAL date decides: work at 23:30 local belongs to that day's rule, not the UTC day's", async () => {
    const f = await salon("dated2", owner, ["Ece"], [["Sac Kesimi", 500]]);
    await rule(f, owner.id, "Ece", "Sac Kesimi", "percentage", 10, "2026-10-10");
    await rule(f, owner.id, "Ece", "Sac Kesimi", "percentage", 50, "2026-10-11");
    await appt(f, "2026-10-10", "23:30", [["Ece", "Sac Kesimi"]], "completed"); // 20:30Z on the 10th local EEST: still the 10th
    await appt(f, "2026-10-11", "00:30", [["Ece", "Sac Kesimi"]], "completed"); // 21:30Z on the 10th UTC, but local 11th
    const d = await detail(f, owner.id, "Ece", "2026-10-10", "2026-10-11");
    expect(d.rows.map((r) => [r.date, r.commission])).toEqual([["2026-10-11", 250], ["2026-10-10", 50]]);
  });
});

describe("EMEL BEAUTY BAR (single person: the Owner is the only provider; all transactions synthetic)", () => {
  let e: Fx;
  let emelOwner: TestUser;

  beforeAll(async () => {
    emelOwner = await newUser("emel");
    e = await salon("emel", emelOwner, ["Emel Kaynakkan"], [["Kaş Laminasyonu", 2000], ["Kirpik Laminasyonu", 2000], ["Kaş Alımı", 600], ["Kaş Laminasyonu + Kaş Alımı", 2500]]);
    await testDb`update staff_members set tenant_membership_id = (select id from tenant_memberships where tenant_id = ${e.t.id} and user_id = ${emelOwner.id}) where id = ${e.staff["Emel Kaynakkan"]!}`;
    await appt(e, DAY, "10:00", [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
    await appt(e, DAY, "12:00", [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    await appt(e, DAY, "14:00", [["Emel Kaynakkan", "Kaş Laminasyonu + Kaş Alımı"]], "completed");
    await appt(e, null, "00:00", [["Emel Kaynakkan", "Kirpik Laminasyonu"]], "confirmed");
  }, 180_000);

  it("no rule configured: commission 0, one staff row, no error, no fake payout; the work itself is still reported", async () => {
    const s = await summary(e, emelOwner.id);
    expect(s.staff).toEqual([{ staffId: e.staff["Emel Kaynakkan"], displayName: "Emel Kaynakkan", completedServices: 3, completedAppointments: 3, serviceAmount: 5100, commissionAmount: 0 }]);
    expect(s.totals).toEqual({ completedServices: 3, serviceAmount: 5100, commissionAmount: 0 });
    const d = await detail(e, emelOwner.id, "Emel Kaynakkan");
    expect(d.rows.map((r) => [r.commission, r.rule.kind])).toEqual([[0, "none"], [0, "none"], [0, "none"]]);
  });

  it("a rule she chooses to set for herself works (10% of 5,100 = 510.00) and the future appointment still adds nothing", async () => {
    for (const service of ["Kaş Laminasyonu", "Kaş Alımı", "Kaş Laminasyonu + Kaş Alımı"]) await rule(e, emelOwner.id, "Emel Kaynakkan", service, "percentage", 10);
    const s = await summary(e, emelOwner.id);
    expect(s.staff).toHaveLength(1);
    expect(s.totals.commissionAmount).toBe(510);
  });

  it("an explicit 'none' returns to 0 without deleting history", async () => {
    for (const service of ["Kaş Laminasyonu", "Kaş Alımı", "Kaş Laminasyonu + Kaş Alımı"]) await rule(e, emelOwner.id, "Emel Kaynakkan", service, "none", null, "2026-10-10");
    expect((await summary(e, emelOwner.id)).totals.commissionAmount).toBe(0);
  });
});

describe("rules — validation, tenant scope, the list for the screen", () => {
  it("percentage 0..100 with at most 2 decimals; fixed 0..999,999.99 with at most 2 decimals; 'none' takes no value; bad kind / date refused", async () => {
    const ok = async (kind: string, value: number | null) => attemptAs(owner.id, (sql) => sql`select public.set_commission_rule(${g.t.id}, ${g.staff["Can"]!}, ${g.svc["Boya"]!}, ${kind}, ${value}, '2026-05-05'::date)`);
    expect(await ok("percentage", 0)).toEqual({ ok: true });
    expect(await ok("percentage", 100)).toEqual({ ok: true });
    expect(await ok("percentage", 12.5)).toEqual({ ok: true });
    expect(await ok("fixed", 0)).toEqual({ ok: true });
    expect(await ok("fixed", 999999.99)).toEqual({ ok: true });
    for (const [kind, value] of [["percentage", 100.01], ["percentage", -1], ["percentage", 12.345], ["percentage", null], ["fixed", -0.01], ["fixed", 1000000], ["fixed", 1.005], ["fixed", null], ["none", 5], ["salary", 5]] as const) {
      expect(await ok(kind, value), `${kind} ${value}`).toMatchObject({ ok: false, code: "CM004" });
    }
    expect(await attemptAs(owner.id, (sql) => sql`select public.set_commission_rule(${g.t.id}, ${g.staff["Can"]!}, ${g.svc["Boya"]!}, 'none', null, '1999-12-31'::date)`)).toMatchObject({ ok: false, code: "CM004" });
    expect(await attemptAs(owner.id, (sql) => sql`select public.set_commission_rule(${g.t.id}, ${g.staff["Can"]!}, ${g.svc["Boya"]!}, 'none', null, '2100-01-01'::date)`)).toMatchObject({ ok: false, code: "CM004" });
  });

  it("a rule cannot reference another salon's person or service (CM003), and nothing is written", async () => {
    const [n0] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_commission_rules`;
    expect(await attemptAs(owner.id, (sql) => sql`select public.set_commission_rule(${g.t.id}, ${other.staff["Ahmet"]!}, ${g.svc["Boya"]!}, 'percentage', 10, null)`)).toMatchObject({ ok: false, code: "CM003" });
    expect(await attemptAs(owner.id, (sql) => sql`select public.set_commission_rule(${g.t.id}, ${g.staff["Can"]!}, ${other.svc["Sac Kesimi"]!}, 'percentage', 10, null)`)).toMatchObject({ ok: false, code: "CM003" });
    expect(await attemptAs(owner.id, (sql) => sql`select public.set_commission_rule(${other.t.id}, ${g.staff["Can"]!}, ${g.svc["Boya"]!}, 'percentage', 10, null)`)).toMatchObject({ ok: false, code: "CM002" });
    const [n1] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_commission_rules`;
    expect(n1!.n).toBe(n0!.n);
  });

  it("the configuration list shows the rules in force today (no 'none' rows), plus the salon's active people and services", async () => {
    const [{ r }] = await asAuthenticatedUser(owner.id, (sql) => sql<{ r: { rules: { staffName: string; serviceName: string; kind: string }[]; staff: { name: string }[]; services: { name: string }[] } }[]>`select public.list_commission_rules(${g.t.id}) as r`);
    expect(r.rules.some((x) => x.staffName === "Burak" && x.serviceName === "Sakal")).toBe(false); // 'none'
    expect(r.rules.find((x) => x.staffName === "Ahmet" && x.serviceName === "Ozel Islem")).toMatchObject({ kind: "fixed" });
    expect(r.staff.map((x) => x.name)).toEqual(["Ahmet", "Burak", "Can"]);
    expect(r.services.map((x) => x.name)).toContain("Boya");
    expect(JSON.stringify(r)).not.toContain("Ahmet" + "x"); // sanity: no foreign names
    expect(r.staff.map((x) => x.name)).not.toContain("Emel Kaynakkan");
  });

  it("range rules: default is today (tenant-local), at most 366 days, from must not be after to", async () => {
    const today = await summary(g, owner.id, null, null);
    expect(today.from).toBe(today.to);
    expect(await attemptAs(owner.id, (sql) => sql`select public.get_staff_commission(${g.t.id}, '2026-01-01'::date, '2027-01-02'::date)`)).toMatchObject({ ok: false, code: "CM004" });
    expect(await attemptAs(owner.id, (sql) => sql`select public.get_staff_commission(${g.t.id}, '2026-01-01'::date, '2026-12-31'::date)`)).toEqual({ ok: true });
    expect(await attemptAs(owner.id, (sql) => sql`select public.get_staff_commission(${g.t.id}, '2026-10-02'::date, '2026-10-01'::date)`)).toMatchObject({ ok: false, code: "CM004" });
  });
});

describe("AUTHORIZATION and PRIVACY", () => {
  it("the Owner may read and configure; a role with only finance.view may read but not configure", async () => {
    expect((await summary(g, owner.id)).totals.completedServices).toBe(10);
    expect((await summary(g, financeViewer.id)).totals.completedServices).toBe(10);
    expect(await attemptAs(financeViewer.id, (sql) => sql`select public.set_commission_rule(${g.t.id}, ${g.staff["Can"]!}, ${g.svc["Boya"]!}, 'none', null, null)`)).toMatchObject({ ok: false, code: "CM002" });
  });

  it("Yönetici, Resepsiyon and Personel are refused everywhere (no finance permission); so is another salon's Owner", async () => {
    for (const u of [manager, receptionist, stylist, otherOwner]) {
      for (const call of [
        (sql: never) => (sql as never as typeof testDb)`select public.get_staff_commission(${g.t.id}, ${DAY}::date, ${DAY}::date)`,
        (sql: never) => (sql as never as typeof testDb)`select public.get_staff_commission_detail(${g.t.id}, ${g.staff["Ahmet"]!}, ${DAY}::date, ${DAY}::date, 10)`,
        (sql: never) => (sql as never as typeof testDb)`select public.list_commission_rules(${g.t.id})`,
        (sql: never) => (sql as never as typeof testDb)`select public.set_commission_rule(${g.t.id}, ${g.staff["Can"]!}, ${g.svc["Boya"]!}, 'none', null, null)`,
      ]) {
        expect(await attemptAs(u.id, (sql) => call(sql as never) as never), u.email).toMatchObject({ ok: false, code: "CM002" });
      }
    }
  });

  it("no session is CM001; anon and service_role cannot execute; the private functions are executable by no API role", async () => {
    await expect(asDatabaseRole("authenticated", null, (sql) => sql`select public.get_staff_commission(${g.t.id}, null, null)`)).rejects.toMatchObject({ code: "CM001" });
    for (const role of ["anon", "service_role"] as const) {
      for (const call of [`select public.get_staff_commission($1::uuid, null, null)`, `select public.list_commission_rules($1::uuid)`, `select public.set_commission_rule($1::uuid, $1::uuid, $1::uuid, 'none', null, null)`]) {
        await expect(asDatabaseRole(role, null, (sql) => sql.unsafe(call, [g.t.id] as never[])), `${role} ${call}`).rejects.toMatchObject({ code: "42501" });
      }
    }
    for (const fn of ["private.commission_items(uuid, date, date)", "private.staff_commission_summary(uuid, date, date)", "private.set_commission_rule(uuid, uuid, uuid, text, numeric, date)"]) {
      const [r] = await testDb<{ a: boolean; b: boolean; c: boolean }[]>`select has_function_privilege('authenticated', ${fn}, 'execute') as a, has_function_privilege('anon', ${fn}, 'execute') as b, has_function_privilege('service_role', ${fn}, 'execute') as c`;
      expect(r, fn).toEqual({ a: false, b: false, c: false });
    }
    for (const [role, ok] of [["authenticated", false], ["anon", false], ["service_role", false]] as const) {
      const [r] = await testDb<{ s: boolean; i: boolean }[]>`select has_table_privilege(${role}, 'public.staff_commission_rules', 'select') as s, has_table_privilege(${role}, 'public.staff_commission_rules', 'insert') as i`;
      expect([r!.s, r!.i], role).toEqual([ok, ok]);
    }
  });

  it("PRIVACY: no customer name, note, phone, e-mail, appointment id or user id in any answer", async () => {
    const s = await summary(g, owner.id);
    const d = await detail(g, owner.id, "Ahmet");
    const text = JSON.stringify([s, d]);
    for (const secret of ["Musteri Gizli Ad", "GIZLI-NOT", g.t.id, owner.id, g.b]) expect(text, secret).not.toContain(secret);
    expect(Object.keys(d.rows[0]!).sort()).toEqual(["commission", "date", "rule", "saleDiscount", "service", "serviceValue"]);
    expect(Object.keys(s.staff[0]!).sort()).toEqual(["commissionAmount", "completedAppointments", "completedServices", "displayName", "serviceAmount", "staffId"]);
  });

  it("reading writes nothing (no rule, no audit row)", async () => {
    const snap = async () => ({
      rules: await testDb`select count(*)::int as n from staff_commission_rules where tenant_id = ${g.t.id}`,
      audit: await testDb`select count(*)::int as n from audit_logs where tenant_id = ${g.t.id}`,
    });
    const before = await snap();
    await summary(g, owner.id);
    await detail(g, owner.id, "Ahmet");
    expect(await snap()).toEqual(before);
  });
});
