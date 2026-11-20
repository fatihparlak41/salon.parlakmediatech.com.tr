import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { cleanupPlatformAdmins, cleanupTenants, cleanupUsers, createTestTenant, createTestUser, testDb, type TestUser } from "./helpers";
import registry from "./fixtures/billing-enforcement-registry.json";

/**
 * Faz SAAS.1C.2c-A1 - the INERT enforcement control plane. IDs: SC stage config, EO operator authorization, ST setter contract, ID idempotency / conflict,
 * CC concurrency, AU audit, PF preflight, PR protection model + precedence, DM decision matrix, CT counters, SE catalog / grants, IN inertness.
 * Everything is synthetic. Nothing here activates enforcement for anything but the scratch database.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Sql = postgres.TransactionSql;
type Role = "authenticated" | "anon" | "service_role";

const u: Record<string, TestUser> = {};
const userIds: string[] = [];
const tenantIds: string[] = [];
const rid = () => randomUUID();
let seq = 0;

async function asApi<T>(userId: string | null, fn: (sql: Sql) => Promise<T>, role: Role = "authenticated"): Promise<T> {
  return (await testDb.begin(async (sql) => {
    if (userId) {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`;
    }
    await sql`set local session authorization authenticator`;
    await sql.unsafe(`set local role ${role}`);
    return fn(sql);
  })) as T;
}
const fails = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { message?: string }).message ?? String(e);
  }
  return "__no_error__";
};

type Set = { target: number; stage: number; version: number; reason?: string | null; rid?: string | null; hash?: string | null };
const setStage = (uid: string | null, a: Set, role: Role = "authenticated") =>
  asApi(uid, async (sql) => (await sql`select public.admin_set_billing_enforcement_stage(${a.target}::int, ${a.stage}::int, ${a.version}::int, ${a.reason === undefined ? "operator test reason" : a.reason}::text, ${a.rid === undefined ? rid() : a.rid}::uuid, ${a.hash ?? null}::text) as r`)[0]!.r as Loose, role);
const preflight = (uid: string | null, target: number, expectedProtected: number | null = null, appSha: string | null = null, role: Role = "authenticated") =>
  asApi(uid, async (sql) => (await sql`select public.admin_billing_enforcement_preflight(${target}::int, ${expectedProtected}::int, ${appSha}::text) as r`)[0]!.r as Loose, role);
const status = (uid: string | null, role: Role = "authenticated") => asApi(uid, async (sql) => (await sql`select public.admin_billing_enforcement_status() as r`)[0]!.r as Loose, role);
const cfg = async (): Promise<Loose> => (await testDb<Loose[]>`select * from private.billing_enforcement_config where id = 1`)[0]!;
const events = () => testDb<Loose[]>`select * from private.billing_enforcement_events order by id`;
const core = async (target: number, expectedProtected: number | null = null): Promise<Loose> =>
  (await testDb`select private.billing_preflight_core(${target}::smallint, ${expectedProtected}::int, null::text) as r`)[0]!.r as Loose;
const checkOf = (r: Loose, id: string): Loose => (r.checks as Loose[]).find((c) => c.id === id)!;

/** operator-style reset of the singleton (the marker is the deliberate operator path; it audits itself) */
async function resetConfig(stage = 0, ageDays = 0) {
  await testDb.begin(async (sql) => {
    await sql`select set_config('salonos.enforcement_setter', 'on', true)`;
    await sql`update private.billing_enforcement_config set stage = ${stage}, version = version + 1, stage_changed_at = now() - make_interval(days => ${ageDays}), updated_at = now() where id = 1`;
  });
}
async function planId(key = "salon") {
  return (await testDb<{ id: string }[]>`select id from plans where key = ${key}`)[0]!.id;
}
type Fx = { status?: string; mode?: string; trialStarted?: string | null; trialEnds?: string | null; grace?: string | null; periodStart?: string | null; periodEnd?: string | null; cancel?: boolean; prot?: boolean; tenantStatus?: string; deleted?: boolean };
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
async function mk(slug: string, fx: Fx = {}): Promise<string> {
  const t = await createTestTenant(`${slug.replace(/[^a-z0-9-]/g, "-")}-${++seq}-${Math.random().toString(36).slice(2, 6)}`, u.owner!.id);
  tenantIds.push(t.id);
  await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode, trial_started_at, trial_ends_at, grace_ends_at, current_period_start, current_period_end, cancel_at_period_end, protected)
    values (${t.id}, ${await planId()}, ${fx.status ?? "active"}, ${fx.mode ?? "pilot"}, ${fx.trialStarted ?? null}, ${fx.trialEnds ?? null}, ${fx.grace ?? null}, ${fx.periodStart ?? null}, ${fx.periodEnd ?? null}, ${fx.cancel ?? false}, ${fx.prot ?? false})`;
  if (fx.tenantStatus || fx.deleted) {
    await testDb`select set_config('salonos.sanctioned_lifecycle', 'on', true)`;
    await testDb.begin(async (sql) => {
      await sql`select set_config('salonos.sanctioned_lifecycle', 'on', true)`;
      if (fx.tenantStatus) await sql`update tenants set status = ${fx.tenantStatus} where id = ${t.id}`;
      if (fx.deleted) await sql`update tenants set deleted_at = now() where id = ${t.id}`;
    });
  }
  return t.id;
}
/** a state in each access mode (non-protected unless asked) */
const MODE: Record<string, Fx> = {
  full: { status: "active", mode: "pilot" },
  grace: { status: "trialing", mode: "paid", trialStarted: inDays(-40), trialEnds: inDays(-5), grace: inDays(9) },
  read_only: { status: "trialing", mode: "paid", trialStarted: inDays(-60), trialEnds: inDays(-30), grace: inDays(-10) },
  blocked: { status: "active", mode: "pilot", tenantStatus: "suspended" },
};

beforeAll(async () => {
  for (const l of ["owner", "pown", "psupport", "plain", "other"]) {
    const x = await createTestUser(`a1-${l}`);
    userIds.push(x.id);
    u[l] = x;
  }
  await testDb`insert into platform_admins (user_id, role, is_active) values (${u.pown!.id}, 'owner', true), (${u.psupport!.id}, 'support', true)`;
  // a clean baseline for the GLOBAL preflight: tenants left behind by other suites without a subscription row would (rightly) fail it
  await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode)
    select t.id, ${await planId()}, 'active', 'pilot' from tenants t where not exists (select 1 from subscriptions s where s.tenant_id = t.id)`;
  await resetConfig(0);
}, 300000);

