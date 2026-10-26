import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
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
  createTestTenant,
  createTestUser,
  safeMorningStart,
  testDb,
  type TestUser,
} from "./helpers";

/**
 * Faz CUST.1A — the finer rules of the history read model and of the import, one behaviour per test (every test here
 * exists because removing the rule it pins was found to go unnoticed). Real facts: Emel Beauty Bar, one working person and
 * four services. EVERYTHING else — customers, phones, e-mails, dates, statuses, payments — is synthetic.
 */

const TZ = "Europe/Nicosia";
type Row = { row: number; name: string; phone?: string; email?: string };
type Preview = {
  summary: { total: number; new: number; matchExisting: number; invalid: number; ambiguous: number; willFillPhone: number; willFillEmail: number };
  rows: { row: number; status: string; reason: string | null; existingName: string | null; fillPhone: boolean; fillEmail: boolean }[];
};
type Commit = { summary: Record<string, number>; rows: { row: number; status: string; reason: string | null }[] };
type History = {
  summary: { completedVisits: number; upcoming: number; cancelled: number; noShow: number; total: number };
  upcoming: { status: string }[];
  past: { status: string; amount?: number; hasCheckout?: boolean; paid?: number | null; outstanding?: number | null; items: { service: string; staff: string | null }[] }[];
  staff: { displayName: string; count: number }[];
  finance: { completedAmount: number; outstanding: number; completedWithoutCheckout: number } | null;
};

const users: TestUser[] = [];
const tenants: string[] = [];
const stamp = Math.random().toString(36).slice(2, 7);
let counter = 0;

async function newUser(label: string): Promise<TestUser> {
  const u = await createTestUser(`c1r-${label}`);
  users.push(u);
  return u;
}

async function at(day: string, time: string): Promise<string> {
  const [row] = await testDb<{ ts: string }[]>`select (((${day}::date + ${time}::time) at time zone ${TZ}) at time zone 'UTC')::text || '+00' as ts`;
  return row!.ts;
}

async function salon(label: string, owner: TestUser, staffName: string) {
  const t = await createTestTenant(`c1r-${label}-${stamp}`, owner.id);
  tenants.push(t.id);
  await testDb`update tenants set timezone = ${TZ}, currency = 'TRY' where id = ${t.id}`;
  const b = await createBranch(t.id, "Merkez");
  const staff = await createStaffMember(t.id, staffName);
  const second = await createStaffMember(t.id, `${staffName} Yardimcisi`);
  for (const s of [staff, second]) {
    await testDb`insert into staff_branches (staff_member_id, branch_id) values (${s.id}, ${b})`;
    for (let w = 0; w <= 6; w++) await createStaffSchedule(t.id, s.id, w, "00:00", "23:59");
  }
  const mk = async (name: string, price: number) => {
    const s = await createService(t.id, name, 30, price); // 30 minutes: synthetic, test-only
    await testDb`insert into service_branches (service_id, branch_id) values (${s.id}, ${b})`;
    for (const p of [staff, second]) await testDb`insert into staff_services (staff_member_id, service_id) values (${p.id}, ${s.id})`;
    return s.id;
  };
  return { t: { id: t.id, slug: t.slug }, b, emel: staff.id, helper: second.id, svc: { kasLam: await mk("Kaş Laminasyonu", 2000), kasAlimi: await mk("Kaş Alımı", 600) } };
}

