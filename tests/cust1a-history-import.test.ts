import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAuthenticatedUser,
  asDatabaseRole,
  attemptAs,
  auditRows,
  cleanupTenants,
  cleanupUsers,
  createBranch,
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
 * Faz CUST.1A — customer history (one read model) and safe customer import, against the real database functions.
 *
 * REAL business facts used (supplied by the Owner): Emel Beauty Bar, one working person (Emel Kaynakkan), and the four
 * services Kaş Laminasyonu 2,000 / Kirpik Laminasyonu 2,000 / Kaş Alımı 600 / Kaş Laminasyonu + Kaş Alımı 2,500 TRY.
 * EVERYTHING ELSE is synthetic: the customers, their phones and e-mails, every appointment, date, status and payment, the
 * 30-minute durations (test-only; the schema requires one). Nothing here is, or was, real customer data.
 */

const TZ = "Europe/Nicosia";
const DAY1 = "2026-09-01";
const DAY2 = "2026-09-20";
const DAY_CANCEL = "2026-09-25";
const DAY_NOSHOW = "2026-09-28";

type History = {
  timezone: string;
  summary: { completedVisits: number; lastVisitAt: string | null; upcoming: number; cancelled: number; noShow: number; total: number };
  upcoming: { startAt: string; status: string; items: { service: string; staff: string | null }[]; amount?: number; hasCheckout?: boolean; paid?: number | null; outstanding?: number | null }[];
  past: History["upcoming"];
  hasMorePast: boolean;
  servicesReceived: { service: string; count: number }[];
  staff: { displayName: string; count: number }[];
  finance: { completedAmount: number; outstanding: number; completedWithoutCheckout: number; currency: string } | null;
};

type Row = { row: number; name: string; phone?: string; email?: string };
type Preview = {
  maxRows: number;
  summary: { total: number; new: number; matchExisting: number; invalid: number; ambiguous: number; willFillPhone: number; willFillEmail: number };
  rows: { row: number; status: string; reason: string | null; existingName: string | null; fillPhone: boolean; fillEmail: boolean }[];
};
type Commit = {
  summary: { total: number; created: number; matchExisting: number; filledPhone: number; filledEmail: number; skippedInvalid: number; skippedAmbiguous: number };
  rows: { row: number; status: string; reason: string | null }[];
};

const users: TestUser[] = [];
const tenants: string[] = [];
let owner: TestUser; // Emel: Owner and the only working person
let manager: TestUser;
let receptionist: TestUser;
let stylist: TestUser;
let otherOwner: TestUser;
let tenant: { id: string; slug: string };
let other: { id: string; slug: string };
let branchId: string;
let emelStaff: string;
let svc: Record<"kasLam" | "kirpikLam" | "kasAlimi" | "kasLamKasAlimi", string>;
const stamp = Math.random().toString(36).slice(2, 7);
let counter = 0;

async function at(day: string, time: string): Promise<string> {
  const [row] = await testDb<{ ts: string }[]>`select (((${day}::date + ${time}::time) at time zone ${TZ}) at time zone 'UTC')::text || '+00' as ts`;
  return row!.ts;
}

async function newUser(label: string): Promise<TestUser> {
  const u = await createTestUser(`c1a-${label}`);
  users.push(u);
  return u;
}

async function customer(tenantId: string, name: string, phone: string | null = null, email: string | null = null, notes: string | null = null): Promise<string> {
  const [c] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name, phone, email, notes) values (${tenantId}, ${name}, ${phone}, ${email}, ${notes}) returning id`;
  return c!.id;
}

async function book(
  t: { id: string },
  ownerId: string,
  bId: string,
  customerId: string,
  items: { staff: string; service: string }[],
  day: string | null,
  time: string,
  final: "completed" | "confirmed" | "cancelled" | "no_show" | "scheduled",
): Promise<string> {
  counter += 1;
  const future = safeMorningStart(3 + counter);
  const [row] = await asAuthenticatedUser(ownerId, (sql) =>
    sql<{ id: string }[]>`select public.create_appointment(${t.id}, ${bId}, ${customerId}, ${sql.json(
      items.map((it, i) => ({ service_id: it.service, staff_member_id: it.staff, scheduled_start_at: future.toISOString(), sequence: i + 1 })) as never,
    )}, 'GIZLI-RANDEVU-NOTU') as id`,
  );
  const id = row!.id;
  if (day) {
    const start = await at(day, time);
    await testDb`update appointment_items set scheduled_start_at = ${start}::text::timestamptz, scheduled_end_at = ${start}::text::timestamptz + interval '30 minutes' where appointment_id = ${id}`;
    await testDb`update appointments set scheduled_start_at = ${start}::text::timestamptz, scheduled_end_at = ${start}::text::timestamptz + interval '30 minutes' where id = ${id}`;
  }
  if (final === "completed") await asAuthenticatedUser(ownerId, (sql) => sql`select public.complete_appointment(${id}, '[]'::jsonb)`);
  else if (final !== "scheduled") await asAuthenticatedUser(ownerId, (sql) => sql`select public.update_appointment_status(${id}, ${final})`);
  return id;
}

async function payFor(ownerId: string, appointmentId: string, amount: number) {
  const [s] = await asAuthenticatedUser(ownerId, (sql) => sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`);
  await asAuthenticatedUser(ownerId, (sql) =>
    sql`select * from public.record_appointment_payment(${s!.id}, ${amount}, 'cash', now(), null, ${crypto.randomUUID()})`,
  );
}

