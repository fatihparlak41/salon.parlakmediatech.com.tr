import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { cleanupTenants, cleanupUsers, createBranch, createService, createStaffMember, createTestMembershipFromTemplate, createTestTenant, createTestUser, sha256Hex, testDb, type TestTenant, type TestUser } from "./helpers";
import { SECTIONS } from "@/lib/modules/export/sections";
import { buildExportArchive, type PageFetcher } from "@/lib/modules/export/archive";
import { readZip } from "./export-zip-reader";

/**
 * Faz SAAS.1C.2b - tenant export database contract. IDs: EO owner-only, FA fresh auth, TK token, RL rate limit / races, RD read pages + isolation +
 * scope, SN snapshot, AU audit, SE catalog / grants, NI no state change, EC end-to-end correctness. Everything synthetic.
 */

type Sql = postgres.TransactionSql;
type Role = "authenticated" | "anon" | "service_role";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

const users: Record<string, TestUser> = {};
const userIds: string[] = [];
const tenantIds: string[] = [];
const nowSec = () => Math.floor(Date.now() / 1000);
const fresh = (ageSec = 30) => [{ method: "password", timestamp: nowSec() - ageSec }];

async function asApi<T>(userId: string | null, fn: (sql: Sql) => Promise<T>, opts: { role?: Role; amr?: unknown; extra?: Loose } = {}): Promise<T> {
  const role = opts.role ?? "authenticated";
  const claims: Loose = { role, ...(userId ? { sub: userId } : {}), amr: "amr" in opts ? opts.amr : fresh(), ...(opts.extra ?? {}) };
  return (await testDb.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    if (userId) await sql`select set_config('request.jwt.claim.sub', ${userId}, true)`;
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

type Tok = { raw: string; hash: string; cid: string };
const tok = (): Tok => {
  const raw = randomUUID() + randomUUID();
  return { raw, hash: sha256Hex(raw), cid: randomUUID() };
};
const request = (uid: string, tenantId: string, t: Tok = tok(), opts: { amr?: unknown; extra?: Loose } = {}) =>
  asApi(uid, async (sql) => (await sql`select public.request_tenant_export(${tenantId}, ${t.hash}, ${t.cid}) as r`)[0]!.r as Loose, opts);
const consume = (uid: string, hash: string) => asApi(uid, async (sql) => (await sql`select public.consume_tenant_export_token(${hash}) as r`)[0]!.r as Loose);
const page = (uid: string, rid: string, section: string, after: string | null = null, limit = 500) =>
  asApi(uid, async (sql) => (await sql`select public.export_read_section(${rid}, ${section}, ${after}, ${limit}) as r`)[0]!.r as Loose);
const complete = (uid: string, rid: string, counts: unknown, bytes: number) =>
  asApi(uid, async (sql) => (await sql`select public.complete_tenant_export(${rid}, ${counts === null ? null : sql.json(counts as never)}::jsonb, ${bytes}) as r`)[0]!.r as Loose);

async function newUser(label: string) {
  const u = await createTestUser(`s2b-${label}`);
  userIds.push(u.id);
  users[label] = u;
  return u;
}

/** A tenant with the full set of entities. Strings carry the tag so cross-tenant leakage is detectable. */
async function seed(tag: string, ownerId: string): Promise<TestTenant & { itemId: string }> {
  const t = await createTestTenant(`h-s2b-${tag.toLowerCase()}-${randomUUID().slice(0, 6)}`, ownerId);
  tenantIds.push(t.id);
  const branch = await createBranch(t.id, `Şube ${tag}`);
  const staff = await createStaffMember(t.id, `Personel ${tag}`);
  const svc = await createService(t.id, `Hizmet ${tag}`, 30, 500);
  await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff.id}, ${branch})`;
  await testDb`insert into service_branches (service_id, branch_id) values (${svc.id}, ${branch})`;
  await testDb`insert into staff_services (staff_member_id, service_id) values (${staff.id}, ${svc.id})`;
  await testDb`insert into staff_schedules (tenant_id, staff_member_id, branch_id, weekday, start_time, end_time) values (${t.id}, ${staff.id}, ${branch}, 1, '09:00', '17:00')`;
  await testDb`insert into staff_schedule_exceptions (tenant_id, staff_member_id, exception_date, type, reason) values (${t.id}, ${staff.id}, current_date, 'unavailable', ${"izin " + tag})`;
  const [c] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name, phone, email, notes) values (${t.id}, ${"Müşteri " + tag}, ${"+905001112233"}, ${"musteri-" + tag + "@example.test"}, ${"not " + tag}) returning id`;
  const [a] = await testDb<{ id: string }[]>`insert into appointments (tenant_id, branch_id, customer_id, status, source, notes, scheduled_start_at, scheduled_end_at) values (${t.id}, ${branch}, ${c!.id}, 'scheduled', 'internal', ${"randevu " + tag}, now() + interval '1 day', now() + interval '1 day 30 minutes') returning id`;
  const [it] = await testDb<{ id: string }[]>`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence) values (${t.id}, ${a!.id}, ${svc.id}, ${staff.id}, now() + interval '1 day', now() + interval '1 day 30 minutes', 30, 500, 1) returning id`;
  const [s] = await testDb<{ id: string }[]>`insert into appointment_sales (tenant_id, branch_id, appointment_id, customer_id, currency) values (${t.id}, ${branch}, ${a!.id}, ${c!.id}, 'TRY') returning id`;
  await testDb`insert into appointment_sale_items (tenant_id, sale_id, appointment_item_id, service_id, service_name_snapshot, unit_price) values (${t.id}, ${s!.id}, ${it!.id}, ${svc.id}, ${"Hizmet " + tag}, 500)`;
  await testDb`insert into payments (tenant_id, branch_id, appointment_sale_id, amount, method, idempotency_key) values (${t.id}, ${branch}, ${s!.id}, 100, 'cash', ${randomUUID()})`;
  const [e] = await testDb<{ id: string }[]>`insert into expenses (tenant_id, branch_id, category_key, description, expense_date, amount, currency) values (${t.id}, ${branch}, 'rent', ${"kira " + tag}, current_date, 1000, 'TRY') returning id`;
  await testDb`insert into expense_payments (tenant_id, expense_id, amount, method, idempotency_key) values (${t.id}, ${e!.id}, 100, 'cash', ${randomUUID()})`;
  await testDb`insert into staff_commission_rules (tenant_id, staff_member_id, service_id, kind, percentage, effective_from) values (${t.id}, ${staff.id}, ${svc.id}, 'percentage', 10, current_date)`;
  await testDb`insert into treatment_notes (appointment_item_id, tenant_id, note) values (${it!.id}, ${t.id}, ${"işlem notu " + tag})`;
  await testDb`insert into treatment_media (tenant_id, appointment_item_id, kind, mime_type, size_bytes, storage_path) values (${t.id}, ${it!.id}, 'before', 'image/jpeg', 1000, ${`${t.id}/${randomUUID()}.jpg`})`;
  await testDb`insert into booking_account_claims (tenant_id, customer_id, appointment_id, email_snapshot, email_normalized_snapshot, secret_hash, expires_at) values (${t.id}, ${c!.id}, ${a!.id}, ${"snap-" + tag + "@example.test"}, ${"snap-" + tag + "@example.test"}, ${"SECRETHASH-" + tag}, now() + interval '1 day')`;
  await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via) values (${ownerId}, ${t.id}, ${c!.id}, 'verified_booking_claim')`;
  return { ...t, itemId: it!.id };
}

let A: TestTenant & { itemId: string };
let B: TestTenant & { itemId: string };

beforeAll(async () => {
  for (const l of ["ownerA", "ownerB", "manager", "recep", "staff", "outsider"]) await newUser(l);
  A = await seed("A", users.ownerA!.id);
  B = await seed("B", users.ownerB!.id);
  await createTestMembershipFromTemplate(A.id, users.manager!.id, "SALON_MANAGER");
  await createTestMembershipFromTemplate(A.id, users.recep!.id, "RECEPTIONIST");
  await createTestMembershipFromTemplate(A.id, users.staff!.id, "STYLIST");
});

afterAll(async () => {
  await testDb`alter table private.tenant_export_audit disable trigger tenant_export_audit_append_only`;
  await testDb`delete from private.tenant_export_audit where actor_id in ${testDb(userIds)}`;
  await testDb`alter table private.tenant_export_audit enable trigger tenant_export_audit_append_only`;
  await testDb`delete from staff_commission_rules where tenant_id in ${testDb(tenantIds)}`;
  await cleanupTenants(tenantIds);
  await cleanupUsers(userIds);
  await testDb.end();
});

const OWN_COUNT_SQL: Record<string, (t: string) => Promise<number>> = {
  tenant: async (t) => 1 + 0 * t.length,
  branches: async (t) => (await testDb`select count(*)::int n from branches where tenant_id = ${t}`)[0]!.n,
  staff: async (t) => (await testDb`select count(*)::int n from staff_members where tenant_id = ${t}`)[0]!.n,
  staff_branches: async (t) => (await testDb`select count(*)::int n from staff_branches x join staff_members s on s.id = x.staff_member_id where s.tenant_id = ${t}`)[0]!.n,
  staff_services: async (t) => (await testDb`select count(*)::int n from staff_services x join staff_members s on s.id = x.staff_member_id where s.tenant_id = ${t}`)[0]!.n,
  service_branches: async (t) => (await testDb`select count(*)::int n from service_branches x join services s on s.id = x.service_id where s.tenant_id = ${t}`)[0]!.n,
  staff_schedules: async (t) => (await testDb`select count(*)::int n from staff_schedules where tenant_id = ${t}`)[0]!.n,
  staff_schedule_exceptions: async (t) => (await testDb`select count(*)::int n from staff_schedule_exceptions where tenant_id = ${t}`)[0]!.n,
  services: async (t) => (await testDb`select count(*)::int n from services where tenant_id = ${t}`)[0]!.n,
  customers: async (t) => (await testDb`select count(*)::int n from customers where tenant_id = ${t}`)[0]!.n,
  appointments: async (t) => (await testDb`select count(*)::int n from appointments where tenant_id = ${t}`)[0]!.n,
  appointment_items: async (t) => (await testDb`select count(*)::int n from appointment_items where tenant_id = ${t}`)[0]!.n,
  appointment_sales: async (t) => (await testDb`select count(*)::int n from appointment_sales where tenant_id = ${t}`)[0]!.n,
  appointment_sale_items: async (t) => (await testDb`select count(*)::int n from appointment_sale_items where tenant_id = ${t}`)[0]!.n,
  payments: async (t) => (await testDb`select count(*)::int n from payments where tenant_id = ${t}`)[0]!.n,
  expenses: async (t) => (await testDb`select count(*)::int n from expenses where tenant_id = ${t}`)[0]!.n,
  expense_payments: async (t) => (await testDb`select count(*)::int n from expense_payments where tenant_id = ${t}`)[0]!.n,
  staff_commission_rules: async (t) => (await testDb`select count(*)::int n from staff_commission_rules where tenant_id = ${t}`)[0]!.n,
  treatment_notes: async (t) => (await testDb`select count(*)::int n from treatment_notes where tenant_id = ${t}`)[0]!.n,
  treatment_photos: async (t) => (await testDb`select count(*)::int n from treatment_media where tenant_id = ${t}`)[0]!.n,
  consent_booking_claims: async (t) => (await testDb`select count(*)::int n from booking_account_claims where tenant_id = ${t}`)[0]!.n,
  consent_account_links: async (t) => (await testDb`select count(*)::int n from customer_account_links where tenant_id = ${t}`)[0]!.n,
};
const ownRowCount = (section: string, tenantId: string) => OWN_COUNT_SQL[section]!(tenantId);

const resetState = async (tenantId: string) => {
  await testDb`delete from private.tenant_export_requests where tenant_id = ${tenantId}`;
};
const auditFor = (tenantId: string) => testDb<Loose[]>`select * from private.tenant_export_audit where tenant_id = ${tenantId} order by id`;

/** request + consume as the owner; returns the request id */
async function startDownload(tenant: TestTenant, uid: string): Promise<string> {
  const t = tok();
  const r = await request(uid, tenant.id, t);
  expect(r.ok).toBe(true);
  const c = await consume(uid, t.hash);
  expect(c.ok).toBe(true);
  return c.request_id as string;
}

describe("EO owner-only authorization", () => {
  it("EO1 the same-tenant Owner is allowed", async () => {
    await resetState(A.id);
    const r = await request(users.ownerA!.id, A.id);
    expect(r.ok).toBe(true);
    expect(typeof r.request_id).toBe("string");
  });
  it.each([["manager"], ["recep"], ["staff"], ["outsider"]])("EO2 %s is denied (not_owner) and the denial is audited", async (label) => {
    await resetState(A.id);
    const before = (await auditFor(A.id)).length;
    const r = await request(users[label]!.id, A.id);
    expect(r).toEqual({ ok: false, error: "not_owner" });
    const rows = await auditFor(A.id);
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ event: "denied", error_code: "not_owner", actor_id: users[label]!.id });
    expect((await testDb`select count(*)::int n from private.tenant_export_requests where tenant_id = ${A.id}`)[0]!.n).toBe(0);
  });
  it("EO3 another tenant's Owner is denied", async () => {
    expect(await request(users.ownerB!.id, A.id)).toEqual({ ok: false, error: "not_owner" });
  });
  it("EO4 a forged / unknown tenant id gives the same answer as a real one (no enumeration)", async () => {
    expect(await request(users.ownerA!.id, randomUUID())).toEqual({ ok: false, error: "not_owner" });
  });
  it("EO5 user_metadata claiming Owner changes nothing", async () => {
    const r = await request(users.manager!.id, A.id, tok(), { extra: { user_metadata: { role: "owner", is_owner: true }, app_metadata: { role: "owner" } } });
    expect(r).toEqual({ ok: false, error: "not_owner" });
  });
  it("EO6 anon and service_role cannot execute any export RPC; unauthenticated authenticated is refused", async () => {
    const t = tok();
    for (const role of ["anon", "service_role"] as Role[]) {
      expect(await fails(asApi(null, async (sql) => sql`select public.request_tenant_export(${A.id}, ${t.hash}, ${t.cid})`, { role }))).toMatch(/permission denied/);
      expect(await fails(asApi(null, async (sql) => sql`select public.get_tenant_export_status(${A.id})`, { role }))).toMatch(/permission denied/);
      expect(await fails(asApi(null, async (sql) => sql`select public.export_read_section(${randomUUID()}, 'branches', null, 10)`, { role }))).toMatch(/permission denied/);
    }
    const r = await asApi(null, async (sql) => (await sql`select public.request_tenant_export(${A.id}, ${t.hash}, ${t.cid}) as r`)[0]!.r as Loose);
    expect(r).toEqual({ ok: false, error: "unauthenticated" });
  });
  it("EO7 status screen: Owner sees quota, everyone else a bare refusal", async () => {
    const own = await asApi(users.ownerA!.id, async (sql) => (await sql`select public.get_tenant_export_status(${A.id}) as r`)[0]!.r as Loose);
    expect(own).toMatchObject({ allowed: true, limit: 3 });
    for (const l of ["manager", "recep", "staff", "outsider", "ownerB"]) {
      const r = await asApi(users[l]!.id, async (sql) => (await sql`select public.get_tenant_export_status(${A.id}) as r`)[0]!.r as Loose);
      expect(r).toEqual({ allowed: false });
    }
  });
});

describe("FA fresh authentication", () => {
  const cases: [string, unknown][] = [
    ["missing amr", undefined],
    ["stale amr (20 min)", fresh(1200)],
    ["amr is a string", "password"],
    ["anonymous method only", [{ method: "anonymous", timestamp: nowSec() }]],
    ["timestamp in the far future", [{ method: "password", timestamp: nowSec() + 3600 }]],
    ["malformed entries", [{ method: "password" }, 5, null]],
  ];
  it.each(cases)("FA1 %s is denied and audited", async (_n, amr) => {
    await resetState(A.id);
    const r = await request(users.ownerA!.id, A.id, tok(), { amr });
    expect(r).toEqual({ ok: false, error: "fresh_auth_required" });
    expect((await auditFor(A.id)).at(-1)).toMatchObject({ event: "denied", error_code: "fresh_auth_required" });
  });
  it("FA2 an authentication 14 minutes ago is accepted", async () => {
    await resetState(A.id);
    expect((await request(users.ownerA!.id, A.id, tok(), { amr: fresh(14 * 60) })).ok).toBe(true);
  });
  it("FA3 the newest of several entries counts (old password + fresh otp)", async () => {
    await resetState(A.id);
    expect((await request(users.ownerA!.id, A.id, tok(), { amr: [{ method: "password", timestamp: nowSec() - 7200 }, { method: "otp", timestamp: nowSec() - 5 }] })).ok).toBe(true);
  });
});

describe("TK download token", () => {
  it("TK1 only the sha256 is stored; the raw token appears nowhere", async () => {
    await resetState(A.id);
    const t = tok();
    await request(users.ownerA!.id, A.id, t);
    const [row] = await testDb<Loose[]>`select * from private.tenant_export_requests where tenant_id = ${A.id}`;
    expect(row!.token_hash).toBe(t.hash);
    const dump = JSON.stringify(row) + JSON.stringify(await auditFor(A.id));
    expect(dump).not.toContain(t.raw);
  });
  it("TK2 single use: the second consume of the same token is refused", async () => {
    await resetState(A.id);
    const t = tok();
    await request(users.ownerA!.id, A.id, t);
    expect((await consume(users.ownerA!.id, t.hash)).ok).toBe(true);
    expect(await consume(users.ownerA!.id, t.hash)).toEqual({ ok: false, error: "invalid_token" });
  });
  it("TK3 concurrent consumes: exactly one wins", async () => {
    await resetState(A.id);
    const t = tok();
    await request(users.ownerA!.id, A.id, t);
    const rs = await Promise.all(Array.from({ length: 24 }, () => consume(users.ownerA!.id, t.hash)));
    expect(rs.filter((r) => r.ok).length).toBe(1);
  });
  it("TK10 deterministic race: a consume that starts while another is still open waits for it and then loses (row lock)", async () => {
    await resetState(A.id);
    const t = tok();
    await request(users.ownerA!.id, A.id, t);
    const claims = JSON.stringify({ sub: users.ownerA!.id, role: "authenticated", amr: fresh() });
    const run = (hold: () => Promise<void>) =>
      testDb.begin(async (sql) => {
        await sql`select set_config('request.jwt.claims', ${claims}, true), set_config('request.jwt.claim.sub', ${users.ownerA!.id}, true)`;
        await sql`set local session authorization authenticator`;
        await sql.unsafe("set local role authenticated");
        const r = (await sql`select public.consume_tenant_export_token(${t.hash}) as r`)[0]!.r as Loose;
        await hold();
        return r;
      });
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const first = run(() => gate);
    await new Promise((r) => setTimeout(r, 400));
    const second = run(async () => {});
    await new Promise((r) => setTimeout(r, 400));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
    expect(a.ok).toBe(true);
  });
  it("TK9 actor binding: a SECOND Owner of the same tenant cannot consume the first Owner's token", async () => {
    await resetState(A.id);
    const second = await newUser("owner2");
    await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status) values (${A.id}, ${second.id}, ${A.ownerRoleId}, 'active')`;
    const t = tok();
    const r = await request(users.ownerA!.id, A.id, t);
    expect(await consume(second.id, t.hash)).toEqual({ ok: false, error: "invalid_token" });
    expect((await consume(users.ownerA!.id, t.hash)).ok).toBe(true);
    // and the second Owner cannot read the first Owner's download either
    expect(await fails(page(second.id, r.request_id, "customers"))).toMatch(/export_denied/);
    await testDb`delete from tenant_memberships where tenant_id = ${A.id} and user_id = ${second.id}`;
  });
  it("TK4 expired token refused; validity window is capped at 10 minutes by a constraint", async () => {
    await resetState(A.id);
    const t = tok();
    await request(users.ownerA!.id, A.id, t);
    await testDb`update private.tenant_export_requests set token_expires_at = requested_at + interval '1 millisecond' where token_hash = ${t.hash}`;
    expect(await consume(users.ownerA!.id, t.hash)).toEqual({ ok: false, error: "invalid_token" });
    expect(await fails(testDb`update private.tenant_export_requests set token_expires_at = requested_at + interval '11 minutes' where token_hash = ${t.hash}`)).toMatch(/token_window/);
  });
  it("TK5 other user / other tenant Owner / unknown / malformed tokens all get the identical refusal and never burn the real token", async () => {
    await resetState(A.id);
    const t = tok();
    await request(users.ownerA!.id, A.id, t);
    const refusals = [await consume(users.ownerB!.id, t.hash), await consume(users.manager!.id, t.hash), await consume(users.ownerA!.id, sha256Hex("nope")), await consume(users.ownerA!.id, "short")];
    for (const r of refusals) expect(r).toEqual({ ok: false, error: "invalid_token" });
    expect((await consume(users.ownerA!.id, t.hash)).ok).toBe(true); // the legitimate holder is unaffected
  });
  it("TK6 token stealing: a signed-out caller cannot consume", async () => {
    await resetState(A.id);
    const t = tok();
    await request(users.ownerA!.id, A.id, t);
    expect(await asApi(null, async (sql) => (await sql`select public.consume_tenant_export_token(${t.hash}) as r`)[0]!.r)).toEqual({ ok: false, error: "invalid_token" });
  });
  it("TK7 an Owner who lost the role between request and download is refused", async () => {
    await resetState(A.id);
    const extra = await newUser("demoted");
    await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status) values (${A.id}, ${extra.id}, ${A.ownerRoleId}, 'active')`;
    const t = tok();
    await request(extra.id, A.id, t);
    await testDb`update tenant_memberships set status = 'suspended' where tenant_id = ${A.id} and user_id = ${extra.id}`;
    expect(await consume(extra.id, t.hash)).toEqual({ ok: false, error: "invalid_token" });
    await testDb`delete from tenant_memberships where tenant_id = ${A.id} and user_id = ${extra.id}`;
  });
  it("TK8 the token row is bound to its tenant: the download reads THAT tenant only", async () => {
    await resetState(A.id);
    await resetState(B.id);
    const rid = await startDownload(A, users.ownerA!.id);
    const p = await page(users.ownerA!.id, rid, "customers");
    expect(JSON.stringify(p.rows)).toContain("Müşteri A");
    expect(JSON.stringify(p.rows)).not.toContain("Müşteri B");
  });
});

describe("RL rate limit", () => {
  const finish = async (uid: string, rid: string) => { const r = await complete(uid, rid, { customers: 1 }, 100); expect(r, JSON.stringify(r)).toMatchObject({ ok: true }); };
  it("RL1 three successful exports per rolling 24h, the fourth is rate_limited with a retry time", async () => {
    await resetState(A.id);
    for (let i = 0; i < 3; i++) await finish(users.ownerA!.id, await startDownload(A, users.ownerA!.id));
    const r = await request(users.ownerA!.id, A.id);
    expect(r).toMatchObject({ ok: false, error: "rate_limited" });
    expect(typeof r.retry_at).toBe("string");
    expect((await auditFor(A.id)).at(-1)).toMatchObject({ event: "denied", error_code: "rate_limited" });
  });
  it("RL2 rolling window: an export older than 24h frees a slot", async () => {
    await testDb`update private.tenant_export_requests set completed_at = now() - interval '25 hours' where id = (select id from private.tenant_export_requests where tenant_id = ${A.id} order by requested_at limit 1)`;
    expect((await request(users.ownerA!.id, A.id)).ok).toBe(true);
  });
  it("RL3 a second request while one is active is refused", async () => {
    await resetState(A.id);
    expect((await request(users.ownerA!.id, A.id)).ok).toBe(true);
    expect(await request(users.ownerA!.id, A.id)).toEqual({ ok: false, error: "export_in_progress" });
  });
  it("RL4 race: 8 concurrent requests -> exactly one reservation", async () => {
    await resetState(A.id);
    const rs = await Promise.all(Array.from({ length: 8 }, () => request(users.ownerA!.id, A.id)));
    expect(rs.filter((r) => r.ok).length).toBe(1);
    expect((await testDb`select count(*)::int n from private.tenant_export_requests where tenant_id = ${A.id}`)[0]!.n).toBe(1);
  });
  it("RL5 race at the cap: two completed + concurrent requests never exceed three", async () => {
    await resetState(A.id);
    for (let i = 0; i < 2; i++) await finish(users.ownerA!.id, await startDownload(A, users.ownerA!.id));
    const rs = await Promise.all(Array.from({ length: 6 }, () => request(users.ownerA!.id, A.id)));
    expect(rs.filter((r) => r.ok).length).toBe(1);
    const t = rs.find((r) => r.ok)!;
    expect(t.remaining_after).toBe(0);
  });
  it("RL6 failed attempts do not consume quota, but ten failures in 24h block (too_many_failures)", async () => {
    await resetState(A.id);
    for (let i = 0; i < 4; i++) {
      const rid = await startDownload(A, users.ownerA!.id);
      expect((await asApi(users.ownerA!.id, async (sql) => (await sql`select public.fail_tenant_export(${rid}, 'read_failed') as r`)[0]!.r as Loose)).ok).toBe(true);
    }
    for (let i = 0; i < 3; i++) await finish(users.ownerA!.id, await startDownload(A, users.ownerA!.id)); // quota untouched by the 4 failures
    await resetState(A.id);
    for (let i = 0; i < 10; i++) await testDb`insert into private.tenant_export_requests (tenant_id, actor_id, client_request_id, token_hash, token_expires_at, status, error_code) values (${A.id}, ${users.ownerA!.id}, ${randomUUID()}, ${sha256Hex(randomUUID())}, now() + interval '5 minutes', 'failed', 'read_failed')`;
    expect(await request(users.ownerA!.id, A.id)).toEqual({ ok: false, error: "too_many_failures" });
  });
  it("RL7 an abandoned download (30 min, never reported) is swept as a failure and frees the tenant", async () => {
    await resetState(A.id);
    const rid = await startDownload(A, users.ownerA!.id);
    await testDb`update private.tenant_export_requests set fence_at = now() - interval '31 minutes' where id = ${rid}`;
    expect((await request(users.ownerA!.id, A.id)).ok).toBe(true);
    expect((await testDb`select status, error_code from private.tenant_export_requests where id = ${rid}`)[0]).toMatchObject({ status: "failed", error_code: "abandoned" });
  });
  it("RL8 an expired unused token is swept and does not hold the slot", async () => {
    await resetState(A.id);
    const t = tok();
    await request(users.ownerA!.id, A.id, t);
    await testDb`update private.tenant_export_requests set token_expires_at = requested_at + interval '1 millisecond' where token_hash = ${t.hash}`;
    expect((await request(users.ownerA!.id, A.id)).ok).toBe(true);
  });
  it("RL9 the same client request id cannot be replayed", async () => {
    await resetState(A.id);
    const t = tok();
    expect((await request(users.ownerA!.id, A.id, t)).ok).toBe(true);
    await resetState(A.id);
    await testDb`insert into private.tenant_export_requests (tenant_id, actor_id, client_request_id, token_hash, token_expires_at) values (${A.id}, ${users.ownerA!.id}, ${t.cid}, ${sha256Hex("x")}, now() + interval '1 minute')`;
    await testDb`delete from private.tenant_export_requests where token_hash = ${sha256Hex("x")}`;
    await testDb`insert into private.tenant_export_requests (tenant_id, actor_id, client_request_id, token_hash, token_expires_at, status) values (${A.id}, ${users.ownerA!.id}, ${t.cid}, ${sha256Hex("y")}, now() + interval '1 minute', 'failed')`;
    expect(await request(users.ownerA!.id, A.id, t)).toEqual({ ok: false, error: "duplicate_request" });
  });
  it("RL10 the other tenant's quota is independent", async () => {
    await resetState(B.id);
    expect((await request(users.ownerB!.id, B.id)).ok).toBe(true);
  });
});

describe("RD reading the data", () => {
  it("RD1 reading before the token is consumed, or by another user, or after the window, is refused", async () => {
    await resetState(A.id);
    const t = tok();
    const r = await request(users.ownerA!.id, A.id, t);
    expect(await fails(page(users.ownerA!.id, r.request_id, "customers"))).toMatch(/export_denied/);
    const c = await consume(users.ownerA!.id, t.hash);
    expect(await fails(page(users.ownerB!.id, c.request_id, "customers"))).toMatch(/export_denied/);
    expect(await fails(page(users.manager!.id, c.request_id, "customers"))).toMatch(/export_denied/);
    await testDb`update private.tenant_export_requests set fence_at = now() - interval '31 minutes' where id = ${c.request_id}`;
    expect(await fails(page(users.ownerA!.id, c.request_id, "customers"))).toMatch(/export_denied/);
  });
  it("RD2 reading after completion is refused", async () => {
    await resetState(A.id);
    const rid = await startDownload(A, users.ownerA!.id);
    await complete(users.ownerA!.id, rid, { customers: 1 }, 10);
    expect(await fails(page(users.ownerA!.id, rid, "customers"))).toMatch(/export_denied/);
  });
  it("RD3 every section returns exactly the declared columns and only this tenant's rows", async () => {
    await resetState(A.id);
    const rid = await startDownload(A, users.ownerA!.id);
    for (const s of SECTIONS) {
      const p = await page(users.ownerA!.id, rid, s.key);
      expect(p.rows.length, s.key).toBeGreaterThanOrEqual(1);
      for (const row of p.rows) expect(Object.keys(row).sort(), s.key).toEqual([...s.columns].sort());
      expect(JSON.stringify(p.rows), s.key).not.toMatch(/ B"|Şube B|-B@|_B"/);
      expect(p.rows.length, `${s.key} row count equals this tenant's own rows`).toBe(await ownRowCount(s.key, A.id));
    }
  });
  it("RD4 excluded data never appears (secrets, internal ids, storage paths, idempotency, provider data)", async () => {
    const rid = (await testDb<Loose[]>`select id from private.tenant_export_requests where tenant_id = ${A.id} and status = 'downloading'`)[0]!.id as string;
    const all = JSON.stringify(await Promise.all(SECTIONS.map((s) => page(users.ownerA!.id, rid, s.key))));
    for (const bad of ["SECRETHASH", "secret_hash", "storage_path", "created_by", "idempotency", "user_id", "email_snapshot", "provider_", "password", "consumed_by", "tenant_membership_id", "snap-A@"]) expect(all).not.toContain(bad);
    expect(all).not.toContain(A.id.slice(0, 0) + `${A.id}/`); // no storage path prefix
  });
  it("RD5 keyset pagination: small pages cover every row exactly once", async () => {
    await resetState(A.id);
    for (let i = 0; i < 25; i++) await testDb`insert into customers (tenant_id, full_name) values (${A.id}, ${"Sayfa " + i})`;
    const rid = await startDownload(A, users.ownerA!.id);
    const seen: string[] = [];
    let after: string | null = null;
    let guard = 0;
    do {
      const p: Loose = await page(users.ownerA!.id, rid, "customers", after, 7);
      for (const r of p.rows) seen.push(r.id);
      after = p.next;
    } while (after && ++guard < 20);
    const [{ n }] = await testDb<{ n: number }[]>`select count(*)::int n from customers where tenant_id = ${A.id}`;
    expect(seen.length).toBe(n);
    expect(new Set(seen).size).toBe(n);
  });
  it("RD6 composite-key sections paginate without loss", async () => {
    const rid = (await testDb<Loose[]>`select id from private.tenant_export_requests where tenant_id = ${A.id} and status = 'downloading'`)[0]!.id as string;
    const staffIds = [];
    for (let i = 0; i < 5; i++) staffIds.push((await createStaffMember(A.id, `Ek ${i}`)).id);
    const [br] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${A.id} limit 1`;
    for (const s of staffIds) await testDb`insert into staff_branches (staff_member_id, branch_id) values (${s}, ${br!.id})`;
    // rows created after the fence are excluded, so insert the links BEFORE a fresh download
    await resetState(A.id);
    const rid2 = await startDownload(A, users.ownerA!.id);
    const [{ n }] = await testDb<{ n: number }[]>`select count(*)::int n from staff_branches sb join staff_members s on s.id = sb.staff_member_id where s.tenant_id = ${A.id}`;
    let total = 0;
    let after: string | null = null;
    do {
      const p: Loose = await page(users.ownerA!.id, rid2, "staff_branches", after, 2);
      total += p.rows.length;
      after = p.next;
    } while (after);
    expect(total).toBe(n);
    expect(rid).toBeTruthy();
  });
  it("RD7 unknown section / invalid cursor are rejected", async () => {
    const rid = (await testDb<Loose[]>`select id from private.tenant_export_requests where tenant_id = ${A.id} and status = 'downloading'`)[0]!.id as string;
    expect(await fails(page(users.ownerA!.id, rid, "subscriptions"))).toMatch(/unknown_section/);
    expect(await fails(page(users.ownerA!.id, rid, "audit_logs"))).toMatch(/unknown_section/);
    expect(await fails(page(users.ownerA!.id, rid, "customers", "not-a-uuid"))).toMatch(/invalid_cursor/);
  });
  it("RD8 Owner status is re-checked on every page", async () => {
    await resetState(A.id);
    const extra = await newUser("midrevoke");
    await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status) values (${A.id}, ${extra.id}, ${A.ownerRoleId}, 'active')`;
    const rid = await startDownload(A, extra.id);
    expect((await page(extra.id, rid, "branches")).rows.length).toBeGreaterThan(0);
    await testDb`update tenant_memberships set status = 'suspended' where tenant_id = ${A.id} and user_id = ${extra.id}`;
    expect(await fails(page(extra.id, rid, "branches"))).toMatch(/export_denied/);
    await testDb`delete from tenant_memberships where tenant_id = ${A.id} and user_id = ${extra.id}`;
  });
});