afterAll(async () => {
  await testDb`alter table private.billing_enforcement_events disable trigger billing_enforcement_events_append_only`;
  await testDb`alter table private.billing_preflight_runs disable trigger billing_preflight_runs_append_only`;
  await testDb`delete from private.billing_enforcement_events`;
  await testDb`delete from private.billing_preflight_runs`;
  await testDb`alter table private.billing_enforcement_events enable trigger billing_enforcement_events_append_only`;
  await testDb`alter table private.billing_preflight_runs enable trigger billing_preflight_runs_append_only`;
  await testDb`delete from private.billing_decision_counters`;
  await testDb`delete from private.billing_guard_health`;
  await testDb`delete from private.billing_shadow_samples`;
  await testDb.begin(async (sql) => {
    await sql`select set_config('salonos.enforcement_setter', 'on', true)`;
    await sql`select set_config('salonos.enforcement_event_written', 'on', true)`;
    await sql`update private.billing_enforcement_config set stage = 0, version = 1, stage_changed_at = now(), updated_by = null, last_event_id = null where id = 1`;
  });
  await cleanupTenants(tenantIds);
  await cleanupPlatformAdmins([u.pown!.id, u.psupport!.id]);
  await cleanupUsers(userIds);
  await testDb.end();
}, 300000);

describe("SC stage configuration", () => {
  it("SC1 the stages are exactly 0 OFF, 1 SHADOW, 2 PUBLIC_BOOKING, 3 NEW_BUSINESS_WRITES, 4 FULL_ENFORCEMENT", async () => {
    const rows = await testDb<Loose[]>`select stage, name from private.billing_stages order by stage`;
    expect(rows.map((r) => `${r.stage}:${r.name}`)).toEqual(["0:OFF", "1:SHADOW", "2:PUBLIC_BOOKING", "3:NEW_BUSINESS_WRITES", "4:FULL_ENFORCEMENT"]);
  });
  it("SC2 the singleton exists, a second row is impossible, the stage is constrained", async () => {
    expect((await testDb`select count(*)::int n from private.billing_enforcement_config`)[0]!.n).toBe(1);
    expect(await fails(testDb`insert into private.billing_enforcement_config (id, stage) values (2, 0)`)).toMatch(/violates check constraint/);
    expect(await fails(testDb`insert into private.billing_enforcement_config (id, stage) values (1, 9)`)).toMatch(/violates|duplicate/);
  });
  it("SC3 nobody changes the config directly: not even the operator without the deliberate marker; delete / truncate refused", async () => {
    expect(await fails(testDb`update private.billing_enforcement_config set stage = 2`)).toMatch(/only through admin_set_billing_enforcement_stage/);
    expect(await fails(testDb`delete from private.billing_enforcement_config`)).toMatch(/singleton/);
    expect(await fails(testDb`truncate private.billing_enforcement_config`)).toMatch(/singleton/);
    expect((await cfg()).stage).toBe(0);
  });
  it("SC4 an operator change WITH the marker is allowed and still leaves an audit row (there is no unaudited stage change)", async () => {
    const before = (await events()).length;
    await resetConfig(0);
    const rows = await events();
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ event: "stage_change", request_hash: "direct", reason: "direct operator change without the setter" });
  });
  it("SC5 status read: platform admins (owner and support) see stage, version, counters; the stage name is exact", async () => {
    await resetConfig(0);
    for (const who of ["pown", "psupport"]) {
      const s = await status(u[who]!.id);
      expect(s).toMatchObject({ stage: 0, stageName: "OFF" });
      expect(s.counters).toMatchObject({ decisions: 0, would_block: 0, guard_errors: 0 });
    }
    expect(await fails(status(u.plain!.id))).toMatch(/platform admin required/);
    expect(await fails(status(null))).toMatch(/authentication required/);
  });
});

describe("EO operator authorization", () => {
  const ok = { target: 1, stage: 0, version: 1 };
  it("EO1 only the platform OWNER: support, a plain user, anon, service_role and a signed-out caller are all refused (setter and preflight)", async () => {
    await resetConfig(0);
    const c = await cfg();
    const a = { target: 1, stage: 0, version: c.version };
    expect(await fails(setStage(u.psupport!.id, a))).toMatch(/platform owner required/);
    expect(await fails(setStage(u.plain!.id, a))).toMatch(/platform owner required/);
    expect(await fails(setStage(null, a))).toMatch(/authentication required/);
    expect(await fails(setStage(u.pown!.id, a, "anon"))).toMatch(/permission denied/);
    expect(await fails(setStage(u.pown!.id, a, "service_role"))).toMatch(/permission denied/);
    expect(await fails(setStage(null, a, "service_role"))).toMatch(/permission denied/);
    expect(await fails(preflight(u.psupport!.id, 1))).toMatch(/platform owner required/);
    expect(await fails(preflight(u.pown!.id, 1, null, null, "service_role"))).toMatch(/permission denied/);
    expect(await fails(preflight(u.plain!.id, 1))).toMatch(/platform owner required/);
    expect((await cfg()).stage).toBe(0);
    void ok;
  });
  it("EO2 the owner is allowed through a passing preflight", async () => {
    await resetConfig(0);
    const c = await cfg();
    const pf = await preflight(u.pown!.id, 1);
    expect(pf.passed, JSON.stringify(pf.checks.filter((x: Loose) => !x.pass))).toBe(true);
    const r = await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, hash: pf.hash });
    expect(r).toMatchObject({ ok: true, replayed: false, fromStage: 0, stage: 1, version: c.version + 1 });
    expect((await cfg()).stage).toBe(1);
  });
  it("EO3 service_role has no way to the control plane: no table privilege, no execute on any new function", async () => {
    const t = await testDb<Loose[]>`select c.relname, has_table_privilege('service_role', c.oid, 'select,insert,update,delete,truncate') p from pg_class c where c.relnamespace = 'private'::regnamespace and c.relname like 'billing\\_%' and c.relkind = 'r'`;
    expect(t.length).toBeGreaterThanOrEqual(9);
    for (const r of t) expect(r.p, r.relname).toBe(false);
    const f = await testDb<Loose[]>`select p.proname, has_function_privilege('service_role', p.oid, 'execute') x from pg_proc p where p.proname like '%billing\\_enforcement%' or p.proname in ('billing_stage', 'billing_decide', 'billing_effective_access', 'billing_preflight_core', 'billing_registry_unregistered', 'billing_check')`;
    expect(f.length).toBeGreaterThanOrEqual(10);
    for (const r of f) expect(r.x, r.proname).toBe(false);
  });
});

