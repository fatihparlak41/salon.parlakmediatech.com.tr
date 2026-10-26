import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAuthenticatedUser,
  asDatabaseRole,
  attemptAs,
  auditRows,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createScheduleException,
  createService,
  createStaffMember,
  createStaffSchedule,
  addMembership,
  createTestTenant,
  createTestUser,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  testDb,
  type TestUser,
} from "./helpers";

/**
 * Faz LAUNCH.1C — guided onboarding in the database: the single readiness read model and the bulk write RPCs.
 * New salons are created through the real create_tenant path (tenant + primary branch + Owner), exactly like the
 * product does; "existing" salons are built with the plain fixture helpers (never touching the wizard RPCs).
 */

type Status = {
  ready: boolean;
  blockers: string[];
  tenantSlug: string;
  profile: { name: string; timezone: string; currency: string; phone: string | null; missing: string[] };
  bookingEngineReady: boolean;
  bookingEngineBlockers: string[];
  counts: { services: number; staff: number; staffWithHours: number; bookablePaths: number };
  onlineBookingEnabled: boolean;
  hasAppointments: boolean;
  firstAvailableSlotAt: string | null;
  steps: { key: string; done: boolean }[];
};

const tenants: string[] = [];
const users: TestUser[] = [];
const stamp = Math.random().toString(36).slice(2, 8);

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`l1c-${label}`);
  users.push(user);
  return user;
}

/** A salon exactly as the product creates it (create_tenant): tenant, primary branch "Merkez Şube", Owner membership. */
async function freshSalon(label: string, owner: TestUser): Promise<{ id: string; slug: string; branchId: string }> {
  const slug = `l1c-${label}-${stamp}`;
  await asAuthenticatedUser(owner.id, (sql) => sql`select public.create_tenant(${`Deneme Salon ${label}`}, ${slug})`);
  const [tenant] = await testDb<{ id: string }[]>`select id from tenants where slug = ${slug}`;
  tenants.push(tenant!.id);
  const [branch] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${tenant!.id} and is_primary`;
  return { id: tenant!.id, slug, branchId: branch!.id };
}

async function status(tenantId: string, userId: string): Promise<Status> {
  const [row] = await asAuthenticatedUser(userId, (sql) => sql<{ s: Status }[]>`select public.get_onboarding_status(${tenantId}) as s`);
  return row!.s;
}

const rpc = {
  profile: (userId: string, t: string, name = "Güzellik Atölyesi", tz = "Europe/Istanbul", cur = "TRY", phone = "0542 123 45 67", addr = "Girne Cad. 1") =>
    asAuthenticatedUser(userId, (sql) => sql<{ s: Status }[]>`select public.update_salon_profile(${t}, ${name}, ${tz}, ${cur}, ${phone}, ${addr}) as s`),
  services: (userId: string, t: string, items: unknown) =>
    asAuthenticatedUser(userId, (sql) => sql<{ r: { created: number; skipped: number; status: Status } }[]>`select public.onboarding_add_services(${t}, ${testDb.json(items as never)}) as r`),
  staff: (userId: string, t: string, items: unknown) =>
    asAuthenticatedUser(userId, (sql) => sql<{ r: { created: number; skipped: number; status: Status } }[]>`select public.onboarding_add_staff(${t}, ${testDb.json(items as never)}) as r`),
  hours: (userId: string, t: string, staffIds: string[], days: unknown) =>
    asAuthenticatedUser(userId, (sql) => sql<{ s: Status }[]>`select public.onboarding_apply_weekly_hours(${t}, ${staffIds}::uuid[], ${testDb.json(days as never)}) as s`),
  mapping: (userId: string, t: string, assignments: unknown) =>
    asAuthenticatedUser(userId, (sql) => sql<{ s: Status }[]>`select public.onboarding_set_staff_services(${t}, ${testDb.json(assignments as never)}) as s`),
  booking: (userId: string, t: string, enabled: boolean) =>
    asAuthenticatedUser(userId, (sql) => sql`select public.set_online_booking_enabled(${t}, ${enabled})`),
};

/** create_tenant already clones every default role into the new salon; a teammate joins the one with that key. */
async function joinAs(tenantId: string, user: TestUser, roleKey: string): Promise<void> {
  const [role] = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${tenantId} and key = ${roleKey}`;
  if (!role) throw new Error(`role ${roleKey} missing in the new salon`);
  await addMembership(tenantId, user.id, role.id);
}

const WEEK = [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({ weekday, start: "09:00", end: "18:00" }));

const TEN_SERVICES = [
  { name: "Saç Kesimi", category: "Saç", durationMinutes: 45, price: "800.00" },
  { name: "Fön", category: "Saç", durationMinutes: 30, price: "400" },
  { name: "Boya", category: "Saç", durationMinutes: 120, price: "2500.50" },
  { name: "Manikür", category: "Tırnak", durationMinutes: 45, price: "600" },
  { name: "Pedikür", category: "Tırnak", durationMinutes: 60, price: "700" },
  { name: "Kalıcı Oje", category: "Tırnak", durationMinutes: 60, price: "900" },
  { name: "Cilt Bakımı", category: "Bakım", durationMinutes: 60, price: "1200" },
  { name: "Kaş Alımı", category: "Bakım", durationMinutes: 15, price: "250" },
  { name: "Ağda", category: "Bakım", durationMinutes: 30, price: "500" },
  { name: "Makyaj", category: null, durationMinutes: 60, price: "1500" },
];

let owner: TestUser;
let otherOwner: TestUser;
let manager: TestUser;
let receptionist: TestUser;
let stylist: TestUser;
let salon: { id: string; slug: string; branchId: string };
let other: { id: string; slug: string; branchId: string };

beforeAll(async () => {
  owner = await newUser("owner");
  otherOwner = await newUser("other-owner");
  manager = await newUser("manager");
  receptionist = await newUser("reception");
  stylist = await newUser("stylist");
  salon = await freshSalon("a", owner);
  other = await freshSalon("b", otherOwner);
  await joinAs(salon.id, manager, "SALON_MANAGER");
  await joinAs(salon.id, receptionist, "RECEPTIONIST");
  await joinAs(salon.id, stylist, "STYLIST");
}, 120_000);

afterAll(async () => {
  await cleanupTenants(tenants);
  await cleanupUsers(users.map((u) => u.id));
}, 120_000);