describe("SN snapshot consistency", () => {
  it("SN1 rows created after the fence are excluded from every page (no child without its parent)", async () => {
    await resetState(A.id);
    const rid = await startDownload(A, users.ownerA!.id);
    const before = (await page(users.ownerA!.id, rid, "customers")).rows.length;
    await testDb`insert into customers (tenant_id, full_name) values (${A.id}, 'Sonradan')`;
    const after = await page(users.ownerA!.id, rid, "customers");
    expect(after.rows.length).toBe(before);
    expect(JSON.stringify(after.rows)).not.toContain("Sonradan");
  });
  it("SN2 writes landing between pages of one section do not duplicate or lose existing rows", async () => {
    await resetState(A.id);
    const rid = await startDownload(A, users.ownerA!.id);
    const first = await page(users.ownerA!.id, rid, "customers", null, 5);
    for (let i = 0; i < 5; i++) await testDb`insert into customers (tenant_id, full_name) values (${A.id}, ${"Yazma " + i})`;
    const seen = first.rows.map((r: Loose) => r.id);
    let after = first.next as string | null;
    while (after) {
      const p: Loose = await page(users.ownerA!.id, rid, "customers", after, 5);
      seen.push(...p.rows.map((r: Loose) => r.id));
      after = p.next;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const [{ n }] = await testDb<{ n: number }[]>`select count(*)::int n from customers c, private.tenant_export_requests r where c.tenant_id = ${A.id} and r.id = ${rid} and c.created_at <= r.fence_at`;
    expect(seen.length).toBe(n);
  });
});

describe("AU audit", () => {
  it("AU1 append-only: update, delete and truncate are refused", async () => {
    const [row] = await auditFor(A.id);
    expect(await fails(testDb`update private.tenant_export_audit set event = 'failed' where id = ${row!.id}`)).toMatch(/append-only/);
    expect(await fails(testDb`delete from private.tenant_export_audit where id = ${row!.id}`)).toMatch(/append-only/);
    expect(await fails(testDb`truncate private.tenant_export_audit`)).toMatch(/append-only/);
  });
  it("AU2 the success path records requested, downloaded, completed with counts and byte size; nothing personal", async () => {
    await resetState(A.id);
    const mark = (await auditFor(A.id)).length;
    const rid = await startDownload(A, users.ownerA!.id);
    await complete(users.ownerA!.id, rid, { customers: 3, branches: 1 }, 4321);
    const rows = (await auditFor(A.id)).slice(mark);
    expect(rows.map((r) => r.event)).toEqual(["requested", "downloaded", "completed"]);
    expect(rows.at(-1)).toMatchObject({ entity_counts: { customers: 3, branches: 1 }, tenant_id: A.id, actor_id: users.ownerA!.id });
    expect(Number(rows.at(-1)!.archive_bytes)).toBe(4321);
    const all = JSON.stringify(await testDb`select * from private.tenant_export_audit where tenant_id = ${A.id} or actor_id = ${users.ownerA!.id}`);
    for (const pii of ["Müşteri", "example.test", "+9050011", users.ownerA!.email, "işlem notu"]) expect(all).not.toContain(pii);
  });
  it("AU3 completion reports are validated: free text, negative or oversized values are refused and nothing is written", async () => {
    await resetState(A.id);
    const rid = await startDownload(A, users.ownerA!.id);
    for (const bad of [{ "Ayşe Yılmaz": 1 }, { customers: "5" }, { customers: -1 }, { customers: 1.5 }, [1], null]) {
      expect(await complete(users.ownerA!.id, rid, bad, 10)).toEqual({ ok: false, error: "invalid_report" });
    }
    expect(await complete(users.ownerA!.id, rid, { customers: 1 }, -5)).toEqual({ ok: false, error: "invalid_report" });
    expect(await complete(users.ownerA!.id, rid, { customers: 1 }, 5_000_000_000)).toEqual({ ok: false, error: "invalid_report" });
    expect((await testDb`select status from private.tenant_export_requests where id = ${rid}`)[0]!.status).toBe("downloading");
  });
  it("AU4 only the actor can complete or fail a request", async () => {
    const rid = (await testDb<Loose[]>`select id from private.tenant_export_requests where tenant_id = ${A.id} and status = 'downloading'`)[0]!.id as string;
    expect(await complete(users.ownerB!.id, rid, { customers: 1 }, 10)).toEqual({ ok: false, error: "not_allowed" });
    expect(await asApi(users.manager!.id, async (sql) => (await sql`select public.fail_tenant_export(${rid}, 'x') as r`)[0]!.r)).toEqual({ ok: false, error: "not_allowed" });
  });
  it("AU5 failure codes are sanitised", async () => {
    const rid = (await testDb<Loose[]>`select id from private.tenant_export_requests where tenant_id = ${A.id} and status = 'downloading'`)[0]!.id as string;
    await asApi(users.ownerA!.id, async (sql) => sql`select public.fail_tenant_export(${rid}, 'Ayşe Yılmaz 0555')`);
    expect((await auditFor(A.id)).at(-1)).toMatchObject({ event: "failed", error_code: "export_failed" });
  });
});

describe("SE catalog and grants", () => {
  const fns = ["request_tenant_export", "consume_tenant_export_token", "export_read_section", "complete_tenant_export", "fail_tenant_export", "get_tenant_export_status"];
  it("SE1 both tables have RLS enabled, no policy, and no API-role privilege", async () => {
    const t = await testDb<Loose[]>`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relname like 'tenant_export_%' and c.relkind = 'r'`;
    expect(t.map((r) => r.relname).sort()).toEqual(["tenant_export_audit", "tenant_export_requests"]);
    for (const r of t) expect(r.relrowsecurity).toBe(true);
    expect((await testDb`select count(*)::int n from pg_policies where schemaname = 'private'`)[0]!.n).toBe(0);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const tbl of ["tenant_export_audit", "tenant_export_requests"]) {
        expect((await testDb`select has_table_privilege(${role}, ${"private." + tbl}, 'select,insert,update,delete,truncate') as x`)[0]!.x, `${role} ${tbl}`).toBe(false);
      }
    }
  });
  it("SE2 the six RPCs are SECURITY DEFINER with an empty search_path; execute = authenticated only", async () => {
    const rows = await testDb<Loose[]>`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s, has_function_privilege('public', p.oid, 'execute') pub from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any(${fns})`;
    expect(rows.length).toBe(6);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(JSON.stringify(r.proconfig), r.proname).toMatch(/search_path=/);
      expect([r.a, r.u, r.s, r.pub], r.proname).toEqual([false, true, false, false]);
    }
  });
  it("SE3 private helpers are not executable by API roles", async () => {
    const rows = await testDb<Loose[]>`select p.proname, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('service_role', p.oid, 'execute') s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname like 'export\_%'`;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) expect([r.a, r.u, r.s], r.proname).toEqual([false, false, false]);
  });
  it("SE4 no storage bucket or public object is created by the feature", async () => {
    const hasStorage = (await testDb`select to_regclass('storage.buckets') is not null as p`)[0]!.p;
    if (hasStorage) expect((await testDb`select count(*)::int n from storage.buckets where name ilike '%export%'`)[0]!.n).toBe(0);
  });
});