describe("ST setter contract", () => {
  async function at(stage: number): Promise<Loose> {
    await resetConfig(stage, 40);
    return cfg();
  }
  it("ST1 validation: reason, request id, target, expected state are required", async () => {
    const c = await at(0);
    expect(await fails(setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, reason: "short" }))).toMatch(/reason_required/);
    expect(await fails(setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, reason: null }))).toMatch(/reason_required/);
    expect(await fails(setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, reason: "x".repeat(501) }))).toMatch(/reason_required/);
    expect(await fails(setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, rid: null }))).toMatch(/request_id_required/);
    expect(await fails(setStage(u.pown!.id, { target: 9, stage: 0, version: c.version }))).toMatch(/invalid_target_stage/);
    expect(await fails(setStage(u.pown!.id, { target: -1, stage: 0, version: c.version }))).toMatch(/invalid_target_stage/);
    expect(await fails(asApi(u.pown!.id, async (sql) => sql`select public.admin_set_billing_enforcement_stage(1, null, ${c.version}::int, 'a long enough reason', ${rid()}::uuid, null)`))).toMatch(/expected_state_required/);
    expect(await fails(asApi(u.pown!.id, async (sql) => sql`select public.admin_set_billing_enforcement_stage(1, 0, null, 'a long enough reason', ${rid()}::uuid, null)`))).toMatch(/expected_state_required/);
    expect((await cfg()).stage).toBe(0);
  });
  it("ST2 an upward step needs a preflight: none, a wrong hash, or a hash for another target are refused (and the refusals are audited)", async () => {
    const c = await at(0);
    const before = (await events()).length;
    expect(await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version })).toEqual({ ok: false, error: "preflight_required" });
    expect(await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, hash: "0".repeat(64) })).toEqual({ ok: false, error: "preflight_stale" });
    const other = await preflight(u.pown!.id, 2);
    expect(await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, hash: other.hash })).toEqual({ ok: false, error: "preflight_stale" });
    const rows = (await events()).slice(before);
    expect(rows.map((r) => `${r.event}:${r.error_code}`)).toEqual(["refused:preflight_required", "refused:preflight_stale", "refused:preflight_stale"]);
    expect((await cfg()).stage).toBe(0);
  });
  it("ST3 one step upward only: 0 -> 2, 0 -> 4 and 1 -> 3 are denied; 0 -> 1 and 1 -> 2 (with the requirements met) work", async () => {
    let c = await at(0);
    const pf2 = await preflight(u.pown!.id, 2);
    expect(await setStage(u.pown!.id, { target: 2, stage: 0, version: c.version, hash: pf2.hash })).toEqual({ ok: false, error: "multi_step_denied" });
    expect(await setStage(u.pown!.id, { target: 4, stage: 0, version: c.version, hash: pf2.hash })).toEqual({ ok: false, error: "multi_step_denied" });
    const pf1 = await preflight(u.pown!.id, 1);
    expect((await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, hash: pf1.hash })).ok).toBe(true);
    c = await cfg();
    expect(await setStage(u.pown!.id, { target: 3, stage: 1, version: c.version, hash: (await preflight(u.pown!.id, 3)).hash })).toEqual({ ok: false, error: "multi_step_denied" });
    // 1 -> 2 needs 14 days in stage 1 and 300 recorded decisions (the agreed shadow acceptance): not met yet
    const pfNo = await preflight(u.pown!.id, 2);
    expect(checkOf(pfNo, "stage_requirements").pass).toBe(false);
    expect(await setStage(u.pown!.id, { target: 2, stage: 1, version: c.version, hash: pfNo.hash })).toEqual({ ok: false, error: "preflight_failed" });
  });
  it("ST4 shadow acceptance: 14 days AND 300 decisions - either one missing keeps the stage at 1; both satisfied allows 1 -> 2", async () => {
    await resetConfig(1, 20);
    let c = await cfg();
    expect(checkOf(await core(2), "stage_requirements").pass).toBe(false); // 20 days but 0 decisions
    const t = await mk("a1-st4", { status: "active", mode: "pilot" });
    const day = new Date().toISOString().slice(0, 10);
    await testDb`insert into private.billing_decision_counters (day, tenant_id, stage, category, action_key, mode, decision, reason, n, config_version)
      values (${day}, ${t}, 1, 'APPT_CREATE', 'fn:create_appointment', 'full', 'allow', 'pilot', 299, ${c.version})`;
    expect(checkOf(await core(2), "stage_requirements").pass).toBe(false); // 299 < 300
    await testDb`update private.billing_decision_counters set n = 300 where tenant_id = ${t}`;
    expect(checkOf(await core(2), "stage_requirements").pass).toBe(true);
    await resetConfig(1, 5); // 300 decisions but only 5 days
    await testDb`update private.billing_decision_counters set config_version = config_version where tenant_id = ${t}`;
    expect(checkOf(await core(2), "stage_requirements").pass).toBe(false);
    await resetConfig(1, 20);
    c = await cfg();
    const pf = await preflight(u.pown!.id, 2);
    expect(pf.passed, JSON.stringify(pf.checks.filter((x: Loose) => !x.pass))).toBe(true);
    expect(await setStage(u.pown!.id, { target: 2, stage: 1, version: c.version, hash: pf.hash })).toMatchObject({ ok: true, stage: 2 });
    await testDb`delete from private.billing_decision_counters where tenant_id = ${t}`;
  });
  it("ST5 downward is immediate: 4 -> 0, 3 -> 1 with no preflight and no dwell time; no_change is refused", async () => {
    let c = await at(4);
    expect(await setStage(u.pown!.id, { target: 0, stage: 4, version: c.version, reason: "emergency rollback to stage 0" })).toMatchObject({ ok: true, stage: 0 });
    c = await at(3);
    expect(await setStage(u.pown!.id, { target: 1, stage: 3, version: c.version })).toMatchObject({ ok: true, stage: 1 });
    c = await cfg();
    expect(await setStage(u.pown!.id, { target: 1, stage: 1, version: c.version })).toEqual({ ok: false, error: "no_change" });
  });
  it("ST6 stale expected stage / stale version are refused; nothing changes", async () => {
    const c = await at(1);
    expect(await setStage(u.pown!.id, { target: 0, stage: 2, version: c.version })).toEqual({ ok: false, error: "stale_stage" });
    expect(await setStage(u.pown!.id, { target: 0, stage: 1, version: c.version - 1 })).toEqual({ ok: false, error: "stale_version" });
    expect(await setStage(u.pown!.id, { target: 0, stage: 1, version: c.version + 5 })).toEqual({ ok: false, error: "stale_version" });
    expect((await cfg()).stage).toBe(1);
  });
  it("ST7 a stale preflight is refused: older than 15 minutes, or the world changed after it (a malformed shape appeared)", async () => {
    const c = await at(0);
    const pf = await preflight(u.pown!.id, 1);
    expect(pf.passed).toBe(true);
    // age the run beyond 15 minutes (append-only table: the test operator rewrites the evidence timestamp deliberately)
    await testDb.begin(async (sql) => {
      await sql`alter table private.billing_preflight_runs disable trigger billing_preflight_runs_append_only`;
      await sql`update private.billing_preflight_runs set at = now() - interval '16 minutes' where result_hash = ${pf.hash}`;
      await sql`alter table private.billing_preflight_runs enable trigger billing_preflight_runs_append_only`;
    });
    expect(await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, hash: pf.hash })).toEqual({ ok: false, error: "preflight_stale" });
    // fresh preflight, then the world changes
    const pf2 = await preflight(u.pown!.id, 1);
    const bad = await mk("a1-st7", { status: "past_due", mode: "paid" }); // open-ended past_due: a dangerous legal shape
    expect(await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, hash: pf2.hash })).toEqual({ ok: false, error: "preflight_stale" });
    // and a preflight taken in the bad state is a FAILED one: it cannot authorise anything
    const pf3 = await preflight(u.pown!.id, 1);
    expect(pf3.passed).toBe(false);
    expect(await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, hash: pf3.hash })).toEqual({ ok: false, error: "preflight_failed" });
    await testDb`delete from subscriptions where tenant_id = ${bad}`;
    await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode) values (${bad}, ${await planId()}, 'active', 'pilot')`;
    expect((await preflight(u.pown!.id, 1)).passed).toBe(true);
  });
  it("ST8 a preflight bound to a config version cannot be replayed after the version moved", async () => {
    let c = await at(0);
    const pf = await preflight(u.pown!.id, 1);
    await resetConfig(0); // version moves
    c = await cfg();
    expect(await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, hash: pf.hash })).toEqual({ ok: false, error: "preflight_stale" });
  });
});

describe("ID idempotency and request conflicts", () => {
  it("ID1 same request id + same payload = a replay of the same event (no second change); same id + different payload = request_id_conflict", async () => {
    await resetConfig(0, 40);
    const c = await cfg();
    const r = rid();
    const pf = await preflight(u.pown!.id, 1);
    const first = await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, rid: r, hash: pf.hash });
    expect(first).toMatchObject({ ok: true, replayed: false });
    const again = await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, rid: r, hash: pf.hash });
    expect(again).toMatchObject({ ok: true, replayed: true, eventId: first.eventId, stage: 1, version: first.version });
    expect((await cfg()).version).toBe(first.version);
    const conflict = await setStage(u.pown!.id, { target: 0, stage: 0, version: c.version, rid: r, reason: "a different payload entirely" });
    expect(conflict).toEqual({ ok: false, error: "request_id_conflict" });
    expect((await cfg()).stage).toBe(1);
    expect((await testDb`select count(*)::int n from private.billing_enforcement_events where request_id = ${r} and event = 'stage_change'`)[0]!.n).toBe(1);
  });
  it("ID2 request ids are per actor: a replay by another actor is not a replay", async () => {
    await resetConfig(0, 40);
    const c = await cfg();
    const r = rid();
    const pf = await preflight(u.pown!.id, 1);
    expect((await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, rid: r, hash: pf.hash })).ok).toBe(true);
    expect(await fails(setStage(u.psupport!.id, { target: 1, stage: 0, version: c.version, rid: r }))).toMatch(/platform owner required/);
  });
});

describe("CC concurrency", () => {
  it("CC1 eight parallel setters on the same expected version: exactly one wins, the rest are stale", async () => {
    await resetConfig(4, 40);
    const c = await cfg();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => setStage(u.pown!.id, { target: i % 4, stage: 4, version: c.version, reason: `parallel attempt number ${i}` })));
    expect(rs.filter((r) => r.ok).length).toBe(1);
    for (const r of rs.filter((x) => !x.ok)) expect(["stale_stage", "stale_version"]).toContain(r.error);
    expect((await cfg()).version).toBe(c.version + 1);
  });
  it("CC2 five parallel retries of the SAME request: one change, four replays", async () => {
    await resetConfig(3, 40);
    const c = await cfg();
    const r = rid();
    const rs = await Promise.all(Array.from({ length: 5 }, () => setStage(u.pown!.id, { target: 0, stage: 3, version: c.version, rid: r, reason: "same payload parallel" })));
    expect(rs.every((x) => x.ok)).toBe(true);
    expect(rs.filter((x) => x.replayed === false).length).toBe(1);
    expect((await cfg()).version).toBe(c.version + 1);
  });
});

describe("AU audit", () => {
  it("AU1 append-only: events and preflight runs cannot be updated, deleted or truncated", async () => {
    await resetConfig(0);
    for (const t of ["billing_enforcement_events", "billing_preflight_runs"]) {
      expect(await fails(testDb.unsafe(`update private.${t} set at = now() where id = (select min(id) from private.${t})`))).toMatch(/append-only/);
      expect(await fails(testDb.unsafe(`delete from private.${t} where id = (select min(id) from private.${t})`))).toMatch(/append-only/);
      expect(await fails(testDb.unsafe(`truncate private.${t}`))).toMatch(/append-only/);
    }
  });
  it("AU2 a successful change stores actor, from / to stage, reason, request id + hash, versions before / after, preflight hash and time; no PII columns exist", async () => {
    await resetConfig(0, 40);
    const c = await cfg();
    const r = rid();
    const pf = await preflight(u.pown!.id, 1);
    await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, rid: r, reason: "audit contents check ok", hash: pf.hash });
    const [e] = await testDb<Loose[]>`select * from private.billing_enforcement_events where request_id = ${r}`;
    expect(e).toMatchObject({ event: "stage_change", actor_id: u.pown!.id, from_stage: 0, to_stage: 1, reason: "audit contents check ok", version_before: c.version, version_after: c.version + 1, preflight_hash: pf.hash });
    expect(e!.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e!.at).toBeTruthy();
    expect((await cfg()).last_event_id).toBe(e!.id);
    const cols = (await testDb<{ column_name: string }[]>`select column_name from information_schema.columns where table_schema = 'private' and table_name in ('billing_enforcement_events', 'billing_preflight_runs', 'billing_decision_counters', 'billing_shadow_samples', 'billing_guard_health')`).map((x) => x.column_name);
    for (const col of cols) expect(col, col).not.toMatch(/name|email|phone|note|payload|body|address|token/i);
    expect(JSON.stringify(e)).not.toContain(u.owner!.email);
  });
  it("AU3 every refusal leaves a refused event with a safe error code; the stage is untouched", async () => {
    await resetConfig(1, 40);
    const c = await cfg();
    const n = (await events()).length;
    await setStage(u.pown!.id, { target: 1, stage: 1, version: c.version });
    await setStage(u.pown!.id, { target: 0, stage: 2, version: c.version });
    const rows = (await events()).slice(n);
    expect(rows.map((x) => x.error_code)).toEqual(["no_change", "stale_stage"]);
    for (const x of rows) {
      expect(x.event).toBe("refused");
      expect(x.error_code).toMatch(/^[a-z0-9_]{1,40}$/);
    }
  });
});

describe("PF preflight", () => {
  it("PF1 a clean database passes every check; the result is deterministic (same state, same hash) and carries the operator context", async () => {
    await resetConfig(0);
    const a = await core(1, 0 + (await testDb`select count(*)::int n from subscriptions where protected`)[0]!.n);
    expect(a.passed, JSON.stringify(a.checks.filter((x: Loose) => !x.pass))).toBe(true);
    const b = await core(1, a.context.expectedProtected);
    expect(b.hash).toBe(a.hash);
    expect((a.checks as Loose[]).map((x) => x.id)).toEqual([
      "config_valid", "transition_valid", "export_capability", "migration_head", "registry_integrity", "registry_complete", "hook_coverage", "subscription_relationship", "trial_grace_boundary",
      "past_due_bounded", "status_mode_shape", "dates_wellformed", "status_values_known", "access_state_resolves", "protected_health", "counters_healthy", "stage_requirements",
    ]);
    const withSha = await core(1, null);
    const viaRpc = await preflight(u.pown!.id, 1, null, "06105a7");
    expect(viaRpc.hash).not.toBe(withSha.hash); // the app sha is part of what was approved
    expect(viaRpc).toMatchObject({ passed: true, targetStage: 1, currentStage: 0 });
    expect(await fails(preflight(u.pown!.id, 1, null, "not a sha"))).toMatch(/invalid_app_sha/);
  });
  it("PF2 dangerous legal shapes each fail their own check: trial without a grace boundary, open-ended past_due, non-paid not active, paid active without period end, canceled without period end", async () => {
    const shapes: [string, string, Fx][] = [
      ["trial_grace_boundary", "trial without grace", { status: "trialing", mode: "paid", trialStarted: inDays(-3), trialEnds: inDays(20), grace: null }],
      ["past_due_bounded", "past_due open ended", { status: "past_due", mode: "paid" }],
      ["status_mode_shape", "pilot past_due", { status: "past_due", mode: "pilot", grace: inDays(5) }],
      ["status_mode_shape", "paid active no period end", { status: "active", mode: "paid" }],
      ["status_mode_shape", "canceled no period end", { status: "canceled", mode: "paid" }],
    ];
    for (const [id, label, fx] of shapes) {
      const t = await mk("a1-pf2", fx);
      const r = await core(1);
      expect(checkOf(r, id).pass, label).toBe(false);
      expect(r.passed, label).toBe(false);
      // an upward stage change is refused while the shape exists
      await resetConfig(0, 40);
      const c = await cfg();
      const pf = await preflight(u.pown!.id, 1);
      expect(await setStage(u.pown!.id, { target: 1, stage: 0, version: c.version, hash: pf.hash }), label).toEqual({ ok: false, error: "preflight_failed" });
      // ... but a DOWNWARD change never needs it
      await resetConfig(2, 40);
      const c2 = await cfg();
      expect(await setStage(u.pown!.id, { target: 0, stage: 2, version: c2.version }), label).toMatchObject({ ok: true, stage: 0 });
      await testDb`delete from subscriptions where tenant_id = ${t}`;
      await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode) values (${t}, ${await planId()}, 'active', 'pilot')`;
    }
    expect((await core(1)).passed).toBe(true);
  });
  it("PF3 missing subscription, orphan subscription, malformed dates, unknown status values, null access state", async () => {
    // missing subscription
    const t = await createTestTenant("a1-pf3", u.owner!.id);
    tenantIds.push(t.id);
    let r = await core(1);
    expect(checkOf(r, "subscription_relationship").pass).toBe(false);
    expect(checkOf(r, "access_state_resolves").pass).toBe(true); // 'no_subscription' resolves to full: caught by the relationship check instead
    await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode) values (${t.id}, ${await planId()}, 'active', 'pilot')`;
    expect((await core(1)).passed).toBe(true);
    // malformed dates (period end before period start)
    const m = await mk("a1-pf3d", { status: "active", mode: "paid", periodStart: inDays(10), periodEnd: inDays(-10) });
    r = await core(1);
    expect(checkOf(r, "dates_wellformed").pass).toBe(false);
    await testDb`update subscriptions set current_period_start = ${inDays(-10)}, current_period_end = ${inDays(10)} where tenant_id = ${m}`;
    expect((await core(1)).passed).toBe(true);
    // unknown status value / billing mode (the table constraints are dropped inside a rolled-back transaction to simulate a constraint-less future)
    const sim = await fails(
      testDb.begin(async (sql) => {
        await sql`alter table subscriptions drop constraint subscriptions_status_check`;
        await sql`update subscriptions set status = 'weird' where tenant_id = ${m}`;
        const res = (await sql`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
        if ((res.checks as Loose[]).find((c) => c.id === "status_values_known")!.pass) throw new Error("status_values_known should have failed");
        throw new Error("ROLLBACK_OK");
      }),
    );
    expect(sim).toMatch(/ROLLBACK_OK/);
    // null / unexpected access state: a subscription whose plan row vanished cannot happen through constraints, simulate by dropping the FK in a rollback
    const sim2 = await fails(
      testDb.begin(async (sql) => {
        await sql`create or replace function private.tenant_access_state(p_tenant_id uuid) returns jsonb language sql stable as $f$ select null::jsonb $f$`;
        const res = (await sql`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
        if ((res.checks as Loose[]).find((c) => c.id === "access_state_resolves")!.pass) throw new Error("access_state_resolves should have failed");
        throw new Error("ROLLBACK_OK");
      }),
    );
    expect(sim2).toMatch(/ROLLBACK_OK/);
  });
  it("PF4 protected health and the expected protected count (structural, no tenant names)", async () => {
    const t = await mk("a1-pf4", { status: "active", mode: "pilot", prot: true });
    const n = (await testDb`select count(*)::int n from subscriptions where protected`)[0]!.n as number;
    expect(checkOf(await core(1, n), "protected_health").pass).toBe(true);
    expect(checkOf(await core(1, n + 1), "protected_health").pass).toBe(false); // the operator expected one more protected tenant
    expect(checkOf(await core(1, n - 1), "protected_health").pass).toBe(false);
    await testDb`update subscriptions set protected = false where tenant_id = ${t}`;
  });
  it("PF5 counters health: guard errors, policy misses, unknown categories, protected would-block each fail the preflight", async () => {
    await resetConfig(1, 40);
    const day = new Date().toISOString().slice(0, 10);
    expect(checkOf(await core(2), "counters_healthy").pass).toBe(true);
    for (const kind of ["guard_error", "policy_miss", "unknown_category", "protected_would_block"]) {
      await testDb`insert into private.billing_guard_health (day, kind, n) values (${day}, ${kind}, 1) on conflict (day, kind) do update set n = 1`;
      expect(checkOf(await core(2), "counters_healthy").pass, kind).toBe(false);
      await testDb`delete from private.billing_guard_health where kind = ${kind}`;
    }
    expect(checkOf(await core(2), "counters_healthy").pass).toBe(true);
  });
  it("PF6 the export capability, the migration head and the registry integrity are part of the preflight and fail when broken", async () => {
    const sim = async (sqlText: string, checkId: string) =>
      fails(
        testDb.begin(async (sql) => {
          await sql.unsafe(sqlText);
          const res = (await sql`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
          if ((res.checks as Loose[]).find((c) => c.id === checkId)!.pass) throw new Error(checkId + " should have failed");
          throw new Error("ROLLBACK_OK");
        }),
      );
    expect(await sim("drop function public.get_tenant_export_status(uuid)", "export_capability")).toMatch(/ROLLBACK_OK/);
    expect(await sim("delete from supabase_migrations.schema_migrations where version >= '20261105090000'", "migration_head")).toMatch(/ROLLBACK_OK/);
    expect(await sim("insert into private.billing_action_registry (action_key, kind, category, enforcement_class, hooked, audience) values ('fn:no_such_function', 'function', 'EXPORT', 'EXPORT', false, 'member')", "registry_integrity")).toMatch(/ROLLBACK_OK/);
  });
});

