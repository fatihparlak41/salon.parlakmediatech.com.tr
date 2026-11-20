import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anonClient, cleanupPlatformAdmins, cleanupTenants, cleanupUsers, createTestTenant, createTestUser, signInAs, testDb, type TestUser } from "../helpers";
import { assertDisposableDatabase, readHostedEnv } from "./guard";
import registry from "../fixtures/billing-enforcement-registry.json";

/**
 * Faz SAAS.1C.2c-A1 - HOSTED acceptance of the inert enforcement foundation (real Postgres + Auth + PostgREST of a DISPOSABLE project).
 * Every actor is a REAL signed-in JWT (platform owner x2, platform support, salon Owner, Yonetici-like member, Personel-like member, outsider), the anon key
 * or the service-role key, talking to the real Data API. Concurrency is real parallel HTTP. testDb (the postgres operator login) is only used for fixtures,
 * ground-truth reads and the deliberate operator moves (age the stage, seed evidence). All slugs start with "h-". Everything is synthetic.
 * IDs: HS status, HA authorization, HP preflight, HB hash binding, HM protection matrix, HT transitions, HI idempotency, HC concurrency, HE audit,
 * HZ stage-0 inertness, HR registry, HV service_role, HG catalog/grants, HX read model.
 */
readHostedEnv();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Client = Awaited<ReturnType<typeof signInAs>>;
type Res = { data: Loose | null; error: string | null; code: string | null };

const rid = () => randomUUID();
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
const u: Record<string, TestUser> = {};
const c: Record<string, Client> = {};
const userIds: string[] = [];
const tenantIds: string[] = [];
let seq = 0;
const RUN = Math.random().toString(36).slice(2, 7);

async function rpc(client: { rpc: Client["rpc"] }, fn: string, args: Record<string, unknown>): Promise<Res> {
  const r = await client.rpc(fn as never, args as never);
  return { data: (r.data as Loose | null) ?? null, error: r.error ? r.error.message : null, code: r.error?.code ?? null };
}
type Set = { target: number; stage: number; version: number; reason?: string | null; rid?: string | null; hash?: string | null };
const setStage = (cl: Client, a: Set) =>
  rpc(cl, "admin_set_billing_enforcement_stage", {
    p_target_stage: a.target, p_expected_stage: a.stage, p_expected_version: a.version,
    p_reason: a.reason === undefined ? "hosted operator test reason" : a.reason, p_request_id: a.rid === undefined ? rid() : a.rid, p_preflight_hash: a.hash ?? null,
  });
const preflight = (cl: Client, target: number, expectedProtected: number | null = null, appSha: string | null = null) =>
  rpc(cl, "admin_billing_enforcement_preflight", { p_target_stage: target, p_expected_protected: expectedProtected, p_app_sha: appSha });
const status = (cl: Client) => rpc(cl, "admin_billing_enforcement_status", {});
const cfg = async (): Promise<Loose> => (await testDb<Loose[]>`select * from private.billing_enforcement_config where id = 1`)[0]!;
const events = () => testDb<Loose[]>`select * from private.billing_enforcement_events order by id`;
const core = async (target: number, expectedProtected: number | null = null): Promise<Loose> =>
  (await testDb`select private.billing_preflight_core(${target}::smallint, ${expectedProtected}::int, null::text) as r`)[0]!.r as Loose;
const checkOf = (r: Loose, id: string): Loose => (r.checks as Loose[]).find((x) => x.id === id)!;

/** the deliberate operator move: set stage / age it (audited by the config audit trigger as a direct operator change) */
async function operatorSet(stage: number, ageDays = 0) {
  await testDb.begin(async (sql) => {
    await sql`select set_config('salonos.enforcement_setter', 'on', true)`;
    await sql`update private.billing_enforcement_config set stage = ${stage}, version = version + 1, stage_changed_at = now() - make_interval(days => ${ageDays}), updated_at = now() where id = 1`;
  });
}
async function seedDecisions(stage: number, n: number, tenant: string) {
  const day = new Date().toISOString().slice(0, 10);
  await testDb`insert into private.billing_decision_counters (day, tenant_id, stage, category, action_key, mode, decision, reason, n, config_version)
    values (${day}, ${tenant}, ${stage}, 'APPT_CREATE', 'fn:create_appointment', 'full', 'allow', 'pilot', ${n}, 1) on conflict do nothing`;
}
async function planId(key = "salon") {
  return (await testDb<{ id: string }[]>`select id from plans where key = ${key}`)[0]!.id;
}
type Fx = { status?: string; mode?: string; trialStarted?: string | null; trialEnds?: string | null; grace?: string | null; periodStart?: string | null; periodEnd?: string | null; prot?: boolean; tenantStatus?: string; deleted?: boolean; noSub?: boolean };
async function mk(slug: string, fx: Fx = {}): Promise<string> {
  const t = await createTestTenant(`h-a1-${RUN}-${slug}-${++seq}`.replace(/[^a-z0-9-]/g, "-"), u.towner!.id);
  tenantIds.push(t.id);
  if (!fx.noSub) {
    await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode, trial_started_at, trial_ends_at, grace_ends_at, current_period_start, current_period_end, protected)
      values (${t.id}, ${await planId()}, ${fx.status ?? "active"}, ${fx.mode ?? "pilot"}, ${fx.trialStarted ?? null}, ${fx.trialEnds ?? null}, ${fx.grace ?? null}, ${fx.periodStart ?? null}, ${fx.periodEnd ?? null}, ${fx.prot ?? false})`;
  }
  if (fx.tenantStatus || fx.deleted) {
    await testDb.begin(async (sql) => {
      await sql`select set_config('salonos.sanctioned_lifecycle', 'on', true)`;
      if (fx.tenantStatus) await sql`update tenants set status = ${fx.tenantStatus} where id = ${t.id}`;
      if (fx.deleted) await sql`update tenants set deleted_at = now() where id = ${t.id}`;
    });
  }
  return t.id;
}
const dropSub = async (t: string) => {
  await testDb`delete from subscriptions where tenant_id = ${t}`;
  await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode) values (${t}, ${await planId()}, 'active', 'pilot')`;
};
const MODE: Record<string, Fx> = {
  full: { status: "active", mode: "pilot" },
  grace: { status: "trialing", mode: "paid", trialStarted: inDays(-40), trialEnds: inDays(-5), grace: inDays(9) },
  read_only: { status: "trialing", mode: "paid", trialStarted: inDays(-60), trialEnds: inDays(-30), grace: inDays(-10) },
  blocked: { status: "active", mode: "pilot", tenantStatus: "suspended" },
};
/** a transaction that always rolls back; resolves to the message the body threw ("ROLLBACK_OK" when the body's assertions held) */
async function sandbox(body: (sql: postgres.TransactionSql) => Promise<void>): Promise<string> {
  try {
    await testDb.begin(async (sql) => {
      await body(sql);
      throw new Error("ROLLBACK_OK");
    });
  } catch (e) {
    return (e as Error).message;
  }
  return "__no_error__";
}

