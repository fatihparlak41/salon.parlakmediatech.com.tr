import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAuthenticatedUser,
  cleanupTenants,
  cleanupUsers,
  createScheduleException,
  createTestUser,
  testDb,
  type TestUser,
} from "./helpers";

/**
 * Faz LAUNCH.1C — the slot probe is the only potentially expensive part of the readiness read model, and the
 * dashboard of a not-yet-ready salon calls it. This pins the WORST case it can meet (eight people, long open hours, a
 * 15-minute service, every one of the next 14 days blocked, so nothing is ever found) to a generous time budget, and
 * that the common case (a slot exists) stops at the first candidate.
 */

let owner: TestUser;
let tenantId = "";
const stamp = Math.random().toString(36).slice(2, 8);
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "07:00", end: "23:00" }));

beforeAll(async () => {
  owner = await createTestUser("l1c-cost");
  const slug = `l1c-cost-${stamp}`;
  await asAuthenticatedUser(owner.id, (sql) => sql`select public.create_tenant(${"Maliyet Salonu"}, ${slug})`);
  const [t] = await testDb<{ id: string }[]>`select id from tenants where slug = ${slug}`;
  tenantId = t!.id;
  const call = (fn: string, args: unknown[]) => {
    const placeholders = args.map((value, i) => (typeof value === "object" && value !== null ? `$${i + 1}::text::jsonb` : typeof value === "string" && value.startsWith("{") ? `$${i + 1}::uuid[]` : typeof value === "boolean" ? `$${i + 1}::boolean` : /^[0-9a-f]{8}-/.test(String(value)) ? `$${i + 1}::uuid` : `$${i + 1}::text`));
    const values = args.map((value) => (typeof value === "object" && value !== null ? JSON.stringify(value) : value));
    return asAuthenticatedUser(owner.id, (sql) => sql.unsafe(`select public.${fn}(${placeholders.join(", ")})`, values as never[]));
  };
  await call("update_salon_profile", [tenantId, "Maliyet Salonu", "Europe/Istanbul", "TRY", "0532 000 00 00", ""]);
  await call("onboarding_add_services", [tenantId, [{ name: "Kisa Hizmet", durationMinutes: 15, price: "10" }]]);
  await call("onboarding_add_staff", [tenantId, Array.from({ length: 8 }, (_, i) => ({ fullName: `Kisi ${i + 1}` }))]);
  const staff = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${tenantId}`;
  const [svc] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${tenantId}`;
  await call("onboarding_set_staff_services", [tenantId, staff.map((s) => ({ staffId: s.id, serviceIds: [svc!.id] }))]);
  await call("onboarding_apply_weekly_hours", [tenantId, `{${staff.map((s) => s.id).join(",")}}`, WEEK]);
  await call("set_online_booking_enabled", [tenantId, true]);
}, 120_000);

afterAll(async () => {
  await cleanupTenants(tenantId ? [tenantId] : []);
  await cleanupUsers(owner ? [owner.id] : []);
}, 120_000);

const readStatus = async () => {
  const started = performance.now();
  const [row] = await asAuthenticatedUser(owner.id, (sql) => sql<{ s: { blockers: string[]; ready: boolean } }[]>`select public.get_onboarding_status(${tenantId}) as s`);
  return { status: row!.s, ms: performance.now() - started };
};

describe("slot probe cost", () => {
  it("common case: a free slot is found at the first candidate, in a few milliseconds", async () => {
    const { status, ms } = await readStatus();
    expect(status.ready).toBe(true);
    expect(ms).toBeLessThan(1500);
  });

  it("worst case: 8 people x 14 blocked days x 64 candidates each stays well inside a page-load budget", async () => {
    const staff = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${tenantId}`;
    const [{ today }] = await testDb<{ today: string }[]>`select (now() at time zone 'Europe/Istanbul')::date::text as today`;
    for (const s of staff) {
      for (let i = 0; i <= 13; i++) {
        const [{ d }] = await testDb<{ d: string }[]>`select (${today}::date + ${i}::int)::text as d`;
        await createScheduleException(tenantId, s.id, d, "unavailable");
      }
    }
    const { status, ms } = await readStatus();
    expect(status.blockers).toEqual(["no_available_slot"]);
    console.log(`PROBE_WORST_CASE_MS=${Math.round(ms)}`);
    expect(ms).toBeLessThan(5000);
  }, 60_000);
});