async function customer(tenantId: string, name: string, phone: string | null = null, email: string | null = null): Promise<string> {
  const [c] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name, phone, email) values (${tenantId}, ${name}, ${phone}, ${email}) returning id`;
  return c!.id;
}

async function book(
  fx: Awaited<ReturnType<typeof salon>>,
  ownerId: string,
  customerId: string,
  staff: string,
  service: string,
  day: string | null,
  time: string,
  final: "completed" | "cancelled" | "no_show" | "scheduled",
  actual?: string,
): Promise<string> {
  counter += 1;
  const future = safeMorningStart(3 + counter);
  const [row] = await asAuthenticatedUser(ownerId, (sql) =>
    sql<{ id: string }[]>`select public.create_appointment(${fx.t.id}, ${fx.b}, ${customerId}, ${sql.json([{ service_id: service, staff_member_id: staff, scheduled_start_at: future.toISOString(), sequence: 1 }] as never)}) as id`,
  );
  const id = row!.id;
  if (day) {
    const start = await at(day, time);
    await testDb`update appointment_items set scheduled_start_at = ${start}::text::timestamptz, scheduled_end_at = ${start}::text::timestamptz + interval '30 minutes' where appointment_id = ${id}`;
    await testDb`update appointments set scheduled_start_at = ${start}::text::timestamptz, scheduled_end_at = ${start}::text::timestamptz + interval '30 minutes' where id = ${id}`;
  }
  if (final === "completed") {
    const [item] = await testDb<{ id: string }[]>`select id from appointment_items where appointment_id = ${id}`;
    const overrides = actual ? [{ appointment_item_id: item!.id, actual_staff_member_id: actual }] : [];
    await asAuthenticatedUser(ownerId, (sql) => sql`select public.complete_appointment(${id}, ${sql.json(overrides as never)})`);
  } else if (final !== "scheduled") {
    await asAuthenticatedUser(ownerId, (sql) => sql`select public.update_appointment_status(${id}, ${final})`);
  }
  return id;
}

async function sale(ownerId: string, appointmentId: string, discount = 0): Promise<string> {
  const [s] = await asAuthenticatedUser(ownerId, (sql) => sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${appointmentId})`);
  if (discount > 0) {
    const items = await testDb<{ id: string; unit_price: string }[]>`select id, unit_price::text from appointment_sale_items where sale_id = ${s!.id}`;
    const priced = items.map((i) => ({ sale_item_id: i.id, unit_price: Number(i.unit_price) }));
    await asAuthenticatedUser(ownerId, (sql) => sql`select * from public.update_appointment_sale_pricing(${s!.id}, ${sql.json(priced as never)}, ${discount}, 'test')`);
  }
  return s!.id;
}

async function pay(ownerId: string, saleId: string, amount: number): Promise<string> {
  const [p] = await asAuthenticatedUser(ownerId, (sql) =>
    sql<{ id: string }[]>`select * from public.record_appointment_payment(${saleId}, ${amount}, 'cash', now(), null, ${crypto.randomUUID()})`,
  );
  return p!.id;
}

const history = (userId: string, customerId: string) =>
  asAuthenticatedUser(userId, (sql) => sql<{ h: History }[]>`select public.get_customer_history(${customerId}, 50) as h`).then((r) => r[0]!.h);
const preview = (userId: string, t: { id: string }, rows: Row[]) =>
  asAuthenticatedUser(userId, (sql) => sql<{ p: Preview }[]>`select public.preview_customer_import(${t.id}, ${sql.json(rows as never)}) as p`).then((r) => r[0]!.p);
const commit = (userId: string, t: { id: string }, rows: Row[]) =>
  asAuthenticatedUser(userId, (sql) => sql<{ c: Commit }[]>`select public.commit_customer_import(${t.id}, ${sql.json(rows as never)}) as c`).then((r) => r[0]!.c);
const status = (p: Preview, row: number) => `${p.rows.find((r) => r.row === row)!.status}:${p.rows.find((r) => r.row === row)!.reason ?? ""}`;

let owner: TestUser;
let fx: Awaited<ReturnType<typeof salon>>;

beforeAll(async () => {
  owner = await newUser("owner");
  fx = await salon("emel", owner, "Emel Kaynakkan");
}, 180_000);

afterAll(async () => {
  await cleanupTenants(tenants);
  await cleanupUsers(users.map((u) => u.id));
}, 180_000);