beforeAll(async () => {
  await assertDisposableDatabase(testDb as unknown as Parameters<typeof assertDisposableDatabase>[0]);
  for (const label of ["towner", "padmin", "padmin2", "psupport", "yon", "pers", "outsider", "forger"]) {
    const user = await createTestUser(`h-a1-${label}`);
    userIds.push(user.id);
    u[label] = user;
  }
  await testDb`insert into platform_admins (user_id, role, is_active) values (${u.padmin!.id}, 'owner', true), (${u.padmin2!.id}, 'owner', true), (${u.psupport!.id}, 'support', true)`;
  // a forged "platform owner" claim in user_metadata (the user can write this themselves) - authorization must ignore it
  await admin.auth.admin.updateUserById(u.forger!.id, { user_metadata: { role: "owner", is_platform_owner: true, platform_role: "owner", service_role: true } });
  for (const label of Object.keys(u)) c[label] = await signInAs(u[label]!);
  // salon members with different roles (real memberships, real roles)
  const t = await createTestTenant(`h-a1-${RUN}-roles-${++seq}`, u.towner!.id);
  tenantIds.push(t.id);
  await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode) values (${t.id}, ${await planId()}, 'active', 'pilot')`;
  const { addMembership } = await import("../helpers");
  await testDb`insert into roles (tenant_id, key, name, description, is_system_default, cloned_from_template_id)
    select ${t.id}, rt.key, rt.name, rt.description, true, rt.id from role_templates rt where rt.key in ('SALON_MANAGER', 'STYLIST')`;
  const roles = await testDb<{ id: string; key: string }[]>`select id, key from roles where tenant_id = ${t.id} and key in ('SALON_MANAGER', 'STYLIST')`;
  for (const r of roles) {
    await testDb`insert into role_permissions (role_id, permission_id) select ${r.id}, permission_id from role_template_permissions rtp join role_templates rt on rt.id = rtp.role_template_id where rt.key = ${r.key}`;
  }
  await addMembership(t.id, u.yon!.id, roles.find((r) => r.key === "SALON_MANAGER")!.id);
  await addMembership(t.id, u.pers!.id, roles.find((r) => r.key === "STYLIST")!.id);
}, 300000);

afterAll(async () => {
  await testDb.begin(async (sql) => {
    await sql`alter table private.billing_enforcement_events disable trigger billing_enforcement_events_append_only`;
    await sql`alter table private.billing_preflight_runs disable trigger billing_preflight_runs_append_only`;
    await sql`delete from private.billing_enforcement_events`;
    await sql`delete from private.billing_preflight_runs`;
    await sql`alter table private.billing_enforcement_events enable trigger billing_enforcement_events_append_only`;
    await sql`alter table private.billing_preflight_runs enable trigger billing_preflight_runs_append_only`;
    await sql`delete from private.billing_decision_counters`;
    await sql`delete from private.billing_guard_health`;
    await sql`delete from private.billing_shadow_samples`;
    await sql`select set_config('salonos.enforcement_setter', 'on', true)`;
    await sql`select set_config('salonos.enforcement_event_written', 'on', true)`;
    await sql`update private.billing_enforcement_config set stage = 0, version = 1, stage_changed_at = now(), updated_by = null, last_event_id = null where id = 1`;
  });
  await cleanupTenants(tenantIds);
  await cleanupPlatformAdmins([u.padmin!.id, u.padmin2!.id, u.psupport!.id]);
  await cleanupUsers(userIds);
  await testDb.end();
}, 300000);

describe("HS initial state and the status read (real API)", () => {
  it("HS1 the hosted project starts at stage 0, version 1, with no events and no evidence rows", async () => {
    const c0 = await cfg();
    expect([c0.stage, c0.version]).toEqual([0, 1]);
    for (const t of ["billing_enforcement_events", "billing_preflight_runs", "billing_decision_counters", "billing_shadow_samples", "billing_guard_health"]) {
      expect((await testDb.unsafe(`select count(*)::int n from private.${t}`))[0]!.n, t).toBe(0);
    }
  });
  it("HS2 the status read answers a platform owner AND support with safe metadata only (no actor ids, no emails, no tokens)", async () => {
    for (const who of ["padmin", "psupport"]) {
      const r = await status(c[who]!);
      expect(r.error, who).toBeNull();
      expect(r.data).toMatchObject({ stage: 0, stageName: "OFF", version: 1 });
      expect(Object.keys(r.data!).sort()).toEqual(["counters", "lastEvents", "stage", "stageChangedAt", "stageName", "updatedAt", "version"]);
      const text = JSON.stringify(r.data);
      for (const l of Object.keys(u)) {
        expect(text).not.toContain(u[l]!.id);
        expect(text).not.toContain(u[l]!.email);
      }
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    }
  });
});

describe("HA authorization over real JWTs", () => {
  it("HA1 the platform OWNER is allowed (preflight); platform SUPPORT, tenant Owner, Yonetici, Personel, an outsider and a user_metadata forger are DENIED for the setter and the preflight", async () => {
    const c0 = await cfg();
    expect((await preflight(c.padmin!, 1)).error).toBeNull();
    expect((await preflight(c.padmin2!, 1)).error).toBeNull();
    for (const who of ["psupport", "towner", "yon", "pers", "outsider", "forger"]) {
      const a = await setStage(c[who]!, { target: 1, stage: 0, version: c0.version });
      expect(a.error, `set ${who}`).toMatch(/platform owner required/);
      const b = await preflight(c[who]!, 1);
      expect(b.error, `preflight ${who}`).toMatch(/platform owner required/);
    }
    // the status read needs a platform admin (support is one: it may READ, never change)
    for (const who of ["towner", "yon", "pers", "outsider", "forger"]) expect((await status(c[who]!)).error, `status ${who}`).toMatch(/platform admin required/);
    expect((await cfg()).stage).toBe(0);
  });
  it("HA2 anon and service_role are denied by privilege (42501) on all three functions", async () => {
    const anon = anonClient();
    const c0 = await cfg();
    for (const [name, client] of [["anon", anon], ["service_role", admin]] as [string, { rpc: Client["rpc"] }][]) {
      for (const r of [
        await setStage(client as Client, { target: 1, stage: 0, version: c0.version }),
        await preflight(client as Client, 1),
        await status(client as Client),
      ]) {
        expect(r.code, name).toBe("42501");
        expect(r.error, name).toMatch(/permission denied/);
      }
    }
  });
  it("HA3 the setter validates its inputs: reason, request id, expected stage, expected version, preflight hash (upward) are all required", async () => {
    const c0 = await cfg();
    const base = { target: 1, stage: 0, version: c0.version };
    expect((await setStage(c.padmin!, { ...base, reason: "short" })).error).toMatch(/reason_required/);
    expect((await setStage(c.padmin!, { ...base, reason: null })).error).toMatch(/reason_required/);
    expect((await setStage(c.padmin!, { ...base, rid: null })).error).toMatch(/request_id_required/);
    expect((await setStage(c.padmin!, { target: 9, stage: 0, version: c0.version })).error).toMatch(/invalid_target_stage/);
    const noStage = await rpc(c.padmin!, "admin_set_billing_enforcement_stage", { p_target_stage: 1, p_expected_stage: null, p_expected_version: c0.version, p_reason: "a long enough reason", p_request_id: rid(), p_preflight_hash: null });
    expect(noStage.error).toMatch(/expected_state_required/);
    const noVer = await rpc(c.padmin!, "admin_set_billing_enforcement_stage", { p_target_stage: 1, p_expected_stage: 0, p_expected_version: null, p_reason: "a long enough reason", p_request_id: rid(), p_preflight_hash: null });
    expect(noVer.error).toMatch(/expected_state_required/);
    expect((await setStage(c.padmin!, base)).data).toEqual({ ok: false, error: "preflight_required" });
    expect((await cfg()).stage).toBe(0);
  });
});

describe("HP preflight", () => {
  it("HP1 a healthy synthetic state passes all 16 checks; the result is deterministic (same state, same hash) and records an append-only run", async () => {
    await operatorSet(0);
    const a = await preflight(c.padmin!, 1, null, "06105a7");
    const b = await preflight(c.padmin!, 1, null, "06105a7");
    expect(a.error).toBeNull();
    expect(a.data!.passed, JSON.stringify((a.data!.checks as Loose[]).filter((x) => !x.pass))).toBe(true);
    // Faz SAAS.1C.2c-A2 adds exactly one check (hook_coverage), same as the committed local test
    expect((a.data!.checks as Loose[]).length).toBe(17);
    expect((a.data!.checks as Loose[]).map((x) => x.id)).toContain("hook_coverage");
    expect(b.data!.hash).toBe(a.data!.hash);
    expect(a.data!.runId).not.toBe(b.data!.runId);
    expect((await testDb`select count(*)::int n from private.billing_preflight_runs where result_hash = ${a.data!.hash as string}`)[0]!.n).toBe(2);
    expect((await preflight(c.padmin!, 1, null, "not a sha")).error).toMatch(/invalid_app_sha/);
  });
  it("HP2 every malformed synthetic state fails its OWN check with a structured result, and an upward change is refused while it exists (downward is not)", async () => {
    const shapes: [string, string, Fx][] = [
      ["trial_grace_boundary", "trial with no required grace boundary", { status: "trialing", mode: "paid", trialStarted: inDays(-3), trialEnds: inDays(20), grace: null }],
      ["past_due_bounded", "unbounded / open past_due", { status: "past_due", mode: "paid" }],
      ["status_mode_shape", "invalid status combination (pilot past_due)", { status: "past_due", mode: "pilot", grace: inDays(5) }],
      ["status_mode_shape", "paid active without a period end", { status: "active", mode: "paid" }],
      ["status_mode_shape", "canceled without a period end", { status: "canceled", mode: "paid" }],
      ["dates_wellformed", "malformed period dates", { status: "active", mode: "paid", periodStart: inDays(10), periodEnd: inDays(-10) }],
    ];
    for (const [id, label, fx] of shapes) {
      const t = await mk("pf2", fx);
      const r = await core(1);
      expect(checkOf(r, id).pass, label).toBe(false);
      expect(r.passed, label).toBe(false);
      await operatorSet(0, 40);
      const c0 = await cfg();
      const pf = await preflight(c.padmin!, 1);
      expect(pf.data!.passed, label).toBe(false);
      expect(pf.data!.checks.find((x: Loose) => x.id === id).pass, `${label} via API`).toBe(false);
      expect((await setStage(c.padmin!, { target: 1, stage: 0, version: c0.version, hash: pf.data!.hash as string })).data, label).toEqual({ ok: false, error: "preflight_failed" });
      await operatorSet(2, 40);
      const c2 = await cfg();
      expect((await setStage(c.padmin!, { target: 0, stage: 2, version: c2.version })).data, label).toMatchObject({ ok: true, stage: 0 });
      await dropSub(t);
    }
    // malformed trial dates are refused by a table constraint; with the constraint dropped inside a rolled-back transaction the preflight still catches them
    const tm = await mk("pf2-trial", MODE.grace);
    expect(
      await sandbox(async (sql) => {
        await sql`alter table subscriptions drop constraint subscriptions_trial_dates_consistent`;
        await sql`update subscriptions set trial_ends_at = trial_started_at - interval '10 days' where tenant_id = ${tm}`;
        const res = (await sql`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
        if (checkOf(res, "dates_wellformed").pass) throw new Error("dates_wellformed should have failed");
      }),
    ).toBe("ROLLBACK_OK");
    // a tenant with no subscription at all
    const missing = await mk("pf2-missing", { noSub: true });
    expect(checkOf(await core(1), "subscription_relationship").pass).toBe(false);
    await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode) values (${missing}, ${await planId()}, 'active', 'pilot')`;
    // access-state resolution failure (the real function made to return null inside a rolled-back transaction) and unknown status values
    expect(
      await sandbox(async (sql) => {
        await sql`create or replace function private.tenant_access_state(p_tenant_id uuid) returns jsonb language sql stable as $f$ select null::jsonb $f$`;
        const res = (await sql`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
        if (checkOf(res, "access_state_resolves").pass) throw new Error("access_state_resolves should have failed");
      }),
    ).toBe("ROLLBACK_OK");
    expect(
      await sandbox(async (sql) => {
        await sql`alter table subscriptions drop constraint subscriptions_status_check`;
        await sql`update subscriptions set status = 'weird' where tenant_id = ${missing}`;
        const res = (await sql`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
        if (checkOf(res, "status_values_known").pass) throw new Error("status_values_known should have failed");
      }),
    ).toBe("ROLLBACK_OK");
    // registry incompleteness (a new exposed write function that is not registered)
    expect(
      await sandbox(async (sql) => {
        await sql`create function public.zz_h_a1_probe() returns void language plpgsql security definer set search_path = '' as $f$ begin update public.customers set full_name = full_name where false; end $f$`;
        await sql`grant execute on function public.zz_h_a1_probe() to authenticated`;
        const res = (await sql`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
        if (checkOf(res, "registry_complete").pass || res.passed) throw new Error("registry_complete should have failed");
      }),
    ).toBe("ROLLBACK_OK");
    await operatorSet(0);
    const clean = await preflight(c.padmin!, 1);
    expect(clean.data!.passed, JSON.stringify((clean.data!.checks as Loose[]).filter((x) => !x.pass))).toBe(true);
  });
});

