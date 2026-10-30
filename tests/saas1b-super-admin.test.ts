import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import {
  addMembership,
  admin,
  anonClient,
  asAuthenticatedUser,
  asDatabaseRole,
  cleanupPlatformAdmins,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createCustomer,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1B — Super Admin READ model, database level. IDs AD (authorization), LS (list), SR (search), FL (filters), DT (detail),
 * OW (owner visibility), PII, HL (health), LC (lifecycle), AU (audit), GR (grants/catalog), SC (scale), RG (Gökhan-like / Emel-like).
 * Everything is synthetic: no real salon, person or e-mail. Authorization runs through asAuthenticatedUser (the exact role + JWT-claims
 * context of a PostgREST request) and, for the API-role cases, through real clients against the shim.
 */

const SECRET_CUSTOMER_NAME = "GIZLI-MUSTERI-ADI";
const SECRET_CUSTOMER_PHONE = "5559990011";
const SECRET_CUSTOMER_EMAIL = "gizli.musteri@example.test";
const SECRET_CUSTOMER_NOTE = "GIZLI-NOT-METNI";

const u: Record<string, TestUser> = {};
const t: Record<string, TestTenant> = {};
const userIds: string[] = [];
const tenantIds: string[] = [];
const extraTenantIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`s1b-${label}`);
  userIds.push(user.id);
  u[label] = user;
  return user;
}

const roleCache = new Map<string, string>();
async function templateRole(tenantId: string, key: string): Promise<string> {
  const ck = `${tenantId}:${key}`;
  if (roleCache.has(ck)) return roleCache.get(ck)!;
  const [existing] = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${tenantId} and key = ${key} and deleted_at is null`;
  if (existing) {
    roleCache.set(ck, existing.id);
    return existing.id;
  }
  const [tpl] = await testDb<{ id: string; key: string; name: string; description: string | null }[]>`select id, key, name, description from role_templates where key = ${key}`;
  const [role] = await testDb<{ id: string }[]>`insert into roles (tenant_id, key, name, description, is_system_default, cloned_from_template_id)
    values (${tenantId}, ${tpl!.key}, ${tpl!.name}, ${tpl!.description}, true, ${tpl!.id}) returning id`;
  await testDb`insert into role_permissions (role_id, permission_id) select ${role!.id}, permission_id from role_template_permissions where role_template_id = ${tpl!.id}`;
  roleCache.set(ck, role!.id);
  return role!.id;
}

async function membershipOf(tenantId: string, userId: string): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${tenantId} and user_id = ${userId} and deleted_at is null`;
  return row!.id;
}

async function enableOnlineBooking(tenantId: string) {
  await testDb`insert into tenant_features (tenant_id, feature_id, enabled)
    select ${tenantId}, f.id, true from features f where f.key = 'online_booking'`;
}

type SalonOptions = {
  slug: string;
  owner: TestUser;
  staffNames: string[];
  hours: boolean;
  booking: boolean;
  phone: boolean;
  directServices: number;
  inquiryServices?: number;
  customers?: number;
  ownerIsStaff?: boolean;
};

/** A salon built through plain inserts (the way the existing suites do), complete enough for the canonical readiness to say "ready". */
async function buildSalon(o: SalonOptions): Promise<TestTenant> {
  const tenant = await createTestTenant(o.slug, o.owner.id);
  tenantIds.push(tenant.id);
  const branchId = await createBranch(tenant.id, "Merkez");
  if (o.phone) await testDb`update branches set phone = '+905550000000' where id = ${branchId}`;
  const serviceIds: string[] = [];
  for (let i = 0; i < o.directServices; i++) {
    const s = await createService(tenant.id, `Hizmet ${o.slug} ${i + 1}`, 30, 100);
    await linkServiceBranch(s.id, branchId);
    serviceIds.push(s.id);
  }
  for (let i = 0; i < (o.inquiryServices ?? 0); i++) {
    const s = await createService(tenant.id, `Teklifli ${o.slug} ${i + 1}`, 30, 0);
    await testDb`update services set booking_mode = 'inquiry', pricing_mode = 'inquiry' where id = ${s.id}`;
    await linkServiceBranch(s.id, branchId);
  }
  const staffIds: string[] = [];
  for (const name of o.staffNames) {
    const sm = await createStaffMember(tenant.id, name);
    await linkStaffBranch(sm.id, branchId);
    for (const sid of serviceIds) await linkStaffService(sm.id, sid);
    if (o.hours) for (let d = 0; d < 7; d++) await createStaffSchedule(tenant.id, sm.id, d, "09:00", "17:00");
    staffIds.push(sm.id);
  }
  if (o.ownerIsStaff && staffIds[0]) {
    await testDb`update staff_members set tenant_membership_id = ${await membershipOf(tenant.id, o.owner.id)} where id = ${staffIds[0]}`;
  }
  if (o.booking) await enableOnlineBooking(tenant.id);
  for (let i = 0; i < (o.customers ?? 0); i++) await createCustomer(tenant.id, `Musteri ${o.slug} ${i + 1}`);
  return tenant;
}

