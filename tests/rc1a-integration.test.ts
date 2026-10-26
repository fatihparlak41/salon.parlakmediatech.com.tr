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
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  safeMorningStart,
  testDb,
  type TestUser,
} from "./helpers";
import { buildCustomerNotificationEmail } from "@/lib/email/templates/appointment-notifications";

/**
 * RC.1A - the integrated product, against the real database functions of ALL seven accepted workstreams applied in migration order.
 * Real facts: the business name, its single provider, the catalogue (names, prices, customer-facing ranges, salon wording, the
 * 4-8 week recommendation, the preparation request). SYNTHETIC: every account, customer, e-mail, phone, date, photo row and every
 * calendar duration (30 / 45 min are test values, never the business's). No mail is ever sent: e-mails are only RENDERED from the
 * claimed payload.
 */

const TZ = "Asia/Nicosia";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PREP = "Lütfen kaşlarınızı almadan geliniz.";
const SYNTHETIC_MINUTES = 30; // synthetic, test-only calendar duration

const users: TestUser[] = [];
const tenants: string[] = [];
const stamp = Math.random().toString(36).slice(2, 7);
let counter = 0;

async function user(label: string): Promise<TestUser> {
  const u = await createTestUser(`rc-${label}`);
  users.push(u);
  return u;
}
async function dayOffset(n: number): Promise<string> {
  const [r] = await testDb<{ d: string }[]>`select (((now() at time zone ${TZ})::date) + ${n}::int)::text as d`;
  return r!.d;
}
async function at(day: string, time: string): Promise<string> {
  const [r] = await testDb<{ ts: string }[]>`select (((${day}::date + ${time}::time) at time zone ${TZ}) at time zone 'UTC')::text || '+00' as ts`;
  return r!.ts;
}

/* ------------------------------------------------------------------------------------------------ Emel (owner setup)
 * Built through the LAUNCH.1C onboarding RPCs, then enriched with the BEAUTY.1A / BEAUTY.1B service fields exactly as the one
 * service edit model writes them (an owner UPDATE under the real RLS). */
type Status = { ready: boolean; bookingEngineReady: boolean; blockers: string[]; steps: { key: string; done: boolean }[]; counts: Record<string, number> };

const CATALOGUE: { name: string; price: number; display?: [number, number | null]; extra?: Record<string, unknown> }[] = [
  { name: "Kaş Alımı", price: 600, display: [10, 15] },
  { name: "Kaş Laminasyonu", price: 2000, display: [30, 40], extra: { public_summary: "Şekillendirme ve bakım odaklı.", preparation_note: PREP, important_note: "Yaklaşık 4–8 hafta kullanılabilir.", rebook_min_days: 28, rebook_max_days: 56 } },
  { name: "Kirpik Laminasyonu", price: 2000, display: [40, null] },
  { name: "Kaş Laminasyonu + Kaş Alımı", price: 2500 },
  { name: "Klasik Bakım", price: 4000, display: [50, 70] },
  { name: "Yosun Peeling", price: 5000, display: [50, 70], extra: { badge_label: "Klasik bakım dahil" } },
  { name: "Nem Bakımı", price: 4000, display: [50, 70] },
  { name: "Akne Tedavisi", price: 5000, display: [50, 70] },
];
const INQUIRY = ["Stüdyo Dışı Makyaj", "Gelin / Nişan / Kına Makyajı", "Nedime Makyajı"];

type Emel = { t: { id: string; slug: string }; branch: string; owner: TestUser; staffId: string; svc: Record<string, string> };
let emel: Emel;
let ownerE: TestUser;
let manager: TestUser;
let receptionist: TestUser;
let stylist: TestUser;
let otherOwner: TestUser;
let other: { id: string; slug: string; ownerId: string };

const status = (t: string, userId: string) =>
  asAuthenticatedUser(userId, (sql) => sql<{ s: Status }[]>`select public.get_onboarding_status(${t}) as s`).then((r) => r[0]!.s);

