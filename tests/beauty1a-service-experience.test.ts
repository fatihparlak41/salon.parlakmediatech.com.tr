import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAuthenticatedUser,
  asDatabaseRole,
  attemptAs,
  cleanupTenants,
  cleanupUsers,
  createBranch,
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
 * Faz BEAUTY.1A - the generic service-experience model against the real database functions. The catalogue below uses the
 * REAL facts the business supplied (names, prices, customer-facing duration ranges, salon-provided wording); everything else is
 * SYNTHETIC: the owner/user accounts, e-mail addresses, customers, dates, and every calendar (booking) duration - the salon has
 * not confirmed any booking duration, so the 30 / 45 minutes below are labelled test values and never presented as the business's.
 */

const SYNTHETIC_CALENDAR_MINUTES = 30; // synthetic, test-only
const SYNTHETIC_COMBINED_MINUTES = 45; // synthetic, test-only (the real combined duration is NOT confirmed)

type Svc = {
  name: string;
  price: number;
  display?: [number, number | null];
  pricingMode?: "fixed" | "inquiry";
  bookingMode?: "direct" | "inquiry";
  pricePublic?: boolean;
  summary?: string;
  details?: string;
  preparation?: string;
  important?: string;
  badge?: string;
  category?: string;
};

const SKIN_NOTE = "Cildiniz değerlendirildikten sonra sizin için uygun bakım netleştirilebilir.";

const CATALOGUE: Svc[] = [
  { name: "Kaş Alımı", price: 600, display: [10, 15], pricePublic: true, category: "Kaş / Kirpik" },
  {
    name: "Kaş Laminasyonu", price: 2000, display: [30, 40], pricePublic: true, category: "Kaş / Kirpik",
    summary: "Şekillendirme ve bakım odaklı.", important: "Yaklaşık 4–8 hafta kullanılabilir.", preparation: "Lütfen kaşlarınızı almadan geliniz.",
  },
  { name: "Kirpik Laminasyonu", price: 2000, display: [40, null], pricePublic: true, category: "Kaş / Kirpik" },
  { name: "Kaş Laminasyonu + Kaş Alımı", price: 2500, pricePublic: true, bookingMode: "inquiry", category: "Kaş / Kirpik" }, // duration not confirmed
  { name: "Klasik Bakım", price: 4000, display: [50, 70], pricePublic: true, category: "Cilt Bakımı", important: SKIN_NOTE },
  { name: "Yosun Peeling", price: 5000, display: [50, 70], pricePublic: true, category: "Cilt Bakımı", badge: "Klasik bakım dahil", details: "Leke ve gözenek bakımı.", important: SKIN_NOTE },
  { name: "Nem Bakımı", price: 4000, display: [50, 70], pricePublic: true, category: "Cilt Bakımı", important: SKIN_NOTE },
  { name: "Akne Tedavisi", price: 5000, display: [50, 70], pricePublic: true, category: "Cilt Bakımı", important: SKIN_NOTE },
  { name: "Gece / Günlük Makyaj", price: 5000, pricePublic: true, bookingMode: "inquiry", category: "Makyaj" }, // studio price known, duration not supplied
  { name: "Stüdyo Dışı Makyaj", price: 0, pricingMode: "inquiry", category: "Makyaj" },
  { name: "Gelin / Nişan / Kına Makyajı", price: 0, pricingMode: "inquiry", category: "Makyaj" },
  { name: "Nedime Makyajı", price: 0, pricingMode: "inquiry", category: "Makyaj" },
];

type PublicSvc = {
  id: string; name: string; category: string | null; pricingMode: string; bookingMode: string; price: number | null;
  displayDurationMin: number | null; displayDurationMax: number | null; summary: string | null; details: string | null;
  preparationNote: string | null; aftercareNote: string | null; importantNote: string | null; badge: string | null;
};
type PublicCtx = { bookable: boolean; branches: { id: string; services: PublicSvc[] }[] };

const users: TestUser[] = [];
const tenants: string[] = [];
const stamp = Math.random().toString(36).slice(2, 7);
let counter = 0;

async function user(label: string): Promise<TestUser> {
  const u = await createTestUser(`by-${label}`);
  users.push(u);
  return u;
}