describe("HB preflight hash binding (the externally observable equivalence of the two local survivors)", () => {
  it("HB1 the hash changes with the target stage, the config version, the operator context and the relevant invariant state", async () => {
    await operatorSet(1, 40);
    const p1 = await preflight(c.padmin!, 2);
    const p2 = await preflight(c.padmin!, 3);
    expect(p1.data!.hash).not.toBe(p2.data!.hash);
    const pEp = await preflight(c.padmin!, 2, 99);
    expect(pEp.data!.hash).not.toBe(p1.data!.hash);
    await operatorSet(1, 40); // the config version moves, the verdicts do not
    const p3 = await preflight(c.padmin!, 2);
    expect(p3.data!.hash).not.toBe(p1.data!.hash);
    const bad = await mk("hb1", { status: "past_due", mode: "paid" });
    const p4 = await preflight(c.padmin!, 2);
    expect(p4.data!.hash).not.toBe(p3.data!.hash);
    await dropSub(bad);
    expect((await preflight(c.padmin!, 2)).data!.hash).toBe(p3.data!.hash); // state restored: same verdicts, same hash
  });
  it("HB2 a previously issued preflight is unusable after the TARGET changes (hash of another target) or the CONFIG VERSION moves, and when it is older than 15 minutes", async () => {
    // seed enough shadow evidence so a 1 -> 2 change is legal
    const t = await mk("hb2", MODE.full);
    await operatorSet(1, 20);
    await seedDecisions(1, 300, t);
    let c0 = await cfg();
    const pf2 = await preflight(c.padmin!, 2);
    expect(pf2.data!.passed, JSON.stringify((pf2.data!.checks as Loose[]).filter((x) => !x.pass))).toBe(true);
    // (a) used for another target
    const pf3 = await preflight(c.padmin!, 3);
    expect((await setStage(c.padmin!, { target: 2, stage: 1, version: c0.version, hash: pf3.data!.hash as string })).data).toEqual({ ok: false, error: "preflight_stale" });
    // (b) the config version moved after it was issued
    await operatorSet(1, 20);
    c0 = await cfg();
    expect((await setStage(c.padmin!, { target: 2, stage: 1, version: c0.version, hash: pf2.data!.hash as string })).data).toEqual({ ok: false, error: "preflight_stale" });
    // (c) older than 15 minutes
    const fresh = await preflight(c.padmin!, 2);
    await testDb.begin(async (sql) => {
      await sql`alter table private.billing_preflight_runs disable trigger billing_preflight_runs_append_only`;
      await sql`update private.billing_preflight_runs set at = now() - interval '16 minutes' where result_hash = ${fresh.data!.hash as string}`;
      await sql`alter table private.billing_preflight_runs enable trigger billing_preflight_runs_append_only`;
    });
    expect((await setStage(c.padmin!, { target: 2, stage: 1, version: c0.version, hash: fresh.data!.hash as string })).data).toEqual({ ok: false, error: "preflight_stale" });
    // (d) the world changed after the run
    const ok = await preflight(c.padmin!, 2);
    const bad = await mk("hb2-bad", { status: "past_due", mode: "paid" });
    expect((await setStage(c.padmin!, { target: 2, stage: 1, version: c0.version, hash: ok.data!.hash as string })).data).toEqual({ ok: false, error: "preflight_stale" });
    await dropSub(bad);
    // (e) another actor cannot use it
    const mine = await preflight(c.padmin!, 2);
    expect((await setStage(c.padmin2!, { target: 2, stage: 1, version: c0.version, hash: mine.data!.hash as string })).data).toEqual({ ok: false, error: "preflight_stale" });
    // and the legitimate use still works
    expect((await setStage(c.padmin!, { target: 2, stage: 1, version: c0.version, hash: mine.data!.hash as string })).data).toMatchObject({ ok: true, stage: 2 });
    await testDb`delete from private.billing_decision_counters`;
    await operatorSet(0);
  });
});