async function visit(fx: { t: { id: string }; branch: string; owner: TestUser }, customerId: string, day: string | null, items: [string, string][], final: "completed" | "cancelled" | "confirmed" | "scheduled", time = "10:00"): Promise<{ id: string; itemIds: string[] }> {
  counter += 1;
  const future = safeMorningStart(60 + counter);
  const [row] = await asAuthenticatedUser(fx.owner.id, (sql) =>
    sql<{ id: string }[]>`select public.create_appointment(${fx.t.id}, ${fx.branch}, ${customerId}, ${sql.json(
      items.map(([staff, service], i) => ({ service_id: service, staff_member_id: staff, scheduled_start_at: new Date(future.getTime() + i * 3600_000).toISOString(), sequence: i + 1 })) as never,
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
  if (final === "completed") await asAuthenticatedUser(fx.owner.id, (sql) => sql`select public.complete_appointment(${id}, '[]'::jsonb)`);
  else if (final !== "scheduled") await asAuthenticatedUser(fx.owner.id, (sql) => sql`select public.update_appointment_status(${id}, ${final})`);
  return { id, itemIds: (await testDb<{ id: string }[]>`select id from appointment_items where appointment_id = ${id} order by sequence`).map((r) => r.id) };
}
async function customer(tenantId: string, name: string, phone: string | null = "0542 555 11 22", email: string | null = "sentetik-musteri@example.test"): Promise<string> {
  const [c] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name, phone, email, notes) values (${tenantId}, ${name}, ${phone}, ${email}, 'MUSTERI-NOTU-GIZLI') returning id`;
  return c!.id;
}
async function guestBook(slug: string, branch: string, service: string, startIso: string, name: string, phone: string, email: string) {
  return testDb`select private.create_guest_booking(${slug}, ${branch}, ${service}, ${startIso}::timestamptz, ${name}, ${phone}, null, ${email}, ${crypto.randomUUID()}, null, null) as r`;
}

beforeAll(async () => {
  ownerE = await user("emel-owner"); // SYNTHETIC account standing in for the owner; no real address anywhere
  manager = await user("manager");
  receptionist = await user("reception");
  stylist = await user("stylist");
  otherOwner = await user("other");

  // 1. Owner setup through the real onboarding RPCs
  const slug = `rc-emel-${stamp}`;
  await asAuthenticatedUser(ownerE.id, (sql) => sql`select public.create_tenant('Emel Beauty Bar', ${slug})`);
  const [tenant] = await testDb<{ id: string }[]>`select id from tenants where slug = ${slug}`;
  tenants.push(tenant!.id);
  const [branch] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${tenant!.id} and is_primary`;
  const t = { id: tenant!.id, slug };
  expect((await status(t.id, ownerE.id)).ready).toBe(false); // an empty salon is incomplete

  await asAuthenticatedUser(ownerE.id, (sql) => sql`select public.update_salon_profile(${t.id}, 'Emel Beauty Bar', ${TZ}, 'TRY', '0542 123 45 67', 'Girne')`);
  const services = [...CATALOGUE.map((c) => ({ name: c.name, category: "Güzellik", durationMinutes: SYNTHETIC_MINUTES, price: String(c.price) }))];
  await asAuthenticatedUser(ownerE.id, (sql) => sql`select public.onboarding_add_services(${t.id}, ${sql.json(services as never)})`);
  // inquiry services: no price, contact only (BEAUTY.1A) - their internal placeholders are never shown or scheduled
  await asAuthenticatedUser(ownerE.id, (sql) => sql`select public.onboarding_add_services(${t.id}, ${sql.json(INQUIRY.map((n) => ({ name: n, category: "Makyaj", durationMinutes: 60, price: "0" })) as never)})`);
  // 2. ONE staff record: the owner herself (no login, no invitation)
  await asAuthenticatedUser(ownerE.id, (sql) => sql`select public.onboarding_add_staff(${t.id}, ${sql.json([{ fullName: "Emel Kaynakkan" }] as never)})`);
  const [staff] = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${t.id}`;
  await testDb`update staff_members set tenant_membership_id = (select id from tenant_memberships where tenant_id = ${t.id} and user_id = ${ownerE.id}) where id = ${staff!.id}`;
  await asAuthenticatedUser(ownerE.id, (sql) => sql`select public.onboarding_apply_weekly_hours(${t.id}, ${[staff!.id]}::uuid[], ${sql.json([1, 2, 3, 4, 5, 6, 0].map((weekday) => ({ weekday, start: "00:00", end: "23:59" })) as never)})`);
  const svcRows = await testDb<{ id: string; name: string }[]>`select id, name from services where tenant_id = ${t.id}`;
  const svc = Object.fromEntries(svcRows.map((r) => [r.name, r.id]));
  await asAuthenticatedUser(ownerE.id, (sql) => sql`select public.onboarding_set_staff_services(${t.id}, ${sql.json([{ staffId: staff!.id, serviceIds: svcRows.map((r) => r.id) }] as never)})`);
  // the BEAUTY fields, written the way the one service edit model writes them: an owner UPDATE under the real RLS
  for (const c of CATALOGUE) {
    await asAuthenticatedUser(ownerE.id, (sql) =>
      sql`update services set price_public = true, display_duration_min = ${c.display?.[0] ?? null}, display_duration_max = ${c.display?.[1] ?? null},
          public_summary = ${(c.extra?.public_summary as string) ?? null}, preparation_note = ${(c.extra?.preparation_note as string) ?? null},
          important_note = ${(c.extra?.important_note as string) ?? null}, badge_label = ${(c.extra?.badge_label as string) ?? null},
          rebook_min_days = ${(c.extra?.rebook_min_days as number) ?? null}, rebook_max_days = ${(c.extra?.rebook_max_days as number) ?? null},
          aftercare_note = 'Sonrasi-notu-ASLA-EPOSTAYA-GITMEZ', description = 'IC-ACIKLAMA-GIZLI'
          where id = ${svc[c.name]!}`,
    );
  }
  // the combined offer and the 5,000 makeup are contact-only until their durations are confirmed; inquiry pricing for the variable ones
  await testDb`update services set booking_mode = 'inquiry' where id = ${svc["Kaş Laminasyonu + Kaş Alımı"]!}`;
  for (const n of INQUIRY) await asAuthenticatedUser(ownerE.id, (sql) => sql`update services set pricing_mode = 'inquiry', booking_mode = 'inquiry' where id = ${svc[n]!}`);
  await asAuthenticatedUser(ownerE.id, (sql) => sql`select public.set_online_booking_enabled(${t.id}, true)`);

  emel = { t, branch: branch!.id, owner: ownerE, staffId: staff!.id, svc };
  // create_tenant already cloned the four default roles into the new salon: teammates join the existing ones
  for (const [u, key] of [[manager, "SALON_MANAGER"], [receptionist, "RECEPTIONIST"], [stylist, "STYLIST"]] as const) {
    const [role] = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${t.id} and key = ${key}`;
    await addMembership(t.id, u.id, role!.id);
  }

  const oSlug = `rc-other-${stamp}`;
  const oTenant = await createTestTenant(oSlug, otherOwner.id);
  tenants.push(oTenant.id);
  await testDb`update tenants set timezone = ${TZ}, currency = 'TRY' where id = ${oTenant.id}`;
  other = { id: oTenant.id, slug: oSlug, ownerId: otherOwner.id };
}, 300_000);

afterAll(async () => {
  await testDb`delete from staff_commission_rules where tenant_id = any(${tenants}::uuid[])`;
  await cleanupTenants(tenants);
  await cleanupUsers(users.map((u) => u.id));
}, 240_000);

describe("EMEL integrated flow (owner, one staff record, catalogue)", () => {
  it("1-2/14. owner setup is complete with one staff record and the salon is ready; the combined staff/owner person is one row", async () => {
    const s = await status(emel.t.id, ownerE.id);
    expect(s.blockers).toEqual([]);
    expect(s.ready).toBe(true);
    expect(s.bookingEngineReady).toBe(true);
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_members where tenant_id = ${emel.t.id} and deleted_at is null`;
    expect(n!.n).toBe("1");
  });

  it("3. the catalogue: one model carries pricing, display range, copy, preparation, rebooking interval; advanced beauty data was optional for readiness", async () => {
    const ctx = await asDatabaseRole("anon", null, (sql) => sql<{ c: { branches: { services: Record<string, unknown>[] }[] } }[]>`select public.get_public_booking_context(${emel.t.slug}) as c`).then((r) => r[0]!.c);
    const byName = Object.fromEntries(ctx.branches[0]!.services.map((s) => [s.name as string, s]));
    expect(byName["Kaş Laminasyonu"]).toMatchObject({ pricingMode: "fixed", bookingMode: "direct", price: 2000, displayDurationMin: 30, displayDurationMax: 40, summary: "Şekillendirme ve bakım odaklı.", preparationNote: PREP, importantNote: "Yaklaşık 4–8 hafta kullanılabilir." });
    expect(byName["Yosun Peeling"]).toMatchObject({ price: 5000, badge: "Klasik bakım dahil" });
    expect(byName["Kaş Laminasyonu + Kaş Alımı"]).toMatchObject({ price: 2500, bookingMode: "inquiry" });
    for (const n of INQUIRY) expect(byName[n], n).toMatchObject({ pricingMode: "inquiry", bookingMode: "inquiry", price: null });
    expect(JSON.stringify(ctx)).not.toContain("IC-ACIKLAMA-GIZLI");
    // the aftercare note is public page information (BEAUTY.1A), so it is deliberately NOT asserted absent here; it must not reach any e-mail (below)
    expect(JSON.stringify(ctx)).not.toContain("durationMinutes");
  });

  it("4. single-staff booking: exactly one eligible person for a direct service (the wizard skips the staff step on this fact); none for the contact-only ones", async () => {
    const eligible = (service: string) =>
      asDatabaseRole("anon", null, (sql) => sql<{ r: { id: string }[] }[]>`select public.get_public_eligible_staff(${emel.t.slug}, ${emel.branch}, ${service}) as r`).then((r) => r[0]!.r);
    expect((await eligible(emel.svc["Kaş Laminasyonu"]!)).map((s) => s.id)).toEqual([emel.staffId]);
    for (const n of [...INQUIRY, "Kaş Laminasyonu + Kaş Alımı"]) expect(await eligible(emel.svc[n]!), n).toEqual([]);
  });

  it("5/6. a direct service books through the public path; a contact-only service cannot create an appointment by any path", async () => {
    const day = await dayOffset(4);
    const start = await at(day, "10:00");
    const [ok] = await guestBook(emel.t.slug, emel.branch, emel.svc["Kaş Laminasyonu"]!, start, "Sentetik Misafir", "0542 777 88 99", "misafir@example.test");
    expect((ok!.r as { serviceName: string; staffName: string; price: number }).serviceName).toBe("Kaş Laminasyonu");
    expect((ok!.r as { staffName: string }).staffName).toBe("Emel Kaynakkan");
    for (const n of [...INQUIRY, "Kaş Laminasyonu + Kaş Alımı"]) {
      await expect(guestBook(emel.t.slug, emel.branch, emel.svc[n]!, await at(await dayOffset(5), "11:00"), "Sentetik Misafir", "0542 777 88 99", "misafir@example.test"), n).rejects.toMatchObject({ code: "BK003" });
      const [c] = await testDb<{ n: string }[]>`select count(*)::text as n from appointment_items where service_id = ${emel.svc[n]!}`;
      expect(c!.n, n).toBe("0");
    }
    const cust = await customer(emel.t.id, "Dahili Musteri", "0542 100 20 30", null);
    expect(await attemptAs(ownerE.id, (sql) => sql`select public.create_appointment(${emel.t.id}, ${emel.branch}, ${cust}, ${sql.json([{ service_id: emel.svc["Gelin / Nişan / Kına Makyajı"], staff_member_id: emel.staffId, scheduled_start_at: new Date(Date.now() + 5 * 86400_000).toISOString(), sequence: 1 }] as never)}, null)`)).toMatchObject({ ok: false, code: "BK003" });
  });
});