async function enableOnlineBooking(tenantId: string) {
  const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
  await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${tenantId}, ${feature!.id}, true)`;
}

type Fx = { t: { id: string; slug: string }; ownerId: string; branch: string; svc: Record<string, string>; staff: Record<string, string> };

async function salon(label: string, owner: TestUser, staffNames: string[], services: Svc[]): Promise<Fx> {
  const t = await createTestTenant(`by-${label}-${stamp}`, owner.id);
  tenants.push(t.id);
  await enableOnlineBooking(t.id);
  const branch = await createBranch(t.id, "Merkez");
  const staff: Record<string, string> = {};
  for (const n of staffNames) {
    const s = await createStaffMember(t.id, n);
    staff[n] = s.id;
    await linkStaffBranch(s.id, branch);
    for (let w = 0; w <= 6; w++) await createStaffSchedule(t.id, s.id, w, "00:00", "23:59");
  }
  const svc: Record<string, string> = {};
  for (const s of services) {
    const created = await createService(t.id, s.name, SYNTHETIC_CALENDAR_MINUTES, s.price);
    svc[s.name] = created.id;
    await linkServiceBranch(created.id, branch);
    for (const sid of Object.values(staff)) await linkStaffService(sid, created.id);
    await testDb`update services set
        category = ${s.category ?? null},
        pricing_mode = ${s.pricingMode ?? "fixed"},
        booking_mode = ${s.pricingMode === "inquiry" ? "inquiry" : (s.bookingMode ?? "direct")},
        price_public = ${s.pricePublic ?? false},
        display_duration_min = ${s.display?.[0] ?? null},
        display_duration_max = ${s.display?.[1] ?? null},
        public_summary = ${s.summary ?? null}, public_details = ${s.details ?? null},
        preparation_note = ${s.preparation ?? null}, important_note = ${s.important ?? null}, badge_label = ${s.badge ?? null},
        description = 'IC-NOT-GIZLI'
      where id = ${created.id}`;
  }
  return { t: { id: t.id, slug: t.slug }, ownerId: owner.id, branch, svc, staff };
}

const context = (fx: Fx) =>
  asDatabaseRole("anon", null, (sql) => sql<{ c: PublicCtx }[]>`select public.get_public_booking_context(${fx.t.slug}) as c`).then((r) => r[0]!.c);
const publicSvc = async (fx: Fx, name: string) => (await context(fx)).branches[0]!.services.find((s) => s.name === name)!;
const eligible = (fx: Fx, name: string) =>
  asDatabaseRole("anon", null, (sql) => sql<{ r: { id: string; fullName: string }[] }[]>`select public.get_public_eligible_staff(${fx.t.slug}, ${fx.branch}, ${fx.svc[name]!}) as r`).then((r) => r[0]!.r);
const slots = (fx: Fx, name: string, date: string) =>
  asDatabaseRole("anon", null, (sql) => sql<{ r: string[] }[]>`select public.get_public_availability_slots(${fx.t.slug}, ${fx.branch}, ${fx.svc[name]!}, ${date}::date, null) as r`).then((r) => r[0]!.r);

async function book(fx: Fx, serviceName: string, staff: string): Promise<string> {
  counter += 1;
  const [customer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${fx.t.id}, 'Sentetik Musteri') returning id`;
  const start = safeMorningStart(3 + counter);
  const [row] = await asAuthenticatedUser(fx.ownerId, (sql) =>
    sql<{ id: string }[]>`select public.create_appointment(${fx.t.id}, ${fx.branch}, ${customer!.id}, ${sql.json([{ service_id: fx.svc[serviceName], staff_member_id: fx.staff[staff], scheduled_start_at: start.toISOString(), sequence: 1 }] as never)}, null) as id`,
  );
  return row!.id;
}

let owner: TestUser;
let manager: TestUser;
let receptionist: TestUser;
let stylist: TestUser;
let otherOwner: TestUser;
let emel: Fx;
let hair: Fx;
let duo: Fx;
let other: Fx;

