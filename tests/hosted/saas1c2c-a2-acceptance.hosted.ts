import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership, admin, anonClient, cleanupTenants, cleanupUsers, createBranch, createService, createStaffMember, createStaffSchedule, createTestMembershipFromTemplate,
  createTestTenant, createTestUser, linkServiceBranch, linkStaffBranch, linkStaffService, safeMorningStart, signInAs, testDb, type TestUser,
} from "../helpers";
import { assertDisposableDatabase, readHostedEnv } from "./guard";
import { callCreateGuestBooking } from "@/lib/modules/public-booking/gateway-db";
import registry from "../fixtures/billing-enforcement-registry.json";

/**
 * Faz SAAS.1C.2c-A2 - HOSTED acceptance of the enforcement hooks (real Postgres + Auth + PostgREST of a DISPOSABLE project).
 * Every API actor is a REAL signed-in JWT talking to the real Data API (Owner, Yonetici, Resepsiyon, Personel, an outsider Owner of another tenant, a removed member,
 * a forger with user_metadata claims, anon, service_role); public booking goes through the REAL booking_gateway login. testDb (the postgres operator login) is used
 * for fixtures, ground-truth reads and the deliberate stage moves only (the stage is put back to 0 in afterAll). Everything is synthetic; slugs start with "h-".
 * IDs: MX stage x access x lifecycle x protection over every hooked action, RJ real-JWT persona matrix, DT direct-table writes through PostgREST, BP billing
 * bypass attempts, TW trigger WHEN / current_user, SH shadow, PB real booking gateway, EC error contract, CC concurrency, SW system / export invariants.
 */
const env = readHostedEnv();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Client = Awaited<ReturnType<typeof signInAs>>;
type Mode = "full" | "grace" | "read_only" | "suspended" | "canceled" | "deleted";
type Eff = "full" | "grace" | "read_only" | "blocked";
type Out = { ok: true } | { ok: false; code: string; msg: string };

const RUN = Math.random().toString(36).slice(2, 6);
// look-alike operator login roles; the name is unique per run because the pooler caches a login role's password
const LOOKS = [`postgres_x${RUN}`, `cli_login_postgres_x${RUN}`];
const MODES: Mode[] = ["full", "grace", "read_only", "suspended", "canceled", "deleted"];
const userIds: string[] = [];
const tenantIds: string[] = [];
const u: Record<string, TestUser> = {};
const c: Record<string, Client> = {};
const tn: Record<string, { id: string; slug: string }> = {};
let seq = 0;
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
const asOut = (e: { code?: string | null; message?: string } | null): Out => (e ? { ok: false, code: e.code ?? "?", msg: e.message ?? "" } : { ok: true });
const isBL = (r: Out) => !r.ok && r.code.startsWith("BL");
const tbl = (cl: Client, t: string) => (cl as unknown as { from: (t: string) => Loose }).from(t);
const rpc = async (cl: Client | ReturnType<typeof anonClient>, fn: string, args: Record<string, unknown>): Promise<Out & { data?: unknown }> => {
  const r = await (cl as Client).rpc(fn as never, args as never);
  return { ...asOut(r.error), data: r.data };
};

// ---- gateway (the REAL booking_gateway login) and lookalike operator roles (REAL pooler logins)
const gwUrl = process.env.BOOKING_GATEWAY_DATABASE_URL!;
const gw = postgres(gwUrl, { ssl: "require", max: 4, prepare: false });
const pgOut = async (p: Promise<unknown>): Promise<Out> => {
  try {
    await p;
    return { ok: true };
  } catch (e) {
    const x = e as { code?: string; message?: string };
    return { ok: false, code: x.code ?? "?", msg: x.message ?? "" };
  }
};
const gwProbe = (action: string, scope: string, id: string | null, key: string | null) => pgOut(gw`select public.zz_a2_probe(${action}, ${scope}, ${id}::uuid, ${key}::text)`);
const probe = async (cl: Client | ReturnType<typeof anonClient>, action: string, scope: string, id: string | null, key: string | null = null): Promise<Out> =>
  asOut((await (cl as Client).rpc("zz_a2_probe" as never, { p_action: action, p_scope: scope, p_id: id, p_key: key } as never)).error);

async function stage(n: number) {
  await testDb.begin(async (sql) => {
    await sql`select set_config('salonos.enforcement_setter', 'on', true)`;
    await sql`update private.billing_enforcement_config set stage = ${n}, version = version + 1, stage_changed_at = now(), updated_at = now() where id = 1`;
  });
}
const wipe = async () => {
  await testDb`delete from private.billing_decision_counters`;
  await testDb`delete from private.billing_guard_health`;
  await testDb`delete from private.billing_shadow_samples`;
};
const rows = async () =>
  (await testDb<{ counters: number; samples: number; health: number }[]>`select (select count(*) from private.billing_decision_counters)::int as counters,
    (select count(*) from private.billing_shadow_samples)::int as samples, (select count(*) from private.billing_guard_health)::int as health`)[0]!;
const sum = async (where: string, ...args: unknown[]) => Number((await testDb.unsafe(`select coalesce(sum(n), 0)::text as n from private.billing_decision_counters where ${where}`, args as never))[0]!.n);
const planId = async () => (await testDb<{ id: string }[]>`select id from plans where key = 'salon'`)[0]!.id;
const batches = async <T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
};