describe("NI no state change, any billing state", () => {
  it("NI1 a full request/consume/read/complete cycle changes no tenant, subscription, branch, customer or appointment row; works in every subscription state", async () => {
    const [plan] = await testDb<{ id: string }[]>`select id from plans limit 1`;
    for (const status of ["trialing", "active", "past_due", "canceled", "expired"]) {
      await resetState(A.id);
      await testDb`delete from subscriptions where tenant_id = ${A.id}`;
      await testDb`insert into subscriptions (tenant_id, plan_id, status, billing_mode) values (${A.id}, ${plan!.id}, ${status}, 'pilot')`;
      const digest = async () => JSON.stringify(await testDb`select (select to_jsonb(t) from tenants t where id = ${A.id}) t, (select to_jsonb(s) from subscriptions s where tenant_id = ${A.id}) s, (select count(*) from branches where tenant_id = ${A.id}) b, (select count(*) from customers where tenant_id = ${A.id}) c, (select count(*) from appointments where tenant_id = ${A.id}) a, (select count(*) from subscription_events where tenant_id = ${A.id}) e`);
      const before = await digest();
      const rid = await startDownload(A, users.ownerA!.id);
      for (const s of SECTIONS) await page(users.ownerA!.id, rid, s.key);
      await complete(users.ownerA!.id, rid, { customers: 1 }, 1);
      expect(await digest(), status).toBe(before);
    }
  });
});

