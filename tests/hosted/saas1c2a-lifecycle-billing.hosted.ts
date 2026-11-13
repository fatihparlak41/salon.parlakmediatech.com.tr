import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  admin,
  anonClient,
  cleanupPlatformAdmins,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "../helpers";
import { assertDisposableDatabase, readHostedEnv } from "./guard";

/**
 * Faz SAAS.1C.2a - HOSTED acceptance (real Postgres + Auth + PostgREST of a DISPOSABLE project). Nothing here uses SET SESSION AUTHORIZATION or a
 * simulated role: every actor is a REAL signed-in JWT (platform owner, platform support, salon Owner, Yonetici, Personel, other salon's owner), the
 * anon key, or the service-role key, talking to the real Data API. Concurrency is real parallel HTTP. The database connection (testDb) is only used for
 * fixtures and ground-truth reads. All slugs start with "h-" (the guard refuses anything else). Everything is synthetic.
 * IDs: HL lifecycle hardening, HA authorization, HV versioning, HC concurrency, HI idempotency, HE events, HP protected tenants, HB branch limit,
 * HS staff soft limit, HR regression, HG catalog/grants.
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
const PROBE = "h_s2a_probe_col";

async function rpc(client: Client, fn: string, args: Record<string, unknown>): Promise<Res> {
  const r = await client.rpc(fn as never, args as never);
  return { data: (r.data as Loose | null) ?? null, error: r.error ? r.error.message : null, code: r.error?.code ?? null };
}

const W = {
  paid: (cl: Client, t: string, end: string, v: number, o: { req?: string; plan?: string | null; reason?: string } = {}) =>
    rpc(cl, "admin_billing_activate_paid", { p_tenant_id: t, p_period_end: end, p_reason: o.reason ?? "hosted manual payment recorded", p_request_id: o.req ?? rid(), p_expected_version: v, p_plan_key: o.plan ?? null }),
  mode: (cl: Client, t: string, mode: string, v: number, o: { req?: string; slug?: string | null; reason?: string } = {}) =>
    rpc(cl, "admin_billing_set_mode", { p_tenant_id: t, p_mode: mode, p_reason: o.reason ?? "hosted mode change", p_request_id: o.req ?? rid(), p_expected_version: v, p_confirm_slug: o.slug ?? null }),
  trial: (cl: Client, t: string, days: number, v: number, o: { req?: string; reason?: string } = {}) =>
    rpc(cl, "admin_billing_extend_trial", { p_tenant_id: t, p_days: days, p_reason: o.reason ?? "hosted trial extension", p_request_id: o.req ?? rid(), p_expected_version: v }),
  grace: (cl: Client, t: string, until: string, v: number, o: { req?: string } = {}) =>
    rpc(cl, "admin_billing_extend_grace", { p_tenant_id: t, p_until: until, p_reason: "hosted grace extension", p_request_id: o.req ?? rid(), p_expected_version: v }),
  pastDue: (cl: Client, t: string, days: number, v: number, o: { req?: string; slug?: string | null } = {}) =>
    rpc(cl, "admin_billing_mark_past_due", { p_tenant_id: t, p_grace_days: days, p_reason: "hosted payment overdue", p_request_id: o.req ?? rid(), p_expected_version: v, p_confirm_slug: o.slug ?? null }),
  restore: (cl: Client, t: string, v: number, o: { req?: string; end?: string | null } = {}) =>
    rpc(cl, "admin_billing_restore_active", { p_tenant_id: t, p_reason: "hosted payment received", p_request_id: o.req ?? rid(), p_expected_version: v, p_period_end: o.end ?? null }),
  cancel: (cl: Client, t: string, mode: string, v: number, o: { req?: string; slug?: string | null } = {}) =>
    rpc(cl, "admin_billing_cancel", { p_tenant_id: t, p_mode: mode, p_reason: "hosted cancellation", p_request_id: o.req ?? rid(), p_expected_version: v, p_confirm_slug: o.slug ?? null }),
  plan: (cl: Client, t: string, key: string, v: number, o: { req?: string } = {}) =>
    rpc(cl, "admin_billing_change_plan", { p_tenant_id: t, p_plan_key: key, p_reason: "hosted plan change", p_request_id: o.req ?? rid(), p_expected_version: v }),
  protect: (cl: Client, t: string, on: boolean, v: number, o: { req?: string; slug?: string | null; reason?: string } = {}) =>
    rpc(cl, "admin_billing_set_protection", { p_tenant_id: t, p_protected: on, p_reason: o.reason ?? "hosted protection review", p_request_id: o.req ?? rid(), p_expected_version: v, p_confirm_slug: o.slug ?? null }),
  life: (cl: Client, t: string, action: string, v: number, o: { req?: string; slug?: string | null } = {}) =>
    rpc(cl, "admin_set_tenant_lifecycle", { p_tenant_id: t, p_action: action, p_reason: "hosted lifecycle decision", p_request_id: o.req ?? rid(), p_expected_version: v, p_confirm_slug: o.slug ?? null }),
};

type Fx = { status?: string; mode?: string; trialStarted?: string | null; trialEnds?: string | null; grace?: string | null; periodStart?: string | null; periodEnd?: string | null; cancel?: boolean; protectedFlag?: boolean; plan?: string; owner?: string };
async function planId(key: string): Promise<string> {
  const [p] = await testDb<{ id: string }[]>`select id from plans where key = ${key}`;
  return p!.id;
}
async function mk(slug: string, fx: Fx = {}): Promise<TestTenant> {
  const t = await createTestTenant(slug, (u[fx.owner ?? "towner"] as TestUser).id);
  tenantIds.push(t.id);
  const plan = await planId(fx.plan ?? "salon");
  await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode, trial_started_at, trial_ends_at, grace_ends_at, current_period_start, current_period_end, cancel_at_period_end, protected)
    values (${t.id}, ${plan}, ${fx.status ?? "active"}, ${fx.mode ?? "pilot"}, ${fx.trialStarted ?? null}, ${fx.trialEnds ?? null}, ${fx.grace ?? null}, ${fx.periodStart ?? null}, ${fx.periodEnd ?? null}, ${fx.cancel ?? false}, ${fx.protectedFlag ?? false})`;
  return t;
}
const trialFx = (): Fx => ({ status: "trialing", mode: "paid", trialStarted: inDays(-2), trialEnds: inDays(28), grace: inDays(42) });
async function sub(t: string): Promise<Loose> {
  return (await testDb<Loose[]>`select * from subscriptions where tenant_id = ${t}`)[0]!;
}
async function events(t: string): Promise<Loose[]> {
  return testDb<Loose[]>`select * from subscription_events where tenant_id = ${t} order by created_at, id`;
}
async function tenantRow(t: string): Promise<Loose> {
  return (await testDb<Loose[]>`select * from tenants where id = ${t}`)[0]!;
}

beforeAll(async () => {
  await assertDisposableDatabase(testDb as unknown as Parameters<typeof assertDisposableDatabase>[0]);
  for (const label of ["towner", "padmin", "psupport", "yon", "pers", "other", "newbie"]) {
    const user = await createTestUser(`h-s2a-${label}`);
    userIds.push(user.id);
    u[label] = user;
  }
  await testDb`insert into platform_admins (user_id, role, is_active) values (${u.padmin!.id}, 'owner', true), (${u.psupport!.id}, 'support', true)`;
  for (const label of Object.keys(u)) if (label !== "newbie") c[label] = await signInAs(u[label]!);
  c.newbie = await signInAs(u.newbie!);
  await testDb.unsafe(`create or replace function public.h_s2a_probe_status(p_id uuid, p_status text) returns void language plpgsql security definer set search_path = '' as $$ begin update public.tenants set status = p_status where id = p_id; end $$`);
  await testDb.unsafe(`create or replace function public.${PROBE}(p_id uuid, p_col text, p_val text) returns void language plpgsql security definer set search_path = '' as $$ begin execute format('update public.tenants set %I = %L where id = %L', p_col, p_val, p_id); end $$`);
  await testDb.unsafe(`grant execute on function public.h_s2a_probe_status(uuid, text) to authenticated, service_role`);
  await testDb.unsafe(`grant execute on function public.${PROBE}(uuid, text, text) to authenticated, service_role`);
}, 300000);

afterAll(async () => {
  await testDb.unsafe(`drop function if exists public.h_s2a_probe_status(uuid, text)`);
  await testDb.unsafe(`drop function if exists public.${PROBE}(uuid, text, text)`);
  await cleanupTenants(tenantIds);
  await cleanupPlatformAdmins([u.padmin!.id, u.psupport!.id]);
  await cleanupUsers(userIds);
  await testDb.end();
}, 300000);

describe("HL - tenant lifecycle hardening over the REAL Data API", () => {
  it("HL1 a salon Owner's REST PATCH of every platform-controlled column is refused, and the original attack (suspended -> active, deleted_at = null) fails", async () => {
    const t = await mk("h-s2a-hl1");
    await testDb`update tenants set status = 'suspended', deleted_at = now() where id = ${t.id}`;
    const before = await tenantRow(t.id);
    const attempts: [string, unknown][] = [
      ["status", "active"], ["deleted_at", null], ["slug", "h-s2a-hl1-renamed"], ["trial_ends_at", inDays(400)],
      ["created_by", u.stranger?.id ?? u.other!.id], ["created_at", new Date().toISOString()], ["id", rid()], ["lifecycle_version", 99],
    ];
    for (const [col, val] of attempts) {
      const r = await c.towner!.from("tenants").update({ [col]: val } as never).eq("id", t.id).select();
      expect(r.error, col).not.toBeNull();
      expect(r.error!.code, col).toBe("42501");
    }
    const multi = await c.towner!.from("tenants").update({ name: "x", status: "active" } as never).eq("id", t.id).select();
    expect(multi.error!.code).toBe("42501");
    expect(await tenantRow(t.id)).toEqual(before);
  });

  it("HL2 intended profile fields still work through the real API: name, timezone, currency, the self-service policy, and the update_salon_profile RPC", async () => {
    const t = await mk("h-s2a-hl2");
    const r1 = await c.towner!.from("tenants").update({ name: "Hosted Profil", timezone: "Europe/Nicosia", currency: "TRY" }).eq("id", t.id).select();
    expect(r1.error).toBeNull();
    expect(r1.data?.length).toBe(1);
    const r2 = await c.towner!.from("tenants").update({ customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 90, customer_reschedule_enabled: true, customer_reschedule_cutoff_minutes: 45 }).eq("id", t.id).select();
    expect(r2.error).toBeNull();
    expect(r2.data?.length).toBe(1);
    const r3 = await rpc(c.towner!, "update_salon_profile", { p_tenant_id: t.id, p_name: "Hosted RPC Profil", p_timezone: "Europe/Nicosia", p_currency: "TRY", p_phone: "+905550000000", p_address: null });
    expect(r3.error).toBeNull();
    const row = await tenantRow(t.id);
    expect(row).toMatchObject({ name: "Hosted RPC Profil", customer_cancellation_cutoff_minutes: 90, lifecycle_version: 1, status: "trial" });
  });

  it("HL3 Yonetici and Personel cannot touch lifecycle columns either; platform SUPPORT and platform OWNER cannot UPDATE tenants directly, reads stay allowed", async () => {
    const t = await mk("h-s2a-hl3");
    await testDb`insert into roles (tenant_id, key, name, description, is_system_default, cloned_from_template_id)
      select ${t.id}, rt.key, rt.name, rt.description, true, rt.id from role_templates rt where rt.key in ('SALON_MANAGER', 'STYLIST')`;
    const roles = await testDb<{ id: string; key: string }[]>`select id, key from roles where tenant_id = ${t.id} and key in ('SALON_MANAGER', 'STYLIST')`;
    for (const r of roles) {
      await testDb`insert into role_permissions (role_id, permission_id) select ${r.id}, permission_id from role_template_permissions rtp join role_templates rt on rt.id = rtp.role_template_id where rt.key = ${r.key}`;
    }
    await addMembership(t.id, u.yon!.id, roles.find((r) => r.key === "SALON_MANAGER")!.id);
    await addMembership(t.id, u.pers!.id, roles.find((r) => r.key === "STYLIST")!.id);
    for (const who of ["yon", "pers", "psupport", "padmin"]) {
      const r = await c[who]!.from("tenants").update({ status: "suspended" } as never).eq("id", t.id).select();
      expect(r.error?.code, who).toBe("42501");
      const n = await c[who]!.from("tenants").update({ name: `rename-by-${who}` }).eq("id", t.id).select();
      if (who === "yon") expect(n.error).toBeNull(); // Yonetici holds settings.manage: a profile field is fine
      else expect(n.data?.length ?? 0, who).toBe(0); // Personel: no permission; platform admins: no longer admitted by the policy
    }
    for (const who of ["psupport", "padmin"]) {
      const seen = await c[who]!.from("tenants").select("id,slug").eq("id", t.id);
      expect(seen.error).toBeNull();
      expect(seen.data?.length, who).toBe(1);
    }
    expect((await tenantRow(t.id)).status).toBe("trial");
  });

  it("HL4 the guard cannot be bypassed: the service-role Data API, a SECURITY DEFINER function through the real API, and a forged marker all fail closed", async () => {
    const t = await mk("h-s2a-hl4");
    // service_role Data API: direct write
    const svc = await admin.from("tenants").update({ status: "suspended" } as never).eq("id", t.id).select();
    expect(svc.error).not.toBeNull();
    expect(svc.error!.code).toBe("42501");
    // SECURITY DEFINER function called through the REAL API as authenticated and as service_role
    for (const [name, client] of [["authenticated", c.towner!], ["service_role", admin as unknown as Client]] as [string, Client][]) {
      const r1 = await rpc(client, "h_s2a_probe_status", { p_id: t.id, p_status: "suspended" });
      expect(r1.error, name).toMatch(/tenant_lifecycle_protected/);
      for (const [col, val] of [["slug", "h-s2a-hl4-x"], ["deleted_at", new Date().toISOString()], ["created_by", u.other!.id], ["trial_ends_at", new Date().toISOString()], ["created_at", new Date().toISOString()]]) {
        const r2 = await rpc(client, PROBE, { p_id: t.id, p_col: col, p_val: val });
        expect(r2.error, `${name}/${col}`).toMatch(/tenant_lifecycle_protected/);
      }
      const ok = await rpc(client, PROBE, { p_id: t.id, p_col: "name", p_val: `definer-${name}` });
      expect(ok.error, `${name}/name`).toBeNull(); // only the platform-controlled set is guarded
    }
    expect((await tenantRow(t.id)).status).toBe("trial");
  });

  it("HL5 the platform OWNER has no direct unaudited path either: only the typed lifecycle RPC changes status, and it writes an event", async () => {
    const t = await mk("h-s2a-hl5", trialFx());
    const direct = await c.padmin!.from("tenants").update({ status: "suspended" } as never).eq("id", t.id).select();
    expect(direct.error?.code).toBe("42501");
    expect((await tenantRow(t.id)).status).toBe("trial");
    const r = await W.life(c.padmin!, t.id, "suspend", 1, { slug: "h-s2a-hl5" });
    expect(r.error).toBeNull();
    expect((await tenantRow(t.id)).status).toBe("suspended");
    const ev = (await events(t.id)).filter((e) => e.event_type === "tenant_lifecycle_changed");
    expect(ev.length).toBe(1);
    expect(ev[0]!.actor_user_id).toBe(u.padmin!.id);
    const back = await W.life(c.padmin!, t.id, "unsuspend", 2);
    expect(back.error).toBeNull();
    expect((await tenantRow(t.id)).status).toBe("trial");
  });
});

describe("HA - the ten typed wrappers over the REAL API roles", () => {
  type Spec = { fn: string; fx: Fx; call: (cl: Client, t: string, slug: string, v: number) => Promise<Res> };
  const specs: Spec[] = [
    { fn: "activate_paid", fx: trialFx(), call: (cl, t, _s, v) => W.paid(cl, t, inDays(30), v) },
    { fn: "set_mode", fx: trialFx(), call: (cl, t, _s, v) => W.mode(cl, t, "complimentary", v) },
    { fn: "extend_trial", fx: trialFx(), call: (cl, t, _s, v) => W.trial(cl, t, 5, v) },
    { fn: "extend_grace", fx: { status: "trialing", mode: "paid", trialStarted: inDays(-40), trialEnds: inDays(-10), grace: inDays(4) }, call: (cl, t, _s, v) => W.grace(cl, t, inDays(12), v) },
    { fn: "mark_past_due", fx: { status: "active", mode: "paid", periodStart: inDays(-20), periodEnd: inDays(10) }, call: (cl, t, s, v) => W.pastDue(cl, t, 7, v, { slug: s }) },
    { fn: "restore_active", fx: { status: "past_due", mode: "paid", periodStart: inDays(-40), periodEnd: inDays(-5), grace: inDays(5) }, call: (cl, t, _s, v) => W.restore(cl, t, v, { end: inDays(30) }) },
    { fn: "cancel", fx: { status: "active", mode: "paid", periodStart: inDays(-5), periodEnd: inDays(25) }, call: (cl, t, _s, v) => W.cancel(cl, t, "at_period_end", v) },
    { fn: "change_plan", fx: trialFx(), call: (cl, t, _s, v) => W.plan(cl, t, "salon_plus", v) },
    { fn: "set_protection", fx: { status: "active", mode: "pilot", protectedFlag: true }, call: (cl, t, s, v) => W.protect(cl, t, false, v, { slug: s }) },
    { fn: "lifecycle", fx: trialFx(), call: (cl, t, s, v) => W.life(cl, t, "suspend", v, { slug: s }) },
  ];

  it("HA1 every wrapper: the platform OWNER succeeds on a valid transition (version +1, one event); support, salon Owner, Yonetici, Personel, another salon's owner and anon are all DENIED with nothing written", async () => {
    let i = 0;
    for (const s of specs) {
      i += 1;
      const slug = `h-s2a-ha1-${i}`;
      const t = await mk(slug, s.fx);
      const denied = ["psupport", "towner", "yon", "pers", "other"];
      // the salon-side personas need a membership to be meaningful; non-members are the harder-to-trust case and are covered too
      for (const who of denied) {
        const r = await s.call(c[who]!, t.id, slug, 1);
        expect(r.error, `${s.fn}/${who}`).toBe("platform owner required");
      }
      const anon = await s.call(anonClient() as unknown as Client, t.id, slug, 1);
      expect(anon.error, `${s.fn}/anon`).toMatch(/permission denied|not allowed|JWT/i);
      expect((await events(t.id)).length, s.fn).toBe(0);
      const beforeVersion = s.fn === "lifecycle" ? (await tenantRow(t.id)).lifecycle_version : (await sub(t.id)).version;
      expect(beforeVersion).toBe(1);
      const ok = await s.call(c.padmin!, t.id, slug, 1);
      expect(ok.error, `${s.fn}/padmin`).toBeNull();
      expect(ok.data).toMatchObject({ ok: true, replayed: false, version: 2 });
      const afterVersion = s.fn === "lifecycle" ? (await tenantRow(t.id)).lifecycle_version : (await sub(t.id)).version;
      expect(afterVersion, s.fn).toBe(2);
      const ev = await events(t.id);
      expect(ev.length, s.fn).toBe(1);
      expect(ev[0]!.actor_user_id).toBe(u.padmin!.id);
    }
  });

  it("HA2 provider fields are never writable or visible through any wrapper, and the platform-owner call cannot name them", async () => {
    const t = await mk("h-s2a-ha2", trialFx());
    await testDb`update subscriptions set provider = 'iyzico', provider_customer_id = 'cus_hosted_s2a', provider_subscription_id = 'sub_hosted_s2a' where tenant_id = ${t.id}`;
    let v = (await sub(t.id)).version as number;
    for (const r of [await W.trial(c.padmin!, t.id, 3, v++), await W.plan(c.padmin!, t.id, "salon_plus", v++), await W.paid(c.padmin!, t.id, inDays(30), v++), await W.cancel(c.padmin!, t.id, "at_period_end", v++)]) expect(r.error).toBeNull();
    const s = await sub(t.id);
    expect([s.provider, s.provider_customer_id, s.provider_subscription_id]).toEqual(["iyzico", "cus_hosted_s2a", "sub_hosted_s2a"]);
    expect(JSON.stringify(await events(t.id))).not.toMatch(/cus_hosted_s2a|sub_hosted_s2a|iyzico/);
    // an extra, provider-shaped argument is simply not part of any wrapper signature
    const bad = await c.padmin!.rpc("admin_billing_change_plan" as never, { p_tenant_id: t.id, p_plan_key: "salon", p_reason: "x provider test", p_request_id: rid(), p_expected_version: v, p_provider_customer_id: "zz" } as never);
    expect(bad.error).not.toBeNull();
  });

  it("HA3 the transition table over the real API: invalid transitions, reason / request id / expected version requirements", async () => {
    const t = await mk("h-s2a-ha3", trialFx());
    expect((await W.trial(c.padmin!, t.id, 0, 1)).error).toBe("invalid_parameter");
    expect((await W.trial(c.padmin!, t.id, 31, 1)).error).toBe("invalid_parameter");
    expect((await W.pastDue(c.padmin!, t.id, 7, 1, { slug: "h-s2a-ha3" })).error).toBe("invalid_transition");
    expect((await W.restore(c.padmin!, t.id, 1)).error).toBe("invalid_transition");
    expect((await W.plan(c.padmin!, t.id, "nope", 1)).error).toBe("plan_not_found");
    expect((await rpc(c.padmin!, "admin_billing_extend_trial", { p_tenant_id: t.id, p_days: 3, p_reason: "abc", p_request_id: rid(), p_expected_version: 1 })).error).toBe("reason_required");
    expect((await rpc(c.padmin!, "admin_billing_extend_trial", { p_tenant_id: t.id, p_days: 3, p_reason: "valid reason", p_request_id: null, p_expected_version: 1 })).error).toBe("request_id_required");
    expect((await rpc(c.padmin!, "admin_billing_extend_trial", { p_tenant_id: t.id, p_days: 3, p_reason: "valid reason", p_request_id: rid(), p_expected_version: null })).error).toBe("expected_version_required");
    expect((await events(t.id)).length).toBe(0);
    expect((await sub(t.id)).version).toBe(1);
  });
});

describe("HV - versioning", () => {
  it("HV1 starting version 1; a successful mutation is +1; a stale expected_version is rejected and writes nothing", async () => {
    const t = await mk("h-s2a-hv1", trialFx());
    expect((await sub(t.id)).version).toBe(1);
    expect((await W.trial(c.padmin!, t.id, 2, 1)).error).toBeNull();
    expect((await sub(t.id)).version).toBe(2);
    const stale = await W.trial(c.padmin!, t.id, 2, 1);
    expect(stale.error).toBe("stale_version");
    expect((await events(t.id)).length).toBe(1);
    expect((await sub(t.id)).version).toBe(2);
  });

  it("HV2 the AUTOMATIC trial start (the onboarding path) bumps the version: an operator holding the old version is stale, and nothing is lost", async () => {
    const t = await mk("h-s2a-hv2", { status: "trialing", mode: "paid" });
    expect((await sub(t.id)).version).toBe(1);
    await testDb`select private.billing_start_trial(${t.id})`;
    const s = await sub(t.id);
    expect(s.version).toBe(2);
    expect(s.trial_started_at).not.toBeNull();
    expect((await W.trial(c.padmin!, t.id, 3, 1)).error).toBe("stale_version");
    expect((await W.trial(c.padmin!, t.id, 3, 2)).error).toBeNull();
  });

  it("HV3 the version cannot be set by any API role (service_role included)", async () => {
    const t = await mk("h-s2a-hv3", trialFx());
    for (const [name, client] of [["towner", c.towner!], ["padmin", c.padmin!], ["service_role", admin as unknown as Client]] as [string, Client][]) {
      const r = await client.from("subscriptions" as never).update({ version: 50 } as never).eq("tenant_id", t.id).select();
      expect(r.error?.code ?? "denied", name).toBe("42501");
    }
    expect((await sub(t.id)).version).toBe(1);
  });
});

describe("HC - real concurrency", () => {
  it("HC1 two parallel writers with the same expected version: exactly one wins, no lost update", async () => {
    const t = await mk("h-s2a-hc1", trialFx());
    const before = await sub(t.id);
    const [a, b] = await Promise.all([W.trial(c.padmin!, t.id, 3, 1), W.trial(c.padmin!, t.id, 4, 1)]);
    const results = [a, b];
    expect(results.filter((r) => r.error === null).length).toBe(1);
    expect(results.filter((r) => r.error === "stale_version").length).toBe(1);
    const after = await sub(t.id);
    const winnerDays = results.find((r) => r.error === null)!.data!.after.trialEndsAt ? Math.round((new Date(after.trial_ends_at).getTime() - new Date(before.trial_ends_at).getTime()) / 86400000) : 0;
    expect([3, 4]).toContain(winnerDays);
    expect(after.version).toBe(2);
    expect((await events(t.id)).length).toBe(1);
  });

  it("HC2 eight parallel writers: one winner, seven stale, one event", async () => {
    const t = await mk("h-s2a-hc2", trialFx());
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => W.trial(c.padmin!, t.id, 1 + (i % 3), 1)));
    expect(res.filter((r) => r.error === null).length).toBe(1);
    expect(res.filter((r) => r.error === "stale_version").length).toBe(7);
    expect((await events(t.id)).length).toBe(1);
    expect((await sub(t.id)).version).toBe(2);
  });

  it("HC3 parallel lifecycle writers on a tenant WITHOUT a subscription row: exactly one wins", async () => {
    const t = await createTestTenant("h-s2a-hc3", u.towner!.id);
    tenantIds.push(t.id);
    const res = await Promise.all([W.life(c.padmin!, t.id, "suspend", 1, { slug: "h-s2a-hc3" }), W.life(c.padmin!, t.id, "suspend", 1, { slug: "h-s2a-hc3" }), W.life(c.padmin!, t.id, "suspend", 1, { slug: "h-s2a-hc3" })]);
    expect(res.filter((r) => r.error === null).length).toBe(1);
    expect((await tenantRow(t.id)).lifecycle_version).toBe(2);
    expect((await events(t.id)).length).toBe(1);
  });

  it("HC4 concurrent DUPLICATE requests (same id, same payload): one effective mutation, one event, both callers get the same result", async () => {
    const t = await mk("h-s2a-hc4", trialFx());
    const req = rid();
    const res = await Promise.all([W.trial(c.padmin!, t.id, 3, 1, { req }), W.trial(c.padmin!, t.id, 3, 1, { req }), W.trial(c.padmin!, t.id, 3, 1, { req })]);
    expect(res.every((r) => r.error === null)).toBe(true);
    expect(res.filter((r) => r.data!.replayed === false).length).toBe(1);
    expect(new Set(res.map((r) => r.data!.eventId)).size).toBe(1);
    expect((await events(t.id)).length).toBe(1);
    expect((await sub(t.id)).version).toBe(2);
  });

  it("HC5 the same request id fired at two tenants at once: one wins, the other is a conflict", async () => {
    const a = await mk("h-s2a-hc5a", trialFx());
    const b = await mk("h-s2a-hc5b", trialFx());
    const req = rid();
    const res = await Promise.all([W.trial(c.padmin!, a.id, 3, 1, { req }), W.trial(c.padmin!, b.id, 3, 1, { req })]);
    expect(res.filter((r) => r.error === null).length).toBe(1);
    expect(res.filter((r) => r.error === "request_conflict").length).toBe(1);
    expect((await events(a.id)).length + (await events(b.id)).length).toBe(1);
  });
});

describe("HI - idempotency", () => {
  it("HI1 same actor + same request id + same payload: exactly one state change, one event, the retry returns the original result", async () => {
    const t = await mk("h-s2a-hi1", trialFx());
    const req = rid();
    const first = await W.trial(c.padmin!, t.id, 3, 1, { req });
    const state = await sub(t.id);
    const retry = await W.trial(c.padmin!, t.id, 3, 1, { req });
    expect(retry.error).toBeNull();
    expect(retry.data).toMatchObject({ replayed: true, eventId: first.data!.eventId, version: 2 });
    expect(retry.data!.after).toEqual(first.data!.after);
    expect(await sub(t.id)).toEqual(state);
    expect((await events(t.id)).length).toBe(1);
  });

  it("HI2 same request id with a different payload / action / tenant / reason: conflict, no second mutation, no second event", async () => {
    const t = await mk("h-s2a-hi2", trialFx());
    const other = await mk("h-s2a-hi2b", trialFx());
    const req = rid();
    await W.trial(c.padmin!, t.id, 3, 1, { req });
    const state = await sub(t.id);
    expect((await W.trial(c.padmin!, t.id, 4, 1, { req })).error).toBe("request_conflict");
    expect((await W.plan(c.padmin!, t.id, "salon_plus", 2, { req })).error).toBe("request_conflict");
    expect((await W.trial(c.padmin!, other.id, 3, 1, { req })).error).toBe("request_conflict");
    expect((await W.trial(c.padmin!, t.id, 3, 1, { req, reason: "a different reason" })).error).toBe("request_conflict");
    expect(await sub(t.id)).toEqual(state);
    expect((await events(t.id)).length).toBe(1);
    expect((await events(other.id)).length).toBe(0);
  });
});

describe("HE - event audit trail", () => {
  it("HE1 the event carries actor, action, reason, request id, correct before and after state, version relationship and a timestamp", async () => {
    const t = await mk("h-s2a-he1", trialFx());
    const req = rid();
    const before = await sub(t.id);
    const r = await W.trial(c.padmin!, t.id, 6, 1, { req, reason: "hosted audit reason" });
    expect(r.error).toBeNull();
    const after = await sub(t.id);
    const [e] = await events(t.id);
    expect(e).toMatchObject({ event_type: "trial_extended", actor_user_id: u.padmin!.id, reason: "hosted audit reason", request_id: req, from_status: "trialing", to_status: "trialing", tenant_id: t.id });
    expect(e!.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e!.metadata.action).toBe("extend_trial");
    expect(e!.metadata.params).toEqual({ days: 6 });
    expect(e!.metadata.before.version).toBe(before.version);
    expect(e!.metadata.after.version).toBe(after.version);
    expect(e!.metadata.after.version).toBe(e!.metadata.before.version + 1);
    expect(new Date(e!.metadata.after.trialEndsAt).getTime()).toBe(new Date(after.trial_ends_at).getTime());
    expect(new Date(e!.metadata.before.trialEndsAt).getTime()).toBe(new Date(before.trial_ends_at).getTime());
    expect(Math.abs(Date.now() - new Date(e!.created_at).getTime())).toBeLessThan(10 * 60 * 1000);
    expect(JSON.stringify(e)).not.toMatch(/provider/i);
  });

  it("HE2 append-only: the database refuses UPDATE and DELETE even to its owner, and no API role (support and platform owner included) can read, insert, update or delete events", async () => {
    const t = await mk("h-s2a-he2", trialFx());
    await W.trial(c.padmin!, t.id, 3, 1);
    const [e] = await events(t.id);
    await expect(testDb`update subscription_events set reason = 'tampered' where id = ${e!.id}`).rejects.toThrow(/append-only/);
    await expect(testDb`delete from subscription_events where id = ${e!.id}`).rejects.toThrow(/append-only/);
    const clients: [string, Client][] = [["towner", c.towner!], ["yon", c.yon!], ["psupport", c.psupport!], ["padmin", c.padmin!], ["other", c.other!], ["anon", anonClient() as unknown as Client], ["service_role", admin as unknown as Client]];
    for (const [name, client] of clients) {
      const t0 = client.from("subscription_events" as never);
      expect((await t0.select("*")).error?.code, `${name} select`).toBe("42501");
      expect((await client.from("subscription_events" as never).update({ reason: "x" } as never).eq("id", e!.id).select()).error?.code, `${name} update`).toBe("42501");
      expect((await client.from("subscription_events" as never).delete().eq("id", e!.id).select()).error?.code, `${name} delete`).toBe("42501");
      expect((await client.from("subscription_events" as never).insert({ tenant_id: t.id, event_type: "note", reason: "forged" } as never)).error?.code, `${name} insert`).toBe("42501");
    }
    expect((await events(t.id)).length).toBe(1);
    expect((await events(t.id))[0]!.reason).toBe("hosted trial extension");
  });

  it("HE3 an authenticated salon user cannot alter billing state, billing mode, trial dates, protection or the overrides directly", async () => {
    const t = await mk("h-s2a-he3", { status: "active", mode: "pilot", protectedFlag: true });
    const before = await sub(t.id);
    for (const client of [c.towner!, c.yon!, c.psupport!, c.padmin!, admin as unknown as Client]) {
      for (const patch of [{ status: "canceled" }, { billing_mode: "paid" }, { trial_ends_at: inDays(1) }, { protected: false }, { cancel_at_period_end: true }]) {
        const r = await client.from("subscriptions" as never).update(patch as never).eq("tenant_id", t.id).select();
        expect(r.error?.code).toBe("42501");
      }
      expect((await client.from("tenant_entitlement_overrides" as never).insert({ tenant_id: t.id } as never)).error?.code).toBe("42501");
    }
    expect(await sub(t.id)).toEqual(before);
  });
});

describe("HP - protected tenants (synthetic Gökhan / Emel / Fatih stand-ins)", () => {
  const protectedCases: [string, string, Fx][] = [
    ["Gökhan-like pilot", "h-s2a-hp-gokhan", { status: "active", mode: "pilot", protectedFlag: true }],
    ["Emel-like pilot", "h-s2a-hp-emel", { status: "active", mode: "pilot", protectedFlag: true }],
    ["Fatih-like internal", "h-s2a-hp-fatih", { status: "active", mode: "internal", protectedFlag: true }],
  ];
  for (const [label, slug, fx] of protectedCases) {
    it(`HP ${label}: every dangerous transition is refused even with the right version, a fresh request id and the typed confirmation`, async () => {
      const t = await mk(slug, fx);
      const before = await sub(t.id);
      const refused = [
        await W.pastDue(c.padmin!, t.id, 7, 1, { slug }),
        await W.cancel(c.padmin!, t.id, "immediate", 1, { slug }),
        await W.cancel(c.padmin!, t.id, "at_period_end", 1, { slug }),
        await W.life(c.padmin!, t.id, "suspend", 1, { slug }),
        await W.paid(c.padmin!, t.id, inDays(30), 1),
        await W.trial(c.padmin!, t.id, 3, 1),
        await W.grace(c.padmin!, t.id, inDays(5), 1),
      ];
      for (const r of refused) expect(r.error).toBe("protected_tenant");
      expect(await sub(t.id)).toEqual(before);
      expect((await events(t.id)).length).toBe(0);
      expect((await tenantRow(t.id)).status).toBe("trial");
      const st = await testDb<Loose[]>`select private.tenant_access_state(${t.id}) s`;
      expect(st[0]!.s.mode).toBe("full");
    });
  }

  it("HP4 permitted operations on a protected tenant: mode among pilot/internal/complimentary, plan change", async () => {
    const t = await mk("h-s2a-hp4", { status: "active", mode: "pilot", protectedFlag: true });
    expect((await W.mode(c.padmin!, t.id, "complimentary", 1)).data!.after).toMatchObject({ billingMode: "complimentary", protected: true });
    expect((await W.plan(c.padmin!, t.id, "salon_plus", 2)).error).toBeNull();
  });

  it("HP5 the approved protection-removal path: owner only, reason, version, typed confirmation, audited; afterwards the state machine applies, and protection can be restored", async () => {
    const t = await mk("h-s2a-hp5", { status: "active", mode: "pilot", protectedFlag: true });
    for (const who of ["psupport", "towner", "yon", "pers", "other"]) expect((await W.protect(c[who]!, t.id, false, 1, { slug: "h-s2a-hp5" })).error, who).toBe("platform owner required");
    expect((await W.protect(c.padmin!, t.id, false, 1)).error).toBe("confirmation_required");
    expect((await W.protect(c.padmin!, t.id, false, 1, { slug: "wrong" })).error).toBe("confirmation_required");
    expect((await W.protect(c.padmin!, t.id, false, 1, { slug: "h-s2a-hp5", reason: "abc" })).error).toBe("reason_required");
    expect((await W.protect(c.padmin!, t.id, false, 9, { slug: "h-s2a-hp5" })).error).toBe("stale_version");
    const off = await W.protect(c.padmin!, t.id, false, 1, { slug: "h-s2a-hp5", reason: "hosted hand over to a paying customer" });
    expect(off.error).toBeNull();
    expect(off.data!.after.protected).toBe(false);
    const ev = (await events(t.id)).at(-1)!;
    expect(ev).toMatchObject({ event_type: "protection_changed", actor_user_id: u.padmin!.id, reason: "hosted hand over to a paying customer" });
    expect(ev.metadata.before.protected).toBe(true);
    expect(ev.metadata.after.protected).toBe(false);
    expect((await W.protect(c.padmin!, t.id, false, 2, { slug: "h-s2a-hp5" })).error).toBe("invalid_transition");
    // now a valid lifecycle operation follows the state machine
    const paid = await W.paid(c.padmin!, t.id, inDays(30), 2);
    expect(paid.error).toBeNull();
    expect(paid.data!.after).toMatchObject({ billingMode: "paid", status: "active", protected: false });
    const pd = await W.pastDue(c.padmin!, t.id, 7, 3, { slug: "h-s2a-hp5" });
    expect(pd.error).toBeNull();
    expect(pd.data!.accessState.mode).toBe("grace");
    expect((await W.protect(c.padmin!, t.id, true, 4)).data!.after.protected).toBe(true);
  });

  it("HP6 a normal synthetic paid/trial tenant follows the whole valid lifecycle", async () => {
    const t = await mk("h-s2a-hp6", { status: "trialing", mode: "paid", trialStarted: inDays(-25), trialEnds: inDays(5), grace: inDays(19) });
    let v = 1;
    const steps: (() => Promise<Res>)[] = [
      () => W.trial(c.padmin!, t.id, 10, v), () => W.paid(c.padmin!, t.id, inDays(30), v), () => W.plan(c.padmin!, t.id, "salon_plus", v),
      () => W.cancel(c.padmin!, t.id, "at_period_end", v), () => W.cancel(c.padmin!, t.id, "undo_at_period_end", v),
      () => W.pastDue(c.padmin!, t.id, 7, v, { slug: "h-s2a-hp6" }), () => W.grace(c.padmin!, t.id, inDays(20), v),
      () => W.restore(c.padmin!, t.id, v, { end: inDays(60) }), () => W.cancel(c.padmin!, t.id, "immediate", v, { slug: "h-s2a-hp6" }),
      () => W.restore(c.padmin!, t.id, v, { end: inDays(30) }),
    ];
    for (const step of steps) {
      const r = await step();
      expect(r.error).toBeNull();
      v = r.data!.version;
    }
    expect(v).toBe(11);
    expect((await events(t.id)).length).toBe(10);
  });
});

describe("HB - branch hard limit over the REAL API", () => {
  const ins = (client: Client, tenantId: string, name: string) => client.from("branches").insert({ tenant_id: tenantId, name }).select();

  it("HB1 first active branch allowed, second denied through REST (direct insert), the service-role Data API cannot bypass", async () => {
    const t = await mk("h-s2a-hb1");
    const first = await ins(c.towner!, t.id, "Merkez");
    expect(first.error).toBeNull();
    const second = await ins(c.towner!, t.id, "Ikinci");
    expect(second.error?.message).toMatch(/branch_limit_reached/);
    const svc = await ins(admin as unknown as Client, t.id, "Servis");
    expect(svc.error).not.toBeNull();
    expect((await testDb<Loose[]>`select count(*)::int n from branches where tenant_id = ${t.id}`)[0]!.n).toBe(1);
  });

  it("HB2 real concurrency: three parallel REST inserts create at most one branch; different tenants may each have one", async () => {
    const a = await mk("h-s2a-hb2a");
    const b = await mk("h-s2a-hb2b");
    const res = await Promise.all([ins(c.towner!, a.id, "A1"), ins(c.towner!, a.id, "A2"), ins(c.towner!, a.id, "A3"), ins(c.towner!, b.id, "B1")]);
    expect(res.slice(0, 3).filter((r) => r.error === null).length).toBe(1);
    expect(res[3]!.error).toBeNull();
    expect((await testDb<Loose[]>`select tenant_id, count(*)::int n from branches where tenant_id in (${a.id}, ${b.id}) group by 1 order by 1`).every((r) => r.n === 1)).toBe(true);
  });

  it("HB3 deleted / inactive semantics: a soft-deleted branch frees the slot, restoring it over an active one is denied, no-op writes on legacy multi-branch tenants work", async () => {
    const t = await mk("h-s2a-hb3");
    const first = await ins(c.towner!, t.id, "Merkez");
    const id1 = first.data![0]!.id as string;
    expect((await c.towner!.from("branches").update({ deleted_at: new Date().toISOString() }).eq("id", id1).select()).error).toBeNull();
    const second = await ins(c.towner!, t.id, "Yeni Merkez");
    expect(second.error).toBeNull();
    expect((await c.towner!.from("branches").update({ deleted_at: null }).eq("id", id1).select()).error?.message).toMatch(/branch_limit_reached/);
    const legacy = await mk("h-s2a-hb3b");
    const l1 = await createBranch(legacy.id, "Legacy 1"); // postgres session: stands in for pre-existing data
    await createBranch(legacy.id, "Legacy 2");
    expect((await c.towner!.from("branches").update({ name: "Legacy edited", deleted_at: null }).eq("id", l1).select()).error).toBeNull();
    expect((await ins(c.towner!, legacy.id, "Third")).error?.message).toMatch(/branch_limit_reached/);
  });

  it("HB4 tenant creation through the real API still creates its required first branch (and a salon cannot add a second)", async () => {
    const made = await rpc(c.newbie!, "create_tenant", { p_name: "Hosted Branch Probe", p_slug: "h-s2a-hb4" });
    expect(made.error).toBeNull();
    const id = (made.data as unknown as string) ?? ((await testDb<Loose[]>`select id from tenants where slug = 'h-s2a-hb4'`)[0]!.id as string);
    const tenantId = typeof id === "string" ? id : (id as Loose).id;
    tenantIds.push(tenantId);
    expect((await testDb<Loose[]>`select count(*)::int n from branches where tenant_id = ${tenantId} and deleted_at is null`)[0]!.n).toBe(1);
    expect((await ins(c.newbie!, tenantId, "Fazla")).error?.message).toMatch(/branch_limit_reached/);
    const s = await sub(tenantId);
    expect(s).toMatchObject({ version: 1, protected: false, status: "trialing", billing_mode: "paid", trial_started_at: null });
  });
});

describe("HS - staff soft limit stays soft", () => {
  it("HS1 salon (5) and salon_plus (12): staff creation through the real API is never blocked beyond the limit; usage turns 'over' and nothing is refused", async () => {
    const small = await mk("h-s2a-hs1a", { status: "trialing", mode: "paid", plan: "salon" });
    const big = await mk("h-s2a-hs1b", { status: "trialing", mode: "paid", plan: "salon_plus" });
    for (let i = 0; i < 6; i++) expect((await c.towner!.from("staff_members").insert({ tenant_id: small.id, full_name: `Usta ${i}` }).select("id")).error, `salon ${i}`).toBeNull();
    for (let i = 0; i < 13; i++) expect((await c.towner!.from("staff_members").insert({ tenant_id: big.id, full_name: `Usta ${i}` }).select("id")).error, `plus ${i}`).toBeNull();
    const rows = await testDb<Loose[]>`select (private.tenant_limit_status(${small.id}) -> 0) a, (private.tenant_limit_status(${big.id}) -> 0) b`;
    expect(rows[0]!.a).toMatchObject({ key: "max_active_staff", limit: 5, used: 6, state: "over", enforcement: "soft" });
    expect(rows[0]!.b).toMatchObject({ key: "max_active_staff", limit: 12, used: 13, state: "over", enforcement: "soft" });
    const summary = await rpc(c.towner!, "get_my_billing_summary", { p_tenant_id: small.id });
    expect(summary.error).toBeNull();
  });
});

describe("HR - nothing else broke (real API flows)", () => {
  it("HR1 tenant creation, onboarding, trial start, public booking switch and billing enforcement stage 0 on the real API", async () => {
    const owner = await createTestUser("h-s2a-hr1");
    userIds.push(owner.id);
    const oc = await signInAs(owner);
    const made = await rpc(oc, "create_tenant", { p_name: "Hosted Regression", p_slug: "h-s2a-hr1" });
    expect(made.error).toBeNull();
    const tenantId = (await testDb<Loose[]>`select id from tenants where slug = 'h-s2a-hr1'`)[0]!.id as string;
    tenantIds.push(tenantId);
    let s = await sub(tenantId);
    expect(s).toMatchObject({ status: "trialing", billing_mode: "paid", trial_started_at: null, version: 1 });
    const prof = await rpc(oc, "update_salon_profile", { p_tenant_id: tenantId, p_name: "Hosted Regression", p_timezone: "Europe/Nicosia", p_currency: "TRY", p_phone: "+905550000001", p_address: "Test Sok 1" });
    expect(prof.error).toBeNull();
    const svc = await rpc(oc, "onboarding_add_services", { p_tenant_id: tenantId, p_items: [{ name: "Kesim", category: "Sac", durationMinutes: 30, price: "100" }] });
    expect(svc.error).toBeNull();
    const stf = await rpc(oc, "onboarding_add_staff", { p_tenant_id: tenantId, p_items: [{ fullName: "Usta Bir" }] });
    expect(stf.error).toBeNull();
    const staffId = (await testDb<Loose[]>`select id from staff_members where tenant_id = ${tenantId} limit 1`)[0]!.id as string;
    const serviceId = (await testDb<Loose[]>`select id from services where tenant_id = ${tenantId} limit 1`)[0]!.id as string;
    expect((await rpc(oc, "onboarding_apply_weekly_hours", { p_tenant_id: tenantId, p_staff_ids: [staffId], p_days: [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({ weekday, start: "09:00", end: "18:00" })) })).error).toBeNull();
    expect((await rpc(oc, "onboarding_set_staff_services", { p_tenant_id: tenantId, p_assignments: [{ staffId, serviceIds: [serviceId] }] })).error).toBeNull();
    const on = await rpc(oc, "set_online_booking_enabled", { p_tenant_id: tenantId, p_enabled: true });
    expect(on.error).toBeNull();
    s = await sub(tenantId);
    expect(s.trial_started_at).not.toBeNull();
    expect(s.version).toBeGreaterThanOrEqual(2); // the automatic trial start moved the row
    const startedAt = new Date(s.trial_started_at).getTime();
    await rpc(oc, "set_online_booking_enabled", { p_tenant_id: tenantId, p_enabled: true });
    expect(new Date((await sub(tenantId)).trial_started_at).getTime()).toBe(startedAt); // idempotent
    const ctx = await anonClient().rpc("get_public_booking_context" as never, { p_tenant_slug: "h-s2a-hr1" } as never);
    expect(ctx.error).toBeNull();
    expect(ctx.data).toBeTruthy();
    const [gate] = await testDb<Loose[]>`select enabled from private.release_gates where key = 'billing_enforcement'`;
    expect(gate!.enabled).toBe(false);
    const st = await testDb<Loose[]>`select private.tenant_access_state(${tenantId}) s`;
    expect(st[0]!.s).toMatchObject({ enforcementEnabled: false });
  }, 180000);

  it("HR2 business writes through the real API still work for every kind of subscription state (nothing is enforced): customer, service, staff creation and an appointment on a read-only-derived tenant", async () => {
    const t = await mk("h-s2a-hr2", { status: "canceled", mode: "paid", periodEnd: inDays(-3) });
    const st = await testDb<Loose[]>`select private.tenant_access_state(${t.id}) s`;
    expect(st[0]!.s.mode).toBe("read_only");
    expect((await c.towner!.from("customers").insert({ tenant_id: t.id, full_name: "Hosted Musteri" }).select("id")).error).toBeNull();
    expect((await c.towner!.from("services").insert({ tenant_id: t.id, name: "Hosted Hizmet", duration_minutes: 30, price: 100 }).select("id")).error).toBeNull();
    expect((await c.towner!.from("staff_members").insert({ tenant_id: t.id, full_name: "Hosted Usta" }).select("id")).error).toBeNull();
    const branch = (await ins2(c.towner!, t.id)).data![0]!.id as string;
    const staffId = (await testDb<Loose[]>`select id from staff_members where tenant_id = ${t.id}`)[0]!.id as string;
    const serviceId = (await testDb<Loose[]>`select id from services where tenant_id = ${t.id}`)[0]!.id as string;
    const customerId = (await testDb<Loose[]>`select id from customers where tenant_id = ${t.id}`)[0]!.id as string;
    await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staffId}, ${branch})`;
    await testDb`insert into service_branches (service_id, branch_id) values (${serviceId}, ${branch})`;
    await testDb`insert into staff_services (staff_member_id, service_id) values (${staffId}, ${serviceId})`;
    for (let d = 0; d < 7; d++) await testDb`insert into staff_schedules (tenant_id, staff_member_id, weekday, start_time, end_time, branch_id) values (${t.id}, ${staffId}, ${d}, '06:00', '23:00', ${branch})`;
    const start = new Date(Date.now() + 3 * 86400000);
    start.setUTCHours(9, 0, 0, 0);
    const appt = await rpc(c.towner!, "create_appointment", { p_tenant_id: t.id, p_branch_id: branch, p_customer_id: customerId, p_items: [{ service_id: serviceId, staff_member_id: staffId, scheduled_start_at: start.toISOString(), sequence: 1 }] });
    expect(appt.error).toBeNull();
  }, 180000);
});

const ins2 = (client: Client, tenantId: string) => client.from("branches").insert({ tenant_id: tenantId, name: "Merkez" }).select();

describe("HG - catalog, grants, RLS, definer hygiene on the hosted database", () => {
  const WRAPPERS = ["admin_billing_activate_paid", "admin_billing_set_mode", "admin_billing_extend_trial", "admin_billing_extend_grace", "admin_billing_mark_past_due", "admin_billing_restore_active", "admin_billing_cancel", "admin_billing_change_plan", "admin_billing_set_protection", "admin_set_tenant_lifecycle"];
  const PRIVATE = ["billing_manual_action", "billing_snapshot", "admin_require_owner", "subscriptions_bump_version", "tenants_lifecycle_guard", "enforce_branch_hard_limit"];

  it("HG1 grants: ten wrappers execute for authenticated only (no anon / PUBLIC / service_role), the six private functions for nobody, volatility as designed", async () => {
    const w = await testDb<Loose[]>`
      select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') svc, has_function_privilege('public', p.oid, 'EXECUTE') pub, p.provolatile vol
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ${testDb(WRAPPERS)}`;
    expect(w.length).toBe(10);
    for (const r of w) expect([r.anon, r.auth, r.svc, r.pub, r.vol], r.proname).toEqual([false, true, false, false, "v"]);
    const pv = await testDb<Loose[]>`
      select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') svc, has_function_privilege('public', p.oid, 'EXECUTE') pub
        from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname in ${testDb(PRIVATE)}`;
    expect(pv.length).toBe(6);
    for (const r of pv) expect([r.anon, r.auth, r.svc, r.pub], r.proname).toEqual([false, false, false, false]);
    // and over the real API: the private core and helpers are not callable at all
    for (const [name, client] of [["authenticated", c.padmin!], ["anon", anonClient() as unknown as Client]] as [string, Client][]) {
      const r = await client.rpc("billing_manual_action" as never, { p_tenant_id: rid(), p_action: "set_mode", p_params: {}, p_reason: "hosted probe", p_request_id: rid(), p_expected_version: 1 } as never);
      expect(r.error, name).not.toBeNull();
    }
  });

  it("HG2 SECURITY DEFINER hygiene: search_path pinned, explicit owner check first in every wrapper, auth.uid based, no user_metadata, no provider column in the core", async () => {
    const rows = await testDb<Loose[]>`select p.proname, p.prosecdef, p.proconfig, p.prosrc, pg_get_userbyid(p.proowner) owner from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.proname in ${testDb([...WRAPPERS, ...PRIVATE])}`;
    expect(rows.length).toBe(16);
    for (const r of rows) {
      expect(r.proconfig, r.proname).toContain('search_path=""');
      expect(r.owner, r.proname).toBe("postgres");
      if (r.proname !== "subscriptions_bump_version") expect(r.prosecdef, r.proname).toBe(true);
      expect(r.prosrc as string, r.proname).not.toMatch(/user_metadata|raw_user_meta|app_metadata/i);
    }
    for (const w of WRAPPERS) {
      const b = rows.find((r) => r.proname === w)!.prosrc as string;
      expect(b.indexOf("private.admin_require_owner()"), w).toBeGreaterThanOrEqual(0);
      expect(b.indexOf("private.admin_require_owner()"), w).toBeLessThan(b.indexOf("private.billing_manual_action"));
    }
    const core = (rows.find((r) => r.proname === "billing_manual_action")!.prosrc as string).split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join(" ");
    expect(core).toMatch(/auth\.uid\(\)/);
    expect(core).not.toMatch(/provider/i);
    const own = rows.find((r) => r.proname === "admin_require_owner")!.prosrc as string;
    expect(own).toMatch(/pa\.role = 'owner'/);
    expect(own).toMatch(/auth\.uid\(\)/);
  });

  it("HG3 RLS and table privileges: billing tables keep RLS ON with no policy and no client privilege; the tenants policy excludes platform admins; the profile column list is exact", async () => {
    const rls = await testDb<Loose[]>`select c.relname, c.relrowsecurity from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('subscriptions', 'subscription_events', 'plan_limits', 'tenant_entitlement_overrides')`;
    expect(rls.length).toBe(4);
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    expect((await testDb<Loose[]>`select count(*)::int n from information_schema.table_privileges where table_schema = 'public' and table_name in ('subscriptions', 'subscription_events', 'plan_limits', 'tenant_entitlement_overrides') and grantee in ('anon', 'authenticated', 'PUBLIC')`)[0]!.n).toBe(0);
    const pol = await testDb<Loose[]>`select pg_get_expr(polqual, polrelid) q, pg_get_expr(polwithcheck, polrelid) c from pg_policy where polrelid = 'public.tenants'::regclass and polname = 'tenants_update_settings_manage'`;
    expect(`${pol[0]!.q} ${pol[0]!.c}`).not.toMatch(/is_platform_admin/);
    const cols = await testDb<Loose[]>`select string_agg(column_name, ',' order by column_name) c from information_schema.column_privileges where table_schema = 'public' and table_name = 'tenants' and grantee = 'authenticated' and privilege_type = 'UPDATE'`;
    expect(cols[0]!.c).toBe("currency,customer_cancellation_cutoff_minutes,customer_cancellation_enabled,customer_reschedule_cutoff_minutes,customer_reschedule_enabled,name,timezone");
    const trg = await testDb<Loose[]>`select c.relname || '.' || t.tgname s from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgname in ('tenants_lifecycle_guard', 'subscriptions_bump_version', 'branches_hard_limit', 'subscription_events_append_only') order by 1`;
    expect(trg.map((r) => r.s)).toEqual(["branches.branches_hard_limit", "subscription_events.subscription_events_append_only", "subscriptions.subscriptions_bump_version", "tenants.tenants_lifecycle_guard"]);
  });

  it("HG4 the release gate stays OFF and the migration head is the candidate's", async () => {
    const [g] = await testDb<Loose[]>`select enabled from private.release_gates where key = 'billing_enforcement'`;
    expect(g!.enabled).toBe(false);
    const [h] = await testDb<Loose[]>`select max(version) v, count(*)::int n from supabase_migrations.schema_migrations`;
    expect(h!.v).toBe("20261104110000");
    expect(h!.n).toBe(139);
  });
});
