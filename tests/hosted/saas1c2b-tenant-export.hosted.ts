import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerClient } from "@supabase/ssr";
import {
  admin,
  anonClient,
  cleanupPlatformAdmins,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createService,
  createStaffMember,
  createTestMembershipFromTemplate,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "../helpers";
import { assertDisposableDatabase, readHostedEnv } from "./guard";
import { SECTIONS } from "@/lib/modules/export/sections";
import { buildExportArchive, exportFolder, type PageFetcher } from "@/lib/modules/export/archive";
import { hashToken, newExportToken } from "@/lib/modules/export/token";
import { readZip } from "../export-zip-reader";

/**
 * Faz SAAS.1C.2b - HOSTED acceptance of the tenant export (real Postgres + Auth + PostgREST of a DISPOSABLE project, the real local app for the download
 * route). Every actor is a REAL signed-in JWT. IDs: FA fresh auth (real tokens), AZ authorization, TK token, RL rate limit, EX real export through the
 * app, SC scope / forbidden data, CS csv + json contract, SN concurrent writes, PF larger tenant, AU audit, BI billing independence, ST storage, CG catalog.
 */
const env = readHostedEnv();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Client = Awaited<ReturnType<typeof signInAs>>;

const u: Record<string, TestUser> = {};
const c: Record<string, Client> = {};
const userIds: string[] = [];
const tenantIds: string[] = [];
const T0 = Date.now();
const rid = () => randomUUID();
const decode = (jwt: string): Loose => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
const jwtOf = async (cl: Client) => (await cl.auth.getSession()).data.session!.access_token;
const amrTs = (claims: Loose): number => Math.max(...((claims.amr ?? []) as Loose[]).map((e) => Number(e.timestamp)));

async function rpc(client: { rpc: Client["rpc"] }, fn: string, args: Record<string, unknown>): Promise<{ data: Loose | null; error: { message: string; code?: string } | null }> {
  const r = await client.rpc(fn as never, args as never);
  return { data: (r.data as Loose | null) ?? null, error: r.error ? { message: r.error.message, code: r.error.code } : null };
}
const request = async (cl: Client, tenantId: string, t = newExportToken()) => ({ t, r: await rpc(cl, "request_tenant_export", { p_tenant_id: tenantId, p_token_hash: t.tokenHash, p_client_request_id: t.clientRequestId }) });
const consume = (cl: Client, hash: string) => rpc(cl, "consume_tenant_export_token", { p_token_hash: hash });
const page = (cl: Client, requestId: string, section: string, after: string | null = null, limit = 500) => rpc(cl, "export_read_section", { p_request_id: requestId, p_section: section, p_after: after, p_limit: limit });
const complete = (cl: Client, requestId: string, counts: Record<string, number>, bytes: number) => rpc(cl, "complete_tenant_export", { p_request_id: requestId, p_counts: counts, p_bytes: bytes });
const failIt = (cl: Client, requestId: string, code: string) => rpc(cl, "fail_tenant_export", { p_request_id: requestId, p_error_code: code });

/** request + consume as `cl`; returns the request id */
async function startDownload(cl: Client, tenantId: string): Promise<string> {
  const { t, r } = await request(cl, tenantId);
  expect(r.data, JSON.stringify(r)).toMatchObject({ ok: true });
  const k = await consume(cl, t.tokenHash);
  expect(k.data, JSON.stringify(k)).toMatchObject({ ok: true });
  return k.data!.request_id as string;
}
const reset = (tenantId: string) => testDb`delete from private.tenant_export_requests where tenant_id = ${tenantId}`;

const EVIL = ["=1+1", "+90 500 111 22 33", "-5+2", "@SUM(A1:A9)", "\t=cmd", "\r=cmd", "\n=cmd"];
const LONG = "uzun-metin-".repeat(2500); // ~27 KB
const SENTINELS = { providerCustomer: "cus_H2B_SENTINEL_9f3a", providerSub: "sub_H2B_SENTINEL_77c1", otherTenantMarker: "Musteri-B-SENTINEL" };

async function seed(tag: string, ownerId: string, withSecrets: boolean): Promise<TestTenant & { itemId: string; customerIds: string[]; branchId: string; svcId: string; staffId: string }> {
  const t = await createTestTenant(`h-s2b-${tag.toLowerCase()}-${rid().slice(0, 6)}`, ownerId);
  tenantIds.push(t.id);
  const branch = await createBranch(t.id, `Şube ${tag} 🏢`);
  const staff = await createStaffMember(t.id, `Personel ${tag}`);
  const svc = await createService(t.id, `Hizmet ${tag}`, 30, 500.5);
  await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff.id}, ${branch})`;
  await testDb`insert into service_branches (service_id, branch_id) values (${svc.id}, ${branch})`;
  await testDb`insert into staff_services (staff_member_id, service_id) values (${staff.id}, ${svc.id})`;
  await testDb`insert into staff_schedules (tenant_id, staff_member_id, branch_id, weekday, start_time, end_time) values (${t.id}, ${staff.id}, ${branch}, 1, '09:00', '17:00')`;
  await testDb`insert into staff_schedule_exceptions (tenant_id, staff_member_id, exception_date, type, reason) values (${t.id}, ${staff.id}, current_date, 'unavailable', ${"izin " + tag})`;
  const customerIds: string[] = [];
  const notes = [...EVIL, "satır1\nsatır2; \"tırnak\"", "çğıöşü ÇĞİÖŞÜ 😀", LONG, null];
  for (const [i, n] of notes.entries()) {
    const [cu] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name, phone, email, notes) values (${t.id}, ${`Müşteri ${tag} ${i}`}, ${i === 0 ? "+905001112233" : null}, ${`m${i}-${tag.toLowerCase()}@example.test`}, ${n}) returning id`;
    customerIds.push(cu!.id);
  }
  const [a] = await testDb<{ id: string }[]>`insert into appointments (tenant_id, branch_id, customer_id, status, source, notes, scheduled_start_at, scheduled_end_at) values (${t.id}, ${branch}, ${customerIds[0]}, 'scheduled', 'internal', ${"randevu " + tag}, now() + interval '1 day', now() + interval '1 day 30 minutes') returning id`;
  const [it] = await testDb<{ id: string }[]>`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence) values (${t.id}, ${a!.id}, ${svc.id}, ${staff.id}, now() + interval '1 day', now() + interval '1 day 30 minutes', 30, 500.5, 1) returning id`;
  const [s] = await testDb<{ id: string }[]>`insert into appointment_sales (tenant_id, branch_id, appointment_id, customer_id, currency) values (${t.id}, ${branch}, ${a!.id}, ${customerIds[0]}, 'TRY') returning id`;
  await testDb`insert into appointment_sale_items (tenant_id, sale_id, appointment_item_id, service_id, service_name_snapshot, unit_price) values (${t.id}, ${s!.id}, ${it!.id}, ${svc.id}, ${"Hizmet " + tag}, 500.5)`;
  await testDb`insert into payments (tenant_id, branch_id, appointment_sale_id, amount, method, idempotency_key) values (${t.id}, ${branch}, ${s!.id}, 100.25, 'cash', ${rid()})`;
  const [e] = await testDb<{ id: string }[]>`insert into expenses (tenant_id, branch_id, category_key, description, expense_date, amount, currency) values (${t.id}, ${branch}, 'rent', ${"kira " + tag}, current_date, 1000, 'TRY') returning id`;
  await testDb`insert into expense_payments (tenant_id, expense_id, amount, method, idempotency_key) values (${t.id}, ${e!.id}, 100, 'cash', ${rid()})`;
  await testDb`insert into staff_commission_rules (tenant_id, staff_member_id, service_id, kind, percentage, effective_from) values (${t.id}, ${staff.id}, ${svc.id}, 'percentage', 10, current_date)`;
  await testDb`insert into treatment_notes (appointment_item_id, tenant_id, note) values (${it!.id}, ${t.id}, ${"işlem notu " + tag})`;
  await testDb`insert into treatment_media (tenant_id, appointment_item_id, kind, mime_type, size_bytes, storage_path) values (${t.id}, ${it!.id}, 'before', 'image/jpeg', 1000, ${`${t.id}/${rid()}.jpg`})`;
  await testDb`insert into booking_account_claims (tenant_id, customer_id, appointment_id, email_snapshot, email_normalized_snapshot, secret_hash, expires_at) values (${t.id}, ${customerIds[0]}, ${a!.id}, ${"snap-" + tag + "@example.test"}, ${"snap-" + tag + "@example.test"}, ${"SECRETHASH-" + tag}, now() + interval '1 day')`;
  await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via) values (${ownerId}, ${t.id}, ${customerIds[0]}, 'verified_booking_claim')`;
  if (withSecrets) {
    const [plan] = await testDb<{ id: string }[]>`select id from plans limit 1`;
    await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode, provider_customer_id, provider_subscription_id) values (${t.id}, ${plan!.id}, 'active', 'pilot', ${SENTINELS.providerCustomer}, ${SENTINELS.providerSub})`;
  }
  return { ...t, itemId: it!.id, customerIds, branchId: branch, svcId: svc.id, staffId: staff.id };
}