async function salon(label: string, ownerUser: TestUser, staffName: string) {
  const t = await createTestTenant(`c1a-${label}-${stamp}`, ownerUser.id);
  tenants.push(t.id);
  await testDb`update tenants set timezone = ${TZ}, currency = 'TRY' where id = ${t.id}`;
  const b = await createBranch(t.id, "Merkez");
  const staff = await createStaffMember(t.id, staffName);
  await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff.id}, ${b})`;
  for (let w = 0; w <= 6; w++) await createStaffSchedule(t.id, staff.id, w, "00:00", "23:59");
  const mk = async (name: string, price: number) => {
    const s = await createService(t.id, name, 30, price); // 30 min is synthetic and test-only
    await testDb`insert into service_branches (service_id, branch_id) values (${s.id}, ${b})`;
    await testDb`insert into staff_services (staff_member_id, service_id) values (${staff.id}, ${s.id})`;
    return s.id;
  };
  return {
    t: { id: t.id, slug: t.slug },
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

const history = (userId: string, customerId: string, limit = 50) =>
  asAuthenticatedUser(userId, (sql) => sql<{ h: History }[]>`select public.get_customer_history(${customerId}, ${limit}) as h`).then((r) => r[0]!.h);
const preview = (userId: string, t: { id: string }, rows: Row[]) =>
  asAuthenticatedUser(userId, (sql) => sql<{ p: Preview }[]>`select public.preview_customer_import(${t.id}, ${sql.json(rows as never)}) as p`).then((r) => r[0]!.p);
const commit = (userId: string, t: { id: string }, rows: Row[]) =>
  asAuthenticatedUser(userId, (sql) => sql<{ c: Commit }[]>`select public.commit_customer_import(${t.id}, ${sql.json(rows as never)}) as c`).then((r) => r[0]!.c);
const countCustomers = async (t: { id: string }) => Number((await testDb<{ n: string }[]>`select count(*)::text as n from customers where tenant_id = ${t.id}`)[0]!.n);
const reasonOf = (p: Preview, row: number) => p.rows.find((r) => r.row === row)!;

let fx: Awaited<ReturnType<typeof salon>>;
let otherFx: Awaited<ReturnType<typeof salon>>;
let custA: string; // the Emel history customer
let custB: string; // a customer with ONE visit that has two services by two people
let secondStaff: string;

beforeAll(async () => {
  owner = await newUser("owner");
  manager = await newUser("manager");
  receptionist = await newUser("reception");
  stylist = await newUser("stylist");
  otherOwner = await newUser("other-owner");

  fx = await salon("emel", owner, "Emel Kaynakkan");
  tenant = fx.t;
  branchId = fx.b;
  emelStaff = fx.staffId;
  svc = fx.svc;
  await testDb`update tenants set name = 'Emel Beauty Bar (test fixture)' where id = ${tenant.id}`;
  await testDb`update staff_members set tenant_membership_id = (select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${owner.id}) where id = ${emelStaff}`;
  await createTestMembershipFromTemplate(tenant.id, manager.id, "SALON_MANAGER");
  await createTestMembershipFromTemplate(tenant.id, receptionist.id, "RECEPTIONIST");
  await createTestMembershipFromTemplate(tenant.id, stylist.id, "STYLIST");

  otherFx = await salon("emel-other", otherOwner, "Baska Kisi");
  other = otherFx.t;

  // --- synthetic customer history: 2 completed visits, 1 upcoming, 1 cancelled, 1 no-show ---
  custA = await customer(tenant.id, "Sentetik Musteri Bir", "0533 111 22 33", "bir@example.test", "MUSTERI-NOTU-GIZLI");
  const v1 = await book(tenant, owner.id, branchId, custA, [{ staff: emelStaff, service: svc.kasLam }], DAY1, "10:00", "completed");
  await payFor(owner.id, v1, 2000);
  const v2 = await book(tenant, owner.id, branchId, custA, [{ staff: emelStaff, service: svc.kasAlimi }], DAY2, "11:00", "completed");
  await payFor(owner.id, v2, 300); // 600 charged, 300 received: 300 outstanding
  await book(tenant, owner.id, branchId, custA, [{ staff: emelStaff, service: svc.kirpikLam }], null, "00:00", "confirmed"); // future
  await book(tenant, owner.id, branchId, custA, [{ staff: emelStaff, service: svc.kasAlimi }], DAY_CANCEL, "12:00", "cancelled");
  await book(tenant, owner.id, branchId, custA, [{ staff: emelStaff, service: svc.kasAlimi }], DAY_NOSHOW, "12:00", "no_show");

  // --- a second customer: ONE visit with two services performed by two people ---
  const s2 = await createStaffMember(tenant.id, "Ikinci Kisi");
  secondStaff = s2.id;
  await testDb`insert into staff_branches (staff_member_id, branch_id) values (${secondStaff}, ${branchId})`;
  for (let w = 0; w <= 6; w++) await createStaffSchedule(tenant.id, secondStaff, w, "00:00", "23:59");
  await testDb`insert into staff_services (staff_member_id, service_id) values (${secondStaff}, ${svc.kasAlimi})`;
  custB = await customer(tenant.id, "Sentetik Musteri Iki", "0542 222 33 44");
  await book(tenant, owner.id, branchId, custB, [{ staff: emelStaff, service: svc.kasLam }, { staff: secondStaff, service: svc.kasAlimi }], DAY1, "14:00", "completed");
}, 300_000);

afterAll(async () => {
  await cleanupTenants(tenants);
  await cleanupUsers(users.map((u) => u.id));
}, 180_000);

describe("CUSTOMER HISTORY — the Emel Beauty Bar single-person model (all customers and transactions synthetic)", () => {
  it("summary: 2 completed visits, 1 upcoming, 1 cancelled, 1 no-show, last visit = the second completed visit", async () => {
    const h = await history(owner.id, custA);
    expect(h.summary).toMatchObject({ completedVisits: 2, upcoming: 1, cancelled: 1, noShow: 1, total: 5 });
    expect(new Date(h.summary.lastVisitAt!).toISOString()).toBe(new Date((await at(DAY2, "11:00")).replace("+00", "Z")).toISOString());
  });

  it("upcoming: the one future Kirpik Laminasyonu, confirmed, with its service and the single staff member", async () => {
    const h = await history(owner.id, custA);
    expect(h.upcoming).toHaveLength(1);
    expect(h.upcoming[0]).toMatchObject({ status: "confirmed", items: [{ service: "Kirpik Laminasyonu", staff: "Emel Kaynakkan" }] });
    expect(new Date(h.upcoming[0]!.startAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("past: newest first — no-show, cancelled, Kaş Alımı, Kaş Laminasyonu — each with date, service, staff, status", async () => {
    const h = await history(owner.id, custA);
    expect(h.past.map((p) => [p.status, p.items[0]!.service])).toEqual([
      ["no_show", "Kaş Alımı"],
      ["cancelled", "Kaş Alımı"],
      ["completed", "Kaş Alımı"],
      ["completed", "Kaş Laminasyonu"],
    ]);
    expect(h.past.every((p) => p.items.every((i) => i.staff === "Emel Kaynakkan"))).toBe(true);
    expect(h.hasMorePast).toBe(false);
  });

  it("services received (completed only) and the staff who performed them: one person, two items, not doubled", async () => {
    const h = await history(owner.id, custA);
    expect(h.servicesReceived).toEqual([
      { service: "Kaş Alımı", count: 1 },
      { service: "Kaş Laminasyonu", count: 1 },
    ]);
    expect(h.staff).toEqual([{ displayName: "Emel Kaynakkan", count: 2 }]); // Owner and staff are the same person: one row
  });

  it("a cancelled or no-show visit is never a completed visit and never a performed service", async () => {
    const h = await history(owner.id, custA);
    expect(h.summary.completedVisits).toBe(2);
    expect(h.servicesReceived.reduce((n, s) => n + s.count, 0)).toBe(2);
  });

  it("a visit with two services by two people counts as ONE visit; each person and each service once", async () => {
    const h = await history(owner.id, custB);
    expect(h.summary).toMatchObject({ completedVisits: 1, total: 1 });
    expect(h.past[0]!.items).toEqual([
      { service: "Kaş Laminasyonu", staff: "Emel Kaynakkan" },
      { service: "Kaş Alımı", staff: "Ikinci Kisi" },
    ]);
    expect(h.staff).toEqual([
      { displayName: "Emel Kaynakkan", count: 1 },
      { displayName: "Ikinci Kisi", count: 1 },
    ]);
  });

  it("Owner (finance.view): completed value 2,000 + 600 = 2,600 and the 300 still outstanding; per-visit amounts only for finance", async () => {
    const h = await history(owner.id, custA);
    expect(h.finance).toEqual({ completedAmount: 2600, outstanding: 300, completedWithoutCheckout: 0, currency: "TRY" });
    const alimi = h.past.find((p) => p.status === "completed" && p.items[0]!.service === "Kaş Alımı")!;
    expect(alimi).toMatchObject({ amount: 600, hasCheckout: true, paid: 300, outstanding: 300 });
    expect(h.upcoming[0]!.amount).toBe(2000); // list price of the future visit, informational
  });

  it("Yönetici and Resepsiyon (customers.view + appointments.view, NO finance.view) get the history without ANY money", async () => {
    for (const u of [manager, receptionist]) {
      const h = await history(u.id, custA);
      expect(h.finance, u.email).toBeNull();
      expect(h.summary.completedVisits).toBe(2);
      const text = JSON.stringify(h);
      for (const key of ['"amount"', '"paid"', '"outstanding"', '"hasCheckout"', "completedAmount"]) expect(text, `${u.email} ${key}`).not.toContain(key);
    }
  });

  it("Personel (no customers.view) is refused; the Owner of another salon is refused; anon and service_role cannot execute; no session is refused", async () => {
    expect(await attemptAs(stylist.id, (sql) => sql`select public.get_customer_history(${custA}, 10)`)).toMatchObject({ ok: false, code: "CH002" });
    expect(await attemptAs(otherOwner.id, (sql) => sql`select public.get_customer_history(${custA}, 10)`)).toMatchObject({ ok: false, code: "CH002" });
    expect(await attemptAs(owner.id, (sql) => sql`select public.get_customer_history('00000000-0000-4000-8000-000000000000', 10)`)).toMatchObject({ ok: false, code: "CH002" });
    for (const role of ["anon", "service_role"] as const) {
      await expect(asDatabaseRole(role, null, (sql) => sql`select public.get_customer_history(${custA}, 10)`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asDatabaseRole("authenticated", null, (sql) => sql`select public.get_customer_history(${custA}, 10)`)).rejects.toMatchObject({ code: "CH001" });
  });

  it("PRIVACY: no appointment notes, no customer notes, no ids, no contact data in the history", async () => {
    const h = await history(owner.id, custA);
    const text = JSON.stringify(h);
    for (const secret of ["GIZLI-RANDEVU-NOTU", "MUSTERI-NOTU-GIZLI", custA, tenant.id, branchId, emelStaff, owner.id, "0533", "bir@example.test"]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(Object.keys(h).sort()).toEqual(["finance", "hasMorePast", "past", "servicesReceived", "staff", "summary", "timezone", "upcoming"]);
  });

  it("only THIS customer's visits: another customer of the same salon and the same name in another salon never mix in", async () => {
    const twin = await customer(other.id, "Sentetik Musteri Bir", "0533 111 22 33", "bir@example.test");
    await book(other, otherOwner.id, otherFx.b, twin, [{ staff: otherFx.staffId, service: otherFx.svc.kasLam }], DAY1, "10:00", "completed");
    expect((await history(owner.id, custA)).summary.total).toBe(5);
    expect((await history(otherOwner.id, twin)).summary).toMatchObject({ completedVisits: 1, total: 1 });
    expect((await history(owner.id, custB)).summary.total).toBe(1);
  });

  it("the past list is capped by the limit and says there is more", async () => {
    const h = await history(owner.id, custA, 2);
    expect(h.past).toHaveLength(2);
    expect(h.hasMorePast).toBe(true);
  });

  it("a visit completed without a checkout carries its list price and is counted as 'no checkout', never as outstanding", async () => {
    const c = await customer(tenant.id, "Sentetik Musteri Uc", "0555 333 44 55");
    await book(tenant, owner.id, branchId, c, [{ staff: emelStaff, service: svc.kasLamKasAlimi }], DAY1, "16:00", "completed");
    const h = await history(owner.id, c);
    expect(h.finance).toMatchObject({ completedAmount: 2500, outstanding: 0, completedWithoutCheckout: 1 });
    expect(h.past[0]).toMatchObject({ hasCheckout: false, paid: null, outstanding: null, amount: 2500 });
  });
});

describe("CANONICAL PHONE — one central rule for Türkiye / KKTC forms (previously four different customers)", () => {
  const norm = async (p: string | null) => (await testDb<{ v: string | null }[]>`select private.normalize_phone(${p}) as v`)[0]!.v;

  it("the five ways people write the same mobile number are one canonical value", async () => {
    for (const form of ["0533 123 45 67", "+90 533 123 45 67", "90 533 123 45 67", "533 123 45 67", "(0533) 123-45-67", "0090 533 123 45 67", "05331234567"]) {
      expect(await norm(form), form).toBe("+905331234567");
    }
  });

  it("KKTC landlines (0392 / +90 392) match each other; a bare 10-digit landline is NOT guessed", async () => {
    expect(await norm("0392 223 12 34")).toBe("+903922231234");
    expect(await norm("+90 392 223 12 34")).toBe("+903922231234");
    expect(await norm("392 223 12 34")).toBe("3922231234"); // left as typed: not invented
  });

  it("other countries are left alone: formatting stripped only; +44 stays; a UK 07... number is not turned into a Turkish one", async () => {
    expect(await norm("+44 7911 123456")).toBe("+447911123456");
    expect(await norm("07911 123456")).toBe("07911123456");
    expect(await norm("0049 170 1234567")).toBe("+491701234567");
  });

  it("empty and junk give null; the function is idempotent; two numbers that matched before (same stripped digits) still match", async () => {
    for (const bad of [null, "", "   ", "abc"]) expect(await norm(bad)).toBeNull();
    for (const p of ["0533 123 45 67", "+90 533 123 45 67", "+44 7911 123456", "07911 123456", "3922231234"]) {
      const once = await norm(p);
      expect(await norm(once)).toBe(once);
    }
    const [r] = await testDb<{ same: boolean }[]>`select private.normalize_phone('0533-123-45-67') = private.normalize_phone('0533 123 45 67') as same`;
    expect(r!.same).toBe(true);
  });

  it("the stored generated column follows: a customer saved as 0533... is stored under the canonical value", async () => {
    const id = await customer(tenant.id, "Sentetik Kanon", "0533 987 65 43");
    const [c] = await testDb<{ phone: string; phone_normalized: string }[]>`select phone, phone_normalized from customers where id = ${id}`;
    expect(c).toEqual({ phone: "0533 987 65 43", phone_normalized: "+905339876543" });
    await testDb`delete from customers where id = ${id}`;
  });

  it("a staff member (no access to the private schema) can still write a customer: the canonical value is computed with the writer's own privileges", async () => {
    const out = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ phone_normalized: string }[]>`insert into customers (tenant_id, full_name, phone) values (${tenant.id}, 'Sentetik Yazma', '0533 000 11 22') returning phone_normalized`,
    );
    expect(out[0]!.phone_normalized).toBe("+905330001122");
    await testDb`delete from customers where tenant_id = ${tenant.id} and full_name = 'Sentetik Yazma'`;
  });

  it("staff search keeps finding a number typed the way people type it, including a partial 0-prefixed one", async () => {
    const find = (q: string) => asAuthenticatedUser(owner.id, (sql) => sql<{ full_name: string }[]>`select full_name from public.search_customers(${tenant.id}, ${q}, 'all', 30, 0)`).then((r) => r.map((x) => x.full_name));
    expect(await find("0533 111")).toContain("Sentetik Musteri Bir");
    expect(await find("+90 533 111 22 33")).toContain("Sentetik Musteri Bir");
    expect(await find("533 111 22")).toContain("Sentetik Musteri Bir");
    expect(await find("Sentetik Musteri Iki")).toEqual(["Sentetik Musteri Iki"]);
  });

  it("PUBLIC BOOKING reuses the customer across the formats (it no longer creates a duplicate for +90 vs 0)", async () => {
    await testDb`insert into tenant_features (tenant_id, feature_id, enabled) select ${tenant.id}, f.id, true from features f where f.key = 'online_booking' on conflict (tenant_id, feature_id) do update set enabled = true`;
    const name = "Sentetik Misafir";
    const [one, two] = [safeMorningStart(40), safeMorningStart(41)];
    for (const [phone, when] of [["0544 777 88 99", one], ["+90 544 777 88 99", two]] as const) {
      await testDb`select public.create_guest_booking(${tenant.slug}, ${branchId}, ${svc.kasAlimi}, ${when.toISOString()}::text::timestamptz, ${name}, ${phone}, ${emelStaff}, 'misafir@example.test')`;
    }
    const rows = await testDb<{ n: string }[]>`select count(*)::text as n from customers where tenant_id = ${tenant.id} and full_name = ${name}`;
    expect(rows[0]!.n).toBe("1");
    const [apps] = await testDb<{ n: string }[]>`select count(distinct a.id)::text as n from appointments a join customers c on c.id = a.customer_id where c.tenant_id = ${tenant.id} and c.full_name = ${name}`;
    expect(apps!.n).toBe("2");
  });
});

describe("IMPORT — preview classifies, commit imports only what is safe", () => {
  let t: { id: string; slug: string };
  let o: TestUser;
  let before: number;

  beforeAll(async () => {
    o = await newUser("imp-owner");
    const f = await salon("imp", o, "Ithalat Kisi");
    t = f.t;
    await customer(t.id, "Ayse Demir", "0533 111 22 33", "ayse@example.test");
    await customer(t.id, "Mehmet Kaya", "+90 542 222 33 44", null);
    await customer(t.id, "Zeynep Arslan", null, "zeynep@example.test");
    await customer(t.id, "Eski Arsivli", "0555 000 11 22", null);
    await testDb`update customers set status = 'archived' where tenant_id = ${t.id} and full_name = 'Eski Arsivli'`;
    await customer(t.id, "Aile Uyesi Bir", "0532 900 00 01", null);
    await customer(t.id, "Aile Uyesi Iki", "0532 900 00 01", null);
    before = await countCustomers(t);
  });

  it("classifies every kind of row with a row number and a reason, and writes NOTHING", async () => {
    const rows: Row[] = [
      { row: 2, name: "Yeni Kisi", phone: "0544 100 20 30", email: "yeni@example.test" }, // NEW
      { row: 3, name: "AYSE DEMIR", phone: "+90 533 111 22 33" }, // same person, other formatting and case -> MATCH
      { row: 4, name: "Ayse Demir", phone: "90 533 111 22 33" }, // second copy inside the file
      { row: 5, name: "Baska Ayse", phone: "533 111 22 33" }, // same phone, other name
      { row: 6, name: "", phone: "0533 000 00 00" }, // no name
      { row: 7, name: "Telefonsuz Eposta" }, // no contact
      { row: 8, name: "Kotu Telefon", phone: "12" }, // invalid phone
      { row: 9, name: "Kotu Eposta", email: "yok" }, // invalid email
      { row: 10, name: "Mehmet Kaya", phone: "0542 222 33 44", email: "mehmet@example.test" }, // MATCH + fill empty email
      { row: 11, name: "Zeynep Arslan", phone: "0541 555 66 77", email: "ZEYNEP@example.test" }, // MATCH by e-mail + fill empty phone
      { row: 12, name: "Eski Arsivli", phone: "+90 555 000 11 22" }, // archived match
      { row: 13, name: "Aile Uyesi Uc", phone: "0532 900 00 01" }, // phone shared by two other names
      { row: 14, name: "Aile Uyesi Bir", phone: "0532 900 00 01" }, // phone matches ONE same-name customer
      { row: 15, name: "Ayse Demir", email: "zeynep@example.test" }, // e-mail of another name AND phone-less
    ];
    const p = await preview(o.id, t, rows);
    const s = (r: number) => `${reasonOf(p, r).status}:${reasonOf(p, r).reason ?? ""}`;
    expect(s(2)).toBe("NEW:");
    expect(s(3)).toBe("MATCH_EXISTING:");
    expect(reasonOf(p, 3).existingName).toBe("Ayse Demir");
    expect(s(4)).toBe("INVALID:duplicate_in_file");
    expect(s(5)).toBe("AMBIGUOUS:phone_other_name"); // the phone belongs to an existing customer under another name
    expect(s(6)).toBe("INVALID:name_missing");
    expect(s(7)).toBe("INVALID:contact_missing");
    expect(s(8)).toBe("INVALID:phone_invalid");
    expect(s(9)).toBe("INVALID:email_invalid");
    expect(s(10)).toBe("MATCH_EXISTING:");
    expect(reasonOf(p, 10).fillEmail).toBe(true);
    expect(s(11)).toBe("MATCH_EXISTING:");
    expect(reasonOf(p, 11)).toMatchObject({ fillPhone: true, fillEmail: false });
    expect(s(12)).toBe("MATCH_EXISTING:"); // archived: matched, never re-created
    expect(s(13)).toBe("AMBIGUOUS:phone_other_name");
    expect(s(14)).toBe("MATCH_EXISTING:");
    expect(s(15)).toBe("AMBIGUOUS:email_other_name");
    expect(p.summary).toMatchObject({ total: 14, new: 1, matchExisting: 5, invalid: 5, ambiguous: 3, willFillPhone: 1, willFillEmail: 1 });
    expect(p.maxRows).toBe(5000);
    expect(await countCustomers(t)).toBe(before); // a preview commits nothing
  });

  it("the same name never merges two people: identical names with different contact are two new customers; name alone is refused", async () => {
    const p = await preview(o.id, t, [
      { row: 1, name: "Ayse Demir", phone: "0546 700 00 01" }, // same name, another phone -> a different person
      { row: 2, name: "Ayse Demir", phone: "0546 700 00 02" },
      { row: 3, name: "Ayse Demir" },
    ]);
    expect(p.rows.map((r) => r.status)).toEqual(["NEW", "NEW", "INVALID"]);
  });

  it("commit imports the safe rows atomically, fills only EMPTY fields, never overwrites, and reports what it skipped", async () => {
    const rows: Row[] = [
      { row: 2, name: "Yeni Kisi", phone: "0544 100 20 30", email: "yeni@example.test" },
      { row: 3, name: "AYSE DEMIR", phone: "+90 533 111 22 33", email: "baska@example.test" }, // existing has an e-mail: must stay
      { row: 4, name: "Ayse Demir", phone: "90 533 111 22 33" },
      { row: 10, name: "Mehmet Kaya", phone: "0542 222 33 44", email: "mehmet@example.test" },
      { row: 11, name: "Zeynep Arslan", phone: "0541 555 66 77", email: "ZEYNEP@example.test" },
      { row: 13, name: "Aile Uyesi Uc", phone: "0532 900 00 01" },
      { row: 8, name: "Kotu Telefon", phone: "12" },
    ];
    const c = await commit(o.id, t, rows);
    expect(c.summary).toMatchObject({ total: 7, created: 1, matchExisting: 3, filledPhone: 1, filledEmail: 1, skippedInvalid: 2, skippedAmbiguous: 1 });
    expect(c.rows.map((r) => [r.row, r.status, r.reason])).toEqual([
      [4, "INVALID", "duplicate_in_file"],
      [8, "INVALID", "phone_invalid"],
      [13, "AMBIGUOUS", "phone_other_name"],
    ]);
    expect(await countCustomers(t)).toBe(before + 1);
    const get = (n: string) => testDb<{ phone: string | null; email: string | null }[]>`select phone, email from customers where tenant_id = ${t.id} and full_name = ${n}`.then((r) => r[0]!);
    expect(await get("Ayse Demir")).toEqual({ phone: "0533 111 22 33", email: "ayse@example.test" }); // untouched, not overwritten
    expect(await get("Mehmet Kaya")).toEqual({ phone: "+90 542 222 33 44", email: "mehmet@example.test" });
    expect(await get("Zeynep Arslan")).toEqual({ phone: "0541 555 66 77", email: "zeynep@example.test" }); // phone filled; the existing e-mail kept as it was
    expect((await get("Yeni Kisi")).email).toBe("yeni@example.test");
  });

  it("IDEMPOTENT: the same file again creates nothing and changes nothing", async () => {
    const rows: Row[] = [
      { row: 2, name: "Yeni Kisi", phone: "0544 100 20 30", email: "yeni@example.test" },
      { row: 10, name: "Mehmet Kaya", phone: "0542 222 33 44", email: "mehmet@example.test" },
      { row: 11, name: "Zeynep Arslan", phone: "0541 555 66 77", email: "ZEYNEP@example.test" },
    ];
    const snapshot = async () => testDb`select id, full_name, phone, email, status, updated_at from customers where tenant_id = ${t.id} order by id`;
    const first = await snapshot();
    const again = await commit(o.id, t, rows);
    expect(again.summary).toMatchObject({ created: 0, filledPhone: 0, filledEmail: 0, matchExisting: 3 });
    expect(await snapshot()).toEqual(first);
    const third = await commit(o.id, t, rows);
    expect(third.summary.created).toBe(0);
  });

  it("retry after a failed attempt is safe: a refused or failing import leaves nothing behind and the retry works", async () => {
    const good: Row[] = [{ row: 2, name: "Yeniden Deneme", phone: "0547 800 90 10" }];
    const n = await countCustomers(t);
    // a malformed request is refused before anything is written
    expect(await attemptAs(o.id, (sql) => sql`select public.commit_customer_import(${t.id}, ${sql.json([{ row: 1, name: "X", phone: "0547 800 90 10" }, { name: "no row number" }] as never)})`)).toMatchObject({ ok: false, code: "CI012" });
    expect(await countCustomers(t)).toBe(n);
    expect((await commit(o.id, t, good)).summary.created).toBe(1);
    expect((await commit(o.id, t, good)).summary.created).toBe(0);
    expect(await countCustomers(t)).toBe(n + 1);
  });

  it("an import is audited with COUNTS ONLY (no name, phone or e-mail in the summary event)", async () => {
    const events = await auditRows(t.id, "customers.import_committed");
    expect(events.length).toBeGreaterThan(0);
    const text = JSON.stringify(events);
    for (const secret of ["Yeni Kisi", "0544", "yeni@example.test", "Mehmet"]) expect(text).not.toContain(secret);
    expect(events[0]!.after).toMatchObject({ total: expect.any(Number), created: expect.any(Number) });
  });

  it("the row limit: 5,000 accepted (and fast), 5,001 and 0 refused", async () => {
    const big: Row[] = Array.from({ length: 5000 }, (_, i) => ({ row: i + 2, name: `Toplu Kisi ${i}`, phone: `054${String(1000000 + i).padStart(7, "0")}` }));
    const started = performance.now();
    const p = await preview(o.id, t, big);
    expect(p.summary).toMatchObject({ total: 5000, new: 5000 });
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(await attemptAs(o.id, (sql) => sql`select public.preview_customer_import(${t.id}, ${sql.json([...big, { row: 9999, name: "x", phone: "0540 000 00 00" }] as never)})`)).toMatchObject({ ok: false, code: "CI012" });
    expect(await attemptAs(o.id, (sql) => sql`select public.preview_customer_import(${t.id}, '[]'::jsonb)`)).toMatchObject({ ok: false, code: "CI012" });
    const c = await commit(o.id, t, big);
    expect(c.summary.created).toBe(5000);
    expect((await commit(o.id, t, big)).summary.created).toBe(0);
  }, 120_000);

  it("TENANT SCOPE: the same phone in another salon is a separate customer; the other salon's data is never matched", async () => {
    const o2 = await newUser("imp-owner2");
    const f2 = await salon("imp2", o2, "Baska Salon Kisi");
    await customer(f2.t.id, "Ayse Demir", "0533 111 22 33", "ayse@example.test"); // the same person in ANOTHER salon
    const before1 = await countCustomers(t);
    const p = await preview(o2.id, f2.t, [{ row: 2, name: "Yeni Kisi", phone: "0544 100 20 30" }, { row: 3, name: "Ayse Demir", phone: "+90 533 111 22 33" }]);
    expect(p.rows.map((r) => r.status)).toEqual(["NEW", "MATCH_EXISTING"]); // "Yeni Kisi" exists in salon t, but not here
    expect((await commit(o2.id, f2.t, [{ row: 2, name: "Yeni Kisi", phone: "0544 100 20 30" }])).summary.created).toBe(1);
    expect(await countCustomers(t)).toBe(before1); // nothing leaked into the first salon
    const same = await testDb<{ n: string }[]>`select count(*)::text as n from customers where phone_normalized = '+905441002030'`;
    expect(Number(same[0]!.n)).toBeGreaterThanOrEqual(2); // two salons, two separate records
  });

  it("AUTHORIZATION: only the Owner imports; Yönetici, Resepsiyon, Personel, another salon's Owner, anon and service_role are refused", async () => {
    const rows: Row[] = [{ row: 2, name: "Yetkisiz", phone: "0540 123 45 67" }];
    await createTestMembershipFromTemplate(t.id, manager.id, "SALON_MANAGER");
    await createTestMembershipFromTemplate(t.id, receptionist.id, "RECEPTIONIST");
    await createTestMembershipFromTemplate(t.id, stylist.id, "STYLIST");
    const n = await countCustomers(t);
    for (const u of [manager, receptionist, stylist, otherOwner]) {
      for (const fn of ["preview_customer_import", "commit_customer_import"]) {
        const out = await attemptAs(u.id, (sql) => sql.unsafe(`select public.${fn}($1::uuid, $2::text::jsonb)`, [t.id, JSON.stringify(rows)] as never[]));
        expect(out, `${u.email} ${fn}`).toMatchObject({ ok: false, code: "CI011" });
      }
    }
    expect(await countCustomers(t)).toBe(n);
    for (const role of ["anon", "service_role"] as const) {
      await expect(asDatabaseRole(role, null, (sql) => sql.unsafe(`select public.commit_customer_import($1::uuid, '[]'::jsonb)`, [t.id] as never[]))).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asDatabaseRole("authenticated", null, (sql) => sql.unsafe(`select public.preview_customer_import($1::uuid, '[]'::jsonb)`, [t.id] as never[]))).rejects.toMatchObject({ code: "CI010" });
    for (const fn of ["private.classify_customer_import(uuid, jsonb)", "private.commit_customer_import(uuid, jsonb)", "private.customer_history(uuid, integer)"]) {
      const [r] = await testDb<{ a: boolean }[]>`select has_function_privilege('authenticated', ${fn}, 'execute') as a`;
      expect(r!.a, fn).toBe(false);
    }
  });

  it("the response carries no internal identifiers", async () => {
    const p = await preview(o.id, t, [{ row: 2, name: "Ayse Demir", phone: "0533 111 22 33" }]);
    const text = JSON.stringify(p);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toContain(t.id);
    expect(Object.keys(p).sort()).toEqual(["maxRows", "rows", "summary"]);
    expect(Object.keys(p.rows[0]!).sort()).toEqual(["existingName", "fillEmail", "fillPhone", "reason", "row", "status"]);
  });
});