beforeAll(async () => {
  owner = await user("emel-owner"); // SYNTHETIC account standing in for the owner; no real address is used anywhere
  manager = await user("manager");
  receptionist = await user("reception");
  stylist = await user("stylist");
  otherOwner = await user("other");
  emel = await salon("emel", owner, ["Emel Kaynakkan"], CATALOGUE);
  await createTestMembershipFromTemplate(emel.t.id, manager.id, "SALON_MANAGER");
  await createTestMembershipFromTemplate(emel.t.id, receptionist.id, "RECEPTIONIST");
  await createTestMembershipFromTemplate(emel.t.id, stylist.id, "STYLIST");
  // the owner IS the one provider: one staff row linked to the owner's membership (no duplicated person)
  await testDb`update staff_members set tenant_membership_id = (select id from tenant_memberships where tenant_id = ${emel.t.id} and user_id = ${owner.id}) where id = ${emel.staff["Emel Kaynakkan"]!}`;

  // a Gökhan-like hair salon: plain services with NONE of the beauty fields, two staff
  const hairOwner = await user("hair-owner");
  hair = await salon("hair", hairOwner, ["Ahmet", "Burak"], [{ name: "Sac Kesimi", price: 500 }, { name: "Boya", price: 1500 }]);
  const duoOwner = await user("duo-owner");
  duo = await salon("duo", duoOwner, ["Ayse", "Banu"], [{ name: "Cilt Bakimi", price: 800 }]);
  other = await salon("other", otherOwner, ["Baska Kisi"], [{ name: "Kas Laminasyonu", price: 1 }]);
}, 300_000);

afterAll(async () => {
  await cleanupTenants(tenants);
  await cleanupUsers(users.map((u) => u.id));
}, 180_000);

describe("FIXED vs INQUIRY pricing and the public payload", () => {
  it("a fixed-price service the salon chose to show carries its exact price and display range", async () => {
    expect(await publicSvc(emel, "Kaş Laminasyonu")).toMatchObject({
      pricingMode: "fixed", bookingMode: "direct", price: 2000, displayDurationMin: 30, displayDurationMax: 40,
      summary: "Şekillendirme ve bakım odaklı.", preparationNote: "Lütfen kaşlarınızı almadan geliniz.", importantNote: "Yaklaşık 4–8 hafta kullanılabilir.",
    });
    expect(await publicSvc(emel, "Kaş Alımı")).toMatchObject({ price: 600, displayDurationMin: 10, displayDurationMax: 15 });
    expect(await publicSvc(emel, "Kirpik Laminasyonu")).toMatchObject({ price: 2000, displayDurationMin: 40, displayDurationMax: null });
  });

  it("an inquiry service has NO price (never 0), is inquiry-booked, and says so", async () => {
    for (const name of ["Stüdyo Dışı Makyaj", "Gelin / Nişan / Kına Makyajı", "Nedime Makyajı"]) {
      const s = await publicSvc(emel, name);
      expect(s, name).toMatchObject({ pricingMode: "inquiry", bookingMode: "inquiry", price: null, displayDurationMin: null, displayDurationMax: null });
    }
    const all = (await context(emel)).branches[0]!.services;
    expect(all.some((s) => s.price === 0)).toBe(false);
  });

  it("a fixed price the salon did not opt to show stays out of the payload (the earlier no-price page is the default)", async () => {
    const s = await publicSvc(hair, "Sac Kesimi");
    expect(s).toMatchObject({ pricingMode: "fixed", bookingMode: "direct", price: null, displayDurationMin: null, summary: null, preparationNote: null });
    await testDb`update services set price_public = true where id = ${hair.svc["Sac Kesimi"]!}`;
    expect((await publicSvc(hair, "Sac Kesimi")).price).toBe(500);
    await testDb`update services set price_public = false where id = ${hair.svc["Sac Kesimi"]!}`;
  });

  it("the calendar (booking) duration and every internal field never reach the public: no durationMinutes, no description, no notes", async () => {
    const ctx = await context(emel);
    const text = JSON.stringify(ctx);
    expect(text).not.toContain("IC-NOT-GIZLI");
    expect(text).not.toContain("durationMinutes");
    expect(text).not.toContain("tenant_id");
    for (const s of ctx.branches[0]!.services) {
      expect(Object.keys(s).sort()).toEqual(["aftercareNote", "badge", "bookingMode", "category", "details", "displayDurationMax", "displayDurationMin", "id", "importantNote", "name", "preparationNote", "price", "pricingMode", "summary"]);
    }
  });

  it("information lands on the right surface: the card line / details / preparation are separate fields, absent where unset", async () => {
    const yosun = await publicSvc(emel, "Yosun Peeling");
    expect(yosun).toMatchObject({ badge: "Klasik bakım dahil", details: "Leke ve gözenek bakımı.", importantNote: SKIN_NOTE, preparationNote: null, summary: null });
    const klasik = await publicSvc(emel, "Klasik Bakım");
    expect(klasik).toMatchObject({ badge: null, details: null, importantNote: SKIN_NOTE });
    expect((await publicSvc(emel, "Kaş Alımı")).preparationNote).toBeNull(); // preparation is not on every service
  });

  it("no system-generated claim: only salon-authored text appears in any public text field", async () => {
    const ctx = await context(emel);
    const authored = new Set(CATALOGUE.flatMap((c) => [c.summary, c.details, c.preparation, c.important, c.badge, c.category, c.name]).filter(Boolean));
    for (const s of ctx.branches[0]!.services) {
      for (const k of ["summary", "details", "preparationNote", "aftercareNote", "importantNote", "badge"] as const) {
        const v = s[k];
        if (v !== null) expect(authored.has(v), `${s.name}.${k}`).toBe(true);
      }
    }
  });
});