describe("customer identity, history, treatment photos, rebooking (one customer history)", () => {
  let cust: string;
  let lam: { id: string; itemIds: string[] };

  it("3 (integration). a booking with the same number written differently reuses the one customer (normalised phone)", async () => {
    const before = Number((await testDb<{ n: string }[]>`select count(*)::text as n from customers where tenant_id = ${emel.t.id}`)[0]!.n);
    const [again] = await guestBook(emel.t.slug, emel.branch, emel.svc["Kaş Alımı"]!, await at(await dayOffset(6), "10:00"), "Sentetik Misafir", "+90 542 777 88 99", "misafir@example.test");
    expect(again).toBeTruthy();
    const after = Number((await testDb<{ n: string }[]>`select count(*)::text as n from customers where tenant_id = ${emel.t.id}`)[0]!.n);
    expect(after).toBe(before);
    const rows = await testDb<{ canon: string | null }[]>`select private.normalize_phone(phone) as canon from customers where tenant_id = ${emel.t.id} and full_name = 'Sentetik Misafir'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.canon).toBe("+905427778899");
  });

  it("7. a completed visit appears ONCE in the one history (CUST.1A visit frame + BEAUTY.1B treatment card); open, future and cancelled ones are not treatments", async () => {
    cust = await customer(emel.t.id, "Sentetik Tedavi Musterisi", "0533 444 55 66", "tedavi@example.test");
    lam = await visit(emel, cust, await dayOffset(-35), [[emel.staffId, emel.svc["Kaş Laminasyonu"]!]], "completed");
    await visit(emel, cust, await dayOffset(-10), [[emel.staffId, emel.svc["Kirpik Laminasyonu"]!]], "cancelled");
    await visit(emel, cust, null, [[emel.staffId, emel.svc["Kaş Alımı"]!]], "scheduled");
    const visits = await asAuthenticatedUser(ownerE.id, (sql) => sql<{ h: { summary: { completedVisits: number; upcoming: number; cancelled: number }; past: { status: string }[] } }[]>`select public.get_customer_history(${cust}, 50) as h`).then((r) => r[0]!.h);
    expect(visits.summary).toMatchObject({ completedVisits: 1, upcoming: 1, cancelled: 1 });
    const treatments = await asAuthenticatedUser(ownerE.id, (sql) => sql<{ h: { items: { serviceName: string; staffName: string; value: string }[] } }[]>`select public.get_customer_treatment_history(${emel.t.id}, ${cust}, 50) as h`).then((r) => r[0]!.h);
    expect(treatments.items).toHaveLength(1);
    expect(treatments.items[0]).toMatchObject({ serviceName: "Kaş Laminasyonu", staffName: "Emel Kaynakkan", value: "2000.00" });
  });

  it("8/7(photo). a photo attaches privately to the valid treatment; an open appointment's item is refused; the path carries no customer data", async () => {
    const reg = await asAuthenticatedUser(ownerE.id, (sql) => sql<{ r: { mediaId: string; path: string } }[]>`select public.register_treatment_photo(${emel.t.id}, ${lam.itemIds[0]!}, 'before', 'image/jpeg', 1000) as r`).then((r) => r[0]!.r);
    expect(reg.path).toMatch(new RegExp(`^${emel.t.id}/${UUID}\\.jpg$`));
    expect(reg.path).not.toMatch(/Tedavi|tedavi|0533|example/);
    await testDb`insert into storage.objects (bucket_id, name, metadata) values ('treatment-media', ${reg.path}, ${testDb.json({ mimetype: "image/jpeg", size: 1000 } as never)})`;
    await asAuthenticatedUser(ownerE.id, (sql) => sql`select public.confirm_treatment_photo(${emel.t.id}, ${reg.mediaId})`);
    const access = await asAuthenticatedUser(ownerE.id, (sql) => sql<{ r: { path: string } }[]>`select public.get_treatment_photo_access(${emel.t.id}, ${reg.mediaId}) as r`).then((r) => r[0]!.r);
    expect(access.path).toBe(reg.path);
    const [open] = await testDb<{ id: string }[]>`select ai.id from appointment_items ai join appointments ap on ap.id = ai.appointment_id where ap.customer_id = ${cust} and ap.status = 'scheduled' limit 1`;
    expect(await attemptAs(ownerE.id, (sql) => sql`select public.register_treatment_photo(${emel.t.id}, ${open!.id}, 'before', 'image/jpeg', 100)`)).toMatchObject({ ok: false, code: "BH003" });
    // Personel gains no customer access because treatment data exists
    for (const call of [
      (sql: never) => (sql as never as typeof testDb)`select public.get_customer_history(${cust}, 10)`,
      (sql: never) => (sql as never as typeof testDb)`select public.get_customer_treatment_history(${emel.t.id}, ${cust}, 10)`,
      (sql: never) => (sql as never as typeof testDb)`select public.get_treatment_photo_access(${emel.t.id}, ${reg.mediaId})`,
    ]) expect((await attemptAs(stylist.id, (sql) => call(sql as never) as never)).ok).toBe(false);
  });

  it("9-10. the rebooking window is computed from the service's own 28-56 day interval; quick rebook proposes the same service and the one provider and creates NOTHING", async () => {
    const h = await asAuthenticatedUser(ownerE.id, (sql) => sql<{ h: { items: { rebook: { state: string; minDays: number; maxDays: number } | null }[] } }[]>`select public.get_customer_treatment_history(${emel.t.id}, ${cust}, 50) as h`).then((r) => r[0]!.h);
    expect(h.items[0]!.rebook).toMatchObject({ state: "due", minDays: 28, maxDays: 56 }); // 35 days ago
    const before = Number((await testDb<{ n: string }[]>`select count(*)::text as n from appointments where tenant_id = ${emel.t.id}`)[0]!.n);
    const d = await asAuthenticatedUser(ownerE.id, (sql) => sql<{ r: Record<string, unknown> }[]>`select public.get_treatment_rebook_defaults(${emel.t.id}, ${lam.itemIds[0]!}) as r`).then((r) => r[0]!.r);
    expect(d).toEqual({ serviceId: emel.svc["Kaş Laminasyonu"], serviceName: "Kaş Laminasyonu", branchId: emel.branch, staffId: emel.staffId });
    expect(Number((await testDb<{ n: string }[]>`select count(*)::text as n from appointments where tenant_id = ${emel.t.id}`)[0]!.n)).toBe(before);
  });

  it("2 (integration). an imported customer later appears in the history after a visit; an import never duplicates a normalised phone", async () => {
    const rows = [
      { row: 1, name: "Ice Aktarilan Bir", phone: "0542 800 90 10" },
      { row: 2, name: "Ice Aktarilan Bir", phone: "+90 542 800 90 10" }, // same person, written differently, in the same file
      { row: 3, name: "Sentetik Tedavi Musterisi", phone: "+905334445566" }, // an existing customer
    ];
    const before = Number((await testDb<{ n: string }[]>`select count(*)::text as n from customers where tenant_id = ${emel.t.id}`)[0]!.n);
    const r = await asAuthenticatedUser(ownerE.id, (sql) => sql<{ c: { summary: { created: number; matchExisting: number } } }[]>`select public.commit_customer_import(${emel.t.id}, ${sql.json(rows as never)}) as c`).then((x) => x[0]!.c);
    expect(r.summary.created).toBe(1);
    expect(Number((await testDb<{ n: string }[]>`select count(*)::text as n from customers where tenant_id = ${emel.t.id}`)[0]!.n)).toBe(before + 1);
    const [imp] = await testDb<{ id: string }[]>`select id from customers where tenant_id = ${emel.t.id} and full_name = 'Ice Aktarilan Bir'`;
    await visit(emel, imp!.id, await dayOffset(-3), [[emel.staffId, emel.svc["Kaş Alımı"]!]], "completed");
    const h = await asAuthenticatedUser(ownerE.id, (sql) => sql<{ h: { summary: { completedVisits: number } } }[]>`select public.get_customer_history(${imp!.id}, 50) as h`).then((x) => x[0]!.h);
    expect(h.summary.completedVisits).toBe(1);
  });
});

describe("finance and commission stay distinct (FIN.2A x COMM.1A)", () => {
  it("11/12/5-6. a completed beauty service counts once in the daily totals and once in commission; with no rule Emel's commission is 0, and a later rule is information - it never reaches the daily cash", async () => {
    const c = await customer(emel.t.id, "Finans Musterisi", "0544 111 22 33", null);
    const day = await dayOffset(-2);
    const v = await visit(emel, c, day, [[emel.staffId, emel.svc["Kaş Laminasyonu"]!]], "completed", "11:00");
    const noon = await at(day, "12:00");
    const noon5 = await at(day, "12:05");
    const [sale] = await asAuthenticatedUser(ownerE.id, (sql) => sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${v.id})`);
    await asAuthenticatedUser(ownerE.id, (sql) => sql`select * from public.record_appointment_payment(${sale!.id}, 1500, 'cash', ${noon}::timestamptz, null, ${crypto.randomUUID()})`);
    await asAuthenticatedUser(ownerE.id, (sql) => sql`select * from public.record_appointment_payment(${sale!.id}, 500, 'card', ${noon5}::timestamptz, null, ${crypto.randomUUID()})`);
    type O = { appointments: { completed: number }; services: { completedAmount: number }; payments: { totalCollected: number; cash: number; card: number }; cash: { cashCollected: number; cashPaidOut: number; difference: number }; staff: { displayName: string; completedItems: number; serviceAmount: number }[]; expenses: { accruedTotal: number } };
    const overview = () => asAuthenticatedUser(ownerE.id, (sql) => sql<{ o: O }[]>`select public.get_daily_owner_overview(${emel.t.id}, ${day}::date) as o`).then((r) => r[0]!.o);
    const o1 = await overview();
    expect(o1.appointments.completed).toBe(1);
    expect(o1.services.completedAmount).toBe(2000); // once
    expect(o1.payments).toMatchObject({ totalCollected: 2000, cash: 1500, card: 500 });
    expect(o1.cash).toMatchObject({ cashCollected: 1500, cashPaidOut: 0, difference: 1500 });
    expect(o1.staff).toHaveLength(1); // the owner is the one provider: not double counted
    expect(o1.staff[0]).toMatchObject({ displayName: "Emel Kaynakkan", completedItems: 1, serviceAmount: 2000 });

    const summary = () => asAuthenticatedUser(ownerE.id, (sql) => sql<{ s: { staff: { displayName: string; serviceAmount: number; commissionAmount: number; completedServices: number }[]; totals: { commissionAmount: number } } }[]>`select public.get_staff_commission(${emel.t.id}, ${day}::date, ${day}::date) as s`).then((r) => r[0]!.s);
    const s0 = await summary();
    expect(s0.staff).toHaveLength(1);
    expect(s0.staff[0]).toMatchObject({ displayName: "Emel Kaynakkan", completedServices: 1, serviceAmount: 2000, commissionAmount: 0 }); // no rule: 0, no error

    await asAuthenticatedUser(ownerE.id, (sql) => sql`select public.set_commission_rule(${emel.t.id}, ${emel.staffId}, ${emel.svc["Kaş Laminasyonu"]!}, 'percentage', 10, '2026-01-01'::date)`);
    const s1 = await summary();
    expect(s1.staff[0]!.commissionAmount).toBe(200); // the same item contributes ONCE (10% of 2,000, not twice)
    const o2 = await overview();
    expect(o2.cash).toEqual(o1.cash); // commission is NOT deducted from the daily cash difference
    expect(o2.expenses.accruedTotal).toBe(o1.expenses.accruedTotal); // and is not an expense
    expect(JSON.stringify(o2)).not.toMatch(/commission|komisyon/i);
    expect(o2.services.completedAmount).toBe(2000);
    await testDb`delete from staff_commission_rules where tenant_id = ${emel.t.id}`;
  });
});