describe("PR protection model and precedence", () => {
  const eff = async (t: string): Promise<Loose> => (await testDb`select private.billing_effective_access(${t}) as r`)[0]!.r as Loose;
  it("PR1 a protected tenant is full in EVERY underlying state (grace, read_only, expired, past_due, canceled, suspended, tenant canceled); the raw state is still reported", async () => {
    const states: [string, Fx][] = [
      ["grace", { ...MODE.grace!, prot: true }],
      ["read_only", { ...MODE.read_only!, prot: true }],
      ["expired", { status: "expired", mode: "pilot", prot: true }],
      ["past_due", { status: "past_due", mode: "pilot", grace: inDays(-3), prot: true }],
      ["canceled", { status: "canceled", mode: "pilot", periodEnd: inDays(-3), prot: true }],
      ["suspended", { status: "active", mode: "pilot", prot: true, tenantStatus: "suspended" }],
      ["tenant_canceled", { status: "active", mode: "pilot", prot: true, tenantStatus: "canceled" }],
    ];
    for (const [label, fx] of states) {
      const t = await mk("a1-pr1", fx);
      const e = await eff(t);
      expect(e, label).toMatchObject({ mode: "full", reason: "protected", protected: true, deleted: false, precedence: "protected" });
      expect(["grace", "read_only", "blocked", "full"], label).toContain(e.rawMode);
    }
  });
  it("PR2 precedence is documented and tested: deleted > protected > tenant lifecycle > dates. A deleted protected tenant is BLOCKED; an unprotected suspended tenant is blocked; protection removed = the lapse applies", async () => {
    const d = await mk("a1-pr2d", { status: "active", mode: "pilot", prot: true, deleted: true });
    expect(await eff(d)).toMatchObject({ mode: "blocked", reason: "tenant_deleted", protected: true, deleted: true, precedence: "deleted" });
    const s = await mk("a1-pr2s", { status: "active", mode: "pilot", tenantStatus: "suspended" });
    expect(await eff(s)).toMatchObject({ mode: "blocked", reason: "suspended_by_platform", precedence: "access_state" });
    const l = await mk("a1-pr2l", { ...MODE.read_only!, prot: true });
    expect((await eff(l)).mode).toBe("full");
    await testDb`update subscriptions set protected = false where tenant_id = ${l}`;
    expect(await eff(l)).toMatchObject({ mode: "read_only", reason: "trial_expired", protected: false });
    expect(await testDb`select private.billing_effective_access(${randomUUID()}) as r`).toEqual([{ r: null }]);
  });
  it("PR3 the existing access-state function and the existing lifecycle security are untouched by the wrapper (same output as before, same guard)", async () => {
    const t = await mk("a1-pr3", { ...MODE.read_only! });
    const raw = (await testDb`select private.tenant_access_state(${t}) as r`)[0]!.r as Loose;
    expect(raw).toMatchObject({ mode: "read_only", reason: "trial_expired", enforcementEnabled: false });
    expect(await fails(testDb.begin(async (sql) => { await sql`set local session authorization authenticator`; await sql.unsafe("set local role authenticated"); await sql`update tenants set status = 'suspended' where id = ${t}`; }))).toMatch(/permission denied|tenant_lifecycle_protected/);
    expect((await testDb`select private.billing_enforcement_enabled() as e`)[0]!.e).toBe(false);
  });
});