let A: Awaited<ReturnType<typeof seed>>;
let B: Awaited<ReturnType<typeof seed>>;
let appReachable = false;
const agedSignIn = { at: 0, token: "" };
const cookieJar = async (user: TestUser): Promise<string> => {
  const jar = new Map<string, string>();
  const ssr = createServerClient(env.supabaseUrl, env.publishableKey, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error } = await ssr.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error("ssr sign-in failed: " + error.message);
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
};
const post = (cookie: string | null, token: string, headers: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set("token", token);
  return fetch(`${env.appUrl}/api/tenant-export`, { method: "POST", body: fd, headers: { ...(cookie ? { cookie } : {}), ...headers }, redirect: "manual" });
};

beforeAll(async () => {
  await assertDisposableDatabase(testDb as unknown as Parameters<typeof assertDisposableDatabase>[0]);
  for (const l of ["ownerA", "ownerB", "manager", "recep", "staff", "outsider", "removed", "aged", "padmin", "owner2"]) {
    const x = await createTestUser(`h-s2b-${l}`);
    userIds.push(x.id);
    u[l] = x;
  }
  await testDb`insert into platform_admins (user_id, role, is_active) values (${u.padmin!.id}, 'owner', true)`;
  A = await seed("A", u.ownerA!.id, true);
  B = await seed("B", u.ownerB!.id, true);
  await testDb`update customers set full_name = ${SENTINELS.otherTenantMarker} where id = ${B.customerIds[0]}`;
  await createTestMembershipFromTemplate(A.id, u.manager!.id, "SALON_MANAGER");
  await createTestMembershipFromTemplate(A.id, u.recep!.id, "RECEPTIONIST");
  await createTestMembershipFromTemplate(A.id, u.staff!.id, "STYLIST");
  await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status) values (${A.id}, ${u.removed!.id}, ${A.ownerRoleId}, 'active')`;
  await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status) values (${A.id}, ${u.owner2!.id}, ${A.ownerRoleId}, 'active')`;
  for (const l of ["ownerA", "ownerB", "manager", "recep", "staff", "outsider", "removed", "owner2"]) c[l] = await signInAs(u[l]!);
  // the real-clock aged user: signs in NOW; FA4 (last test) uses this token more than 16 minutes later
  const aged = await createTestMembershipFromTemplate(A.id, u.aged!.id, "SALON_OWNER").catch(async () => {
    await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status) values (${A.id}, ${u.aged!.id}, ${A.ownerRoleId}, 'active')`;
    return null;
  });
  void aged;
  c.aged = await signInAs(u.aged!);
  agedSignIn.at = Date.now();
  agedSignIn.token = await jwtOf(c.aged);
  try {
    const r = await fetch(`${env.appUrl}/login`, { redirect: "manual" });
    appReachable = r.status < 500;
  } catch {
    appReachable = false;
  }
}, 600000);

afterAll(async () => {
  await testDb`alter table private.tenant_export_audit disable trigger tenant_export_audit_append_only`;
  await testDb`delete from private.tenant_export_audit where actor_id in ${testDb(userIds)} or tenant_id in ${testDb(tenantIds)}`;
  await testDb`alter table private.tenant_export_audit enable trigger tenant_export_audit_append_only`;
  await testDb`delete from staff_commission_rules where tenant_id in ${testDb(tenantIds)}`;
  await cleanupTenants(tenantIds);
  await cleanupPlatformAdmins([u.padmin!.id]);
  await cleanupUsers(userIds);
  await testDb.end();
}, 600000);

describe("FA fresh authentication with REAL Supabase Auth tokens", () => {
  it("FA1 a fresh sign-in carries a signed amr entry; the Owner may export", async () => {
    await reset(A.id);
    const claims = decode(await jwtOf(c.ownerA!));
    console.log("FA1 claims: amr =", JSON.stringify(claims.amr), "iat =", claims.iat, "now =", Math.floor(Date.now() / 1000), "session_id present =", !!claims.session_id);
    expect(Array.isArray(claims.amr)).toBe(true);
    expect(claims.amr.some((e: Loose) => e.method === "password")).toBe(true);
    expect(Math.abs(Math.floor(Date.now() / 1000) - amrTs(claims))).toBeLessThan(900);
    const { r } = await request(c.ownerA!, A.id);
    expect(r.data).toMatchObject({ ok: true });
  });
  it("FA2 a TOKEN REFRESH without credentials does NOT change the amr timestamp (iat moves, amr does not)", async () => {
    const cl = await signInAs(u.owner2!);
    const before = decode(await jwtOf(cl));
    await new Promise((r) => setTimeout(r, 4000));
    const { data, error } = await cl.auth.refreshSession();
    expect(error).toBeNull();
    const after = decode(data.session!.access_token);
    console.log("FA2 amr before =", JSON.stringify(before.amr), "after refresh =", JSON.stringify(after.amr), "iat before/after =", before.iat, after.iat);
    expect(after.iat).toBeGreaterThan(before.iat);
    expect(amrTs(after)).toBe(amrTs(before));
  });
  it("FA3 a session whose authentication is old stays old after refresh, and the export is DENIED (authentication age backdated in the Auth tables of the disposable project)", async () => {
    await reset(A.id);
    const cl = await signInAs(u.owner2!);
    const sid = decode(await jwtOf(cl)).session_id as string;
    const cols = await testDb<{ column_name: string }[]>`select column_name from information_schema.columns where table_schema = 'auth' and table_name = 'mfa_amr_claims'`;
    const names = cols.map((x) => x.column_name);
    console.log("FA3 auth.mfa_amr_claims columns:", names.join(","));
    await testDb.unsafe(`update auth.mfa_amr_claims set created_at = now() - interval '20 minutes', updated_at = now() - interval '20 minutes' where session_id = '${sid}'`);
    const { data, error } = await cl.auth.refreshSession();
    expect(error).toBeNull();
    const claims = decode(data.session!.access_token);
    console.log("FA3 amr after refresh of a 20-minute-old authentication:", JSON.stringify(claims.amr), "age(s) =", Math.floor(Date.now() / 1000) - amrTs(claims));
    expect(Math.floor(Date.now() / 1000) - amrTs(claims)).toBeGreaterThan(900);
    const { r } = await request(cl, A.id);
    expect(r.data).toEqual({ ok: false, error: "fresh_auth_required" });
    // and the denial really was about freshness: the same user, signing in again, is allowed
    const again = await signInAs(u.owner2!);
    expect((await request(again, A.id)).r.data).toMatchObject({ ok: true });
  });
  it("FA5 a client-supplied freshness flag changes nothing (user_metadata / app_metadata are not read)", async () => {
    await reset(A.id);
    const cl = await signInAs(u.owner2!);
    const sid = decode(await jwtOf(cl)).session_id as string;
    await testDb.unsafe(`update auth.mfa_amr_claims set created_at = now() - interval '30 minutes', updated_at = now() - interval '30 minutes' where session_id = '${sid}'`);
    await cl.auth.updateUser({ data: { fresh: true, amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }] } });
    const { data } = await cl.auth.refreshSession();
    expect((await request(cl, A.id)).r.data).toEqual({ ok: false, error: "fresh_auth_required" });
    void data;
  });
});

describe("AZ authorization with real tokens", () => {
  it("AZ1 same-tenant Owner ALLOWED; every other real identity DENIED; anon / service_role / tampering DENIED", async () => {
    await reset(A.id);
    expect((await request(c.ownerA!, A.id)).r.data).toMatchObject({ ok: true });
    await reset(A.id);
    for (const l of ["manager", "recep", "staff", "outsider", "ownerB"]) expect((await request(c[l]!, A.id)).r.data, l).toEqual({ ok: false, error: "not_owner" });
    expect((await request(c.ownerA!, rid())).r.data).toEqual({ ok: false, error: "not_owner" });
    expect((await request(c.ownerB!, A.id)).r.data).toEqual({ ok: false, error: "not_owner" });
    expect((await request(c.ownerA!, B.id)).r.data).toEqual({ ok: false, error: "not_owner" });
    const t = newExportToken();
    const an = await anonClient().rpc("request_tenant_export" as never, { p_tenant_id: A.id, p_token_hash: t.tokenHash, p_client_request_id: t.clientRequestId } as never);
    expect(an.error?.code).toBe("42501");
    const { createClient } = await import("@supabase/supabase-js");
    const svc = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } });
    const sv = await svc.rpc("request_tenant_export" as never, { p_tenant_id: A.id, p_token_hash: t.tokenHash, p_client_request_id: t.clientRequestId } as never);
    expect(sv.error?.code).toBe("42501");
    for (const fn of ["export_read_section", "get_tenant_export_status", "consume_tenant_export_token", "complete_tenant_export", "fail_tenant_export"]) {
      const a2 = await anonClient().rpc(fn as never, {} as never);
      expect(a2.error, fn).not.toBeNull();
    }
  });
  it("AZ2 inactive / removed membership is denied", async () => {
    await reset(A.id);
    await testDb`update tenant_memberships set status = 'suspended' where tenant_id = ${A.id} and user_id = ${u.removed!.id}`;
    expect((await request(c.removed!, A.id)).r.data).toEqual({ ok: false, error: "not_owner" });
    await testDb`update tenant_memberships set status = 'active', deleted_at = now() where tenant_id = ${A.id} and user_id = ${u.removed!.id}`;
    expect((await request(c.removed!, A.id)).r.data).toEqual({ ok: false, error: "not_owner" });
    await testDb`update tenant_memberships set status = 'active', deleted_at = null where tenant_id = ${A.id} and user_id = ${u.removed!.id}`;
  });
  it("AZ3 authorization is re-checked at token use and on every data page (a demoted Owner stops mid-download)", async () => {
    await reset(A.id);
    const rid1 = await startDownload(c.removed!, A.id);
    expect((await page(c.removed!, rid1, "branches")).data!.rows.length).toBeGreaterThan(0);
    await testDb`update tenant_memberships set status = 'suspended' where tenant_id = ${A.id} and user_id = ${u.removed!.id}`;
    const denied = await page(c.removed!, rid1, "branches");
    expect(denied.error?.message).toMatch(/export_denied/);
    await testDb`update tenant_memberships set status = 'active' where tenant_id = ${A.id} and user_id = ${u.removed!.id}`;
    await reset(A.id);
    const { t, r } = await request(c.removed!, A.id);
    expect(r.data).toMatchObject({ ok: true });
    await testDb`update tenant_memberships set status = 'suspended' where tenant_id = ${A.id} and user_id = ${u.removed!.id}`;
    expect((await consume(c.removed!, t.tokenHash)).data).toEqual({ ok: false, error: "invalid_token" });
    await testDb`update tenant_memberships set status = 'active' where tenant_id = ${A.id} and user_id = ${u.removed!.id}`;
  });
  it("AZ4 cross-tenant: a data page of tenant A can never be read by tenant B's Owner, and reads only A's rows for A's Owner", async () => {
    await reset(A.id);
    const ridA = await startDownload(c.ownerA!, A.id);
    expect((await page(c.ownerB!, ridA, "customers")).error?.message).toMatch(/export_denied/);
    const own = await page(c.ownerA!, ridA, "customers");
    expect(JSON.stringify(own.data)).not.toContain(SENTINELS.otherTenantMarker);
    expect(own.data!.rows.length).toBe(A.customerIds.length);
  });
});

describe("TK download token on the real database", () => {
  it("TK1 only the sha256 is stored; the raw token and its base64 form appear in no table", async () => {
    await reset(A.id);
    const { t } = await request(c.ownerA!, A.id);
    const [row] = await testDb<Loose[]>`select * from private.tenant_export_requests where tenant_id = ${A.id}`;
    expect(row!.token_hash).toBe(createHash("sha256").update(t.token).digest("hex"));
    const dump = JSON.stringify(row) + JSON.stringify(await testDb`select * from private.tenant_export_audit where tenant_id = ${A.id}`);
    expect(dump).not.toContain(t.token);
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t.token, "base64url").length).toBe(32);
  });
  it("TK2 replay, expiry, other user / tenant, malformed, enumeration", async () => {
    await reset(A.id);
    const { t } = await request(c.ownerA!, A.id);
    expect((await consume(c.ownerB!, t.tokenHash)).data).toEqual({ ok: false, error: "invalid_token" });
    expect((await consume(c.manager!, t.tokenHash)).data).toEqual({ ok: false, error: "invalid_token" });
    expect((await consume(c.owner2!, t.tokenHash)).data).toEqual({ ok: false, error: "invalid_token" }); // another Owner of the SAME tenant
    expect((await consume(c.ownerA!, "short")).data).toEqual({ ok: false, error: "invalid_token" });
    const guesses = await Promise.all(Array.from({ length: 20 }, () => consume(c.ownerA!, hashToken(randomTok()))));
    for (const g of guesses) expect(g.data).toEqual({ ok: false, error: "invalid_token" });
    expect((await consume(c.ownerA!, t.tokenHash)).data).toMatchObject({ ok: true }); // the holder is unaffected by all of the above
    expect((await consume(c.ownerA!, t.tokenHash)).data).toEqual({ ok: false, error: "invalid_token" }); // replay
    await reset(A.id);
    const e = await request(c.ownerA!, A.id);
    await testDb`update private.tenant_export_requests set token_expires_at = requested_at + interval '1 millisecond' where token_hash = ${e.t.tokenHash}`;
    expect((await consume(c.ownerA!, e.t.tokenHash)).data).toEqual({ ok: false, error: "invalid_token" });
    await expect(testDb`update private.tenant_export_requests set token_expires_at = requested_at + interval '11 minutes' where token_hash = ${e.t.tokenHash}`).rejects.toThrow(/token_window/);
  });
  it("TK3 concurrent token use over real parallel HTTP: exactly one winner", async () => {
    await reset(A.id);
    const { t } = await request(c.ownerA!, A.id);
    const rs = await Promise.all(Array.from({ length: 12 }, () => consume(c.ownerA!, t.tokenHash)));
    expect(rs.filter((x) => x.data?.ok === true).length).toBe(1);
  });
});

describe("RL rate limit on the real database", () => {
  it("RL1 three successes per 24h, the fourth is denied; failures do not consume quota; one active; separate tenants independent", async () => {
    await reset(A.id);
    await reset(B.id);
    for (let i = 0; i < 3; i++) {
      const id = await startDownload(c.ownerA!, A.id);
      expect((await complete(c.ownerA!, id, { customers: 1 }, 100)).data).toEqual({ ok: true });
    }
    const fourth = await request(c.ownerA!, A.id);
    expect(fourth.r.data).toMatchObject({ ok: false, error: "rate_limited" });
    expect(typeof fourth.r.data!.retry_at).toBe("string");
    expect((await request(c.ownerB!, B.id)).r.data).toMatchObject({ ok: true }); // B independent
    await reset(B.id);
    // failures do not consume the quota
    await reset(A.id);
    for (let i = 0; i < 4; i++) {
      const id = await startDownload(c.ownerA!, A.id);
      expect((await failIt(c.ownerA!, id, "read_failed")).data).toEqual({ ok: true });
    }
    for (let i = 0; i < 3; i++) expect((await complete(c.ownerA!, await startDownload(c.ownerA!, A.id), { customers: 1 }, 1)).data).toEqual({ ok: true });
    // one active at a time
    await reset(A.id);
    expect((await request(c.ownerA!, A.id)).r.data).toMatchObject({ ok: true });
    expect((await request(c.ownerA!, A.id)).r.data).toEqual({ ok: false, error: "export_in_progress" });
  });
  it("RL2 ten failures in 24h block", async () => {
    await reset(A.id);
    for (let i = 0; i < 10; i++) await testDb`insert into private.tenant_export_requests (tenant_id, actor_id, client_request_id, token_hash, token_expires_at, status, error_code) values (${A.id}, ${u.ownerA!.id}, ${rid()}, ${hashToken(randomTok())}, now() + interval '5 minutes', 'failed', 'read_failed')`;
    expect((await request(c.ownerA!, A.id)).r.data).toEqual({ ok: false, error: "too_many_failures" });
  });
  it("RL3 real parallel HTTP: 12 simultaneous requests -> exactly one reservation; at the cap (2 done) 12 more -> exactly one; never more than 3 completed", async () => {
    await reset(A.id);
    const first = await Promise.all(Array.from({ length: 12 }, () => request(c.ownerA!, A.id)));
    expect(first.filter((x) => x.r.data?.ok === true).length).toBe(1);
    await reset(A.id);
    for (let i = 0; i < 2; i++) await complete(c.ownerA!, await startDownload(c.ownerA!, A.id), { customers: 1 }, 1);
    const atCap = await Promise.all(Array.from({ length: 12 }, () => request(c.ownerA!, A.id)));
    expect(atCap.filter((x) => x.r.data?.ok === true).length).toBe(1);
    const winner = atCap.find((x) => x.r.data?.ok === true)!;
    const k = await consume(c.ownerA!, winner.t.tokenHash);
    expect((await complete(c.ownerA!, k.data!.request_id, { customers: 1 }, 1)).data).toEqual({ ok: true });
    expect((await request(c.ownerA!, A.id)).r.data).toMatchObject({ ok: false, error: "rate_limited" });
    expect((await testDb`select count(*)::int n from private.tenant_export_requests where tenant_id = ${A.id} and status = 'completed'`)[0]!.n).toBe(3);
  });
});

const randomTok = () => Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString("base64url");

const ownCount: Record<string, () => Promise<number>> = {};
const countOf = (section: string, t: string): Promise<number> => {
  const q: Record<string, string> = {
    tenant: "select 1 as n where $1::uuid is not null",
    branches: "select count(*)::int n from branches where tenant_id = $1",
    staff: "select count(*)::int n from staff_members where tenant_id = $1",
    staff_branches: "select count(*)::int n from staff_branches x join staff_members s on s.id = x.staff_member_id where s.tenant_id = $1",
    staff_services: "select count(*)::int n from staff_services x join staff_members s on s.id = x.staff_member_id where s.tenant_id = $1",
    service_branches: "select count(*)::int n from service_branches x join services s on s.id = x.service_id where s.tenant_id = $1",
    staff_schedules: "select count(*)::int n from staff_schedules where tenant_id = $1",
    staff_schedule_exceptions: "select count(*)::int n from staff_schedule_exceptions where tenant_id = $1",
    services: "select count(*)::int n from services where tenant_id = $1",
    customers: "select count(*)::int n from customers where tenant_id = $1",
    appointments: "select count(*)::int n from appointments where tenant_id = $1",
    appointment_items: "select count(*)::int n from appointment_items where tenant_id = $1",
    appointment_sales: "select count(*)::int n from appointment_sales where tenant_id = $1",
    appointment_sale_items: "select count(*)::int n from appointment_sale_items where tenant_id = $1",
    payments: "select count(*)::int n from payments where tenant_id = $1",
    expenses: "select count(*)::int n from expenses where tenant_id = $1",
    expense_payments: "select count(*)::int n from expense_payments where tenant_id = $1",
    staff_commission_rules: "select count(*)::int n from staff_commission_rules where tenant_id = $1",
    treatment_notes: "select count(*)::int n from treatment_notes where tenant_id = $1",
    treatment_photos: "select count(*)::int n from treatment_media where tenant_id = $1",
    consent_booking_claims: "select count(*)::int n from booking_account_claims where tenant_id = $1",
    consent_account_links: "select count(*)::int n from customer_account_links where tenant_id = $1",
  };
  return testDb.unsafe(q[section]!, [t] as never).then((r) => Number((r[0] as Loose).n));
};
void ownCount;

describe("EX real export through the running application", () => {
  let zip: Map<string, Buffer>;
  let folder = "";
  let rawToken = "";
  let ownerJwt = "";
  let refresh = "";

  it("EX1 the real route streams a valid zip for the Owner (cookie session -> POST token body -> application/zip)", async () => {
    expect(appReachable, "the local app must be running at HOSTED_ACCEPTANCE_APP_URL").toBe(true);
    await reset(A.id);
    const cookie = await cookieJar(u.ownerA!);
    const { t, r } = await request(c.ownerA!, A.id);
    expect(r.data).toMatchObject({ ok: true });
    rawToken = t.token;
    ownerJwt = await jwtOf(c.ownerA!);
    refresh = (await c.ownerA!.auth.getSession()).data.session!.refresh_token;
    const res = await post(cookie, t.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="salonos-export-\d{4}-\d{2}-\d{2}-\d{4}\.zip"/);
    const buf = Buffer.from(await res.arrayBuffer());
    zip = readZip(buf); // independent reader: central directory, deflate, crc32, descriptors, UTF-8 flags
    folder = [...zip.keys()][0]!.split("/")[0]! + "/";
    expect(folder).toMatch(/^salonos-export-\d{4}-\d{2}-\d{2}-\d{4}\/$/);
    // replay of the same token over HTTP is refused; so is a request with no cookie
    expect((await post(cookie, t.token)).status).toBe(403);
    expect((await post(null, t.token)).status).toBe(401);
    expect((await fetch(`${env.appUrl}/api/tenant-export`, { method: "GET" })).status).toBe(405);
    const completed = await testDb<Loose[]>`select status, archive_bytes, entity_counts from private.tenant_export_requests where tenant_id = ${A.id}`;
    expect(completed[0]).toMatchObject({ status: "completed" });
    expect(Number(completed[0]!.archive_bytes)).toBe(buf.length);
  });
  it("EX2 22 CSV sections + salonos-export.json + metadata.json (last), BOM, separator, version 1", async () => {
    const names = [...zip.keys()];
    expect(names.filter((n) => n.endsWith(".csv")).length).toBe(SECTIONS.length);
    expect(SECTIONS.length).toBe(22);
    for (const s of SECTIONS) expect(names).toContain(`${folder}csv/${s.key}.csv`);
    expect(names.at(-1)).toBe(`${folder}metadata.json`);
    expect(names).toContain(`${folder}salonos-export.json`);
    for (const s of SECTIONS) {
      const b = zip.get(`${folder}csv/${s.key}.csv`)!;
      expect(b.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), s.key).toBe(true);
      expect(b.toString("utf8").slice(1).split("\r\n")[0], s.key).toBe(s.columns.join(";"));
    }
    const meta = JSON.parse(zip.get(`${folder}metadata.json`)!.toString("utf8"));
    expect(meta.export_version).toBe(1);
    const json = JSON.parse(zip.get(`${folder}salonos-export.json`)!.toString("utf8"));
    expect(json.export_version).toBe(1);
    expect(Object.keys(json.sections).length).toBe(22);
  });
  it("EX3 every section: exact row count for tenant A, tenant isolation, relation coherence, deterministic / typed JSON", async () => {
    const json = JSON.parse(zip.get(`${folder}salonos-export.json`)!.toString("utf8"));
    const meta = JSON.parse(zip.get(`${folder}metadata.json`)!.toString("utf8"));
    for (const s of SECTIONS) {
      const expected = await countOf(s.key, A.id);
      expect(json.sections[s.key].length, `${s.key} json`).toBe(expected);
      expect(meta.entity_counts[s.key], `${s.key} meta`).toBe(expected);
      const csvRows = zip.get(`${folder}csv/${s.key}.csv`)!.toString("utf8").slice(1);
      expect(csvRows.length, s.key).toBeGreaterThan(10);
      for (const row of json.sections[s.key]) expect(Object.keys(row), s.key).toEqual([...s.columns].sort());
      expect(Object.keys(json.sections[s.key][0] ?? {}).join(","), s.key).toBe(Object.keys(json.sections[s.key][0] ?? {}).sort().join(","));
    }
    const ids = (k: string) => new Set(json.sections[k].map((r: Loose) => r.id));
    for (const r of json.sections.appointments) {
      expect(ids("customers").has(r.customer_id)).toBe(true);
      expect(ids("branches").has(r.branch_id)).toBe(true);
    }
    for (const r of json.sections.appointment_items) {
      expect(ids("appointments").has(r.appointment_id)).toBe(true);
      expect(ids("services").has(r.service_id)).toBe(true);
      expect(ids("staff").has(r.staff_member_id)).toBe(true);
    }
    for (const r of json.sections.appointment_sale_items) expect(ids("appointment_sales").has(r.sale_id)).toBe(true);
    for (const r of json.sections.payments) expect(ids("appointment_sales").has(r.appointment_sale_id)).toBe(true);
    for (const r of json.sections.expense_payments) expect(ids("expenses").has(r.expense_id)).toBe(true);
    for (const r of json.sections.treatment_photos) expect(ids("appointment_items").has(r.appointment_item_id)).toBe(true);
    // types and money / currency / dates stay typed in the JSON
    expect(typeof json.sections.services[0].price).toBe("number");
    expect(json.sections.services[0].price).toBe(500.5);
    expect(json.sections.payments[0].amount).toBe(100.25);
    expect(json.sections.appointment_sales[0].currency).toBe("TRY");
    expect(json.sections.branches[0].is_primary === true || json.sections.branches[0].is_primary === false).toBe(true);
    expect(json.sections.appointments[0].scheduled_start_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(json.sections.expenses[0].expense_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(json.sections.tenant[0].currency).toBe("TRY");
    expect(meta.consistency.passes_identical).toBe(true);
    // deterministic contract: re-serialising the parsed sections with sorted keys reproduces the exact bytes
    const raw = zip.get(`${folder}salonos-export.json`)!.toString("utf8");
    const { canonicalStringify } = await import("@/lib/modules/export/csv");
    for (const s of SECTIONS) expect(raw).toContain(`"${s.key}":[` + json.sections[s.key].map((r: Loose) => canonicalStringify(r)).join(",") + "]");
  });
  it("EX4 FORBIDDEN DATA: secrets, tokens, provider ids, hashes, admin records, other tenants appear NOWHERE in the zip", async () => {
    const all = [...zip.entries()].map(([k, v]) => k + "\n" + v.toString("utf8")).join("\n");
    const pwHashes = (await testDb<{ h: string }[]>`select encrypted_password h from auth.users where id in ${testDb(userIds)}`).map((x) => x.h).filter(Boolean);
    expect(pwHashes.length).toBeGreaterThan(5);
    const forbidden = [
      env.serviceRoleKey, env.publishableKey, rawToken, ownerJwt, refresh, ...pwHashes,
      SENTINELS.providerCustomer, SENTINELS.providerSub, SENTINELS.otherTenantMarker, "SECRETHASH-A", "snap-A@", u.padmin!.email, u.padmin!.id,
      B.id, u.ownerB!.email, u.ownerB!.id, "provider_customer_id", "provider_subscription_id", "encrypted_password", "access_token", "refresh_token", "service_role", "SUPABASE_",
    ];
    for (const f of forbidden) expect(all.includes(f), `forbidden string present: ${f.slice(0, 12)}…`).toBe(false);
    expect(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./.test(all)).toBe(false); // any JWT-looking value
    expect(/\$2[aby]\$\d\d\$/.test(all)).toBe(false); // bcrypt
    const dataOnly = [...zip.entries()].filter(([k]) => !k.endsWith("metadata.json")).map(([, v]) => v.toString("utf8")).join("|"); // metadata.json only NAMES the excluded categories in prose
    expect(dataOnly.match(/storage_path|created_by|idempotency|secret_hash|user_id/)?.[0] ?? null, "forbidden column name in the data files").toBeNull();
    expect(all).toContain("Müşteri A"); // and the real data is there
  });
  it("EX5 CSV: formula guard for = + - @ TAB CR LF, quotes, semicolons, newlines, Turkish, emoji, long text, nulls; the independent parse is lossless", async () => {
    const csv = zip.get(`${folder}csv/customers.csv`)!.toString("utf8").slice(1);
    const json = JSON.parse(zip.get(`${folder}salonos-export.json`)!.toString("utf8"));
    // a small RFC-4180-style parser with ";" separator
    const rows: string[][] = [];
    let cur: string[] = [], cell = "", q = false;
    for (let i = 0; i < csv.length; i++) {
      const ch = csv[i]!;
      if (q) { if (ch === '"') { if (csv[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ";") { cur.push(cell); cell = ""; }
      else if (ch === "\r" && csv[i + 1] === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = ""; i++; }
      else cell += ch;
    }
    const head = rows[0]!;
    expect(head.join(";")).toBe(SECTIONS.find((s) => s.key === "customers")!.columns.join(";"));
    const body = rows.slice(1);
    expect(body.length).toBe(A.customerIds.length);
    const ni = head.indexOf("notes");
    const byId = new Map(body.map((r) => [r[head.indexOf("id")]!, r]));
    for (const row of json.sections.customers as Loose[]) {
      const cellv = byId.get(row.id)![ni]!;
      if (row.notes === null) { expect(cellv).toBe(""); continue; }
      const dangerous = /^[=+\-@\t\r\n]/.test(row.notes);
      expect(cellv).toBe(dangerous ? `'${row.notes}` : row.notes); // lossless apart from the documented guard prefix
    }
    for (const e of EVIL) expect(json.sections.customers.some((r: Loose) => r.notes === e), JSON.stringify(e)).toBe(true); // JSON keeps raw
    expect(json.sections.customers.some((r: Loose) => r.notes === LONG)).toBe(true);
    expect(json.sections.customers.some((r: Loose) => /😀/.test(r.notes ?? "") && /ÇĞİÖŞÜ/.test(r.notes))).toBe(true);
    expect(body.every((r) => r.length === head.length)).toBe(true);
  });
  it("EX6 the audit and the request row hold no PII, no raw token; state is clean after the export (no object, no bucket, no blob)", async () => {
    const audit = JSON.stringify(await testDb`select * from private.tenant_export_audit where tenant_id = ${A.id}`) + JSON.stringify(await testDb`select * from private.tenant_export_requests where tenant_id = ${A.id}`);
    for (const pii of ["Müşteri", "example.test", "+9050011", u.ownerA!.email, "işlem", rawToken]) expect(audit.includes(pii), pii).toBe(false);
    const st = await testDb<Loose[]>`select (select count(*) from storage.buckets)::int b, (select count(*) from storage.objects)::int o`;
    console.log("EX6 storage after export: buckets =", st[0]!.b, "objects =", st[0]!.o);
    expect((await testDb`select count(*)::int n from storage.buckets where name ilike '%export%'`)[0]!.n).toBe(0);
    expect((await testDb`select count(*)::int n from storage.objects where bucket_id ilike '%export%'`)[0]!.n).toBe(0);
  });
});

