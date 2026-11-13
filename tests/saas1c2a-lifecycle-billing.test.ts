import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import {
  cleanupPlatformAdmins,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createTestTenant,
  createTestUser,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1C.2a - tenant lifecycle hardening, manual billing RPC foundation, branch hard limit. IDs: LC lifecycle columns, LS lifecycle RPC, MB manual
 * billing, ID idempotency / versioning / concurrency, PT protected tenants, BR branch limit, SE security / catalog, RG regression.
 * Everything is synthetic. Billing enforcement stays OFF: nothing here makes any user action fail because of billing.
 * API-style sessions use SET SESSION AUTHORIZATION authenticator so that session_user is NOT the operator (the rules exempt operator sessions only).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Sql = postgres.TransactionSql;
type Role = "authenticated" | "service_role" | "anon" | "booking_gateway";

const u: Record<string, TestUser> = {};
const userIds: string[] = [];
const tenantIds: string[] = [];
const rid = () => randomUUID();
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();

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

async function fails(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { message?: string }).message ?? String(e);
  }
  return "__no_error__";
}

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`s2a-${label}`);
  userIds.push(user.id);
  u[label] = user;
  return user;
}

async function planId(key: string): Promise<string> {
  const [p] = await testDb<{ id: string }[]>`select id from plans where key = ${key}`;
  return p!.id;
}

type Fx = { status?: string; mode?: string; trialStarted?: string | null; trialEnds?: string | null; grace?: string | null; periodStart?: string | null; periodEnd?: string | null; cancel?: boolean; protectedFlag?: boolean; plan?: string };