describe("DM decision matrix (the pure model: category x mode x stage, expected values derived independently from the fixture)", () => {
  type Cat = { category: string; read_only: string; blocked: string; first_stage: number };
  const cats = registry.categories as Cat[];
  const expected = (c: Cat, mode: string, stage: number) => {
    if (stage === 0) return { decision: "allow", enforced: false };
    const policy = mode === "read_only" ? c.read_only : mode === "blocked" ? c.blocked : "allow";
    const effMode = mode === "blocked" && stage < 4 ? "read_only" : mode;
    const eff = effMode === "read_only" ? c.read_only : effMode === "blocked" ? c.blocked : "allow";
    const enforced = stage >= 2 && stage >= c.first_stage && eff === "block";
    return { decision: enforced ? "blocked" : policy === "block" ? "would_block" : "allow", enforced };
  };
  it("DM1 all 23 categories x 4 modes x 5 stages match the independent expectation (460 cells)", async () => {
    const tenants: Record<string, string> = {};
    for (const m of ["full", "grace", "read_only", "blocked"]) tenants[m] = await mk(`a1-dm-${m}`, MODE[m]!);
    for (const m of Object.keys(tenants)) expect(((await testDb`select private.tenant_access_state(${tenants[m]!}) as r`)[0]!.r as Loose).mode, m).toBe(m);
    let cells = 0;
    for (const c of cats) {
      for (const m of Object.keys(tenants)) {
        for (let stage = 0; stage <= 4; stage++) {
          const got = (await testDb`select private.billing_decide(${tenants[m]!}, ${c.category}, ${stage}::smallint) as r`)[0]!.r as Loose;
          const want = expected(c, m, stage);
          expect(got.decision, `${c.category} ${m} s${stage}`).toBe(want.decision);
          expect(got.enforced, `${c.category} ${m} s${stage}`).toBe(want.enforced);
          cells++;
        }
      }
    }
    expect(cells).toBe(23 * 4 * 5);
  });
  it("DM2 a PROTECTED tenant is allowed in every category / stage, whatever its raw state; the would-have-blocked fact is flagged for the counters", async () => {
    const t = await mk("a1-dm2", { ...MODE.read_only!, prot: true });
    let flagged = 0;
    for (const c of cats) {
      for (let stage = 0; stage <= 4; stage++) {
        const got = (await testDb`select private.billing_decide(${t}, ${c.category}, ${stage}::smallint) as r`)[0]!.r as Loose;
        expect(got.decision, `${c.category} s${stage}`).toBe("allow");
        expect(got.enforced).toBe(false);
        if (got.protectedOverride) flagged++;
      }
    }
    expect(flagged).toBeGreaterThan(0);
  });
  it("DM3 an unknown category is allowed and flagged as a policy miss (never a silent block); an unknown tenant is allowed", async () => {
    const t = await mk("a1-dm3", MODE.read_only!);
    const got = (await testDb`select private.billing_decide(${t}, 'NOT_A_CATEGORY', 4::smallint) as r`)[0]!.r as Loose;
    expect(got).toMatchObject({ decision: "allow", policyMiss: true, reason: "unknown_category" });
    expect(((await testDb`select private.billing_decide(${randomUUID()}, 'APPT_CREATE', 4::smallint) as r`)[0]!.r as Loose).decision).toBe("allow");
  });
  it("DM4 stage defaults to the configured stage and error codes are the agreed ones (BL001 read_only, BL002 blocked, BL003 public booking)", async () => {
    await resetConfig(4, 40);
    const ro = await mk("a1-dm4r", MODE.read_only!);
    const bl = await mk("a1-dm4b", MODE.blocked!);
    expect(((await testDb`select private.billing_decide(${ro}, 'APPT_CREATE') as r`)[0]!.r as Loose)).toMatchObject({ decision: "blocked", code: "BL001", stage: 4 });
    expect(((await testDb`select private.billing_decide(${bl}, 'APPT_CREATE') as r`)[0]!.r as Loose)).toMatchObject({ decision: "blocked", code: "BL002" });
    expect(((await testDb`select private.billing_decide(${ro}, 'PUBLIC_BOOKING_CREATE') as r`)[0]!.r as Loose)).toMatchObject({ decision: "blocked", code: "BL003" });
    for (const cat of ["EXPORT", "CUSTOMER_SELF_SERVICE_CANCEL", "SYSTEM_HYGIENE", "PLATFORM_ADMIN", "PERSONAL_PREFS"]) {
      for (const t of [ro, bl]) expect(((await testDb`select private.billing_decide(${t}, ${cat}) as r`)[0]!.r as Loose).decision, cat).toBe("allow");
    }
    await resetConfig(0, 0);
  });
});

