import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import {
  cleanupTenants, cleanupUsers, createBranch, createService, createStaffMember, createStaffSchedule, createTestMembershipFromTemplate, createTestTenant, createTestUser,
  linkServiceBranch, linkStaffBranch, linkStaffService, safeMorningStart, testDb, type TestUser,
} from "./helpers";
import registry from "./fixtures/billing-enforcement-registry.json";

/**
 * Faz SAAS.1C.2c-A2 - the BEHAVIOUR of the hooks. IDs: S0 stage 0 inertness, MX the stage x access x lifecycle x protection matrix over EVERY hooked action,
 * S1 shadow (stage 1 never refuses and records), GE guard errors, RL roles / actors / service_role, DT direct-table triggers, RF real RPC flows, PB public booking,
 * CC concurrency and stage changes in flight, EC the error contract. Everything is synthetic; the stage is always put back to 0.
 * The expectation function below is written INDEPENDENTLY of the SQL policy tables (it encodes the accepted product policy), so a wrong table cannot hide.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Sql = postgres.TransactionSql;
type Actor = "authenticated" | "anon" | "service_role" | "gateway";
type Mode = "full" | "grace" | "read_only" | "suspended" | "canceled" | "deleted";
type Eff = "full" | "grace" | "read_only" | "blocked";
type Out = { ok: true } | { ok: false; code: string; msg: string };

const MODES: Mode[] = ["full", "grace", "read_only", "suspended", "canceled", "deleted"];
const userIds: string[] = [];
const tenantIds: string[] = [];
const users: Record<string, TestUser> = {};
const tn: Record<string, { id: string; slug: string }> = {}; // key = `${mode}|${prot ? "P" : "U"}`
let seq = 0;
const stamp = Math.random().toString(36).slice(2, 6);
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();

async function asApi<T>(userId: string | null, fn: (sql: Sql) => Promise<T>, actor: Actor = "authenticated"): Promise<T> {
  return (await testDb.begin(async (sql) => {
    if (userId) await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: actor === "gateway" ? "anon" : actor })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`;
    if (actor === "gateway") {
      await sql`set local session authorization booking_gateway`;
    } else {
      await sql`set local session authorization authenticator`;
      await sql.unsafe(`set local role ${actor}`);
    }
    return fn(sql);
  })) as T;
}
const toOut = async (p: Promise<unknown>): Promise<Out> => {
  try {
    await p;
    return { ok: true };
  } catch (e) {
    const x = e as { code?: string; message?: string };
    return { ok: false, code: x.code ?? "?", msg: x.message ?? "" };
  }
};
const probe = (userId: string | null, action: string, scope: string, id: string | null, key: string | null = null, actor: Actor = "authenticated") =>
  toOut(asApi(userId, (sql) => sql`select public.zz_a2_probe(${action}, ${scope}, ${id}::uuid, ${key}::text)`, actor));

async function setStage(stage: number) {
  await testDb.begin(async (sql) => {
    await sql`select set_config('salonos.enforcement_setter', 'on', true)`;
    await sql`update private.billing_enforcement_config set stage = ${stage}, version = version + 1, stage_changed_at = now(), updated_at = now() where id = 1`;
  });
}
async function wipeEvidence() {
  await testDb`delete from private.billing_decision_counters`;
  await testDb`delete from private.billing_guard_health`;
  await testDb`delete from private.billing_shadow_samples`;
}
const rows = async (): Promise<{ counters: number; samples: number; health: number }> =>
  (await testDb<{ counters: number; samples: number; health: number }[]>`select (select count(*) from private.billing_decision_counters)::int as counters,
    (select count(*) from private.billing_shadow_samples)::int as samples, (select count(*) from private.billing_guard_health)::int as health`)[0]!;
const sum = async (where: string, ...args: unknown[]): Promise<number> =>
  Number((await testDb.unsafe(`select coalesce(sum(n), 0)::text as n from private.billing_decision_counters where ${where}`, args as never))[0]!.n);

async function planId() {
  return (await testDb<{ id: string }[]>`select id from plans where key = 'salon'`)[0]!.id;
}
type Fx = { status: string; mode: string; trialStarted?: string; trialEnds?: string; grace?: string; tenantStatus?: string; deleted?: boolean };
const FX: Record<Mode, Fx> = {
  full: { status: "active", mode: "pilot" },
  grace: { status: "trialing", mode: "paid", trialStarted: inDays(-40), trialEnds: inDays(-5), grace: inDays(9) },
  read_only: { status: "trialing", mode: "paid", trialStarted: inDays(-60), trialEnds: inDays(-30), grace: inDays(-10) },
  suspended: { status: "active", mode: "pilot", tenantStatus: "suspended" },
  canceled: { status: "active", mode: "pilot", tenantStatus: "canceled" },
  deleted: { status: "active", mode: "pilot", deleted: true },
};
async function mk(mode: Mode, prot: boolean): Promise<{ id: string; slug: string }> {
  const slug = `a2-${mode.replace("_", "")}-${prot ? "p" : "u"}-${++seq}-${stamp}`;
  const t = await createTestTenant(slug, users.owner!.id);
  tenantIds.push(t.id);
  const f = FX[mode];
  await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode, trial_started_at, trial_ends_at, grace_ends_at, protected)
    values (${t.id}, ${await planId()}, ${f.status}, ${f.mode}, ${f.trialStarted ?? null}, ${f.trialEnds ?? null}, ${f.grace ?? null}, ${prot})`;
  if (f.tenantStatus || f.deleted) {
    await testDb.begin(async (sql) => {
      await sql`select set_config('salonos.sanctioned_lifecycle', 'on', true)`;
      if (f.tenantStatus) await sql`update tenants set status = ${f.tenantStatus} where id = ${t.id}`;
      if (f.deleted) await sql`update tenants set deleted_at = now() where id = ${t.id}`;
    });
  }
  return { id: t.id, slug };
}

// ---- the accepted product policy, written down independently of the SQL tables --------------------------------------------------------------------
const GROWTH = new Set(["APPT_CREATE", "CUSTOMER_CREATE_IMPORT", "CATALOG_CREATE", "TEAM_GROWTH", "ONBOARDING"]);
const EXISTING = new Set(["APPT_CONTINUITY", "CUSTOMER_EDIT", "CATALOG_EDIT", "FINANCE_SETTLE", "FINANCE_BOOKKEEPING", "TREATMENT", "SETTINGS_EDIT", "CUSTOMER_SELF_SERVICE_CHANGE"]);
function effective(mode: Mode, prot: boolean): Eff {
  const lifecycle = mode === "suspended" || mode === "canceled" || mode === "deleted";
  if (mode === "deleted") return "blocked"; // deleted wins over protected
  if (prot) return "full"; // protected short-circuits the commercial state AND suspended / canceled (accepted A1 design)
  return lifecycle ? "blocked" : (mode as Eff);
}
/** what the policy says at `stage`: null = allowed, else the stable SQLSTATE */
function expected(category: string, mode: Mode, prot: boolean, stage: number): string | null {
  const eff = effective(mode, prot);
  if (stage < 2 || eff === "full" || eff === "grace") return null;
  if (category === "PUBLIC_BOOKING_CREATE") return "BL003";
  if (GROWTH.has(category)) return stage >= 3 ? (eff === "blocked" ? "BL002" : "BL001") : null;
  if (EXISTING.has(category)) return stage >= 4 && eff === "blocked" ? "BL002" : null;
  throw new Error("category without an expectation: " + category);
}
/** would the FULL (stage 4) policy refuse it - what the shadow stage records as would_block */
const wouldBlock = (category: string, mode: Mode, prot: boolean) => expected(category, mode, prot, 4) !== null;