describe("public listing boundaries", () => {
  it("an inquiry-priced service never shows a price even if the public-price flag is set on it", async () => {
    const id = emel.svc["Nedime Makyajı"]!;
    await testDb`update services set price_public = true, price = 777 where id = ${id}`;
    try {
      expect((await publicSvc(emel, "Nedime Makyajı")).price).toBeNull();
    } finally {
      await testDb`update services set price_public = false, price = 0 where id = ${id}`;
    }
  });

  it("inactive and deleted services are not listed", async () => {
    const id = emel.svc["Nem Bakımı"]!;
    await testDb`update services set status = 'inactive' where id = ${id}`;
    expect((await context(emel)).branches[0]!.services.some((s) => s.name === "Nem Bakımı")).toBe(false);
    await testDb`update services set status = 'active', deleted_at = now() where id = ${id}`;
    expect((await context(emel)).branches[0]!.services.some((s) => s.name === "Nem Bakımı")).toBe(false);
    await testDb`update services set deleted_at = null where id = ${id}`;
    expect((await context(emel)).branches[0]!.services.some((s) => s.name === "Nem Bakımı")).toBe(true);
  });

  it("another salon's service wearing this salon's branch link is neither listed nor made eligible (tenant predicates)", async () => {
    const foreignSvc = other.svc["Kas Laminasyonu"]!;
    const lonely = await salon("tenantlink", await user("tenantlink-owner"), ["Yerel Kisi"], [{ name: "Yerel Hizmet", price: 10 }]);
    await testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into service_branches (service_id, branch_id) values (${foreignSvc}, ${lonely.branch})`;
      await tx`insert into staff_services (staff_member_id, service_id) values (${lonely.staff["Yerel Kisi"]!}, ${foreignSvc})`;
    });
    try {
      const names = (await context(lonely)).branches[0]!.services.map((s) => s.name);
      expect(names).toEqual(["Yerel Hizmet"]);
      const people = await asDatabaseRole("anon", null, (sql) => sql<{ r: unknown[] }[]>`select public.get_public_eligible_staff(${lonely.t.slug}, ${lonely.branch}, ${foreignSvc}) as r`);
      expect(people[0]!.r).toEqual([]);
    } finally {
      await testDb`delete from staff_services where service_id = ${foreignSvc}`;
      await testDb`delete from service_branches where service_id = ${foreignSvc} and branch_id = ${lonely.branch}`;
    }
  });
});

describe("INQUIRY / not-bookable services never enter slot booking", () => {
  it("no eligible staff and no slots for any inquiry-booked service; a direct service has both", async () => {
    const day = safeMorningStart(5).toISOString().slice(0, 10);
    for (const name of ["Stüdyo Dışı Makyaj", "Gelin / Nişan / Kına Makyajı", "Nedime Makyajı", "Gece / Günlük Makyaj", "Kaş Laminasyonu + Kaş Alımı"]) {
      expect(await eligible(emel, name), name).toEqual([]);
      expect(await slots(emel, name, day), name).toEqual([]);
    }
    expect((await eligible(emel, "Kaş Laminasyonu")).map((s) => s.fullName)).toEqual(["Emel Kaynakkan"]);
    expect((await slots(emel, "Kaş Laminasyonu", day)).length).toBeGreaterThan(0);
  });

  it("no appointment item can be created for an inquiry-booked service by ANY path (internal RPC, direct insert, guest booking function)", async () => {
    const inquiryId = emel.svc["Stüdyo Dışı Makyaj"]!;
    const [customer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${emel.t.id}, 'Sentetik Musteri') returning id`;
    const start = safeMorningStart(9).toISOString();
    const rpc = await attemptAs(owner.id, (sql) => sql`select public.create_appointment(${emel.t.id}, ${emel.branch}, ${customer!.id}, ${sql.json([{ service_id: inquiryId, staff_member_id: emel.staff["Emel Kaynakkan"], scheduled_start_at: start, sequence: 1 }] as never)}, null)`);
    expect(rpc).toMatchObject({ ok: false, code: "BK003" });
    const [real] = await testDb<{ id: string }[]>`select id from appointments where tenant_id = ${emel.t.id} limit 1`;
    if (real) {
      await expect(testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
        select tenant_id, appointment_id, ${inquiryId}, staff_member_id, scheduled_start_at, scheduled_end_at, 30, 0, 99 from appointment_items where appointment_id = ${real.id} limit 1`).rejects.toMatchObject({ code: "BK003" });
    }
    await expect(
      testDb`select private.create_guest_booking(${emel.t.slug}, ${emel.branch}, ${inquiryId}, ${start}::timestamptz, 'Sentetik Misafir', '+905550000001', null, 'sentetik@example.com', ${crypto.randomUUID()}, null, null)`,
    ).rejects.toMatchObject({ code: "BK003" });
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from appointment_items where service_id = ${inquiryId}`;
    expect(n!.n).toBe("0");
  });

  it("a fixed-price service that is contact-only (duration not confirmed) is equally unbookable, internally and publicly", async () => {
    const id = emel.svc["Gece / Günlük Makyaj"]!;
    const [customer] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${emel.t.id}, 'Sentetik Musteri') returning id`;
    const start = safeMorningStart(10).toISOString();
    expect(await attemptAs(owner.id, (sql) => sql`select public.create_appointment(${emel.t.id}, ${emel.branch}, ${customer!.id}, ${sql.json([{ service_id: id, staff_member_id: emel.staff["Emel Kaynakkan"], scheduled_start_at: start, sequence: 1 }] as never)}, null)`)).toMatchObject({ ok: false, code: "BK003" });
    expect((await publicSvc(emel, "Gece / Günlük Makyaj")).price).toBe(5000);
  });

  it("the database refuses an inconsistent mode: inquiry pricing with direct booking, a backwards display range, blank or oversized copy", async () => {
    const id = emel.svc["Kaş Alımı"]!;
    const bad = [
      testDb`update services set pricing_mode = 'inquiry' where id = ${id}`,
      testDb`update services set display_duration_min = 40, display_duration_max = 30 where id = ${id}`,
      testDb`update services set display_duration_min = null, display_duration_max = 30 where id = ${id}`,
      testDb`update services set preparation_note = '   ' where id = ${id}`,
      testDb`update services set public_summary = ${"x".repeat(161)} where id = ${id}`,
      testDb`update services set badge_label = ${"x".repeat(41)} where id = ${id}`,
      testDb`update services set pricing_mode = 'free' where id = ${id}`,
    ];
    for (const q of bad) await expect(q).rejects.toMatchObject({ code: "23514" });
  });
});

describe("SINGLE-PERSON salon and the multi-staff flows (eligibility is tenant-scoped)", () => {
  it("one-person salon: exactly one eligible person, the owner linked once, assigned correctly on a real booking", async () => {
    const people = await eligible(emel, "Kaş Alımı");
    expect(people).toHaveLength(1);
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_members where tenant_id = ${emel.t.id} and deleted_at is null`;
    expect(n!.n).toBe("1");
    const id = await book(emel, "Kaş Alımı", "Emel Kaynakkan");
    const [item] = await testDb<{ staff_member_id: string; price: string }[]>`select staff_member_id, price::text from appointment_items where appointment_id = ${id}`;
    expect(item).toEqual({ staff_member_id: people[0]!.id, price: "600.00" });
  });

  it("two eligible staff: both are listed (the choice stays); a hair salon without any beauty field is unchanged", async () => {
    expect((await eligible(duo, "Cilt Bakimi")).map((s) => s.fullName).sort()).toEqual(["Ayse", "Banu"]);
    expect((await eligible(hair, "Sac Kesimi")).map((s) => s.fullName).sort()).toEqual(["Ahmet", "Burak"]);
    const id = await book(hair, "Boya", "Burak");
    const [item] = await testDb<{ price: string }[]>`select price::text from appointment_items where appointment_id = ${id}`;
    expect(item!.price).toBe("1500.00");
  });

  it("zero eligible staff: nothing to choose, no slots", async () => {
    const day = safeMorningStart(6).toISOString().slice(0, 10);
    await testDb`delete from staff_services where service_id = ${duo.svc["Cilt Bakimi"]!}`;
    try {
      expect(await eligible(duo, "Cilt Bakimi")).toEqual([]);
      expect(await slots(duo, "Cilt Bakimi", day)).toEqual([]);
    } finally {
      for (const sid of Object.values(duo.staff)) await linkStaffService(sid, duo.svc["Cilt Bakimi"]!);
    }
  });

  it("another salon's staff cannot make a service eligible, even if a corrupted link exists (tenant predicate)", async () => {
    const lonely = await salon("lonely", await user("lonely-owner"), [], [{ name: "Tek Hizmet", price: 100 }]);
    expect(await eligible(lonely, "Tek Hizmet")).toEqual([]);
    const foreign = other.staff["Baska Kisi"]!;
    await testDb.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into staff_branches (staff_member_id, branch_id) values (${foreign}, ${lonely.branch}) on conflict do nothing`;
      await tx`insert into staff_services (staff_member_id, service_id) values (${foreign}, ${lonely.svc["Tek Hizmet"]!}) on conflict do nothing`;
    });
    try {
      expect(await eligible(lonely, "Tek Hizmet")).toEqual([]);
    } finally {
      await testDb`delete from staff_services where staff_member_id = ${foreign} and service_id = ${lonely.svc["Tek Hizmet"]!}`;
      await testDb`delete from staff_branches where staff_member_id = ${foreign} and branch_id = ${lonely.branch}`;
    }
  });
});

describe("COMBINED service = its own service at its own price", () => {
  it("2,000 + 600 stay 2,000 and 600; the combined offer is 2,500 - never 2,600, no discount invented", async () => {
    const lam = await publicSvc(emel, "Kaş Laminasyonu");
    const alim = await publicSvc(emel, "Kaş Alımı");
    const combined = await publicSvc(emel, "Kaş Laminasyonu + Kaş Alımı");
    expect([lam.price, alim.price, combined.price]).toEqual([2000, 600, 2500]);
    expect(combined.price).not.toBe((lam.price ?? 0) + (alim.price ?? 0));
    // the real combined duration is not confirmed: no display range, not directly bookable until the owner decides
    expect(combined).toMatchObject({ displayDurationMin: null, displayDurationMax: null, bookingMode: "inquiry" });
  });

  it("once the owner confirms a duration the combined service books at 2,500 end to end (synthetic duration); checkout has no discount", async () => {
    await testDb`update services set booking_mode = 'direct', duration_minutes = ${SYNTHETIC_COMBINED_MINUTES} where id = ${emel.svc["Kaş Laminasyonu + Kaş Alımı"]!}`;
    const id = await book(emel, "Kaş Laminasyonu + Kaş Alımı", "Emel Kaynakkan");
    const [item] = await testDb<{ price: string; duration_minutes: number }[]>`select price::text, duration_minutes from appointment_items where appointment_id = ${id}`;
    expect(item).toEqual({ price: "2500.00", duration_minutes: SYNTHETIC_COMBINED_MINUTES });
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.complete_appointment(${id}, '[]'::jsonb)`);
    const [sale] = await asAuthenticatedUser(owner.id, (sql) => sql<{ id: string }[]>`select * from public.get_or_create_appointment_sale(${id})`);
    const [totals] = await testDb<{ subtotal: string; discount_amount: string; total_amount: string }[]>`select subtotal::text, discount_amount::text, total_amount::text from appointment_sales where id = ${sale!.id}`;
    expect(totals).toEqual({ subtotal: "2500.00", discount_amount: "0.00", total_amount: "2500.00" });
    // booking the two services separately is a different thing: two items, 2,600 in total
    const a = await book(emel, "Kaş Laminasyonu", "Emel Kaynakkan");
    const b = await book(emel, "Kaş Alımı", "Emel Kaynakkan");
    const [sum] = await testDb<{ s: string }[]>`select sum(price)::text as s from appointment_items where appointment_id in (${a}, ${b})`;
    expect(sum!.s).toBe("2600.00");
    await testDb`update services set booking_mode = 'inquiry' where id = ${emel.svc["Kaş Laminasyonu + Kaş Alımı"]!}`;
  });
});