describe("CT counters foundation (empty by construction)", () => {
  it("CT1 at stage 0 nothing is recorded: all counter / sample / health tables are empty and the read model returns zeros", async () => {
    for (const t of ["billing_decision_counters", "billing_shadow_samples", "billing_guard_health"]) {
      expect((await testDb.unsafe(`select count(*)::int n from private.${t}`))[0]!.n, t).toBe(0);
    }
    expect(((await testDb`select private.billing_enforcement_counters(0::smallint, now() - interval '30 days') as r`)[0]!.r) as Loose).toEqual({
      decisions: 0, allow: 0, would_block: 0, blocked: 0, guard_errors: 0, policy_misses: 0, unknown_category: 0, protected_would_block: 0,
    });
  });
  it("CT2 the read model aggregates by stage and day: decisions, would_block, guard errors, unknown categories, protected would-block", async () => {
    const t = await mk("a1-ct2", MODE.full!);
    const day = new Date().toISOString().slice(0, 10);
    await testDb`insert into private.billing_decision_counters (day, tenant_id, stage, category, action_key, mode, decision, reason, n, config_version) values
      (${day}, ${t}, 1, 'APPT_CREATE', 'fn:create_appointment', 'full', 'allow', 'pilot', 10, 1),
      (${day}, ${t}, 1, 'APPT_CREATE', 'fn:create_appointment', 'read_only', 'would_block', 'trial_expired', 3, 1),
      (${day}, ${t}, 2, 'APPT_CREATE', 'fn:create_appointment', 'read_only', 'blocked', 'trial_expired', 7, 1)`;
    await testDb`insert into private.billing_guard_health (day, kind, n) values (${day}, 'guard_error', 2), (${day}, 'unknown_category', 1)`;
    expect(((await testDb`select private.billing_enforcement_counters(1::smallint, now() - interval '1 day') as r`)[0]!.r) as Loose).toMatchObject({ decisions: 13, allow: 10, would_block: 3, blocked: 0, guard_errors: 2, unknown_category: 1 });
    expect(((await testDb`select private.billing_enforcement_counters(2::smallint, now() - interval '1 day') as r`)[0]!.r) as Loose).toMatchObject({ decisions: 7, blocked: 7 });
    await testDb`delete from private.billing_decision_counters where tenant_id = ${t}`;
    await testDb`delete from private.billing_guard_health`;
  });
  it("CT3 volume design: the counter key is bounded per day (one row per tenant, stage, action, mode, decision, reason) and a duplicate key is refused", async () => {
    const t = await mk("a1-ct3", MODE.full!);
    const day = new Date().toISOString().slice(0, 10);
    await testDb`insert into private.billing_decision_counters (day, tenant_id, stage, category, action_key, mode, decision, reason, n, config_version) values (${day}, ${t}, 1, 'EXPORT', 'fn:request_tenant_export', 'full', 'allow', 'pilot', 1, 1)`;
    expect(await fails(testDb`insert into private.billing_decision_counters (day, tenant_id, stage, category, action_key, mode, decision, reason, n, config_version) values (${day}, ${t}, 1, 'EXPORT', 'fn:request_tenant_export', 'full', 'allow', 'pilot', 1, 1)`)).toMatch(/duplicate key/);
    expect(await fails(testDb`insert into private.billing_decision_counters (day, tenant_id, stage, category, action_key, mode, decision, reason, n, config_version) values (${day}, ${t}, 1, 'NOT_A_CATEGORY', 'x', 'full', 'allow', 'pilot', 1, 1)`)).toMatch(/foreign key/);
    expect(await fails(testDb`insert into private.billing_decision_counters (day, tenant_id, stage, category, action_key, mode, decision, reason, n, config_version) values (${day}, ${t}, 1, 'EXPORT', 'y', 'full', 'maybe', 'pilot', 1, 1)`)).toMatch(/check constraint/);
    await testDb`delete from private.billing_decision_counters where tenant_id = ${t}`;
  });
});