/** A synthetic tenant (owner = the tenant owner user) with one subscription row in the requested state. */
async function mk(slug: string, fx: Fx = {}): Promise<TestTenant> {
  const t = await createTestTenant(slug, u.towner!.id);
  tenantIds.push(t.id);
  const plan = await planId(fx.plan ?? "salon");
  await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode, trial_started_at, trial_ends_at, grace_ends_at, current_period_start, current_period_end, cancel_at_period_end, protected)
    values (${t.id}, ${plan}, ${fx.status ?? "active"}, ${fx.mode ?? "pilot"}, ${fx.trialStarted ?? null}, ${fx.trialEnds ?? null}, ${fx.grace ?? null}, ${fx.periodStart ?? null}, ${fx.periodEnd ?? null}, ${fx.cancel ?? false}, ${fx.protectedFlag ?? false})`;
  return t;
}

async function sub(tenantId: string): Promise<Loose> {
  const [r] = await testDb<Loose[]>`select * from subscriptions where tenant_id = ${tenantId}`;
  return r!;
}
async function events(tenantId: string): Promise<Loose[]> {
  return testDb<Loose[]>`select * from subscription_events where tenant_id = ${tenantId} order by created_at, id`;
}
async function ver(tenantId: string): Promise<number> {
  return (await sub(tenantId)).version as number;
}

/** Calls one public wrapper as a given user; returns the jsonb result. */
async function call(user: TestUser | null, sqlText: string, params: unknown[], role: Role = "authenticated"): Promise<Loose> {
  return asApi(user?.id ?? null, async (s) => (await s.unsafe(`select public.${sqlText} as r`, params as never[]))[0]!.r as Loose, role);
}
const A = {
  paid: (user: TestUser, t: string, end: string, v: number, p: { reason?: string; req?: string; plan?: string | null } = {}) =>
    call(user, "admin_billing_activate_paid($1::uuid,$2::timestamptz,$3::text,$4::uuid,$5::int,$6::text)", [t, end, p.reason ?? "manual payment recorded", p.req ?? rid(), v, p.plan ?? null]),
  mode: (user: TestUser, t: string, mode: string, v: number, p: { reason?: string; req?: string; slug?: string | null } = {}) =>
    call(user, "admin_billing_set_mode($1::uuid,$2::text,$3::text,$4::uuid,$5::int,$6::text)", [t, mode, p.reason ?? "manual mode change", p.req ?? rid(), v, p.slug ?? null]),
  trial: (user: TestUser, t: string, days: number, v: number, p: { reason?: string; req?: string } = {}) =>
    call(user, "admin_billing_extend_trial($1::uuid,$2::int,$3::text,$4::uuid,$5::int)", [t, days, p.reason ?? "owner asked for more time", p.req ?? rid(), v]),
  grace: (user: TestUser, t: string, until: string, v: number, p: { reason?: string; req?: string } = {}) =>
    call(user, "admin_billing_extend_grace($1::uuid,$2::timestamptz,$3::text,$4::uuid,$5::int)", [t, until, p.reason ?? "payment promised", p.req ?? rid(), v]),
  pastDue: (user: TestUser, t: string, days: number, v: number, p: { reason?: string; req?: string; slug?: string | null } = {}) =>
    call(user, "admin_billing_mark_past_due($1::uuid,$2::int,$3::text,$4::uuid,$5::int,$6::text)", [t, days, p.reason ?? "payment overdue", p.req ?? rid(), v, p.slug ?? null]),
  restore: (user: TestUser, t: string, v: number, p: { reason?: string; req?: string; end?: string | null } = {}) =>
    call(user, "admin_billing_restore_active($1::uuid,$2::text,$3::uuid,$4::int,$5::timestamptz)", [t, p.reason ?? "payment received", p.req ?? rid(), v, p.end ?? null]),
  cancel: (user: TestUser, t: string, mode: string, v: number, p: { reason?: string; req?: string; slug?: string | null } = {}) =>
    call(user, "admin_billing_cancel($1::uuid,$2::text,$3::text,$4::uuid,$5::int,$6::text)", [t, mode, p.reason ?? "customer asked to cancel", p.req ?? rid(), v, p.slug ?? null]),
  plan: (user: TestUser, t: string, key: string, v: number, p: { reason?: string; req?: string } = {}) =>
    call(user, "admin_billing_change_plan($1::uuid,$2::text,$3::text,$4::uuid,$5::int)", [t, key, p.reason ?? "plan change agreed", p.req ?? rid(), v]),
  protect: (user: TestUser, t: string, on: boolean, v: number, p: { reason?: string; req?: string; slug?: string | null } = {}) =>
    call(user, "admin_billing_set_protection($1::uuid,$2::boolean,$3::text,$4::uuid,$5::int,$6::text)", [t, on, p.reason ?? "protection review", p.req ?? rid(), v, p.slug ?? null]),
  life: (user: TestUser, t: string, action: string, v: number, p: { reason?: string; req?: string; slug?: string | null } = {}) =>
    call(user, "admin_set_tenant_lifecycle($1::uuid,$2::text,$3::text,$4::uuid,$5::int,$6::text)", [t, action, p.reason ?? "lifecycle decision", p.req ?? rid(), v, p.slug ?? null]),
};
async function lifeVer(tenantId: string): Promise<number> {
  const [r] = await testDb<{ v: number }[]>`select lifecycle_version v from tenants where id = ${tenantId}`;
  return r!.v;
}

/** A SECURITY DEFINER function that tries to change a platform-controlled column: proves the guard trigger, independent of column privileges. */
const DEFINER_FN = "s2a_probe_status";

beforeAll(async () => {
  await newUser("towner");
  await newUser("padmin"); // platform OWNER
  await newUser("psupport"); // platform support
  await newUser("stranger");
  await testDb`insert into platform_admins (user_id, role, is_active) values (${u.padmin!.id}, 'owner', true), (${u.psupport!.id}, 'support', true)`;
  await testDb.unsafe(`create or replace function public.${DEFINER_FN}(p_id uuid, p_status text) returns void language plpgsql security definer set search_path = '' as $$ begin update public.tenants set status = p_status where id = p_id; end $$`);
  await testDb.unsafe(`grant execute on function public.${DEFINER_FN}(uuid, text) to authenticated, service_role`);
  await testDb.unsafe(`create or replace function public.${DEFINER_FN}_col(p_id uuid, p_col text, p_val text) returns void language plpgsql security definer set search_path = '' as $$ begin execute format('update public.tenants set %I = %L where id = %L', p_col, p_val, p_id); end $$`);
  await testDb.unsafe(`grant execute on function public.${DEFINER_FN}_col(uuid, text, text) to authenticated, service_role`);
}, 120000);

afterAll(async () => {
  await testDb.unsafe(`drop function if exists public.${DEFINER_FN}(uuid, text)`);
  await testDb.unsafe(`drop function if exists public.${DEFINER_FN}_col(uuid, text, text)`);
  await cleanupTenants(tenantIds);
  await cleanupPlatformAdmins([u.padmin!.id, u.psupport!.id]);
  await cleanupUsers(userIds);
  await testDb.end();
}, 120000);

describe("LC - tenant lifecycle hardening", () => {
  it("LC1 a salon Owner cannot reactivate a suspended tenant (the original attack)", async () => {
    const t = await mk("s2a-lc1");
    await testDb`update tenants set status = 'suspended' where id = ${t.id}`;
    const m = await fails(asApi(u.towner!.id, (s) => s`update tenants set status = 'active' where id = ${t.id}`));
    expect(m).toMatch(/permission denied/i);
    const [r] = await testDb<Loose[]>`select status from tenants where id = ${t.id}`;
    expect(r!.status).toBe("suspended");
  });

  it("LC2 a salon Owner cannot clear deleted_at, nor set it", async () => {
    const t = await mk("s2a-lc2");
    await testDb`update tenants set deleted_at = now() where id = ${t.id}`;
    expect(await fails(asApi(u.towner!.id, (s) => s`update tenants set deleted_at = null where id = ${t.id}`))).toMatch(/permission denied/i);
    const t2 = await mk("s2a-lc2b");
    expect(await fails(asApi(u.towner!.id, (s) => s`update tenants set deleted_at = now() where id = ${t2.id}`))).toMatch(/permission denied/i);
    const [r] = await testDb<Loose[]>`select deleted_at from tenants where id = ${t.id}`;
    expect(r!.deleted_at).not.toBeNull();
  });

  it("LC3 slug, created_by, created_at, trial_ends_at, id, updated_at and lifecycle_version are platform-controlled", async () => {
    const t = await mk("s2a-lc3");
    const attempts: [string, (s: Sql) => Promise<unknown>][] = [
      ["slug", (s) => s`update tenants set slug = 's2a-lc3-renamed' where id = ${t.id}`],
      ["created_by", (s) => s`update tenants set created_by = ${u.stranger!.id} where id = ${t.id}`],
      ["created_at", (s) => s`update tenants set created_at = now() where id = ${t.id}`],
      ["trial_ends_at", (s) => s`update tenants set trial_ends_at = now() where id = ${t.id}`],
      ["id", (s) => s`update tenants set id = ${rid()} where id = ${t.id}`],
      ["updated_at", (s) => s`update tenants set updated_at = now() where id = ${t.id}`],
      ["lifecycle_version", (s) => s`update tenants set lifecycle_version = 99 where id = ${t.id}`],
    ];
    for (const [name, fn] of attempts) expect(await fails(asApi(u.towner!.id, fn)), name).toMatch(/permission denied/i);
    const [r] = await testDb<Loose[]>`select slug, lifecycle_version from tenants where id = ${t.id}`;
    expect(r!.slug).toBe("s2a-lc3");
    expect(r!.lifecycle_version).toBe(1);
  });

  it("LC4 legitimate salon-profile edits keep working: name, timezone, currency, the customer self-service policy, and update_salon_profile", async () => {
    const t = await mk("s2a-lc4");
    await asApi(u.towner!.id, (s) => s`update tenants set name = 'Yeni Salon Adi', timezone = 'Europe/Nicosia', currency = 'TRY' where id = ${t.id}`);
    await asApi(u.towner!.id, (s) => s`update tenants set customer_cancellation_enabled = true, customer_cancellation_cutoff_minutes = 60, customer_reschedule_enabled = true, customer_reschedule_cutoff_minutes = 30 where id = ${t.id}`);
    let [r] = await testDb<Loose[]>`select name, timezone, currency, customer_cancellation_enabled c, customer_reschedule_cutoff_minutes rc from tenants where id = ${t.id}`;
    expect(r).toMatchObject({ name: "Yeni Salon Adi", timezone: "Europe/Nicosia", currency: "TRY", c: true, rc: 30 });
    await asApi(u.towner!.id, (s) => s`select public.update_salon_profile(${t.id}::uuid, 'Profil Adi', 'Europe/Nicosia', 'TRY', '+905550000000', null)`);
    [r] = await testDb<Loose[]>`select name from tenants where id = ${t.id}`;
    expect(r!.name).toBe("Profil Adi");
    const [v] = await testDb<Loose[]>`select lifecycle_version from tenants where id = ${t.id}`;
    expect(v!.lifecycle_version).toBe(1);
  });

  it("LC5 platform OWNER and SUPPORT admins cannot UPDATE tenants directly (read access stays)", async () => {
    const t = await mk("s2a-lc5");
    for (const admin of [u.padmin!, u.psupport!]) {
      expect(await fails(asApi(admin.id, (s) => s`update tenants set status = 'suspended' where id = ${t.id}`))).toMatch(/permission denied/i);
      const rows = await asApi(admin.id, (s) => s`update tenants set name = 'Admin Rename' where id = ${t.id} returning id`);
      expect(rows.length).toBe(0); // the policy no longer admits a platform admin
      const seen = await asApi(admin.id, (s) => s`select id from tenants where id = ${t.id}`);
      expect(seen.length).toBe(1); // reads unchanged
    }
    const [r] = await testDb<Loose[]>`select name, status from tenants where id = ${t.id}`;
    expect(r!.name).not.toBe("Admin Rename");
    expect(r!.status).toBe("trial");
  });

  it("LC6 the guard trigger refuses a SECURITY DEFINER path that tries to change status (defence in depth, independent of column grants)", async () => {
    const t = await mk("s2a-lc6");
    for (const role of ["authenticated", "service_role"] as Role[]) {
      const m = await fails(asApi(u.towner!.id, (s) => s.unsafe(`select public.${DEFINER_FN}($1::uuid, 'suspended')`, [t.id] as never[]), role));
      expect(m, role).toMatch(/tenant_lifecycle_protected/);
    }
    // forging the marker from a plain API session still cannot write the column (privilege)
    const m2 = await fails(asApi(u.towner!.id, async (s) => {
      await s`select set_config('salonos.sanctioned_lifecycle', 'on', true)`;
      await s`update tenants set status = 'active' where id = ${t.id}`;
    }));
    expect(m2).toMatch(/permission denied/i);
    const [r] = await testDb<Loose[]>`select status from tenants where id = ${t.id}`;
    expect(r!.status).toBe("trial");
  });

  it("LC6b the guard covers every platform-controlled column for a SECURITY DEFINER path: slug, deleted_at, created_by, trial_ends_at, created_at", async () => {
    const t = await mk("s2a-lc6b");
    const attempts: [string, string][] = [
      ["slug", "s2a-lc6b-renamed"],
      ["deleted_at", new Date().toISOString()],
      ["created_by", u.stranger!.id],
      ["trial_ends_at", new Date().toISOString()],
      ["created_at", new Date().toISOString()],
    ];
    for (const [col, val] of attempts) {
      for (const role of ["authenticated", "service_role"] as Role[]) {
        const m = await fails(asApi(u.towner!.id, (s) => s.unsafe(`select public.${DEFINER_FN}_col($1::uuid, $2::text, $3::text)`, [t.id, col, val] as never[]), role));
        expect(m, `${col}/${role}`).toMatch(/tenant_lifecycle_protected/);
      }
    }
    // a profile column through the same definer path is NOT refused (only the platform-controlled set is guarded)
    await asApi(u.towner!.id, (s) => s.unsafe(`select public.${DEFINER_FN}_col($1::uuid, 'name', 'Definer Rename')`, [t.id] as never[]));
    expect((await testDb<Loose[]>`select name from tenants where id = ${t.id}`)[0]!.name).toBe("Definer Rename");
  });

  it("LC7 operator sessions (migrations, break-glass) still work, and lifecycle_version moves only with status / deleted_at", async () => {
    const t = await mk("s2a-lc7");
    expect(await lifeVer(t.id)).toBe(1);
    await testDb`update tenants set name = 'Only a name' where id = ${t.id}`;
    expect(await lifeVer(t.id)).toBe(1);
    await testDb`update tenants set status = 'suspended' where id = ${t.id}`;
    expect(await lifeVer(t.id)).toBe(2);
    await testDb`update tenants set status = 'trial', deleted_at = now() where id = ${t.id}`;
    expect(await lifeVer(t.id)).toBe(3);
  });

  it("LC8 the tenant owner's lifecycle protection holds when combined with returning / multi-column updates", async () => {
    const t = await mk("s2a-lc8");
    await testDb`update tenants set status = 'suspended' where id = ${t.id}`;
    expect(await fails(asApi(u.towner!.id, (s) => s`update tenants set name = 'x', status = 'active' where id = ${t.id} returning status`))).toMatch(/permission denied/i);
    expect((await testDb<Loose[]>`select status from tenants where id = ${t.id}`)[0]!.status).toBe("suspended");
  });
});

describe("LS - tenant lifecycle RPC (platform owner only)", () => {
  it("LS1 suspend then unsuspend restores the previous status; version, event and slug confirmation", async () => {
    const t = await mk("s2a-ls1", { status: "trialing", mode: "paid", trialStarted: inDays(-5), trialEnds: inDays(25), grace: inDays(39) });
    await testDb`update tenants set status = 'active' where id = ${t.id}`;
    expect(await fails(A.life(u.padmin!, t.id, "suspend", 2))).toBe("confirmation_required");
    const r = await A.life(u.padmin!, t.id, "suspend", 2, { slug: "s2a-ls1" });
    expect(r).toMatchObject({ ok: true, replayed: false, version: 3 });
    expect(r.before.status).toBe("active");
    expect(r.after.status).toBe("suspended");
    expect((await testDb<Loose[]>`select status from tenants where id = ${t.id}`)[0]!.status).toBe("suspended");
    expect(await fails(A.life(u.padmin!, t.id, "suspend", 3, { slug: "s2a-ls1" }))).toBe("invalid_transition");
    const back = await A.life(u.padmin!, t.id, "unsuspend", 3);
    expect(back.after.status).toBe("active");
    const ev = (await events(t.id)).filter((e) => e.event_type === "tenant_lifecycle_changed");
    expect(ev.map((e) => [e.from_status, e.to_status])).toEqual([["active", "suspended"], ["suspended", "active"]]);
    expect(ev[0]!.actor_user_id).toBe(u.padmin!.id);
    expect(ev[0]!.reason).toBe("lifecycle decision");
    expect(ev[0]!.request_id).not.toBeNull();
  });

  it("LS2 stale lifecycle version, replay and conflicting replay", async () => {
    const t = await mk("s2a-ls2");
    expect(await fails(A.life(u.padmin!, t.id, "suspend", 7, { slug: "s2a-ls2" }))).toBe("stale_version");
    const req = rid();
    const a = await A.life(u.padmin!, t.id, "suspend", 1, { slug: "s2a-ls2", req });
    const b = await A.life(u.padmin!, t.id, "suspend", 1, { slug: "s2a-ls2", req });
    expect(b).toMatchObject({ replayed: true, eventId: a.eventId });
    expect(await fails(A.life(u.padmin!, t.id, "unsuspend", 2, { req }))).toBe("request_conflict");
    expect((await events(t.id)).length).toBe(1);
  });

  it("LS3 only the platform OWNER: support, a tenant owner, a stranger and anon are refused", async () => {
    const t = await mk("s2a-ls3");
    expect(await fails(A.life(u.psupport!, t.id, "suspend", 1, { slug: "s2a-ls3" }))).toBe("platform owner required");
    expect(await fails(A.life(u.towner!, t.id, "suspend", 1, { slug: "s2a-ls3" }))).toBe("platform owner required");
    expect(await fails(A.life(u.stranger!, t.id, "suspend", 1, { slug: "s2a-ls3" }))).toBe("platform owner required");
    expect(await fails(call(null, "admin_set_tenant_lifecycle($1::uuid,'suspend','long enough reason',$2::uuid,1,$3::text)", [t.id, rid(), "s2a-ls3"], "anon"))).toMatch(/permission denied/i);
    expect((await testDb<Loose[]>`select status from tenants where id = ${t.id}`)[0]!.status).toBe("trial");
  });

  it("LS4 a deleted tenant, an unknown tenant and a bad action are refused", async () => {
    const t = await mk("s2a-ls4");
    await testDb`update tenants set deleted_at = now() where id = ${t.id}`;
    expect(await fails(A.life(u.padmin!, t.id, "suspend", 2, { slug: "s2a-ls4" }))).toBe("tenant_deleted");
    expect(await fails(A.life(u.padmin!, rid(), "suspend", 1, { slug: "x" }))).toBe("tenant_not_found");
    const t2 = await mk("s2a-ls4b");
    expect(await fails(A.life(u.padmin!, t2.id, "cancel", 1))).toBe("invalid_parameter");
  });
});

describe("MB - manual billing transitions", () => {
  it("MB1 activate paid from a started trial: paid/active, period set, trial history kept, grace cleared, version +1, one event", async () => {
    const t = await mk("s2a-mb1", { status: "trialing", mode: "paid", trialStarted: inDays(-10), trialEnds: inDays(20), grace: inDays(34) });
    const end = inDays(30);
    const r = await A.paid(u.padmin!, t.id, end, 1);
    expect(r).toMatchObject({ ok: true, replayed: false, version: 2 });
    const s = await sub(t.id);
    expect(s).toMatchObject({ status: "active", billing_mode: "paid", cancel_at_period_end: false, grace_ends_at: null, version: 2 });
    expect(s.current_period_end).not.toBeNull();
    expect(r.accessState.mode).toBe("full");
    const ev = await events(t.id);
    expect(ev.length).toBe(1);
    expect(ev[0]).toMatchObject({ event_type: "period_set", from_status: "trialing", to_status: "active", actor_user_id: u.padmin!.id });
    expect(ev[0]!.metadata.before.version).toBe(1);
    expect(ev[0]!.metadata.after.version).toBe(2);
    expect(ev[0]!.metadata.action).toBe("activate_paid");
  });

  it("MB2 renewal extends an active paid period; a shorter or equal end is refused; period bounds", async () => {
    const t = await mk("s2a-mb2", { status: "active", mode: "paid", periodStart: inDays(-5), periodEnd: inDays(25) });
    expect(await fails(A.paid(u.padmin!, t.id, inDays(10), 1))).toBe("period_not_extended");
    expect(await fails(A.paid(u.padmin!, t.id, inDays(500), 1))).toBe("invalid_parameter");
    expect(await fails(A.paid(u.padmin!, t.id, inDays(-1), 1))).toBe("invalid_parameter");
    const r = await A.paid(u.padmin!, t.id, inDays(55), 1);
    expect(r.after.version).toBe(2);
    const s = await sub(t.id);
    expect(new Date(s.current_period_end).getTime()).toBeGreaterThan(Date.now() + 50 * 86400000);
  });

  it("MB3 activate paid can also assign a plan; unknown or inactive plans are refused", async () => {
    const t = await mk("s2a-mb3", { status: "trialing", mode: "paid", trialStarted: inDays(-1), trialEnds: inDays(29), grace: inDays(43) });
    expect(await fails(A.paid(u.padmin!, t.id, inDays(30), 1, { plan: "nope" }))).toBe("plan_not_found");
    expect(await fails(A.paid(u.padmin!, t.id, inDays(30), 1, { plan: "starter" }))).toBe("plan_not_found"); // legacy plan is inactive
    const r = await A.paid(u.padmin!, t.id, inDays(30), 1, { plan: "salon_plus" });
    expect(r.after.planKey).toBe("salon_plus");
  });

  it("MB4 set complimentary / pilot / internal: active, trial and period cleared, protection follows pilot/internal, internal needs the slug", async () => {
    const t = await mk("s2a-mb4", { status: "trialing", mode: "paid", trialStarted: inDays(-3), trialEnds: inDays(27), grace: inDays(41) });
    const c = await A.mode(u.padmin!, t.id, "complimentary", 1);
    expect(c.after).toMatchObject({ billingMode: "complimentary", status: "active", trialStartedAt: null, trialEndsAt: null, protected: false });
    expect(await fails(A.mode(u.padmin!, t.id, "internal", 2))).toBe("confirmation_required");
    expect(await fails(A.mode(u.padmin!, t.id, "internal", 2, { slug: "wrong" }))).toBe("confirmation_required");
    const i = await A.mode(u.padmin!, t.id, "internal", 2, { slug: "s2a-mb4" });
    expect(i.after).toMatchObject({ billingMode: "internal", protected: true });
    const p = await A.mode(u.padmin!, t.id, "pilot", 3);
    expect(p.after).toMatchObject({ billingMode: "pilot", protected: true });
    expect(await fails(A.mode(u.padmin!, t.id, "pilot", 4))).toBe("invalid_transition");
    expect(await fails(A.mode(u.padmin!, t.id, "gold", 4))).toBe("invalid_parameter");
    expect((await events(t.id)).map((e) => e.event_type)).toEqual(["billing_mode_changed", "billing_mode_changed", "billing_mode_changed"]);
  });

  it("MB5 extend trial: days 1..30, moves trial end and grace together, cumulative cap, only a started paid trial", async () => {
    const started = inDays(-20);
    const t = await mk("s2a-mb5", { status: "trialing", mode: "paid", trialStarted: started, trialEnds: inDays(10), grace: inDays(24) });
    const before = await sub(t.id);
    const r = await A.trial(u.padmin!, t.id, 7, 1);
    expect(r.after.version).toBe(2);
    const after = await sub(t.id);
    expect(new Date(after.trial_ends_at).getTime() - new Date(before.trial_ends_at).getTime()).toBe(7 * 86400000);
    expect(new Date(after.grace_ends_at).getTime() - new Date(before.grace_ends_at).getTime()).toBe(7 * 86400000);
    expect(await fails(A.trial(u.padmin!, t.id, 0, 2))).toBe("invalid_parameter");
    expect(await fails(A.trial(u.padmin!, t.id, 31, 2))).toBe("invalid_parameter");
    await A.trial(u.padmin!, t.id, 30, 2);
    await A.trial(u.padmin!, t.id, 20, 3); // 7+30+20 = 57 days: still inside the 60-day cap
    expect(await fails(A.trial(u.padmin!, t.id, 5, 4))).toBe("cap_exceeded"); // 62 > 60
    const nostart = await mk("s2a-mb5b", { status: "trialing", mode: "paid" });
    expect(await fails(A.trial(u.padmin!, nostart.id, 5, 1))).toBe("trial_not_started");
    const pilot = await mk("s2a-mb5c", { mode: "pilot", protectedFlag: true });
    expect(await fails(A.trial(u.padmin!, pilot.id, 5, 1))).toBe("protected_tenant");
  });

  it("MB6 extend grace: only trialing/past_due paid rows, must move the end forward, at most 30 days ahead", async () => {
    const t = await mk("s2a-mb6", { status: "trialing", mode: "paid", trialStarted: inDays(-40), trialEnds: inDays(-10), grace: inDays(4) });
    expect(await fails(A.grace(u.padmin!, t.id, inDays(2), 1))).toBe("invalid_parameter"); // not beyond the current grace
    expect(await fails(A.grace(u.padmin!, t.id, inDays(45), 1))).toBe("invalid_parameter"); // more than 30 days ahead
    expect(await fails(A.grace(u.padmin!, t.id, inDays(-1), 1))).toBe("invalid_parameter");
    const r = await A.grace(u.padmin!, t.id, inDays(12), 1);
    expect(r.after.version).toBe(2);
    const act = await mk("s2a-mb6b", { status: "active", mode: "paid", periodStart: inDays(-1), periodEnd: inDays(29) });
    expect(await fails(A.grace(u.padmin!, act.id, inDays(5), 1))).toBe("invalid_transition");
  });

  it("MB7 mark past_due then restore active then cancel flows on a paid tenant (slug confirmation, grace window, period needed to restore)", async () => {
    const t = await mk("s2a-mb7", { status: "active", mode: "paid", periodStart: inDays(-30), periodEnd: inDays(1) });
    expect(await fails(A.pastDue(u.padmin!, t.id, 14, 1))).toBe("confirmation_required");
    expect(await fails(A.pastDue(u.padmin!, t.id, 0, 1, { slug: "s2a-mb7" }))).toBe("invalid_parameter");
    const pd = await A.pastDue(u.padmin!, t.id, 14, 1, { slug: "s2a-mb7" });
    expect(pd.after.status).toBe("past_due");
    expect(pd.accessState.mode).toBe("grace");
    expect(await fails(A.restore(u.padmin!, t.id, 2))).toBe("invalid_parameter"); // paid restore needs a period end
    const rs = await A.restore(u.padmin!, t.id, 2, { end: inDays(30) });
    expect(rs.after.status).toBe("active");
    expect(rs.accessState.mode).toBe("full");
    expect(await fails(A.restore(u.padmin!, t.id, 3, { end: inDays(30) }))).toBe("invalid_transition"); // already active
    expect(await fails(A.pastDue(u.padmin!, t.id, 14, 3, { slug: "x" }))).toBe("confirmation_required");
  });

  it("MB8 cancel at period end, undo, and immediate (read_only, not blocked); every guard", async () => {
    const t = await mk("s2a-mb8", { status: "active", mode: "paid", periodStart: inDays(-10), periodEnd: inDays(20) });
    const c1 = await A.cancel(u.padmin!, t.id, "at_period_end", 1);
    expect(c1.after.cancelAtPeriodEnd).toBe(true);
    expect(c1.accessState.reason).toBe("cancel_scheduled");
    expect(await fails(A.cancel(u.padmin!, t.id, "at_period_end", 2))).toBe("invalid_transition");
    const c2 = await A.cancel(u.padmin!, t.id, "undo_at_period_end", 2);
    expect(c2.after.cancelAtPeriodEnd).toBe(false);
    expect(await fails(A.cancel(u.padmin!, t.id, "undo_at_period_end", 3))).toBe("invalid_transition");
    expect(await fails(A.cancel(u.padmin!, t.id, "immediate", 3))).toBe("confirmation_required");
    const c3 = await A.cancel(u.padmin!, t.id, "immediate", 3, { slug: "s2a-mb8" });
    expect(c3.after.status).toBe("canceled");
    expect(c3.accessState.mode).toBe("read_only");
    expect((await testDb<Loose[]>`select status from tenants where id = ${t.id}`)[0]!.status).toBe("trial"); // tenant lifecycle untouched
    expect(await fails(A.cancel(u.padmin!, t.id, "immediate", 4, { slug: "s2a-mb8" }))).toBe("invalid_transition");
    expect(await fails(A.cancel(u.padmin!, t.id, "forever", 4))).toBe("invalid_parameter");
    const rs = await A.restore(u.padmin!, t.id, 4, { end: inDays(30) });
    expect(rs.after.status).toBe("active");
    const noPeriod = await mk("s2a-mb8b", { status: "trialing", mode: "paid" });
    expect(await fails(A.cancel(u.padmin!, noPeriod.id, "at_period_end", 1))).toBe("invalid_transition");
  });

  it("MB9 change plan: both ways, same plan and unknown plan refused, limits follow the plan", async () => {
    const t = await mk("s2a-mb9", { status: "trialing", mode: "paid" });
    const r = await A.plan(u.padmin!, t.id, "salon_plus", 1);
    expect(r.after.planKey).toBe("salon_plus");
    const ev = (await events(t.id))[0]!;
    expect(ev.event_type).toBe("plan_changed");
    expect(ev.from_plan_id).not.toEqual(ev.to_plan_id);
    expect(await fails(A.plan(u.padmin!, t.id, "salon_plus", 2))).toBe("invalid_transition");
    expect(await fails(A.plan(u.padmin!, t.id, "enterprise", 2))).toBe("plan_not_found");
    await A.plan(u.padmin!, t.id, "salon", 2);
    const [lim] = await testDb<Loose[]>`select private.tenant_limit(${t.id}, 'max_active_staff') as l`;
    expect(lim!.l).toBe(5);
  });

  it("MB10 every action requires a reason (5..500), a request id and an expected version", async () => {
    const t = await mk("s2a-mb10", { status: "trialing", mode: "paid", trialStarted: inDays(-1), trialEnds: inDays(29), grace: inDays(43) });
    expect(await fails(A.trial(u.padmin!, t.id, 3, 1, { reason: "" }))).toBe("reason_required");
    expect(await fails(A.trial(u.padmin!, t.id, 3, 1, { reason: "abcd" }))).toBe("reason_required");
    expect(await fails(A.trial(u.padmin!, t.id, 3, 1, { reason: "     " }))).toBe("reason_required");
    expect(await fails(A.trial(u.padmin!, t.id, 3, 1, { reason: "x".repeat(501) }))).toBe("reason_required");
    expect(await fails(call(u.padmin!, "admin_billing_extend_trial($1::uuid,3,'valid reason',null::uuid,1)", [t.id]))).toBe("request_id_required");
    expect(await fails(call(u.padmin!, "admin_billing_extend_trial($1::uuid,3,'valid reason',$2::uuid,null::int)", [t.id, rid()]))).toBe("expected_version_required");
    expect((await events(t.id)).length).toBe(0);
    expect(await ver(t.id)).toBe(1);
    await A.trial(u.padmin!, t.id, 3, 1, { reason: "x".repeat(500) });
    expect((await events(t.id))[0]!.reason).toHaveLength(500);
  });

  it("MB11 a deleted tenant and a tenant without a subscription are refused", async () => {
    const t = await mk("s2a-mb11");
    await testDb`update tenants set deleted_at = now() where id = ${t.id}`;
    expect(await fails(A.mode(u.padmin!, t.id, "pilot", 1))).toBe("tenant_deleted");
    const bare = await createTestTenant("s2a-mb11b", u.towner!.id);
    tenantIds.push(bare.id);
    expect(await fails(A.mode(u.padmin!, bare.id, "pilot", 1))).toBe("subscription_not_found");
  });

  it("MB12 provider identifiers are never read or changed by any manual action, and the events never carry them", async () => {
    const t = await mk("s2a-mb12", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    await testDb`update subscriptions set provider = 'iyzico', provider_customer_id = 'cus_secret_1', provider_subscription_id = 'sub_secret_1' where tenant_id = ${t.id}`;
    let v = await ver(t.id);
    await A.trial(u.padmin!, t.id, 3, v++);
    await A.plan(u.padmin!, t.id, "salon_plus", v++);
    await A.paid(u.padmin!, t.id, inDays(30), v++);
    await A.cancel(u.padmin!, t.id, "at_period_end", v++);
    const s = await sub(t.id);
    expect([s.provider, s.provider_customer_id, s.provider_subscription_id]).toEqual(["iyzico", "cus_secret_1", "sub_secret_1"]);
    expect(JSON.stringify(await events(t.id))).not.toMatch(/cus_secret_1|sub_secret_1|provider/i);
    const [src] = await testDb<{ b: string }[]>`select prosrc b from pg_proc where proname = 'billing_manual_action' and pronamespace = 'private'::regnamespace`;
    const code = src!.b.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join(" ");
    expect(code).not.toMatch(/provider/i);
  });

  it("MB13 transitions that mutate nothing a tenant could see: business tables are untouched by every action", async () => {
    const t = await mk("s2a-mb13", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    await createBranch(t.id, "Merkez");
    const snap = async () => (await testDb<Loose[]>`select (select count(*) from branches where tenant_id = ${t.id}) b, (select md5(row(name, slug, status, deleted_at)::text) from tenants where id = ${t.id}) trow, (select count(*) from tenant_features where tenant_id = ${t.id}) f`)[0]!;
    const before = await snap();
    await A.trial(u.padmin!, t.id, 3, 1);
    await A.paid(u.padmin!, t.id, inDays(30), 2);
    expect(await snap()).toEqual(before);
  });
});

describe("ID - versioning, idempotency, concurrency", () => {
  it("ID1 stale expected_version is refused, nothing written", async () => {
    const t = await mk("s2a-id1", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    expect(await fails(A.trial(u.padmin!, t.id, 3, 5))).toBe("stale_version");
    expect(await fails(A.trial(u.padmin!, t.id, 3, 0))).toBe("stale_version");
    expect((await events(t.id)).length).toBe(0);
    await A.trial(u.padmin!, t.id, 3, 1);
    expect(await fails(A.trial(u.padmin!, t.id, 3, 1))).toBe("stale_version"); // the stale client re-sending its old view
    expect(await ver(t.id)).toBe(2);
  });

  it("ID2 every successful manual mutation bumps the version by exactly 1; a refused one does not", async () => {
    const t = await mk("s2a-id2", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    await A.trial(u.padmin!, t.id, 2, 1);
    expect(await ver(t.id)).toBe(2);
    await fails(A.trial(u.padmin!, t.id, 99, 2));
    expect(await ver(t.id)).toBe(2);
    await A.plan(u.padmin!, t.id, "salon_plus", 2);
    expect(await ver(t.id)).toBe(3);
  });

  it("ID3 ANY change to the managed columns bumps the version (an automatic trial start included); a no-op touch does not", async () => {
    const t = await mk("s2a-id3", { status: "trialing", mode: "paid" });
    expect(await ver(t.id)).toBe(1);
    await testDb`update subscriptions set updated_at = now() where tenant_id = ${t.id}`;
    expect(await ver(t.id)).toBe(1);
    await testDb`select private.billing_start_trial(${t.id})`;
    expect(await ver(t.id)).toBe(2); // the system trial start moved the row: an operator holding version 1 is stale
    expect(await fails(A.trial(u.padmin!, t.id, 3, 1))).toBe("stale_version");
    await testDb`update subscriptions set version = 50 where tenant_id = ${t.id}`; // the version is never client-assignable
    expect(await ver(t.id)).toBe(2);
  });

  it("ID4 a duplicate request (same id, same payload) returns the original result and writes nothing", async () => {
    const t = await mk("s2a-id4", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    const req = rid();
    const a = await A.trial(u.padmin!, t.id, 3, 1, { req });
    const b = await A.trial(u.padmin!, t.id, 3, 1, { req });
    expect(a.replayed).toBe(false);
    expect(b).toMatchObject({ ok: true, replayed: true, eventId: a.eventId, version: 2 });
    expect(b.after).toEqual(a.after);
    expect((await events(t.id)).length).toBe(1);
    expect(await ver(t.id)).toBe(2);
  });

  it("ID5 the same request id with a different payload, action, tenant or reason is a conflict and writes nothing", async () => {
    const t = await mk("s2a-id5", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    const other = await mk("s2a-id5b", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    const req = rid();
    await A.trial(u.padmin!, t.id, 3, 1, { req });
    expect(await fails(A.trial(u.padmin!, t.id, 4, 1, { req }))).toBe("request_conflict"); // other days
    expect(await fails(A.plan(u.padmin!, t.id, "salon_plus", 2, { req }))).toBe("request_conflict"); // other action
    expect(await fails(A.trial(u.padmin!, other.id, 3, 1, { req }))).toBe("request_conflict"); // other tenant
    expect(await fails(A.trial(u.padmin!, t.id, 3, 1, { req, reason: "a different reason" }))).toBe("request_conflict");
    expect((await events(t.id)).length).toBe(1);
    expect((await events(other.id)).length).toBe(0);
    expect(await ver(t.id)).toBe(2);
  });

  it("ID6 concurrent writers with the same expected version: exactly one wins, the other is stale", async () => {
    const t = await mk("s2a-id6", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    const res = await Promise.allSettled([A.trial(u.padmin!, t.id, 3, 1), A.trial(u.padmin!, t.id, 4, 1)]);
    const ok = res.filter((r) => r.status === "fulfilled");
    const bad = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(bad.length).toBe(1);
    expect((bad[0]!.reason as Error).message).toBe("stale_version");
    expect((await events(t.id)).length).toBe(1);
    expect(await ver(t.id)).toBe(2);
  });

  it("ID7 concurrent TWIN requests (same request id): one event, both callers get the same result", async () => {
    const t = await mk("s2a-id7", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    const req = rid();
    const [a, b] = await Promise.all([A.trial(u.padmin!, t.id, 3, 1, { req }), A.trial(u.padmin!, t.id, 3, 1, { req })]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.eventId).toBe(b.eventId);
    expect((await events(t.id)).length).toBe(1);
    expect(await ver(t.id)).toBe(2);
  });

  it("ID8 the same request id used concurrently on two tenants: one wins, the other is a conflict (unique index backstop)", async () => {
    const mkT = (s: string) => mk(s, { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    const t1 = await mkT("s2a-id8a");
    const t2 = await mkT("s2a-id8b");
    const req = rid();
    const res = await Promise.allSettled([A.trial(u.padmin!, t1.id, 3, 1, { req }), A.trial(u.padmin!, t2.id, 3, 1, { req })]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
    const bad = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((bad.reason as Error).message).toBe("request_conflict");
    expect((await events(t1.id)).length + (await events(t2.id)).length).toBe(1);
  });

  it("ID9 a transaction that fails after the action leaves no trace (rollback)", async () => {
    const t = await mk("s2a-id9", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    const m = await fails(asApi(u.padmin!.id, async (s) => {
      await s`select public.admin_billing_extend_trial(${t.id}::uuid, 3, 'will be rolled back', ${rid()}::uuid, 1)`;
      throw new Error("boom");
    }));
    expect(m).toBe("boom");
    expect((await events(t.id)).length).toBe(0);
    expect(await ver(t.id)).toBe(1);
    // and the next attempt with the same version succeeds
    await A.trial(u.padmin!, t.id, 3, 1);
    expect(await ver(t.id)).toBe(2);
  });

  it("ID10 requests are scoped to the actor: another actor's id space does not collide (only the platform owner can act, so it is checked by the unique index shape)", async () => {
    const [ix] = await testDb<{ d: string }[]>`select indexdef d from pg_indexes where indexname = 'subscription_events_actor_request_uidx'`;
    expect(ix!.d).toMatch(/UNIQUE/);
    expect(ix!.d).toMatch(/actor_user_id, request_id/);
    expect(ix!.d).toMatch(/request_id IS NOT NULL/);
  });
});

describe("PT - protected tenants", () => {
  const dangerous: [string, (t: string, v: number) => Promise<unknown>][] = [
    ["activate paid", (t, v) => A.paid(u.padmin!, t, inDays(30), v)],
    ["mark past_due", (t, v) => A.pastDue(u.padmin!, t, 14, v, { slug: undefined as never })],
    ["cancel at period end", (t, v) => A.cancel(u.padmin!, t, "at_period_end", v)],
    ["cancel immediately", (t, v) => A.cancel(u.padmin!, t, "immediate", v)],
    ["extend trial", (t, v) => A.trial(u.padmin!, t, 3, v)],
    ["extend grace", (t, v) => A.grace(u.padmin!, t, inDays(5), v)],
  ];

  for (const [label, mode, slug] of [
    ["PT1 Gökhan-like pilot/active", "pilot", "s2a-pt-gokhan"],
    ["PT2 Emel-like pilot/active", "pilot", "s2a-pt-emel"],
    ["PT3 Fatih-like internal/active", "internal", "s2a-pt-fatih"],
  ] as const) {
    it(`${label}: no accidental manual operation, even WITH the slug confirmation, can make it blocked / read-only / past_due / paid`, async () => {
      const t = await mk(slug, { status: "active", mode, protectedFlag: true });
      const before = await sub(t.id);
      for (const [name, fn] of dangerous) {
        const m = await fails(fn(t.id, 1));
        expect(["protected_tenant", "confirmation_required"], `${name}: ${m}`).toContain(m);
      }
      // with the slug it is still refused by the protected guard (the slug is an operator brake, not the protection)
      expect(await fails(A.pastDue(u.padmin!, t.id, 14, 1, { slug }))).toBe("protected_tenant");
      expect(await fails(A.cancel(u.padmin!, t.id, "immediate", 1, { slug }))).toBe("protected_tenant");
      expect(await fails(A.life(u.padmin!, t.id, "suspend", 1, { slug }))).toBe("protected_tenant");
      const after = await sub(t.id);
      expect(after.version).toBe(before.version);
      expect([after.status, after.billing_mode, after.protected]).toEqual(["active", mode, true]);
      const [st] = await testDb<Loose[]>`select private.tenant_access_state(${t.id}) s`;
      expect(st!.s).toMatchObject({ mode: "full" });
      expect((await events(t.id)).length).toBe(0);
      expect((await testDb<Loose[]>`select status from tenants where id = ${t.id}`)[0]!.status).toBe("trial");
    });
  }

  it("PT4 permitted operations on a protected tenant still work: mode among pilot/internal/complimentary, plan change; protection stays", async () => {
    const t = await mk("s2a-pt4", { status: "active", mode: "pilot", protectedFlag: true });
    expect((await A.mode(u.padmin!, t.id, "complimentary", 1)).after).toMatchObject({ billingMode: "complimentary", protected: true });
    expect((await A.plan(u.padmin!, t.id, "salon_plus", 2)).after.planKey).toBe("salon_plus");
    expect((await A.mode(u.padmin!, t.id, "internal", 3, { slug: "s2a-pt4" })).after.billingMode).toBe("internal");
    expect(await fails(A.restore(u.padmin!, t.id, 4))).toBe("invalid_transition");
  });

  it("PT5 only the explicit, audited un-protect step opens the door: it needs the slug, one more step is then required for the dangerous action", async () => {
    const t = await mk("s2a-pt5", { status: "active", mode: "pilot", protectedFlag: true });
    expect(await fails(A.protect(u.padmin!, t.id, false, 1))).toBe("confirmation_required");
    expect(await fails(A.protect(u.padmin!, t.id, false, 1, { slug: "other" }))).toBe("confirmation_required");
    const r = await A.protect(u.padmin!, t.id, false, 1, { slug: "s2a-pt5", reason: "hand over to a paying customer" });
    expect(r.after.protected).toBe(false);
    const ev = (await events(t.id)).at(-1)!;
    expect(ev.event_type).toBe("protection_changed");
    expect(ev.reason).toBe("hand over to a paying customer");
    expect(await fails(A.protect(u.padmin!, t.id, false, 2, { slug: "s2a-pt5" }))).toBe("invalid_transition");
    // now (and only now) a dangerous transition for the former pilot is possible: pilot -> paid via set_mode is impossible, so move to paid with activate_paid
    const paid = await A.paid(u.padmin!, t.id, inDays(30), 2);
    expect(paid.after).toMatchObject({ status: "active", billingMode: "paid", protected: false });
    const back = await A.protect(u.padmin!, t.id, true, 3);
    expect(back.after.protected).toBe(true);
  });

  it("PT6 the protection is recognised from data: set_mode pilot / internal protects automatically; complimentary does not", async () => {
    const t = await mk("s2a-pt6", { status: "trialing", mode: "paid" });
    expect((await A.mode(u.padmin!, t.id, "complimentary", 1)).after.protected).toBe(false);
    expect((await A.mode(u.padmin!, t.id, "pilot", 2)).after.protected).toBe(true);
  });

  it("PT7 a synthetic normal tenant follows the whole valid lifecycle end to end", async () => {
    const t = await mk("s2a-pt7", { status: "trialing", mode: "paid", trialStarted: inDays(-25), trialEnds: inDays(5), grace: inDays(19) });
    let v = 1;
    v = (await A.trial(u.padmin!, t.id, 10, v)).version;
    v = (await A.paid(u.padmin!, t.id, inDays(30), v)).version;
    v = (await A.plan(u.padmin!, t.id, "salon_plus", v)).version;
    v = (await A.cancel(u.padmin!, t.id, "at_period_end", v)).version;
    v = (await A.cancel(u.padmin!, t.id, "undo_at_period_end", v)).version;
    v = (await A.pastDue(u.padmin!, t.id, 7, v, { slug: "s2a-pt7" })).version;
    v = (await A.grace(u.padmin!, t.id, inDays(20), v)).version;
    v = (await A.restore(u.padmin!, t.id, v, { end: inDays(60) })).version;
    v = (await A.cancel(u.padmin!, t.id, "immediate", v, { slug: "s2a-pt7" })).version;
    v = (await A.restore(u.padmin!, t.id, v, { end: inDays(30) })).version;
    expect(v).toBe(11);
    expect(await ver(t.id)).toBe(11);
    expect((await events(t.id)).length).toBe(10);
    const life = await A.life(u.padmin!, t.id, "suspend", 1, { slug: "s2a-pt7" }); // the normal tenant is not protected
    expect(life.after.status).toBe("suspended");
  });
});

describe("BR - branch hard limit", () => {
  const insBranch = (tenantId: string, userId: string, name: string, role: Role = "authenticated") =>
    asApi(userId, (s) => s`insert into branches (tenant_id, name) values (${tenantId}, ${name}) returning id`, role);

  it("BR1 the first active branch is allowed, the second is denied (direct table INSERT through the API role)", async () => {
    const t = await mk("s2a-br1");
    const first = await insBranch(t.id, u.towner!.id, "Merkez");
    expect(first.length).toBe(1);
    expect(await fails(insBranch(t.id, u.towner!.id, "Ikinci"))).toMatch(/branch_limit_reached/);
    expect((await testDb<Loose[]>`select count(*)::int n from branches where tenant_id = ${t.id}`)[0]!.n).toBe(1);
  });

  it("BR2 the service-role client and the booking-gateway-style roles are covered too", async () => {
    const t = await mk("s2a-br2");
    await createBranch(t.id, "Merkez");
    expect(await fails(insBranch(t.id, u.towner!.id, "Servis", "service_role"))).toMatch(/branch_limit_reached|permission denied/i);
    expect((await testDb<Loose[]>`select count(*)::int n from branches where tenant_id = ${t.id}`)[0]!.n).toBe(1);
  });

  it("BR3 concurrent creation of a tenant's branches: exactly one succeeds", async () => {
    const t = await mk("s2a-br3");
    const res = await Promise.allSettled([insBranch(t.id, u.towner!.id, "A"), insBranch(t.id, u.towner!.id, "B"), insBranch(t.id, u.towner!.id, "C")]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
    for (const r of res.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) expect((r.reason as Error).message).toMatch(/branch_limit_reached/);
    expect((await testDb<Loose[]>`select count(*)::int n from branches where tenant_id = ${t.id}`)[0]!.n).toBe(1);
  });

  it("BR4 cross-tenant: another tenant is unaffected by this one reaching its limit, and cross-tenant inserts are refused by RLS", async () => {
    const a = await mk("s2a-br4a");
    const b = await mk("s2a-br4b");
    await insBranch(a.id, u.towner!.id, "A1");
    await insBranch(b.id, u.towner!.id, "B1");
    expect((await testDb<Loose[]>`select count(*)::int n from branches where tenant_id in (${a.id}, ${b.id})`)[0]!.n).toBe(2);
    const lone = await createTestUser("s2a-br4-lone");
    userIds.push(lone.id);
    expect(await fails(insBranch(a.id, lone.id, "intruder"))).toMatch(/row-level security|branch_limit_reached/i);
  });

  it("BR5 deleted branch semantics: a soft-deleted branch does not count, a new one may replace it, restoring a deleted one over an active one is denied", async () => {
    const t = await mk("s2a-br5");
    const [first] = await insBranch(t.id, u.towner!.id, "Merkez");
    await asApi(u.towner!.id, (s) => s`update branches set deleted_at = now() where id = ${first!.id}`);
    const [second] = await insBranch(t.id, u.towner!.id, "Yeni Merkez");
    expect(second).toBeDefined();
    expect(await fails(asApi(u.towner!.id, (s) => s`update branches set deleted_at = null where id = ${first!.id}`))).toMatch(/branch_limit_reached/);
    // editing the active branch is never blocked
    await asApi(u.towner!.id, (s) => s`update branches set phone = '+905550000000' where id = ${second!.id}`);
  });

  it("BR5b inserting an already-deleted branch is allowed even at the limit (it is not an active branch)", async () => {
    const t = await mk("s2a-br5b");
    await insBranch(t.id, u.towner!.id, "Aktif");
    const rows = await asApi(u.towner!.id, (s) => s`insert into branches (tenant_id, name, deleted_at) values (${t.id}, 'Arsiv', now()) returning id`);
    expect(rows.length).toBe(1);
    expect(await fails(insBranch(t.id, u.towner!.id, "Ikinci Aktif"))).toMatch(/branch_limit_reached/);
  });

  it("BR6 existing data is not disturbed: a legacy tenant with several active branches can still edit them, but not add another", async () => {
    const t = await mk("s2a-br6");
    const b1 = await createBranch(t.id, "Legacy 1");
    await createBranch(t.id, "Legacy 2"); // operator session: exempt, stands in for pre-existing data
    await asApi(u.towner!.id, (s) => s`update branches set name = 'Legacy 1 edited' where id = ${b1}`);
    expect(await fails(insBranch(t.id, u.towner!.id, "Third"))).toMatch(/branch_limit_reached/);
    expect((await testDb<Loose[]>`select count(*)::int n from branches where tenant_id = ${t.id}`)[0]!.n).toBe(2);
  });

  it("BR7 the default branch of a brand-new tenant created through the real API path still works", async () => {
    const owner = await createTestUser("s2a-br7");
    userIds.push(owner.id);
    const made = await asApi(owner.id, (s) => s`select public.create_tenant('Branch Probe', 's2a-br7-salon') as id`);
    const tenantId = (made[0] as Loose).id as string;
    tenantIds.push(tenantId);
    const [n] = await testDb<Loose[]>`select count(*)::int n from branches where tenant_id = ${tenantId} and deleted_at is null`;
    expect(n!.n).toBe(1);
    // and the subscription row exists with version 1, unprotected, trial not started (1C.1 behaviour unchanged)
    const s = await sub(tenantId);
    expect(s).toMatchObject({ version: 1, protected: false, status: "trialing", billing_mode: "paid", trial_started_at: null });
  });

  it("BR8 the limit follows the plan_limits hard row and falls back to 1 without a subscription; the staff limit stays soft", async () => {
    const noSub = await createTestTenant("s2a-br8", u.towner!.id);
    tenantIds.push(noSub.id);
    await insBranch(noSub.id, u.towner!.id, "Only");
    expect(await fails(insBranch(noSub.id, u.towner!.id, "Two"))).toMatch(/branch_limit_reached/);
    const rows = await testDb<Loose[]>`select pl.limit_key, pl.enforcement from plan_limits pl join plans p on p.id = pl.plan_id where p.key = 'salon' order by 1`;
    expect(rows.map((r) => `${r.limit_key}:${r.enforcement}`)).toEqual(["max_active_staff:soft", "max_branches:hard"]);
    // staff creation is never refused by a limit: 7 active staff on a plan of 5
    const t = await mk("s2a-br8b");
    for (let i = 0; i < 7; i++) await asApi(u.towner!.id, (s) => s`insert into staff_members (tenant_id, full_name) values (${t.id}, ${`Usta ${i}`})`);
    expect((await testDb<Loose[]>`select (private.tenant_usage(${t.id}) ->> 'activeStaff')::int n`)[0]!.n).toBe(7);
  });
});

describe("SE - security, grants, RLS, catalog", () => {
  const WRAPPERS = ["admin_billing_activate_paid", "admin_billing_set_mode", "admin_billing_extend_trial", "admin_billing_extend_grace", "admin_billing_mark_past_due", "admin_billing_restore_active", "admin_billing_cancel", "admin_billing_change_plan", "admin_billing_set_protection", "admin_set_tenant_lifecycle"];
  const PRIVATE = ["billing_manual_action", "billing_snapshot", "admin_require_owner", "subscriptions_bump_version", "tenants_lifecycle_guard", "enforce_branch_hard_limit"];

  it("SE1 anon cannot execute any manual billing wrapper", async () => {
    const t = await mk("s2a-se1");
    expect(await fails(call(null, "admin_billing_set_mode($1::uuid,'pilot','long enough reason',$2::uuid,1,null::text)", [t.id, rid()], "anon"))).toMatch(/permission denied/i);
    expect(await fails(call(null, "admin_billing_cancel($1::uuid,'immediate','long enough reason',$2::uuid,1,null::text)", [t.id, rid()], "anon"))).toMatch(/permission denied/i);
  });

  it("SE2 a tenant owner, a stranger and the platform SUPPORT role are refused on every wrapper", async () => {
    const t = await mk("s2a-se2", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    for (const who of [u.towner!, u.stranger!, u.psupport!]) {
      for (const fn of [
        () => A.paid(who, t.id, inDays(30), 1), () => A.mode(who, t.id, "pilot", 1), () => A.trial(who, t.id, 3, 1), () => A.grace(who, t.id, inDays(5), 1),
        () => A.pastDue(who, t.id, 7, 1, { slug: "s2a-se2" }), () => A.restore(who, t.id, 1, { end: inDays(30) }), () => A.cancel(who, t.id, "immediate", 1, { slug: "s2a-se2" }),
        () => A.plan(who, t.id, "salon_plus", 1), () => A.protect(who, t.id, true, 1), () => A.life(who, t.id, "suspend", 1, { slug: "s2a-se2" }),
      ]) expect(await fails(fn())).toBe("platform owner required");
    }
    expect((await events(t.id)).length).toBe(0);
    expect(await ver(t.id)).toBe(1);
  });

  it("SE3 an INACTIVE platform owner is refused", async () => {
    const t = await mk("s2a-se3", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    await testDb`update platform_admins set is_active = false where user_id = ${u.padmin!.id}`;
    try {
      expect(await fails(A.trial(u.padmin!, t.id, 3, 1))).toBe("platform owner required");
    } finally {
      await testDb`update platform_admins set is_active = true where user_id = ${u.padmin!.id}`;
    }
  });

  it("SE4 no manual billing function can be reached through user_metadata or an unauthenticated session", async () => {
    const t = await mk("s2a-se4");
    // a jwt carrying a platform-owner-looking user_metadata for the tenant owner changes nothing
    const m = await fails(asApi(u.towner!.id, async (s) => {
      await s`select set_config('request.jwt.claims', ${JSON.stringify({ sub: u.towner!.id, role: "authenticated", user_metadata: { role: "owner", is_platform_owner: true }, app_metadata: { role: "owner" } })}, true)`;
      await s`select public.admin_billing_set_mode(${t.id}::uuid, 'pilot', 'long enough reason', ${rid()}::uuid, 1, null)`;
    }));
    expect(m).toBe("platform owner required");
    const srcs = await testDb<{ n: string; b: string }[]>`select proname n, prosrc b from pg_proc where pronamespace in ('public'::regnamespace, 'private'::regnamespace) and proname in ${testDb([...WRAPPERS, ...PRIVATE])}`;
    expect(srcs.length).toBe(WRAPPERS.length + PRIVATE.length);
    for (const s of srcs) expect(s.b, s.n).not.toMatch(/user_metadata|raw_user_meta|app_metadata/i);
    const unauth = await fails(asApi(null, (s) => s`select public.admin_billing_set_mode(${t.id}::uuid, 'pilot', 'long enough reason', ${rid()}::uuid, 1, null)`));
    expect(unauth).toBe("authentication required");
  });

  it("SE5 grants: the ten wrappers execute for authenticated only (no anon, PUBLIC, service_role); the six private functions for nobody", async () => {
    const w = await testDb<Loose[]>`
      select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') svc, has_function_privilege('public', p.oid, 'EXECUTE') pub
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ${testDb(WRAPPERS)} order by 1`;
    expect(w.length).toBe(10);
    for (const r of w) expect([r.anon, r.auth, r.svc, r.pub], r.proname).toEqual([false, true, false, false]);
    const pv = await testDb<Loose[]>`
      select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') svc, has_function_privilege('public', p.oid, 'EXECUTE') pub
        from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname in ${testDb(PRIVATE)}`;
    expect(pv.length).toBe(6);
    for (const r of pv) expect([r.anon, r.auth, r.svc, r.pub], r.proname).toEqual([false, false, false, false]);
  });

  it("SE5b the ten write wrappers are VOLATILE (they write); the SAAS.1B / 1C.1 admin reads stay STABLE", async () => {
    const w = await testDb<Loose[]>`select proname, provolatile from pg_proc where pronamespace = 'public'::regnamespace and proname in ${testDb(WRAPPERS)}`;
    expect(w.length).toBe(10);
    for (const r of w) expect(r.provolatile, r.proname as string).toBe("v");
    const reads = await testDb<Loose[]>`select proname, provolatile from pg_proc where pronamespace = 'public'::regnamespace and proname in ('admin_billing_dashboard', 'admin_billing_list', 'admin_tenant_billing', 'admin_dashboard_summary', 'admin_list_tenants', 'admin_tenant_detail', 'admin_tenant_audit')`;
    expect(reads.length).toBe(7);
    for (const r of reads) expect(r.provolatile, r.proname as string).toBe("s");
  });

  it("SE6 definer hygiene: every new function is SECURITY DEFINER (triggers excepted where plain) with search_path pinned to ''", async () => {
    const rows = await testDb<Loose[]>`select p.proname, p.prosecdef, p.proconfig from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.proname in ${testDb([...WRAPPERS, ...PRIVATE])} order by 1`;
    for (const r of rows) {
      expect(r.proconfig, r.proname).toContain('search_path=""');
      if (r.proname !== "subscriptions_bump_version") expect(r.prosecdef, r.proname).toBe(true);
    }
    const guard = (await testDb<{ b: string }[]>`select prosrc b from pg_proc where proname = 'billing_manual_action' and pronamespace = 'private'::regnamespace`)[0]!.b;
    expect(guard).toMatch(/private\.admin_require_owner\(\)/);
    for (const w of WRAPPERS) {
      const b = (await testDb<{ b: string }[]>`select prosrc b from pg_proc where proname = ${w} and pronamespace = 'public'::regnamespace`)[0]!.b;
      expect(b.indexOf("private.admin_require_owner()"), w).toBeGreaterThanOrEqual(0);
      expect(b.indexOf("private.admin_require_owner()"), w).toBeLessThan(b.indexOf("private.billing_manual_action"));
    }
  });

  it("SE7 subscription_events is append-only and invisible to every API role; subscriptions has no client privilege at all", async () => {
    const t = await mk("s2a-se7", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    await A.trial(u.padmin!, t.id, 3, 1);
    const [e] = await events(t.id);
    expect(await fails(testDb`update subscription_events set reason = 'tampered' where id = ${e!.id}`)).toMatch(/append-only/);
    expect(await fails(testDb`delete from subscription_events where id = ${e!.id}`)).toMatch(/append-only/);
    for (const role of ["authenticated", "anon", "service_role"] as const) {
      expect(await fails(asApi(u.padmin!.id, (s) => s`select * from subscription_events`, role)), role).toMatch(/permission denied/i);
      expect(await fails(asApi(u.padmin!.id, (s) => s`update subscriptions set status = 'active'`, role)), role).toMatch(/permission denied/i);
      expect(await fails(asApi(u.padmin!.id, (s) => s`select provider_customer_id from subscriptions`, role)), role).toMatch(/permission denied/i);
    }
    const priv = await testDb<Loose[]>`select count(*)::int n from information_schema.table_privileges where table_schema = 'public' and table_name in ('subscriptions', 'subscription_events', 'plan_limits', 'tenant_entitlement_overrides') and grantee in ('anon', 'authenticated', 'PUBLIC')`;
    expect(priv[0]!.n).toBe(0);
  });

  it("SE8 RLS: the four billing tables keep RLS ON with no policy; the tenants policy no longer admits a platform admin", async () => {
    const rls = await testDb<Loose[]>`select c.relname, c.relrowsecurity from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('subscriptions', 'subscription_events', 'plan_limits', 'tenant_entitlement_overrides') order by 1`;
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    const pol = await testDb<Loose[]>`select pg_get_expr(polqual, polrelid) q, pg_get_expr(polwithcheck, polrelid) c from pg_policy where polrelid = 'public.tenants'::regclass and polname = 'tenants_update_settings_manage'`;
    expect(pol.length).toBe(1);
    expect(`${pol[0]!.q} ${pol[0]!.c}`).not.toMatch(/is_platform_admin/);
    const cols = await testDb<Loose[]>`select string_agg(column_name, ',' order by column_name) c from information_schema.column_privileges where table_schema = 'public' and table_name = 'tenants' and grantee = 'authenticated' and privilege_type = 'UPDATE'`;
    expect(cols[0]!.c).toBe("currency,customer_cancellation_cutoff_minutes,customer_cancellation_enabled,customer_reschedule_cutoff_minutes,customer_reschedule_enabled,name,timezone");
  });

  it("SE9 cross-tenant isolation: an action on tenant A never changes tenant B", async () => {
    const a = await mk("s2a-se9a", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    const b = await mk("s2a-se9b", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    const before = JSON.stringify(await sub(b.id));
    await A.trial(u.padmin!, a.id, 3, 1);
    await A.life(u.padmin!, a.id, "suspend", 1, { slug: "s2a-se9a" });
    expect(JSON.stringify(await sub(b.id))).toBe(before);
    expect((await events(b.id)).length).toBe(0);
    expect((await testDb<Loose[]>`select status from tenants where id = ${b.id}`)[0]!.status).toBe("trial");
  });
});

describe("RG - regression: nothing else moved", () => {
  it("RG1 billing enforcement stays OFF (stage 0) and nothing consults the state yet", async () => {
    const [g] = await testDb<Loose[]>`select enabled from private.release_gates where key = 'billing_enforcement'`;
    expect(g!.enabled).toBe(false);
    const t = await mk("s2a-rg1", { status: "canceled", mode: "paid", periodEnd: inDays(-1) });
    const [s] = await testDb<Loose[]>`select private.tenant_access_state(${t.id}) s`;
    expect(s!.s).toMatchObject({ mode: "read_only", enforcementEnabled: false });
    // a read_only tenant can still create business data: enforcement is not wired
    const rows = await asApi(u.towner!.id, (q) => q`insert into customers (tenant_id, full_name) values (${t.id}, 'Hala Calisiyor') returning id`);
    expect(rows.length).toBe(1);
  });

  it("RG2 the trial start and the access-state truth table are unchanged by the new columns", async () => {
    const t = await mk("s2a-rg2", { status: "trialing", mode: "paid" });
    const [a] = await testDb<Loose[]>`select private.tenant_access_state(${t.id}) s`;
    expect(a!.s).toMatchObject({ mode: "full", reason: "trial_not_started" });
    await testDb`select private.billing_start_trial(${t.id})`;
    const s = await sub(t.id);
    expect(new Date(s.trial_ends_at).getTime() - new Date(s.trial_started_at).getTime()).toBe(720 * 3600 * 1000);
    expect(new Date(s.grace_ends_at).getTime() - new Date(s.trial_ends_at).getTime()).toBe(336 * 3600 * 1000);
  });

  it("RG3 the 1C.1 read model and the SAAS.1B admin reads still answer for a platform admin and are still refused for others", async () => {
    const t = await mk("s2a-rg3", { status: "active", mode: "pilot", protectedFlag: true });
    const d = await asApi(u.psupport!.id, (s) => s`select public.admin_tenant_billing(${t.id}::uuid) r`);
    expect((d[0] as Loose).r).toMatchObject({ subscriptionPresent: true, planKey: "salon" });
    expect(await fails(asApi(u.towner!.id, (s) => s`select public.admin_tenant_billing(${t.id}::uuid)`))).toMatch(/platform admin required/);
    const dash = await asApi(u.padmin!.id, (s) => s`select public.admin_billing_dashboard() r`);
    expect((dash[0] as Loose).r).toBeTruthy();
    const sb = await asApi(u.padmin!.id, (s) => s`select public.admin_dashboard_summary() r`);
    expect((sb[0] as Loose).r).toBeTruthy();
  });

  it("RG4 the billing read model shows the new event types without error", async () => {
    const t = await mk("s2a-rg4", { status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
    await A.trial(u.padmin!, t.id, 3, 1);
    await A.plan(u.padmin!, t.id, "salon_plus", 2);
    const d = await asApi(u.padmin!.id, (s) => s`select public.admin_tenant_billing(${t.id}::uuid) r`);
    const types = ((d[0] as Loose).r.events as Loose[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["trial_extended", "plan_changed"]));
  });

  it("RG5 new tenants keep getting their subscription row with the 1C.1 defaults (version 1, unprotected, trial not started)", async () => {
    const [d] = await testDb<Loose[]>`select column_default from information_schema.columns where table_name = 'subscriptions' and column_name = 'version'`;
    expect(d!.column_default).toBe("1");
    const [p] = await testDb<Loose[]>`select column_default from information_schema.columns where table_name = 'subscriptions' and column_name = 'protected'`;
    expect(p!.column_default).toBe("false");
  });

  it("RG6 every event type the database accepts has a Turkish label in the Super Admin billing history (no raw key can show)", async () => {
    const [c] = await testDb<Loose[]>`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'subscription_events_event_type_check'`;
    const types = [...(c!.d as string).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    expect(types.length).toBe(15);
    const { readFileSync } = await import("node:fs");
    const messages = JSON.parse(readFileSync(new URL("../messages/tr.json", import.meta.url), "utf8"));
    const labels = messages.SuperAdmin.billing.detail.eventTypes as Record<string, string>;
    for (const t of types) expect(labels[t], t).toBeTruthy();
    const labelsSrc = readFileSync(new URL("../components/billing/page-labels.ts", import.meta.url), "utf8");
    for (const t of types) expect(labelsSrc, t).toContain(`"${t}"`);
  });
});