describe("AUTHORIZATION: the new fields follow services.manage and nothing broader", () => {
  const edit = (userId: string, fx: Fx, name: string, summary: string) =>
    attemptAs(userId, (sql) => sql`update services set public_summary = ${summary} where id = ${fx.svc[name]!}`);
  const summaryOf = async (fx: Fx, name: string) => (await testDb<{ s: string | null }[]>`select public_summary as s from services where id = ${fx.svc[name]!}`)[0]!.s;

  it("Owner and Yönetici (services.manage) may write them; Resepsiyon and Personel (view only) change nothing", async () => {
    expect(await edit(owner.id, emel, "Nem Bakımı", "owner-yazdi")).toEqual({ ok: true });
    expect(await summaryOf(emel, "Nem Bakımı")).toBe("owner-yazdi");
    expect(await edit(manager.id, emel, "Nem Bakımı", "yonetici-yazdi")).toEqual({ ok: true });
    expect(await summaryOf(emel, "Nem Bakımı")).toBe("yonetici-yazdi");
    for (const u of [receptionist, stylist]) {
      await edit(u.id, emel, "Nem Bakımı", "yetkisiz");
      expect(await summaryOf(emel, "Nem Bakımı")).toBe("yonetici-yazdi");
    }
    await testDb`update services set public_summary = null where id = ${emel.svc["Nem Bakımı"]!}`;
  });

  it("another salon's Owner cannot write them; anon cannot write or read the table; the public RPC is read-only data", async () => {
    await edit(otherOwner.id, emel, "Nem Bakımı", "baska-salon");
    expect(await summaryOf(emel, "Nem Bakımı")).toBeNull();
    await expect(asDatabaseRole("anon", null, (sql) => sql`update public.services set public_summary = 'x' where id = ${emel.svc["Nem Bakımı"]!}`)).rejects.toMatchObject({ code: "42501" });
    await expect(asDatabaseRole("anon", null, (sql) => sql`select public_summary from public.services limit 1`)).rejects.toMatchObject({ code: "42501" });
  });

  it("the inquiry guard function is executable by no API role", async () => {
    const [r] = await testDb<{ a: boolean; b: boolean; c: boolean }[]>`select has_function_privilege('authenticated', 'private.guard_inquiry_service_item()', 'execute') as a, has_function_privilege('anon', 'private.guard_inquiry_service_item()', 'execute') as b, has_function_privilege('service_role', 'private.guard_inquiry_service_item()', 'execute') as c`;
    expect(r).toEqual({ a: false, b: false, c: false });
  });
});