describe("HM protection model and precedence (decision function on the hosted database)", () => {
  const eff = async (t: string): Promise<Loose> => (await testDb`select private.billing_effective_access(${t}) as r`)[0]!.r as Loose;
  const dec = async (t: string, cat: string, stage: number): Promise<Loose> => (await testDb`select private.billing_decide(${t}, ${cat}, ${stage}::smallint) as r`)[0]!.r as Loose;
  it("HM1 protected + normal / grace / read_only / expired / past_due / canceled / suspended / tenant canceled = full + ALLOW in every category and stage; the raw state stays visible", async () => {
    const states: [string, Fx][] = [
      ["normal", { ...MODE.full, prot: true }], ["grace", { ...MODE.grace, prot: true }], ["read_only", { ...MODE.read_only, prot: true }],
      ["expired", { status: "expired", mode: "pilot", prot: true }], ["past_due", { status: "past_due", mode: "pilot", grace: inDays(-3), prot: true }],
      ["canceled", { status: "canceled", mode: "pilot", periodEnd: inDays(-3), prot: true }],
      ["suspended", { status: "active", mode: "pilot", prot: true, tenantStatus: "suspended" }], ["tenant_canceled", { status: "active", mode: "pilot", prot: true, tenantStatus: "canceled" }],
    ];
    const made: string[] = [];
    for (const [label, fx] of states) {
      const t = await mk("hm1", fx);
      made.push(t);
      expect(await eff(t), label).toMatchObject({ mode: "full", reason: "protected", protected: true, deleted: false, precedence: "protected" });
      for (const cat of registry.categories.map((x) => x.category)) {
        for (const stage of [1, 2, 3, 4]) {
          const d = await dec(t, cat, stage);
          expect(d.decision, `${label} ${cat} s${stage}`).toBe("allow");
          expect(d.enforced).toBe(false);
        }
      }
    }
    // these fixtures are deliberately odd shapes (protected pilot past_due, expired...): they must not poison the global preflight of later tests
    await cleanupTenants(made);
    for (const id of made) tenantIds.splice(tenantIds.indexOf(id), 1);
  });
  it("HM2 DELETION overrides protection (a deleted protected tenant is BLOCKED); removing protection from a lapsed tenant applies the commercial state; tenant lifecycle safety is not weakened", async () => {
    const d = await mk("hm2d", { ...MODE.full, prot: true, deleted: true });
    expect(await eff(d)).toMatchObject({ mode: "blocked", reason: "tenant_deleted", protected: true, deleted: true, precedence: "deleted" });
    expect((await dec(d, "APPT_CREATE", 4)).decision).toBe("blocked");
    const s = await mk("hm2s", MODE.blocked);
    expect(await eff(s)).toMatchObject({ mode: "blocked", reason: "suspended_by_platform", precedence: "access_state" });
    const l = await mk("hm2l", { ...MODE.read_only, prot: true });
    expect((await eff(l)).mode).toBe("full");
    await testDb`update subscriptions set protected = false where tenant_id = ${l}`;
    expect(await eff(l)).toMatchObject({ mode: "read_only", reason: "trial_expired", protected: false });
    // the existing lifecycle guard still refuses a tenant owner's attempt to un-suspend through the real API
    const r = await c.towner!.from("tenants").update({ status: "active" } as never).eq("id", s).select();
    expect(r.error?.code).toBe("42501");
  });
  it("HM3 unprotected: read_only blocks growth categories only from stage 2+, blocked is Owner-locked at stage 4, export / self-cancel / hygiene stay allowed", async () => {
    const ro = await mk("hm3r", MODE.read_only);
    const bl = await mk("hm3b", MODE.blocked);
    expect((await dec(ro, "APPT_CREATE", 0)).decision).toBe("allow");
    expect((await dec(ro, "APPT_CREATE", 1)).decision).toBe("would_block");
    expect((await dec(ro, "PUBLIC_BOOKING_CREATE", 2))).toMatchObject({ decision: "blocked", code: "BL003" });
    expect((await dec(ro, "CATALOG_CREATE", 4))).toMatchObject({ decision: "blocked", code: "BL001" });
    expect((await dec(bl, "APPT_CREATE", 4))).toMatchObject({ decision: "blocked", code: "BL002" });
    for (const cat of ["EXPORT", "CUSTOMER_SELF_SERVICE_CANCEL", "SYSTEM_HYGIENE", "PLATFORM_ADMIN", "PERSONAL_PREFS"]) {
      for (const t of [ro, bl]) expect((await dec(t, cat, 4)).decision, cat).toBe("allow");
    }
  });
});