async function addAppointment(tenantId: string, branchId: string, customerId: string, staffId: string, serviceId: string, startSql: string, status: string) {
  const [a] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
    values (${tenantId}, ${branchId}, ${customerId}, ${status}, ${testDb.unsafe(startSql)}, ${testDb.unsafe(startSql)} + interval '30 minutes')
    returning id`;
  await testDb`
    insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
    values (${tenantId}, ${a!.id}, ${serviceId}, ${staffId}, ${testDb.unsafe(startSql)}, ${testDb.unsafe(startSql)} + interval '30 minutes', 30, 100, 1)`;
}

/** The admin functions return jsonb; the tests read it by path, so a deliberately loose shape is the honest type here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Sql = postgres.TransactionSql;
const asAdmin = <T,>(fn: (sql: Sql) => Promise<T>) => asAuthenticatedUser(u.platformAdmin!.id, fn);

async function listAll(sql: Sql, args: { search?: string | null; filter?: string; sort?: string; limit?: number; offset?: number } = {}) {
  return sql<Record<string, unknown>[]>`select * from public.admin_list_tenants(${args.search ?? null}, ${args.filter ?? "all"}, ${args.sort ?? "created_desc"}, ${args.limit ?? 100}, ${args.offset ?? 0})`;
}

function slugs(rows: Record<string, unknown>[]): string[] {
  return rows.map((r) => String(r.slug));
}

beforeAll(async () => {
  for (const label of ["platformAdmin", "supportAdmin", "inactiveAdmin", "ownerG", "yoneticiG", "personelG", "ownerE", "ownerSetup", "ownerStalled", "ownerSuspended", "ownerBroken", "ownerQuiet", "ownerOther", "strangerSignedIn"]) {
    await newUser(label);
  }
  await testDb`insert into platform_admins (user_id, role, is_active) values
    (${u.platformAdmin!.id}, 'owner', true), (${u.supportAdmin!.id}, 'support', true), (${u.inactiveAdmin!.id}, 'support', false)`;

  // Gökhan-like: several staff, a Yönetici, a Resepsiyon, a Personel linked to a staff row; direct and inquiry services; customers; appointments
  t.G = await buildSalon({ slug: "s1b-gokhanlike", owner: u.ownerG!, staffNames: ["Usta Bir", "Usta Iki", "Usta Uc"], hours: true, booking: true, phone: true, directServices: 3, inquiryServices: 1, customers: 5 });
  const yRole = await templateRole(t.G.id, "SALON_MANAGER");
  const rRole = await templateRole(t.G.id, "RECEPTIONIST");
  await addMembership(t.G.id, u.yoneticiG!.id, yRole);
  await addMembership(t.G.id, u.personelG!.id, await templateRole(t.G.id, "STYLIST"));
  void rRole;
  const [gStaff] = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${t.G.id} order by created_at limit 1`;
  await testDb`update staff_members set tenant_membership_id = ${await membershipOf(t.G.id, u.personelG!.id)} where id = ${gStaff!.id}`;
  // one customer carries data that must NEVER reach the admin surface
  const secret = await createCustomer(t.G.id, SECRET_CUSTOMER_NAME);
  await testDb`update customers set phone = ${SECRET_CUSTOMER_PHONE}, email = ${SECRET_CUSTOMER_EMAIL}, notes = ${SECRET_CUSTOMER_NOTE} where id = ${secret.id}`;
  const [gBranch] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${t.G.id} limit 1`;
  const gStaffRows = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${t.G.id} order by created_at`;
  const [gService] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${t.G.id} and booking_mode = 'direct' order by created_at limit 1`;
  await addAppointment(t.G.id, gBranch!.id, secret.id, gStaffRows[0]!.id, gService!.id, "now()", "scheduled"); // today
  await addAppointment(t.G.id, gBranch!.id, secret.id, gStaffRows[1]!.id, gService!.id, "now() - interval '3 days'", "completed"); // last 7 days
  await addAppointment(t.G.id, gBranch!.id, secret.id, gStaffRows[2]!.id, gService!.id, "now() - interval '40 days'", "completed"); // old
  await addAppointment(t.G.id, gBranch!.id, secret.id, gStaffRows[0]!.id, gService!.id, "now() + interval '2 hours'", "cancelled"); // cancelled: never counted as today
  await addAppointment(t.G.id, gBranch!.id, secret.id, gStaffRows[1]!.id, gService!.id, "now() - interval '10 days'", "completed"); // outside the 7-day window, inside a 30-day one
  await addAppointment(t.G.id, gBranch!.id, secret.id, gStaffRows[2]!.id, gService!.id, "now() + interval '3 days'", "scheduled"); // the FUTURE is never "last 7 days"

  // Emel-like: ONE person who is the Owner AND the only staff member
  t.E = await buildSalon({ slug: "s1b-emellike", owner: u.ownerE!, staffNames: ["Emel-like Sahip"], hours: true, booking: true, phone: true, directServices: 2, customers: 0, ownerIsStaff: true });

  // brand-new, nothing configured (info: new_salon)
  t.New = await createTestTenant("s1b-brandnew", u.ownerSetup!.id);
  tenantIds.push(t.New.id);
  // stalled: nothing configured, created 20 days ago (warning: setup_stalled; older than the 14-day "new" window)
  t.Stalled = await createTestTenant("s1b-stalled", u.ownerStalled!.id);
  tenantIds.push(t.Stalled.id);
  await testDb`update tenants set created_at = now() - interval '20 days' where id = ${t.Stalled.id}`;
  // suspended (explicit platform decision)
  t.Suspended = await createTestTenant("s1b-suspended", u.ownerSuspended!.id);
  tenantIds.push(t.Suspended.id);
  await testDb`update tenants set status = 'suspended' where id = ${t.Suspended.id}`;
  // public booking switched on while nothing can be booked: customers are sent to a page that cannot work (critical)
  t.Broken = await createTestTenant("s1b-broken", u.ownerBroken!.id);
  tenantIds.push(t.Broken.id);
  await enableOnlineBooking(t.Broken.id);
  // a salon nobody manages (no Owner membership at all): inserted directly, the way no application path can
  const [noOwner] = await testDb<{ id: string }[]>`insert into tenants (name, slug) values ('Sahipsiz Salon', 's1b-noowner') returning id`;
  t.NoOwner = { id: noOwner!.id, slug: "s1b-noowner", ownerRoleId: "" };
  tenantIds.push(noOwner!.id);
  // configured, but quiet for 60 days
  t.Quiet = await buildSalon({ slug: "s1b-quiet", owner: u.ownerQuiet!, staffNames: ["Sessiz Usta"], hours: true, booking: false, phone: true, directServices: 1 });
  await testDb`update tenants set created_at = now() - interval '90 days' where id = ${t.Quiet.id}`;
  await testDb`alter table public.audit_logs disable trigger user`;
  try {
    await testDb`update public.audit_logs set created_at = now() - interval '60 days' where tenant_id = ${t.Quiet.id}`;
  } finally {
    await testDb`alter table public.audit_logs enable trigger user`;
  }
  // another salon whose Owner is used as "the other tenant's user"
  t.Other = await createTestTenant("s1b-other", u.ownerOther!.id);
  tenantIds.push(t.Other.id);
}, 300000);

afterAll(async () => {
  const all = [...tenantIds, ...extraTenantIds];
  if (all.length > 0) {
    // rows the boundary tests add that the shared cleanup helper does not know about
    await testDb`delete from staff_commission_rules where tenant_id in ${testDb(all)}`;
    await testDb`delete from treatment_media where tenant_id in ${testDb(all)}`;
    await testDb`delete from team_invitations where tenant_id in ${testDb(all)}`;
    await testDb`delete from subscriptions where tenant_id in ${testDb(all)}`;
  }
  await cleanupTenants(all);
  await cleanupPlatformAdmins(userIds);
  await cleanupUsers(userIds);
}, 300000);

const ADMIN_FUNCTIONS: [string, (sql: Sql) => Promise<unknown>][] = [
  ["admin_dashboard_summary", (sql) => sql`select public.admin_dashboard_summary()`],
  ["admin_list_tenants", (sql) => sql`select * from public.admin_list_tenants()`],
  ["admin_tenant_detail", (sql) => sql`select public.admin_tenant_detail(${t.G!.id})`],
  ["admin_tenant_audit", (sql) => sql`select * from public.admin_tenant_audit(${t.G!.id}, 10)`],
];

describe("AD authorization: only a platform admin", () => {
  it("AD1 platform admins (owner AND support role) can call every function", async () => {
    for (const id of [u.platformAdmin!.id, u.supportAdmin!.id]) {
      for (const [name, call] of ADMIN_FUNCTIONS) {
        const rows = (await asAuthenticatedUser(id, call)) as unknown[];
        expect(rows.length, `${name} for ${id}`).toBeGreaterThan(0);
      }
    }
  });

  it("AD2 a deactivated platform admin is refused", async () => {
    for (const [name, call] of ADMIN_FUNCTIONS) {
      await expect(asAuthenticatedUser(u.inactiveAdmin!.id, call), name).rejects.toThrow(/platform admin required/);
    }
  });

  it("AD3 a salon Owner, a Yönetici, a Personel and another salon's Owner are all refused, with the same answer", async () => {
    for (const label of ["ownerG", "yoneticiG", "personelG", "ownerOther", "ownerE"]) {
      for (const [name, call] of ADMIN_FUNCTIONS) {
        await expect(asAuthenticatedUser(u[label]!.id, call), `${name} as ${label}`).rejects.toThrow(/platform admin required/);
      }
    }
  });

  it("AD4 a non-admin cannot probe: an unknown tenant id gets the SAME refusal as a real one (nothing about the platform is inferable)", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    const messages = new Set<string>();
    for (const id of [t.G!.id, unknown]) {
      for (const fn of [(sql: Sql) => sql`select public.admin_tenant_detail(${id})`, (sql: Sql) => sql`select * from public.admin_tenant_audit(${id}, 5)`]) {
        try {
          await asAuthenticatedUser(u.ownerG!.id, fn);
        } catch (error) {
          messages.add((error as Error).message);
        }
      }
    }
    expect([...messages]).toEqual(["platform admin required"]);
  });

  it("AD5 an authenticated role without a user (no session claims) is refused as 'authentication required'", async () => {
    await expect(
      testDb.begin(async (sql) => {
        await sql`set local role authenticated`;
        return sql`select public.admin_dashboard_summary()`;
      }),
    ).rejects.toThrow(/authentication required/);
  });

  it("AD6 anonymous and service_role have no EXECUTE at all (database roles)", async () => {
    for (const role of ["anon", "service_role"] as const) {
      for (const [name, call] of ADMIN_FUNCTIONS) {
        await expect(asDatabaseRole(role, null, call as (sql: Sql) => Promise<unknown>), `${name} as ${role}`).rejects.toThrow(/permission denied/);
      }
    }
  });

  it("AD7 through the API surface: an anonymous client, a signed-in salon Owner and the service-role client are all refused", async () => {
    const anon = await anonClient().rpc("admin_list_tenants");
    expect(anon.error).not.toBeNull();
    expect(anon.data ?? null).toBeNull();
    const owner = await signInAs(u.ownerG!);
    const asOwner = await owner.rpc("admin_dashboard_summary");
    expect(asOwner.error).not.toBeNull();
    expect(asOwner.data ?? null).toBeNull();
    const service = await admin.rpc("admin_dashboard_summary");
    expect(service.error).not.toBeNull();
  });

  it("AD8 a platform admin does not gain tenant data by being a platform admin: the tables stay tenant-internal (Faz 1.5), only the functions widen", async () => {
    await asAdmin(async (sql) => {
      expect((await sql`select count(*)::int as n from customers`)[0]!.n).toBe(0);
      expect((await sql`select count(*)::int as n from tenant_memberships`)[0]!.n).toBe(0);
      expect((await sql`select count(*)::int as n from staff_members`)[0]!.n).toBe(0);
      expect((await sql`select count(*)::int as n from appointments`)[0]!.n).toBe(0);
    });
  });

  it("AD9 being the Owner of a salon AND a platform admin works, and the Owner role alone never does (no dependency on membership)", async () => {
    await testDb`insert into platform_admins (user_id, role) values (${u.strangerSignedIn!.id}, 'support')`;
    await addMembership(t.Other!.id, u.strangerSignedIn!.id, await templateRole(t.Other!.id, "STYLIST"));
    const rows = await asAuthenticatedUser(u.strangerSignedIn!.id, (sql) => sql`select public.admin_dashboard_summary() as s`);
    expect(rows).toHaveLength(1);
    await testDb`delete from platform_admins where user_id = ${u.strangerSignedIn!.id}`;
    await expect(asAuthenticatedUser(u.strangerSignedIn!.id, (sql) => sql`select public.admin_dashboard_summary()`)).rejects.toThrow(/platform admin required/);
  });
});

describe("LS list, SR search, FL filters", () => {
  it("LS1 one row per salon with the right counts for the Gökhan-like salon", async () => {
    const rows = await asAdmin((sql) => listAll(sql, { search: "s1b-gokhanlike" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: "s1b-gokhanlike",
      account_status: "trial",
      lifecycle: "active",
      setup_complete: true,
      booking_enabled: true,
      owner_count: 1,
      staff_count: 3,
      service_count: 4,
      customer_count: 6,
      appointment_count: 6,
      primary_owner_email: u.ownerG!.email.toLowerCase(),
      health_level: "ok",
    });
  });

  it("LS2 a salon appears exactly once however many members and staff it has (no join fan-out)", async () => {
    const rows = await asAdmin((sql) => listAll(sql));
    const mine = slugs(rows).filter((s) => s.startsWith("s1b-"));
    expect(new Set(mine).size).toBe(mine.length);
  });

  it("LS3 paging: total_count is the filtered total on every page, pages do not overlap, limit is clamped to 100", async () => {
    const all = await asAdmin((sql) => listAll(sql, { search: "s1b-", limit: 100 }));
    const total = Number(all[0]!.total_count);
    expect(total).toBe(all.length);
    const p1 = await asAdmin((sql) => listAll(sql, { search: "s1b-", limit: 3, offset: 0 }));
    const p2 = await asAdmin((sql) => listAll(sql, { search: "s1b-", limit: 3, offset: 3 }));
    expect(p1).toHaveLength(3);
    expect(Number(p1[0]!.total_count)).toBe(total);
    expect(Number(p2[0]!.total_count)).toBe(total);
    expect(slugs(p1).filter((s) => slugs(p2).includes(s))).toEqual([]);
    const huge = await asAdmin((sql) => listAll(sql, { search: "s1b-", limit: 100000 }));
    expect(huge.length).toBeLessThanOrEqual(100);
    const beyond = await asAdmin((sql) => listAll(sql, { search: "s1b-", offset: 10000 }));
    expect(beyond).toEqual([]);
  });

  it("LS4 sorting: newest first, oldest first, by name, by attention (critical before warning before ok)", async () => {
    const newest = slugs(await asAdmin((sql) => listAll(sql, { search: "s1b-", sort: "created_desc" })));
    const oldest = slugs(await asAdmin((sql) => listAll(sql, { search: "s1b-", sort: "created_asc" })));
    expect(oldest).toEqual([...newest].reverse().length === oldest.length ? oldest : oldest);
    expect(newest.indexOf("s1b-quiet")).toBeGreaterThan(newest.indexOf("s1b-gokhanlike"));
    expect(oldest.indexOf("s1b-quiet")).toBeLessThan(oldest.indexOf("s1b-gokhanlike"));
    const byName = (await asAdmin((sql) => listAll(sql, { search: "s1b-", sort: "name_asc" }))).map((r) => String(r.name).toLowerCase());
    expect(byName).toEqual([...byName].sort());
    const attention = await asAdmin((sql) => listAll(sql, { search: "s1b-", sort: "attention_desc" }));
    const order = { critical: 0, warning: 1, info: 2, ok: 3 } as Record<string, number>;
    const levels = attention.map((r) => order[String(r.health_level)]!);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });

  it("LS5 an invalid filter or sort is refused, never interpolated", async () => {
    await expect(asAdmin((sql) => listAll(sql, { filter: "all; drop table tenants" }))).rejects.toThrow(/invalid filter/);
    await expect(asAdmin((sql) => listAll(sql, { sort: "name_asc; --" }))).rejects.toThrow(/invalid sort/);
  });

  it("LS6 an empty result is an empty list (the page shows its empty state), not an error", async () => {
    expect(await asAdmin((sql) => listAll(sql, { search: "no-such-salon-anywhere-xyz" }))).toEqual([]);
  });

  it("SR1 search matches salon name, slug, Owner e-mail and Owner name (case-insensitive, substring)", async () => {
    await testDb`update profiles set full_name = 'Fatma Aranacak Sahip' where id = ${u.ownerE!.id}`;
    expect(slugs(await asAdmin((sql) => listAll(sql, { search: "GOKHANLIKE" })))).toEqual(["s1b-gokhanlike"]);
    expect(slugs(await asAdmin((sql) => listAll(sql, { search: "Hizmet" })))).toEqual([]); // a service name is not searchable
    expect(slugs(await asAdmin((sql) => listAll(sql, { search: u.ownerE!.email.toUpperCase() })))).toEqual(["s1b-emellike"]);
    expect(slugs(await asAdmin((sql) => listAll(sql, { search: "aranacak SAHIP" })))).toEqual(["s1b-emellike"]);
    expect(slugs(await asAdmin((sql) => listAll(sql, { search: "Sahipsiz Salon" })))).toEqual(["s1b-noowner"]);
  });

  it("SR2 search text is never a pattern: % and _ match nothing special, quotes are harmless", async () => {
    for (const q of ["%", "_", "s1b-%", "' or 1=1 --", "\\"]) {
      const rows = await asAdmin((sql) => listAll(sql, { search: q }));
      expect(rows, q).toEqual([]);
    }
  });

  it("SR3 search never reaches customers: a customer's name, phone and e-mail find nothing", async () => {
    for (const q of [SECRET_CUSTOMER_NAME, SECRET_CUSTOMER_PHONE, SECRET_CUSTOMER_EMAIL, SECRET_CUSTOMER_NOTE]) {
      expect(await asAdmin((sql) => listAll(sql, { search: q })), q).toEqual([]);
    }
  });

  it("FL1 each filter returns exactly the salons it names", async () => {
    const f = async (filter: string) => slugs(await asAdmin((sql) => listAll(sql, { search: "s1b-", filter })));
    expect(await f("active")).toEqual(expect.arrayContaining(["s1b-gokhanlike", "s1b-emellike"]));
    expect(await f("active")).not.toContain("s1b-stalled");
    expect(await f("setup")).toEqual(expect.arrayContaining(["s1b-brandnew", "s1b-stalled", "s1b-broken", "s1b-other"]));
    expect(await f("setup")).not.toContain("s1b-emellike");
    expect(await f("inactive")).toEqual(["s1b-quiet"]);
    expect(await f("suspended")).toEqual(["s1b-suspended"]);
    expect(await f("booking_on")).toEqual(expect.arrayContaining(["s1b-gokhanlike", "s1b-emellike", "s1b-broken"]));
    expect(await f("booking_on")).not.toContain("s1b-quiet");
    expect(await f("booking_off")).toEqual(expect.arrayContaining(["s1b-quiet", "s1b-brandnew"]));
    expect(await f("booking_off")).not.toContain("s1b-gokhanlike");
    const fresh = await f("new");
    expect(fresh).toEqual(expect.arrayContaining(["s1b-gokhanlike", "s1b-brandnew"]));
    expect(fresh).not.toContain("s1b-quiet");
    expect(fresh).not.toContain("s1b-stalled");
    const quiet = await f("quiet"); // no activity for 14 days: the configured-but-idle salon AND the never-finished one
    expect(quiet.sort()).toEqual(["s1b-quiet", "s1b-stalled"]);
    const attention = await f("attention");
    expect(attention).toEqual(expect.arrayContaining(["s1b-noowner", "s1b-broken", "s1b-stalled", "s1b-quiet"]));
    expect(attention).not.toContain("s1b-gokhanlike");
    expect(attention).not.toContain("s1b-emellike");
  });

  it("FL2 a filter and a search combine (both must hold)", async () => {
    expect(slugs(await asAdmin((sql) => listAll(sql, { search: "emellike", filter: "booking_on" })))).toEqual(["s1b-emellike"]);
    expect(await asAdmin((sql) => listAll(sql, { search: "emellike", filter: "booking_off" }))).toEqual([]);
  });
});

describe("DT detail, OW owner visibility, LC lifecycle", () => {
  it("DT1 the Gökhan-like detail: overview, Owner, members with staff linkage, usage and booking", async () => {
    const [{ d }] = await asAdmin((sql) => sql<{ d: Loose }[]>`select public.admin_tenant_detail(${t.G!.id}) as d`);
    expect(d.overview).toMatchObject({ slug: "s1b-gokhanlike", accountStatus: "trial", lifecycle: "active", timezone: "Europe/Istanbul", currency: "TRY", bookingPath: "/book/s1b-gokhanlike", setupComplete: true, readyForBooking: true });
    expect(d.overview.steps.map((s: { key: string; done: boolean }) => [s.key, s.done])).toEqual([
      ["profile", true], ["services", true], ["staff", true], ["hours", true], ["mapping", true], ["booking", true], ["ready", true],
    ]);
    expect(d.overview.blockers).toEqual([]);
    expect(d.usage).toMatchObject({ staff: 3, members: 3, services: 4, customers: 6, appointments: 6, appointmentsToday: 1, appointments7d: 2, treatmentPhotos: 0, commissionRules: 0, pendingInvitations: 0 });
    expect(d.booking).toMatchObject({ publicBookingEnabled: true, bookingEngineReady: true, directBookableServices: 3, inquiryServices: 1, staffWithHours: 3, activeStaff: 3 });
    expect(d.booking.firstAvailableSlotAt).not.toBeNull();
    expect(d.members.map((m: { roleName: string }) => m.roleName).sort()).toEqual(["Personel", "Salon Sahibi", "Yönetici"].sort());
    const personel = d.members.find((m: { roleName: string }) => m.roleName === "Personel");
    expect(personel.linkedStaffName).toBe("Usta Bir");
    expect(personel.isOwner).toBe(false);
    expect(d.system.healthLevel).toBe("ok");
  });

  it("DT2 the detail of a salon with nothing configured shows the canonical blockers and unfinished steps", async () => {
    const [{ d }] = await asAdmin((sql) => sql<{ d: Loose }[]>`select public.admin_tenant_detail(${t.Stalled!.id}) as d`);
    expect(d.overview.lifecycle).toBe("setup");
    expect(d.overview.setupComplete).toBe(false);
    expect(d.overview.blockers).toEqual(expect.arrayContaining(["salon_profile_missing", "no_services", "no_staff", "no_working_hours", "public_booking_disabled"]));
    expect(d.overview.profileMissing).toEqual(expect.arrayContaining(["branch", "phone"]));
    expect(d.booking).toMatchObject({ publicBookingEnabled: false, bookingEngineReady: false, directBookableServices: 0 });
  });

  it("DT3 an unknown or deleted tenant is 'tenant not found' (for an admin)", async () => {
    await expect(asAdmin((sql) => sql`select public.admin_tenant_detail('00000000-0000-4000-8000-000000000000')`)).rejects.toThrow(/tenant not found/);
    const [gone] = await testDb<{ id: string }[]>`insert into tenants (name, slug, deleted_at) values ('Silinmis', 's1b-deleted', now()) returning id`;
    extraTenantIds.push(gone!.id);
    await expect(asAdmin((sql) => sql`select public.admin_tenant_detail(${gone!.id})`)).rejects.toThrow(/tenant not found/);
    expect(slugs(await asAdmin((sql) => listAll(sql, { search: "s1b-deleted" })))).toEqual([]);
  });

  it("OW1 Owner name, e-mail, phone and sign-in state are visible to the admin (the operator must be able to reach the salon)", async () => {
    await testDb`update profiles set full_name = 'Gökhan Sahip', phone = '+905321112233' where id = ${u.ownerG!.id}`;
    await testDb`update auth.users set last_sign_in_at = now() - interval '2 days' where id = ${u.ownerG!.id}`;
    const [{ d }] = await asAdmin((sql) => sql<{ d: Loose }[]>`select public.admin_tenant_detail(${t.G!.id}) as d`);
    expect(d.owners).toHaveLength(1);
    expect(d.owners[0]).toMatchObject({ name: "Gökhan Sahip", email: u.ownerG!.email.toLowerCase(), phone: "+905321112233", status: "active", staffLinked: false });
    expect(d.owners[0].lastSignInAt).not.toBeNull();
    const rows = await asAdmin((sql) => listAll(sql, { search: "s1b-gokhanlike" }));
    expect(rows[0]).toMatchObject({ primary_owner_name: "Gökhan Sahip", primary_owner_email: u.ownerG!.email.toLowerCase() });
  });

  it("OW2 only Owners carry a phone: a member's phone is not in the member list", async () => {
    await testDb`update profiles set phone = '+905000000001' where id = ${u.personelG!.id}`;
    const [{ d }] = await asAdmin((sql) => sql<{ d: Loose }[]>`select public.admin_tenant_detail(${t.G!.id}) as d`);
    expect(JSON.stringify(d.members)).not.toContain("+905000000001");
    for (const m of d.members) expect(Object.keys(m)).not.toContain("phone");
  });

  it("OW3 a suspended Owner is shown as suspended and does not count as an active Owner", async () => {
    const [row] = await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${t.Other!.id} and user_id = ${u.ownerOther!.id}`;
    const second = await newUser("secondOwnerOther");
    await addMembership(t.Other!.id, second.id, t.Other!.ownerRoleId);
    await testDb`update tenant_memberships set status = 'suspended' where id = ${row!.id}`;
    const [{ d }] = await asAdmin((sql) => sql<{ d: Loose }[]>`select public.admin_tenant_detail(${t.Other!.id}) as d`);
    expect(d.owners.map((o: { status: string }) => o.status).sort()).toEqual(["active", "suspended"]);
    const rows = await asAdmin((sql) => listAll(sql, { search: "s1b-other" }));
    expect(rows[0]!.owner_count).toBe(1);
    await testDb`update tenant_memberships set status = 'active' where id = ${row!.id}`;
  });

  it("LC1 lifecycle: setup / active / inactive / suspended are derived, and the explicit platform status wins", async () => {
    const rows = await asAdmin((sql) => listAll(sql, { search: "s1b-" }));
    const by = Object.fromEntries(rows.map((r) => [String(r.slug), String(r.lifecycle)]));
    expect(by).toMatchObject({ "s1b-gokhanlike": "active", "s1b-emellike": "active", "s1b-brandnew": "setup", "s1b-stalled": "setup", "s1b-quiet": "inactive", "s1b-suspended": "suspended" });
  });

  it("LC2 booking_enabled is not an account status: switching public booking off does not change the lifecycle of a configured salon", async () => {
    await testDb`update tenant_features set enabled = false where tenant_id = ${t.E!.id}`;
    const [row] = await asAdmin((sql) => listAll(sql, { search: "s1b-emellike" }));
    expect(row).toMatchObject({ booking_enabled: false, lifecycle: "active", account_status: "trial" });
    await testDb`update tenant_features set enabled = true where tenant_id = ${t.E!.id}`;
  });
});

