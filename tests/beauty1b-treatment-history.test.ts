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
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  safeMorningStart,
  testDb,
  type TestUser,
} from "./helpers";

/**
 * Faz BEAUTY.1B - treatment history, private treatment photos, rebooking window and quick-rebook defaults, against the real
 * database functions and (through a local stand-in of the Storage schema) the real bucket policies. The service names, the
 * single provider and the 4-8 week recommendation are the business's supplied facts; every customer, date, note, photo byte and
 * the other intervals are SYNTHETIC. Photos are tiny fake byte-less rows: only their metadata matters to the database.
 */

const TZ = "Europe/Nicosia";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

type Hist = {
  today: string; timezone: string; canSeeValue: boolean; hasMore: boolean;
  items: {
    itemId: string; appointmentId: string; date: string; serviceId: string; serviceName: string; staffName: string | null;
    value: string | null; note: string | null; media: { id: string; kind: string; createdAt: string }[];
    rebook: null | { minDays: number; maxDays: number | null; windowStart: string; windowEnd: string | null; state: string };
  }[];
};

const users: TestUser[] = [];
const tenants: string[] = [];
const stamp = Math.random().toString(36).slice(2, 7);
let counter = 0;

async function user(label: string): Promise<TestUser> {
  const u = await createTestUser(`bb-${label}`);
  users.push(u);
  return u;
}

async function dayOffset(n: number, tz = TZ): Promise<string> {
  const [r] = await testDb<{ d: string }[]>`select (((now() at time zone ${tz})::date) + ${n}::int)::text as d`;
  return r!.d;
}
async function at(day: string, time: string): Promise<string> {
  const [row] = await testDb<{ ts: string }[]>`select (((${day}::date + ${time}::time) at time zone ${TZ}) at time zone 'UTC')::text || '+00' as ts`;
  return row!.ts;
}

type Fx = { t: { id: string; slug: string }; ownerId: string; branch: string; staff: Record<string, string>; svc: Record<string, string> };

async function salon(label: string, owner: TestUser, staffNames: string[], services: [string, number, number | null, number | null][]): Promise<Fx> {
  const t = await createTestTenant(`bb-${label}-${stamp}`, owner.id);
  tenants.push(t.id);
  await testDb`update tenants set timezone = ${TZ}, currency = 'TRY' where id = ${t.id}`;
  const branch = await createBranch(t.id, "Merkez");
  const staff: Record<string, string> = {};
  for (const n of staffNames) {
    const s = await createStaffMember(t.id, n);
    staff[n] = s.id;
    await linkStaffBranch(s.id, branch);
    for (let w = 0; w <= 6; w++) await createStaffSchedule(t.id, s.id, w, "00:00", "23:59");
  }
  const svc: Record<string, string> = {};
  for (const [name, price, rmin, rmax] of services) {
    const s = await createService(t.id, name, 30, price); // 30 minutes: synthetic, test-only calendar duration
    svc[name] = s.id;
    await linkServiceBranch(s.id, branch);
    for (const sid of Object.values(staff)) await linkStaffService(sid, s.id);
    if (rmin !== null) await testDb`update services set rebook_min_days = ${rmin}, rebook_max_days = ${rmax} where id = ${s.id}`;
  }
  return { t: { id: t.id, slug: t.slug }, ownerId: owner.id, branch, staff, svc };
}

async function customer(fx: Fx, name = "Sentetik Musteri"): Promise<{ id: string; name: string }> {
  const [c] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name, phone, email) values (${fx.t.id}, ${name}, '+905559990000', 'sentetik-gizli@example.com') returning id`;
  return { id: c!.id, name };
}

/** one appointment (1..n items) for a customer on a past/today local `day`; created through the real RPC, then moved */
async function visit(fx: Fx, cust: { id: string }, day: string | null, items: [string, string][], final: "completed" | "cancelled" | "no_show" | "confirmed" | "scheduled", time = "10:00"): Promise<{ id: string; itemIds: string[] }> {
  counter += 1;
  const future = safeMorningStart(40 + counter);
  const [row] = await asAuthenticatedUser(fx.ownerId, (sql) =>
    sql<{ id: string }[]>`select public.create_appointment(${fx.t.id}, ${fx.branch}, ${cust.id}, ${sql.json(
      items.map(([staff, service], i) => ({ service_id: fx.svc[service], staff_member_id: fx.staff[staff], scheduled_start_at: new Date(future.getTime() + i * 3600_000).toISOString(), sequence: i + 1 })) as never,
    )}, 'GIZLI-RANDEVU-NOTU') as id`,
  );
  const id = row!.id;
  if (day) {
    const base = await at(day, time);
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

const history = (fx: Fx, userId: string, cust: { id: string }, limit = 50) =>
  asAuthenticatedUser(userId, (sql) => sql<{ h: Hist }[]>`select public.get_customer_treatment_history(${fx.t.id}, ${cust.id}, ${limit}) as h`).then((r) => r[0]!.h);
const register = (fx: Fx, userId: string, item: string, kind = "before", mime = "image/jpeg", size = 1000) =>
  asAuthenticatedUser(userId, (sql) => sql<{ r: { mediaId: string; path: string } }[]>`select public.register_treatment_photo(${fx.t.id}, ${item}, ${kind}, ${mime}, ${size}) as r`).then((r) => r[0]!.r);
const confirm = (fx: Fx, userId: string, media: string) =>
  asAuthenticatedUser(userId, (sql) => sql`select public.confirm_treatment_photo(${fx.t.id}, ${media}) as r`);
const access = (fx: Fx, userId: string, media: string) =>
  asAuthenticatedUser(userId, (sql) => sql<{ r: { path: string; mime: string; kind: string } }[]>`select public.get_treatment_photo_access(${fx.t.id}, ${media}) as r`).then((r) => r[0]!.r);
async function putObject(path: string, mime = "image/jpeg", size = 1000) {
  await testDb`insert into storage.objects (bucket_id, name, metadata) values ('treatment-media', ${path}, ${testDb.json({ mimetype: mime, size } as never)})`;
}
async function readyPhoto(fx: Fx, item: string, kind = "before"): Promise<{ mediaId: string; path: string }> {
  const r = await register(fx, fx.ownerId, item, kind);
  await putObject(r.path);
  await confirm(fx, fx.ownerId, r.mediaId);
  return r;
}

let owner: TestUser;
let manager: TestUser;
let receptionist: TestUser;
let stylist: TestUser;
let viewOnly: TestUser; // customers.view + appointments.view, nothing else
let noAppt: TestUser; // customers.view only (no appointments.view)
let otherOwner: TestUser;
let emel: Fx;
let gok: Fx;
let other: Fx;

beforeAll(async () => {
  owner = await user("owner");
  manager = await user("manager");
  receptionist = await user("reception");
  stylist = await user("stylist");
  viewOnly = await user("viewonly");
  noAppt = await user("noappt");
  otherOwner = await user("other");
  emel = await salon("emel", owner, ["Emel Kaynakkan"], [
    ["Kaş Alımı", 600, null, null], ["Kaş Laminasyonu", 2000, 28, 56], ["Yosun Peeling", 5000, 30, 45], ["Kirpik Laminasyonu", 2000, null, null],
  ]);
  await testDb`update staff_members set tenant_membership_id = (select id from tenant_memberships where tenant_id = ${emel.t.id} and user_id = ${owner.id}) where id = ${emel.staff["Emel Kaynakkan"]!}`;
  await createTestMembershipFromTemplate(emel.t.id, manager.id, "SALON_MANAGER");
  await createTestMembershipFromTemplate(emel.t.id, receptionist.id, "RECEPTIONIST");
  await createTestMembershipFromTemplate(emel.t.id, stylist.id, "STYLIST");
  await addMembership(emel.t.id, viewOnly.id, await createCustomRole(emel.t.id, "Sadece Goruntule", ["customers.view", "appointments.view"]));
  await addMembership(emel.t.id, noAppt.id, await createCustomRole(emel.t.id, "Sadece Musteri", ["customers.view"]));
  gok = await salon("gok", await user("gok-owner"), ["Ahmet", "Burak", "Can"], [["Sac Kesimi", 500, 21, 35], ["Boya", 1500, null, null], ["Sakal", 200, null, null]]);
  other = await salon("other", otherOwner, ["Baska Kisi"], [["Kas Laminasyonu", 1, 28, 56]]);
}, 300_000);

afterAll(async () => {
  await cleanupTenants(tenants);
  await cleanupUsers(users.map((u) => u.id));
}, 180_000);

describe("TREATMENT HISTORY: completed work only, attribution, multi-service", () => {
  it("Emel (one provider): completed treatments appear with date, service, the one staff person and the value; open, future, cancelled and no-show visits do not", async () => {
    const c = await customer(emel);
    await visit(emel, c, await dayOffset(-100), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    await visit(emel, c, await dayOffset(-40), [["Emel Kaynakkan", "Yosun Peeling"]], "completed");
    await visit(emel, c, await dayOffset(-20), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
    await visit(emel, c, await dayOffset(-10), [["Emel Kaynakkan", "Kirpik Laminasyonu"]], "cancelled");
    await visit(emel, c, await dayOffset(-9), [["Emel Kaynakkan", "Kirpik Laminasyonu"]], "no_show");
    await visit(emel, c, await dayOffset(-8), [["Emel Kaynakkan", "Kirpik Laminasyonu"]], "confirmed");
    await visit(emel, c, null, [["Emel Kaynakkan", "Kirpik Laminasyonu"]], "scheduled"); // the future
    const h = await history(emel, owner.id, c);
    expect(h.items.map((i) => i.serviceName)).toEqual(["Kaş Laminasyonu", "Yosun Peeling", "Kaş Alımı"]); // newest first
    expect(h.items.map((i) => i.staffName)).toEqual(["Emel Kaynakkan", "Emel Kaynakkan", "Emel Kaynakkan"]);
    expect(h.items.map((i) => i.value)).toEqual(["2000.00", "5000.00", "600.00"]);
    expect(h.items[0]!.date).toBe(await dayOffset(-20));
    expect(h.canSeeValue).toBe(true);
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_members where tenant_id = ${emel.t.id} and deleted_at is null`;
    expect(n!.n).toBe("1"); // the owner is the one provider: not duplicated
  });

  it("multi-service visit: every item is its own treatment with its own performer; a checkout's edited price and the actual performer are honoured, a voided checkout is not", async () => {
    const c = await customer(gok);
    const v = await visit(gok, c, await dayOffset(-3), [["Ahmet", "Sac Kesimi"], ["Burak", "Boya"], ["Can", "Sakal"]], "completed");
    const [sale] = await asAuthenticatedUser(gok.ownerId, (sql) => sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${v.id})`);
    await testDb`update appointment_sale_items set actual_staff_member_id = ${gok.staff["Can"]!}, unit_price = 450 where appointment_item_id = ${v.itemIds[0]!} and sale_id = ${sale!.id}`;
    const h = await history(gok, gok.ownerId, c);
    const byService = Object.fromEntries(h.items.map((i) => [i.serviceName, i]));
    expect(h.items).toHaveLength(3);
    expect(byService["Sac Kesimi"]).toMatchObject({ staffName: "Can", value: "450.00" }); // performed by Can at an edited price
    expect(byService["Boya"]).toMatchObject({ staffName: "Burak", value: "1500.00" });
    expect(byService["Sakal"]).toMatchObject({ staffName: "Can", value: "200.00" });
    await testDb`update appointment_sales set status = 'voided' where id = ${sale!.id}`;
    const again = await history(gok, gok.ownerId, c);
    expect(Object.fromEntries(again.items.map((i) => [i.serviceName, i]))["Sac Kesimi"]).toMatchObject({ staffName: "Ahmet", value: "500.00" }); // booking price and booked staff
  });

  it("a customer's history contains only that customer's treatments", async () => {
    const a = await customer(gok, "Musteri A");
    const b = await customer(gok, "Musteri B");
    await visit(gok, a, await dayOffset(-5), [["Ahmet", "Boya"]], "completed");
    await visit(gok, b, await dayOffset(-5), [["Burak", "Sakal"]], "completed");
    expect((await history(gok, gok.ownerId, a)).items.map((i) => i.serviceName)).toEqual(["Boya"]);
    expect((await history(gok, gok.ownerId, b)).items.map((i) => i.serviceName)).toEqual(["Sakal"]);
  });

  it("the limit pages the list (newest first) and says there is more", async () => {
    const c = await customer(gok, "Cok Ziyaret");
    for (const n of [-30, -20, -10]) await visit(gok, c, await dayOffset(n), [["Ahmet", "Sakal"]], "completed");
    const h = await history(gok, gok.ownerId, c, 2);
    expect(h.items.map((i) => i.date)).toEqual([await dayOffset(-10), await dayOffset(-20)]);
    expect(h.hasMore).toBe(true);
    expect((await history(gok, gok.ownerId, c, 3)).hasMore).toBe(false);
  });

  it("a note is shown on its own treatment; an item with no note shows null", async () => {
    const c = await customer(emel, "Notlu Musteri");
    const v = await visit(emel, c, await dayOffset(-4), [["Emel Kaynakkan", "Kaş Alımı"], ["Emel Kaynakkan", "Kirpik Laminasyonu"]], "completed");
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.set_treatment_note(${emel.t.id}, ${v.itemIds[1]!}, '  Ton kodu 3  ')`);
    const h = await history(emel, owner.id, c);
    expect(Object.fromEntries(h.items.map((i) => [i.serviceName, i.note]))).toEqual({ "Kaş Alımı": null, "Kirpik Laminasyonu": "Ton kodu 3" });
  });
});