describe("history — the finer rules (synthetic customer, Emel Beauty Bar model)", () => {
  let c: string;
  let discounted: string;
  let voidedPaymentVisit: string;

  beforeAll(async () => {
    c = await customer(fx.t.id, "Sentetik Ayrinti", "0538 700 00 01");
    await book(fx, owner.id, c, fx.emel, fx.svc.kasAlimi, "2026-08-05", "10:00", "scheduled"); // never completed, long past
    await book(fx, owner.id, c, fx.emel, fx.svc.kasAlimi, null, "00:00", "cancelled"); // cancelled, in the FUTURE
    await book(fx, owner.id, c, fx.emel, fx.svc.kasAlimi, "2026-09-26", "13:00", "no_show");
    await book(fx, owner.id, c, fx.emel, fx.svc.kasAlimi, "2026-09-26", "14:00", "no_show");
    // booked on the helper, performed by Emel (completion-time correction); paid in full, then the payment is voided
    voidedPaymentVisit = await book(fx, owner.id, c, fx.helper, fx.svc.kasAlimi, "2026-09-10", "10:00", "completed", fx.emel);
    const pid = await pay(owner.id, await sale(owner.id, voidedPaymentVisit), 600);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.void_appointment_payment(${pid}, 'yanlis')`);
    // a discounted checkout: list 2,000, charged 1,600, 1,000 received
    discounted = await book(fx, owner.id, c, fx.emel, fx.svc.kasLam, "2026-09-11", "10:00", "completed");
    await pay(owner.id, await sale(owner.id, discounted, 400), 1000);
  }, 180_000);

  it("a past appointment that was never completed is history, not 'upcoming'; a cancelled future one is not upcoming either", async () => {
    const h = await history(owner.id, c);
    expect(h.summary).toMatchObject({ upcoming: 0, completedVisits: 2, cancelled: 1, noShow: 2, total: 6 });
    expect(h.upcoming).toEqual([]);
    expect(h.past.map((p) => p.status).sort()).toEqual(["cancelled", "completed", "completed", "no_show", "no_show", "scheduled"]);
  });

  it("no-shows and cancellations are counted separately (2 and 1, not swapped)", async () => {
    const h = await history(owner.id, c);
    expect([h.summary.noShow, h.summary.cancelled]).toEqual([2, 1]);
  });

  it("the person shown is the one who PERFORMED the work, not the one it was booked on", async () => {
    const h = await history(owner.id, c);
    expect(h.staff).toEqual([{ displayName: "Emel Kaynakkan", count: 2 }]);
    const visit = h.past.find((p) => p.status === "completed" && p.items[0]!.service === "Kaş Alımı")!;
    expect(visit.items[0]!.staff).toBe("Emel Kaynakkan");
  });

  it("completed value uses the CHECKOUT total (1,600 after the discount), not the list price; a voided payment does not reduce what is outstanding", async () => {
    const h = await history(owner.id, c);
    expect(h.finance).toMatchObject({ completedAmount: 600 + 1600, outstanding: 600 + 600, completedWithoutCheckout: 0 });
    const disc = h.past.find((p) => p.items[0]!.service === "Kaş Laminasyonu")!;
    expect(disc).toMatchObject({ amount: 1600, paid: 1000, outstanding: 600, hasCheckout: true });
    const voided = h.past.find((p) => p.status === "completed" && p.items[0]!.service === "Kaş Alımı")!;
    expect(voided).toMatchObject({ amount: 600, paid: 0, outstanding: 600 });
  });

  it("a voided checkout (a reserved state) is shown as a visit without a checkout, at list price, and is not a balance", async () => {
    await testDb`update appointment_sales set status = 'voided' where appointment_id = ${discounted}`;
    try {
      const h = await history(owner.id, c);
      const disc = h.past.find((p) => p.items[0]!.service === "Kaş Laminasyonu")!;
      expect(disc).toMatchObject({ amount: 2000, hasCheckout: false, paid: null, outstanding: null });
      expect(h.finance).toMatchObject({ completedAmount: 600 + 2000, outstanding: 600, completedWithoutCheckout: 1 });
    } finally {
      await testDb`update appointment_sales set status = 'open' where appointment_id = ${discounted}`;
    }
  });

  it("corrupt cross-salon references never leak in: another salon's appointment pointing at this customer, or an item stamped with another salon", async () => {
    const o2 = await newUser("o2");
    const f2 = await salon("other", o2, "Baska Kisi");
    const twin = await customer(f2.t.id, "Baska Salon Musterisi", "0538 700 00 09");
    const foreignAppt = await book(f2, o2.id, twin, f2.emel, f2.svc.kasLam, "2026-09-12", "10:00", "completed");
    const before = await history(owner.id, c);
    await testDb`update appointments set customer_id = ${c} where id = ${foreignAppt}`;
    try {
      expect(await history(owner.id, c)).toEqual(before);
    } finally {
      await testDb`update appointments set customer_id = ${twin} where id = ${foreignAppt}`;
    }
    const [own] = await testDb<{ id: string }[]>`select ai.id from appointment_items ai join appointments a on a.id = ai.appointment_id where a.id = ${discounted}`;
    const stamped = await testDb`update appointment_items set tenant_id = ${f2.t.id} where id = ${own!.id}`.then(() => true, () => false);
    try {
      if (stamped) {
        const h = await history(owner.id, c);
        const disc = h.past.find((p) => p.status === "completed" && p.items.length === 0);
        expect(disc, "an item stamped with another salon is not listed").toBeTruthy();
      }
    } finally {
      if (stamped) await testDb`update appointment_items set tenant_id = ${fx.t.id} where id = ${own!.id}`;
    }
  });
});

describe("import — gate, validation, identity and enrichment details", () => {
  let t: { id: string; slug: string };
  let o: TestUser;

  beforeAll(async () => {
    o = await newUser("imp");
    const f = await salon("imp", o, "Ithalat Kisi");
    t = f.t;
    await customer(t.id, "Cift Kayit", "0530 111 00 00");
    await customer(t.id, "Cift Kayit", "0530 111 00 00");
    await customer(t.id, "Cakisan Kisi", "0530 111 00 01");
    await customer(t.id, "Cakisan Kisi", null, "cakisan@example.test");
    await customer(t.id, "Silinmis Kisi", "0530 111 00 02");
    await testDb`update customers set deleted_at = now() where tenant_id = ${t.id} and full_name = 'Silinmis Kisi'`;
    await customer(t.id, "Dolu Kisi", "0530 111 00 03", "dolu@example.test");
    await customer(t.id, "Bos Telefon", null, "bos@example.test");
  });

  it("the gate asks for ALL FOUR permissions: a role missing exactly one of view / create / update / settings.manage is refused, the full set passes", async () => {
    const roles: [string, string[], boolean][] = [
      ["no view", ["customers.create", "customers.update", "settings.manage"], false],
      ["no create", ["customers.view", "customers.update", "settings.manage"], false],
      ["no update", ["customers.view", "customers.create", "settings.manage"], false],
      ["no settings", ["customers.view", "customers.create", "customers.update"], false],
      ["all four", ["customers.view", "customers.create", "customers.update", "settings.manage"], true],
    ];
    for (const [label, keys, allowed] of roles) {
      const u = await newUser(`gate-${label.replace(/\W/g, "")}`);
      await addMembership(t.id, u.id, await createCustomRole(t.id, `Rol ${label}`, keys));
      for (const fn of ["preview_customer_import", "commit_customer_import"]) {
        const out = await attemptAs(u.id, (sql) => sql.unsafe(`select public.${fn}($1::uuid, $2::text::jsonb)`, [t.id, JSON.stringify([{ row: 2, name: "Kapi Denemesi", phone: "0530 999 00 00" }])] as never[]));
        if (allowed) expect(out, `${label} ${fn}`).toEqual({ ok: true });
        else expect(out, `${label} ${fn}`).toMatchObject({ ok: false, code: "CI011" });
      }
    }
  });

  it("anon and service_role cannot execute the preview, the commit or the history", async () => {
    for (const role of ["anon", "service_role"] as const) {
      for (const call of [
        `select public.preview_customer_import($1::uuid, '[]'::jsonb)`,
        `select public.commit_customer_import($1::uuid, '[]'::jsonb)`,
        `select public.get_customer_history($1::uuid, 10)`,
      ]) {
        await expect(asDatabaseRole(role, null, (sql) => sql.unsafe(call, [t.id] as never[])), `${role} ${call}`).rejects.toMatchObject({ code: "42501" });
      }
    }
  });

  it("limits: a 201-character name, a 6-digit phone and a 16-digit phone are INVALID (a 7- and a 15-digit number are fine)", async () => {
    const p = await preview(o.id, t, [
      { row: 2, name: "A".repeat(201), phone: "0530 222 00 01" },
      { row: 3, name: "Kisa Telefon", phone: "123456" },
      { row: 4, name: "Uzun Telefon", phone: "+1234567890123456" },
      { row: 5, name: "Yedi Hane", phone: "1234567" },
      { row: 6, name: "On Bes Hane", phone: "+123456789012345" },
      { row: 7, name: "A".repeat(200), phone: "0530 222 00 02" },
    ]);
    expect([2, 3, 4, 5, 6, 7].map((r) => status(p, r))).toEqual(["INVALID:name_too_long", "INVALID:phone_invalid", "INVALID:phone_invalid", "NEW:", "NEW:", "NEW:"]);
  });

  it("identity: another salon's customer is never matched by e-mail; a deleted customer is never matched; two existing records are 'multiple'; phone and e-mail of two different customers conflict", async () => {
    const o2 = await newUser("imp2");
    const f2 = await salon("imp2", o2, "Baska Kisi");
    await customer(f2.t.id, "Yabanci Kisi", null, "yabanci@example.test");
    const p = await preview(o.id, t, [
      { row: 2, name: "Yabanci Kisi", email: "yabanci@example.test" }, // exists only in ANOTHER salon
      { row: 3, name: "Silinmis Kisi", phone: "+90 530 111 00 02" }, // exists only as a deleted record
      { row: 4, name: "Cift Kayit", phone: "0530 111 00 00" }, // two live records with this name and phone
      { row: 5, name: "Cakisan Kisi", phone: "0530 111 00 01", email: "cakisan@example.test" }, // phone -> one record, e-mail -> another
    ]);
    expect([2, 3, 4, 5].map((r) => status(p, r))).toEqual(["NEW:", "NEW:", "AMBIGUOUS:multiple_existing", "AMBIGUOUS:conflicting_matches"]);
  });

  it("inside one file: the same phone or the same e-mail under two names is ambiguous; the same person twice by e-mail only is a duplicate", async () => {
    const p = await preview(o.id, t, [
      { row: 2, name: "Dosya Bir", phone: "0530 333 00 01" },
      { row: 3, name: "Dosya Iki", phone: "+90 530 333 00 01" }, // same phone, other name
      { row: 4, name: "Dosya Uc", email: "uc@example.test" },
      { row: 5, name: "Dosya Dort", email: "UC@example.test" }, // same e-mail, other name
      { row: 6, name: "Dosya Bes", email: "bes@example.test", phone: "0530 333 00 05" },
      { row: 7, name: "dosya bes", email: "bes@example.test", phone: "0530 333 00 06" }, // same person: same name, same e-mail, other phone
    ]);
    expect([2, 3, 4, 5, 6, 7].map((r) => status(p, r))).toEqual(["NEW:", "AMBIGUOUS:file_conflict", "NEW:", "AMBIGUOUS:file_conflict", "NEW:", "INVALID:duplicate_in_file"]);
  });

  it("enrichment fills EMPTY fields only: a customer with both phone and e-mail is never marked for filling; new customers are created active", async () => {
    const p = await preview(o.id, t, [
      { row: 2, name: "Dolu Kisi", email: "dolu@example.test", phone: "0555 444 00 01" }, // matched by e-mail; phone differs but exists
      { row: 3, name: "Dolu Kisi", phone: "0530 111 00 03", email: "baska@example.test" }, // matched by phone; e-mail differs but exists
      { row: 4, name: "Bos Telefon", email: "bos@example.test", phone: "0555 444 00 02" }, // matched by e-mail; phone EMPTY -> fill
    ]);
    expect(p.rows.map((r) => [r.row, r.status, r.fillPhone, r.fillEmail])).toEqual([
      [2, "MATCH_EXISTING", false, false],
      [3, "MATCH_EXISTING", false, false],
      [4, "MATCH_EXISTING", true, false],
    ]);
    expect(p.summary).toMatchObject({ willFillPhone: 1, willFillEmail: 0 });
    const created = await commit(o.id, t, [{ row: 2, name: "Aktif Olmali", phone: "0530 555 00 01" }]);
    expect(created.summary.created).toBe(1);
    const [row] = await testDb<{ status: string }[]>`select status from customers where tenant_id = ${t.id} and full_name = 'Aktif Olmali'`;
    expect(row!.status).toBe("active");
  });

  it("a refused (duplicate) row never inflates the 'will fill' counts of its twin", async () => {
    const p = await preview(o.id, t, [
      { row: 2, name: "Bos Telefon", email: "bos@example.test", phone: "0555 444 00 07" },
      { row: 3, name: "Bos Telefon", email: "bos@example.test", phone: "0555 444 00 08" },
    ]);
    expect(p.rows.map((r) => [r.status, r.fillPhone])).toEqual([["MATCH_EXISTING", true], ["INVALID", false]]);
    expect(p.summary.willFillPhone).toBe(1);
  });
});