describe("EC end-to-end archive from the real RPCs", () => {
  it("EC1 the streamed zip holds every section, matches the database, contains no other tenant, and the passes agree", async () => {
    await resetState(A.id);
    const t = tok();
    expect((await request(users.ownerA!.id, A.id, t)).ok).toBe(true);
    const c = await consume(users.ownerA!.id, t.hash);
    const fetchPage: PageFetcher = async (section, after) => {
      const p = await page(users.ownerA!.id, c.request_id, section, after, 3);
      return { rows: p.rows, next: p.next };
    };
    const { stream, report } = buildExportArchive({ fetchPage, now: new Date("2026-11-05T09:30:00Z"), snapshotAt: c.fence_at, tenantTimezone: "Europe/Nicosia", tenantCurrency: "TRY" });
    const chunks: Buffer[] = [];
    for await (const ch of stream) chunks.push(Buffer.from(ch));
    const r = report();
    const files = readZip(Buffer.concat(chunks));
    const base = "salonos-export-2026-11-05-0930/";
    for (const s of SECTIONS) expect(files.has(`${base}csv/${s.key}.csv`), s.key).toBe(true);
    const json = JSON.parse(files.get(`${base}salonos-export.json`)!.toString("utf8"));
    expect(json.export_version).toBe(1);
    const meta = JSON.parse(files.get(`${base}metadata.json`)!.toString("utf8"));
    expect(meta.consistency.passes_identical).toBe(true);
    expect(r.passesIdentical).toBe(true);
    const [{ n }] = await testDb<{ n: number }[]>`select count(*)::int n from customers where tenant_id = ${A.id}`;
    expect(json.sections.customers.length).toBe(n);
    expect(r.counts.customers).toBe(n);
    const all = [...files.values()].map((b) => b.toString("utf8")).join("\n");
    expect(all).not.toMatch(/Müşteri B|Şube B|Hizmet B|kira B/);
    expect(all).toContain("Müşteri A");
    expect(files.get(`${base}csv/customers.csv`)!.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect((await complete(users.ownerA!.id, c.request_id, r.counts, r.bytes)).ok).toBe(true);
  });
});