describe("SE catalog and grants", () => {
  it("SE1 every new table: RLS enabled, no policy, no privilege for anon / authenticated / service_role / PUBLIC", async () => {
    const t = await testDb<Loose[]>`select c.relname, c.relrowsecurity rls from pg_class c where c.relnamespace = 'private'::regnamespace and c.relkind = 'r' and c.relname like 'billing\\_%' order by 1`;
    expect(t.map((r) => r.relname)).toEqual(["billing_action_registry", "billing_categories", "billing_decision_counters", "billing_enforcement_config", "billing_enforcement_events", "billing_guard_health", "billing_preflight_runs", "billing_shadow_samples", "billing_stages"]);
    for (const r of t) expect(r.rls, r.relname).toBe(true);
    expect((await testDb`select count(*)::int n from pg_policies where schemaname = 'private' and tablename like 'billing\\_%'`)[0]!.n).toBe(0);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const r of t) expect((await testDb`select has_table_privilege(${role}, ${"private." + r.relname}, 'select,insert,update,delete,truncate,references,trigger') x`)[0]!.x, `${role} ${r.relname}`).toBe(false);
    }
  });
  it("SE2 the three public RPCs: SECURITY DEFINER, empty search_path, executable by authenticated only (never anon, service_role, PUBLIC)", async () => {
    const rows = await testDb<Loose[]>`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s, has_function_privilege('public', p.oid, 'execute') pub
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_billing_enforcement_status', 'admin_billing_enforcement_preflight', 'admin_set_billing_enforcement_stage')`;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(JSON.stringify(r.proconfig), r.proname).toMatch(/search_path=/);
      expect([r.a, r.u, r.s, r.pub], r.proname).toEqual([false, true, false, false]);
    }
  });
  it("SE3 every private helper is closed to every API role and carries an empty search_path where it is a definer", async () => {
    const rows = await testDb<Loose[]>`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s, has_function_privilege('public', p.oid, 'execute') pub
      from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname in ('billing_stage', 'billing_effective_access', 'billing_decide', 'billing_enforcement_counters', 'billing_registry_unregistered', 'billing_check', 'billing_preflight_core', 'billing_enforcement_refuse', 'billing_enforcement_append_only', 'billing_enforcement_config_guard', 'billing_enforcement_config_audit')`;
    expect(rows.length).toBe(11);
    for (const r of rows) {
      expect([r.a, r.u, r.s, r.pub], r.proname).toEqual([false, false, false, false]);
      expect(JSON.stringify(r.proconfig), r.proname).toMatch(/search_path=/);
    }
  });
  it("SE4 no authorization on user_metadata anywhere in the new functions", async () => {
    const rows = await testDb<{ src: string }[]>`select pg_get_functiondef(p.oid) src from pg_proc p where p.proname like 'billing\\_%' or p.proname like 'admin\\_%billing\\_enforcement%' or p.proname = 'admin_set_billing_enforcement_stage'`;
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const r of rows) expect(r.src).not.toMatch(/user_metadata|raw_user_meta|app_metadata/i);
  });
});