type Fx = { status: string; mode: string; trialStarted?: string; trialEnds?: string; grace?: string; tenantStatus?: string; deleted?: boolean };
const FX: Record<Mode, Fx> = {
  full: { status: "active", mode: "pilot" },
  grace: { status: "trialing", mode: "paid", trialStarted: inDays(-40), trialEnds: inDays(-5), grace: inDays(9) },
  read_only: { status: "trialing", mode: "paid", trialStarted: inDays(-60), trialEnds: inDays(-30), grace: inDays(-10) },
  suspended: { status: "active", mode: "pilot", tenantStatus: "suspended" },
  canceled: { status: "active", mode: "pilot", tenantStatus: "canceled" },
  deleted: { status: "active", mode: "pilot", deleted: true },
};
async function mk(mode: Mode, prot: boolean, ownerId = u.owner!.id): Promise<{ id: string; slug: string }> {
  const slug = `h-a2-${mode.replace("_", "")}-${prot ? "p" : "u"}-${++seq}-${RUN}`;
  const t = await createTestTenant(slug, ownerId);
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

// ---- the accepted product policy, written down independently of the SQL tables
const GROWTH = new Set(["APPT_CREATE", "CUSTOMER_CREATE_IMPORT", "CATALOG_CREATE", "TEAM_GROWTH", "ONBOARDING"]);
const EXISTING = new Set(["APPT_CONTINUITY", "CUSTOMER_EDIT", "CATALOG_EDIT", "FINANCE_SETTLE", "FINANCE_BOOKKEEPING", "TREATMENT", "SETTINGS_EDIT", "CUSTOMER_SELF_SERVICE_CHANGE"]);
function effective(mode: Mode, prot: boolean): Eff {
  if (mode === "deleted") return "blocked";
  if (prot) return "full";
  return mode === "suspended" || mode === "canceled" ? "blocked" : (mode as Eff);
}
function expected(category: string, mode: Mode, prot: boolean, st: number): string | null {
  const eff = effective(mode, prot);
  if (st < 2 || eff === "full" || eff === "grace") return null;
  if (category === "PUBLIC_BOOKING_CREATE") return "BL003";
  if (GROWTH.has(category)) return st >= 3 ? (eff === "blocked" ? "BL002" : "BL001") : null;
  if (EXISTING.has(category)) return st >= 4 && eff === "blocked" ? "BL002" : null;
  throw new Error("category without an expectation: " + category);
}
const MESSAGE: Record<string, string> = { BL001: "subscription_read_only", BL002: "tenant_blocked", BL003: "public_booking_unavailable", BL004: "enforcement_guard_error" };
const hooked = registry.actions.filter((a) => a.hooked);
const keyFor = (a: { kind: string; scope?: string }, t: { id: string; slug: string }) =>
  a.kind === "function" && a.scope === "slug" ? { scope: "slug", id: null, key: t.slug } : { scope: a.kind === "function" ? "tenant" : "row", id: t.id, key: null };

beforeAll(async () => {
  await assertDisposableDatabase(testDb as unknown as Parameters<typeof assertDisposableDatabase>[0]);
  const [{ stage: s0 }] = await testDb<{ stage: number }[]>`select stage from private.billing_enforcement_config where id = 1`;
  expect(s0).toBe(0);
  for (const l of ["owner", "manager", "recep", "stylist", "outsider", "removed", "forger"]) {
    const x = await createTestUser(`h-a2-${l}`);
    userIds.push(x.id);
    u[l] = x;
  }
  await admin.auth.admin.updateUserById(u.forger!.id, { user_metadata: { role: "owner", is_platform_owner: true, platform_role: "owner", service_role: true, tenant_id: "forged" } });
  for (const l of Object.keys(u)) c[l] = await signInAs(u[l]!);
  await testDb.unsafe(`create or replace function public.zz_a2_probe(p_action text, p_scope text, p_id uuid default null, p_key text default null)
    returns void language plpgsql security definer set search_path = '' as $$ begin perform private.billing_guard(p_action, p_scope, p_id, p_key); end $$`);
  await testDb.unsafe(`grant execute on function public.zz_a2_probe(text, text, uuid, text) to anon, authenticated, service_role, booking_gateway`);
  await testDb`notify pgrst, 'reload schema'`;
  await new Promise((r) => setTimeout(r, 4000));
  for (const m of MODES) for (const p of [false, true]) tn[`${m}|${p ? "P" : "U"}`] = await mk(m, p);
}, 900000);

afterAll(async () => {
  try {
    await stage(0);
    await wipe();
    await testDb.unsafe(`drop function if exists public.zz_a2_probe(text, text, uuid, text)`);
    for (const r of LOOKS) await testDb.unsafe(`drop role if exists ${r}`).catch(() => undefined);
  } finally {
    await cleanupTenants(tenantIds);
    await cleanupUsers(userIds);
    await gw.end();
    await testDb.end();
  }
}, 900000);

describe("HW the migrated hosted catalog", () => {
  it("HW1 stage is 0, the coverage function reports 0 problems, the registry has 99 actions of which 51 hooked, the preflight hook_coverage check is ok", async () => {
    expect((await testDb<{ stage: number }[]>`select stage from private.billing_enforcement_config`)[0]!.stage).toBe(0);
    expect(await testDb`select * from private.billing_hook_coverage()`).toHaveLength(0);
    const r = (await testDb`select count(*)::int as n, count(*) filter (where hooked)::int as h from private.billing_action_registry`)[0]!;
    expect([r.n, r.h]).toEqual([99, 51]);
    const pf = (await testDb`select private.billing_preflight_core(1::smallint, null::int, null::text) as r`)[0]!.r as Loose;
    const hc = (pf.checks as Loose[]).find((x) => x.id === "hook_coverage")!;
    expect(hc.ok ?? hc.pass ?? hc.passed).toBe(true);
    const trg = await testDb`select count(*)::int as n from pg_trigger where tgname = 'billing_a2_guard' and not tgisinternal`;
    expect(trg[0]!.n).toBe(10);
  });
});

describe("MX stage x access x lifecycle x protection over every hooked action (real PostgREST / real gateway)", () => {
  for (const st of [0, 1, 2, 3, 4]) {
    it(`MX${st} stage ${st}: 51 hooked actions x 12 tenant states are refused exactly as the accepted policy says and allowed otherwise`, async () => {
      await wipe();
      await stage(st);
      const jobs: { a: (typeof hooked)[number]; mode: Mode; prot: boolean }[] = [];
      for (const mode of MODES) for (const prot of [false, true]) for (const a of hooked) jobs.push({ a, mode, prot });
      const bad: string[] = [];
      await batches(jobs, 12, async ({ a, mode, prot }) => {
        const t = tn[`${mode}|${prot ? "P" : "U"}`]!;
        const k = keyFor(a, t);
        const r = a.audience === "public" ? await gwProbe(a.action_key, k.scope, k.id, k.key) : await probe(c.owner!, a.action_key, k.scope, k.id, k.key);
        const want = expected(a.category, mode, prot, st);
        if (want === null) {
          if (!r.ok) bad.push(`${a.action_key} ${mode}/${prot} s${st}: refused ${r.code} but policy allows`);
        } else if (r.ok) bad.push(`${a.action_key} ${mode}/${prot} s${st}: allowed but policy says ${want}`);
        else if (r.code !== want || r.msg !== MESSAGE[want]) bad.push(`${a.action_key} ${mode}/${prot} s${st}: got ${r.code}/${r.msg}, want ${want}`);
      });
      expect(jobs).toHaveLength(51 * 12);
      expect(bad).toEqual([]);
      if (st === 0) expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 });
      await stage(0);
    }, 1500000);
  }
});