describe("notification metadata materialises without sending mail (LAUNCH.1B x BEAUTY.1A)", () => {
  it("15/9. with the switches on, the claimed payload carries ONE concise preparation line from the service - and no private note of any kind; update and cancellation carry nothing new", async () => {
    for (const type of ["appointment_confirmation", "appointment_reminder_24h", "appointment_update", "appointment_cancellation"]) {
      await asAuthenticatedUser(ownerE.id, (sql) => sql`select public.set_customer_notification_setting(${emel.t.id}::uuid, ${type}, true)`);
    }
    const cust = await customer(emel.t.id, "Bildirim Musterisi", "0545 200 30 40", "bildirim@example.test");
    const [ap] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, source, notes, scheduled_start_at, scheduled_end_at)
      values (${emel.t.id}, ${emel.branch}, ${cust}, 'scheduled', 'internal', 'RANDEVU-NOTU-GIZLI-456', now() + interval '3 days', now() + interval '3 days 30 minutes') returning id`;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${emel.t.id}, ${ap!.id}, ${emel.svc["Kaş Laminasyonu"]!}, ${emel.staffId}, now() + interval '3 days', now() + interval '3 days 30 minutes', 30, 2000, 1),
             (${emel.t.id}, ${ap!.id}, ${emel.svc["Yosun Peeling"]!}, ${emel.staffId}, now() + interval '3 days 30 minutes', now() + interval '3 days 60 minutes', 30, 5000, 2)`;
    // a treatment note and a customer note exist too: none of them may travel
    await testDb`update appointments set status = 'confirmed' where id = ${ap!.id}`;
    const claimed = await testDb<{ result: { jobs: Record<string, unknown>[] } }[]>`select private.claim_customer_notification_jobs(50, 180) as result`;
    const mine = claimed[0]!.result.jobs.find((j) => j.tenantSlug === emel.t.slug && j.notificationType === "appointment_confirmation");
    expect(mine).toBeTruthy();
    expect(mine!.preparationNote).toBe(PREP); // Yosun Peeling has no preparation note: exactly one line
    const payload = JSON.stringify(mine);
    for (const secret of ["RANDEVU-NOTU-GIZLI", "MUSTERI-NOTU-GIZLI", "IC-ACIKLAMA-GIZLI", "ASLA-EPOSTAYA", "Yaklaşık 4–8"]) expect(payload, secret).not.toContain(secret);

    const input = {
      salonName: String(mine!.salonName), greetingName: String(mine!.greetingName ?? ""), appointmentStartAt: String(mine!.appointmentStartAt), tenantTimezone: String(mine!.tenantTimezone),
      serviceNames: mine!.serviceNames as string[], staffNames: mine!.staffNames as string[], contactPhone: (mine!.contactPhone as string) ?? null, locationUrl: null,
      preparationNote: mine!.preparationNote as string, referenceInstant: new Date().toISOString(), rebookUrl: null,
    };
    for (const type of ["appointment_confirmation", "appointment_reminder_24h"] as const) {
      const mail = buildCustomerNotificationEmail(type, input);
      expect(mail.text, type).toContain(`Randevu öncesi: ${PREP}`);
      expect(mail.html, type).toContain("RANDEVU ÖNCESİ");
      for (const secret of ["RANDEVU-NOTU-GIZLI", "MUSTERI-NOTU-GIZLI", "IC-ACIKLAMA-GIZLI", "ASLA-EPOSTAYA", "2000", "5000"]) expect(mail.text + mail.html, `${type} ${secret}`).not.toContain(secret);
    }
    for (const type of ["appointment_update", "appointment_cancellation"] as const) {
      const mail = buildCustomerNotificationEmail(type, input);
      expect(mail.text + mail.html, type).not.toContain(PREP);
    }
    // aftercare is NOT introduced: there is no post-appointment message type at all
    const types = await testDb<{ notification_type: string }[]>`select distinct notification_type from private.customer_notification_jobs where tenant_id = ${emel.t.id}`;
    expect(types.map((x) => x.notification_type).sort()).toEqual(expect.not.arrayContaining(["appointment_aftercare"]));
  });

  it("a preparation note never grows into a giant text: one line, at most 240 characters", () => {
    const long = "Çok uzun hazırlık notu ".repeat(40);
    const mail = buildCustomerNotificationEmail("appointment_confirmation", {
      salonName: "Salon", greetingName: null, appointmentStartAt: new Date(Date.now() + 86400_000).toISOString(), tenantTimezone: TZ, serviceNames: ["Hizmet"], staffNames: [],
      contactPhone: null, locationUrl: null, preparationNote: long, referenceInstant: new Date().toISOString(), rebookUrl: null,
    });
    const line = mail.text.split("\n").find((l) => l.startsWith("Randevu öncesi: "))!;
    expect(line.length).toBeLessThanOrEqual("Randevu öncesi: ".length + 240);
    expect(line).not.toContain("\n");
  });
});