describe("IN inertness: at stage 0 the foundation changes nothing in the product", () => {
  it("IN1 no pre-existing function references any A1 object (the foundation is not wired into any write or read path)", async () => {
    const needles = ["billing_stage", "billing_decide", "billing_effective_access", "billing_preflight_core", "billing_enforcement_config", "billing_decision_counters", "billing_shadow_samples", "billing_guard_health", "billing_action_registry", "billing_categories", "billing_enforcement_counters", "billing_registry_unregistered", "billing_enforcement_events"];
    const own = new Set(["billing_stage", "billing_effective_access", "billing_decide", "billing_enforcement_counters", "billing_registry_unregistered", "billing_check", "billing_preflight_core", "billing_enforcement_refuse", "billing_enforcement_append_only", "billing_enforcement_config_guard", "billing_enforcement_config_audit", "admin_billing_enforcement_status", "admin_billing_enforcement_preflight", "admin_set_billing_enforcement_stage",
      // Faz SAAS.1C.2c-A2 adds these private helpers (the guard, its recorder, the resolver, the read gate, the coverage check and the trigger function)
      "billing_scope_tenant", "billing_health_bump", "billing_decision_record", "billing_guard", "billing_public_booking_open", "billing_hook_coverage", "billing_trigger_guard"]);
    const rows = await testDb<{ proname: string; src: string }[]>`select p.proname, pg_get_functiondef(p.oid) src from pg_proc p where p.prokind = 'f' and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)`;
    // A2: the ONLY way an existing function may reference the foundation is its one marked hook line (proved exactly by tests/saas1c2c-a2-catalog.test.ts); everything else must stay unwired
    const unhooked = (src: string) => src.replace(/[^\n]*-- a2-billing-hook[^\n]*\n?/g, "");
    const hits = rows.filter((r) => !own.has(r.proname) && needles.some((n) => unhooked(r.src).includes(n))).map((r) => r.proname);
    expect(hits).toEqual([]);
  });
  it("IN2 no trigger on any public table calls an A1 function (no A2 hook exists); the existing billing triggers are exactly the four known", async () => {
    const trg = await testDb<{ t: string; f: string }[]>`select c.relname || '.' || t.tgname t, p.proname f from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal`;
    expect(trg.filter((x) => /billing_(stage|decide|effective|preflight|enforcement)/.test(x.f)).map((x) => x.t)).toEqual([]);
    expect(trg.filter((x) => ["branches_hard_limit", "subscription_events_append_only", "subscriptions_bump_version", "tenants_lifecycle_guard"].includes(x.t.split(".")[1]!)).length).toBe(4);
  });
  it("IN3 the stage is 0 and the legacy gate is unchanged and still off; the default stage means every decision is allow / stage_off", async () => {
    await resetConfig(0);
    expect((await cfg()).stage).toBe(0);
    expect((await testDb`select private.billing_stage() s`)[0]!.s).toBe(0);
    expect((await testDb`select enabled from private.release_gates where key = 'billing_enforcement'`)[0]!.enabled).toBe(false);
    const ro = await mk("a1-in3", MODE.read_only!);
    for (const cat of ["PUBLIC_BOOKING_CREATE", "APPT_CREATE", "CUSTOMER_CREATE_IMPORT", "CATALOG_CREATE", "FINANCE_SETTLE"]) {
      expect(((await testDb`select private.billing_decide(${ro}, ${cat}) as r`)[0]!.r as Loose)).toMatchObject({ decision: "allow", reason: "stage_off", enforced: false });
    }
  });
  it("IN4 the locked write-surface inventory equals the catalog; the ONLY additions over the 1C.2b surface are the three A1 operator RPCs (no business RPC added, none changed)", async () => {
    const fx = (await import("./fixtures/saas1c2a-write-surface.json")).default as Loose;
    const live = (await testDb<{ s: string }[]>`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' s from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`).map((x) => x.s).sort();
    expect(live).toEqual(fx.rpc.authenticated);
    expect(live.filter((x) => x.includes("billing_enforcement")).map((x) => x.split("(")[0]).sort()).toEqual(["admin_billing_enforcement_preflight", "admin_billing_enforcement_status", "admin_set_billing_enforcement_stage"]);
  });
});