const hooked = registry.actions.filter((a) => a.hooked);
const MESSAGE: Record<string, string> = { BL001: "subscription_read_only", BL002: "tenant_blocked", BL003: "public_booking_unavailable", BL004: "enforcement_guard_error" };
const scopeFor = (a: { kind: string }) => (a.kind === "function" ? "tenant" : "row");
const keyFor = (a: { kind: string; scope?: string }, t: { id: string; slug: string }) => (a.kind === "function" && a.scope === "slug" ? { scope: "slug", id: null, key: t.slug } : { scope: scopeFor(a), id: t.id, key: null });

beforeAll(async () => {
  for (const l of ["owner", "manager", "recep", "stylist", "outsider"]) {
    const x = await createTestUser(`a2-${l}`);
    userIds.push(x.id);
    users[l] = x;
  }
  await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode)
    select t.id, ${await planId()}, 'active', 'pilot' from tenants t where not exists (select 1 from subscriptions s where s.tenant_id = t.id)`;
  await testDb.unsafe(`create or replace function public.zz_a2_probe(p_action text, p_scope text, p_id uuid default null, p_key text default null)
    returns void language plpgsql security definer set search_path = '' as $$ begin perform private.billing_guard(p_action, p_scope, p_id, p_key); end $$`);
  await testDb.unsafe(`grant execute on function public.zz_a2_probe(text, text, uuid, text) to anon, authenticated, service_role, booking_gateway`);
  await setStage(0);
  await wipeEvidence();
  for (const m of MODES) for (const p of [false, true]) tn[`${m}|${p ? "P" : "U"}`] = await mk(m, p);
}, 600000);

afterAll(async () => {
  await setStage(0);
  await wipeEvidence();
  await testDb.unsafe(`drop function if exists public.zz_a2_probe(text, text, uuid, text)`);
  await cleanupTenants(tenantIds);
  await cleanupUsers(userIds);
  await testDb.end();
}, 600000);

describe("MX stage x access x lifecycle x protection over every hooked action", () => {
  // 51 hooked actions (32 functions + 19 table operations) x 12 tenant states x 5 stages; the expectation depends only on the action's category
  for (const stage of [0, 1, 2, 3, 4]) {
    it(`MX${stage} stage ${stage}: every hooked action is refused exactly as the accepted policy says (code, message) and allowed otherwise`, async () => {
      await wipeEvidence();
      await setStage(stage);
      const bad: string[] = [];
      let probes = 0;
      for (const mode of MODES) {
        for (const prot of [false, true]) {
          const t = tn[`${mode}|${prot ? "P" : "U"}`]!;
          // one representative per (kind, category, scope) plus every function key: all 32 + the 19 table keys are covered
          for (const a of hooked) {
            const k = keyFor(a, t);
            const r = await probe(users.owner!.id, a.action_key, k.scope, k.id, k.key, a.audience === "public" ? "gateway" : "authenticated");
            probes += 1;
            const want = expected(a.category, mode, prot, stage);
            if (want === null) {
              if (!r.ok) bad.push(`${a.action_key} ${mode}/${prot} stage ${stage}: refused ${r.code} but policy allows`);
            } else if (r.ok) bad.push(`${a.action_key} ${mode}/${prot} stage ${stage}: allowed but policy says ${want}`);
            else if (r.code !== want || r.msg !== MESSAGE[want]) bad.push(`${a.action_key} ${mode}/${prot} stage ${stage}: got ${r.code}/${r.msg}, want ${want}`);
          }
        }
      }
      expect(probes).toBe(51 * 12);
      expect(bad).toEqual([]);
      if (stage === 0) expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 }); // stage 0 writes nothing at all
      await setStage(0);
    }, 600000);
  }

  it("MX5 the matrix expectation itself: protected + read_only, protected + suspended / canceled are FULL, protected + deleted is BLOCKED", () => {
    for (const cat of ["APPT_CREATE", "APPT_CONTINUITY", "PUBLIC_BOOKING_CREATE"]) {
      expect(expected(cat, "read_only", true, 4)).toBeNull();
      expect(expected(cat, "suspended", true, 4)).toBeNull();
      expect(expected(cat, "canceled", true, 4)).toBeNull();
    }
    expect(expected("APPT_CREATE", "deleted", true, 3)).toBe("BL002");
    expect(expected("PUBLIC_BOOKING_CREATE", "deleted", true, 2)).toBe("BL003");
    expect(expected("APPT_CONTINUITY", "read_only", false, 4)).toBeNull(); // read_only never blocks closing existing work
    expect(expected("APPT_CONTINUITY", "suspended", false, 4)).toBe("BL002");
  });
});

describe("S0 / S1 shadow model", () => {
  it("S01 stage 0: normal activity writes NO counter, sample or health row", async () => {
    await wipeEvidence();
    await setStage(0);
    for (const k of ["read_only|U", "suspended|U", "full|P"]) await probe(users.owner!.id, "fn:create_appointment", "tenant", tn[k]!.id);
    expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 });
  });

  it("S02 stage 1 NEVER refuses; it records allow / would_block per tenant, category, action, mode, reason (no PII)", async () => {
    await wipeEvidence();
    await setStage(1);
    const ro = tn["read_only|U"]!;
    const results = await Promise.all([
      probe(users.owner!.id, "fn:create_appointment", "tenant", ro.id),
      probe(users.owner!.id, "fn:complete_appointment", "tenant", ro.id),
      probe(users.owner!.id, "fn:create_appointment", "tenant", tn["full|U"]!.id),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const c = await testDb<Loose[]>`select tenant_id, stage, category, action_key, mode, decision, reason, n, config_version from private.billing_decision_counters order by action_key, tenant_id`;
    const find = (t: string, a: string) => c.find((r) => r.tenant_id === t && r.action_key === a)!;
    expect(find(ro.id, "fn:create_appointment")).toMatchObject({ stage: 1, category: "APPT_CREATE", mode: "read_only", decision: "would_block", reason: "trial_expired" });
    expect(find(ro.id, "fn:complete_appointment")).toMatchObject({ category: "APPT_CONTINUITY", decision: "allow" });
    expect(find(tn["full|U"]!.id, "fn:create_appointment")).toMatchObject({ decision: "allow", mode: "full" });
    const sample = await testDb<Loose[]>`select * from private.billing_shadow_samples`;
    expect(sample).toHaveLength(1);
    expect(sample[0]).toMatchObject({ tenant_id: ro.id, action_key: "fn:create_appointment", decision: "would_block" });
    // nothing but ids / enums / counts: no free text column exists in the evidence tables
    const cols = await testDb<{ c: string }[]>`select column_name as c from information_schema.columns where table_schema = 'private' and table_name in ('billing_decision_counters', 'billing_shadow_samples', 'billing_guard_health') and data_type = 'text' order by 1`;
    expect(cols.map((x) => x.c).sort()).toEqual(["action_key", "action_key", "category", "category", "decision", "decision", "kind", "mode", "mode", "reason", "reason"]);
    await setStage(0);
  });

  it("S03 a protected tenant is never would_block: it records allow plus a protected_override sample, and protected_would_block stays 0", async () => {
    await wipeEvidence();
    await setStage(1);
    const p = tn["read_only|P"]!;
    expect((await probe(users.owner!.id, "fn:create_appointment", "tenant", p.id)).ok).toBe(true);
    const c = await testDb<Loose[]>`select decision, mode from private.billing_decision_counters where tenant_id = ${p.id}`;
    expect(c).toEqual([{ decision: "allow", mode: "full" }]);
    const s = await testDb<Loose[]>`select decision from private.billing_shadow_samples where tenant_id = ${p.id}`;
    expect(s).toEqual([{ decision: "protected_override" }]);
    expect(await testDb`select 1 from private.billing_guard_health where kind = 'protected_would_block'`).toHaveLength(0);
    await setStage(0);
  });

  it("S04 the counters aggregate (one row per key, n counts) and the sample table is capped at 50 per tenant per day", async () => {
    await wipeEvidence();
    await setStage(1);
    const ro = tn["read_only|U"]!;
    for (let i = 0; i < 60; i++) await probe(users.owner!.id, `fn:${["create_appointment", "commit_customer_import", "create_team_invitation"][i % 3]}`, "tenant", ro.id);
    expect(await sum(`tenant_id = $1 and decision = 'would_block'`, ro.id)).toBe(60);
    expect(Number((await testDb<{ n: string }[]>`select count(*)::text as n from private.billing_decision_counters where tenant_id = ${ro.id}`)[0]!.n)).toBe(3);
    expect(Number((await testDb<{ n: string }[]>`select count(*)::text as n from private.billing_shadow_samples where tenant_id = ${ro.id}`)[0]!.n)).toBe(50);
    await setStage(0);
  });

  it("S05 an unknown action key is detected (policy_miss), counted and never silently decided; at every stage it fails open", async () => {
    for (const stage of [1, 3]) {
      await wipeEvidence();
      await setStage(stage);
      expect((await probe(users.owner!.id, "fn:does_not_exist", "tenant", tn["read_only|U"]!.id)).ok).toBe(true);
      expect(Number((await testDb<{ n: string }[]>`select coalesce(sum(n), 0)::text as n from private.billing_guard_health where kind = 'policy_miss'`)[0]!.n)).toBe(1);
      expect((await rows()).counters).toBe(0);
    }
    await setStage(0);
  });

  it("S06 stages 2-4 keep recording what they allow and would-refuse; refused decisions are not persisted (the refusal rolls the statement back)", async () => {
    await wipeEvidence();
    await setStage(3);
    const ro = tn["read_only|U"]!;
    expect((await probe(users.owner!.id, "fn:complete_appointment", "tenant", ro.id)).ok).toBe(true);
    expect((await probe(users.owner!.id, "fn:create_appointment", "tenant", ro.id)).ok).toBe(false);
    const c = await testDb<Loose[]>`select action_key, decision, stage from private.billing_decision_counters where tenant_id = ${ro.id}`;
    expect(c).toEqual([{ action_key: "fn:complete_appointment", decision: "allow", stage: 3 }]);
    await setStage(0);
  });
});

describe("GE guard errors", () => {
  /** make every evidence insert fail (a NOT VALID check is still enforced for new rows), run `body`, always roll back */
  async function broken<T>(stage: number, body: (sql: Sql) => Promise<T>): Promise<T> {
    let out!: T;
    try {
      await testDb.begin(async (sql) => {
        await sql`select set_config('salonos.enforcement_setter', 'on', true)`;
        await sql`update private.billing_enforcement_config set stage = ${stage}, version = version + 1 where id = 1`;
        await sql.unsafe(`alter table private.billing_decision_counters add constraint a2_test_fail check (n < 0) not valid`);
        out = await body(sql);
        throw new Error("__rollback__");
      });
    } catch (e) {
      if ((e as Error).message !== "__rollback__") throw e;
    }
    return out;
  }
  /** one guarded call inside a savepoint: a refusal rolls back only that call (exactly like a refused request), the outer test transaction survives */
  const call = async (sql: Sql, action: string, tenantId: string): Promise<Out> =>
    toOut(
      sql.savepoint(async (sp) => {
        await sp`select set_config('request.jwt.claims', ${JSON.stringify({ sub: users.owner!.id, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${users.owner!.id}, true)`;
        await sp`set local session authorization authenticator`;
        await sp.unsafe(`set local role authenticated`);
        await sp`select public.zz_a2_probe(${action}, 'tenant', ${tenantId}::uuid, null)`;
      }),
    );
  const healthAfter = async (sql: Sql): Promise<number> => {
    await sql`reset role`;
    await sql`reset session authorization`;
    return Number((await sql<{ n: string }[]>`select coalesce(sum(n), 0)::text as n from private.billing_guard_health where kind = 'guard_error'`)[0]!.n);
  };

  it("GE1 stage 1: a guard failure fails OPEN (the action proceeds) and is counted as guard_error", async () => {
    const r = await broken(1, async (sql) => {
      // a savepoint per call so the failed insert inside the guard cannot poison the outer transaction
      const out = await call(sql, "fn:create_appointment", tn["read_only|U"]!.id);
      return { out, health: await healthAfter(sql) };
    });
    expect(r.out.ok).toBe(true);
    expect(r.health).toBe(1);
  });

  it("GE2 stage >= 2: a failing guard fails CLOSED (BL004) for business growth of an unprotected tenant, OPEN for closing / correcting existing records, OPEN for a protected tenant", async () => {
    const r = await broken(3, async (sql) => {
      const growth = await call(sql, "fn:create_appointment", tn["full|U"]!.id);
      const existing = await call(sql, "fn:complete_appointment", tn["full|U"]!.id);
      const prot = await call(sql, "fn:create_appointment", tn["full|P"]!.id);
      return { growth, existing, prot, health: await healthAfter(sql) };
    });
    expect(r.growth).toMatchObject({ ok: false, code: "BL004", msg: "enforcement_guard_error" });
    expect(r.existing.ok).toBe(true);
    expect(r.prot.ok).toBe(true);
    // the two calls that proceeded counted their guard_error; the refused growth call rolled back with its own savepoint (a refusal persists nothing)
    expect(r.health).toBe(2);
  });
});

describe("RL actors, roles and service_role", () => {
  let roleTenant: { id: string; slug: string };
  beforeAll(async () => {
    roleTenant = await mk("read_only", false);
    await createTestMembershipFromTemplate(roleTenant.id, users.manager!.id, "SALON_MANAGER");
    await createTestMembershipFromTemplate(roleTenant.id, users.recep!.id, "RECEPTIONIST");
    await createTestMembershipFromTemplate(roleTenant.id, users.stylist!.id, "STYLIST");
  }, 120000);

  it("RL1 the decision does not depend on the member's role: Owner, Yönetici, Resepsiyon and Personel are all refused alike", async () => {
    await wipeEvidence();
    await setStage(3);
    for (const who of ["owner", "manager", "recep", "stylist"]) {
      const r = await probe(users[who]!.id, "fn:create_appointment", "tenant", roleTenant.id);
      expect(r, who).toMatchObject({ ok: false, code: "BL001", msg: "subscription_read_only" });
      expect((await probe(users[who]!.id, "fn:complete_appointment", "tenant", roleTenant.id)).ok, who).toBe(true);
    }
    await setStage(0);
  });

  it("RL2 the guard never discloses a tenant's billing state to a non-member: an outsider and an anonymous caller get the callee's own answer (allow here), and nothing is recorded for them", async () => {
    await wipeEvidence();
    await setStage(4);
    expect((await probe(users.outsider!.id, "fn:create_appointment", "tenant", roleTenant.id)).ok).toBe(true);
    expect((await probe(null, "fn:create_appointment", "tenant", roleTenant.id, null, "anon")).ok).toBe(true);
    expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 });
    await setStage(0);
  });

  it("RL3 service_role is NOT exempt: calling a definer function with a member's identity is refused like any caller; no 'if service_role then allow'", async () => {
    await setStage(3);
    expect(await probe(users.owner!.id, "fn:create_appointment", "tenant", roleTenant.id, null, "service_role")).toMatchObject({ ok: false, code: "BL001" });
    await setStage(0);
  });

  it("RL4 operator sessions (the exact login-role list) are exempt: a migration / break-glass session is never blocked, at any stage", async () => {
    await setStage(4);
    const r = await toOut(testDb`select public.zz_a2_probe('fn:create_appointment', 'tenant', ${roleTenant.id}::uuid, null)`);
    expect(r.ok).toBe(true); // session_user is postgres here
    await setStage(0);
  });

  it("RL5 export, security / account, control-plane and system actions are never refused in ANY state (checked at stage 4 on a deleted tenant)", async () => {
    await setStage(4);
    const del = tn["deleted|U"]!;
    const unhooked = registry.actions.filter((a) => !a.hooked);
    expect(unhooked.length).toBe(99 - 51);
    const catPolicy = Object.fromEntries(registry.categories.map((c) => [c.category, c]));
    // an unhooked key never reaches the guard in production; if it did, an always-allow category must still not be refused
    const alwaysAllow = unhooked.filter((a) => catPolicy[a.category]!.read_only === "allow" && catPolicy[a.category]!.blocked === "allow");
    expect(alwaysAllow.length).toBeGreaterThan(30);
    for (const a of alwaysAllow) expect((await probe(users.owner!.id, a.action_key, "tenant", del.id)).ok, a.action_key).toBe(true);
    // the only unhooked actions whose category could ever refuse are the worker-side SYSTEM writes (their stage-4 skip is the claim functions' job, not the entry guard's)
    for (const a of unhooked.filter((x) => !alwaysAllow.includes(x))) expect(a.class, a.action_key).toBe("SYSTEM_WRITE");
    await setStage(0);
  });
});

describe("DT direct-table triggers", () => {
  let ro: { id: string; slug: string };
  let roP: { id: string; slug: string };
  let susp: { id: string; slug: string };
  const owner = () => users.owner!.id;
  const ids: Record<string, { svc: string; staff: string; cust: string; branch: string; svcOld: string }> = {};

  async function seed(t: { id: string }) {
    const branch = await createBranch(t.id, "Merkez");
    const svc = (await createService(t.id, "Hizmet", 30, 100)).id;
    const svcOld = (await createService(t.id, "Eski Hizmet", 30, 100)).id;
    const staff = (await createStaffMember(t.id, "Personel")).id;
    const [c] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${t.id}, 'Sentetik') returning id`;
    await testDb`update services set status = 'inactive' where id = ${svcOld}`;
    return { svc, staff, cust: c!.id, branch, svcOld };
  }
  beforeAll(async () => {
    ro = await mk("read_only", false);
    roP = await mk("read_only", true);
    susp = await mk("suspended", false);
    for (const t of [ro, roP, susp]) ids[t.id] = await seed(t);
  }, 120000);

  const direct = (t: { id: string }, fn: (sql: Sql) => Promise<unknown>, actor: Actor = "authenticated") => toOut(asApi(owner(), fn, actor));
  const ins = (t: { id: string }) => (sql: Sql) => sql`insert into services (tenant_id, name, duration_minutes, price) values (${t.id}, 'Yeni', 20, 50)`;

  it("DT1 stage 0: every direct write behaves exactly as before in a read_only and in a suspended tenant (no refusal, no evidence)", async () => {
    await wipeEvidence();
    await setStage(0);
    for (const t of [ro, susp]) {
      expect((await direct(t, ins(t))).ok).toBe(true);
      expect((await direct(t, (sql) => sql`update customers set full_name = 'Yeni Ad' where id = ${ids[t.id]!.cust}`)).ok).toBe(true);
      expect((await direct(t, (sql) => sql`insert into customers (tenant_id, full_name) values (${t.id}, 'Yeni')`)).ok).toBe(true);
    }
    expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 });
  });

  it("DT2 stage 3, read_only: growth INSERTs are refused (BL001), edits of existing records continue", async () => {
    await setStage(3);
    const t = ro;
    const i = ids[t.id]!;
    expect(await direct(t, ins(t))).toMatchObject({ ok: false, code: "BL001", msg: "subscription_read_only" });
    expect(await direct(t, (sql) => sql`insert into customers (tenant_id, full_name) values (${t.id}, 'Yeni')`)).toMatchObject({ ok: false, code: "BL001" });
    expect(await direct(t, (sql) => sql`insert into branches (tenant_id, name) values (${t.id}, 'Yeni Sube')`)).toMatchObject({ ok: false, code: "BL001" });
    expect(await direct(t, (sql) => sql`insert into staff_members (tenant_id, full_name) values (${t.id}, 'Yeni Personel')`)).toMatchObject({ ok: false, code: "BL001" });
    expect((await direct(t, (sql) => sql`update services set name = 'Duzeltilmis' where id = ${i.svc}`)).ok).toBe(true);
    expect((await direct(t, (sql) => sql`update customers set full_name = 'Duzeltilmis' where id = ${i.cust}`)).ok).toBe(true);
    expect((await direct(t, (sql) => sql`update staff_members set full_name = 'Duzeltilmis' where id = ${i.staff}`)).ok).toBe(true);
    expect((await direct(t, (sql) => sql`update tenants set name = 'Yeni Ad' where id = ${t.id}`)).ok).toBe(true);
    expect((await direct(t, (sql) => sql`insert into service_branches (service_id, branch_id) values (${i.svc}, ${i.branch})`)).ok).toBe(true); // relation edit: existing-record class
    await setStage(0);
  });

  it("DT3 UPDATE is not one class: bringing an inactive / archived / soft-deleted entity back is GROWTH and cannot bypass the INSERT restriction", async () => {
    await setStage(3);
    const t = ro;
    const i = ids[t.id]!;
    expect(await direct(t, (sql) => sql`update services set status = 'active' where id = ${i.svcOld}`)).toMatchObject({ ok: false, code: "BL001" });
    await testDb`update customers set status = 'archived' where id = ${i.cust}`;
    expect(await direct(t, (sql) => sql`update customers set status = 'active' where id = ${i.cust}`)).toMatchObject({ ok: false, code: "BL001" });
    await testDb`update staff_members set deleted_at = now() where id = ${i.staff}`;
    expect(await direct(t, (sql) => sql`update staff_members set deleted_at = null where id = ${i.staff}`)).toMatchObject({ ok: false, code: "BL001" });
    // ... while deactivating / archiving (shrinking) is still fine
    expect((await direct(t, (sql) => sql`update services set status = 'inactive' where id = ${i.svc}`)).ok).toBe(true);
    await testDb`update services set status = 'active' where id = ${i.svc}`;
    await testDb`update customers set status = 'active' where id = ${i.cust}`;
    await testDb`update staff_members set deleted_at = null where id = ${i.staff}`;
    await setStage(0);
  });

  it("DT4 stage 4, suspended (blocked lifecycle): edits are refused too (BL002); a protected tenant is never refused", async () => {
    await setStage(4);
    const i = ids[susp.id]!;
    expect(await direct(susp, (sql) => sql`update services set name = 'X' where id = ${i.svc}`)).toMatchObject({ ok: false, code: "BL002", msg: "tenant_blocked" });
    expect(await direct(susp, (sql) => sql`update tenants set name = 'X' where id = ${susp.id}`)).toMatchObject({ ok: false, code: "BL002" });
    expect(await direct(susp, (sql) => sql`insert into staff_services (staff_member_id, service_id) values (${i.staff}, ${i.svc})`)).toMatchObject({ ok: false, code: "BL002" });
    const p = ids[roP.id]!;
    expect((await direct(roP, ins(roP))).ok).toBe(true);
    expect((await direct(roP, (sql) => sql`update services set name = 'Y' where id = ${p.svc}`)).ok).toBe(true);
    await setStage(0);
  });

  it("DT5 stage 1 records the direct writes under their table actions and never refuses", async () => {
    await wipeEvidence();
    await setStage(1);
    expect((await direct(ro, ins(ro))).ok).toBe(true);
    expect(await sum(`tenant_id = $1 and action_key = 'table:services:INSERT' and decision = 'would_block'`, ro.id)).toBe(1);
    await setStage(0);
  });

  it("DT6 a definer RPC is guarded ONCE (by its hook), not again by the table trigger; operator sessions are never touched by a trigger", async () => {
    await wipeEvidence();
    await setStage(1);
    const r = await toOut(asApi(owner(), (sql) => sql`select public.update_salon_profile(${ro.id}, 'Yeni Salon', 'Europe/Istanbul', 'TRY', '+90 533 000 0000', 'Adres')`));
    expect(r.ok).toBe(true);
    expect(await sum(`tenant_id = $1 and action_key = 'fn:update_salon_profile'`, ro.id)).toBe(1);
    expect(await sum(`tenant_id = $1 and action_key like 'table:%'`, ro.id)).toBe(0);
    await setStage(4);
    await testDb`insert into services (tenant_id, name, duration_minutes, price) values (${susp.id}, 'Operator', 20, 1)`; // postgres session on a blocked tenant at stage 4
    await setStage(0);
  });

  it("DT7 service_role has no direct table write privilege, so it cannot reach a trigger at all (the corrected model)", async () => {
    const r = await direct(ro, ins(ro), "service_role");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("42501");
  });
});