describe("NEW OWNER — an empty tenant is incomplete, and each step is derived from real data", () => {
  it("a freshly created salon: not ready, every blocker named, nothing stored anywhere", async () => {
    const s = await status(salon.id, owner.id);
    expect(s.ready).toBe(false);
    expect(s.blockers).toEqual([
      "salon_profile_missing",
      "no_working_hours",
      "no_services",
      "no_staff",
      "no_bookable_staff",
      "public_booking_disabled",
    ]);
    expect(s.profile.missing).toEqual(["phone"]);
    expect(s.counts).toEqual({ services: 0, staff: 0, staffWithHours: 0, bookablePaths: 0 });
    expect(s.onlineBookingEnabled).toBe(false);
    expect(s.hasAppointments).toBe(false);
    expect(s.firstAvailableSlotAt).toBeNull();
    expect(s.steps.map((x) => x.key)).toEqual(["profile", "services", "staff", "hours", "mapping", "booking", "ready"]);
    expect(s.steps.every((x) => !x.done)).toBe(true);
  });

  it("reading the status writes nothing (no audit row, no data) — and repeating it gives the same answer", async () => {
    const before = await testDb<{ n: string }[]>`select count(*)::text as n from audit_logs where tenant_id = ${salon.id}`;
    const a = await status(salon.id, owner.id);
    const b = await status(salon.id, owner.id);
    expect(b).toEqual(a);
    const after = await testDb<{ n: string }[]>`select count(*)::text as n from audit_logs where tenant_id = ${salon.id}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("the whole journey, one step at a time: each RPC flips only its own step, and readiness appears only when a real slot exists", async () => {
    // 1 profile
    const afterProfile = (await rpc.profile(owner.id, salon.id))[0]!.s;
    expect(afterProfile.steps.find((x) => x.key === "profile")!.done).toBe(true);
    expect(afterProfile.ready).toBe(false);
    expect(afterProfile.profile).toMatchObject({ name: "Güzellik Atölyesi", timezone: "Europe/Istanbul", currency: "TRY", phone: "05421234567" });

    // 2 services (10 in 3 categories + one without)
    const svc = (await rpc.services(owner.id, salon.id, TEN_SERVICES))[0]!.r;
    expect(svc).toMatchObject({ created: 10, skipped: 0 });
    expect(svc.status.counts.services).toBe(10);
    expect(svc.status.steps.find((x) => x.key === "services")!.done).toBe(true);
    expect(svc.status.steps.find((x) => x.key === "mapping")!.done).toBe(false);

    // 3 staff (roster only)
    const stf = (await rpc.staff(owner.id, salon.id, [{ fullName: "Ayşe Demir" }, { fullName: "Mehmet Kaya", phone: "0533 111 22 33" }, { fullName: "Elif Şahin" }]))[0]!.r;
    expect(stf).toMatchObject({ created: 3, skipped: 0 });
    expect(stf.status.counts.staff).toBe(3);
    expect(stf.status.ready).toBe(false);

    const staffIds = (await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${salon.id} order by display_order`).map((r) => r.id);
    const serviceIds = (await testDb<{ id: string }[]>`select id from services where tenant_id = ${salon.id} order by display_order`).map((r) => r.id);

    // 4 mapping: everyone does everything
    const mapped = (await rpc.mapping(owner.id, salon.id, staffIds.map((staffId) => ({ staffId, serviceIds }))))[0]!.s;
    expect(mapped.counts.bookablePaths).toBe(30);
    expect(mapped.ready).toBe(false);
    expect(mapped.blockers).toContain("no_working_hours");

    // 5 hours
    const hours = (await rpc.hours(owner.id, salon.id, staffIds, WEEK))[0]!.s;
    expect(hours.counts.staffWithHours).toBe(3);
    expect(hours.ready).toBe(false);
    expect(hours.blockers).toEqual(["public_booking_disabled"]);
    expect(hours.firstAvailableSlotAt).not.toBeNull(); // a slot exists, only the public switch is off

    // 6 booking switch (existing RPC)
    await rpc.booking(owner.id, salon.id, true);
    const done = await status(salon.id, owner.id);
    expect(done.blockers).toEqual([]);
    expect(done.ready).toBe(true);
    expect(done.steps.every((x) => x.done)).toBe(true);
    expect(new Date(done.firstAvailableSlotAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("resume: a brand-new session (another connection, same data) sees exactly the same state — nothing lives in a session", async () => {
    const a = await status(salon.id, owner.id);
    const b = await status(salon.id, owner.id);
    expect(a).toEqual(b);
    expect(a.ready).toBe(true);
  });

  it("the readiness 'ready' agrees with the real public slot picker for the very same instant", async () => {
    const s = await status(salon.id, owner.id);
    const slotAt = new Date(s.firstAvailableSlotAt!);
    const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Istanbul", dateStyle: "short", timeStyle: "short" }).format(slotAt); // "2026-10-25 09:00"
    const [date, time] = local.split(" ") as [string, string];
    const [svc] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${salon.id} and name = 'Kaş Alımı'`;
    const [row] = await asAuthenticatedUser(owner.id, (sql) =>
      sql<{ slots: string[] }[]>`select public.get_public_availability_slots(${salon.slug}, ${salon.branchId}, ${svc!.id}, ${date}::date) as slots`,
    );
    expect(row!.slots).toContain(time);
  });
});

describe("BOOKING READINESS — every missing piece produces its own blocker", () => {
  async function fullSalon(label: string) {
    const o = await newUser(`o-${label}`);
    const t = await freshSalon(label, o);
    await rpc.profile(o.id, t.id);
    await rpc.services(o.id, t.id, [{ name: "Tek Hizmet", category: "Saç", durationMinutes: 30, price: "100" }]);
    await rpc.staff(o.id, t.id, [{ fullName: "Tek Personel" }]);
    const [st] = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${t.id}`;
    const [sv] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${t.id}`;
    await rpc.mapping(o.id, t.id, [{ staffId: st!.id, serviceIds: [sv!.id] }]);
    await rpc.hours(o.id, t.id, [st!.id], WEEK);
    await rpc.booking(o.id, t.id, true);
    return { o, t, staffId: st!.id, serviceId: sv!.id };
  }

  it("a fully configured salon is ready", async () => {
    const f = await fullSalon("r1");
    expect((await status(f.t.id, f.o.id)).blockers).toEqual([]);
  });

  it("booking switched off → only public_booking_disabled", async () => {
    const f = await fullSalon("r2");
    await rpc.booking(f.o.id, f.t.id, false);
    expect((await status(f.t.id, f.o.id)).blockers).toEqual(["public_booking_disabled"]);
  });

  it("no service ↔ staff mapping → no_bookable_staff (and no slot probe is attempted)", async () => {
    const f = await fullSalon("r3");
    await rpc.mapping(f.o.id, f.t.id, [{ staffId: f.staffId, serviceIds: [] }]);
    const s = await status(f.t.id, f.o.id);
    expect(s.blockers).toEqual(["no_bookable_staff"]);
    expect(s.firstAvailableSlotAt).toBeNull();
  });

  it("the staff member works at no branch the service is offered at → no_bookable_staff", async () => {
    const f = await fullSalon("r4");
    const second = await createBranch(f.t.id, "Ikinci Sube");
    await testDb`delete from staff_branches where staff_member_id = ${f.staffId}`;
    await linkStaffBranch(f.staffId, second);
    expect((await status(f.t.id, f.o.id)).blockers).toContain("no_bookable_staff");
  });

  it("no working hours → no_working_hours", async () => {
    const f = await fullSalon("r5");
    await testDb`update staff_schedules set deleted_at = now() where staff_member_id = ${f.staffId}`;
    expect((await status(f.t.id, f.o.id)).blockers).toEqual(["no_working_hours"]);
  });

  it("the only service switched off → no_services and no bookable path", async () => {
    const f = await fullSalon("r6");
    await testDb`update services set status = 'inactive' where id = ${f.serviceId}`;
    const s = await status(f.t.id, f.o.id);
    expect(s.blockers).toEqual(["no_services", "no_bookable_staff"]);
  });

  it("a deleted service is not counted", async () => {
    const f = await fullSalon("r7");
    await testDb`update services set deleted_at = now() where id = ${f.serviceId}`;
    expect((await status(f.t.id, f.o.id)).counts.services).toBe(0);
  });

  it("the only staff member deactivated → no_staff and no bookable path", async () => {
    const f = await fullSalon("r8");
    await testDb`update staff_members set status = 'inactive' where id = ${f.staffId}`;
    const s = await status(f.t.id, f.o.id);
    expect(s.blockers).toEqual(["no_working_hours", "no_staff", "no_bookable_staff"]);
  });

  it("everything structural is fine but the service is longer than every working window → no_available_slot (rows exist, no real slot)", async () => {
    const f = await fullSalon("r9");
    await testDb`update services set duration_minutes = 600 where id = ${f.serviceId}`;
    const s = await status(f.t.id, f.o.id);
    expect(s.counts.bookablePaths).toBe(1);
    expect(s.blockers).toEqual(["no_available_slot"]);
    expect(s.ready).toBe(false);
  });

  it("every one of the next 14 days marked unavailable → no_available_slot", async () => {
    const f = await fullSalon("r10");
    const [{ today }] = await testDb<{ today: string }[]>`select (now() at time zone 'Europe/Istanbul')::date::text as today`;
    for (let i = 0; i <= 13; i++) {
      const [{ d }] = await testDb<{ d: string }[]>`select (${today}::date + ${i}::int)::text as d`;
      await createScheduleException(f.t.id, f.staffId, d, "unavailable");
    }
    expect((await status(f.t.id, f.o.id)).blockers).toEqual(["no_available_slot"]);
  });

  it("the slot probe respects existing appointments: a staff member who is booked solid on every probed day has no available slot", async () => {
    const f = await fullSalon("r11");
    await rpc.hours(f.o.id, f.t.id, [f.staffId], [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "10:00" })));
    await testDb`update services set duration_minutes = 60 where id = ${f.serviceId}`;
    expect((await status(f.t.id, f.o.id)).ready).toBe(true);
    const [cust] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${f.t.id}, 'Dolu Musteri') returning id`;
    const [{ today }] = await testDb<{ today: string }[]>`select (now() at time zone 'Europe/Istanbul')::date::text as today`;
    for (let i = 0; i <= 14; i++) {
      const [{ at }] = await testDb<{ at: string }[]>`select (((${today}::date + ${i}::int)::text || ' 09:00:00+03')::timestamptz)::text as at`;
      await attemptAs(f.o.id, (sql) =>
        sql`select public.create_appointment(${f.t.id}, ${f.t.branchId}, ${cust!.id}, ${testDb.json([{ service_id: f.serviceId, staff_member_id: f.staffId, scheduled_start_at: at, sequence: 1 }] as never)})`,
      );
    }
    const s = await status(f.t.id, f.o.id);
    expect(s.counts.bookablePaths).toBe(1);
    expect(s.blockers).toEqual(["no_available_slot"]);
    expect(s.hasAppointments).toBe(true);

    // another salon's appointments are not this salon's history ...
    expect((await status(salon.id, owner.id)).hasAppointments).toBe(false);

    // ... and a cancelled appointment frees its slot again
    await testDb`update appointments set status = 'cancelled' where tenant_id = ${f.t.id}`;
    const freed = await status(f.t.id, f.o.id);
    expect(freed.blockers).toEqual([]);
    expect(freed.ready).toBe(true);
    expect(freed.hasAppointments).toBe(true);
  });

  it("hours bound to a DIFFERENT branch give no slot at the branch the service is offered at (documents the branch rule of the shared predicate)", async () => {
    const f = await fullSalon("r17");
    const second = await createBranch(f.t.id, "Ikinci Sube");
    await testDb`update staff_schedules set branch_id = ${second} where staff_member_id = ${f.staffId} and deleted_at is null`;
    const s = await status(f.t.id, f.o.id);
    expect(s.counts.bookablePaths).toBe(1);
    expect(s.blockers).toEqual(["no_available_slot"]);
  });

  it("BOOKING ENGINE vs ONBOARDING: without a salon phone the engine still produces a slot; only the onboarding is incomplete", async () => {
    const f = await fullSalon("e1");
    await testDb`update branches set phone = null where tenant_id = ${f.t.id}`;
    const s = await status(f.t.id, f.o.id);
    expect(s.bookingEngineReady).toBe(true);
    expect(s.bookingEngineBlockers).toEqual([]);
    expect(s.firstAvailableSlotAt).not.toBeNull();
    expect(s.ready).toBe(false);
    expect(s.blockers).toEqual(["salon_profile_missing"]);
  });

  it("BOOKING ENGINE: the public switch is not part of it; a missing slot, hours or service is", async () => {
    const f = await fullSalon("e2");
    await rpc.booking(f.o.id, f.t.id, false);
    const off = await status(f.t.id, f.o.id);
    expect(off.bookingEngineReady).toBe(true);
    expect(off.blockers).toEqual(["public_booking_disabled"]);
    await testDb`update services set duration_minutes = 600 where id = ${f.serviceId}`;
    const noSlot = await status(f.t.id, f.o.id);
    expect(noSlot.bookingEngineReady).toBe(false);
    expect(noSlot.bookingEngineBlockers).toEqual(["no_available_slot"]);
    expect(noSlot.blockers).toEqual(["public_booking_disabled", "no_available_slot"]);
  });

  it("the probe offers the SAME 15-minute grid as the public picker: a block 09:10-09:25 holds no 15-minute slot, 09:10-09:50 first offers 09:15", async () => {
    const f = await fullSalon("e3");
    await testDb`update services set duration_minutes = 15 where id = ${f.serviceId}`;
    await testDb`update staff_schedules set start_time = '09:10', end_time = '09:25' where staff_member_id = ${f.staffId} and deleted_at is null`;
    const tight = await status(f.t.id, f.o.id);
    expect(tight.blockers).toEqual(["no_available_slot"]);
    await testDb`update staff_schedules set end_time = '09:50' where staff_member_id = ${f.staffId} and deleted_at is null`;
    const wide = await status(f.t.id, f.o.id);
    expect(wide.ready).toBe(true);
    const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Istanbul", dateStyle: "short", timeStyle: "short" }).format(new Date(wide.firstAvailableSlotAt!));
    const [date, time] = local.split(" ") as [string, string];
    expect(["09:15", "09:30"]).toContain(time); // 09:15 unless today's 09:15 has already passed
    const [row] = await asAuthenticatedUser(f.o.id, (sql) =>
      sql<{ slots: string[] }[]>`select public.get_public_availability_slots(${f.t.slug}, ${f.t.branchId}, ${f.serviceId}, ${date}::date) as slots`,
    );
    expect(row!.slots).toContain(time);
  });

  it("a slot that has already passed today is not a slot: hours that ended this morning and every later day blocked give no_available_slot", async () => {
    const f = await fullSalon("e5");
    const [{ minutes }] = await testDb<{ minutes: number }[]>`select (extract(epoch from (now() at time zone 'Europe/Istanbul')::time) / 60)::int as minutes`;
    if (minutes < 60) return; // within the first hour after midnight no "earlier today" window exists
    await rpc.hours(f.o.id, f.t.id, [f.staffId], [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:00", end: "00:30" })));
    await testDb`update services set duration_minutes = 15 where id = ${f.serviceId}`;
    const [{ today }] = await testDb<{ today: string }[]>`select (now() at time zone 'Europe/Istanbul')::date::text as today`;
    for (let i = 1; i <= 13; i++) {
      const [{ d }] = await testDb<{ d: string }[]>`select (${today}::date + ${i}::int)::text as d`;
      await createScheduleException(f.t.id, f.staffId, d, "unavailable");
    }
    const s = await status(f.t.id, f.o.id);
    expect(s.counts.bookablePaths).toBe(1);
    expect(s.blockers).toEqual(["no_available_slot"]);
    expect(s.bookingEngineReady).toBe(false);
  });

  it("a schedule row stamped with ANOTHER salon never makes this salon ready (and is not rewritten by an hours apply)", async () => {
    const f = await fullSalon("e4");
    await testDb`update staff_schedules set start_time = '09:00', end_time = '09:30' where staff_member_id = ${f.staffId} and deleted_at is null`;
    await testDb`update services set duration_minutes = 60 where id = ${f.serviceId}`;
    for (let weekday = 0; weekday <= 6; weekday++) {
      await testDb`insert into staff_schedules (tenant_id, staff_member_id, weekday, start_time, end_time) values (${salon.id}, ${f.staffId}, ${weekday}, '10:00', '18:00')`;
    }
    const s = await status(f.t.id, f.o.id);
    expect(s.counts.staffWithHours).toBe(1);
    expect(s.blockers).toEqual(["no_available_slot"]);

    await rpc.hours(f.o.id, f.t.id, [f.staffId], WEEK);
    const [foreign] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_schedules where tenant_id = ${salon.id} and staff_member_id = ${f.staffId} and deleted_at is null`;
    expect(foreign!.n).toBe("7");
  });

  it("a salon whose only branch was removed has no profile, no services and no bookable path", async () => {
    const f = await fullSalon("r14");
    await testDb`update branches set deleted_at = now() where tenant_id = ${f.t.id}`;
    const s = await status(f.t.id, f.o.id);
    expect(s.profile.missing).toContain("branch");
    expect(s.blockers).toEqual(expect.arrayContaining(["salon_profile_missing", "no_services", "no_bookable_staff"]));
    expect(s.counts.bookablePaths).toBe(0);
    expect(s.ready).toBe(false);
  });

  it("a deleted salon is inactive even though its status text still says active", async () => {
    const f = await fullSalon("r15");
    await testDb`update tenants set deleted_at = now() where id = ${f.t.id}`;
    const s = await status(f.t.id, f.o.id);
    expect(s.blockers).toContain("tenant_inactive");
    expect(s.ready).toBe(false);
  });

  it("a stored time zone the database does not know is a profile gap", async () => {
    const f = await fullSalon("r16");
    await testDb`update tenants set timezone = 'UTC+3' where id = ${f.t.id}`;
    const s = await status(f.t.id, f.o.id);
    expect(s.profile.missing).toEqual(["timezone"]);
    expect(s.blockers).toContain("salon_profile_missing");
  });

  it("services are counted per salon: another salon's service linked to this salon's branch (corrupt data) is not counted", async () => {
    const o = await newUser("iso1");
    const x = await freshSalon("iso1", o);
    const o2 = await newUser("iso2");
    const y = await freshSalon("iso2", o2);
    await rpc.services(o2.id, y.id, [{ name: "Baska Salon Hizmeti", durationMinutes: 30, price: "10" }]);
    const [foreignService] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${y.id}`;
    await testDb`insert into service_branches (service_id, branch_id) values (${foreignService!.id}, ${x.branchId})`;
    expect((await status(x.id, o.id)).counts.services).toBe(0);
    expect((await status(y.id, o2.id)).counts.services).toBe(1);
  });

  it("each step's 'done' follows its own data: people without any hours leave the hours step open", async () => {
    const o = await newUser("steps");
    const t = await freshSalon("steps", o);
    await rpc.staff(o.id, t.id, [{ fullName: "Sadece Kisi" }]);
    const s = await status(t.id, o.id);
    expect(s.steps.find((x) => x.key === "staff")!.done).toBe(true);
    expect(s.steps.find((x) => x.key === "hours")!.done).toBe(false);
    expect(s.steps.find((x) => x.key === "mapping")!.done).toBe(false);
  });

  it("a suspended salon is never ready (tenant_inactive)", async () => {
    const f = await fullSalon("r12");
    await testDb`update tenants set status = 'suspended' where id = ${f.t.id}`;
    const s = await status(f.t.id, f.o.id);
    expect(s.blockers).toContain("tenant_inactive");
    expect(s.ready).toBe(false);
  });

  it("an invalid stored timezone or an empty phone is a profile gap", async () => {
    const f = await fullSalon("r13");
    await testDb`update branches set phone = null where tenant_id = ${f.t.id}`;
    const s = await status(f.t.id, f.o.id);
    expect(s.blockers).toEqual(["salon_profile_missing"]);
    expect(s.profile.missing).toEqual(["phone"]);
  });
});

describe("SERVICES — fast multi-add keeps what was typed", () => {
  it("duration, price, category and branch availability are preserved exactly (including a service without a category)", async () => {
    const o = await newUser("svc");
    const t = await freshSalon("svc", o);
    await rpc.services(o.id, t.id, TEN_SERVICES);
    const rows = await testDb<{ name: string; category: string | null; duration_minutes: number; price: string; status: string; branches: string }[]>`
      select s.name, s.category, s.duration_minutes, s.price::text, s.status,
             (select count(*)::text from service_branches sb where sb.service_id = s.id and sb.branch_id = ${t.branchId}) as branches
      from services s where s.tenant_id = ${t.id} order by s.display_order`;
    expect(rows).toHaveLength(10);
    expect(rows[2]).toMatchObject({ name: "Boya", category: "Saç", duration_minutes: 120, price: "2500.50", status: "active", branches: "1" });
    expect(rows[1]).toMatchObject({ name: "Fön", price: "400.00" });
    expect(rows[9]).toMatchObject({ name: "Makyaj", category: null });
    expect(new Set(rows.map((r) => r.category)).size).toBe(4); // Saç, Tırnak, Bakım, null
    expect((await auditRows(t.id, "onboarding.services_added"))).toHaveLength(1);
  });

  it("the same request twice changes nothing (idempotent retry); duplicates inside one request collapse", async () => {
    const o = await newUser("svc2");
    const t = await freshSalon("svc2", o);
    const first = (await rpc.services(o.id, t.id, [...TEN_SERVICES.slice(0, 3), { name: "saç kesimi", category: "Saç", durationMinutes: 10, price: "1" }]))[0]!.r;
    expect(first).toMatchObject({ created: 3, skipped: 1 });
    const again = (await rpc.services(o.id, t.id, TEN_SERVICES.slice(0, 3)))[0]!.r;
    expect(again).toMatchObject({ created: 0, skipped: 3 });
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from services where tenant_id = ${t.id}`;
    expect(n!.n).toBe("3");
    expect(await auditRows(t.id, "onboarding.services_added")).toHaveLength(1); // the all-skipped retry writes no audit row
  });

  it("invalid input is refused atomically — one bad row means NO row is created", async () => {
    const o = await newUser("svc3");
    const t = await freshSalon("svc3", o);
    for (const bad of [
      { name: "", durationMinutes: 30, price: "10" },
      { name: "X", durationMinutes: 0, price: "10" },
      { name: "X", durationMinutes: 4, price: "10" },
      { name: "X", durationMinutes: 30, price: "-5" },
      { name: "X", durationMinutes: 30, price: "10,5" },
      { name: "X", durationMinutes: 30, price: "1e3" },
      { name: "X", durationMinutes: "30; drop", price: "10" },
    ]) {
      const out = await attemptAs(o.id, (sql) => sql`select public.onboarding_add_services(${t.id}, ${testDb.json([TEN_SERVICES[0], bad] as never)})`);
      expect(out, JSON.stringify(bad)).toMatchObject({ ok: false, code: "OB012" });
    }
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from services where tenant_id = ${t.id}`;
    expect(n!.n).toBe("0");
    expect(await attemptAs(o.id, (sql) => sql`select public.onboarding_add_services(${t.id}, ${testDb.json([] as never)})`)).toMatchObject({ ok: false, code: "OB012" });
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ name: `S${i}`, durationMinutes: 30, price: "1" }));
    expect(await attemptAs(o.id, (sql) => sql`select public.onboarding_add_services(${t.id}, ${testDb.json(tooMany as never)})`)).toMatchObject({ ok: false, code: "OB012" });
  });

  it("no hair-specific wording is required: a beauty-bar catalogue works identically", async () => {
    const o = await newUser("svc4");
    const t = await freshSalon("svc4", o);
    const r = (await rpc.services(o.id, t.id, [
      { name: "Lazer Epilasyon", category: "Lazer", durationMinutes: 40, price: "1800" },
      { name: "Kirpik Lifting", category: "Kirpik", durationMinutes: 75, price: "950" },
    ]))[0]!.r;
    expect(r.created).toBe(2);
  });
});

describe("STAFF — roster without any login", () => {
  it("roster records have no membership, no e-mail, are linked to the branch and are idempotent", async () => {
    const o = await newUser("stf");
    const t = await freshSalon("stf", o);
    const r = (await rpc.staff(o.id, t.id, [{ fullName: "Ayse" }, { fullName: "Mehmet", phone: "0533 111 22 33" }]))[0]!.r;
    expect(r).toMatchObject({ created: 2, skipped: 0 });
    const rows = await testDb<{ full_name: string; tenant_membership_id: string | null; email: string | null; phone: string | null; linked: string }[]>`
      select sm.full_name, sm.tenant_membership_id, sm.email, sm.phone,
             (select count(*)::text from staff_branches sb where sb.staff_member_id = sm.id and sb.branch_id = ${t.branchId}) as linked
      from staff_members sm where sm.tenant_id = ${t.id} order by sm.display_order`;
    expect(rows).toEqual([
      { full_name: "Ayse", tenant_membership_id: null, email: null, phone: null, linked: "1" },
      { full_name: "Mehmet", tenant_membership_id: null, email: null, phone: "05331112233", linked: "1" },
    ]);
    const again = (await rpc.staff(o.id, t.id, [{ fullName: "AYSE" }, { fullName: "Yeni Kişi" }]))[0]!.r;
    expect(again).toMatchObject({ created: 1, skipped: 1 });
    const [invites] = await testDb<{ n: string }[]>`select count(*)::text as n from team_invitations where tenant_id = ${t.id}`;
    expect(invites!.n).toBe("0");
  });

  it("refuses bad input atomically", async () => {
    const o = await newUser("stf2");
    const t = await freshSalon("stf2", o);
    expect(await attemptAs(o.id, (sql) => sql`select public.onboarding_add_staff(${t.id}, ${testDb.json([{ fullName: "Iyi" }, { fullName: "  " }] as never)})`)).toMatchObject({ ok: false, code: "OB012" });
    expect(await attemptAs(o.id, (sql) => sql`select public.onboarding_add_staff(${t.id}, ${testDb.json([{ fullName: "Iyi", phone: "12" }] as never)})`)).toMatchObject({ ok: false, code: "OB012" });
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_members where tenant_id = ${t.id}`;
    expect(n!.n).toBe("0");
  });
});

describe("WEEKLY HOURS — one template, many people", () => {
  async function trio(label: string) {
    const o = await newUser(label);
    const t = await freshSalon(label, o);
    await rpc.staff(o.id, t.id, [{ fullName: "A" }, { fullName: "B" }, { fullName: "C" }]);
    const ids = (await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${t.id} order by display_order`).map((r) => r.id);
    return { o, t, ids };
  }

  it("applies the template to every listed person; a day that is absent is closed; a break is two rows", async () => {
    const { o, t, ids } = await trio("h1");
    const days = [
      { weekday: 1, start: "09:00", end: "13:00" },
      { weekday: 1, start: "14:00", end: "18:00" },
      { weekday: 2, start: "10:00", end: "17:00" },
    ];
    await rpc.hours(o.id, t.id, ids, days);
    const rows = await testDb<{ staff_member_id: string; weekday: number; start_time: string; end_time: string; branch_id: string | null }[]>`
      select staff_member_id, weekday, start_time::text, end_time::text, branch_id from staff_schedules
      where tenant_id = ${t.id} and deleted_at is null order by staff_member_id, weekday, start_time`;
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.staff_member_id === ids[0])).toEqual([
      { staff_member_id: ids[0], weekday: 1, start_time: "09:00:00", end_time: "13:00:00", branch_id: null },
      { staff_member_id: ids[0], weekday: 1, start_time: "14:00:00", end_time: "18:00:00", branch_id: null },
      { staff_member_id: ids[0], weekday: 2, start_time: "10:00:00", end_time: "17:00:00", branch_id: null },
    ]);
    expect(rows.some((r) => r.weekday === 0 || r.weekday >= 3)).toBe(false);
    // the break is really a break: 13:00-14:00 is not bookable
    const [free] = await testDb<{ ok: boolean }[]>`
      select private.staff_is_available(${t.id}, ${t.branchId}, ${ids[0]}, '2026-11-02 11:00:00+03'::timestamptz, '2026-11-02 11:30:00+03'::timestamptz) as ok`;
    const [brk] = await testDb<{ ok: boolean }[]>`
      select private.staff_is_available(${t.id}, ${t.branchId}, ${ids[0]}, '2026-11-02 13:15:00+03'::timestamptz, '2026-11-02 13:45:00+03'::timestamptz) as ok`;
    expect(free!.ok).toBe(true);
    expect(brk!.ok).toBe(false);
  });

  it("re-applying replaces only the listed people's hours (soft delete, like the per-person editor); others are untouched", async () => {
    const { o, t, ids } = await trio("h2");
    await rpc.hours(o.id, t.id, ids, WEEK);
    await rpc.hours(o.id, t.id, [ids[0]!], [{ weekday: 3, start: "10:00", end: "12:00" }]);
    const live = await testDb<{ staff_member_id: string; n: string }[]>`
      select staff_member_id, count(*)::text as n from staff_schedules where tenant_id = ${t.id} and deleted_at is null group by 1`;
    const byStaff = Object.fromEntries(live.map((r) => [r.staff_member_id, r.n]));
    expect(byStaff[ids[0]!]).toBe("1");
    expect(byStaff[ids[1]!]).toBe("7");
    expect(byStaff[ids[2]!]).toBe("7");
  });

  it("refuses overlap, reversed times, bad weekday, bad time text — atomically", async () => {
    const { o, t, ids } = await trio("h3");
    await rpc.hours(o.id, t.id, ids, WEEK);
    for (const bad of [
      [{ weekday: 1, start: "09:00", end: "12:00" }, { weekday: 1, start: "11:00", end: "15:00" }],
      [{ weekday: 1, start: "12:00", end: "09:00" }],
      [{ weekday: 1, start: "09:00", end: "09:00" }],
      [{ weekday: 7, start: "09:00", end: "10:00" }],
      [{ weekday: 1, start: "nine", end: "10:00" }],
      [{ weekday: "x", start: "09:00", end: "10:00" }],
    ]) {
      const out = await attemptAs(o.id, (sql) => sql`select public.onboarding_apply_weekly_hours(${t.id}, ${ids}::uuid[], ${testDb.json(bad as never)})`);
      expect(out, JSON.stringify(bad)).toMatchObject({ ok: false, code: "OB012" });
    }
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_schedules where tenant_id = ${t.id} and deleted_at is null`;
    expect(n!.n).toBe("21"); // the earlier good hours survived every refused attempt
  });

  it("an empty template closes the week; a staff list containing someone from ANOTHER salon is refused and changes nothing", async () => {
    const { o, t, ids } = await trio("h4");
    const o2 = await newUser("h4b");
    const t2 = await freshSalon("h4b", o2);
    await rpc.staff(o2.id, t2.id, [{ fullName: "Yabanci" }]);
    const [foreign] = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${t2.id}`;
    await rpc.hours(o2.id, t2.id, [foreign!.id], WEEK);
    expect(await attemptAs(o.id, (sql) => sql`select public.onboarding_apply_weekly_hours(${t.id}, ${[ids[0], foreign!.id]}::uuid[], ${testDb.json(WEEK as never)})`)).toMatchObject({ ok: false, code: "OB012" });
    const [fn] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_schedules where staff_member_id = ${foreign!.id} and deleted_at is null`;
    expect(fn!.n).toBe("7");
    await rpc.hours(o.id, t.id, ids, []);
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from staff_schedules where tenant_id = ${t.id} and deleted_at is null`;
    expect(n!.n).toBe("0");
  });
});