describe("HZ stage 0 is inert (nothing records, nothing blocks)", () => {
  it("HZ1 real application writes as a tenant Owner over the Data API (customer insert / update, salon profile RPC, the unchanged DELETE denial) leave ZERO decision / sample / health rows and the stage at 0", async () => {
    await operatorSet(0);
    const t = await mk("hz1", MODE.read_only); // even a lapsed tenant: stage 0 never decides
    const { addMembership } = await import("../helpers");
    void addMembership;
    const own = await createTestTenant(`h-a1-${RUN}-hz1o-${++seq}`, u.towner!.id);
    tenantIds.push(own.id);
    await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode) values (${own.id}, ${await planId()}, 'active', 'pilot')`;
    const cus = await c.towner!.from("customers").insert({ tenant_id: own.id, full_name: "Hosted Stage0 Customer" } as never).select().single();
    expect(cus.error).toBeNull();
    const upd = await c.towner!.from("customers").update({ full_name: "Hosted Stage0 Customer 2" }).eq("id", (cus.data as Loose).id).select();
    expect(upd.error).toBeNull();
    const prof = await c.towner!.rpc("update_salon_profile" as never, { p_tenant_id: own.id, p_name: "Hosted Stage0 Profile", p_timezone: "Europe/Nicosia", p_currency: "TRY", p_phone: "+905550000000", p_address: null } as never);
    expect(prof.error).toBeNull();
    // customers are not deletable through the API (no DELETE grant): the denial itself is unchanged by A1
    expect((await c.towner!.from("customers").delete().eq("id", (cus.data as Loose).id).select()).error?.code).toBe("42501");
    // the lapsed tenant: the decision model answers allow / stage_off for every growth category
    for (const cat of ["PUBLIC_BOOKING_CREATE", "APPT_CREATE", "CUSTOMER_CREATE_IMPORT", "CATALOG_CREATE", "FINANCE_SETTLE", "TEAM_GROWTH"]) {
      const d = (await testDb`select private.billing_decide(${t}, ${cat}) as r`)[0]!.r as Loose;
      expect(d, cat).toMatchObject({ decision: "allow", reason: "stage_off", enforced: false });
    }
    for (const tbl of ["billing_decision_counters", "billing_shadow_samples", "billing_guard_health"]) {
      expect((await testDb.unsafe(`select count(*)::int n from private.${tbl}`))[0]!.n, tbl).toBe(0);
    }
    expect((await cfg()).stage).toBe(0);
  });
  it("HZ2 no existing function references any A1 object and no public trigger calls one (nothing is hooked into a write path)", async () => {
    const needles = ["billing_stage", "billing_decide", "billing_effective_access", "billing_preflight_core", "billing_enforcement_config", "billing_decision_counters", "billing_shadow_samples", "billing_guard_health", "billing_action_registry", "billing_categories", "billing_enforcement_counters", "billing_registry_unregistered", "billing_enforcement_events"];
    const own = new Set(["billing_stage", "billing_effective_access", "billing_decide", "billing_enforcement_counters", "billing_registry_unregistered", "billing_check", "billing_preflight_core", "billing_enforcement_refuse", "billing_enforcement_append_only", "billing_enforcement_config_guard", "billing_enforcement_config_audit", "admin_billing_enforcement_status", "admin_billing_enforcement_preflight", "admin_set_billing_enforcement_stage"]);
    const rows = await testDb<{ proname: string; src: string }[]>`select p.proname, pg_get_functiondef(p.oid) src from pg_proc p where p.prokind = 'f' and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)`;
    expect(rows.length).toBeGreaterThan(500);
    // Faz SAAS.1C.2c-A2 adds these private helpers; an existing function may reference the foundation ONLY through its one marked hook line (proved exactly by the A2 catalog suite)
    for (const h of ["billing_scope_tenant", "billing_health_bump", "billing_decision_record", "billing_guard", "billing_public_booking_open", "billing_hook_coverage", "billing_trigger_guard"]) own.add(h);
    const unhooked = (src: string) => src.replace(/[^\n]*-- a2-billing-hook[^\n]*\n?/g, "");
    expect(rows.filter((r) => !own.has(r.proname) && needles.some((n) => unhooked(r.src).includes(n))).map((r) => r.proname)).toEqual([]);
    const trg = await testDb<{ f: string }[]>`select p.proname f from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal`;
    expect(trg.filter((x) => /billing_(stage|decide|effective|preflight|enforcement)/.test(x.f))).toEqual([]);
  });
});

describe("HT stage transitions over the real API", () => {
  it("HT1 0->1 allowed with a valid preflight; 0->2 and 0->4 denied; 1->2 needs the shadow acceptance (14 days AND 300 decisions) and is then allowed; 2->4 denied; 2->3->4 step by step; 4->2 and 4->0 immediate", async () => {
    await operatorSet(0, 40);
    const t = await mk("ht1", MODE.full);
    let c0 = await cfg();
    const pf1 = await preflight(c.padmin!, 1);
    expect((await setStage(c.padmin!, { target: 2, stage: 0, version: c0.version, hash: (await preflight(c.padmin!, 2)).data!.hash as string })).data).toEqual({ ok: false, error: "multi_step_denied" });
    expect((await setStage(c.padmin!, { target: 4, stage: 0, version: c0.version, hash: pf1.data!.hash as string })).data).toEqual({ ok: false, error: "multi_step_denied" });
    const r01 = await setStage(c.padmin!, { target: 1, stage: 0, version: c0.version, hash: pf1.data!.hash as string });
    expect(r01.data).toMatchObject({ ok: true, replayed: false, fromStage: 0, stage: 1, version: c0.version + 1 });
    c0 = await cfg();
    // 1 -> 2: not yet (0 decisions / not 14 days)
    const early = await preflight(c.padmin!, 2);
    expect(checkOf(early.data!, "stage_requirements").pass).toBe(false);
    expect((await setStage(c.padmin!, { target: 2, stage: 1, version: c0.version, hash: early.data!.hash as string })).data).toEqual({ ok: false, error: "preflight_failed" });
    // days but not decisions, decisions but not days
    await operatorSet(1, 20);
    expect(checkOf(await core(2), "stage_requirements").pass).toBe(false);
    await seedDecisions(1, 299, t);
    expect(checkOf(await core(2), "stage_requirements").pass).toBe(false);
    await testDb`update private.billing_decision_counters set n = 300 where tenant_id = ${t}`;
    await operatorSet(1, 5);
    expect(checkOf(await core(2), "stage_requirements").pass).toBe(false);
    await operatorSet(1, 20);
    c0 = await cfg();
    const pf2 = await preflight(c.padmin!, 2);
    expect(pf2.data!.passed).toBe(true);
    expect((await setStage(c.padmin!, { target: 2, stage: 1, version: c0.version, hash: pf2.data!.hash as string })).data).toMatchObject({ ok: true, stage: 2 });
    c0 = await cfg();
    expect((await setStage(c.padmin!, { target: 4, stage: 2, version: c0.version, hash: (await preflight(c.padmin!, 4)).data!.hash as string })).data).toEqual({ ok: false, error: "multi_step_denied" });
    await operatorSet(2, 20);
    c0 = await cfg();
    expect((await setStage(c.padmin!, { target: 3, stage: 2, version: c0.version, hash: (await preflight(c.padmin!, 3)).data!.hash as string })).data).toMatchObject({ ok: true, stage: 3 });
    await operatorSet(3, 40);
    c0 = await cfg();
    expect((await setStage(c.padmin!, { target: 4, stage: 3, version: c0.version, hash: (await preflight(c.padmin!, 4)).data!.hash as string })).data).toMatchObject({ ok: true, stage: 4 });
    c0 = await cfg();
    expect((await setStage(c.padmin!, { target: 2, stage: 4, version: c0.version })).data).toMatchObject({ ok: true, stage: 2 }); // downward, no preflight
    await operatorSet(4, 0);
    c0 = await cfg();
    expect((await setStage(c.padmin!, { target: 0, stage: 4, version: c0.version, reason: "emergency rollback to stage zero" })).data).toMatchObject({ ok: true, stage: 0 });
    await testDb`delete from private.billing_decision_counters`;
  });
  it("HT2 stale expected stage / stale expected version / no-op are refused and audited; nothing changes", async () => {
    await operatorSet(1, 40);
    const c0 = await cfg();
    const n = (await events()).length;
    expect((await setStage(c.padmin!, { target: 0, stage: 2, version: c0.version })).data).toEqual({ ok: false, error: "stale_stage" });
    expect((await setStage(c.padmin!, { target: 0, stage: 1, version: c0.version - 1 })).data).toEqual({ ok: false, error: "stale_version" });
    expect((await setStage(c.padmin!, { target: 0, stage: 1, version: c0.version + 3 })).data).toEqual({ ok: false, error: "stale_version" });
    expect((await setStage(c.padmin!, { target: 1, stage: 1, version: c0.version })).data).toEqual({ ok: false, error: "no_change" });
    expect((await events()).slice(n).map((e) => `${e.event}:${e.error_code}`)).toEqual(["refused:stale_stage", "refused:stale_version", "refused:stale_version", "refused:no_change"]);
    expect((await cfg()).stage).toBe(1);
    await operatorSet(0);
  });
});

describe("HI idempotency", () => {
  it("HI1 same request id + same payload returns the ORIGINAL result with no second audit row; same id + different payload is a conflict", async () => {
    await operatorSet(0, 40);
    const c0 = await cfg();
    const r = rid();
    const pf = await preflight(c.padmin!, 1);
    const a = { target: 1, stage: 0, version: c0.version, rid: r, hash: pf.data!.hash as string };
    const first = await setStage(c.padmin!, a);
    expect(first.data, JSON.stringify(first)).toMatchObject({ ok: true, replayed: false });
    const again = await setStage(c.padmin!, a);
    expect(again.data).toMatchObject({ ok: true, replayed: true, eventId: first.data!.eventId, stage: 1, version: first.data!.version });
    expect((await cfg()).version).toBe(first.data!.version);
    expect((await setStage(c.padmin!, { ...a, target: 0, reason: "a different payload entirely" })).data).toEqual({ ok: false, error: "request_id_conflict" });
    expect((await testDb`select count(*)::int n from private.billing_enforcement_events where request_id = ${r} and event = 'stage_change'`)[0]!.n).toBe(1);
    await operatorSet(0);
  });
});

describe("HC concurrency (real parallel HTTP)", () => {
  it("HC1 eight parallel setters (two platform owners) on the same expected version: exactly one wins, the rest are stale; one event; version +1", async () => {
    await operatorSet(4, 40);
    const c0 = await cfg();
    const before = (await events()).filter((e) => e.event === "stage_change").length;
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => setStage(i % 2 ? c.padmin! : c.padmin2!, { target: i % 4, stage: 4, version: c0.version, reason: `parallel attempt number ${i}` })));
    expect(rs.filter((r) => r.data?.ok).length).toBe(1);
    for (const r of rs.filter((x) => !x.data?.ok)) expect(["stale_stage", "stale_version"]).toContain(r.data!.error);
    expect((await cfg()).version).toBe(c0.version + 1);
    expect((await events()).filter((e) => e.event === "stage_change").length).toBe(before + 1);
    await operatorSet(0);
  });
  it("HC2 five parallel retries of the SAME request: one change, the rest replays; no duplicate audit", async () => {
    await operatorSet(3, 40);
    const c0 = await cfg();
    const r = rid();
    const rs = await Promise.all(Array.from({ length: 5 }, () => setStage(c.padmin!, { target: 0, stage: 3, version: c0.version, rid: r, reason: "same payload parallel" })));
    expect(rs.every((x) => x.data?.ok)).toBe(true);
    expect(rs.filter((x) => x.data!.replayed === false).length).toBe(1);
    expect((await cfg()).version).toBe(c0.version + 1);
    expect((await testDb`select count(*)::int n from private.billing_enforcement_events where request_id = ${r} and event = 'stage_change'`)[0]!.n).toBe(1);
  });
  it("HC3 simultaneous 0->1 and 0->2 (each with its own valid preflight): 0->2 can NEVER sneak through, whatever the order", async () => {
    for (let round = 0; round < 3; round++) {
      await operatorSet(0, 40);
      const c0 = await cfg();
      const p1 = await preflight(c.padmin!, 1);
      const p2 = await preflight(c.padmin2!, 2);
      const [a, b] = await Promise.all([
        setStage(c.padmin!, { target: 1, stage: 0, version: c0.version, hash: p1.data!.hash as string }),
        setStage(c.padmin2!, { target: 2, stage: 0, version: c0.version, hash: p2.data!.hash as string }),
      ]);
      expect(a.data!.ok, `round ${round}`).toBe(true);
      expect(b.data!.ok, `round ${round}`).toBe(false);
      expect((await cfg()).stage).toBe(1);
      expect((await cfg()).version).toBe(c0.version + 1);
    }
    await operatorSet(0);
  });
  it("HC4 simultaneous downward and upward from the same state: exactly one applies, deterministic safe outcome, coherent version and audit", async () => {
    for (let round = 0; round < 3; round++) {
      await operatorSet(2, 40);
      const t = await mk("hc4", MODE.full);
      await seedDecisions(2, 10, t);
      const c0 = await cfg();
      const up = await preflight(c.padmin!, 3);
      const before = (await events()).filter((e) => e.event === "stage_change").length;
      const [d, uu] = await Promise.all([
        setStage(c.padmin2!, { target: 1, stage: 2, version: c0.version, reason: "emergency downward during an upward attempt" }),
        setStage(c.padmin!, { target: 3, stage: 2, version: c0.version, hash: up.data!.hash as string }),
      ]);
      const wins = [d, uu].filter((x) => x.data?.ok).length;
      expect(wins, `round ${round}`).toBe(1);
      const loser = [d, uu].find((x) => !x.data?.ok)!;
      expect(["stale_stage", "stale_version", "preflight_stale"]).toContain(loser.data!.error);
      expect((await cfg()).version).toBe(c0.version + 1);
      expect((await events()).filter((e) => e.event === "stage_change").length).toBe(before + 1);
      expect([1, 3]).toContain((await cfg()).stage);
      await testDb`delete from private.billing_decision_counters`;
    }
    await operatorSet(0);
  });
});

describe("HE audit trail", () => {
  it("HE1 a change stores exactly the approved fields; no PII columns; the actor is the real platform owner", async () => {
    await operatorSet(0, 40);
    const c0 = await cfg();
    const r = rid();
    const pf = await preflight(c.padmin!, 1);
    await setStage(c.padmin!, { target: 1, stage: 0, version: c0.version, rid: r, reason: "audit contents check ok", hash: pf.data!.hash as string });
    const [e] = await testDb<Loose[]>`select * from private.billing_enforcement_events where request_id = ${r}`;
    expect(e).toMatchObject({ event: "stage_change", actor_id: u.padmin!.id, from_stage: 0, to_stage: 1, reason: "audit contents check ok", version_before: c0.version, version_after: c0.version + 1, preflight_hash: pf.data!.hash });
    expect(e!.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e!.at).toBeTruthy();
    const cols = (await testDb<{ column_name: string }[]>`select column_name from information_schema.columns where table_schema = 'private' and table_name in ('billing_enforcement_events', 'billing_preflight_runs', 'billing_decision_counters', 'billing_shadow_samples', 'billing_guard_health')`).map((x) => x.column_name);
    for (const col of cols) expect(col, col).not.toMatch(/name|email|phone|note|payload|body|address|token/i);
    const runs = await testDb<Loose[]>`select summary from private.billing_preflight_runs limit 5`;
    expect(JSON.stringify(runs)).not.toContain(u.padmin!.email);
    await operatorSet(0);
  });
  it("HE2 append-only: UPDATE / DELETE / TRUNCATE are refused even for the operator login; API roles cannot INSERT or touch the tables (privilege layer)", async () => {
    for (const t of ["billing_enforcement_events", "billing_preflight_runs"]) {
      for (const q of [`update private.${t} set at = now() where id = (select min(id) from private.${t})`, `delete from private.${t} where id = (select min(id) from private.${t})`, `truncate private.${t}`]) {
        expect((await testDb.unsafe(q).then(() => "ok", (e: Error) => e.message)), q).toMatch(/append-only/);
      }
    }
    for (const role of ["authenticated", "service_role", "anon"]) {
      for (const q of [
        `insert into private.billing_enforcement_events (event, actor_id, request_id, request_hash, version_before, version_after, reason, from_stage, to_stage) values ('stage_change', '${u.padmin!.id}', '${rid()}', 'x', 1, 2, 'forged', 0, 1)`,
        `update private.billing_enforcement_events set reason = 'x'`, `delete from private.billing_enforcement_events`,
        `update private.billing_enforcement_config set stage = 4`, `insert into private.billing_decision_counters (day, tenant_id, stage, category, action_key, mode, decision, reason, n, config_version) values (now()::date, '${rid()}', 1, 'EXPORT', 'x', 'full', 'allow', 'x', 1, 1)`,
      ]) {
        let msg = "__no_error__";
        try {
          await testDb.begin(async (sql) => {
            await sql.unsafe(`set local role ${role}`);
            await sql.unsafe(q);
          });
        } catch (e) {
          msg = (e as Error).message;
        }
        expect(msg, `${role}: ${q.slice(0, 60)}`).toMatch(/permission denied|must be owner/);
      }
    }
    // through the REAL Data API the private schema is simply not reachable
    for (const client of [c.padmin!, admin as unknown as Client]) {
      const r = await (client as Client).from("billing_enforcement_events" as never).select("*");
      expect(r.error).not.toBeNull();
    }
    const r2 = await (admin as unknown as Client).from("billing_enforcement_config" as never).update({ stage: 4 } as never).eq("id", 1);
    expect(r2.error).not.toBeNull();
    expect((await cfg()).stage).toBe(0);
  });
  it("HE3 the config cannot be changed except through the setter (even an operator needs the deliberate marker, which audits itself)", async () => {
    const n = (await events()).length;
    expect(await testDb`update private.billing_enforcement_config set stage = 2`.then(() => "ok", (e: Error) => e.message)).toMatch(/only through admin_set_billing_enforcement_stage/);
    expect(await testDb`delete from private.billing_enforcement_config`.then(() => "ok", (e: Error) => e.message)).toMatch(/singleton/);
    await operatorSet(0);
    const rows = (await events()).slice(n);
    expect(rows.at(-1)).toMatchObject({ event: "stage_change", request_hash: "direct", reason: "direct operator change without the setter" });
  });
});

describe("HR registry completeness against the hosted catalog", () => {
  it("HR1 the registry equals the fixture; the hosted catalog has exactly the registered write surface (75 + 2 functions, 22 table operations on 12 tables) and nothing unregistered", async () => {
    const fn = registry.actions.filter((x) => x.kind === "function");
    const tb = registry.actions.filter((x) => x.kind === "table_op");
    expect([fn.length, tb.length, new Set(tb.map((x) => x.action_key.split(":")[1])).size]).toEqual([77, 22, 12]);
    const a = await testDb<Loose[]>`select action_key, kind, category from private.billing_action_registry order by action_key`;
    expect(a.map((x) => ({ ...x }))).toEqual(registry.actions.map((x) => ({ action_key: x.action_key, kind: x.kind, category: x.category })).sort((p, q) => (p.action_key < q.action_key ? -1 : 1)));
    expect(await testDb`select action_key from private.billing_registry_unregistered()`).toEqual([]);
    expect((await testDb`select count(*)::int n from private.billing_categories`)[0]!.n).toBe(registry.categories.length);
  });
  it("HR2 A: a new unregistered API write function is detected (and a write reached through a helper); registering it clears the finding", async () => {
    expect(
      await sandbox(async (sql) => {
        await sql`create function public.zz_h_a1_probe() returns void language plpgsql security definer set search_path = '' as $f$ begin update public.customers set full_name = full_name where false; end $f$`;
        await sql`grant execute on function public.zz_h_a1_probe() to authenticated`;
        const un = (await sql<{ action_key: string }[]>`select action_key from private.billing_registry_unregistered()`).map((x) => x.action_key);
        if (!un.includes("fn:zz_h_a1_probe")) throw new Error("NOT_DETECTED " + JSON.stringify(un));
        await sql`create function private.zz_h_inner() returns void language plpgsql security definer set search_path = '' as $f$ begin delete from public.staff_services where false; end $f$`;
        await sql`create function public.zz_h_outer() returns void language plpgsql security definer set search_path = '' as $f$ begin perform private.zz_h_inner(); end $f$`;
        await sql`grant execute on function public.zz_h_outer() to authenticated`;
        if (!(await sql<{ action_key: string }[]>`select action_key from private.billing_registry_unregistered()`).some((x) => x.action_key === "fn:zz_h_outer")) throw new Error("TRANSITIVE_NOT_DETECTED");
        await sql`insert into private.billing_action_registry (action_key, kind, category, enforcement_class, hooked, audience) values ('fn:zz_h_a1_probe', 'function', 'CUSTOMER_EDIT', 'EXISTING_RECORD_OPERATION', false, 'member'), ('fn:zz_h_outer', 'function', 'CUSTOMER_EDIT', 'EXISTING_RECORD_OPERATION', false, 'member')`;
        if ((await sql`select 1 from private.billing_registry_unregistered()`).length !== 0) throw new Error("STILL_FLAGGED");
      }),
    ).toBe("ROLLBACK_OK");
  });
  it("HR3 B: a new direct-write table (INSERT / UPDATE / DELETE grants to an API role) is detected", async () => {
    expect(
      await sandbox(async (sql) => {
        await sql`create table public.zz_h_probe (id int primary key)`;
        await sql`grant insert on public.zz_h_probe to authenticated`;
        await sql`grant update (id) on public.zz_h_probe to authenticated`;
        await sql`grant delete on public.zz_h_probe to authenticated`;
        const un = (await sql<{ action_key: string }[]>`select action_key from private.billing_registry_unregistered()`).map((x) => x.action_key);
        for (const k of ["table:zz_h_probe:INSERT", "table:zz_h_probe:UPDATE", "table:zz_h_probe:DELETE"]) if (!un.includes(k)) throw new Error("NOT_DETECTED " + k);
      }),
    ).toBe("ROLLBACK_OK");
  });
  it("HR4 C: a removed / renamed registered write path breaks registry_integrity AND exposes the new name as unregistered", async () => {
    expect(
      await sandbox(async (sql) => {
        const [f] = await sql<{ n: string; a: string }[]>`select p.proname n, pg_get_function_identity_arguments(p.oid) a from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (select substr(action_key, 4) from private.billing_action_registry where kind = 'function' and category = 'APPT_CREATE') order by 1 limit 1`;
        await sql.unsafe(`alter function public.${f!.n}(${f!.a}) rename to ${f!.n}_renamed`);
        const res = (await sql`select private.billing_preflight_core(1::smallint, null, null) as r`)[0]!.r as Loose;
        if (checkOf(res, "registry_integrity").pass) throw new Error("registry_integrity should have failed");
        if (checkOf(res, "registry_complete").pass) throw new Error("registry_complete should have failed");
      }),
    ).toBe("ROLLBACK_OK");
  });
  it("HR5 D: incorrect API role classification - a write function exposed to ANY API role (anon, service_role, PUBLIC) is detected; one exposed to none is not; read-only functions are not", async () => {
    expect(
      await sandbox(async (sql) => {
        for (const [name, role] of [["a", "anon"], ["s", "service_role"], ["p", "public"]] as const) {
          await sql.unsafe(`create function public.zz_h_${name}() returns void language plpgsql security definer set search_path = '' as $f$ begin delete from public.customers where false; end $f$`);
          await sql.unsafe(`revoke all on function public.zz_h_${name}() from public, anon, authenticated, service_role`);
          await sql.unsafe(`grant execute on function public.zz_h_${name}() to ${role}`);
        }
        await sql`create function public.zz_h_hidden() returns void language plpgsql security definer set search_path = '' as $f$ begin delete from public.customers where false; end $f$`;
        await sql`revoke all on function public.zz_h_hidden() from public, anon, authenticated, service_role`;
        await sql`create function public.zz_h_reader() returns int language sql stable security definer set search_path = '' as $f$ select count(*)::int from public.customers $f$`;
        await sql`grant execute on function public.zz_h_reader() to authenticated`;
        const un = (await sql<{ action_key: string }[]>`select action_key from private.billing_registry_unregistered()`).map((x) => x.action_key).sort();
        const want = ["fn:zz_h_a", "fn:zz_h_p", "fn:zz_h_s"];
        if (JSON.stringify(un) !== JSON.stringify(want)) throw new Error("CLASSIFICATION " + JSON.stringify(un));
      }),
    ).toBe("ROLLBACK_OK");
  });
});

describe("HV service_role cannot reach the control plane", () => {
  it("HV1 service_role holds no privilege on any A1 table and no EXECUTE on any A1 function (catalog), and the real service-role client is refused", async () => {
    const t = await testDb<Loose[]>`select c.relname, has_table_privilege('service_role', c.oid, 'select,insert,update,delete,truncate,references,trigger') p from pg_class c where c.relnamespace = 'private'::regnamespace and c.relname like 'billing\\_%' and c.relkind in ('r', 'S')`;
    expect(t.length).toBeGreaterThanOrEqual(12);
    for (const r of t) expect(r.p, r.relname).toBe(false);
    const f = await testDb<Loose[]>`select p.proname, has_function_privilege('service_role', p.oid, 'execute') x from pg_proc p where p.proname like '%billing\\_enforcement%' or p.proname in ('billing_stage', 'billing_decide', 'billing_effective_access', 'billing_preflight_core', 'billing_registry_unregistered', 'billing_check')`;
    expect(f.length).toBeGreaterThanOrEqual(14);
    for (const r of f) expect(r.x, r.proname).toBe(false);
    for (const fn of ["billing_decide", "billing_stage", "billing_preflight_core"]) {
      const r = await rpc(admin as unknown as Client, fn, {});
      expect(r.error, fn).not.toBeNull();
    }
    // there is no broad operator exemption either: only the deliberate marker, and only for the postgres login
    expect((await testDb`select count(*)::int n from pg_roles where rolname = 'service_role' and rolsuper`)[0]!.n).toBe(0);
  });
});

describe("HG catalog and grants (hosted)", () => {
  it("HG1 9 private tables, RLS on, no policy, no API privilege; 3 public RPCs SECURITY DEFINER with an empty search_path, authenticated only; 11 helpers closed to every API role", async () => {
    const t = await testDb<Loose[]>`select c.relname, c.relrowsecurity rls from pg_class c where c.relnamespace = 'private'::regnamespace and c.relkind = 'r' and c.relname like 'billing\\_%' order by 1`;
    expect(t.length).toBe(9);
    for (const r of t) expect(r.rls, r.relname).toBe(true);
    expect((await testDb`select count(*)::int n from pg_policies where schemaname = 'private' and tablename like 'billing\\_%'`)[0]!.n).toBe(0);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const r of t) expect((await testDb`select has_table_privilege(${role}, ${"private." + r.relname}, 'select,insert,update,delete,truncate,references,trigger') x`)[0]!.x, `${role} ${r.relname}`).toBe(false);
    }
    const pub = await testDb<Loose[]>`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s, has_function_privilege('public', p.oid, 'execute') pb
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_billing_enforcement_status', 'admin_billing_enforcement_preflight', 'admin_set_billing_enforcement_stage')`;
    expect(pub.length).toBe(3);
    for (const r of pub) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(JSON.stringify(r.proconfig), r.proname).toMatch(/search_path=/);
      expect([r.a, r.u, r.s, r.pb], r.proname).toEqual([false, true, false, false]);
    }
    const priv = await testDb<Loose[]>`select p.proname, p.proconfig, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s, has_function_privilege('public', p.oid, 'execute') pb
      from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname in ('billing_stage', 'billing_effective_access', 'billing_decide', 'billing_enforcement_counters', 'billing_registry_unregistered', 'billing_check', 'billing_preflight_core', 'billing_enforcement_refuse', 'billing_enforcement_append_only', 'billing_enforcement_config_guard', 'billing_enforcement_config_audit')`;
    expect(priv.length).toBe(11);
    for (const r of priv) {
      expect([r.a, r.u, r.s, r.pb], r.proname).toEqual([false, false, false, false]);
      expect(JSON.stringify(r.proconfig), r.proname).toMatch(/search_path=/);
    }
    const defs = await testDb<{ src: string }[]>`select pg_get_functiondef(p.oid) src from pg_proc p where p.proname like 'billing\\_%' or p.proname like 'admin\\_%billing\\_enforcement%' or p.proname = 'admin_set_billing_enforcement_stage'`;
    for (const d of defs) expect(d.src).not.toMatch(/user_metadata|raw_user_meta|app_metadata/i);
  });
  it("HG2 indexes cover the idempotency key, the preflight lookup, the audit time order and the counter read model", async () => {
    const idx = (await testDb<{ indexname: string }[]>`select indexname from pg_indexes where schemaname = 'private' and tablename like 'billing\\_%'`).map((x) => x.indexname);
    for (const i of ["billing_enforcement_events_request_uidx", "billing_enforcement_events_at_idx", "billing_preflight_runs_lookup_idx", "billing_decision_counters_stage_day_idx", "billing_shadow_samples_at_idx"]) expect(idx, i).toContain(i);
    const plan = (await testDb`explain select * from private.billing_enforcement_events where actor_id = ${rid()} and request_id = ${rid()} and event = 'stage_change'`).map((r) => Object.values(r)[0]).join("\n");
    expect(plan).toMatch(/Index|Seq Scan/); // an empty table may legitimately seq-scan; the unique index exists and is asserted above
  });
});