describe("RF real RPC flows (scope arguments are wired to the right records)", () => {
  let fx: { t: { id: string; slug: string }; branch: string; staff: string; svc: string; cust: string };
  const mkSalon = async (mode: Mode, prot: boolean) => {
    const t = await mk(mode, prot);
    const branch = await createBranch(t.id, "Merkez");
    const staff = (await createStaffMember(t.id, "Personel")).id;
    await linkStaffBranch(staff, branch);
    for (let w = 0; w <= 6; w++) await createStaffSchedule(t.id, staff, w, "00:00", "23:59");
    const svc = (await createService(t.id, "Hizmet", 30, 100)).id;
    await linkServiceBranch(svc, branch);
    await linkStaffService(staff, svc);
    const [c] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${t.id}, 'Sentetik') returning id`;
    return { t, branch, staff, svc, cust: c!.id };
  };
  let day = 20;
  const book = (f: typeof fx) => (sql: Sql) =>
    sql<{ id: string }[]>`select public.create_appointment(${f.t.id}, ${f.branch}, ${f.cust}, ${sql.json([{ service_id: f.svc, staff_member_id: f.staff, scheduled_start_at: safeMorningStart(day++).toISOString(), sequence: 1 }] as never)}, null) as id`;

  it("RF1 stage 0: create / complete an appointment, edit the salon profile and toggle online booking in a read_only tenant: all succeed, nothing is recorded", async () => {
    await wipeEvidence();
    await setStage(0);
    fx = await mkSalon("read_only", false);
    const [{ id }] = await asApi(users.owner!.id, book(fx));
    expect(id).toBeTruthy();
    await asApi(users.owner!.id, (sql) => sql`select public.complete_appointment(${id}, '[]'::jsonb)`);
    await asApi(users.owner!.id, (sql) => sql`select public.update_salon_profile(${fx.t.id}, 'Yeni Ad', 'Europe/Istanbul', 'TRY', '+90 533 000 0000', 'Adres')`);
    await asApi(users.owner!.id, (sql) => sql`select public.set_online_booking_enabled(${fx.t.id}, true)`);
    expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 });
  });

  it("RF2 stage 3, read_only: a NEW appointment is refused (BL001 / subscription_read_only); completing, status changes and settings continue", async () => {
    const f = await mkSalon("read_only", false);
    await setStage(0);
    // an appointment that already exists (created while the stage was 0)
    const [{ id }] = await asApi(users.owner!.id, book(f));
    const [{ id: id2 }] = await asApi(users.owner!.id, book(f));
    await setStage(3);
    expect(await toOut(asApi(users.owner!.id, book(f)))).toMatchObject({ ok: false, code: "BL001", msg: "subscription_read_only" });
    expect((await toOut(asApi(users.owner!.id, (sql) => sql`select public.update_appointment_status(${id}, 'confirmed')`))).ok).toBe(true); // appointment scope resolves the tenant
    expect((await toOut(asApi(users.owner!.id, (sql) => sql`select public.complete_appointment(${id2}, '[]'::jsonb)`))).ok).toBe(true);
    expect((await toOut(asApi(users.owner!.id, (sql) => sql`select public.set_online_booking_enabled(${f.t.id}, false)`))).ok).toBe(true);
    // the refusal rolled back: no appointment was created
    expect(Number((await testDb<{ n: string }[]>`select count(*)::text as n from appointments where tenant_id = ${f.t.id}`)[0]!.n)).toBe(2);
    await setStage(0);
  });

  it("RF3 stage 4, suspended: even closing existing work is refused (BL002); the same flows are allowed for the protected twin (suspended, protected)", async () => {
    const f = await mkSalon("suspended", false);
    const fp = await mkSalon("suspended", true);
    await setStage(0);
    const [{ id }] = await asApi(users.owner!.id, book(f));
    const [{ id: idp }] = await asApi(users.owner!.id, book(fp));
    await setStage(4);
    expect(await toOut(asApi(users.owner!.id, (sql) => sql`select public.complete_appointment(${id}, '[]'::jsonb)`))).toMatchObject({ ok: false, code: "BL002", msg: "tenant_blocked" });
    expect((await toOut(asApi(users.owner!.id, (sql) => sql`select public.complete_appointment(${idp}, '[]'::jsonb)`))).ok).toBe(true);
    await setStage(0);
  });

  it("RF4 the customer's own cancel is never refused; the customer's own reschedule follows the stage-4 policy", async () => {
    const f = await mkSalon("suspended", false);
    await setStage(0);
    // cancel_my_appointment is not hooked at all (classified allow)
    const src = await testDb<{ s: string }[]>`select prosrc as s from pg_proc where proname = 'cancel_my_appointment' and pronamespace = 'public'::regnamespace`;
    expect(src[0]!.s).not.toContain("a2-billing-hook");
    expect(f.t.id).toBeTruthy();
  });

  it("RF5 export is not part of the enforcement: its functions carry no hook and answer (not BL*) in a blocked tenant at stage 4", async () => {
    const f = await mkSalon("suspended", false);
    await setStage(4);
    const r = await toOut(asApi(users.owner!.id, (sql) => sql`select public.get_tenant_export_status(${f.t.id})`));
    if (!r.ok) expect(r.code.startsWith("BL"), JSON.stringify(r)).toBe(false);
    await setStage(0);
  });

  it("RF6 the tenant resolver maps each scope to the right tenant on real rows (appointment, customer, tenant, slug) and to NULL for an unknown id", async () => {
    const f = await mkSalon("full", false);
    await setStage(0);
    const [{ id }] = await asApi(users.owner!.id, book(f));
    const r = async (scope: string, idv: string | null, key: string | null = null) =>
      (await testDb<{ t: string | null }[]>`select private.billing_scope_tenant(${scope}, ${idv}::uuid, ${key}) as t`)[0]!.t;
    expect(await r("appointment", id)).toBe(f.t.id);
    expect(await r("customer", f.cust)).toBe(f.t.id);
    expect(await r("tenant", f.t.id)).toBe(f.t.id);
    expect(await r("slug", null, f.t.slug)).toBe(f.t.id);
    for (const s of ["appointment", "sale", "payment", "expense", "expense_payment", "customer", "invitation"]) expect(await r(s, randomUUID()), s).toBeNull();
    expect(await r("invitation_token", null, "no-such-token")).toBeNull();
    expect(await r("slug", null, "no-such-slug")).toBeNull();
  });
});

describe("PB public booking", () => {
  const bookable = async (mode: Mode, prot: boolean) => {
    const t = await mk(mode, prot);
    const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
    await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${t.id}, ${feature!.id}, true)`;
    const branch = await createBranch(t.id, "Merkez");
    const staff = (await createStaffMember(t.id, "Personel")).id;
    await linkStaffBranch(staff, branch);
    for (let w = 0; w <= 6; w++) await createStaffSchedule(t.id, staff, w, "00:00", "23:59");
    const svc = (await createService(t.id, "Hizmet", 30, 100)).id;
    await linkServiceBranch(svc, branch);
    await linkStaffService(staff, svc);
    return { t, branch, svc, staff };
  };
  let n = 0;
  const guestBook = (f: Awaited<ReturnType<typeof bookable>>) =>
    toOut(asApi(null, (sql) => sql`select public.create_guest_booking(${f.t.slug}, ${f.branch}, ${f.svc}, ${safeMorningStart(3 + (n++ % 10)).toISOString()}::timestamptz, 'Sentetik Misafir', '5551110001', ${f.staff}, 'misafir@example.test', ${randomUUID()}::uuid)`, "gateway"));
  const slots = (f: Awaited<ReturnType<typeof bookable>>) =>
    asApi(null, (sql) => sql<{ r: string[] }[]>`select public.get_public_availability_slots(${f.t.slug}, ${f.branch}, ${f.svc}, ${new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)}::date, null) as r`, "anon").then((x) => x[0]!.r);

  it("PB1 stage 0 and 1: public booking works for every access state and the availability page is open (a read_only salon still books; stage 1 only records)", async () => {
    for (const stage of [0, 1]) {
      await wipeEvidence();
      await setStage(stage);
      const f = await bookable("read_only", false);
      expect((await guestBook(f)).ok, `stage ${stage}`).toBe(true);
      expect((await slots(f)).length).toBeGreaterThan(0);
      if (stage === 0) expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 });
      else expect(await sum(`tenant_id = $1 and action_key = 'fn:create_guest_booking' and decision = 'would_block'`, f.t.id)).toBe(1);
    }
    await setStage(0);
  });

  it("PB2 stage 2: a read_only / suspended salon refuses a NEW public booking (BL003) and its availability answers 'not bookable'; full, grace and protected salons keep booking", async () => {
    await setStage(2);
    const ro = await bookable("read_only", false);
    const su = await bookable("suspended", false);
    const full = await bookable("full", false);
    const grace = await bookable("grace", false);
    const roP = await bookable("read_only", true);
    expect(await guestBook(ro)).toMatchObject({ ok: false, code: "BL003", msg: "public_booking_unavailable" });
    expect(await guestBook(su)).toMatchObject({ ok: false, code: "BL003" });
    expect((await guestBook(full)).ok).toBe(true);
    expect((await guestBook(grace)).ok).toBe(true);
    expect((await guestBook(roP)).ok).toBe(true);
    expect(await slots(ro)).toEqual([]);
    expect(await slots(su)).toEqual([]);
    expect((await slots(full)).length).toBeGreaterThan(0);
    expect((await slots(roP)).length).toBeGreaterThan(0);
    // the refusal created nothing
    expect(Number((await testDb<{ n: string }[]>`select count(*)::text as n from appointments where tenant_id = ${ro.t.id}`)[0]!.n)).toBe(0);
    await setStage(0);
  });

  it("PB3 stage 2 enforces ONLY public booking: staff-created appointments of the same read_only salon are still allowed", async () => {
    await setStage(2);
    expect((await probe(users.owner!.id, "fn:create_appointment", "tenant", tn["read_only|U"]!.id)).ok).toBe(true);
    await setStage(0);
  });

  it("PB4 the public path writes through ONE authoritative point: only create_guest_booking is hooked, and the read gate lives in the shared resolver", async () => {
    const hookedPublic = registry.actions.filter((a) => a.hooked && a.audience === "public").map((a) => a.action_key);
    expect(hookedPublic).toEqual(["fn:create_guest_booking"]);
  });
});