describe("closeout: defaults, limits, eligibility boundaries, listing rules", () => {
  it("a service created the old way gets the old behaviour by default: fixed, direct, price hidden, no copy", async () => {
    const s = await createService(emel.t.id, "Varsayilan Hizmet", 20, 100);
    const [r] = await testDb`select pricing_mode, booking_mode, price_public, display_duration_min, display_duration_max, public_summary, public_details, preparation_note, aftercare_note, important_note, badge_label from services where id = ${s.id}`;
    expect(r).toEqual({ pricing_mode: "fixed", booking_mode: "direct", price_public: false, display_duration_min: null, display_duration_max: null, public_summary: null, public_details: null, preparation_note: null, aftercare_note: null, important_note: null, badge_label: null });
  });

  it("limits: details 1000 / important 200 / aftercare 300 are the maximum and blank is refused; unknown booking mode and a zero display minimum are refused", async () => {
    const id = emel.svc["Kaş Alımı"]!;
    await testDb`update services set public_details = ${"x".repeat(1000)}, important_note = ${"y".repeat(200)}, aftercare_note = ${"z".repeat(300)} where id = ${id}`;
    await testDb`update services set public_details = null, important_note = null, aftercare_note = null where id = ${id}`;
    const bad = [
      testDb`update services set public_details = ${"x".repeat(1001)} where id = ${id}`,
      testDb`update services set important_note = ${"y".repeat(201)} where id = ${id}`,
      testDb`update services set aftercare_note = ${"z".repeat(301)} where id = ${id}`,
      testDb`update services set aftercare_note = '  ' where id = ${id}`,
      testDb`update services set booking_mode = 'maybe' where id = ${id}`,
      testDb`update services set display_duration_min = 0 where id = ${id}`,
    ];
    for (const q of bad) await expect(q).rejects.toMatchObject({ code: "23514" });
  });

  it("public eligibility needs an active, undeleted service that is linked to the branch", async () => {
    const id = duo.svc["Cilt Bakimi"]!;
    expect((await eligible(duo, "Cilt Bakimi")).length).toBe(2);
    await testDb`update services set status = 'inactive' where id = ${id}`;
    expect(await eligible(duo, "Cilt Bakimi")).toEqual([]);
    await testDb`update services set status = 'active', deleted_at = now() where id = ${id}`;
    expect(await eligible(duo, "Cilt Bakimi")).toEqual([]);
    await testDb`update services set deleted_at = null where id = ${id}`;
    await testDb`delete from service_branches where service_id = ${id}`;
    expect(await eligible(duo, "Cilt Bakimi")).toEqual([]);
    await linkServiceBranch(id, duo.branch);
    expect((await eligible(duo, "Cilt Bakimi")).length).toBe(2);
  });

  it("the aftercare note is published when the salon wrote one", async () => {
    const id = emel.svc["Kaş Alımı"]!;
    await testDb`update services set aftercare_note = 'Sonrası notu' where id = ${id}`;
    try {
      expect((await publicSvc(emel, "Kaş Alımı")).aftercareNote).toBe("Sonrası notu");
    } finally {
      await testDb`update services set aftercare_note = null where id = ${id}`;
    }
  });

  it("an unbookable or deleted salon publishes nothing", async () => {
    await testDb`update tenant_features set enabled = false where tenant_id = ${duo.t.id}`;
    expect((await asDatabaseRole("anon", null, (sql) => sql<{ c: PublicCtx }[]>`select public.get_public_booking_context(${duo.t.slug}) as c`))[0]!.c).toEqual({ bookable: false });
    await testDb`update tenant_features set enabled = true where tenant_id = ${duo.t.id}`;
    await testDb`update tenants set deleted_at = now() where id = ${duo.t.id}`;
    try {
      expect((await asDatabaseRole("anon", null, (sql) => sql<{ c: PublicCtx }[]>`select public.get_public_booking_context(${duo.t.slug}) as c`))[0]!.c).toEqual({ bookable: false });
    } finally {
      await testDb`update tenants set deleted_at = null where id = ${duo.t.id}`;
    }
    expect((await context(duo)).bookable).toBe(true);
  });

  it("services are listed by display order, then by name", async () => {
    const names = async () => (await context(hair)).branches[0]!.services.map((s) => s.name);
    await testDb`update services set display_order = 0 where tenant_id = ${hair.t.id}`;
    expect(await names()).toEqual(["Boya", "Sac Kesimi"]);
    await testDb`update services set display_order = 1 where id = ${hair.svc["Boya"]!}`;
    expect(await names()).toEqual(["Sac Kesimi", "Boya"]);
    await testDb`update services set display_order = 0 where tenant_id = ${hair.t.id}`;
  });
});