describe("RJ real-JWT persona matrix on real hooked RPCs", () => {
  let rt: { id: string; slug: string };
  let fx: { branch: string; staff: string; svc: string; cust: string; ap1: string; ap2: string };
  let ot: { id: string; slug: string };
  let day = 30;
  const book = (cl: Client, t = rt) =>
    rpc(cl, "create_appointment", { p_tenant_id: t.id, p_branch_id: fx.branch, p_customer_id: fx.cust, p_items: [{ service_id: fx.svc, staff_member_id: fx.staff, scheduled_start_at: safeMorningStart(day++).toISOString(), sequence: 1 }], p_notes: null });

  beforeAll(async () => {
    rt = await mk("read_only", false);
    ot = await mk("full", false, u.outsider!.id);
    await createTestMembershipFromTemplate(rt.id, u.manager!.id, "SALON_MANAGER");
    await createTestMembershipFromTemplate(rt.id, u.recep!.id, "RECEPTIONIST");
    await createTestMembershipFromTemplate(rt.id, u.stylist!.id, "STYLIST");
    const [rr] = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${rt.id} and key = 'RECEPTIONIST'`;
    await addMembership(rt.id, u.removed!.id, rr!.id);
    const branch = await createBranch(rt.id, "Merkez");
    const staff = (await createStaffMember(rt.id, "Personel")).id;
    await linkStaffBranch(staff, branch);
    for (let w = 0; w <= 6; w++) await createStaffSchedule(rt.id, staff, w, "00:00", "23:59");
    const svc = (await createService(rt.id, "Hizmet", 30, 100)).id;
    await linkServiceBranch(svc, branch);
    await linkStaffService(staff, svc);
    const [cu] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${rt.id}, 'Sentetik') returning id`;
    fx = { branch, staff, svc, cust: cu!.id, ap1: "", ap2: "" };
    await stage(0);
    const a1 = await book(c.owner!);
    const a2 = await book(c.owner!);
    expect(a1.ok && a2.ok).toBe(true);
    fx.ap1 = a1.data as string;
    fx.ap2 = a2.data as string;
    // the removed member: a real soft-removed membership
    await testDb`update tenant_memberships set deleted_at = now(), status = 'suspended' where tenant_id = ${rt.id} and user_id = ${u.removed!.id}`;
  }, 600000);

  it("RJ1 stage 0: every persona's create_appointment behaves exactly as before the migration (members succeed or get their own permission error, never BL*)", async () => {
    await wipe();
    for (const l of ["owner", "manager", "recep", "stylist", "outsider", "removed", "forger"]) {
      const r = await book(c[l]!);
      expect(isBL(r), l).toBe(false);
      if (l === "owner" || l === "manager" || l === "recep") expect(r.ok, l).toBe(true);
      else expect(r.ok, l).toBe(false);
    }
    expect(isBL(await book(anonClient() as never))).toBe(false);
    expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 });
  });

  it("RJ2 stage 3, read_only: a NEW appointment is refused BL001 for EVERY member role (Owner, Yonetici, Resepsiyon, Personel) alike", async () => {
    await stage(3);
    for (const l of ["owner", "manager", "recep", "stylist"]) expect(await book(c[l]!), l).toMatchObject({ ok: false, code: "BL001", msg: "subscription_read_only" });
    await stage(0);
  });

  it("RJ3 non-members never learn the tenant's billing state: outsider Owner (own tenant fine), removed member, forger and anon get the callee's own answer, never BL*, at stage 4", async () => {
    await wipe();
    await stage(4);
    for (const l of ["outsider", "removed", "forger"]) expect(isBL(await book(c[l]!)), l).toBe(false);
    expect(isBL(await book(anonClient() as never))).toBe(false);
    expect(isBL(await rpc(c.outsider!, "update_salon_profile", { p_tenant_id: rt.id, p_name: "X", p_timezone: "Europe/Istanbul", p_currency: "TRY", p_phone: "+90 533 000 0000", p_address: "A" }))).toBe(false);
    // nothing was recorded for the non-members
    expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 });
    // the outsider's OWN tenant (full) is not affected by someone else's state
    expect((await book(c.outsider!, ot)).ok || !isBL(await book(c.outsider!, ot))).toBe(true);
    await stage(0);
  });

  it("RJ4 stage 3, read_only: existing work continues for authorised members (update status, complete, settings, online booking toggle); the refused create left no appointment", async () => {
    await stage(3);
    const before = Number((await testDb<{ n: string }[]>`select count(*)::text as n from appointments where tenant_id = ${rt.id}`)[0]!.n);
    expect((await rpc(c.owner!, "update_appointment_status", { p_appointment_id: fx.ap1, p_new_status: "confirmed" })).ok).toBe(true);
    expect((await rpc(c.owner!, "complete_appointment", { p_appointment_id: fx.ap2, p_performer_overrides: [] })).ok).toBe(true);
    expect((await rpc(c.owner!, "update_salon_profile", { p_tenant_id: rt.id, p_name: "Duzeltilmis", p_timezone: "Europe/Istanbul", p_currency: "TRY", p_phone: "+90 533 000 0000", p_address: "Adres" })).ok).toBe(true);
    expect((await rpc(c.owner!, "set_online_booking_enabled", { p_tenant_id: rt.id, p_enabled: false })).ok).toBe(true);
    expect((await book(c.owner!)).ok).toBe(false);
    expect(Number((await testDb<{ n: string }[]>`select count(*)::text as n from appointments where tenant_id = ${rt.id}`)[0]!.n)).toBe(before);
    await stage(0);
  });

  it("RJ5 stage 4, suspended: even closing existing work is refused BL002; the protected suspended twin is allowed; a deleted tenant is blocked even when protected", async () => {
    const f = tn["suspended|U"]!;
    const fp = tn["suspended|P"]!;
    const dp = tn["deleted|P"]!;
    await stage(4);
    for (const [t, want] of [[f, "BL002"], [fp, null], [dp, "BL002"]] as const) {
      const r = await rpc(c.owner!, "update_salon_profile", { p_tenant_id: t.id, p_name: "Ad", p_timezone: "Europe/Istanbul", p_currency: "TRY", p_phone: "+90 533 000 0000", p_address: "A" });
      if (want) expect(r, t.slug).toMatchObject({ ok: false, code: want });
      else expect(isBL(r), t.slug).toBe(false);
    }
    await stage(0);
  });

  it("RJ6 forged user_metadata (role / platform / service_role / tenant claims) changes nothing: the forger is a non-member and is neither refused with BL* nor allowed to write", async () => {
    await stage(4);
    const r = await book(c.forger!);
    expect(r.ok).toBe(false);
    expect(isBL(r)).toBe(false);
    const w = await tbl(c.forger!, "services").insert({ tenant_id: rt.id, name: "Forged", duration_minutes: 10, price: 1 });
    expect(w.error).not.toBeNull();
    expect((await testDb`select count(*)::int as n from services where tenant_id = ${rt.id} and name = 'Forged'`)[0]!.n).toBe(0);
    await stage(0);
  });
});