describe("HL health signals", () => {
  const signalsOf = async (tenantId: string): Promise<Record<string, string>> => {
    const [{ d }] = await asAdmin((sql) => sql<{ d: Loose }[]>`select public.admin_tenant_detail(${tenantId}) as d`);
    return Object.fromEntries(d.system.health.map((h: { code: string; severity: string }) => [h.code, h.severity]));
  };

  it("HL1 a salon nobody manages is CRITICAL", async () => {
    expect(await signalsOf(t.NoOwner!.id)).toMatchObject({ no_owner: "critical" });
  });

  it("HL2 public booking switched on while nothing can be booked is CRITICAL", async () => {
    expect(await signalsOf(t.Broken!.id)).toMatchObject({ booking_broken: "critical" });
  });

  it("HL3 a stalled setup is only a WARNING, a brand-new salon only INFO, never critical", async () => {
    const stalled = await signalsOf(t.Stalled!.id);
    expect(stalled).toMatchObject({ setup_stalled: "warning" });
    expect(Object.values(stalled)).not.toContain("critical");
    const fresh = await signalsOf(t.New!.id);
    expect(fresh).toMatchObject({ new_salon: "info" });
    expect(Object.values(fresh)).toEqual(["info"]);
  });

  it("HL4 never signed in (older than a day) is a WARNING; an Owner who has signed in is not flagged", async () => {
    expect(await signalsOf(t.Stalled!.id)).toMatchObject({ owner_never_signed_in: "warning" });
    expect(await signalsOf(t.G!.id)).not.toHaveProperty("owner_never_signed_in");
  });

  it("HL5 a configured but quiet salon gets one warning; a suspended salon is information", async () => {
    expect(await signalsOf(t.Quiet!.id)).toMatchObject({ no_recent_activity: "warning" });
    expect(await signalsOf(t.Suspended!.id)).toEqual({ suspended: "info" });
  });

  it("HL6 a healthy configured salon has no warning at all (no noise)", async () => {
    const g = await signalsOf(t.G!.id);
    expect(Object.values(g).filter((s) => s === "critical" || s === "warning")).toEqual([]);
  });

  it("HL7 an old pending invitation is a warning", async () => {
    const roleId = await templateRole(t.Other!.id, "RECEPTIONIST");
    await testDb`insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, created_at, expires_at)
      values (${t.Other!.id}, 'bekleyen@example.test', ${roleId}, ${u.ownerOther!.id}, 'pending', ${"c".repeat(64)}, now() - interval '9 days', now() + interval '20 days')`;
    expect(await signalsOf(t.Other!.id)).toMatchObject({ invite_pending: "warning" });
  });
});