describe("GÖKHAN-like salon regression (multi-staff, no beauty data at all)", () => {
  it("normal staff selection remains; booking, history, finance and commission work with no beauty metadata and no photos", async () => {
    const owner = await user("hair-owner");
    const t = await createTestTenant(`rc-hair-${stamp}`, owner.id);
    tenants.push(t.id);
    await testDb`update tenants set timezone = ${TZ}, currency = 'TRY' where id = ${t.id}`;
    const feature = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
    await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${t.id}, ${feature[0]!.id}, true)`;
    const branch = await createBranch(t.id, "Merkez");
    const staff: Record<string, string> = {};
    for (const n of ["Ahmet", "Burak", "Can"]) {
      const s = await createStaffMember(t.id, n);
      staff[n] = s.id;
      await linkStaffBranch(s.id, branch);
      for (let w = 0; w <= 6; w++) await createStaffSchedule(t.id, s.id, w, "00:00", "23:59");
    }
    const svc: Record<string, string> = {};
    for (const [name, price] of [["Sac Kesimi", 500], ["Boya", 1500], ["Sakal", 200]] as [string, number][]) {
      const s = await createService(t.id, name, 45, price);
      svc[name] = s.id;
      await linkServiceBranch(s.id, branch);
      for (const sid of Object.values(staff)) await linkStaffService(sid, s.id);
    }
    const hair = { t, branch, owner };
    // public: two or more eligible -> the choice stays; no beauty field is shown or required
    const eligible = await asDatabaseRole("anon", null, (sql) => sql<{ r: { id: string }[] }[]>`select public.get_public_eligible_staff(${t.slug}, ${branch}, ${svc["Sac Kesimi"]!}) as r`).then((r) => r[0]!.r);
    expect(eligible).toHaveLength(3);
    const ctx = await asDatabaseRole("anon", null, (sql) => sql<{ c: { branches: { services: Record<string, unknown>[] }[] } }[]>`select public.get_public_booking_context(${t.slug}) as c`).then((r) => r[0]!.c);
    for (const s of ctx.branches[0]!.services) {
      expect(s).toMatchObject({ pricingMode: "fixed", bookingMode: "direct", price: null, summary: null, details: null, preparationNote: null, badge: null, displayDurationMin: null });
    }
    // a booking, a multi-person visit, history, finance, commission
    const c = await customer(t.id, "Gokhan Benzeri Musteri", "0546 300 40 50", null);
    const day = await dayOffset(-1);
    const v = await visit(hair, c, day, [[staff["Ahmet"]!, svc["Sac Kesimi"]!], [staff["Burak"]!, svc["Boya"]!], [staff["Can"]!, svc["Sakal"]!]], "completed");
    const one = await at(day, "13:00");
    const [sale] = await asAuthenticatedUser(owner.id, (sql) => sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${v.id})`);
    await asAuthenticatedUser(owner.id, (sql) => sql`select * from public.record_appointment_payment(${sale!.id}, 1000, 'cash', ${one}::timestamptz, null, ${crypto.randomUUID()})`);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.set_commission_rule(${t.id}, ${staff["Ahmet"]!}, ${svc["Sac Kesimi"]!}, 'percentage', 20, '2026-01-01'::date)`);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.set_commission_rule(${t.id}, ${staff["Burak"]!}, ${svc["Boya"]!}, 'fixed', 250, '2026-01-01'::date)`);
    const th = await asAuthenticatedUser(owner.id, (sql) => sql<{ h: { items: { serviceName: string; staffName: string; media: unknown[]; rebook: unknown }[] } }[]>`select public.get_customer_treatment_history(${t.id}, ${c}, 50) as h`).then((r) => r[0]!.h);
    expect(th.items.map((i) => [i.serviceName, i.staffName]).sort()).toEqual([["Boya", "Burak"], ["Sac Kesimi", "Ahmet"], ["Sakal", "Can"]]);
    expect(th.items.every((i) => i.media.length === 0 && i.rebook === null)).toBe(true);
    const ov = await asAuthenticatedUser(owner.id, (sql) => sql<{ o: { services: { completedAmount: number }; payments: { totalCollected: number }; cash: { difference: number }; staff: unknown[] } }[]>`select public.get_daily_owner_overview(${t.id}, ${day}::date) as o`).then((r) => r[0]!.o);
    expect(ov.services.completedAmount).toBe(2200);
    expect(ov.payments.totalCollected).toBe(1000);
    expect(ov.cash.difference).toBe(1000);
    expect(ov.staff).toHaveLength(3);
    const cm = await asAuthenticatedUser(owner.id, (sql) => sql<{ s: { staff: { displayName: string; commissionAmount: number }[]; totals: { commissionAmount: number } } }[]>`select public.get_staff_commission(${t.id}, ${day}::date, ${day}::date) as s`).then((r) => r[0]!.s);
    expect(Object.fromEntries(cm.staff.map((x) => [x.displayName, x.commissionAmount]))).toEqual({ Ahmet: 100, Burak: 250, Can: 0 });
    expect(cm.totals.commissionAmount).toBe(350);
    expect(ov.cash.difference).toBe(1000); // commission did not move the cash
    // and onboarding is not forced to know any beauty field: the salon is ready as soon as the base configuration exists
    const st = await status(t.id, owner.id);
    expect(st.bookingEngineReady).toBe(true); // the booking engine needs no beauty field
    await testDb`update branches set phone = '+905321112233' where id = ${branch}`;
    const st2 = await status(t.id, owner.id);
    expect(st2.blockers).toEqual([]);
    expect(st2.ready).toBe(true);
  });
});