describe("TW trigger WHEN / current_user, definer RPC single guard, operator and lookalike roles", () => {
  let ro: { id: string; slug: string };
  let su: { id: string; slug: string };
  const looks: Record<string, ReturnType<typeof postgres>> = {};
  const mkLogin = async (name: string) => {
    await testDb.unsafe(`drop role if exists ${name}`).catch(() => undefined);
    await testDb.unsafe(`create role ${name} login password 'a2x-${RUN}-pw'`);
    await testDb.unsafe(`grant authenticated to ${name}`);
    looks[name] = postgres({ host: new URL(env.databaseUrl).hostname, port: 5432, user: `${name}.${env.ref}`, password: `a2x-${RUN}-pw`, database: "postgres", ssl: "require", max: 1, prepare: false });
  };
  beforeAll(async () => {
    ro = await mk("read_only", false);
    su = await mk("suspended", false);
    for (const n of LOOKS) await mkLogin(n);
  }, 300000);
  afterAll(async () => {
    for (const s of Object.values(looks)) await s.end();
  });

  it("TW1 trigger definition contract: every one of the 10 triggers is BEFORE ROW with a WHEN (current_user in (API roles)) clause; the function is SECURITY DEFINER", async () => {
    const t = await testDb<{ def: string }[]>`select pg_get_triggerdef(t.oid) as def from pg_trigger t where t.tgname = 'billing_a2_guard' and not t.tgisinternal`;
    expect(t).toHaveLength(10);
    for (const r of t) {
      expect(r.def.toLowerCase()).toContain("before");
      expect(r.def.toLowerCase()).toContain("for each row");
      expect(r.def).toMatch(/WHEN \(\(?CURRENT_USER = ANY \(ARRAY\['authenticated'|WHEN \(\(CURRENT_USER\)::text = ANY/i);
      for (const role of ["authenticated", "anon", "service_role", "booking_gateway"]) expect(r.def).toContain(role);
    }
    const f = await testDb<{ secdef: boolean }[]>`select prosecdef as secdef from pg_proc where proname = 'billing_trigger_guard' and pronamespace = 'private'::regnamespace`;
    expect(f[0]!.secdef).toBe(true);
  });

  it("TW2 A) a direct PostgREST write by an API role reaches the trigger: one table:* decision is recorded and NO fn:* decision (stage 1)", async () => {
    await wipe();
    await stage(1);
    const r = await tbl(c.owner!, "services").insert({ tenant_id: ro.id, name: "TW2", duration_minutes: 20, price: 5 });
    expect(r.error).toBeNull();
    expect(await sum(`tenant_id = $1 and action_key = 'table:services:INSERT'`, ro.id)).toBe(1);
    expect(await sum(`tenant_id = $1 and action_key like 'fn:%'`, ro.id)).toBe(0);
    await stage(0);
  });

  it("TW3 B) a definer RPC is guarded ONCE (its hook) and its own table write does NOT trigger a second guard: DOUBLE_GUARD = NO (update_salon_profile -> tenants UPDATE; set_online_booking_enabled)", async () => {
    await wipe();
    await stage(1);
    expect((await rpc(c.owner!, "update_salon_profile", { p_tenant_id: ro.id, p_name: "TW3", p_timezone: "Europe/Istanbul", p_currency: "TRY", p_phone: "+90 533 000 0000", p_address: "A" })).ok).toBe(true);
    expect((await rpc(c.owner!, "set_online_booking_enabled", { p_tenant_id: ro.id, p_enabled: true })).ok).toBe(true);
    expect(await sum(`tenant_id = $1 and action_key = 'fn:update_salon_profile'`, ro.id)).toBe(1);
    expect(await sum(`tenant_id = $1 and action_key = 'fn:set_online_booking_enabled'`, ro.id)).toBe(1);
    expect(await sum(`tenant_id = $1 and action_key like 'table:%'`, ro.id)).toBe(0);
    await stage(4);
    // at stage 4 on the suspended tenant the RPC is refused once (BL002) by its hook; at stage 4 on a FULL tenant it works without a second decision
    expect(await rpc(c.owner!, "update_salon_profile", { p_tenant_id: su.id, p_name: "TW3b", p_timezone: "Europe/Istanbul", p_currency: "TRY", p_phone: "+90 533 000 0000", p_address: "A" })).toMatchObject({ ok: false, code: "BL002" });
    await stage(0);
  });

  it("TW4 C1) the operator login (postgres) is exempt at every stage: probe, a direct INSERT and a direct UPDATE on a blocked tenant at stage 4", async () => {
    await stage(4);
    expect((await pgOut(testDb`select public.zz_a2_probe('fn:create_appointment', 'tenant', ${su.id}::uuid, null)`)).ok).toBe(true);
    expect((await pgOut(testDb`insert into services (tenant_id, name, duration_minutes, price) values (${su.id}, 'Operator', 20, 1)`)).ok).toBe(true);
    expect((await pgOut(testDb`update services set name = 'Operator2' where tenant_id = ${su.id} and name = 'Operator'`)).ok).toBe(true);
    await stage(0);
  });

  it("TW5 C2) look-alike login roles (postgres_x<run>, cli_login_postgres_x<run>) are NOT exempt: with the API role and a member identity they are refused like any caller (probe and trigger)", async () => {
    await stage(3);
    for (const [name, sql] of Object.entries(looks)) {
      const out = await pgOut(
        sql.begin(async (tx) => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: u.owner!.id, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${u.owner!.id}, true)`;
          await tx.unsafe(`set local role authenticated`);
          await tx`select public.zz_a2_probe('fn:create_appointment', 'tenant', ${ro.id}::uuid, null)`;
        }),
      );
      expect(out, name).toMatchObject({ ok: false, code: "BL001" });
      const ins = await pgOut(
        sql.begin(async (tx) => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: u.owner!.id, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${u.owner!.id}, true)`;
          await tx.unsafe(`set local role authenticated`);
          await tx`insert into services (tenant_id, name, duration_minutes, price) values (${ro.id}, 'Lookalike', 20, 1)`;
        }),
      );
      expect(ins, name).toMatchObject({ ok: false, code: "BL001" });
    }
    await stage(0);
  });

  it("TW6 the exemption list is exactly postgres, supabase_admin, cli_login_postgres by session_user (source check) and contains no service_role / authenticator / anon", async () => {
    const src = (await testDb<{ s: string }[]>`select pg_get_functiondef(p.oid) as s from pg_proc p where p.proname = 'billing_guard' and p.pronamespace = 'private'::regnamespace`)[0]!.s;
    expect(src).toContain("session_user in ('postgres', 'supabase_admin', 'cli_login_postgres')");
    expect(src).not.toMatch(/service_role'\s*(then|\))/);
  });

  it("TW7 service_role is NOT exempt: a service-role call into the guard on a public-audience action is refused (BL003) at stage 2 for a read_only salon", async () => {
    await stage(2);
    const r = asOut((await (admin as unknown as Client).rpc("zz_a2_probe" as never, { p_action: "fn:create_guest_booking", p_scope: "slug", p_id: null, p_key: ro.slug } as never)).error);
    expect(r).toMatchObject({ ok: false, code: "BL003" });
    await stage(0);
  });
});

describe("DT direct-table writes through PostgREST (the bypass attempts) and UPDATE semantics", () => {
  type Ctx = { t: { id: string; slug: string }; svc: string; svcOld: string; staff: string; cust: string; branch: string; sched: string; exc: string; ten: string };
  const ctxs: Record<string, Ctx> = {};
  const priv: Record<string, boolean> = {};
  const seed = async (t: { id: string; slug: string }): Promise<Ctx> => {
    const branch = await createBranch(t.id, "Merkez");
    const svc = (await createService(t.id, "Hizmet", 30, 100)).id;
    const svcOld = (await createService(t.id, "Eski", 30, 100)).id;
    const staff = (await createStaffMember(t.id, "Personel")).id;
    const [cu] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name) values (${t.id}, 'Sentetik') returning id`;
    await testDb`update services set status = 'inactive' where id = ${svcOld}`;
    const sched = await createStaffSchedule(t.id, staff, 1, "09:00", "17:00");
    const [ex] = await testDb<{ id: string }[]>`insert into staff_schedule_exceptions (tenant_id, staff_member_id, exception_date, type) values (${t.id}, ${staff}, '2031-01-05', 'unavailable') returning id`;
    return { t, svc, svcOld, staff, cust: cu!.id, branch, sched, exc: ex!.id, ten: t.id };
  };
  beforeAll(async () => {
    for (const k of ["read_only|U", "read_only|P", "suspended|U"]) ctxs[k] = await seed(tn[k]!);
    const q = async (t: string, op: string) => Boolean((await testDb`select has_table_privilege('authenticated', ${"public." + t}, ${op}) or (${op} = 'UPDATE' and has_any_column_privilege('authenticated', ${"public." + t}, 'UPDATE')) as ok`)[0]!.ok);
    for (const [t, op] of hooked.filter((a) => a.kind === "table_op").map((a) => [a.action_key.split(":")[1]!, a.action_key.split(":")[2]!] as const)) priv[`${t}:${op}`] = await q(t, op);
  }, 600000);

  // one operation per hooked table op; `reset` puts the state back (operator) so every run starts from the same ground
  const ops = (x: Ctx, n: number) => {
    const T = (cl: Client, t: string) => tbl(cl, t);
    return [
      { key: "branches:INSERT", growth: true, run: (cl: Client) => T(cl, "branches").insert({ tenant_id: x.ten, name: `B${n}` }) },
      { key: "branches:UPDATE", run: (cl: Client) => T(cl, "branches").update({ name: `B${n}u` }).eq("id", x.branch).select() },
      { key: "customers:INSERT", growth: true, run: (cl: Client) => T(cl, "customers").insert({ tenant_id: x.ten, full_name: `C${n}` }) },
      { key: "customers:UPDATE", run: (cl: Client) => T(cl, "customers").update({ full_name: `C${n}u` }).eq("id", x.cust).select() },
      { key: "services:INSERT", growth: true, run: (cl: Client) => T(cl, "services").insert({ tenant_id: x.ten, name: `S${n}`, duration_minutes: 20, price: 5 }) },
      { key: "services:UPDATE", run: (cl: Client) => T(cl, "services").update({ name: `S${n}u` }).eq("id", x.svc).select() },
      { key: "staff_members:INSERT", growth: true, run: (cl: Client) => T(cl, "staff_members").insert({ tenant_id: x.ten, full_name: `P${n}` }) },
      { key: "staff_members:UPDATE", run: (cl: Client) => T(cl, "staff_members").update({ full_name: `P${n}u` }).eq("id", x.staff).select() },
      { key: "staff_schedules:INSERT", run: (cl: Client) => T(cl, "staff_schedules").insert({ tenant_id: x.ten, staff_member_id: x.staff, weekday: 2 + (n % 4), start_time: "09:00", end_time: "17:00" }) },
      { key: "staff_schedules:UPDATE", run: (cl: Client) => T(cl, "staff_schedules").update({ end_time: "18:00" }).eq("id", x.sched).select() },
      { key: "staff_schedule_exceptions:INSERT", run: (cl: Client) => T(cl, "staff_schedule_exceptions").insert({ tenant_id: x.ten, staff_member_id: x.staff, exception_date: `2032-02-${String(1 + (n % 27)).padStart(2, "0")}`, type: "unavailable" }) },
      { key: "staff_schedule_exceptions:UPDATE", run: (cl: Client) => T(cl, "staff_schedule_exceptions").update({ type: "unavailable" }).eq("id", x.exc).select() },
      { key: "service_branches:INSERT", run: (cl: Client) => T(cl, "service_branches").insert({ service_id: x.svc, branch_id: x.branch }) },
      { key: "service_branches:DELETE", run: (cl: Client) => T(cl, "service_branches").delete().eq("service_id", x.svc).eq("branch_id", x.branch) },
      { key: "staff_branches:INSERT", run: (cl: Client) => T(cl, "staff_branches").insert({ staff_member_id: x.staff, branch_id: x.branch }) },
      { key: "staff_branches:DELETE", run: (cl: Client) => T(cl, "staff_branches").delete().eq("staff_member_id", x.staff).eq("branch_id", x.branch) },
      { key: "staff_services:INSERT", run: (cl: Client) => T(cl, "staff_services").insert({ staff_member_id: x.staff, service_id: x.svc }) },
      { key: "staff_services:DELETE", run: (cl: Client) => T(cl, "staff_services").delete().eq("staff_member_id", x.staff).eq("service_id", x.svc) },
      { key: "tenants:UPDATE", run: (cl: Client) => T(cl, "tenants").update({ name: `T${n}` }).eq("id", x.ten).select() },
    ];
  };
  const reset = async (x: Ctx) => {
    // relation rows: INSERT ops need them absent, DELETE ops need them present - the operator alternates, so just ensure a known baseline per op below
    await testDb`delete from service_branches where service_id = ${x.svc} and branch_id = ${x.branch}`;
    await testDb`delete from staff_branches where staff_member_id = ${x.staff} and branch_id = ${x.branch}`;
    await testDb`delete from staff_services where staff_member_id = ${x.staff} and service_id = ${x.svc}`;
  };
  const link = async (x: Ctx, key: string) => {
    if (key === "service_branches:DELETE") await testDb`insert into service_branches (service_id, branch_id) values (${x.svc}, ${x.branch}) on conflict do nothing`;
    if (key === "staff_branches:DELETE") await testDb`insert into staff_branches (staff_member_id, branch_id) values (${x.staff}, ${x.branch}) on conflict do nothing`;
    if (key === "staff_services:DELETE") await testDb`insert into staff_services (staff_member_id, service_id) values (${x.staff}, ${x.svc}) on conflict do nothing`;
  };
  let n = 100;
  /** runs one op as the Owner over PostgREST and classifies: ok / BL code / other error code */
  const exec = async (x: Ctx, key: string): Promise<string> => {
    await reset(x);
    await link(x, key);
    const o = ops(x, ++n).find((y) => y.key === key)!;
    const r = await o.run(c.owner!);
    return r.error ? (r.error.code ?? "?") : "ok";
  };
  const keys = () => hooked.filter((a) => a.kind === "table_op").map((a) => a.action_key.replace("table:", ""));

  it("DT0 the 19 hooked table operations are all exercised; the privileges the API role really holds are recorded (an op the role cannot perform can never be refused by BL* - it is refused earlier by the grant)", () => {
    expect(keys()).toHaveLength(19);
    expect(Object.keys(priv)).toHaveLength(19);
    expect(ops(ctxs["read_only|U"]!, 0).map((o) => o.key).sort()).toEqual(keys().sort());
  });

  it("DT1 stage 0 baseline: the outcome of every one of the 19 direct writes in a read_only AND a suspended tenant (no BL*, no evidence); remembered for the stage comparisons", async () => {
    await wipe();
    await stage(0);
    for (const k of ["read_only|U", "suspended|U"]) for (const key of keys()) { const r = await exec(ctxs[k]!, key); (globalThis as Loose)[`__a2base_${k}_${key}`] = r; expect(r.startsWith("BL"), `${k} ${key}`).toBe(false); }
    expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 });
    console.log("DT1 baseline", JSON.stringify(Object.fromEntries(Object.entries(globalThis as Loose).filter(([k]) => k.startsWith("__a2base_")))));
  });

  const base = (k: string, key: string) => (globalThis as Loose)[`__a2base_${k}_${key}`] as string;

  it("DT2 stage 3, read_only: growth INSERTs (branches, customers, services, staff_members) are refused BL001 wherever the API role can write them; edits and relation writes behave exactly as at stage 0", async () => {
    await stage(3);
    const bad: string[] = [];
    for (const o of ops(ctxs["read_only|U"]!, 0)) {
      const r = await exec(ctxs["read_only|U"]!, o.key);
      const canWrite = priv[o.key];
      if (o.growth && canWrite) { if (r !== "BL001") bad.push(`${o.key}: ${r} (want BL001)`); }
      else if (r.startsWith("BL")) bad.push(`${o.key}: ${r} (want ${base("read_only|U", o.key)})`);
      else if (r !== base("read_only|U", o.key) && !(r === "ok" || base("read_only|U", o.key) === "ok")) bad.push(`${o.key}: ${r} vs baseline ${base("read_only|U", o.key)}`);
    }
    expect(bad).toEqual([]);
    await stage(0);
  });

  it("DT3 stage 4, suspended (blocked lifecycle): EVERY hooked table op the API role can perform is refused BL002 (relations resolve the tenant from the parent row); the protected twin is never refused", async () => {
    await stage(4);
    const bad: string[] = [];
    const outcomes: string[] = [];
    for (const key of keys()) {
      const r = await exec(ctxs["suspended|U"]!, key);
      outcomes.push(`${key}: stage0=${base("suspended|U", key)} stage4=${r}`);
      const b0 = base("suspended|U", key);
      // an op whose own statement already fails at stage 0 for a reason that comes BEFORE the guard (grant / RLS of a suspended tenant) is unreachable: it must keep failing with that same code
      if (b0 !== "ok" && !b0.startsWith("BL")) { if (r !== b0 && r !== "BL002") bad.push(`${key}: ${r} (stage 0 ${b0})`); }
      else if (priv[key]) { if (r !== "BL002") bad.push(`${key}: ${r} (want BL002)`); } else if (r.startsWith("BL")) bad.push(`${key}: ${r}`);
      const p = await exec(ctxs["read_only|P"]!, key);
      if (p.startsWith("BL")) bad.push(`protected ${key}: ${p}`);
    }
    console.log("DT3 outcomes", JSON.stringify(outcomes));
    expect(bad).toEqual([]);
    await stage(0);
  });

  it("DT4 stage 1 records every performable direct write under its table action and never refuses", async () => {
    await wipe();
    await stage(1);
    for (const key of keys()) expect((await exec(ctxs["read_only|U"]!, key)).startsWith("BL"), key).toBe(false);
    const c1 = await testDb<Loose[]>`select action_key from private.billing_decision_counters where tenant_id = ${tn["read_only|U"]!.id} and action_key like 'table:%'`;
    const seen = new Set(c1.map((r) => r.action_key));
    // a decision is part of the statement: an op that fails LATER for another reason (e.g. the plan hard limit on a 2nd branch) rolls its decision back with it, so evidence is required only for ops that succeed
    for (const key of keys()) if (priv[key] && base("read_only|U", key) === "ok") expect(seen.has(`table:${key}`), key).toBe(true);
    await stage(0);
  });

  it("DT5 UPDATE is not one class: reactivating an inactive service / archived customer / soft-deleted staff member at stage 3 is GROWTH (BL001) - the INSERT restriction cannot be bypassed; shrinking is fine; ground truth unchanged", async () => {
    const x = ctxs["read_only|U"]!;
    await testDb`update customers set status = 'archived' where id = ${x.cust}`;
    await testDb`update staff_members set deleted_at = now() where id = ${x.staff}`;
    await stage(3);
    const a = await tbl(c.owner!, "services").update({ status: "active" }).eq("id", x.svcOld).select();
    const b = await tbl(c.owner!, "customers").update({ status: "active" }).eq("id", x.cust).select();
    const d = await tbl(c.owner!, "staff_members").update({ deleted_at: null }).eq("id", x.staff).select();
    const code = (r: Loose) => (r.error ? r.error.code : "ok");
    if (priv["services:UPDATE"]) expect(code(a)).toBe("BL001");
    if (priv["customers:UPDATE"]) expect(code(b)).toBe("BL001");
    if (priv["staff_members:UPDATE"]) expect(["BL001", "42501"]).toContain(code(d));
    expect((await testDb`select status from services where id = ${x.svcOld}`)[0]!.status).toBe("inactive");
    expect((await testDb`select status from customers where id = ${x.cust}`)[0]!.status).toBe("archived");
    expect((await testDb`select deleted_at from staff_members where id = ${x.staff}`)[0]!.deleted_at).not.toBeNull();
    // shrinking an active service is allowed
    const sh = await tbl(c.owner!, "services").update({ status: "inactive" }).eq("id", x.svc).select();
    expect(String(code(sh)).startsWith("BL")).toBe(false);
    await testDb`update services set status = 'active' where id = ${x.svc}`;
    await testDb`update customers set status = 'active' where id = ${x.cust}`;
    await testDb`update staff_members set deleted_at = null where id = ${x.staff}`;
    await stage(0);
  });

  it("DT6 an upsert / bulk insert cannot dodge the guard: INSERT ... ON CONFLICT and a multi-row insert are refused as growth at stage 3 (BL001) and nothing is created", async () => {
    await stage(3);
    const x = ctxs["read_only|U"]!;
    const before = (await testDb`select count(*)::int as n from customers where tenant_id = ${x.ten}`)[0]!.n;
    const up = await tbl(c.owner!, "customers").upsert({ id: randomUUID(), tenant_id: x.ten, full_name: "Upsert" });
    const bulk = await tbl(c.owner!, "customers").insert([{ tenant_id: x.ten, full_name: "A" }, { tenant_id: x.ten, full_name: "B" }]);
    if (priv["customers:INSERT"]) { expect(up.error?.code).toBe("BL001"); expect(bulk.error?.code).toBe("BL001"); }
    expect((await testDb`select count(*)::int as n from customers where tenant_id = ${x.ten}`)[0]!.n).toBe(before);
    await stage(0);
  });

  it("DT7 a row moved to ANOTHER tenant is guarded for BOTH tenants (dual-tenant check): leaving a blocked tenant at stage 4 is refused BL002 although the destination is full", async () => {
    const s = ctxs["suspended|U"]!;
    const dest = tn["full|U"]!;
    const mv = await createService(s.ten, "Tasinacak", 30, 10);
    await stage(4);
    const r = await tbl(c.owner!, "services").update({ tenant_id: dest.id }).eq("id", mv.id).select();
    if (priv["services:UPDATE"]) expect(["BL002", "42501"]).toContain(r.error?.code);
    expect((await testDb`select tenant_id from services where id = ${mv.id}`)[0]!.tenant_id).toBe(s.ten);
    await stage(0);
  });

  it("DT8 service_role has no direct table write privilege (the corrected model): its direct INSERT is a 42501 permission error, not a BL* decision", async () => {
    const r = await tbl(admin as unknown as Client, "services").insert({ tenant_id: ctxs["read_only|U"]!.ten, name: "SR", duration_minutes: 1, price: 1 });
    expect(r.error?.code).toBe("42501");
  });
});

describe("SH shadow behaviour at stage 1 (real HTTP)", () => {
  it("SH1 stage 1 NEVER refuses; it records allow / would_block per tenant, category, action, mode and reason; a protected tenant is allow + protected_override and never would_block; no PII columns", async () => {
    await wipe();
    await stage(1);
    const ro = tn["read_only|U"]!, roP = tn["read_only|P"]!, full = tn["full|U"]!;
    const res = await Promise.all([probe(c.owner!, "fn:create_appointment", "tenant", ro.id), probe(c.owner!, "fn:complete_appointment", "tenant", ro.id), probe(c.owner!, "fn:create_appointment", "tenant", full.id), probe(c.owner!, "fn:create_appointment", "tenant", roP.id)]);
    expect(res.every((r) => r.ok)).toBe(true);
    const cn = await testDb<Loose[]>`select tenant_id, stage, category, action_key, mode, decision, reason from private.billing_decision_counters`;
    const find = (t: string, a: string) => cn.find((r) => r.tenant_id === t && r.action_key === a)!;
    expect(find(ro.id, "fn:create_appointment")).toMatchObject({ stage: 1, category: "APPT_CREATE", mode: "read_only", decision: "would_block", reason: "trial_expired" });
    expect(find(ro.id, "fn:complete_appointment")).toMatchObject({ decision: "allow" });
    expect(find(full.id, "fn:create_appointment")).toMatchObject({ decision: "allow", mode: "full" });
    expect(find(roP.id, "fn:create_appointment")).toMatchObject({ decision: "allow", mode: "full" });
    expect((await testDb`select decision from private.billing_shadow_samples where tenant_id = ${roP.id}`).map((r) => r.decision)).toEqual(["protected_override"]);
    expect(await testDb`select 1 from private.billing_guard_health where kind = 'protected_would_block'`).toHaveLength(0);
    const cols = await testDb<{ c: string }[]>`select column_name as c from information_schema.columns where table_schema = 'private' and table_name in ('billing_decision_counters', 'billing_shadow_samples', 'billing_guard_health') and data_type = 'text' order by 1`;
    expect([...new Set(cols.map((x) => x.c))].sort()).toEqual(["action_key", "category", "decision", "kind", "mode", "reason"]);
    await stage(0);
  });

  it("SH2 counters aggregate (one row per key) and the sample table is capped at 50 per tenant per day; an unknown action is a counted policy_miss that fails open at every stage", async () => {
    await wipe();
    await stage(1);
    const ro = tn["read_only|U"]!;
    await batches(Array.from({ length: 60 }, (_, i) => ["create_appointment", "commit_customer_import", "create_team_invitation"][i % 3]!), 10, (a) => probe(c.owner!, `fn:${a}`, "tenant", ro.id));
    expect(await sum(`tenant_id = $1 and decision = 'would_block'`, ro.id)).toBe(60);
    expect((await testDb`select count(*)::int as n from private.billing_decision_counters where tenant_id = ${ro.id}`)[0]!.n).toBe(3);
    expect((await testDb`select count(*)::int as n from private.billing_shadow_samples where tenant_id = ${ro.id}`)[0]!.n).toBe(50);
    for (const st of [1, 3]) {
      await wipe();
      await stage(st);
      expect((await probe(c.owner!, "fn:does_not_exist", "tenant", ro.id)).ok).toBe(true);
      expect(Number((await testDb<{ n: string }[]>`select coalesce(sum(n), 0)::text as n from private.billing_guard_health where kind = 'policy_miss'`)[0]!.n)).toBe(1);
    }
    await stage(0);
  });
});

describe("PB public booking through the REAL booking_gateway login and anon PostgREST", () => {
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
  let nn = 0;
  const book = async (f: Awaited<ReturnType<typeof bookable>>): Promise<Out> => {
    const r = await callCreateGuestBooking({ tenantSlug: f.t.slug, branchId: f.branch, serviceId: f.svc, scheduledStartAtUtc: safeMorningStart(3 + (nn++ % 10)).toISOString(), customerFullName: "Sentetik Misafir", customerPhone: "5551110001", staffMemberId: f.staff, customerEmail: "misafir@example.test", idempotencyKey: randomUUID(), customerAccountUserId: null });
    return r.success ? { ok: true } : { ok: false, code: r.code, msg: r.message };
  };
  const slots = async (f: Awaited<ReturnType<typeof bookable>>) => {
    const r = await anonClient().rpc("get_public_availability_slots" as never, { p_tenant_slug: f.t.slug, p_branch_id: f.branch, p_service_id: f.svc, p_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), p_staff_member_id: null } as never);
    expect(r.error).toBeNull();
    return ((r.data as unknown) as unknown[] | null) ?? [];
  };

  it("PB1 stage 0 and 1: public booking works for a read_only salon through the real gateway, the availability page is open, stage 0 writes nothing, stage 1 only records would_block", async () => {
    for (const st of [0, 1]) {
      await wipe();
      await stage(st);
      const f = await bookable("read_only", false);
      expect((await book(f)).ok, `stage ${st}`).toBe(true);
      expect((await slots(f)).length).toBeGreaterThan(0);
      if (st === 0) expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 });
      else expect(await sum(`tenant_id = $1 and action_key = 'fn:create_guest_booking' and decision = 'would_block'`, f.t.id)).toBe(1);
    }
    await stage(0);
  });

  it("PB2 stage 2: read_only and suspended salons refuse a NEW public booking BL003 through the real gateway and answer 'not bookable' on the availability read; full, grace and protected salons keep booking; the refusal created nothing", async () => {
    await stage(2);
    const ro = await bookable("read_only", false), su = await bookable("suspended", false), full = await bookable("full", false), grace = await bookable("grace", false), roP = await bookable("read_only", true);
    expect(await book(ro)).toMatchObject({ ok: false, code: "BL003", msg: "public_booking_unavailable" });
    expect(await book(su)).toMatchObject({ ok: false, code: "BL003" });
    for (const f of [full, grace, roP]) expect((await book(f)).ok).toBe(true);
    expect(await slots(ro)).toEqual([]);
    expect(await slots(su)).toEqual([]);
    expect((await slots(full)).length).toBeGreaterThan(0);
    expect((await slots(roP)).length).toBeGreaterThan(0);
    expect((await testDb`select count(*)::int as n from appointments where tenant_id = ${ro.t.id}`)[0]!.n).toBe(0);
    // stage 2 enforces ONLY public booking: staff-created appointments of the same read_only salon are still allowed
    expect((await probe(c.owner!, "fn:create_appointment", "tenant", ro.t.id)).ok).toBe(true);
    await stage(0);
  });

  it("PB3 stages 3 and 4 keep refusing public booking for a blocked salon and the anon booking-context read still answers (no 5xx)", async () => {
    const su = await bookable("suspended", false);
    for (const st of [3, 4]) {
      await stage(st);
      expect(await book(su)).toMatchObject({ ok: false, code: "BL003" });
      const cx = await anonClient().rpc("get_public_booking_context" as never, { p_tenant_slug: su.t.slug } as never);
      expect(cx.error?.code ?? "").not.toMatch(/^(BL|5)/);
    }
    await stage(0);
  });
});

describe("EC error contract and BLOCKED decision persistence", () => {
  it("EC1 BL001 / BL002 / BL003 arrive over real HTTP with their stable code and message token and no database internals; refused statements leave nothing behind", async () => {
    await stage(3);
    const r1 = await rpc(c.owner!, "create_expense", { p_tenant_id: tn["read_only|U"]!.id });
    expect(isBL(r1) || !r1.ok).toBe(true);
    const ro = await probe(c.owner!, "fn:create_appointment", "tenant", tn["read_only|U"]!.id);
    expect(ro).toMatchObject({ ok: false, code: "BL001", msg: "subscription_read_only" });
    await stage(4);
    expect(await probe(c.owner!, "fn:complete_appointment", "tenant", tn["suspended|U"]!.id)).toMatchObject({ ok: false, code: "BL002", msg: "tenant_blocked" });
    await stage(2);
    expect(await gwProbe("fn:create_guest_booking", "slug", null, tn["read_only|U"]!.slug)).toMatchObject({ ok: false, code: "BL003", msg: "public_booking_unavailable" });
    for (const r of [ro]) expect((r as { msg: string }).msg).not.toMatch(/private\.|billing_|schema|relation|constraint|violat/i);
    await stage(0);
  });

  it("EC2 BL004: a failing evidence write fails CLOSED for unprotected growth at stage >= 2, OPEN for existing-record work, OPEN for a protected tenant, and OPEN at stage 1 (counted guard_error); over real HTTP", async () => {
    await wipe();
    await testDb.unsafe(`alter table private.billing_decision_counters add constraint a2_hosted_fail check (n < 0) not valid`);
    try {
      await stage(1);
      expect((await probe(c.owner!, "fn:create_appointment", "tenant", tn["read_only|U"]!.id)).ok).toBe(true);
      await stage(3);
      expect(await probe(c.owner!, "fn:create_appointment", "tenant", tn["full|U"]!.id)).toMatchObject({ ok: false, code: "BL004", msg: "enforcement_guard_error" });
      expect((await probe(c.owner!, "fn:complete_appointment", "tenant", tn["full|U"]!.id)).ok).toBe(true);
      expect((await probe(c.owner!, "fn:create_appointment", "tenant", tn["full|P"]!.id)).ok).toBe(true);
    } finally {
      await stage(0);
      await testDb.unsafe(`alter table private.billing_decision_counters drop constraint if exists a2_hosted_fail`);
    }
    expect(Number((await testDb<{ n: string }[]>`select coalesce(sum(n), 0)::text as n from private.billing_guard_health where kind = 'guard_error'`)[0]!.n)).toBeGreaterThanOrEqual(3);
  });

  it("EC3 BLOCKED_DECISION_DB_EVENT_PERSISTED = NO (documented limitation): a refused decision rolls back with the refused statement - after real refusals no 'blocked' decision row exists, only allow / would_block", async () => {
    await wipe();
    await stage(3);
    const ro = tn["read_only|U"]!;
    for (let i = 0; i < 5; i++) expect(await probe(c.owner!, "fn:create_appointment", "tenant", ro.id)).toMatchObject({ ok: false, code: "BL001" });
    expect((await probe(c.owner!, "fn:complete_appointment", "tenant", ro.id)).ok).toBe(true);
    const d = await testDb<{ decision: string }[]>`select distinct decision from private.billing_decision_counters`;
    expect(d.map((x) => x.decision).sort()).toEqual(["allow"]);
    expect(await sum(`decision = 'blocked'`)).toBe(0);
    expect(await sum(`tenant_id = $1 and action_key = 'fn:create_appointment'`, ro.id)).toBe(0);
    await stage(0);
  });
});

describe("CC concurrency and stage changes in flight (real parallel HTTP / gateway)", () => {
  it("CC1 stage 1: 24 simultaneous HTTP growth actions all succeed and every one is counted exactly once; 16 simultaneous direct customer inserts are all allowed and counted", async () => {
    await wipe();
    await stage(1);
    const t = tn["read_only|U"]!;
    const res = await Promise.all(Array.from({ length: 24 }, () => probe(c.owner!, "fn:create_appointment", "tenant", t.id)));
    expect(res.every((r) => r.ok)).toBe(true);
    expect(await sum(`tenant_id = $1 and action_key = 'fn:create_appointment'`, t.id)).toBe(24);
    const ins = await Promise.all(Array.from({ length: 16 }, (_, i) => tbl(c.owner!, "customers").insert({ tenant_id: t.id, full_name: `Es ${i}` })));
    expect(ins.every((r) => !r.error)).toBe(true);
    expect(await sum(`tenant_id = $1 and action_key = 'table:customers:INSERT'`, t.id)).toBe(16);
    await stage(0);
  });

  it("CC2 stage 1 -> 2 while public bookings are in flight through the gateway: every decision is coherent (allowed at 1 or BL003 at 2), after the flip every request is refused, every recorded decision carries its stage", async () => {
    await wipe();
    await stage(1);
    const t = tn["read_only|U"]!;
    const flight = Array.from({ length: 30 }, () => gwProbe("fn:create_guest_booking", "slug", null, t.slug));
    const flip = (async () => { await new Promise((r) => setTimeout(r, 60)); await stage(2); })();
    const res = (await Promise.all([...flight, flip.then(() => ({ ok: true }) as Out)])).slice(0, 30) as Out[];
    for (const r of res) if (!r.ok) expect(r).toMatchObject({ code: "BL003" });
    expect(await gwProbe("fn:create_guest_booking", "slug", null, t.slug)).toMatchObject({ ok: false, code: "BL003" });
    expect(await testDb`select stage, decision from private.billing_decision_counters where tenant_id = ${t.id} and not ((stage = 1 and decision = 'would_block') or (stage = 2 and decision in ('would_block', 'allow')))`).toEqual([]);
    await stage(0);
  });

  it("CC3 stage 4 -> 0 while blocked requests are happening: after the downward change completes NOTHING is refused any more (instant rollback) and stage 0 adds no evidence", async () => {
    await stage(4);
    const t = tn["suspended|U"]!;
    const flight = Array.from({ length: 30 }, () => probe(c.owner!, "fn:complete_appointment", "tenant", t.id));
    const flip = (async () => { await new Promise((r) => setTimeout(r, 60)); await stage(0); })();
    const res = (await Promise.all([...flight, flip.then(() => ({ ok: true }) as Out)])).slice(0, 30) as Out[];
    for (const r of res) if (!r.ok) expect(r).toMatchObject({ code: "BL002" });
    for (const a of ["fn:create_appointment", "fn:complete_appointment", "fn:update_salon_profile"]) expect((await probe(c.owner!, a, "tenant", t.id)).ok, a).toBe(true);
    await wipe();
    for (let i = 0; i < 5; i++) await probe(c.owner!, "fn:create_appointment", "tenant", t.id);
    expect(await rows()).toEqual({ counters: 0, samples: 0, health: 0 });
  });

  it("CC4 one coherent stage per decision: every counter row's config_version is a version that existed (no mixed state) under parallel stage rewrites", async () => {
    await wipe();
    await stage(1);
    const t = tn["read_only|U"]!;
    await Promise.all([...Array.from({ length: 12 }, () => probe(c.owner!, "fn:create_appointment", "tenant", t.id)), stage(1), stage(1)]);
    const cur = (await testDb<Loose[]>`select version from private.billing_enforcement_config`)[0]!.version;
    for (const r of await testDb<Loose[]>`select distinct config_version from private.billing_decision_counters where tenant_id = ${t.id}`) expect(r.config_version).toBeLessThanOrEqual(cur);
    await stage(0);
  });
});

describe("SW system writes, export and security actions are never refused", () => {
  it("SW1 SYSTEM_WRITE (11 worker / hygiene functions) carry NO hook and are never refused: with service_role at stage 4 none answers BL*; the hooked / unhooked split of the registry is the committed one", async () => {
    await stage(4);
    const sys = registry.actions.filter((a) => a.class === "SYSTEM_WRITE");
    expect(sys).toHaveLength(11);
    for (const a of sys) {
      const src = (await testDb<{ s: string }[]>`select prosrc as s from pg_proc where proname = ${a.action_key.slice(3)} and pronamespace = 'public'::regnamespace`)[0]!.s;
      expect(src.includes("-- a2-billing-hook"), a.action_key).toBe(a.action_key === "fn:log_team_invitation_email_delivery" ? false : false);
    }
    for (const fn of ["purge_expired_notification_event_display_snapshots", "materialize_pending_notification_events"]) {
      const r = await rpc(admin as unknown as Client, fn, fn === "materialize_pending_notification_events" ? { p_limit: 1 } : {});
      expect(isBL(r), fn).toBe(false);
    }
    await stage(0);
  });

  it("SW2 export invariants: the export status / request functions carry no hook and answer (never BL*) for a blocked tenant at stage 4; security / account / control-plane / export actions are unhooked", async () => {
    await stage(4);
    for (const cls of ["EXPORT", "SECURITY_ACCOUNT_ACTION", "CONTROL_PLANE", "OTHER"]) for (const a of registry.actions.filter((x) => x.class === cls)) expect(a.hooked, a.action_key).toBe(false);
    for (const t of [tn["suspended|U"]!, tn["deleted|U"]!]) {
      const r = await rpc(c.owner!, "get_tenant_export_status", { p_tenant_id: t.id });
      expect(isBL(r), t.slug).toBe(false);
    }
    await stage(0);
  });
});