describe("SN concurrent writes during an export (creation fence + two-pass digest)", () => {
  async function run(mutate: (calls: number, pass: number) => Promise<void>) {
    await reset(A.id);
    const id = await startDownload(c.ownerA!, A.id);
    const k = (await testDb<Loose[]>`select fence_at from private.tenant_export_requests where id = ${id}`)[0]!;
    let calls = 0;
    const seenCustomers: Record<number, number> = { 1: 0, 2: 0 };
    let pass = 1;
    const fetchPage: PageFetcher = async (section, after) => {
      calls++;
      if (section === "tenant" && after === null && calls > 3) pass = 2;
      await mutate(calls, pass);
      const p = await page(c.ownerA!, id, section, after, 3);
      if (p.error) throw new Error(p.error.message);
      if (section === "customers") seenCustomers[pass] = (seenCustomers[pass] ?? 0) + p.data!.rows.length;
      return { rows: p.data!.rows, next: p.data!.next };
    };
    const { stream, report } = buildExportArchive({ fetchPage, now: new Date(), snapshotAt: String(k.fence_at), tenantTimezone: "Europe/Nicosia", tenantCurrency: "TRY" });
    const chunks: Buffer[] = [];
    for await (const ch of stream) chunks.push(Buffer.from(ch));
    return { files: readZip(Buffer.concat(chunks)), report: report(), seenCustomers };
  }
  const customersNow = async () => Number((await testDb`select count(*)::int n from customers where tenant_id = ${A.id}`)[0]!.n);

  it("SN1 (A) a row created after the fence is excluded from BOTH passes: consistent, no flag needed", async () => {
    const before = await customersNow();
    let done = false;
    const { files, report } = await run(async (calls) => {
      if (calls === 2 && !done) { done = true; await testDb`insert into customers (tenant_id, full_name) values (${A.id}, 'SN1-yeni-musteri')`; }
    });
    const json = JSON.parse([...files.entries()].find(([n]) => n.endsWith("salonos-export.json"))![1].toString());
    expect(JSON.stringify(json)).not.toContain("SN1-yeni-musteri");
    expect(json.sections.customers.length).toBe(before);
    expect(report.passesIdentical).toBe(true);
    await testDb`delete from customers where tenant_id = ${A.id} and full_name = 'SN1-yeni-musteri'`;
  });
  it("SN2 (B) an UPDATE landing between the two passes is FLAGGED in metadata (passes_identical=false + the section name)", async () => {
    let done = false;
    const { files, report } = await run(async (_c, pass) => {
      if (pass === 2 && !done) { done = true; await testDb`update customers set full_name = 'SN2-degisti' where id = ${A.customerIds[1]}`; }
    });
    const meta = JSON.parse([...files.entries()].find(([n]) => n.endsWith("metadata.json"))![1].toString());
    console.log("SN2 metadata consistency:", JSON.stringify({ passes_identical: meta.consistency.passes_identical, mismatched: meta.consistency.mismatched_sections }));
    expect(report.passesIdentical).toBe(false);
    expect(meta.consistency.passes_identical).toBe(false);
    expect(meta.consistency.mismatched_sections).toContain("customers");
    await testDb`update customers set full_name = ${`Müşteri A 1`} where id = ${A.customerIds[1]}`;
  });
  it("SN3 (C) a hard DELETE (junction row) between the passes is FLAGGED", async () => {
    await testDb`insert into staff_services (staff_member_id, service_id) select ${A.staffId}, s.id from services s where s.tenant_id = ${A.id} and not exists (select 1 from staff_services x where x.staff_member_id = ${A.staffId} and x.service_id = s.id)`;
    let done = false;
    const { report } = await run(async (_c, pass) => {
      if (pass === 2 && !done) { done = true; await testDb`delete from staff_services where staff_member_id = ${A.staffId} and service_id = ${A.svcId}`; }
    });
    expect(report.passesIdentical).toBe(false);
    expect(report.mismatchedSections).toContain("staff_services");
    await testDb`insert into staff_services (staff_member_id, service_id) values (${A.staffId}, ${A.svcId}) on conflict do nothing`;
  });
  it("SN4 an update BEFORE a section is first read is simply current state in both passes (consistent; documented limit: not point-in-time)", async () => {
    const { report } = await run(async (calls) => {
      if (calls === 1) await testDb`update customers set notes = 'SN4-guncel' where id = ${A.customerIds[2]}`;
    });
    expect(report.passesIdentical).toBe(true);
    await testDb`update customers set notes = ${EVIL[2]!} where id = ${A.customerIds[2]}`;
  });
});