describe("LAUNCH.1B compatibility and existing behaviour", () => {
  it("a future confirmation can read short name + preparation + important info from the appointment's service id", async () => {
    const id = await book(emel, "Kaş Laminasyonu", "Emel Kaynakkan");
    const [row] = await testDb<{ name: string; preparation_note: string | null; important_note: string | null }[]>`
      select s.name, s.preparation_note, s.important_note from appointment_items ai join services s on s.id = ai.service_id where ai.appointment_id = ${id}`;
    expect(row).toEqual({ name: "Kaş Laminasyonu", preparation_note: "Lütfen kaşlarınızı almadan geliniz.", important_note: "Yaklaşık 4–8 hafta kullanılabilir." });
  });

  it("a service with none of the beauty fields behaves exactly as before: fixed, direct, no price shown, bookable, copied price on the appointment", async () => {
    const s = await publicSvc(hair, "Boya");
    expect(s).toMatchObject({ pricingMode: "fixed", bookingMode: "direct", price: null, summary: null, details: null, preparationNote: null, aftercareNote: null, importantNote: null, badge: null, displayDurationMin: null });
    const [row] = await testDb<{ pricing_mode: string; booking_mode: string; price_public: boolean }[]>`
      select pricing_mode, booking_mode, price_public from services where tenant_id = ${hair.t.id} and name = 'Boya'`;
    expect(row).toEqual({ pricing_mode: "fixed", booking_mode: "direct", price_public: false });
  });
});