describe("CROSS-TENANT isolation across every integrated feature", () => {
  it("11. another salon's Owner is refused (or finds nothing) on onboarding, history, treatment history, photos, rebook, finance, commission, import and notification settings", async () => {
    const c = await customer(emel.t.id, "Yabanci Hedef", "0547 600 70 80", null);
    const v = await visit(emel, c, await dayOffset(-8), [[emel.staffId, emel.svc["Kaş Alımı"]!]], "completed");
    const calls: [string, (sql: never) => unknown][] = [
      ["onboarding status", (sql) => (sql as never as typeof testDb)`select public.get_onboarding_status(${emel.t.id})`],
      ["customer history", (sql) => (sql as never as typeof testDb)`select public.get_customer_history(${c}, 10)`],
      ["treatment history", (sql) => (sql as never as typeof testDb)`select public.get_customer_treatment_history(${emel.t.id}, ${c}, 10)`],
      ["rebook defaults", (sql) => (sql as never as typeof testDb)`select public.get_treatment_rebook_defaults(${emel.t.id}, ${v.itemIds[0]!})`],
      ["register photo", (sql) => (sql as never as typeof testDb)`select public.register_treatment_photo(${emel.t.id}, ${v.itemIds[0]!}, 'before', 'image/jpeg', 10)`],
      ["daily overview", (sql) => (sql as never as typeof testDb)`select public.get_daily_owner_overview(${emel.t.id}, 2026-10-10::date)`],
      ["commission", (sql) => (sql as never as typeof testDb)`select public.get_staff_commission(${emel.t.id}, null, null)`],
      ["commission rule", (sql) => (sql as never as typeof testDb)`select public.set_commission_rule(${emel.t.id}, ${emel.staffId}, ${emel.svc["Kaş Alımı"]!}, 'fixed', 1, null)`],
      ["import preview", (sql) => (sql as never as typeof testDb)`select public.preview_customer_import(${emel.t.id}, ${testDb.json([{ row: 1, name: "X", phone: "0540 000 00 00" }] as never)})`],
      ["import commit", (sql) => (sql as never as typeof testDb)`select public.commit_customer_import(${emel.t.id}, ${testDb.json([{ row: 1, name: "X", phone: "0540 000 00 00" }] as never)})`],
      ["notification setting", (sql) => (sql as never as typeof testDb)`select public.set_customer_notification_setting(${emel.t.id}::uuid, 'appointment_confirmation', true)`],
      ["salon profile", (sql) => (sql as never as typeof testDb)`select public.update_salon_profile(${emel.t.id}, 'X', 'Europe/Istanbul', 'TRY', '0540 000 00 00', null)`],
    ];
    for (const [label, call] of calls) {
      const r = await attemptAs(otherOwner.id, (sql) => call(sql as never) as never);
      expect(r.ok, label).toBe(false);
    }
    // nothing was written
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from customers where tenant_id = ${emel.t.id} and full_name = 'X'`;
    expect(n!.n).toBe("0");
    // and the other salon's own surfaces know nothing about Emel's rows
    const mine = await asAuthenticatedUser(otherOwner.id, (sql) => sql<{ s: { staff: unknown[]; totals: { serviceAmount: number } } }[]>`select public.get_staff_commission(${other.id}, null, null) as s`).then((r) => r[0]!.s);
    expect(mine.staff).toEqual([]);
    expect(await auditRows(other.id, "treatment.photo_registered")).toHaveLength(0);
  });
});