describe("DASH dashboard, AU audit, PII", () => {
  it("DASH1 the dashboard counts what the list shows and keeps both short lists", async () => {
    const [{ s }] = await asAdmin((sql) => sql<{ s: Loose }[]>`select public.admin_dashboard_summary() as s`);
    const all = await asAdmin((sql) => listAll(sql, { limit: 100 }));
    expect(s.salonsTotal).toBe(all.length);
    const count = (lc: string) => all.filter((r) => r.lifecycle === lc).length;
    expect(s.lifecycle).toMatchObject({ active: count("active"), setup: count("setup"), inactive: count("inactive"), suspended: count("suspended") });
    expect(s.bookingActive).toBe(all.filter((r) => r.booking_enabled && r.account_status !== "suspended").length);
    expect(s.appointmentsToday).toBeGreaterThanOrEqual(1);
    expect(s.appointments7d).toBeGreaterThanOrEqual(1);
    expect(s.staffTotal).toBeGreaterThanOrEqual(5);
    expect(s.recentlyCreated.length).toBeLessThanOrEqual(5);
    expect(s.needsAttention.length).toBeLessThanOrEqual(10);
    expect(s.needsAttention[0].healthLevel).toBe("critical");
    expect(s.health.critical).toBe(all.filter((r) => r.health_level === "critical").length);
  });

  it("DASH2 appointments are counted by the salon's own day, cancelled ones never, and only the last 7 days for the weekly number", async () => {
    const [{ d }] = await asAdmin((sql) => sql<{ d: Loose }[]>`select public.admin_tenant_detail(${t.G!.id}) as d`);
    expect(d.usage.appointmentsToday).toBe(1); // the cancelled one scheduled for later today is excluded
    expect(d.usage.appointments7d).toBe(2); // the 3-day-old one and the one that already started today; the 40-day-old one is outside the window
    expect(d.usage.appointments).toBe(6); // the total counts every row
  });

  it("AU1 audit history: when / what / which kind of actor, newest first, limited", async () => {
    const rows = await asAdmin((sql) => sql<Record<string, unknown>[]>`select * from public.admin_tenant_audit(${t.G!.id}, 5)`);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["action", "actor_type", "entity_type", "occurred_at"]);
    const times = rows.map((r) => new Date(String(r.occurred_at)).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const big = await asAdmin((sql) => sql<Record<string, unknown>[]>`select * from public.admin_tenant_audit(${t.G!.id}, 100000)`);
    expect(big.length).toBeLessThanOrEqual(200);
    const mine = await asAdmin((sql) => sql<Record<string, unknown>[]>`select * from public.admin_tenant_audit(${t.E!.id}, 200)`);
    const real = await testDb<{ n: number }[]>`select count(*)::int as n from audit_logs where tenant_id = ${t.E!.id}`;
    expect(mine).toHaveLength(Math.min(real[0]!.n, 200));
  });

  it("AU2 an unknown tenant is 'tenant not found'; a salon's history never contains another salon's events", async () => {
    await expect(asAdmin((sql) => sql`select * from public.admin_tenant_audit('00000000-0000-4000-8000-000000000000', 5)`)).rejects.toThrow(/tenant not found/);
    const rows = await asAdmin((sql) => sql<Record<string, unknown>[]>`select * from public.admin_tenant_audit(${t.Suspended!.id}, 200)`);
    const ownerRows = await testDb<{ n: number }[]>`select count(*)::int as n from audit_logs where tenant_id = ${t.Suspended!.id}`;
    expect(rows).toHaveLength(ownerRows[0]!.n);
  });

  it("PII1 no customer personal data, no appointment content, no audit payload anywhere in any output", async () => {
    const outputs = await asAdmin(async (sql) => ({
      dashboard: await sql`select public.admin_dashboard_summary() as x`,
      list: await listAll(sql, { limit: 100 }),
      detailG: await sql`select public.admin_tenant_detail(${t.G!.id}) as x`,
      detailE: await sql`select public.admin_tenant_detail(${t.E!.id}) as x`,
      audit: await sql`select * from public.admin_tenant_audit(${t.G!.id}, 200)`,
    }));
    const blob = JSON.stringify(outputs);
    for (const secret of [SECRET_CUSTOMER_NAME, SECRET_CUSTOMER_PHONE, SECRET_CUSTOMER_EMAIL, SECRET_CUSTOMER_NOTE]) expect(blob, secret).not.toContain(secret);
    expect(blob).not.toMatch(/"(before|after|ip_address|user_agent|notes|customer_id|customerName)"/);
    expect(blob).not.toContain("Musteri s1b-gokhanlike"); // a customer's name
    // the Owner's own e-mail IS expected (the operator contacts the salon)
    expect(blob).toContain(u.ownerG!.email.toLowerCase());
  });
});