describe("AU audit model on the real database", () => {
  it("AU1 append-only against postgres itself, no REST access to either table, API roles have no privilege", async () => {
    await expect(testDb`update private.tenant_export_audit set event = 'failed' where id = (select min(id) from private.tenant_export_audit)`).rejects.toThrow(/append-only/);
    await expect(testDb`delete from private.tenant_export_audit where id = (select min(id) from private.tenant_export_audit)`).rejects.toThrow(/append-only/);
    await expect(testDb`truncate private.tenant_export_audit`).rejects.toThrow(/append-only/);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const [p] = await testDb<Loose[]>`select has_table_privilege(${role}, 'private.tenant_export_audit', 'select,insert,update,delete,truncate') a, has_table_privilege(${role}, 'private.tenant_export_requests', 'select,insert,update,delete,truncate') b`;
      expect([p!.a, p!.b], role).toEqual([false, false]);
    }
    const tok = await jwtOf(c.ownerA!);
    for (const schema of ["private", "public"]) {
      for (const tbl of ["tenant_export_audit", "tenant_export_requests"]) {
        const r = await fetch(`${env.supabaseUrl}/rest/v1/${tbl}?select=*`, { headers: { apikey: env.publishableKey, authorization: `Bearer ${tok}`, "Accept-Profile": schema } });
        expect(r.status, `${schema}.${tbl}`).toBeGreaterThanOrEqual(400);
        const body = await r.text();
        expect(body).not.toMatch(/"tenant_id"/);
      }
    }
    // an authenticated session cannot INSERT into the audit through any API path (no function accepts it either)
    await expect(
      testDb.begin(async (sql) => {
        await sql`set local role authenticated`;
        await sql`insert into private.tenant_export_audit (event) values ('requested')`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
  it("AU2 recorded fields: actor, tenant, request id, start / completion, success / failure, counts, bytes, safe error codes; no PII", async () => {
    const rows = await testDb<Loose[]>`select * from private.tenant_export_audit where tenant_id = ${A.id} order by id`;
    const events = new Set(rows.map((r) => r.event));
    for (const e of ["requested", "downloaded", "completed", "denied"]) expect(events.has(e), e).toBe(true);
    const done = rows.find((r) => r.event === "completed")!;
    expect(done.actor_id).toBeTruthy();
    expect(done.request_id).toBeTruthy();
    expect(Number(done.archive_bytes)).toBeGreaterThanOrEqual(0);
    expect(typeof done.entity_counts).toBe("object");
    for (const r of rows) if (r.error_code) expect(r.error_code).toMatch(/^[a-z0-9_]{1,40}$/);
    const all = JSON.stringify(rows);
    for (const pii of ["Müşteri", "@example.test", "+90500", "işlem notu"]) expect(all.includes(pii), pii).toBe(false);
    const req = rows.find((r) => r.event === "requested")!;
    expect(new Date(done.occurred_at).getTime()).toBeGreaterThanOrEqual(new Date(req.occurred_at).getTime()); // start <= completion
  });
});

describe("BI billing independence", () => {
  it("BI1 export authorization and data do not depend on the subscription state, and the subscription is not changed by an export", async () => {
    const [plan] = await testDb<{ id: string }[]>`select id from plans limit 1`;
    const states: [string, Loose][] = [
      ["trialing", { status: "trialing", mode: "paid", ts: "now() - interval '2 days'", te: "now() + interval '28 days'" }],
      ["active", { status: "active", mode: "paid" }],
      ["grace", { status: "past_due", mode: "paid", grace: "now() + interval '7 days'" }],
      ["read_only-derived", { status: "expired", mode: "paid" }],
      ["blocked-derived", { status: "canceled", mode: "paid" }],
      ["pilot-protected", { status: "active", mode: "pilot", prot: true }],
    ];
    for (const [name, fx] of states) {
      const t = await createTestTenant(`h-s2b-bi-${name.replace(/[^a-z]/g, "")}-${rid().slice(0, 5)}`, u.ownerA!.id);
      tenantIds.push(t.id);
      await testDb.unsafe(`insert into subscriptions (tenant_id, plan_id, status, billing_mode, trial_started_at, trial_ends_at, grace_ends_at, protected) values ('${t.id}', '${plan!.id}', '${fx.status}', '${fx.mode}', ${fx.ts ?? "null"}, ${fx.te ?? "null"}, ${fx.grace ?? "null"}, ${fx.prot ? "true" : "false"})`);
      const dg = async () => JSON.stringify(await testDb`select (select to_jsonb(s) - 'updated_at' from subscriptions s where tenant_id = ${t.id}) s, (select to_jsonb(x) - 'updated_at' from tenants x where id = ${t.id}) t, (select count(*) from subscription_events where tenant_id = ${t.id}) e`);
      const before = await dg();
      const id = await startDownload(c.ownerA!, t.id);
      for (const s of SECTIONS) expect((await page(c.ownerA!, id, s.key)).error, `${name} ${s.key}`).toBeNull();
      expect((await complete(c.ownerA!, id, { customers: 1 }, 1)).data, name).toEqual({ ok: true });
      expect(await dg(), name).toBe(before);
    }
  });
});

describe("CG catalog and grants on the real project", () => {
  const fns = ["request_tenant_export", "consume_tenant_export_token", "export_read_section", "complete_tenant_export", "fail_tenant_export", "get_tenant_export_status"];
  it("CG1 RLS on, no policy, no API privilege on both tables; six RPCs definer + search_path + authenticated only; helpers closed", async () => {
    const t = await testDb<Loose[]>`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relname like 'tenant_export_%' and c.relkind = 'r'`;
    expect(t.length).toBe(2);
    for (const r of t) expect(r.relrowsecurity).toBe(true);
    expect((await testDb`select count(*)::int n from pg_policies where schemaname = 'private'`)[0]!.n).toBe(0);
    const f = await testDb<Loose[]>`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s, has_function_privilege('public', p.oid, 'execute') pub from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any(${fns})`;
    expect(f.length).toBe(6);
    for (const r of f) { expect(r.prosecdef).toBe(true); expect(JSON.stringify(r.proconfig)).toMatch(/search_path=/); expect([r.a, r.u, r.s, r.pub], r.proname).toEqual([false, true, false, false]); }
    const h = await testDb<Loose[]>`select p.proname, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname like 'export\_%'`;
    expect(h.length).toBeGreaterThanOrEqual(4);
    for (const r of h) expect([r.a, r.u, r.s], r.proname).toEqual([false, false, false]);
    expect((await testDb`select count(*)::int n from storage.buckets where name ilike '%export%'`)[0]!.n).toBe(0);
  });
});

describe("FA4 REAL elapsed authentication age (no tampering)", () => {
  it("FA4 a token minted at sign-in is refused for export once its authentication is more than 15 minutes old", async () => {
    const wait = agedSignIn.at + 16 * 60 * 1000 + 5000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await reset(A.id);
    const claims = decode(agedSignIn.token);
    const age = Math.floor(Date.now() / 1000) - amrTs(claims);
    console.log("FA4 authentication age (s) of the original, unrefreshed token:", age);
    expect(age).toBeGreaterThan(900);
    // a still-valid (1 h) access token: the SAME signed token that was fresh at minute 0
    const { createClient } = await import("@supabase/supabase-js");
    const raw = createClient(env.supabaseUrl, env.publishableKey, { global: { headers: { Authorization: `Bearer ${agedSignIn.token}` } }, auth: { persistSession: false } });
    const t = newExportToken();
    const r = await raw.rpc("request_tenant_export" as never, { p_tenant_id: A.id, p_token_hash: t.tokenHash, p_client_request_id: t.clientRequestId } as never);
    expect(r.data).toEqual({ ok: false, error: "fresh_auth_required" });
    // refreshing it does not rescue it either
    const refreshed = await c.aged!.auth.refreshSession();
    const r2 = await request(c.aged!, A.id);
    void refreshed;
    expect(r2.r.data).toEqual({ ok: false, error: "fresh_auth_required" });
  }, 1500000);
});

export const _unused = [admin, exportFolder];