describe("STAFF ↔ SERVICE MATRIX", () => {
  it("sets exactly the listed services per person; an empty list clears; foreign ids are refused", async () => {
    const o = await newUser("m1");
    const t = await freshSalon("m1", o);
    await rpc.services(o.id, t.id, TEN_SERVICES.slice(0, 4));
    await rpc.staff(o.id, t.id, [{ fullName: "A" }, { fullName: "B" }]);
    const ids = (await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${t.id} order by display_order`).map((r) => r.id);
    const svc = (await testDb<{ id: string }[]>`select id from services where tenant_id = ${t.id} order by display_order`).map((r) => r.id);
    await rpc.mapping(o.id, t.id, [{ staffId: ids[0], serviceIds: [svc[0], svc[1]] }, { staffId: ids[1], serviceIds: svc }]);
    const count = async (id: string) => (await testDb<{ n: string }[]>`select count(*)::text as n from staff_services where staff_member_id = ${id}`)[0]!.n;
    expect([await count(ids[0]!), await count(ids[1]!)]).toEqual(["2", "4"]);
    await rpc.mapping(o.id, t.id, [{ staffId: ids[0], serviceIds: [svc[3]] }]);
    expect([await count(ids[0]!), await count(ids[1]!)]).toEqual(["1", "4"]); // B untouched
    await rpc.mapping(o.id, t.id, [{ staffId: ids[0], serviceIds: [] }]);
    expect(await count(ids[0]!)).toBe("0");

    const o2 = await newUser("m1b");
    const t2 = await freshSalon("m1b", o2);
    await rpc.services(o2.id, t2.id, [TEN_SERVICES[0]]);
    const [foreignSvc] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${t2.id}`;
    expect(await attemptAs(o.id, (sql) => sql`select public.onboarding_set_staff_services(${t.id}, ${testDb.json([{ staffId: ids[0], serviceIds: [foreignSvc!.id] }] as never)})`)).toMatchObject({ ok: false, code: "OB012" });
    expect(await attemptAs(o.id, (sql) => sql`select public.onboarding_set_staff_services(${t.id}, ${testDb.json([{ staffId: "00000000-0000-4000-8000-000000000000", serviceIds: [] }] as never)})`)).toMatchObject({ ok: false, code: "OB012" });
    expect(await attemptAs(o.id, (sql) => sql`select public.onboarding_set_staff_services(${t.id}, ${testDb.json([{ staffId: "not-a-uuid", serviceIds: [] }] as never)})`)).toMatchObject({ ok: false, code: "OB012" });
    expect(await count(ids[1]!)).toBe("4"); // a refused request never half-applies
  });

  it("another salon's staff cannot be given this salon's services (and vice-versa)", async () => {
    const o2 = await newUser("m2");
    const t2 = await freshSalon("m2", o2);
    await rpc.staff(o2.id, t2.id, [{ fullName: "Yabanci Personel" }]);
    const [foreignStaff] = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${t2.id}`;
    const [mine] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${salon.id} limit 1`;
    expect(await attemptAs(owner.id, (sql) => sql`select public.onboarding_set_staff_services(${salon.id}, ${testDb.json([{ staffId: foreignStaff!.id, serviceIds: [mine!.id] }] as never)})`)).toMatchObject({ ok: false, code: "OB012" });
  });
});

describe("EXISTING TENANT — a salon configured the old way is untouched and never forced", () => {
  it("a fully hand-configured salon is ready with no onboarding having happened, and reading its status changes nothing", async () => {
    const o = await newUser("ex");
    await createTestTenant(`l1c-ex-${stamp}`, o.id).then(async (t) => {
      tenants.push(t.id);
      const branchId = await createBranch(t.id, "Merkez Şube");
      await testDb`update branches set is_primary = true, phone = '05320000000' where id = ${branchId}`;
      const svc = await createService(t.id, "Eski Hizmet", 45, 500);
      await linkServiceBranch(svc.id, branchId);
      const st = await createStaffMember(t.id, "Eski Personel");
      await linkStaffBranch(st.id, branchId);
      await linkStaffService(st.id, svc.id);
      for (const d of [1, 2, 3, 4, 5]) await createStaffSchedule(t.id, st.id, d, "09:00", "17:00");
      await testDb`insert into tenant_features (tenant_id, feature_id, enabled) select ${t.id}, f.id, true from features f where f.key = 'online_booking'`;

      const snapshot = async () => ({
        services: await testDb`select * from services where tenant_id = ${t.id} order by id`,
        staff: await testDb`select * from staff_members where tenant_id = ${t.id} order by id`,
        schedules: await testDb`select * from staff_schedules where tenant_id = ${t.id} order by id`,
        tenant: await testDb`select name, slug, timezone, currency, status from tenants where id = ${t.id}`,
        audit: await testDb`select count(*)::int as n from audit_logs where tenant_id = ${t.id}`,
      });
      const before = await snapshot();
      const s = await status(t.id, o.id);
      expect(s.ready).toBe(true);
      expect(s.blockers).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });
  });

  it("bulk-adding to a configured salon leaves every pre-existing row byte-identical", async () => {
    const o = await newUser("ex2");
    const t = await createTestTenant(`l1c-ex2-${stamp}`, o.id);
    tenants.push(t.id);
    const branchId = await createBranch(t.id, "Merkez Şube");
    await testDb`update branches set is_primary = true, phone = '05320000000' where id = ${branchId}`;
    const svc = await createService(t.id, "Eski Hizmet", 45, 500);
    await linkServiceBranch(svc.id, branchId);
    const st = await createStaffMember(t.id, "Eski Personel");
    await linkStaffBranch(st.id, branchId);
    await linkStaffService(st.id, svc.id);
    await createStaffSchedule(t.id, st.id, 1, "09:00", "17:00");

    const before = {
      services: await testDb`select * from services where id = ${svc.id}`,
      staff: await testDb`select * from staff_members where id = ${st.id}`,
      schedules: await testDb`select * from staff_schedules where staff_member_id = ${st.id}`,
      mapping: await testDb`select * from staff_services where staff_member_id = ${st.id}`,
    };
    await rpc.services(o.id, t.id, [{ name: "Yeni Hizmet", category: "Yeni", durationMinutes: 20, price: "99" }]);
    await rpc.staff(o.id, t.id, [{ fullName: "Yeni Personel" }]);
    const [newStaff] = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${t.id} and full_name = 'Yeni Personel'`;
    await rpc.hours(o.id, t.id, [newStaff!.id], WEEK);
    expect({
      services: await testDb`select * from services where id = ${svc.id}`,
      staff: await testDb`select * from staff_members where id = ${st.id}`,
      schedules: await testDb`select * from staff_schedules where staff_member_id = ${st.id}`,
      mapping: await testDb`select * from staff_services where staff_member_id = ${st.id}`,
    }).toEqual(before);
  });
});

describe("PROFILE — explicit timezone and currency, KKTC-sensible, validated", () => {
  it("updates the tenant and the primary branch, audits before/after, and accepts non-Istanbul zones (Nicosia)", async () => {
    const o = await newUser("p1");
    const t = await freshSalon("p1", o);
    const s = (await rpc.profile(o.id, t.id, "  Kıbrıs Güzellik  ", "Asia/Nicosia", "eur", "+90 542 123 45 67", " Girne "))[0]!.s;
    expect(s.profile).toMatchObject({ name: "Kıbrıs Güzellik", timezone: "Asia/Nicosia", currency: "EUR", phone: "+905421234567" });
    const [b] = await testDb<{ phone: string; address: string }[]>`select phone, address from branches where id = ${t.branchId}`;
    expect(b).toEqual({ phone: "+905421234567", address: "Girne" });
    const audit = await auditRows(t.id, "onboarding.profile_updated");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before).toMatchObject({ timezone: "Europe/Istanbul", currency: "TRY" });
    expect(audit[0]!.after).toMatchObject({ timezone: "Asia/Nicosia", currency: "EUR" });
  });

  it("rejects an unknown timezone, an unsupported currency, an empty name, a junk phone", async () => {
    const o = await newUser("p2");
    const t = await freshSalon("p2", o);
    for (const args of [
      ["Salon", "Mars/Olympus", "TRY", "05320000000"],
      ["Salon", "Europe/Istanbul", "XXX", "05320000000"],
      ["  ", "Europe/Istanbul", "TRY", "05320000000"],
      ["Salon", "Europe/Istanbul", "TRY", "abc"],
      ["Salon", "Europe/Istanbul", "TRY", ""],
    ] as const) {
      const out = await attemptAs(o.id, (sql) => sql`select public.update_salon_profile(${t.id}, ${args[0]}, ${args[1]}, ${args[2]}, ${args[3]}, null)`);
      expect(out, JSON.stringify(args)).toMatchObject({ ok: false, code: "OB012" });
    }
    const [row] = await testDb<{ name: string; timezone: string }[]>`select name, timezone from tenants where id = ${t.id}`;
    expect(row).toEqual({ name: "Deneme Salon p2", timezone: "Europe/Istanbul" });
  });
});

describe("AUTHORIZATION — Owner yes, others per their real permissions, other salons never", () => {
  const writes = (userId: string, t: { id: string }) => ({
    profile: attemptAs(userId, (sql) => sql`select public.update_salon_profile(${t.id}, 'X', 'Europe/Istanbul', 'TRY', '05320000000', null)`),
    services: attemptAs(userId, (sql) => sql`select public.onboarding_add_services(${t.id}, ${testDb.json([{ name: `Z${Math.random()}`, durationMinutes: 30, price: "1" }] as never)})`),
    staff: attemptAs(userId, (sql) => sql`select public.onboarding_add_staff(${t.id}, ${testDb.json([{ fullName: `P${Math.random()}` }] as never)})`),
    hours: attemptAs(userId, (sql) => sql`select public.onboarding_apply_weekly_hours(${t.id}, array[]::uuid[], '[]'::jsonb)`),
    mapping: attemptAs(userId, (sql) => sql`select public.onboarding_set_staff_services(${t.id}, '[]'::jsonb)`),
    read: attemptAs(userId, (sql) => sql`select public.get_onboarding_status(${t.id})`),
  });

  it("Owner may read and write everything (validation errors, not permission errors, for the empty calls)", async () => {
    const w = writes(owner.id, salon);
    expect(await w.profile).toEqual({ ok: true });
    expect(await w.services).toEqual({ ok: true });
    expect(await w.staff).toEqual({ ok: true });
    expect(await w.read).toEqual({ ok: true });
    expect(await w.hours).toMatchObject({ ok: false, code: "OB012" });
    expect(await w.mapping).toMatchObject({ ok: false, code: "OB012" });
  });

  it("Yönetici keeps services/staff/hours but NOT the salon profile (settings.manage is Owner-only)", async () => {
    const w = writes(manager.id, salon);
    expect(await w.profile).toMatchObject({ ok: false, code: "OB011" });
    expect(await w.services).toEqual({ ok: true });
    expect(await w.staff).toEqual({ ok: true });
    expect(await w.read).toEqual({ ok: true });
  });

  it("Resepsiyon and Personel are refused for every write and for the status", async () => {
    for (const u of [receptionist, stylist]) {
      const w = writes(u.id, salon);
      for (const k of ["profile", "services", "staff", "hours", "mapping", "read"] as const) {
        expect(await w[k], `${u.email} ${k}`).toMatchObject({ ok: false, code: "OB011" });
      }
    }
  });

  it("another salon's Owner is refused everywhere on this salon — and the refusal comes before any data is read", async () => {
    const w = writes(otherOwner.id, salon);
    for (const k of ["profile", "services", "staff", "hours", "mapping", "read"] as const) {
      expect(await w[k], k).toMatchObject({ ok: false, code: "OB011" });
    }
    const [n] = await testDb<{ n: string }[]>`select count(*)::text as n from services where tenant_id = ${other.id}`;
    expect(n!.n).toBe("0");
  });

  it("a signed-in user with no membership anywhere is refused; the status of a non-existent salon is refused too", async () => {
    const stranger = await newUser("stranger");
    expect(await attemptAs(stranger.id, (sql) => sql`select public.get_onboarding_status(${salon.id})`)).toMatchObject({ ok: false, code: "OB011" });
    expect(await attemptAs(owner.id, (sql) => sql`select public.get_onboarding_status('00000000-0000-4000-8000-000000000000')`)).toMatchObject({ ok: false, code: "OB011" });
  });

  it("anon and service_role cannot execute any onboarding function; a session without a user is refused", async () => {
    const calls = [
      (sql: never) => (sql as never as typeof testDb)`select public.get_onboarding_status(${salon.id})`,
      (sql: never) => (sql as never as typeof testDb)`select public.update_salon_profile(${salon.id}, 'X', 'Europe/Istanbul', 'TRY', '05320000000', null)`,
      (sql: never) => (sql as never as typeof testDb)`select public.onboarding_add_services(${salon.id}, '[]'::jsonb)`,
      (sql: never) => (sql as never as typeof testDb)`select public.onboarding_add_staff(${salon.id}, '[]'::jsonb)`,
      (sql: never) => (sql as never as typeof testDb)`select public.onboarding_apply_weekly_hours(${salon.id}, array[]::uuid[], '[]'::jsonb)`,
      (sql: never) => (sql as never as typeof testDb)`select public.onboarding_set_staff_services(${salon.id}, '[]'::jsonb)`,
    ];
    for (const role of ["anon", "service_role"] as const) {
      for (const call of calls) {
        await expect(asDatabaseRole(role, null, (sql) => call(sql as never) as never)).rejects.toMatchObject({ code: "42501" });
      }
    }
    for (const fn of ["private.onboarding_status(uuid)", "private.onboarding_require(uuid, text[], boolean)"]) {
      const [row] = await testDb<{ a: boolean; b: boolean; c: boolean }[]>`
        select has_function_privilege('authenticated', ${fn}, 'execute') as a,
               has_function_privilege('anon', ${fn}, 'execute') as b,
               has_function_privilege('service_role', ${fn}, 'execute') as c`;
      expect(row).toEqual({ a: false, b: false, c: false });
    }
  });

  it("a suspended salon refuses every write (OB004) but the Owner can still read its status", async () => {
    const o = await newUser("susp");
    const t = await freshSalon("susp", o);
    await testDb`update tenants set status = 'suspended' where id = ${t.id}`;
    expect(await attemptAs(o.id, (sql) => sql`select public.onboarding_add_services(${t.id}, ${testDb.json([{ name: "A", durationMinutes: 30, price: "1" }] as never)})`)).toMatchObject({ ok: false, code: "OB004" });
    expect(await attemptAs(o.id, (sql) => sql`select public.update_salon_profile(${t.id}, 'X', 'Europe/Istanbul', 'TRY', '05320000000', null)`)).toMatchObject({ ok: false, code: "OB004" });
    expect(await attemptAs(o.id, (sql) => sql`select public.get_onboarding_status(${t.id})`)).toEqual({ ok: true });
  });

  it("every write is audited with the actor", async () => {
    for (const action of ["onboarding.profile_updated", "onboarding.services_added", "onboarding.staff_added"]) {
      const rows = await auditRows(salon.id, action);
      expect(rows.length, action).toBeGreaterThan(0);
      expect(rows.every((r) => r.actor_user_id !== null)).toBe(true);
    }
  });
});

describe("TENANT ISOLATION — a write for one salon never reaches another", () => {
  it("bulk-added services and staff are linked only to THIS salon's branches", async () => {
    const oa = await newUser("isoa");
    const a = await freshSalon("isoa", oa);
    const ob = await newUser("isob");
    const b = await freshSalon("isob", ob);
    await rpc.services(oa.id, a.id, [{ name: "A Hizmeti", durationMinutes: 30, price: "10" }]);
    await rpc.staff(oa.id, a.id, [{ fullName: "A Personeli" }]);
    const foreignServiceLinks = await testDb<{ n: string }[]>`
      select count(*)::text as n from service_branches sb join services s on s.id = sb.service_id join branches br on br.id = sb.branch_id
      where s.tenant_id = ${a.id} and br.tenant_id <> ${a.id}`;
    const foreignStaffLinks = await testDb<{ n: string }[]>`
      select count(*)::text as n from staff_branches sb join staff_members sm on sm.id = sb.staff_member_id join branches br on br.id = sb.branch_id
      where sm.tenant_id = ${a.id} and br.tenant_id <> ${a.id}`;
    expect([foreignServiceLinks[0]!.n, foreignStaffLinks[0]!.n]).toEqual(["0", "0"]);
    // and the other salon saw nothing of it
    const bLinks = await testDb<{ n: string }[]>`select count(*)::text as n from service_branches where branch_id = ${b.branchId}`;
    expect(bLinks[0]!.n).toBe("0");
  });

  it("updating one salon's profile leaves every other salon's name, time zone, currency and contact untouched", async () => {
    const oa = await newUser("profa");
    const a = await freshSalon("profa", oa);
    const ob = await newUser("profb");
    const b = await freshSalon("profb", ob);
    await rpc.profile(ob.id, b.id, "B Salonu", "Asia/Nicosia", "EUR", "0533 000 11 22", "B Adresi");
    const snapshot = async () => ({
      tenant: await testDb`select name, timezone, currency from tenants where id = ${b.id}`,
      branch: await testDb`select name, phone, address from branches where tenant_id = ${b.id}`,
    });
    const before = await snapshot();
    await rpc.profile(oa.id, a.id, "A Salonu", "Europe/Istanbul", "TRY", "0542 999 88 77", "A Adresi");
    expect(await snapshot()).toEqual(before);
    const [mine] = await testDb<{ name: string }[]>`select name from tenants where id = ${a.id}`;
    expect(mine!.name).toBe("A Salonu");
  });

  it("a session without a signed-in user is refused with its own code, for the status and for every write", async () => {
    const calls = [
      (sql: never) => (sql as never as typeof testDb)`select public.get_onboarding_status(${salon.id})`,
      (sql: never) => (sql as never as typeof testDb)`select public.onboarding_add_staff(${salon.id}, '[{"fullName":"X"}]'::jsonb)`,
      (sql: never) => (sql as never as typeof testDb)`select public.onboarding_add_services(${salon.id}, '[{"name":"X","durationMinutes":30,"price":"1"}]'::jsonb)`,
    ];
    for (const call of calls) {
      await expect(asDatabaseRole("authenticated", null, (sql) => call(sql as never) as never)).rejects.toMatchObject({ code: "OB010" });
    }
  });
});

describe("PRIVACY — the status carries salon facts only", () => {
  it("no user ids, e-mails, tokens or foreign keys appear anywhere in the status payload", async () => {
    const s = await status(salon.id, owner.id);
    const serialized = JSON.stringify(s);
    for (const secret of [owner.id, owner.email, otherOwner.id, manager.id, salon.id, salon.branchId, other.id]) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys(s).sort()).toEqual(
      ["blockers", "bookingEngineBlockers", "bookingEngineReady", "counts", "firstAvailableSlotAt", "hasAppointments", "onlineBookingEnabled", "profile", "ready", "steps", "tenantSlug"].sort(),
    );
    expect(Object.keys(s.profile).sort()).toEqual(["currency", "missing", "name", "phone", "timezone"]);
  });
});
