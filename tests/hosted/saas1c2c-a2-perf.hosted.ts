import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTenants, cleanupUsers, createBranch, createService, createStaffMember, createStaffSchedule, createTestTenant, createTestUser, linkServiceBranch, linkStaffBranch, linkStaffService, signInAs, testDb, type TestUser } from "../helpers";
import { assertDisposableDatabase, readHostedEnv } from "./guard";
import { callCreateGuestBooking } from "@/lib/modules/public-booking/gateway-db";

/**
 * Faz SAAS.1C.2c-A2 - HOSTED latency of the common write paths at stage 0, over REAL HTTP (PostgREST + signed-in JWT) and the real booking_gateway
 * connection. Run once on the A1 schema (A2_PHASE=a1) and once on the A2 schema (A2_PHASE=a2); the result is written to A2_PERF_OUT. N sequential
 * calls per operation per round, medians over the rounds (round 1 is warm-up). The stage is asserted to be 0.
 */
readHostedEnv();
const PHASE = process.env.A2_PHASE ?? "a1";
const OUT = process.env.A2_PERF_OUT ?? `perf-${PHASE}.json`;
const N = Number(process.env.A2_PERF_N ?? 30);
const ROUNDS = Number(process.env.A2_PERF_ROUNDS ?? 5);
const RUN = Math.random().toString(36).slice(2, 7);
const userIds: string[] = [];
const tenantIds: string[] = [];
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const slot = (base: number, idx: number): string => {
  const d = new Date();
  d.setUTCHours(5, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + base + Math.floor(idx / 24));
  return new Date(d.getTime() + (idx % 24) * 30 * 60000).toISOString();
};

let owner: TestUser;
let tenant: { id: string; slug: string };
let branch: string;
let staff: string;
let staff2: string;
let svc: string;
let cust: string;
let schedId: string;
let cl: Awaited<ReturnType<typeof signInAs>>;
const apptIds: string[] = [];

beforeAll(async () => {
  await assertDisposableDatabase(testDb as unknown as Parameters<typeof assertDisposableDatabase>[0]);
  const [{ stage }] = await testDb<{ stage: number }[]>`select stage from private.billing_enforcement_config where id = 1`;
  expect(stage).toBe(0);
  owner = await createTestUser("h-a2perf-owner");
  userIds.push(owner.id);
  const t = await createTestTenant(`h-a2-perf-${PHASE}-${RUN}`, owner.id);
  tenant = { id: t.id, slug: t.slug };
  tenantIds.push(t.id);
  const [plan] = await testDb<{ id: string }[]>`select id from plans where key = 'salon'`;
  await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode) values (${t.id}, ${plan!.id}, 'active', 'pilot')`;
  const [feat] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
  await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${t.id}, ${feat!.id}, true)`;
  branch = await createBranch(t.id, "Merkez");
  staff = (await createStaffMember(t.id, "Personel")).id;
  staff2 = (await createStaffMember(t.id, "Personel 2")).id;
  svc = (await createService(t.id, "Hizmet", 30, 100)).id;
  await linkServiceBranch(svc, branch);
  for (const s of [staff, staff2]) {
    await linkStaffBranch(s, branch);
    await linkStaffService(s, svc);
    for (let w = 0; w <= 6; w++) schedId = await createStaffSchedule(t.id, s, w, "00:00", "23:59");
  }
  const [c] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${t.id}, 'Musteri') returning id`;
  cust = c!.id;
  cl = await signInAs(owner);
}, 300000);

afterAll(async () => {
  await cleanupTenants(tenantIds);
  await cleanupUsers(userIds);
  await testDb.end();
}, 300000);

async function time(n: number, fn: (i: number) => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  return (performance.now() - t0) / n;
}

describe("PF hosted stage-0 latency", () => {
  it(`PF1 ${PHASE}: common write paths over real HTTP / the real gateway login`, async () => {
    const res: Record<string, number[]> = {};
    const push = (k: string, v: number, r: number) => { if (r > 0) (res[k] ??= []).push(v); };
    for (let r = 0; r < ROUNDS; r++) {
      push("direct INSERT customers (PostgREST, owner JWT)", await time(N, async (i) => { const x = await cl.from("customers").insert({ tenant_id: tenant.id, full_name: `Perf ${r}-${i}` }); if (x.error) throw new Error(x.error.message); }), r);
      push("direct UPDATE customers (PostgREST)", await time(N, async () => { const x = await cl.from("customers").update({ full_name: "Duzenlendi" }).eq("id", cust); if (x.error) throw new Error(x.error.message); }), r);
      push("direct UPDATE staff_schedules (PostgREST)", await time(N, async () => { const x = await cl.from("staff_schedules").update({ end_time: "23:59:00" }).eq("id", schedId); if (x.error) throw new Error(x.error.message); }), r);
      push("create_appointment (RPC)", await time(N, async (i) => {
        const x = await cl.rpc("create_appointment", { p_tenant_id: tenant.id, p_branch_id: branch, p_customer_id: cust, p_items: [{ service_id: svc, staff_member_id: staff, scheduled_start_at: slot(2, r * N + i), sequence: 1 }], p_notes: null } as never);
        if (x.error) throw new Error(x.error.message);
        apptIds.push(x.data as unknown as string);
      }), r);
      const base = apptIds.length - N;
      push("update_appointment_status (RPC)", await time(N, async (i) => { const x = await cl.rpc("update_appointment_status", { p_appointment_id: apptIds[base + i]!, p_new_status: "confirmed" }); if (x.error) throw new Error(x.error.message); }), r);
      push("set_online_booking_enabled (RPC)", await time(N, async (i) => { const x = await cl.rpc("set_online_booking_enabled", { p_tenant_id: tenant.id, p_enabled: i % 2 === 0 }); if (x.error) throw new Error(x.error.message); }), r);
      // Harness fix: the toggle loop above ends with i = N - 1 (odd for N = 30) => p_enabled false, which is what made the first run fail with BK001.
      // Leave online booking ENABLED and assert the precondition explicitly before the public booking loop.
      { const x = await cl.rpc("set_online_booking_enabled", { p_tenant_id: tenant.id, p_enabled: true }); if (x.error) throw new Error(x.error.message); }
      { const [e] = await testDb<{ on: boolean }[]>`select private.tenant_effective_online_booking(${tenant.id}) as on`; expect(e!.on).toBe(true); }
      push("public booking (real booking_gateway login)", await time(N, async (i) => {
        const x = await callCreateGuestBooking({ tenantSlug: tenant.slug, branchId: branch, serviceId: svc, scheduledStartAtUtc: slot(12, r * N + i), customerFullName: "Misafir", customerPhone: "5551110001", staffMemberId: staff2, customerEmail: "misafir@example.test", idempotencyKey: randomUUID(), customerAccountUserId: null });
        if (!x.success) throw new Error(x.code + " " + x.message);
      }), r);
    }
    const out = Object.fromEntries(Object.entries(res).map(([k, v]) => [k, Number(median(v).toFixed(2))]));
    writeFileSync(OUT, JSON.stringify({ phase: PHASE, n: N, rounds: ROUNDS - 1, median_ms_per_op: out }, null, 1));
    console.log("PERF", PHASE, JSON.stringify(out));
    expect(Object.keys(out)).toHaveLength(7);
  }, 1200000);
});