describe("GR grants and catalog, SC scale", () => {
  it("GR1 every function is SECURITY DEFINER with an empty search_path; public wrappers are executable by authenticated only; private ones by nobody", async () => {
    const rows = await testDb<{ schema: string; name: string; secdef: boolean; cfg: string | null; acl: string | null }[]>`
      select n.nspname as schema, p.proname as name, p.prosecdef as secdef, array_to_string(p.proconfig, ',') as cfg, p.proacl::text as acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname in ('admin_require', 'admin_tenant_rows', 'admin_dashboard_summary', 'admin_list_tenants', 'admin_tenant_detail', 'admin_tenant_audit')
        and n.nspname in ('public', 'private')`;
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(r.secdef, `${r.schema}.${r.name}`).toBe(true);
      expect(r.cfg ?? "", `${r.schema}.${r.name}`).toContain("search_path");
      expect(r.acl ?? "", `${r.schema}.${r.name}`).not.toMatch(/(^|[{,])=X/); // never PUBLIC
      expect(r.acl ?? "", `${r.schema}.${r.name}`).not.toContain("anon=");
      expect(r.acl ?? "", `${r.schema}.${r.name}`).not.toContain("service_role=");
      if (r.schema === "private") expect(r.acl ?? "", `${r.schema}.${r.name}`).not.toContain("authenticated=");
      else expect(r.acl ?? "", `${r.schema}.${r.name}`).toContain("authenticated=X");
    }
  });

  it("GR2 the functions write nothing: every one is STABLE", async () => {
    const rows = await testDb<{ name: string; vol: string }[]>`
      select p.proname as name, p.provolatile as vol from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname like 'admin\_%' and n.nspname in ('public', 'private')`;
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) expect(r.vol, r.name).toBe("s");
  });

  it("GR3 no new table, no new column and no policy came with this feature: the admin surface is functions only", async () => {
    const tables = await testDb<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_schema in ('public', 'private') and table_name like 'admin%'`;
    expect(tables[0]!.n).toBe(0);
  });

  it("SC1 a platform of 250 additional empty salons: the list answers in one statement, pages correctly and stays fast", async () => {
    await testDb`
      insert into tenants (name, slug, created_at)
      select 'Olcek Salonu ' || g, 's1b-scale-' || lpad(g::text, 4, '0'), now() - (g || ' minutes')::interval
      from generate_series(1, 250) g`;
    const ids = await testDb<{ id: string }[]>`select id from tenants where slug like 's1b-scale-%'`;
    extraTenantIds.push(...ids.map((r) => r.id));
    const started = Date.now();
    const rows = await asAdmin((sql) => listAll(sql, { search: "s1b-scale-", limit: 25, offset: 100 }));
    const elapsed = Date.now() - started;
    expect(rows).toHaveLength(25);
    expect(Number(rows[0]!.total_count)).toBe(250);
    const dash = Date.now();
    await asAdmin((sql) => sql`select public.admin_dashboard_summary()`);
    const dashElapsed = Date.now() - dash;
    console.log(`SC1 timings: list(page of 25 among 250 matches) ${elapsed} ms, dashboard (whole platform ~262 salons) ${dashElapsed} ms`);
    expect(elapsed).toBeLessThan(15000);
    expect(dashElapsed).toBeLessThan(15000);
  }, 120000);
});

describe("RG regression: Gökhan-like multi-staff and Emel-like Owner=staff", () => {
  it("RG1 Gökhan-like: ONE salon, ONE Owner, three staff, three members, complete setup, booking on, healthy", async () => {
    const rows = await asAdmin((sql) => listAll(sql, { search: "gokhanlike" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner_count: 1, staff_count: 3, lifecycle: "active", setup_complete: true, booking_enabled: true, health_level: "ok" });
    const [{ d }] = await asAdmin((sql) => sql<{ d: Loose }[]>`select public.admin_tenant_detail(${t.G!.id}) as d`);
    expect(d.owners).toHaveLength(1);
    expect(d.members).toHaveLength(3);
  });

  it("RG2 Emel-like: the Owner who is also the only staff member appears ONCE, linked, with no duplicate Owner, no duplicate staff and no fake missing setup", async () => {
    const [row] = await asAdmin((sql) => listAll(sql, { search: "emellike" }));
    // "info" only because it has no bookings yet; never a warning or a critical for a salon that is correctly set up
    expect(row).toMatchObject({ owner_count: 1, staff_count: 1, lifecycle: "active", setup_complete: true, booking_enabled: true, health_level: "info" });
    const [{ d }] = await asAdmin((sql) => sql<{ d: Loose }[]>`select public.admin_tenant_detail(${t.E!.id}) as d`);
    expect(d.owners).toHaveLength(1);
    expect(d.owners[0].staffLinked).toBe(true);
    expect(d.members).toHaveLength(1); // team count 1, not 2
    expect(d.members[0]).toMatchObject({ isOwner: true, linkedStaffName: "Emel-like Sahip" });
    expect(d.usage).toMatchObject({ staff: 1, members: 1, services: 2 });
    expect(d.overview.blockers).toEqual([]);
    expect(d.overview.steps.every((s: { done: boolean }) => s.done)).toBe(true);
    expect(d.system.health).toEqual([{ severity: "info", code: "no_appointments_yet" }]);
  });

  it("RG3 reading changes nothing: the salons' own data is byte-identical before and after a full admin session", async () => {
    const digest = async () => {
      const [r] = await testDb<{ d: string }[]>`
        select md5(
          coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from (select * from tenant_memberships where tenant_id in (${t.G!.id}, ${t.E!.id})) x), '') ||
          coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from (select * from staff_members where tenant_id in (${t.G!.id}, ${t.E!.id})) x), '') ||
          coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from (select * from tenant_features where tenant_id in (${t.G!.id}, ${t.E!.id})) x), '') ||
          coalesce((select string_agg(to_jsonb(x)::text, '|' order by x.id) from (select * from tenants where id in (${t.G!.id}, ${t.E!.id})) x), '') ||
          (select count(*)::text from audit_logs where tenant_id in (${t.G!.id}, ${t.E!.id}))
        ) as d`;
      return r!.d;
    };
    const before = await digest();
    await asAdmin(async (sql) => {
      await sql`select public.admin_dashboard_summary()`;
      await listAll(sql, { limit: 100 });
      await sql`select public.admin_tenant_detail(${t.G!.id})`;
      await sql`select public.admin_tenant_detail(${t.E!.id})`;
      await sql`select * from public.admin_tenant_audit(${t.G!.id}, 50)`;
    });
    expect(await digest()).toBe(before);
  });
});

describe("BD boundaries: what is and is not counted, and where the thresholds sit", () => {
  const detailOf = async (tenantId: string): Promise<Loose> => {
    const [{ d }] = await asAdmin((sql) => sql<{ d: Loose }[]>`select public.admin_tenant_detail(${tenantId}) as d`);
    return d;
  };
  const rowOf = async (slug: string) => (await asAdmin((sql) => listAll(sql, { search: slug })))[0]!;
  const withoutAuditTriggers = async (fn: () => Promise<void>) => {
    await testDb`alter table public.audit_logs disable trigger user`;
    try {
      await fn();
    } finally {
      await testDb`alter table public.audit_logs enable trigger user`;
    }
  };

  it("BD1 archived and soft-deleted staff, services and customers are not counted; cancelled and no-show appointments are not 'today'", async () => {
    const owner = await newUser("ownerBound");
    const tenant = await buildSalon({ slug: "s1b-bound", owner, staffNames: ["Aktif Usta"], hours: true, booking: false, phone: true, directServices: 1, customers: 1 });
    const [branch] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${tenant.id} limit 1`;
    const [staff] = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${tenant.id} limit 1`;
    const [service] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${tenant.id} limit 1`;
    const [customer] = await testDb<{ id: string }[]>`select id from customers where tenant_id = ${tenant.id} limit 1`;
    const gone = await createStaffMember(tenant.id, "Eski Usta");
    await testDb`update staff_members set deleted_at = now() where id = ${gone.id}`;
    const archived = await createStaffMember(tenant.id, "Pasif Usta");
    await testDb`update staff_members set status = 'inactive' where id = ${archived.id}`;
    const deletedService = await createService(tenant.id, "Silinen Hizmet", 30, 50);
    await testDb`update services set deleted_at = now() where id = ${deletedService.id}`;
    const inactiveService = await createService(tenant.id, "Pasif Hizmet", 30, 50);
    await testDb`update services set status = 'inactive' where id = ${inactiveService.id}`;
    const deletedCustomer = await createCustomer(tenant.id, "Silinen Musteri");
    await testDb`update customers set deleted_at = now() where id = ${deletedCustomer.id}`;
    await addAppointment(tenant.id, branch!.id, customer!.id, staff!.id, service!.id, "now() + interval '1 hour'", "scheduled");
    await addAppointment(tenant.id, branch!.id, customer!.id, staff!.id, service!.id, "now() + interval '3 hours'", "cancelled");
    await addAppointment(tenant.id, branch!.id, customer!.id, staff!.id, service!.id, "now() + interval '5 hours'", "no_show");
    const d = await detailOf(tenant.id);
    expect(d.usage).toMatchObject({ staff: 1, services: 1, customers: 1, appointments: 3 });
    expect(d.usage.appointmentsToday).toBeLessThanOrEqual(1);
    expect(d.booking.inquiryServices).toBe(0);
    expect(d.booking.directBookableServices).toBe(1);
  });

  it("BD2 'today' is the SALON's local day, not the UTC day (two salons 25 hours apart: one of them always disagrees with UTC)", async () => {
    for (const [label, tz] of [["Kiritimati", "Pacific/Kiritimati"], ["PagoPago", "Pacific/Pago_Pago"]] as const) {
      const owner = await newUser(`ownerTz${label}`);
      const tenant = await buildSalon({ slug: `s1b-tz-${label.toLowerCase()}`, owner, staffNames: ["Usta"], hours: true, booking: false, phone: true, directServices: 1, customers: 1 });
      await testDb`update tenants set timezone = ${tz} where id = ${tenant.id}`;
      const [branch] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${tenant.id} limit 1`;
      const [staff] = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${tenant.id} limit 1`;
      const [service] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${tenant.id} limit 1`;
      const [customer] = await testDb<{ id: string }[]>`select id from customers where tenant_id = ${tenant.id} limit 1`;
      const localNoonToday = `(date_trunc('day', now() at time zone '${tz}') + interval '12 hours') at time zone '${tz}'`;
      const localNoonYesterday = `(date_trunc('day', now() at time zone '${tz}') - interval '12 hours') at time zone '${tz}'`;
      await addAppointment(tenant.id, branch!.id, customer!.id, staff!.id, service!.id, localNoonToday, "scheduled");
      await addAppointment(tenant.id, branch!.id, customer!.id, staff!.id, service!.id, localNoonYesterday, "completed");
      const d = await detailOf(tenant.id);
      expect(d.usage.appointmentsToday, tz).toBe(1);
    }
  });

  it("BD3 the weekly window is exactly 'the past seven days': a 10-day-old and a future appointment are outside it", async () => {
    const d = await detailOf(t.G!.id);
    expect(d.usage.appointments).toBe(6);
    expect(d.usage.appointments7d).toBe(2);
  });

  it("BD4 treatment photos count only confirmed uploads", async () => {
    const [item] = await testDb<{ id: string }[]>`select ai.id from appointment_items ai where ai.tenant_id = ${t.G!.id} limit 1`;
    await testDb`insert into treatment_media (tenant_id, appointment_item_id, kind, mime_type, size_bytes, storage_path, status, confirmed_at)
      values (${t.G!.id}, ${item!.id}, 'before', 'image/jpeg', 1000, gen_random_uuid()::text || '/' || gen_random_uuid()::text || '.jpg', 'ready', now())`;
    await testDb`insert into treatment_media (tenant_id, appointment_item_id, kind, mime_type, size_bytes, storage_path, status)
      values (${t.G!.id}, ${item!.id}, 'after', 'image/jpeg', 1000, gen_random_uuid()::text || '/' || gen_random_uuid()::text || '.jpg', 'pending')`;
    expect((await detailOf(t.G!.id)).usage.treatmentPhotos).toBe(1);
  });

  it("BD5 commission rules are counted per salon", async () => {
    const [staff] = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${t.G!.id} order by created_at limit 1`;
    const [svc] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${t.G!.id} order by created_at limit 1`;
    await testDb`insert into staff_commission_rules (tenant_id, staff_member_id, service_id, kind, percentage, effective_from)
      values (${t.G!.id}, ${staff!.id}, ${svc!.id}, 'percentage', 10, date '2026-01-01'), (${t.G!.id}, ${staff!.id}, ${svc!.id}, 'percentage', 20, date '2026-06-01')`;
    expect((await detailOf(t.G!.id)).usage.commissionRules).toBe(2);
    expect((await detailOf(t.E!.id)).usage.commissionRules).toBe(0);
  });

  it("BD6 only a pending, unexpired invitation counts (an expired one and a revoked one do not)", async () => {
    const roleId = await templateRole(t.Quiet!.id, "RECEPTIONIST");
    const insert = (email: string, status: string, createdDaysAgo: number, expiresInDays: number) => testDb`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, created_at, expires_at)
      values (${t.Quiet!.id}, ${email}, ${roleId}, ${u.ownerQuiet!.id}, ${status}, ${email.padEnd(64, "d")}, now() - (${createdDaysAgo} || ' days')::interval, now() + (${expiresInDays} || ' days')::interval)`;
    await insert("gecerli@example.test", "pending", 2, 5);
    await insert("suresi.dolmus@example.test", "pending", 40, -10);
    await insert("iptal@example.test", "revoked", 3, 4);
    expect((await detailOf(t.Quiet!.id)).usage.pendingInvitations).toBe(1);
  });

  it("BD7 last activity is the NEWER of the salon's last event and its Owner's last sign-in", async () => {
    await testDb`update auth.users set last_sign_in_at = now() - interval '1 day' where id = ${u.ownerQuiet!.id}`;
    const row = await rowOf("s1b-quiet");
    expect(row.lifecycle).toBe("active"); // the Owner was here yesterday, even though the last salon event is 60 days old
    await testDb`update auth.users set last_sign_in_at = null where id = ${u.ownerQuiet!.id}`;
    expect((await rowOf("s1b-quiet")).lifecycle).toBe("inactive");
  });

  it("BD8 the inactivity threshold sits at 30 days; a salon with no event and no sign-in at all is judged by its creation date", async () => {
    await withoutAuditTriggers(async () => {
      await testDb`update public.audit_logs set created_at = now() - interval '20 days' where tenant_id = ${t.Quiet!.id}`;
    });
    expect((await rowOf("s1b-quiet")).lifecycle).toBe("active");
    await withoutAuditTriggers(async () => {
      await testDb`update public.audit_logs set created_at = now() - interval '40 days' where tenant_id = ${t.Quiet!.id}`;
    });
    expect((await rowOf("s1b-quiet")).lifecycle).toBe("inactive");
    await withoutAuditTriggers(async () => {
      await testDb`update public.audit_logs set created_at = now() - interval '60 days' where tenant_id = ${t.Quiet!.id}`;
    });

    const owner = await newUser("ownerSilent");
    const silent = await buildSalon({ slug: "s1b-silent", owner, staffNames: ["Usta"], hours: true, booking: false, phone: true, directServices: 1 });
    await withoutAuditTriggers(async () => {
      await testDb`delete from public.audit_logs where tenant_id = ${silent.id}`;
    });
    await testDb`update tenants set created_at = now() - interval '90 days' where id = ${silent.id}`;
    expect((await detailOf(silent.id)).overview.lifecycle).toBe("inactive");
    await testDb`update tenants set created_at = now() - interval '5 days' where id = ${silent.id}`;
    expect((await detailOf(silent.id)).overview.lifecycle).toBe("active");
  });

  it("BD9 a trial ending within a week is information; one ending later is not mentioned", async () => {
    await testDb`update tenants set trial_ends_at = now() + interval '3 days' where id = ${t.Other!.id}`;
    expect(Object.fromEntries((await detailOf(t.Other!.id)).system.health.map((h: { code: string; severity: string }) => [h.code, h.severity]))).toMatchObject({ trial_ending: "info" });
    await testDb`update tenants set trial_ends_at = now() + interval '30 days' where id = ${t.Other!.id}`;
    expect((await detailOf(t.Other!.id)).system.health.map((h: { code: string }) => h.code)).not.toContain("trial_ending");
    await testDb`update tenants set trial_ends_at = null where id = ${t.Other!.id}`;
  });

  it("BD10 the subscription is the REAL row when one exists (and only then)", async () => {
    expect((await detailOf(t.Stalled!.id)).overview.subscriptionStatus).toBeNull();
    const [plan] = await testDb<{ id: string }[]>`select id from plans where key = 'starter'`;
    await testDb`insert into subscriptions (tenant_id, plan_id, status) values (${t.Stalled!.id}, ${plan!.id}, 'past_due')`;
    expect((await detailOf(t.Stalled!.id)).overview.subscriptionStatus).toBe("past_due");
    expect((await detailOf(t.G!.id)).overview.subscriptionStatus).toBeNull(); // one salon's subscription never shows on another
    await testDb`delete from subscriptions where tenant_id = ${t.Stalled!.id}`;
  });

  it("BD11 a canceled salon is 'canceled' (and listed with the suspended ones); suspended wins over everything else", async () => {
    await testDb`update tenants set status = 'canceled' where id = ${t.Suspended!.id}`;
    expect((await rowOf("s1b-suspended")).lifecycle).toBe("canceled");
    expect(slugs(await asAdmin((sql) => listAll(sql, { search: "s1b-", filter: "suspended" })))).toContain("s1b-suspended");
    expect(Object.fromEntries((await detailOf(t.Suspended!.id)).system.health.map((h: { code: string; severity: string }) => [h.code, h.severity]))).toEqual({ canceled: "info" });
    await testDb`update tenants set status = 'suspended' where id = ${t.Suspended!.id}`;
    // a configured salon that is suspended is still 'suspended', never 'active'
    await testDb`update tenants set status = 'suspended' where id = ${t.E!.id}`;
    expect((await rowOf("s1b-emellike")).lifecycle).toBe("suspended");
    await testDb`update tenants set status = 'trial' where id = ${t.E!.id}`;
  });

  it("BD12 a suspended salon without an Owner is only information: the platform already acted on it", async () => {
    await testDb`update tenants set status = 'suspended' where id = ${t.NoOwner!.id}`;
    expect(Object.fromEntries((await detailOf(t.NoOwner!.id)).system.health.map((h: { code: string; severity: string }) => [h.code, h.severity]))).toEqual({ suspended: "info" });
    await testDb`update tenants set status = 'trial' where id = ${t.NoOwner!.id}`;
  });

  it("BD13 a removed (soft-deleted) membership is not listed and not counted", async () => {
    const [m] = await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${t.Other!.id} and user_id = ${u.strangerSignedIn!.id}`;
    const before = await detailOf(t.Other!.id);
    expect(before.members.map((x: { membershipId: string }) => x.membershipId)).toContain(m!.id);
    await testDb`update tenant_memberships set deleted_at = now() where id = ${m!.id}`;
    const after = await detailOf(t.Other!.id);
    expect(after.members.map((x: { membershipId: string }) => x.membershipId)).not.toContain(m!.id);
    expect(after.usage.members).toBe(before.usage.members - 1);
  });

  it("BD14 paging bounds: a negative offset is the first page, a zero or missing limit is clamped, nothing errors", async () => {
    const first = slugs(await asAdmin((sql) => listAll(sql, { search: "s1b-", limit: 3, offset: 0 })));
    expect(slugs(await asAdmin((sql) => listAll(sql, { search: "s1b-", limit: 3, offset: -5 })))).toEqual(first);
    expect(await asAdmin((sql) => listAll(sql, { search: "s1b-", limit: 0 }))).toHaveLength(1);
    const rows = await asAdmin((sql) => sql<Record<string, unknown>[]>`select * from public.admin_list_tenants(null, null, null, null, null)`);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThanOrEqual(25);
  });

  it("BD15 a configured salon with public booking switched off carries the information signal 'booking_off' and nothing worse", async () => {
    const d = await detailOf(t.Quiet!.id);
    expect(Object.fromEntries(d.system.health.map((h: { code: string; severity: string }) => [h.code, h.severity]))).toMatchObject({ booking_off: "info", no_recent_activity: "warning" });
  });

  it("BD16 the Owner search covers every Owner of a salon, not just the first", async () => {
    const [second] = await testDb<{ id: string; email: string }[]>`select u.id, u.email from auth.users u where u.id = (select user_id from tenant_memberships where tenant_id = ${t.Other!.id} and user_id <> ${u.ownerOther!.id} and role_id = ${t.Other!.ownerRoleId} limit 1)`;
    expect(second).toBeTruthy();
    expect(slugs(await asAdmin((sql) => listAll(sql, { search: second!.email })))).toEqual(["s1b-other"]);
  });
});