describe("HX the read model can represent every future decision kind (A1 itself generates none)", () => {
  it("HX1 allow / would_block / blocked / guard_error / unknown_category / policy_miss / protected_would_block are all representable and aggregated by stage; cleaned up afterwards", async () => {
    await testDb`delete from private.billing_decision_counters`;
    await testDb`delete from private.billing_guard_health`;
    await testDb`delete from private.billing_shadow_samples`;
    const t = await mk("hx1", MODE.full);
    const day = new Date().toISOString().slice(0, 10);
    await testDb`insert into private.billing_decision_counters (day, tenant_id, stage, category, action_key, mode, decision, reason, n, config_version) values
      (${day}, ${t}, 1, 'APPT_CREATE', 'fn:create_appointment', 'full', 'allow', 'pilot', 10, 1),
      (${day}, ${t}, 1, 'APPT_CREATE', 'fn:create_appointment', 'read_only', 'would_block', 'trial_expired', 3, 1),
      (${day}, ${t}, 2, 'APPT_CREATE', 'fn:create_appointment', 'read_only', 'blocked', 'trial_expired', 7, 1)`;
    await testDb`insert into private.billing_guard_health (day, kind, n) values (${day}, 'guard_error', 2), (${day}, 'unknown_category', 1), (${day}, 'policy_miss', 4), (${day}, 'protected_would_block', 5)`;
    await testDb`insert into private.billing_shadow_samples (stage, category, action_key, mode, decision, reason, tenant_id, config_version) values (1, 'APPT_CREATE', 'fn:create_appointment', 'read_only', 'would_block', 'trial_expired', ${t}, 1)`;
    const r1 = (await testDb`select private.billing_enforcement_counters(1::smallint, now() - interval '1 day') as r`)[0]!.r as Loose;
    expect(r1).toMatchObject({ decisions: 13, allow: 10, would_block: 3, guard_errors: 2, unknown_category: 1, policy_misses: 4, protected_would_block: 5 });
    expect(((await testDb`select private.billing_enforcement_counters(2::smallint, now() - interval '1 day') as r`)[0]!.r as Loose)).toMatchObject({ decisions: 7, blocked: 7 });
    expect(await testDb`insert into private.billing_decision_counters (day, tenant_id, stage, category, action_key, mode, decision, reason, n, config_version) values (${day}, ${t}, 1, 'APPT_CREATE', 'fn:create_appointment', 'full', 'allow', 'pilot', 1, 1)`.then(() => "ok", (e: Error) => e.message)).toMatch(/duplicate key/);
    await testDb`delete from private.billing_decision_counters`;
    await testDb`delete from private.billing_guard_health`;
    await testDb`delete from private.billing_shadow_samples`;
    for (const tbl of ["billing_decision_counters", "billing_shadow_samples", "billing_guard_health"]) expect((await testDb.unsafe(`select count(*)::int n from private.${tbl}`))[0]!.n, tbl).toBe(0);
  });
});