describe("REBOOKING WINDOW (service interval 28-56 days, i.e. the supplied 4-8 weeks)", () => {
  async function stateFor(daysAgo: number, label: string): Promise<NonNullable<Hist["items"][number]["rebook"]>> {
    const c = await customer(emel, label);
    await visit(emel, c, await dayOffset(-daysAgo), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
    return (await history(emel, owner.id, c)).items[0]!.rebook!;
  }

  it("before the window = not_due; the first and the last day of the window = due; the day after = overdue", async () => {
    expect((await stateFor(27, "A27")).state).toBe("not_due");
    expect((await stateFor(28, "A28")).state).toBe("due");
    expect((await stateFor(35, "A35")).state).toBe("due");
    expect((await stateFor(56, "A56")).state).toBe("due");
    expect((await stateFor(57, "A57")).state).toBe("overdue");
  });

  it("the window dates are visit date + min .. + max and the interval is the service's own", async () => {
    const r = await stateFor(20, "W20");
    expect(r).toMatchObject({ minDays: 28, maxDays: 56, windowStart: await dayOffset(8), windowEnd: await dayOffset(36), state: "not_due" });
  });

  it("an upcoming appointment for the same service makes it 'booked'; a cancelled one does not", async () => {
    const c = await customer(emel, "Booked");
    await visit(emel, c, await dayOffset(-35), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
    await visit(emel, c, await dayOffset(3), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "cancelled");
    expect((await history(emel, owner.id, c)).items[0]!.rebook!.state).toBe("due");
    await visit(emel, c, null, [["Emel Kaynakkan", "Kaş Laminasyonu"]], "scheduled");
    expect((await history(emel, owner.id, c)).items[0]!.rebook!.state).toBe("booked");
  });

  it("only the latest treatment of a service carries the hint; a service with no interval carries none; a min-only interval is never overdue", async () => {
    const c = await customer(emel, "Repeat");
    await visit(emel, c, await dayOffset(-100), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
    await visit(emel, c, await dayOffset(-20), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
    await visit(emel, c, await dayOffset(-30), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    const h = await history(emel, owner.id, c);
    const lam = h.items.filter((i) => i.serviceName === "Kaş Laminasyonu");
    expect(lam[0]!.rebook!.state).toBe("not_due");
    expect(lam[1]!.rebook).toBeNull();
    expect(h.items.find((i) => i.serviceName === "Kaş Alımı")!.rebook).toBeNull();
    await testDb`update services set rebook_max_days = null where id = ${emel.svc["Kaş Laminasyonu"]!}`;
    try {
      const old = await customer(emel, "MinOnly");
      await visit(emel, old, await dayOffset(-400), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
      expect((await history(emel, owner.id, old)).items[0]!.rebook).toMatchObject({ state: "due", maxDays: null, windowEnd: null });
    } finally {
      await testDb`update services set rebook_max_days = 56 where id = ${emel.svc["Kaş Laminasyonu"]!}`;
    }
  });

  it("the database refuses an inconsistent interval", async () => {
    const id = emel.svc["Kaş Alımı"]!;
    for (const q of [
      testDb`update services set rebook_max_days = 30 where id = ${id}`,
      testDb`update services set rebook_min_days = 30, rebook_max_days = 20 where id = ${id}`,
      testDb`update services set rebook_min_days = 0 where id = ${id}`,
      testDb`update services set rebook_min_days = 731 where id = ${id}`,
    ]) await expect(q).rejects.toMatchObject({ code: "23514" });
  });
});

describe("QUICK REBOOK defaults: only what is still true; customer, date and time are chosen again", () => {
  async function itemOf(fx: Fx, name: string, staff: string): Promise<string> {
    const c = await customer(fx, "Hizli " + name + staff);
    const v = await visit(fx, c, await dayOffset(-2), [[staff, name]], "completed");
    return v.itemIds[0]!;
  }
  const defaults = (fx: Fx, userId: string, item: string) =>
    asAuthenticatedUser(userId, (sql) => sql<{ r: Record<string, unknown> }[]>`select public.get_treatment_rebook_defaults(${fx.t.id}, ${item}) as r`).then((r) => r[0]!.r);

  it("Emel: same service, same branch, the one provider; nothing about the customer, the date or the time", async () => {
    const item = await itemOf(emel, "Kaş Laminasyonu", "Emel Kaynakkan");
    const d = await defaults(emel, owner.id, item);
    expect(d).toEqual({ serviceId: emel.svc["Kaş Laminasyonu"], serviceName: "Kaş Laminasyonu", branchId: emel.branch, staffId: emel.staff["Emel Kaynakkan"] });
  });

  it("the performing person is reused (not the booked one); an inactive, unlinked or removed person falls back to null", async () => {
    const item = await itemOf(gok, "Boya", "Burak");
    expect((await defaults(gok, gok.ownerId, item)).staffId).toBe(gok.staff["Burak"]);
    await testDb`update staff_members set status = 'inactive' where id = ${gok.staff["Burak"]!}`;
    expect((await defaults(gok, gok.ownerId, item)).staffId).toBeNull();
    await testDb`update staff_members set status = 'active' where id = ${gok.staff["Burak"]!}`;
    await testDb`delete from staff_services where staff_member_id = ${gok.staff["Burak"]!} and service_id = ${gok.svc["Boya"]!}`;
    expect((await defaults(gok, gok.ownerId, item)).staffId).toBeNull();
    await linkStaffService(gok.staff["Burak"]!, gok.svc["Boya"]!);
    await testDb`update staff_members set deleted_at = now() where id = ${gok.staff["Burak"]!}`;
    expect((await defaults(gok, gok.ownerId, item)).staffId).toBeNull();
    await testDb`update staff_members set deleted_at = null where id = ${gok.staff["Burak"]!}`;
    await testDb`delete from staff_branches where staff_member_id = ${gok.staff["Burak"]!}`;
    expect((await defaults(gok, gok.ownerId, item)).staffId).toBeNull();
    await linkStaffBranch(gok.staff["Burak"]!, gok.branch);
    expect((await defaults(gok, gok.ownerId, item)).staffId).toBe(gok.staff["Burak"]);
  });

  it("the actual performer of a checkout is the default staff, not the booked person", async () => {
    const c = await customer(gok, "Performer");
    const v = await visit(gok, c, await dayOffset(-2), [["Ahmet", "Sakal"]], "completed");
    const [sale] = await asAuthenticatedUser(gok.ownerId, (sql) => sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${v.id})`);
    await testDb`update appointment_sale_items set actual_staff_member_id = ${gok.staff["Can"]!} where sale_id = ${sale!.id}`;
    expect((await defaults(gok, gok.ownerId, v.itemIds[0]!)).staffId).toBe(gok.staff["Can"]);
  });

  it("a service that is no longer offered is refused (BH003); a branch that no longer offers it leaves branch and staff null", async () => {
    const item = await itemOf(gok, "Sakal", "Ahmet");
    await testDb`delete from service_branches where service_id = ${gok.svc["Sakal"]!}`;
    expect(await defaults(gok, gok.ownerId, item)).toMatchObject({ serviceId: gok.svc["Sakal"], branchId: null, staffId: null });
    await linkServiceBranch(gok.svc["Sakal"]!, gok.branch);
    await testDb`update services set status = 'inactive' where id = ${gok.svc["Sakal"]!}`;
    expect(await attemptAs(gok.ownerId, (sql) => sql`select public.get_treatment_rebook_defaults(${gok.t.id}, ${item})`)).toMatchObject({ ok: false, code: "BH003" });
    await testDb`update services set status = 'active' where id = ${gok.svc["Sakal"]!}`;
    await testDb`update services set deleted_at = now() where id = ${gok.svc["Sakal"]!}`;
    expect(await attemptAs(gok.ownerId, (sql) => sql`select public.get_treatment_rebook_defaults(${gok.t.id}, ${item})`)).toMatchObject({ ok: false, code: "BH003" });
    await testDb`update services set deleted_at = null where id = ${gok.svc["Sakal"]!}`;
  });

  it("another salon's treatment is never reused, and an item that is not a completed treatment is refused", async () => {
    const item = await itemOf(gok, "Boya", "Ahmet");
    expect(await attemptAs(otherOwner.id, (sql) => sql`select public.get_treatment_rebook_defaults(${other.t.id}, ${item})`)).toMatchObject({ ok: false, code: "BH003" });
    expect(await attemptAs(otherOwner.id, (sql) => sql`select public.get_treatment_rebook_defaults(${gok.t.id}, ${item})`)).toMatchObject({ ok: false, code: "BH002" });
    const c = await customer(gok, "Acik");
    const open = await visit(gok, c, null, [["Ahmet", "Boya"]], "scheduled");
    expect(await attemptAs(gok.ownerId, (sql) => sql`select public.get_treatment_rebook_defaults(${gok.t.id}, ${open.itemIds[0]!})`)).toMatchObject({ ok: false, code: "BH003" });
  });
});

describe("PHOTOS: register, upload, confirm, read, delete - private and bounded", () => {
  let item: string;
  beforeAll(async () => {
    const c = await customer(emel, "Fotoli Musteri");
    const v = await visit(emel, c, await dayOffset(-6), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
    item = v.itemIds[0]!;
  });

  it("the path is <tenant>/<random>.<ext> - no customer, appointment, e-mail, phone or original file name in it; the bucket is private with a size and type limit", async () => {
    const r = await register(emel, owner.id, item, "before", "image/png", 5000);
    expect(r.path).toMatch(new RegExp(`^${emel.t.id}/${UUID}\\.png$`));
    for (const secret of ["Fotoli", "Musteri", "sentetik", "9990000", item]) expect(r.path).not.toContain(secret);
    const [b] = await testDb<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }[]>`select public, file_size_limit::text, allowed_mime_types from storage.buckets where id = 'treatment-media'`;
    expect(b).toEqual({ public: false, file_size_limit: "2097152", allowed_mime_types: ["image/jpeg", "image/png", "image/webp"] });
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.delete_treatment_photo(${emel.t.id}, ${r.mediaId})`);
  });

  it("before and after photos attach to THE treatment; a pending photo is not shown or readable until confirmed", async () => {
    const before = await register(emel, owner.id, item, "before");
    await putObject(before.path);
    const c = (await testDb<{ customer_id: string }[]>`select ap.customer_id from appointment_items ai join appointments ap on ap.id = ai.appointment_id where ai.id = ${item}`)[0]!;
    expect((await history(emel, owner.id, { id: c.customer_id })).items[0]!.media).toEqual([]);
    await expect(access(emel, owner.id, before.mediaId)).rejects.toMatchObject({ code: "BH003" });
    await confirm(emel, owner.id, before.mediaId);
    const after = await readyPhoto(emel, item, "after");
    const h = await history(emel, owner.id, { id: c.customer_id });
    expect(h.items[0]!.media.map((m) => m.kind)).toEqual(["before", "after"]);
    expect(Object.keys(h.items[0]!.media[0]!).sort()).toEqual(["createdAt", "id", "kind"]); // no path, no mime, no user ids
    expect(await access(emel, owner.id, after.mediaId)).toEqual({ path: after.path, mime: "image/jpeg", kind: "after" });
  });

  it("invalid type, oversize, zero size, unknown kind and a missing treatment are refused", async () => {
    for (const [kind, mime, size] of [["before", "application/pdf", 100], ["before", "image/gif", 100], ["before", "image/heic", 100], ["before", "image/jpeg", 2097153], ["before", "image/jpeg", 0], ["selfie", "image/jpeg", 100]] as const) {
      expect(await attemptAs(owner.id, (sql) => sql`select public.register_treatment_photo(${emel.t.id}, ${item}, ${kind}, ${mime}, ${size})`), `${kind} ${mime} ${size}`).toMatchObject({ ok: false, code: "BH004" });
    }
    expect(await attemptAs(owner.id, (sql) => sql`select public.register_treatment_photo(${emel.t.id}, ${crypto.randomUUID()}, 'before', 'image/jpeg', 100)`)).toMatchObject({ ok: false, code: "BH003" });
    expect(await register(emel, owner.id, item, "other", "image/webp", 2097152)).toBeTruthy(); // exactly the limit is fine
  });

  it("at most 8 photos per treatment", async () => {
    const c = await customer(emel, "Limitli");
    const v = await visit(emel, c, await dayOffset(-7), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    for (let i = 0; i < 8; i++) await register(emel, owner.id, v.itemIds[0]!, "other");
    expect(await attemptAs(owner.id, (sql) => sql`select public.register_treatment_photo(${emel.t.id}, ${v.itemIds[0]!}, 'other', 'image/jpeg', 100)`)).toMatchObject({ ok: false, code: "BH005" });
  });

  it("confirm needs the uploaded object, in the declared type and within the size limit, and only the person who registered it", async () => {
    const r = await register(emel, owner.id, item, "other", "image/jpeg", 1000);
    await expect(confirm(emel, owner.id, r.mediaId)).rejects.toMatchObject({ code: "BH006" }); // nothing uploaded
    await putObject(r.path, "image/png", 1000);
    await expect(confirm(emel, owner.id, r.mediaId)).rejects.toMatchObject({ code: "BH006" }); // wrong type
    await testDb`delete from storage.objects where name = ${r.path}`;
    await putObject(r.path, "image/jpeg", 5_000_000);
    await expect(confirm(emel, owner.id, r.mediaId)).rejects.toMatchObject({ code: "BH006" }); // too large
    await testDb`delete from storage.objects where name = ${r.path}`;
    await putObject(r.path);
    expect(await attemptAs(manager.id, (sql) => sql`select public.confirm_treatment_photo(${emel.t.id}, ${r.mediaId})`)).toMatchObject({ ok: false, code: "BH002" }); // not the registrant
    await confirm(emel, owner.id, r.mediaId);
    await confirm(emel, owner.id, r.mediaId); // idempotent
  });

  it("delete removes the row at once (deleted media is unavailable) and answers with the object path for cleanup", async () => {
    const r = await readyPhoto(emel, item);
    const res = await asAuthenticatedUser(owner.id, (sql) => sql<{ r: { path: string } }[]>`select public.delete_treatment_photo(${emel.t.id}, ${r.mediaId}) as r`);
    expect(res[0]!.r.path).toBe(r.path);
    await expect(access(emel, owner.id, r.mediaId)).rejects.toMatchObject({ code: "BH003" });
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from treatment_media where id = ${r.mediaId}`;
    expect(n!.n).toBe("0");
    expect(await attemptAs(owner.id, (sql) => sql`select public.delete_treatment_photo(${emel.t.id}, ${r.mediaId})`)).toMatchObject({ ok: false, code: "BH003" });
  });

  it("removed context: a customer deleted, or an appointment no longer completed, closes the photo; deleting the appointment removes the metadata", async () => {
    const c = await customer(emel, "Silinen");
    const v = await visit(emel, c, await dayOffset(-12), [["Emel Kaynakkan", "Kirpik Laminasyonu"]], "completed");
    const p = await readyPhoto(emel, v.itemIds[0]!);
    expect((await access(emel, owner.id, p.mediaId)).path).toBe(p.path);
    await testDb`update customers set deleted_at = now() where id = ${c.id}`;
    await expect(access(emel, owner.id, p.mediaId)).rejects.toMatchObject({ code: "BH003" });
    expect(await attemptAs(owner.id, (sql) => sql`select public.get_customer_treatment_history(${emel.t.id}, ${c.id}, 10)`)).toMatchObject({ ok: false, code: "BH003" });
    expect(await attemptAs(owner.id, (sql) => sql`select public.register_treatment_photo(${emel.t.id}, ${v.itemIds[0]!}, 'before', 'image/jpeg', 10)`)).toMatchObject({ ok: false, code: "BH003" });
    await testDb`update customers set deleted_at = null where id = ${c.id}`;
    expect((await access(emel, owner.id, p.mediaId)).path).toBe(p.path);
    await testDb`update appointments set status = 'cancelled' where id = ${v.id}`;
    await expect(access(emel, owner.id, p.mediaId)).rejects.toMatchObject({ code: "BH003" });
    await testDb`update appointments set status = 'completed' where id = ${v.id}`;
    await testDb`delete from appointment_items where appointment_id = ${v.id}`;
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from treatment_media where id = ${p.mediaId}`;
    expect(n!.n).toBe("0");
  });

  it("every photo action is audited without the customer or the file name", async () => {
    const rows = await auditRows(emel.t.id, "treatment.photo_registered");
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/Musteri|sentetik|jpg|png/i);
    expect((await auditRows(emel.t.id, "treatment.photo_confirmed")).length).toBeGreaterThan(0);
    expect((await auditRows(emel.t.id, "treatment.photo_deleted")).length).toBeGreaterThan(0);
  });
});

describe("STORAGE POLICIES (private bucket): the same rules at the object level", () => {
  let item: string;
  let ready: { mediaId: string; path: string };
  let pending: { mediaId: string; path: string };
  beforeAll(async () => {
    const c = await customer(emel, "Storage Musteri");
    const v = await visit(emel, c, await dayOffset(-14), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    item = v.itemIds[0]!;
    ready = await readyPhoto(emel, item);
    pending = await register(emel, owner.id, item, "other");
    await putObject(pending.path);
  });
  const visible = (userId: string, path: string) =>
    asAuthenticatedUser(userId, (sql) => sql<{ n: string }[]>`select count(*)::text as n from storage.objects where bucket_id = 'treatment-media' and name = ${path}`).then((r) => r[0]!.n);

  it("a confirmed object is readable by those who may read the history, and by nobody else", async () => {
    for (const u of [owner, manager, receptionist, viewOnly]) expect(await visible(u.id, ready.path), u.email).toBe("1");
    for (const u of [stylist, noAppt, otherOwner]) expect(await visible(u.id, ready.path), u.email).toBe("0");
    await expect(asDatabaseRole("anon", null, (sql) => sql`select name from storage.objects where bucket_id = 'treatment-media'`)).resolves.toEqual([]);
  });

  it("an unconfirmed object is visible only to the person who registered it; after the row is deleted the object is unreadable even though it still exists", async () => {
    expect(await visible(owner.id, pending.path)).toBe("1"); // the registrant (needed to clean up a failed upload)
    expect(await visible(manager.id, pending.path)).toBe("0");
    expect(await visible(receptionist.id, pending.path)).toBe("0");
    const r = await readyPhoto(emel, item);
    expect(await visible(owner.id, r.path)).toBe("1");
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.delete_treatment_photo(${emel.t.id}, ${r.mediaId})`);
    const [o] = await testDb<{ n: string }[]>`select count(*)::text as n from storage.objects where name = ${r.path}`;
    expect(o!.n).toBe("1");
    expect(await visible(owner.id, r.path)).toBe("0");
  });

  it("removal order: an object can be removed while its row exists (pending by the registrant, ready by a deleter); once the row is gone nothing is left to remove through the API", async () => {
    const reg = await register(emel, owner.id, item, "other");
    await putObject(reg.path);
    const remove = (userId: string, path: string) =>
      asAuthenticatedUser(userId, (sql) => sql<{ name: string }[]>`delete from storage.objects where bucket_id = 'treatment-media' and name = ${path} returning name`);
    expect(await remove(manager.id, reg.path)).toEqual([]); // not the registrant
    expect(await remove(owner.id, reg.path)).toHaveLength(1);
    const ready = await readyPhoto(emel, item);
    expect(await remove(receptionist.id, ready.path)).toHaveLength(1);
    const second = await readyPhoto(emel, item);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.delete_treatment_photo(${emel.t.id}, ${second.mediaId})`);
    expect(await remove(owner.id, second.path)).toEqual([]); // the row is gone: this is why the object is removed first
  });

  it("upload is allowed only to a registered pending path by the person who registered it", async () => {
    const reg = await register(emel, owner.id, item, "other");
    const put = (userId: string, name: string) =>
      attemptAs(userId, (sql) => sql`insert into storage.objects (bucket_id, name, metadata) values ('treatment-media', ${name}, '{}'::jsonb)`);
    expect(await put(owner.id, `${emel.t.id}/${crypto.randomUUID()}.jpg`)).toMatchObject({ ok: false }); // never registered
    expect(await put(manager.id, reg.path)).toMatchObject({ ok: false }); // someone else
    expect(await put(otherOwner.id, reg.path)).toMatchObject({ ok: false });
    expect(await put(owner.id, reg.path.replace(/\.jpg$/, ".gif"))).toMatchObject({ ok: false });
    expect(await put(owner.id, reg.path)).toEqual({ ok: true });
    await expect(asDatabaseRole("anon", null, (sql) => sql`insert into storage.objects (bucket_id, name) values ('treatment-media', ${reg.path})`)).rejects.toBeTruthy();
  });

  it("deleting an object needs customers.update in THAT tenant's folder; another tenant cannot delete it", async () => {
    const r = await readyPhoto(emel, item);
    const del = (userId: string) =>
      asAuthenticatedUser(userId, (sql) => sql<{ name: string }[]>`delete from storage.objects where bucket_id = 'treatment-media' and name = ${r.path} returning name`);
    expect(await del(otherOwner.id)).toEqual([]);
    expect(await del(stylist.id)).toEqual([]);
    expect(await del(viewOnly.id)).toEqual([]);
    expect(await del(receptionist.id)).toHaveLength(1);
  });
});

describe("AUTHORIZATION and PRIVACY", () => {
  let item: string;
  let cust: { id: string };
  beforeAll(async () => {
    cust = await customer(emel, "Yetki Musteri");
    const v = await visit(emel, cust, await dayOffset(-5), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
    item = v.itemIds[0]!;
  });

  it("Owner, Yönetici and Resepsiyon read the history; a custom view-only role reads it WITHOUT the value; Personel and a customer-only role are refused", async () => {
    expect((await history(emel, owner.id, cust)).items[0]!.value).toBe("2000.00");
    expect((await history(emel, manager.id, cust)).items[0]!.value).toBe("2000.00");
    expect((await history(emel, receptionist.id, cust)).items[0]!.value).toBe("2000.00");
    const vo = await history(emel, viewOnly.id, cust);
    expect(vo.canSeeValue).toBe(false);
    expect(vo.items[0]!.value).toBeNull();
    for (const u of [stylist, noAppt]) {
      expect(await attemptAs(u.id, (sql) => sql`select public.get_customer_treatment_history(${emel.t.id}, ${cust.id}, 10)`), u.email).toMatchObject({ ok: false, code: "BH002" });
    }
  });

  it("writes (note, photos) need customers.update: Owner, Yönetici, Resepsiyon yes; view-only, customer-only and Personel no", async () => {
    for (const u of [owner, manager, receptionist]) {
      expect(await attemptAs(u.id, (sql) => sql`select public.set_treatment_note(${emel.t.id}, ${item}, 'tamam')`), u.email).toEqual({ ok: true });
    }
    for (const u of [viewOnly, noAppt, stylist]) {
      expect(await attemptAs(u.id, (sql) => sql`select public.set_treatment_note(${emel.t.id}, ${item}, 'olmaz')`), u.email).toMatchObject({ ok: false, code: "BH002" });
      expect(await attemptAs(u.id, (sql) => sql`select public.register_treatment_photo(${emel.t.id}, ${item}, 'before', 'image/jpeg', 10)`), u.email).toMatchObject({ ok: false, code: "BH002" });
    }
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.set_treatment_note(${emel.t.id}, ${item}, null)`);
  });

  it("another salon's Owner is refused everywhere, and cannot reach this salon's media by id", async () => {
    const r = await readyPhoto(emel, item);
    for (const call of [
      (sql: never) => (sql as never as typeof testDb)`select public.get_customer_treatment_history(${emel.t.id}, ${cust.id}, 10)`,
      (sql: never) => (sql as never as typeof testDb)`select public.get_treatment_photo_access(${emel.t.id}, ${r.mediaId})`,
      (sql: never) => (sql as never as typeof testDb)`select public.delete_treatment_photo(${emel.t.id}, ${r.mediaId})`,
      (sql: never) => (sql as never as typeof testDb)`select public.confirm_treatment_photo(${emel.t.id}, ${r.mediaId})`,
      (sql: never) => (sql as never as typeof testDb)`select public.register_treatment_photo(${emel.t.id}, ${item}, 'before', 'image/jpeg', 10)`,
    ]) {
      expect(await attemptAs(otherOwner.id, (sql) => call(sql as never) as never)).toMatchObject({ ok: false, code: "BH002" });
    }
    // with the OTHER tenant's id the ids simply do not exist there
    expect(await attemptAs(otherOwner.id, (sql) => sql`select public.get_treatment_photo_access(${other.t.id}, ${r.mediaId})`)).toMatchObject({ ok: false, code: "BH003" });
    expect(await attemptAs(otherOwner.id, (sql) => sql`select public.delete_treatment_photo(${other.t.id}, ${r.mediaId})`)).toMatchObject({ ok: false, code: "BH003" });
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from treatment_media where id = ${r.mediaId}`;
    expect(n!.n).toBe("1");
  });

  it("no session is BH001; anon and service_role cannot execute; private functions and the tables are closed to every API role", async () => {
    await expect(asDatabaseRole("authenticated", null, (sql) => sql`select public.get_customer_treatment_history(${emel.t.id}, ${cust.id}, 10)`)).rejects.toMatchObject({ code: "BH001" });
    for (const role of ["anon", "service_role"] as const) {
      for (const call of [
        `select public.get_customer_treatment_history($1::uuid, $1::uuid, 10)`,
        `select public.register_treatment_photo($1::uuid, $1::uuid, 'before', 'image/jpeg', 10)`,
        `select public.get_treatment_photo_access($1::uuid, $1::uuid)`,
        `select public.get_treatment_rebook_defaults($1::uuid, $1::uuid)`,
      ]) await expect(asDatabaseRole(role, null, (sql) => sql.unsafe(call, [emel.t.id] as never[])), `${role} ${call}`).rejects.toMatchObject({ code: "42501" });
    }
    for (const fn of ["private.get_customer_treatment_history(uuid, uuid, integer)", "private.register_treatment_photo(uuid, uuid, text, text, integer)", "private.delete_treatment_photo(uuid, uuid)", "private.treatment_gate(uuid, text[])", "private.treatment_item_exists(uuid, uuid)"]) {
      const [r] = await testDb<{ a: boolean; b: boolean; c: boolean }[]>`select has_function_privilege('authenticated', ${fn}, 'execute') as a, has_function_privilege('anon', ${fn}, 'execute') as b, has_function_privilege('service_role', ${fn}, 'execute') as c`;
      expect(r, fn).toEqual({ a: false, b: false, c: false });
    }
    for (const t of ["treatment_notes", "treatment_media"]) {
      for (const role of ["authenticated", "anon", "service_role"]) {
        const [r] = await testDb<{ s: boolean; i: boolean }[]>`select has_table_privilege(${role}, ${"public." + t}, 'select') as s, has_table_privilege(${role}, ${"public." + t}, 'insert') as i`;
        expect([r!.s, r!.i], `${role} ${t}`).toEqual([false, false]);
      }
    }
  });

  it("PRIVACY: the history carries no phone, e-mail, private appointment note, auth user id or storage path; a note is not in the audit log", async () => {
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.set_treatment_note(${emel.t.id}, ${item}, 'Gizli operasyonel not')`);
    await readyPhoto(emel, item);
    const text = JSON.stringify(await history(emel, owner.id, cust));
    for (const secret of ["9990000", "sentetik-gizli", "GIZLI-RANDEVU-NOTU", owner.id, "treatment-media", ".jpg", emel.t.id, "Yetki Musteri"]) expect(text, secret).not.toContain(secret);
    expect(JSON.stringify(await auditRows(emel.t.id, "treatment.note_set"))).not.toContain("Gizli operasyonel not");
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.set_treatment_note(${emel.t.id}, ${item}, '')`);
  });

  it("notes: trimmed, at most 500 characters, cleared by an empty value, only on a completed treatment", async () => {
    const set = (note: string | null, it = item) => attemptAs(owner.id, (sql) => sql`select public.set_treatment_note(${emel.t.id}, ${it}, ${note})`);
    expect(await set("x".repeat(500))).toEqual({ ok: true });
    expect(await set("x".repeat(501))).toMatchObject({ ok: false, code: "BH004" });
    expect(await set("   ")).toEqual({ ok: true });
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from treatment_notes where appointment_item_id = ${item}`;
    expect(n!.n).toBe("0");
    const c = await customer(emel, "Acik Randevu");
    const open = await visit(emel, c, null, [["Emel Kaynakkan", "Kaş Alımı"]], "scheduled");
    expect(await set("x", open.itemIds[0]!)).toMatchObject({ ok: false, code: "BH003" });
  });
});

describe("closeout: day boundaries, upcoming appointments, quick-rebook eligibility, object-level policies", () => {
  it("'today' and the window states use the salon's own local date, whatever the UTC date is", async () => {
    const f = await salon("tzs", await user("tzs-owner"), ["Eda"], [["Kaş Laminasyonu", 100, 28, 56]]);
    const c = await customer(f, "Saat Dilimi");
    await visit(f, c, await dayOffset(-35), [["Eda", "Kaş Laminasyonu"]], "completed");
    for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      await testDb`update tenants set timezone = ${tz} where id = ${f.t.id}`;
      expect((await history(f, f.ownerId, c)).today, tz).toBe(await dayOffset(0, tz));
    }
  });

  it("a past appointment that never happened is not an upcoming booking; another customer's upcoming booking is not this customer's", async () => {
    const a = await customer(emel, "Gecmis Randevu");
    await visit(emel, a, await dayOffset(-35), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
    await visit(emel, a, await dayOffset(-3), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "scheduled"); // in the past, never completed
    expect((await history(emel, owner.id, a)).items[0]!.rebook!.state).toBe("due");
    const b = await customer(emel, "Baskasi");
    await visit(emel, b, null, [["Emel Kaynakkan", "Kaş Laminasyonu"]], "scheduled");
    expect((await history(emel, owner.id, a)).items[0]!.rebook!.state).toBe("due");
    const c = await customer(emel, "Gelecek Teyit");
    await visit(emel, c, await dayOffset(-35), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
    await visit(emel, c, null, [["Emel Kaynakkan", "Kaş Laminasyonu"]], "confirmed");
    expect((await history(emel, owner.id, c)).items[0]!.rebook!.state).toBe("booked");
  });

  it("a service with no interval carries no rebook window at all", async () => {
    const c = await customer(emel, "Aralik Yok");
    await visit(emel, c, await dayOffset(-35), [["Emel Kaynakkan", "Kirpik Laminasyonu"]], "completed");
    expect((await history(emel, owner.id, c)).items[0]!.rebook).toBeNull();
  });

  it("quick rebook: a person linked to another service or to another branch only is not offered; a foreign branch, service or person is never reused", async () => {
    const c = await customer(gok, "Hizli Uygunluk");
    const v = await visit(gok, c, await dayOffset(-2), [["Can", "Sakal"]], "completed");
    const item = v.itemIds[0]!;
    const defaults = () => asAuthenticatedUser(gok.ownerId, (sql) => sql<{ r: { branchId: string | null; staffId: string | null } }[]>`select public.get_treatment_rebook_defaults(${gok.t.id}, ${item}) as r`).then((r) => r[0]!.r);
    expect((await defaults()).staffId).toBe(gok.staff["Can"]);
    // linked to ANOTHER service only
    await testDb`delete from staff_services where staff_member_id = ${gok.staff["Can"]!} and service_id = ${gok.svc["Sakal"]!}`;
    expect((await defaults()).staffId).toBeNull();
    await linkStaffService(gok.staff["Can"]!, gok.svc["Sakal"]!);
    // linked to ANOTHER branch only
    const branch2 = await createBranch(gok.t.id, "Ikinci");
    await testDb`delete from staff_branches where staff_member_id = ${gok.staff["Can"]!}`;
    await linkStaffBranch(gok.staff["Can"]!, branch2);
    expect((await defaults()).staffId).toBeNull();
    await testDb`delete from staff_branches where staff_member_id = ${gok.staff["Can"]!}`;
    await linkStaffBranch(gok.staff["Can"]!, gok.branch);
    expect((await defaults()).staffId).toBe(gok.staff["Can"]);
    // foreign ids wearing this tenant's rows (constraints off for the corruption only)
    await testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update appointment_items set actual_staff_member_id = ${other.staff["Baska Kisi"]!} where id = ${item}`;
    });
    expect((await defaults()).staffId).toBeNull();
    await testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update appointment_items set actual_staff_member_id = ${gok.staff["Can"]!} where id = ${item}`;
    });
    const [ap] = await testDb<{ id: string; branch_id: string }[]>`select ap.id, ap.branch_id from appointments ap join appointment_items ai on ai.appointment_id = ap.id where ai.id = ${item}`;
    const [foreignBranch] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${other.t.id} limit 1`;
    await testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update appointments set branch_id = ${foreignBranch!.id} where id = ${ap!.id}`;
    });
    expect((await defaults()).branchId).toBeNull();
    await testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update appointments set branch_id = ${ap!.branch_id} where id = ${ap!.id}`;
    });
    await testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update appointment_items set service_id = ${other.svc["Kas Laminasyonu"]!} where id = ${item}`;
    });
    expect(await attemptAs(gok.ownerId, (sql) => sql`select public.get_treatment_rebook_defaults(${gok.t.id}, ${item})`)).toMatchObject({ ok: false, code: "BH003" });
    await testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update appointment_items set service_id = ${gok.svc["Sakal"]!} where id = ${item}`;
    });
    expect((await defaults()).staffId).toBe(gok.staff["Can"]);
  });

  it("a second confirm changes nothing and is not audited twice", async () => {
    const c = await customer(emel, "Cift Onay");
    const v = await visit(emel, c, await dayOffset(-8), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    const r = await register(emel, owner.id, v.itemIds[0]!);
    await putObject(r.path);
    await confirm(emel, owner.id, r.mediaId);
    const before = (await auditRows(emel.t.id, "treatment.photo_confirmed")).length;
    await confirm(emel, owner.id, r.mediaId);
    expect((await auditRows(emel.t.id, "treatment.photo_confirmed")).length).toBe(before);
  });

  it("object level: nothing is readable once the customer is deleted or the appointment is no longer completed; a ready path accepts no second upload; another bucket's same name is not exposed", async () => {
    const c = await customer(emel, "Nesne Duzeyi");
    const v = await visit(emel, c, await dayOffset(-9), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    const p = await readyPhoto(emel, v.itemIds[0]!);
    const visible = (name: string, bucket = "treatment-media") =>
      asAuthenticatedUser(owner.id, (sql) => sql<{ n: string }[]>`select count(*)::text as n from storage.objects where bucket_id = ${bucket} and name = ${name}`).then((r) => r[0]!.n);
    expect(await visible(p.path)).toBe("1");
    await testDb`update customers set deleted_at = now() where id = ${c.id}`;
    expect(await visible(p.path)).toBe("0");
    await testDb`update customers set deleted_at = null where id = ${c.id}`;
    await testDb`update appointments set status = 'cancelled' where id = ${v.id}`;
    expect(await visible(p.path)).toBe("0");
    await testDb`update appointments set status = 'completed' where id = ${v.id}`;
    expect(await visible(p.path)).toBe("1");
    expect(await attemptAs(owner.id, (sql) => sql`insert into storage.objects (bucket_id, name, metadata) values ('treatment-media', ${p.path}, '{}'::jsonb)`)).toMatchObject({ ok: false });
    await testDb`insert into storage.buckets (id, name, public) values ('misc-bucket', 'misc-bucket', false) on conflict do nothing`;
    await testDb`insert into storage.objects (bucket_id, name, metadata) values ('misc-bucket', ${p.path}, '{}'::jsonb)`;
    expect(await visible(p.path, "misc-bucket")).toBe("0");
    expect(await attemptAs(owner.id, (sql) => sql`insert into storage.objects (bucket_id, name, metadata) values ('misc-bucket', ${emel.t.id + "/" + crypto.randomUUID() + ".jpg"}, '{}'::jsonb)`)).toMatchObject({ ok: false });
  });

  it("upload is refused once the registrant lost customers.update; deletion by a role without it is refused at the object level", async () => {
    const temp = await user("temp-role");
    const roleId = await createCustomRole(emel.t.id, "Gecici Foto", ["customers.update", "customers.view"]);
    await addMembership(emel.t.id, temp.id, roleId);
    const c = await customer(emel, "Rol Degisimi");
    const v = await visit(emel, c, await dayOffset(-11), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    const r = await register(emel, temp.id, v.itemIds[0]!);
    await testDb`delete from role_permissions where role_id = ${roleId} and permission_id = (select id from permissions where key = 'customers.update')`;
    expect(await attemptAs(temp.id, (sql) => sql`insert into storage.objects (bucket_id, name, metadata) values ('treatment-media', ${r.path}, '{}'::jsonb)`)).toMatchObject({ ok: false });
    const ready = await readyPhoto(emel, v.itemIds[0]!);
    const gone = await asAuthenticatedUser(temp.id, (sql) => sql<{ name: string }[]>`delete from storage.objects where bucket_id = 'treatment-media' and name = ${ready.path} returning name`);
    expect(gone).toEqual([]);
  });
});

describe("round two: permission edges, each tenant predicate alone, table checks, object policies per bucket", () => {
  const corrupt = (run: (tx: typeof testDb) => Promise<unknown>) =>
    testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await run(tx as never);
    });

  it("a custom view-only role cannot quick-rebook, confirm or delete; a customer-only role cannot read a photo", async () => {
    const c = await customer(emel, "Yetki Kenari");
    const v = await visit(emel, c, await dayOffset(-13), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    const r = await register(emel, owner.id, v.itemIds[0]!);
    const ready = await readyPhoto(emel, v.itemIds[0]!);
    expect(await attemptAs(viewOnly.id, (sql) => sql`select public.get_treatment_rebook_defaults(${emel.t.id}, ${v.itemIds[0]!})`)).toMatchObject({ ok: false, code: "BH002" });
    expect(await attemptAs(viewOnly.id, (sql) => sql`select public.confirm_treatment_photo(${emel.t.id}, ${r.mediaId})`)).toMatchObject({ ok: false, code: "BH002" });
    expect(await attemptAs(viewOnly.id, (sql) => sql`select public.delete_treatment_photo(${emel.t.id}, ${ready.mediaId})`)).toMatchObject({ ok: false, code: "BH002" });
    expect(await attemptAs(noAppt.id, (sql) => sql`select public.get_treatment_photo_access(${emel.t.id}, ${ready.mediaId})`)).toMatchObject({ ok: false, code: "BH002" });
  });

  it("a deleted salon is closed to its own Owner", async () => {
    const f = await salon("deltenant", await user("deltenant-owner"), ["Ece"], [["Kaş Alımı", 10, null, null]]);
    const c = await customer(f, "Silinen Salon");
    await testDb`update tenants set deleted_at = now() where id = ${f.t.id}`;
    try {
      expect(await attemptAs(f.ownerId, (sql) => sql`select public.get_customer_treatment_history(${f.t.id}, ${c.id}, 10)`)).toMatchObject({ ok: false, code: "BH002" });
    } finally {
      await testDb`update tenants set deleted_at = null where id = ${f.t.id}`;
    }
  });

  it("the treatment check needs the item, its appointment AND its customer to belong to the tenant (each alone)", async () => {
    const c = await customer(gok, "Tek Tek");
    const v = await visit(gok, c, await dayOffset(-4), [["Ahmet", "Boya"]], "completed");
    const item = v.itemIds[0]!;
    const tries = [
      ["item", `update appointment_items set tenant_id = '${other.t.id}' where id = '${item}'`, `update appointment_items set tenant_id = '${gok.t.id}' where id = '${item}'`],
      ["appointment", `update appointments set tenant_id = '${other.t.id}' where id = '${v.id}'`, `update appointments set tenant_id = '${gok.t.id}' where id = '${v.id}'`],
      ["customer", `update customers set tenant_id = '${other.t.id}' where id = '${c.id}'`, `update customers set tenant_id = '${gok.t.id}' where id = '${c.id}'`],
    ] as const;
    for (const [label, bad, good] of tries) {
      await corrupt((tx) => tx.unsafe(bad));
      try {
        if (label !== "customer") expect((await history(gok, gok.ownerId, c)).items, `${label} history`).toHaveLength(0);
        expect(await attemptAs(gok.ownerId, (sql) => sql`select public.set_treatment_note(${gok.t.id}, ${item}, 'x')`), label).toMatchObject({ ok: false, code: "BH003" });
      } finally {
        await corrupt((tx) => tx.unsafe(good));
      }
    }
    expect((await history(gok, gok.ownerId, c)).items).toHaveLength(1);
  });

  it("quick rebook never offers a foreign person or branch even if their links exist; a deleted branch is not offered", async () => {
    const c = await customer(gok, "Yabanci Baglanti");
    const v = await visit(gok, c, await dayOffset(-2), [["Ahmet", "Boya"]], "completed");
    const item = v.itemIds[0]!;
    const defaults = () => asAuthenticatedUser(gok.ownerId, (sql) => sql<{ r: { branchId: string | null; staffId: string | null } }[]>`select public.get_treatment_rebook_defaults(${gok.t.id}, ${item}) as r`).then((r) => r[0]!.r);
    const foreignStaff = other.staff["Baska Kisi"]!;
    await corrupt(async (tx) => {
      await tx`insert into staff_services (staff_member_id, service_id) values (${foreignStaff}, ${gok.svc["Boya"]!}) on conflict do nothing`;
      await tx`insert into staff_branches (staff_member_id, branch_id) values (${foreignStaff}, ${gok.branch}) on conflict do nothing`;
      await tx`update appointment_items set actual_staff_member_id = ${foreignStaff} where id = ${item}`;
    });
    try {
      expect((await defaults()).staffId).toBeNull();
    } finally {
      await corrupt(async (tx) => {
        await tx`update appointment_items set actual_staff_member_id = ${gok.staff["Ahmet"]!} where id = ${item}`;
        await tx`delete from staff_services where staff_member_id = ${foreignStaff} and service_id = ${gok.svc["Boya"]!}`;
        await tx`delete from staff_branches where staff_member_id = ${foreignStaff} and branch_id = ${gok.branch}`;
      });
    }
    const [foreignBranch] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${other.t.id} limit 1`;
    await corrupt(async (tx) => {
      await tx`insert into service_branches (service_id, branch_id) values (${gok.svc["Boya"]!}, ${foreignBranch!.id}) on conflict do nothing`;
      await tx`update appointments set branch_id = ${foreignBranch!.id} where id = ${v.id}`;
    });
    try {
      expect((await defaults()).branchId).toBeNull();
    } finally {
      await corrupt(async (tx) => {
        await tx`update appointments set branch_id = ${gok.branch} where id = ${v.id}`;
        await tx`delete from service_branches where service_id = ${gok.svc["Boya"]!} and branch_id = ${foreignBranch!.id}`;
      });
    }
    await testDb`update branches set deleted_at = now() where id = ${gok.branch}`;
    try {
      expect(await defaults()).toEqual({ serviceId: gok.svc["Boya"], serviceName: "Boya", branchId: null, staffId: null });
    } finally {
      await testDb`update branches set deleted_at = null where id = ${gok.branch}`;
    }
    expect((await defaults()).branchId).toBe(gok.branch);
  });

  it("an in-progress appointment counts as booked; another salon's appointment of the same customer id does not", async () => {
    const c = await customer(emel, "Surmekte");
    await visit(emel, c, await dayOffset(-35), [["Emel Kaynakkan", "Kaş Laminasyonu"]], "completed");
    const up = await visit(emel, c, null, [["Emel Kaynakkan", "Kaş Laminasyonu"]], "scheduled");
    await testDb`update appointments set status = 'in_progress' where id = ${up.id}`;
    expect((await history(emel, owner.id, c)).items[0]!.rebook!.state).toBe("booked");
    await testDb`update appointments set status = 'scheduled' where id = ${up.id}`;
    await corrupt((tx) => tx`update appointments set tenant_id = ${other.t.id} where id = ${up.id}`);
    try {
      expect((await history(emel, owner.id, c)).items[0]!.rebook!.state).toBe("due");
    } finally {
      await corrupt((tx) => tx`update appointments set tenant_id = ${emel.t.id} where id = ${up.id}`);
    }
  });

  it("the item's recorded performer is used without a checkout; the date is the salon's local date even at 01:00", async () => {
    const c = await customer(gok, "Gece Yarisi");
    const v = await visit(gok, c, await dayOffset(-6), [["Ahmet", "Sakal"]], "completed", "01:00");
    expect((await history(gok, gok.ownerId, c)).items[0]).toMatchObject({ date: await dayOffset(-6), staffName: "Ahmet" });
    await testDb`update appointment_items set actual_staff_member_id = ${gok.staff["Burak"]!} where id = ${v.itemIds[0]!}`;
    expect((await history(gok, gok.ownerId, c)).items[0]!.staffName).toBe("Burak");
  });

  it("a foreign photo row or note row wearing this treatment is not shown, readable, confirmable or deletable here", async () => {
    const c = await customer(emel, "Yabanci Satir");
    const v = await visit(emel, c, await dayOffset(-15), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    const item = v.itemIds[0]!;
    const foreignReady = crypto.randomUUID();
    const foreignPending = crypto.randomUUID();
    await corrupt(async (tx) => {
      await tx`insert into treatment_media (id, tenant_id, appointment_item_id, kind, mime_type, size_bytes, storage_path, status, created_by)
        values (${foreignReady}, ${other.t.id}, ${item}, 'before', 'image/jpeg', 10, ${other.t.id + "/" + foreignReady + ".jpg"}, 'ready', ${owner.id}),
               (${foreignPending}, ${other.t.id}, ${item}, 'after', 'image/jpeg', 10, ${other.t.id + "/" + foreignPending + ".jpg"}, 'pending', ${owner.id})`;
      await tx`insert into treatment_notes (appointment_item_id, tenant_id, note) values (${item}, ${other.t.id}, 'yabanci not')`;
    });
    try {
      const h = await history(emel, owner.id, c);
      expect(h.items[0]!.media).toEqual([]);
      expect(h.items[0]!.note).toBeNull();
      await expect(access(emel, owner.id, foreignReady)).rejects.toMatchObject({ code: "BH003" });
      await expect(confirm(emel, owner.id, foreignPending)).rejects.toMatchObject({ code: "BH003" });
      expect(await attemptAs(owner.id, (sql) => sql`select public.delete_treatment_photo(${emel.t.id}, ${foreignReady})`)).toMatchObject({ ok: false, code: "BH003" });
    } finally {
      await corrupt(async (tx) => {
        await tx`delete from treatment_media where id in (${foreignReady}, ${foreignPending})`;
        await tx`delete from treatment_notes where appointment_item_id = ${item}`;
      });
    }
  });

  it("a note can be changed and the change is audited; confirming a photo of a closed treatment is refused", async () => {
    const c = await customer(emel, "Not Degisimi");
    const v = await visit(emel, c, await dayOffset(-16), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    const set = (n: string) => asAuthenticatedUser(owner.id, (sql) => sql`select public.set_treatment_note(${emel.t.id}, ${v.itemIds[0]!}, ${n})`);
    await set("ilk");
    await set("ikinci");
    expect((await history(emel, owner.id, c)).items[0]!.note).toBe("ikinci");
    expect((await auditRows(emel.t.id, "treatment.note_set")).length).toBeGreaterThan(1);
    const r = await register(emel, owner.id, v.itemIds[0]!);
    await putObject(r.path);
    await testDb`update appointments set status = 'cancelled' where id = ${v.id}`;
    await expect(confirm(emel, owner.id, r.mediaId)).rejects.toMatchObject({ code: "BH003" });
    await testDb`update appointments set status = 'completed' where id = ${v.id}`;
  });

  it("the policies are bound to the treatment bucket: another bucket accepts neither a registered name nor a tenant-folder delete", async () => {
    const c = await customer(emel, "Kova Siniri");
    const v = await visit(emel, c, await dayOffset(-17), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    const r = await register(emel, owner.id, v.itemIds[0]!);
    await testDb`insert into storage.buckets (id, name, public) values ('misc-bucket', 'misc-bucket', false) on conflict do nothing`;
    expect(await attemptAs(owner.id, (sql) => sql`insert into storage.objects (bucket_id, name, metadata) values ('misc-bucket', ${r.path}, '{}'::jsonb)`)).toMatchObject({ ok: false });
    const ready = await readyPhoto(emel, v.itemIds[0]!);
    await testDb`insert into storage.objects (bucket_id, name, metadata) values ('misc-bucket', ${ready.path}, '{}'::jsonb)`;
    const gone = await asAuthenticatedUser(owner.id, (sql) => sql<{ name: string }[]>`delete from storage.objects where bucket_id = 'misc-bucket' and name = ${ready.path} returning name`);
    expect(gone).toEqual([]);
  });

  it("confirming needs customers.update itself, not just being the registrant on record", async () => {
    const c = await customer(emel, "Kayit Sahibi");
    const v = await visit(emel, c, await dayOffset(-19), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    const r = await register(emel, owner.id, v.itemIds[0]!);
    await putObject(r.path);
    await testDb`update treatment_media set created_by = ${viewOnly.id} where id = ${r.mediaId}`; // a registrant who has since lost (or never had) customers.update
    expect(await attemptAs(viewOnly.id, (sql) => sql`select public.confirm_treatment_photo(${emel.t.id}, ${r.mediaId})`)).toMatchObject({ ok: false, code: "BH002" });
  });

  it("the tables refuse bad rows on their own: blank note, bad type, huge size, unknown kind, free-form path; rebook upper bound", async () => {
    const c = await customer(emel, "Tablo Kontrol");
    const v = await visit(emel, c, await dayOffset(-18), [["Emel Kaynakkan", "Kaş Alımı"]], "completed");
    const item = v.itemIds[0]!;
    const media = (kind: string, mime: string, size: number, path: string) =>
      testDb`insert into treatment_media (tenant_id, appointment_item_id, kind, mime_type, size_bytes, storage_path) values (${emel.t.id}, ${item}, ${kind}, ${mime}, ${size}, ${path})`;
    const good = `${emel.t.id}/${crypto.randomUUID()}.jpg`;
    await expect(testDb`insert into treatment_notes (appointment_item_id, tenant_id, note) values (${item}, ${emel.t.id}, '   ')`).rejects.toMatchObject({ code: "23514" });
    await expect(media("before", "image/gif", 10, good)).rejects.toMatchObject({ code: "23514" });
    await expect(media("before", "image/jpeg", 2097153, good)).rejects.toMatchObject({ code: "23514" });
    await expect(media("selfie", "image/jpeg", 10, good)).rejects.toMatchObject({ code: "23514" });
    await expect(media("before", "image/jpeg", 10, "kisi-adi/foto.jpg")).rejects.toMatchObject({ code: "23514" });
    await expect(testDb`update services set rebook_min_days = 1, rebook_max_days = 731 where id = ${emel.svc["Kaş Alımı"]!}`).rejects.toMatchObject({ code: "23514" });
    await media("before", "image/jpeg", 10, good);
    await testDb`delete from treatment_media where storage_path = ${good}`;
  });

  it("the history never returns more than 200 rows, however large a limit is asked for", async () => {
    const c = await customer(gok, "Cok Kayit");
    await testDb`insert into appointments (tenant_id, branch_id, customer_id, scheduled_start_at, scheduled_end_at, status)
      select ${gok.t.id}, ${gok.branch}, ${c.id}, now() - (g || ' hours')::interval - interval '3 days', now() - (g || ' hours')::interval - interval '3 days' + interval '30 minutes', 'completed'
      from generate_series(1, 205) g`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      select ap.tenant_id, ap.id, ${gok.svc["Sakal"]!}, ${gok.staff["Ahmet"]!}, ap.scheduled_start_at, ap.scheduled_end_at, 30, 10, 1 from appointments ap where ap.customer_id = ${c.id}`;
    const h = await history(gok, gok.ownerId, c, 1000);
    expect(h.items).toHaveLength(200);
    expect(h.hasMore).toBe(true);
  });
});

describe("TENANT ISOLATION in depth: corrupted ids cannot pull a foreign row into a history", () => {
  it("a foreign salon's service, staff or note wearing this tenant's ids is not shown (each tenant predicate alone)", async () => {
    const c = await customer(gok, "Izolasyon");
    const v = await visit(gok, c, await dayOffset(-3), [["Ahmet", "Boya"]], "completed");
    const yc = await customer(other, "Yabanci");
    const yv = await visit(other, yc, await dayOffset(-3), [["Baska Kisi", "Kas Laminasyonu"]], "completed");
    const baseline = (await history(gok, gok.ownerId, c)).items.length;
    expect(baseline).toBe(1);
    // the foreign appointment pretends to belong to this customer (appointment tenant stays foreign)
    await testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update appointments set customer_id = ${c.id} where id = ${yv.id}`;
    });
    try {
      expect((await history(gok, gok.ownerId, c)).items).toHaveLength(1);
    } finally {
      await testDb.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update appointments set customer_id = ${yc.id} where id = ${yv.id}`;
      });
    }
    // an item row of this tenant pointing at a foreign service / foreign staff
    await testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update appointment_items set service_id = ${other.svc["Kas Laminasyonu"]!} where id = ${v.itemIds[0]!}`;
    });
    try {
      expect((await history(gok, gok.ownerId, c)).items).toHaveLength(0);
    } finally {
      await testDb.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update appointment_items set service_id = ${gok.svc["Boya"]!} where id = ${v.itemIds[0]!}`;
      });
    }
    await testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update appointment_items set staff_member_id = ${other.staff["Baska Kisi"]!}, actual_staff_member_id = ${other.staff["Baska Kisi"]!} where id = ${v.itemIds[0]!}`;
    });
    try {
      expect((await history(gok, gok.ownerId, c)).items[0]!.staffName).toBeNull();
    } finally {
      await testDb.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update appointment_items set staff_member_id = ${gok.staff["Ahmet"]!}, actual_staff_member_id = ${gok.staff["Ahmet"]!} where id = ${v.itemIds[0]!}`;
      });
    }
    // a foreign tenant's customer id is simply unknown in this tenant
    expect(await attemptAs(gok.ownerId, (sql) => sql`select public.get_customer_treatment_history(${gok.t.id}, ${yc.id}, 10)`)).toMatchObject({ ok: false, code: "BH003" });
  });
});