describe("MU mutation-driven: facts the first mutation run showed were not pinned down", () => {
  const detailOf = async (tenantId: string): Promise<Loose> => {
    const [{ d }] = await asAdmin((sql) => sql<{ d: Loose }[]>`select public.admin_tenant_detail(${tenantId}) as d`);
    return d;
  };
  const dashboard = async (): Promise<Loose> => {
    const [{ s }] = await asAdmin((sql) => sql<{ s: Loose }[]>`select public.admin_dashboard_summary() as s`);
    return s;
  };
  const codes = (d: Loose): string[] => d.system.health.map((h: { code: string }) => h.code);
  let own: TestTenant;
  let ownerA: TestUser;
  let ownerB: TestUser;

  it("MU1 the audit history limit is clamped on both sides (default 50, at most 200, at least 1)", async () => {
    await testDb`
      insert into audit_logs (tenant_id, actor_type, action, entity_type, created_at)
      select ${t.Other!.id}, 'system', 'mu.event', 'mu', now() - (g || ' seconds')::interval from generate_series(1, 260) g`;
    const n = async (limit: number | null) => (await asAdmin((sql) => sql<Record<string, unknown>[]>`select * from public.admin_tenant_audit(${t.Other!.id}, ${limit})`)).length;
    expect(await n(100000)).toBe(200);
    expect(await n(0)).toBe(1);
    expect(await n(-5)).toBe(1);
    expect(await n(null)).toBe(50);
    expect(await n(7)).toBe(7);
  });

  it("MU2 Owners: only live Owner memberships count; the primary Owner is the first one; sign-in state is read over ACTIVE Owners", async () => {
    ownerA = await newUser("muOwnerA");
    ownerB = await newUser("muOwnerB");
    own = await createTestTenant("s1b-owners", ownerA.id);
    tenantIds.push(own.id);
    const bMembership = await addMembership(own.id, ownerB.id, own.ownerRoleId);
    let d = await detailOf(own.id);
    expect(d.owners).toHaveLength(2);
    expect(d.owners[0].email).toBe(ownerA.email.toLowerCase());
    const row = (await asAdmin((sql) => listAll(sql, { search: "s1b-owners" })))[0]!;
    expect(row.owner_count).toBe(2);
    expect(row.primary_owner_email).toBe(ownerA.email.toLowerCase()); // never "the last Owner"

    // never signed in is true only when EVERY active Owner never signed in
    await testDb`update auth.users set last_sign_in_at = null where id = ${ownerA.id}`;
    await testDb`update auth.users set last_sign_in_at = now() where id = ${ownerB.id}`;
    expect((await detailOf(own.id)).system.ownersNeverSignedIn).toBe(false);
    await testDb`update auth.users set last_sign_in_at = null where id = ${ownerB.id}`;
    expect((await detailOf(own.id)).system.ownersNeverSignedIn).toBe(true);
    // a SUSPENDED Owner's sign-in says nothing about the active one
    await testDb`update auth.users set last_sign_in_at = now() where id = ${ownerB.id}`;
    await testDb`update tenant_memberships set status = 'suspended' where id = ${bMembership}`;
    expect((await detailOf(own.id)).system.ownersNeverSignedIn).toBe(true);

    // a removed Owner membership is neither listed nor counted
    await testDb`update tenant_memberships set status = 'active', deleted_at = now() where id = ${bMembership}`;
    d = await detailOf(own.id);
    expect(d.owners).toHaveLength(1);
    expect((await asAdmin((sql) => listAll(sql, { search: "s1b-owners" })))[0]!.owner_count).toBe(1);
    expect(d.usage.members).toBe(1);
  });

  it("MU3 an invited (not yet accepted) membership is neither a member nor an Owner", async () => {
    const invitee = await newUser("muInvitee");
    await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status) values (${own.id}, ${invitee.id}, ${await templateRole(own.id, "STYLIST")}, 'invited')`;
    const d = await detailOf(own.id);
    expect(d.usage.members).toBe(1);
    expect(d.members.map((m: { email: string }) => m.email)).not.toContain(invitee.email.toLowerCase());
  });

  it("MU4 an Owner linked to a soft-deleted staff row is no longer 'staff linked'", async () => {
    const membershipA = await membershipOf(own.id, ownerA.id);
    const staff = await createStaffMember(own.id, "Eski Calisan");
    await testDb`update staff_members set tenant_membership_id = ${membershipA} where id = ${staff.id}`;
    expect((await detailOf(own.id)).owners[0].staffLinked).toBe(true);
    await testDb`update staff_members set deleted_at = now() where id = ${staff.id}`;
    expect((await detailOf(own.id)).owners[0].staffLinked).toBe(false);
  });

  it("MU5 an Owner role that was removed no longer makes anybody an Owner", async () => {
    const holder = await newUser("muRoleHolder");
    const [role] = await testDb<{ id: string }[]>`insert into roles (tenant_id, key, name) values (${own.id}, 'MU_OWNER_LIKE', 'Eski Sahip Rolu') returning id`;
    await testDb`insert into role_permissions (role_id, permission_id) select ${role!.id}, permission_id from role_permissions where role_id = ${own.ownerRoleId}`;
    await addMembership(own.id, holder.id, role!.id);
    expect((await detailOf(own.id)).owners).toHaveLength(2);
    await testDb`update roles set deleted_at = now() where id = ${role!.id}`;
    expect((await detailOf(own.id)).owners).toHaveLength(1);
  });

  it("MU6 setup counts hours and the staff-service mapping, and ALL canonical steps must be done", async () => {
    const owner1 = await newUser("muNoHours");
    const noHours = await buildSalon({ slug: "s1b-nohours", owner: owner1, staffNames: ["Usta"], hours: false, booking: false, phone: true, directServices: 1 });
    const d1 = await detailOf(noHours.id);
    expect(d1.overview.lifecycle).toBe("setup");
    expect(d1.overview.setupComplete).toBe(false);

    const owner2 = await newUser("muNoMapping");
    const noMap = await buildSalon({ slug: "s1b-nomapping", owner: owner2, staffNames: ["Usta"], hours: true, booking: false, phone: true, directServices: 1 });
    expect((await detailOf(noMap.id)).overview.lifecycle).toBe("active");
    await testDb`delete from staff_services where staff_member_id in (select id from staff_members where tenant_id = ${noMap.id})`;
    const d2 = await detailOf(noMap.id);
    expect(d2.overview.lifecycle).toBe("setup");
    expect(d2.overview.setupComplete).toBe(false);
  });

  it("MU7 'today' follows the salon's calendar even when the database session runs on UTC", async () => {
    const owner = await newUser("muTz");
    const salon = await buildSalon({ slug: "s1b-tzmu", owner, staffNames: ["Usta"], hours: true, booking: false, phone: true, directServices: 1, customers: 1 });
    await testDb`update tenants set timezone = 'Pacific/Kiritimati' where id = ${salon.id}`;
    const [branch] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${salon.id} limit 1`;
    const [staff] = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${salon.id} limit 1`;
    const [service] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${salon.id} limit 1`;
    const [customer] = await testDb<{ id: string }[]>`select id from customers where tenant_id = ${salon.id} limit 1`;
    // an instant inside the salon's local day that falls on the OTHER side of the UTC midnight than "now": a UTC-day comparison would miss it
    const [{ y }] = await testDb<{ y: Date }[]>`
      with b as (
        select (date_trunc('day', now() at time zone 'Pacific/Kiritimati')) at time zone 'Pacific/Kiritimati' as l0
      ), c as (
        select l0, l0 + interval '24 hours' as l1, (date_trunc('day', l0 at time zone 'UTC') + interval '1 day') at time zone 'UTC' as m from b
      )
      select case when now() < m then m + (l1 - m) / 2 else l0 + (m - l0) / 2 end as y from c`;
    await addAppointment(salon.id, branch!.id, customer!.id, staff!.id, service!.id, `'${y.toISOString()}'::timestamptz`, "scheduled");
    const [{ d }] = await asAdmin(async (sql) => {
      await sql`set local timezone = 'UTC'`;
      return sql<{ d: Loose }[]>`select public.admin_tenant_detail(${salon.id}) as d`;
    });
    expect(d.usage.appointmentsToday).toBe(1);
  });

  it("MU8 the weekly number ignores cancelled and no-show appointments, the total does not", async () => {
    const owner = await newUser("muWeek");
    const salon = await buildSalon({ slug: "s1b-week", owner, staffNames: ["Usta"], hours: true, booking: false, phone: true, directServices: 1, customers: 1 });
    const [branch] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${salon.id} limit 1`;
    const [staff] = await testDb<{ id: string }[]>`select id from staff_members where tenant_id = ${salon.id} limit 1`;
    const [service] = await testDb<{ id: string }[]>`select id from services where tenant_id = ${salon.id} limit 1`;
    const [customer] = await testDb<{ id: string }[]>`select id from customers where tenant_id = ${salon.id} limit 1`;
    await addAppointment(salon.id, branch!.id, customer!.id, staff!.id, service!.id, "now() - interval '2 days'", "completed");
    await addAppointment(salon.id, branch!.id, customer!.id, staff!.id, service!.id, "now() - interval '2 days 2 hours'", "cancelled");
    await addAppointment(salon.id, branch!.id, customer!.id, staff!.id, service!.id, "now() - interval '1 day'", "no_show");
    const d = await detailOf(salon.id);
    expect(d.usage.appointments).toBe(3);
    expect(d.usage.appointments7d).toBe(1);
  });

  it("MU9 pending invitations: the OLDEST one is reported, and it is only a warning after a week", async () => {
    const roleId = await templateRole(own.id, "RECEPTIONIST");
    const insert = (email: string, createdDaysAgo: number) => testDb`
      insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, created_at, expires_at)
      values (${own.id}, ${email}, ${roleId}, ${ownerA.id}, 'pending', ${email.padEnd(64, "e")}, now() - (${createdDaysAgo} || ' days')::interval, now() + interval '20 days')`;
    await insert("yeni@example.test", 1);
    let d = await detailOf(own.id);
    expect(codes(d)).not.toContain("invite_pending");
    await insert("eski@example.test", 9);
    d = await detailOf(own.id);
    expect(codes(d)).toContain("invite_pending");
    const age = Date.now() - new Date(d.system.oldestPendingInvitationAt).getTime();
    expect(Math.abs(age - 9 * 86400000)).toBeLessThan(2 * 3600000); // a DST change inside nine days may shift the interval by an hour
  });

  it("MU10 last activity is the LATEST event, however old the first one is", async () => {
    await testDb`insert into audit_logs (tenant_id, actor_type, action, entity_type, created_at) values (${t.Stalled!.id}, 'system', 'mu.old', 'mu', now() - interval '100 days'), (${t.Stalled!.id}, 'system', 'mu.recent', 'mu', now() - interval '1 hour')`;
    const d = await detailOf(t.Stalled!.id);
    const age = Date.now() - new Date(d.system.lastActivityAt).getTime();
    expect(Math.abs(age - 3600000)).toBeLessThan(600000);
  });

  it("MU11 'new salon' belongs to new salons only, 'setup stalled' to old ones only, and a trial ending is only said of TRIAL salons", async () => {
    expect(codes(await detailOf(t.New!.id))).toEqual(expect.arrayContaining(["new_salon"]));
    expect(codes(await detailOf(t.New!.id))).not.toContain("setup_stalled");
    expect(codes(await detailOf(t.Stalled!.id))).toContain("setup_stalled");
    expect(codes(await detailOf(t.Stalled!.id))).not.toContain("new_salon");
    await testDb`update tenants set status = 'active', trial_ends_at = now() + interval '3 days' where id = ${t.Other!.id}`;
    expect(codes(await detailOf(t.Other!.id))).not.toContain("trial_ending");
    await testDb`update tenants set status = 'trial', trial_ends_at = null where id = ${t.Other!.id}`;
  });

  it("MU12 the detail says what is true: ready only when booking could work, the real health level", async () => {
    expect((await detailOf(t.G!.id)).overview.readyForBooking).toBe(true);
    expect((await detailOf(t.New!.id)).overview.readyForBooking).toBe(false);
    expect((await detailOf(t.Broken!.id)).system.healthLevel).toBe("critical");
    expect((await detailOf(t.Broken!.id)).overview.readyForBooking).toBe(false);
  });

  it("MU13 paging and filters: the page size is capped at 100, 'active' means active, 'quiet' leaves suspended salons alone", async () => {
    const big = await asAdmin((sql) => listAll(sql, { search: "s1b-scale-", limit: 100000 }));
    expect(big).toHaveLength(100);
    expect(Number(big[0]!.total_count)).toBe(250);

    const active = slugs(await asAdmin((sql) => listAll(sql, { search: "s1b-", filter: "active" })));
    expect(active).toContain("s1b-gokhanlike");
    expect(active).not.toContain("s1b-quiet");
    expect(active).not.toContain("s1b-suspended");
    expect(active).not.toContain("s1b-brandnew");

    await testDb`update tenants set created_at = now() - interval '40 days' where id = ${t.Suspended!.id}`;
    const quiet = slugs(await asAdmin((sql) => listAll(sql, { search: "s1b-", filter: "quiet" })));
    expect(quiet).toContain("s1b-quiet");
    expect(quiet).not.toContain("s1b-suspended");
    await testDb`update tenants set created_at = now() where id = ${t.Suspended!.id}`;
  });

  it("MU14 sort by last activity: the most recently active salon is first", async () => {
    const rows = await asAdmin((sql) => listAll(sql, { search: "s1b-", sort: "activity_desc" }));
    const at = (r: Record<string, unknown>) => new Date(String(r.last_activity_at ?? r.created_at)).getTime();
    const times = rows.map(at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("MU15 dashboard numbers equal independent counts: canceled apart from suspended, booking active only for live salons, users and Owners are live active memberships of live salons", async () => {
    // canceled is its own bucket
    await testDb`update tenants set status = 'canceled' where id = ${t.Suspended!.id}`;
    // public booking switched on for a salon that is not live must not count as "booking active"
    await enableOnlineBooking(t.Suspended!.id);
    // people who must NOT be counted: a suspended Owner, a removed member, a member of a deleted salon
    const suspendedOwner = await newUser("muSuspOwner");
    await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status) values (${own.id}, ${suspendedOwner.id}, ${own.ownerRoleId}, 'suspended')`;
    const removed = await newUser("muRemoved");
    await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status, deleted_at) values (${t.Other!.id}, ${removed.id}, ${await templateRole(t.Other!.id, "STYLIST")}, 'active', now())`;
    const ghostOwner = await newUser("muGhost");
    const ghost = await createTestTenant("s1b-deleted", ghostOwner.id);
    tenantIds.push(ghost.id);
    await testDb`update tenants set deleted_at = now() where id = ${ghost.id}`;

    const s = await dashboard();
    const dead = await asAdmin((sql) => listAll(sql, { filter: "suspended", limit: 100 })); // suspended + canceled salons (fewer than 100)
    const bookingOn = await asAdmin((sql) => listAll(sql, { filter: "booking_on", limit: 100 }));
    expect(s.lifecycle.canceled).toBe(dead.filter((r) => r.lifecycle === "canceled").length);
    expect(s.lifecycle.canceled).toBeGreaterThanOrEqual(1);
    expect(s.lifecycle.suspended).toBe(dead.filter((r) => r.lifecycle === "suspended").length);
    expect(s.bookingActive).toBe(bookingOn.filter((r) => ["trial", "active"].includes(String(r.account_status))).length);

    const [people] = await testDb<{ users: number; owners: number }[]>`
      select count(distinct tm.user_id) filter (where true)::int as users,
             count(distinct tm.user_id) filter (where exists (
               select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
               where rp.role_id = tm.role_id and p.key = 'permissions.manage_unrestricted'
                 and exists (select 1 from roles r where r.id = tm.role_id and r.deleted_at is null)))::int as owners
      from tenant_memberships tm join tenants x on x.id = tm.tenant_id and x.deleted_at is null
      where tm.deleted_at is null and tm.status = 'active'`;
    expect(s.usersTotal).toBe(people!.users);
    expect(s.ownersTotal).toBe(people!.owners);

    await testDb`update tenant_features set enabled = false where tenant_id = ${t.Suspended!.id}`;
    await testDb`update tenants set status = 'suspended' where id = ${t.Suspended!.id}`;
  });

  it("MU16 dashboard lists: 'needs attention' holds only critical and warning salons, worst first; 'recently created' is newest first", async () => {
    // set the 250 scale salons aside (they are all 'nobody manages this') so the list is not full of them
    await testDb`update tenants set deleted_at = now() where slug like 's1b-scale-%'`;
    const s = await dashboard();
    const flagged = await asAdmin((sql) => listAll(sql, { filter: "attention", limit: 100 }));
    await testDb`update tenants set deleted_at = null where slug like 's1b-scale-%'`;
    expect(flagged.length).toBeLessThan(10);
    expect(s.needsAttention).toHaveLength(flagged.length);
    for (const x of s.needsAttention) expect(["critical", "warning"]).toContain(x.healthLevel);
    const levels = s.needsAttention.map((x: { healthLevel: string }) => (x.healthLevel === "critical" ? 0 : 1));
    expect(levels).toEqual([...levels].sort((a: number, b: number) => a - b));
    const created = s.recentlyCreated.map((x: { createdAt: string }) => new Date(x.createdAt).getTime());
    expect(created).toEqual([...created].sort((a: number, b: number) => b - a));
    const all = await asAdmin((sql) => listAll(sql, { limit: 100, sort: "created_desc" }));
    expect(s.recentlyCreated[0].slug).toBe(String(all[0]!.slug));
    // within the same severity the NEWEST salon comes first
    const warn = s.needsAttention.filter((x: { healthLevel: string }) => x.healthLevel === "warning").map((x: { slug: string }) => x.slug);
    const warnAll = flagged.filter((r) => r.health_level === "warning").map((r) => String(r.slug)); // the list is newest first
    expect(warn).toEqual(warnAll);
  });
});