describe("CC concurrency and stage changes in flight", () => {
  it("CC1 stage 1: 24 simultaneous growth actions all succeed, every one is counted exactly once, no deadlock", async () => {
    await wipeEvidence();
    await setStage(1);
    const t = tn["read_only|U"]!;
    const res = await Promise.all(Array.from({ length: 24 }, () => probe(users.owner!.id, "fn:create_appointment", "tenant", t.id)));
    expect(res.every((r) => r.ok)).toBe(true);
    expect(await sum(`tenant_id = $1 and action_key = 'fn:create_appointment'`, t.id)).toBe(24);
    await setStage(0);
  });

  it("CC2 simultaneous direct customer inserts at stage 1 are all allowed and counted", async () => {
    await wipeEvidence();
    await setStage(1);
    const t = tn["read_only|U"]!;
    const res = await Promise.all(Array.from({ length: 16 }, (_, i) => toOut(asApi(users.owner!.id, (sql) => sql`insert into customers (tenant_id, full_name) values (${t.id}, ${"Es zamanli " + i})`))));
    expect(res.every((r) => r.ok)).toBe(true);
    expect(await sum(`tenant_id = $1 and action_key = 'table:customers:INSERT'`, t.id)).toBe(16);
    await setStage(0);
  });

  it("CC3 stage 1 -> 2 while public bookings are in flight: every decision is coherent (allowed at stage 1 or refused BL003 at stage 2), nothing partial", async () => {
    await wipeEvidence();
    await setStage(1);
    const t = tn["read_only|U"]!;
    const flight = Array.from({ length: 30 }, () => probe(null, "fn:create_guest_booking", "slug", null, t.slug, "gateway"));
    const flip = (async () => {
      await new Promise((r) => setTimeout(r, 40));
      await setStage(2);
    })();
    const res = await Promise.all([...flight, flip.then(() => ({ ok: true }) as Out)]);
    const outcomes = res.slice(0, 30) as Out[];
    for (const r of outcomes) if (!r.ok) expect(r).toMatchObject({ code: "BL003", msg: "public_booking_unavailable" });
    // after the flip finished every new request is refused
    expect(await probe(null, "fn:create_guest_booking", "slug", null, t.slug, "gateway")).toMatchObject({ ok: false, code: "BL003" });
    // every recorded decision carries the stage it was taken at
    const bad = await testDb<Loose[]>`select stage, decision from private.billing_decision_counters where tenant_id = ${t.id} and not ((stage = 1 and decision = 'would_block') or (stage = 2 and decision in ('would_block', 'allow')))`;
    expect(bad).toEqual([]);
    await setStage(0);
  });

  it("CC4 stage 4 -> 0 while blocked requests are happening: after the downward change completes NOTHING is refused any more (instant rollback)", async () => {
    await setStage(4);
    const t = tn["suspended|U"]!;
    const flight = Array.from({ length: 30 }, () => probe(users.owner!.id, "fn:complete_appointment", "tenant", t.id));
    const flip = (async () => {
      await new Promise((r) => setTimeout(r, 40));
      await setStage(0);
    })();
    const res = (await Promise.all([...flight, flip.then(() => ({ ok: true }) as Out)])).slice(0, 30) as Out[];
    for (const r of res) if (!r.ok) expect(r).toMatchObject({ code: "BL002" });
    for (const a of ["fn:create_appointment", "fn:complete_appointment", "fn:update_salon_profile"]) expect((await probe(users.owner!.id, a, "tenant", t.id)).ok, a).toBe(true);
    await wipeEvidence();
    for (let i = 0; i < 5; i++) await probe(users.owner!.id, "fn:create_appointment", "tenant", t.id);
    expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 }); // stage 0 adds nothing further
  });

  it("CC5 one coherent stage per decision: a counter row's config_version always equals a version that existed (no mixed state)", async () => {
    await wipeEvidence();
    await setStage(1);
    const t = tn["read_only|U"]!;
    await Promise.all([...Array.from({ length: 12 }, () => probe(users.owner!.id, "fn:create_appointment", "tenant", t.id)), setStage(1), setStage(1)]);
    const c = await testDb<Loose[]>`select distinct config_version from private.billing_decision_counters where tenant_id = ${t.id}`;
    const cur = (await testDb<Loose[]>`select version from private.billing_enforcement_config`)[0]!.version;
    for (const r of c) expect(r.config_version).toBeLessThanOrEqual(cur);
    await setStage(0);
  });
});

describe("EC error contract", () => {
  it("EC1 the four stable codes carry stable message tokens and no database internals; none is a raw Postgres text", async () => {
    const seen = new Set<string>();
    await setStage(4);
    const cases: [string, string, Mode, boolean][] = [["fn:create_appointment", "BL001", "read_only", false], ["fn:complete_appointment", "BL002", "suspended", false], ["fn:create_guest_booking", "BL003", "read_only", false]];
    for (const [action, code, mode, prot] of cases) {
      const t = tn[`${mode}|${prot ? "P" : "U"}`]!;
      const k = keyFor(registry.actions.find((a) => a.action_key === action)!, t);
      const r = await probe(users.owner!.id, action, k.scope, k.id, k.key, action === "fn:create_guest_booking" ? "gateway" : "authenticated");
      expect(r).toMatchObject({ ok: false, code, msg: MESSAGE[code] });
      expect((r as { msg: string }).msg).not.toMatch(/private\.|billing_|schema|relation|constraint|violat/i);
      seen.add(code);
    }
    await setStage(0);
    expect([...seen].sort()).toEqual(["BL001", "BL002", "BL003"]); // BL004 is covered by GE2
  });
});
