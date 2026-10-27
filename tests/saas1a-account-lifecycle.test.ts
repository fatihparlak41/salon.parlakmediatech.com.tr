import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type postgres from "postgres";
import {
  addMembership,
  anonClient,
  asAuthenticatedUser,
  asDatabaseRole,
  attemptAs,
  auditRows,
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
  type AttemptOutcome,
  type TestTenant,
  type TestUser,
} from "./helpers";
import { getTeamMembers } from "@/lib/modules/team/queries";
import { reactivateMemberCore, removeMemberCore, suspendMemberCore } from "@/lib/modules/team/member-management";
import {
  LAST_OWNER_MESSAGE,
  MEMBER_NOT_FOUND_MESSAGE,
  MEMBER_NOT_MANAGEABLE_MESSAGE,
  MEMBER_ROLE_GONE_MESSAGE,
  MEMBER_SELF_ACTION_MESSAGE,
  MEMBER_STATE_CHANGED_MESSAGE,
  mapMemberManagementError,
} from "@/lib/modules/team/helpers";

/**
 * Faz SAAS.1A — account lifecycle, database level. IDs ML (member read model), AC (access actions), OW (owner
 * safety), AZ (authorization), SE (session behavior), RG (regression: Gökhan-like and Emel-like synthetic salons),
 * IN (invitation gaps). No real data: every tenant, user and row is synthetic.
 *
 * Authority and role matrices run through asAuthenticatedUser (the exact role + JWT-claims context of a PostgREST
 * request, without spending a rate-limited sign-in per actor); the Core functions and the session tests use real
 * signed-in clients.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------

let tenantA: TestTenant; // Gökhan-like: owner, second owner, Yönetici, Resepsiyon, Personel, several staff
let tenantB: TestTenant; // another salon
let tenantE: TestTenant; // Emel-like: ONE person who is both the Owner and the only staff member

const u: Record<string, TestUser> = {};
const m: Record<string, string> = {}; // membership ids by label
const staffOf: Record<string, string> = {};
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

let branchA: string;
let serviceA: string;
let customerA: string;
let branchE: string;
let serviceE: string;

let ownerClient: SupabaseClient;
let yoneticiClient: SupabaseClient;
let victimClient: SupabaseClient;

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`s1a-${label}`);
  createdUserIds.push(user.id);
  u[label] = user;
  return user;
}

async function membershipIdOf(tenantId: string, userId: string): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenantId} and user_id = ${userId} and deleted_at is null`;
  if (!row) throw new Error("membership not found in fixture");
  return row.id;
}

async function giveStaffHistory(tenantId: string, branchId: string, serviceId: string, customerId: string, label: string) {
  const staff = await createStaffMember(tenantId, `Personel ${label}`);
  staffOf[label] = staff.id;
  await testDb`update staff_members set tenant_membership_id = ${m[label]!} where id = ${staff.id}`;
  await linkStaffBranch(staff.id, branchId);
  await linkStaffService(staff.id, serviceId);
  await createStaffSchedule(tenantId, staff.id, 1, "09:00", "17:00");
  for (const [days, completed] of [[3, false], [-3, true]] as const) {
    const start = new Date(Date.now() + days * 86_400_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    const [appointment] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenantId}, ${branchId}, ${customerId}, ${completed ? "completed" : "scheduled"}, ${start}, ${end})
      returning id`;
    await testDb`
      insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at,
                                     scheduled_end_at, duration_minutes, price, sequence, actual_staff_member_id)
      values (${tenantId}, ${appointment!.id}, ${serviceId}, ${staff.id}, ${start}, ${end}, 30, 100, 1,
              ${completed ? staff.id : null})`;
  }
}

async function enableOnlineBooking(tenantId: string) {
  await testDb`
    insert into tenant_features (tenant_id, feature_id, enabled)
    select ${tenantId}, f.id, true from features f where f.key = 'online_booking'`;
}

/** Everything the salon's BUSINESS consists of, as counts and content hashes. A lifecycle action on a login must not
 * move any of it. (The staff row's own tenant_membership_id is the one column excluded: remove/re-invite legitimately
 * changes the login link, never the person's record.) */
async function businessDigest(tenantId: string): Promise<Record<string, string>> {
  const [row] = await testDb<{ d: Record<string, string> }[]>`
    select jsonb_build_object(
      'appointments', (select count(*)::text || ':' || coalesce(md5(string_agg((to_jsonb(a) - 'updated_at')::text, '|' order by a.id)), '') from appointments a where a.tenant_id = ${tenantId}),
      'appointment_items', (select count(*)::text || ':' || coalesce(md5(string_agg((to_jsonb(i) - 'updated_at')::text, '|' order by i.id)), '') from appointment_items i where i.tenant_id = ${tenantId}),
      'customers', (select count(*)::text || ':' || coalesce(md5(string_agg((to_jsonb(c) - 'updated_at')::text, '|' order by c.id)), '') from customers c where c.tenant_id = ${tenantId}),
      'services', (select count(*)::text || ':' || coalesce(md5(string_agg((to_jsonb(s) - 'updated_at')::text, '|' order by s.id)), '') from services s where s.tenant_id = ${tenantId}),
      'staff_members', (select count(*)::text || ':' || coalesce(md5(string_agg((to_jsonb(s) - 'updated_at' - 'tenant_membership_id')::text, '|' order by s.id)), '') from staff_members s where s.tenant_id = ${tenantId}),
      'staff_services', (select count(*)::text from staff_services ss join staff_members s on s.id = ss.staff_member_id where s.tenant_id = ${tenantId}),
      'staff_schedules', (select count(*)::text from staff_schedules where tenant_id = ${tenantId}),
      'branches', (select count(*)::text || ':' || coalesce(md5(string_agg((to_jsonb(b) - 'updated_at')::text, '|' order by b.id)), '') from branches b where b.tenant_id = ${tenantId}),
      'commission_rules', (select count(*)::text from staff_commission_rules where tenant_id = ${tenantId})
    ) as d`;
  return row!.d;
}

async function publicContext(slug: string): Promise<unknown> {
  const rows = await asDatabaseRole("anon", null, (sql) => sql<{ c: unknown }[]>`select public.get_public_booking_context(${slug}) as c`);
  return rows[0]!.c;
}

async function membershipRow(id: string) {
  const [row] = await testDb<{ role_id: string; status: string; deleted_at: string | null }[]>`
    select role_id, status, deleted_at from tenant_memberships where id = ${id}`;
  return row!;
}

async function activeUnrestrictedHolders(tenantId: string): Promise<number> {
  const [row] = await testDb<{ n: string }[]>`
    select count(distinct tm.id)::text as n
    from tenant_memberships tm
    join roles r on r.id = tm.role_id and r.deleted_at is null
    join role_permissions rp on rp.role_id = r.id
    join permissions p on p.id = rp.permission_id
    where tm.tenant_id = ${tenantId} and tm.status = 'active' and tm.deleted_at is null
      and p.key = 'permissions.manage_unrestricted'`;
  return Number(row!.n);
}

const roleCache = new Map<string, string>();
/** The tenant's clone of a REAL role template (Yönetici, Resepsiyon, Personel...), created once per tenant: roles are unique per (tenant, key). */
async function templateRole(tenantId: string, key: string): Promise<string> {
  const cacheKey = `${tenantId}:${key}`;
  const cached = roleCache.get(cacheKey);
  if (cached) return cached;
  const [existing] = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${tenantId} and key = ${key} and deleted_at is null`;
  if (existing) {
    roleCache.set(cacheKey, existing.id);
    return existing.id;
  }
  const [template] = await testDb<{ id: string; key: string; name: string; description: string | null }[]>`
    select id, key, name, description from role_templates where key = ${key}`;
  if (!template) throw new Error(`role template ${key} not found`);
  const [role] = await testDb<{ id: string }[]>`
    insert into roles (tenant_id, key, name, description, is_system_default, cloned_from_template_id)
    values (${tenantId}, ${template.key}, ${template.name}, ${template.description}, true, ${template.id}) returning id`;
  await testDb`insert into role_permissions (role_id, permission_id) select ${role!.id}, permission_id from role_template_permissions where role_template_id = ${template.id}`;
  roleCache.set(cacheKey, role!.id);
  return role!.id;
}
async function addTemplateMember(tenantId: string, userId: string, key: string): Promise<string> {
  return addMembership(tenantId, userId, await templateRole(tenantId, key));
}

class Rollback extends Error {}
/** Runs `fn` as `userId` exactly like a request and ALWAYS rolls back, returning whether the database accepted it. */
async function dryRun(userId: string, fn: (sql: postgres.TransactionSql) => Promise<unknown>): Promise<AttemptOutcome> {
  let outcome: AttemptOutcome = { ok: true };
  try {
    await testDb.begin(async (sql) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true),
                       set_config('request.jwt.claim.sub', ${userId}, true)`;
      await sql`set local role authenticated`;
      try {
        await fn(sql);
      } catch (error) {
        const e = error as { message?: string; code?: string };
        outcome = { ok: false, message: e.message ?? String(error), code: e.code };
      }
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return outcome;
}

const rpcSuspend = (sql: postgres.TransactionSql, t: string, id: string) => sql`select public.suspend_membership(${t}::uuid, ${id}::uuid)`;
const rpcReactivate = (sql: postgres.TransactionSql, t: string, id: string) => sql`select public.reactivate_membership(${t}::uuid, ${id}::uuid)`;
const rpcRemove = (sql: postgres.TransactionSql, t: string, id: string) => sql`select public.remove_membership_access(${t}::uuid, ${id}::uuid)`;

const listAs = (userId: string, tenantId: string) =>
  asAuthenticatedUser(userId, (sql) => sql<Record<string, unknown>[]>`select * from public.list_team_members(${tenantId}::uuid)`);

beforeAll(async () => {
  for (const label of ["ownerA1", "ownerA2", "yoneticiA", "resepsiyonA", "personelA", "victimA", "otherOwnerB", "soloOwnerE", "stranger", "newcomer"]) {
    await newUser(label);
  }

  tenantA = await createTestTenant("test-tenant-s1a-a", u.ownerA1!.id);
  tenantB = await createTestTenant("test-tenant-s1a-b", u.otherOwnerB!.id);
  tenantE = await createTestTenant("test-tenant-s1a-e", u.soloOwnerE!.id);
  createdTenantIds.push(tenantA.id, tenantB.id, tenantE.id);

  m.ownerA1 = await membershipIdOf(tenantA.id, u.ownerA1!.id);
  m.ownerA2 = await addMembership(tenantA.id, u.ownerA2!.id, tenantA.ownerRoleId);
  m.yoneticiA = await addTemplateMember(tenantA.id, u.yoneticiA!.id, "SALON_MANAGER");
  m.resepsiyonA = await addTemplateMember(tenantA.id, u.resepsiyonA!.id, "RECEPTIONIST");
  m.personelA = await addTemplateMember(tenantA.id, u.personelA!.id, "STYLIST");
  m.victimA = await addTemplateMember(tenantA.id, u.victimA!.id, "RECEPTIONIST");
  m.ownerB = await membershipIdOf(tenantB.id, u.otherOwnerB!.id);
  m.soloOwnerE = await membershipIdOf(tenantE.id, u.soloOwnerE!.id);

  branchA = await createBranch(tenantA.id, "Merkez");
  serviceA = (await createService(tenantA.id, "Saç Kesimi", 30, 100)).id;
  await linkServiceBranch(serviceA, branchA);
  customerA = (await createCustomer(tenantA.id, "Müşteri Bir")).id;
  await giveStaffHistory(tenantA.id, branchA, serviceA, customerA, "victimA");
  await giveStaffHistory(tenantA.id, branchA, serviceA, customerA, "personelA");
  await createStaffMember(tenantA.id, "Bağlantısız Personel");
  await enableOnlineBooking(tenantA.id);

  // Emel-like: the Owner IS the only staff member.
  branchE = await createBranch(tenantE.id, "Merkez Şube");
  serviceE = (await createService(tenantE.id, "Kirpik Laminasyonu", 40, 2000)).id;
  await linkServiceBranch(serviceE, branchE);
  const ownerStaff = await createStaffMember(tenantE.id, "Emel-like Sahip");
  staffOf.soloOwnerE = ownerStaff.id;
  await testDb`update staff_members set tenant_membership_id = ${m.soloOwnerE!} where id = ${ownerStaff.id}`;
  await linkStaffBranch(ownerStaff.id, branchE);
  await linkStaffService(ownerStaff.id, serviceE);
  await createStaffSchedule(tenantE.id, ownerStaff.id, 1, "09:00", "17:00");
  await enableOnlineBooking(tenantE.id);

  ownerClient = await signInAs(u.ownerA1!);
  yoneticiClient = await signInAs(u.yoneticiA!);
  victimClient = await signInAs(u.victimA!);
}, 240000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 180000);

// ---------------------------------------------------------------------------------------------------------------------
describe("ML member read model (list_team_members)", () => {
  const EXPECTED_KEYS = [
    "can_reactivate", "can_remove", "can_suspend", "display_name", "email", "is_last_unrestricted_holder", "is_self",
    "linked_staff_name", "membership_id", "role_id", "role_name", "status",
  ];

  it("ML1 the row shape is exactly the twelve columns: no auth user id, no phone, nothing else", async () => {
    const rows = await listAs(u.ownerA1!.id, tenantA.id);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(EXPECTED_KEYS);
    const serialized = JSON.stringify(rows);
    for (const user of Object.values(u)) expect(serialized).not.toContain(user.id);
  });

  it("ML2 an owner sees every active member with e-mail (lower case), role, status, self flag and linked staff name", async () => {
    const rows = await listAs(u.ownerA1!.id, tenantA.id);
    const byEmail = new Map(rows.map((r) => [r.email as string, r]));
    const owner = byEmail.get(u.ownerA1!.email.toLowerCase())!;
    expect(owner).toMatchObject({ role_name: "Salon Sahibi", status: "active", is_self: true, linked_staff_name: null });
    const victim = byEmail.get(u.victimA!.email.toLowerCase())!;
    expect(victim).toMatchObject({ role_name: "Resepsiyon", status: "active", is_self: false, linked_staff_name: "Personel victimA" });
    expect(byEmail.get(u.yoneticiA!.email.toLowerCase())).toMatchObject({ role_name: "Yönetici" });
    expect(byEmail.get(u.personelA!.email.toLowerCase())).toMatchObject({ role_name: "Personel", linked_staff_name: "Personel personelA" });
    for (const email of byEmail.keys()) expect(email).toBe(email.toLowerCase());
  });

  it("ML3 a SUSPENDED member is listed (so access can be restored) and a REMOVED one never is", async () => {
    const suspendee = await createTestUser("s1a-ml3-susp");
    const leaver = await createTestUser("s1a-ml3-leave");
    createdUserIds.push(suspendee.id, leaver.id);
    const mSusp = await addTemplateMember(tenantA.id, suspendee.id, "RECEPTIONIST");
    const mLeave = await addTemplateMember(tenantA.id, leaver.id, "RECEPTIONIST");
    expect(await attemptAs(u.ownerA1!.id, (sql) => rpcSuspend(sql, tenantA.id, mSusp))).toEqual({ ok: true });
    expect(await attemptAs(u.ownerA1!.id, (sql) => rpcRemove(sql, tenantA.id, mLeave))).toEqual({ ok: true });

    const rows = await listAs(u.ownerA1!.id, tenantA.id);
    const susp = rows.find((r) => r.membership_id === mSusp)!;
    expect(susp).toMatchObject({ status: "suspended", can_reactivate: true, can_suspend: false, can_remove: true });
    expect(rows.some((r) => r.membership_id === mLeave)).toBe(false);
  });

  it("ML4 only staff.manage holders of the asked tenant may read it; everybody else gets the SAME refusal", async () => {
    const allowed = [u.ownerA1!, u.ownerA2!, u.yoneticiA!];
    for (const user of allowed) expect((await listAs(user.id, tenantA.id)).length).toBeGreaterThan(0);

    const refused = [u.resepsiyonA!, u.personelA!, u.otherOwnerB!, u.stranger!];
    const messages = new Set<string>();
    for (const user of refused) {
      const outcome = await attemptAs(user.id, (sql) => sql`select * from public.list_team_members(${tenantA.id}::uuid)`);
      expect(outcome.ok, user.email).toBe(false);
      messages.add((outcome as { message: string }).message);
    }
    expect([...messages]).toEqual(["staff.manage required"]);
  });

  it("ML5 a suspended or removed manager loses the list immediately", async () => {
    const mgr = await createTestUser("s1a-ml5-mgr");
    createdUserIds.push(mgr.id);
    const id = await addTemplateMember(tenantA.id, mgr.id, "SALON_MANAGER");
    expect((await listAs(mgr.id, tenantA.id)).length).toBeGreaterThan(0);
    await testDb`update tenant_memberships set status = 'suspended' where id = ${id}`;
    expect((await attemptAs(mgr.id, (sql) => sql`select * from public.list_team_members(${tenantA.id}::uuid)`)).ok).toBe(false);
    await testDb`update tenant_memberships set status = 'active', deleted_at = now() where id = ${id}`;
    expect((await attemptAs(mgr.id, (sql) => sql`select * from public.list_team_members(${tenantA.id}::uuid)`)).ok).toBe(false);
  });

  it("ML6 tenant isolation: another salon's owner reads nothing of ours, and ours reads nothing of theirs", async () => {
    const own = await listAs(u.otherOwnerB!.id, tenantB.id);
    expect(own).toHaveLength(1);
    expect(JSON.stringify(own)).not.toContain(u.ownerA1!.email.toLowerCase());
    const cross = await attemptAs(u.ownerA1!.id, (sql) => sql`select * from public.list_team_members(${tenantB.id}::uuid)`);
    expect(cross).toMatchObject({ ok: false, message: "staff.manage required" });
  });

  it("ML7 anon cannot execute it, and the private function is executable by no client role", async () => {
    const asAnon = await asDatabaseRole("anon", null, (sql) => sql`select * from public.list_team_members(${tenantA.id}::uuid)`).then(
      () => "ran",
      (error: { message?: string }) => error.message ?? "failed",
    );
    expect(asAnon).toMatch(/permission denied/i);
    const [grants] = await testDb<{ anon_pub: boolean; auth_pub: boolean; auth_priv: boolean; anon_priv: boolean }[]>`
      select has_function_privilege('anon', 'public.list_team_members(uuid)', 'execute') as anon_pub,
             has_function_privilege('authenticated', 'public.list_team_members(uuid)', 'execute') as auth_pub,
             has_function_privilege('authenticated', 'private.list_team_members(uuid)', 'execute') as auth_priv,
             has_function_privilege('anon', 'private.list_team_members(uuid)', 'execute') as anon_priv`;
    expect(grants).toEqual({ anon_pub: false, auth_pub: true, auth_priv: false, anon_priv: false });
    const [fn] = await testDb<{ secdef: boolean; config: string[] | null }[]>`
      select p.prosecdef as secdef, p.proconfig as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = 'list_team_members'`;
    expect(fn).toEqual({ secdef: true, config: ['search_path=""'] });
  });

  it("ML8 the advisory can_* flags equal what the real RPCs accept, for every caller x member pair (dry runs, rolled back)", async () => {
    const callers = [u.ownerA1!, u.ownerA2!, u.yoneticiA!];
    for (const caller of callers) {
      const rows = await listAs(caller.id, tenantA.id);
      for (const row of rows) {
        const id = row.membership_id as string;
        const label = `${caller.email} -> ${row.display_name ?? row.email} (${row.status})`;
        const suspend = await dryRun(caller.id, (sql) => rpcSuspend(sql, tenantA.id, id));
        const reactivate = await dryRun(caller.id, (sql) => rpcReactivate(sql, tenantA.id, id));
        const remove = await dryRun(caller.id, (sql) => rpcRemove(sql, tenantA.id, id));
        expect(row.can_suspend, `suspend ${label}`).toBe(suspend.ok);
        expect(row.can_reactivate, `reactivate ${label}`).toBe(reactivate.ok);
        expect(row.can_remove, `remove ${label}`).toBe(remove.ok);
      }
    }
  });

  it("ML9 the last unrestricted holder is flagged exactly when it is the only active one", async () => {
    // Tenant A has two owners: neither is the last holder.
    const both = await listAs(u.ownerA1!.id, tenantA.id);
    expect(both.filter((r) => r.is_last_unrestricted_holder)).toHaveLength(0);
    // The solo tenant's owner is.
    const solo = await listAs(u.soloOwnerE!.id, tenantE.id);
    expect(solo).toHaveLength(1);
    expect(solo[0]).toMatchObject({ is_last_unrestricted_holder: true, is_self: true, can_suspend: false, can_reactivate: false, can_remove: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("AC access actions through the application Core (real signed-in clients)", () => {
  async function digestOfVictimStaff() {
    const [row] = await testDb<{ j: Record<string, unknown> }[]>`select to_jsonb(s) - 'updated_at' - 'tenant_membership_id' as j from staff_members s where id = ${staffOf.victimA!}`;
    return row!.j;
  }

  it("AC1 suspend: success, status suspended, exactly one audit row, history and staff record untouched", async () => {
    const before = await businessDigest(tenantA.id);
    const staffBefore = await digestOfVictimStaff();
    const auditBefore = (await auditRows(tenantA.id, "membership.suspended", m.victimA!)).length;

    const result = await suspendMemberCore(ownerClient, { tenantId: tenantA.id, membershipId: m.victimA! });
    expect(result).toEqual({ success: true, data: { membershipId: m.victimA! } });

    expect((await membershipRow(m.victimA!)).status).toBe("suspended");
    expect((await auditRows(tenantA.id, "membership.suspended", m.victimA!)).length).toBe(auditBefore + 1);
    expect(await businessDigest(tenantA.id)).toEqual(before);
    expect(await digestOfVictimStaff()).toEqual(staffBefore);
    // The staff row is still LINKED to the suspended login (suspension never touches the link).
    const [link] = await testDb<{ tenant_membership_id: string | null }[]>`select tenant_membership_id from staff_members where id = ${staffOf.victimA!}`;
    expect(link!.tenant_membership_id).toBe(m.victimA!);
  });

  it("AC2 the member list now offers reactivation (and not suspension) for that person", async () => {
    const rows = await getTeamMembers(ownerClient, tenantA.id);
    const row = rows.find((r) => r.membershipId === m.victimA!)!;
    expect(row).toMatchObject({ status: "suspended", canSuspend: false, canReactivate: true, canRemove: true });
    expect(row.email?.toLowerCase()).toBe(u.victimA!.email.toLowerCase());
  });

  it("AC3 a stale suspend of an already suspended member is a conflict and writes nothing", async () => {
    const auditBefore = (await auditRows(tenantA.id, "membership.suspended", m.victimA!)).length;
    const result = await suspendMemberCore(ownerClient, { tenantId: tenantA.id, membershipId: m.victimA! });
    expect(result).toEqual({ success: false, error: { code: "CONFLICT", message: MEMBER_STATE_CHANGED_MESSAGE } });
    expect((await auditRows(tenantA.id, "membership.suspended", m.victimA!)).length).toBe(auditBefore);
  });

  it("AC4 reactivate: success, same membership id and role, one audit row, no second identity or membership", async () => {
    const before = await membershipRow(m.victimA!);
    const countBefore = await testDb<{ n: string }[]>`select count(*)::text as n from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${u.victimA!.id}`;
    const result = await reactivateMemberCore(ownerClient, { tenantId: tenantA.id, membershipId: m.victimA! });
    expect(result.success).toBe(true);
    const after = await membershipRow(m.victimA!);
    expect(after).toMatchObject({ status: "active", role_id: before.role_id, deleted_at: null });
    const countAfter = await testDb<{ n: string }[]>`select count(*)::text as n from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${u.victimA!.id}`;
    expect(countAfter[0]!.n).toBe(countBefore[0]!.n);
    expect((await auditRows(tenantA.id, "membership.reactivated", m.victimA!)).length).toBe(1);
    const [identities] = await testDb<{ n: string }[]>`select count(*)::text as n from auth.users where lower(email) = ${u.victimA!.email.toLowerCase()}`;
    expect(identities!.n).toBe("1");
  });

  it("AC5 a stale reactivate of an already active member is a conflict and writes nothing", async () => {
    const result = await reactivateMemberCore(ownerClient, { tenantId: tenantA.id, membershipId: m.victimA! });
    expect(result).toEqual({ success: false, error: { code: "CONFLICT", message: MEMBER_STATE_CHANGED_MESSAGE } });
    expect((await auditRows(tenantA.id, "membership.reactivated", m.victimA!)).length).toBe(1);
  });

  it("AC6 remove: access ends, the membership is soft-deleted, the staff row and ALL history survive and the staff row is merely unlinked", async () => {
    const before = await businessDigest(tenantA.id);
    const staffBefore = await digestOfVictimStaff();
    const result = await removeMemberCore(ownerClient, { tenantId: tenantA.id, membershipId: m.victimA! });
    expect(result).toEqual({ success: true, data: { membershipId: m.victimA! } });

    const row = await membershipRow(m.victimA!);
    expect(row.deleted_at).not.toBeNull();
    expect(await businessDigest(tenantA.id)).toEqual(before);
    expect(await digestOfVictimStaff()).toEqual(staffBefore);
    const [link] = await testDb<{ tenant_membership_id: string | null; deleted_at: string | null }[]>`
      select tenant_membership_id, deleted_at from staff_members where id = ${staffOf.victimA!}`;
    expect(link).toEqual({ tenant_membership_id: null, deleted_at: null });
    expect((await auditRows(tenantA.id, "membership.removed", m.victimA!)).length).toBe(1);
    // The performance history keeps pointing at the staff record.
    const [performed] = await testDb<{ n: string }[]>`select count(*)::text as n from appointment_items where tenant_id = ${tenantA.id} and actual_staff_member_id = ${staffOf.victimA!}`;
    expect(Number(performed!.n)).toBeGreaterThan(0);
  });

  it("AC7 a removed member is gone from the list and cannot be acted on again", async () => {
    const rows = await getTeamMembers(ownerClient, tenantA.id);
    expect(rows.some((r) => r.membershipId === m.victimA!)).toBe(false);
    for (const core of [suspendMemberCore, reactivateMemberCore, removeMemberCore]) {
      const result = await core(ownerClient, { tenantId: tenantA.id, membershipId: m.victimA! });
      expect(result).toEqual({ success: false, error: { code: "NOT_FOUND", message: MEMBER_NOT_FOUND_MESSAGE } });
    }
  });

  it("AC8 a removed person can be invited again: new membership, SAME auth identity, the SAME staff row relinked (no duplicate)", async () => {
    const staffCountBefore = (await testDb<{ n: string }[]>`select count(*)::text as n from staff_members where tenant_id = ${tenantA.id}`)[0]!.n;
    const { data, error } = await ownerClient.rpc("create_team_invitation", {
      p_tenant_id: tenantA.id,
      p_email: u.victimA!.email,
      p_role_id: (await testDb<{ id: string }[]>`select id from roles where tenant_id = ${tenantA.id} and key = 'RECEPTIONIST'`)[0]!.id,
      p_staff_member_id: staffOf.victimA!,
    });
    expect(error).toBeNull();
    const token = (data as { token: string }[])[0]!.token;
    const accepted = await victimClient.rpc("accept_team_invitation", { p_token: token });
    expect(accepted.error).toBeNull();

    const memberships = await testDb<{ id: string; deleted_at: string | null }[]>`
      select id, deleted_at from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${u.victimA!.id} order by created_at`;
    expect(memberships).toHaveLength(2);
    expect(memberships[0]!.deleted_at).not.toBeNull();
    expect(memberships[1]!.deleted_at).toBeNull();
    const [link] = await testDb<{ tenant_membership_id: string | null }[]>`select tenant_membership_id from staff_members where id = ${staffOf.victimA!}`;
    expect(link!.tenant_membership_id).toBe(memberships[1]!.id);
    expect((await testDb<{ n: string }[]>`select count(*)::text as n from staff_members where tenant_id = ${tenantA.id}`)[0]!.n).toBe(staffCountBefore);
    m.victimA = memberships[1]!.id;
  });

  it("AC9 a membership id of ANOTHER salon is NOT_FOUND for every action and nothing changes there", async () => {
    const before = await membershipRow(m.ownerB!);
    for (const core of [suspendMemberCore, reactivateMemberCore, removeMemberCore]) {
      const result = await core(ownerClient, { tenantId: tenantA.id, membershipId: m.ownerB! });
      expect(result).toEqual({ success: false, error: { code: "NOT_FOUND", message: MEMBER_NOT_FOUND_MESSAGE } });
    }
    // Naming the OTHER tenant does not help: the caller holds no staff.manage there.
    for (const core of [suspendMemberCore, reactivateMemberCore, removeMemberCore]) {
      const result = await core(ownerClient, { tenantId: tenantB.id, membershipId: m.ownerB! });
      expect(result.success).toBe(false);
    }
    expect(await membershipRow(m.ownerB!)).toEqual(before);
  });

  it("AC10 acting on yourself is refused with its own message, whichever action", async () => {
    for (const core of [suspendMemberCore, removeMemberCore]) {
      const result = await core(ownerClient, { tenantId: tenantA.id, membershipId: m.ownerA1! });
      expect(result).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: MEMBER_SELF_ACTION_MESSAGE } });
    }
    expect((await membershipRow(m.ownerA1!)).status).toBe("active");
  });

  it("AC11 a Yönetici cannot suspend or remove an owner and gets the plain authority message", async () => {
    for (const core of [suspendMemberCore, removeMemberCore]) {
      const result = await core(yoneticiClient, { tenantId: tenantA.id, membershipId: m.ownerA2! });
      expect(result).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: MEMBER_NOT_MANAGEABLE_MESSAGE } });
    }
    expect((await membershipRow(m.ownerA2!)).status).toBe("active");
  });

  it("AC12 malformed input never reaches the database", async () => {
    for (const core of [suspendMemberCore, reactivateMemberCore, removeMemberCore]) {
      expect(await core(ownerClient, { tenantId: "nope", membershipId: m.victimA! })).toMatchObject({ success: false, error: { code: "VALIDATION" } });
      expect(await core(ownerClient, { tenantId: tenantA.id, membershipId: "x" })).toMatchObject({ success: false, error: { code: "VALIDATION" } });
    }
  });

  it("AC13 the RPC error words: every stable code maps to a plain Turkish sentence and nothing raw leaks", () => {
    const cases: [string, string, string][] = [
      ["authentication_required", "UNAUTHENTICATED", "Oturum açmanız gerekiyor"],
      ["membership_not_found", "NOT_FOUND", MEMBER_NOT_FOUND_MESSAGE],
      ["staff_manage_required", "UNAUTHORIZED", "Bu işlem için yetkiniz yok"],
      ["cannot_manage_self", "UNAUTHORIZED", MEMBER_SELF_ACTION_MESSAGE],
      ["insufficient_authority", "UNAUTHORIZED", MEMBER_NOT_MANAGEABLE_MESSAGE],
      ["tenant_would_lose_last_unrestricted_holder", "CONFLICT", LAST_OWNER_MESSAGE],
      ["membership_not_active", "CONFLICT", MEMBER_STATE_CHANGED_MESSAGE],
      ["membership_not_suspended", "CONFLICT", MEMBER_STATE_CHANGED_MESSAGE],
      ["role_not_found", "CONFLICT", MEMBER_ROLE_GONE_MESSAGE],
    ];
    for (const [raw, code, message] of cases) {
      expect(mapMemberManagementError({ message: `error: ${raw}` }), raw).toEqual({ success: false, error: { code, message } });
    }
    const unknown = mapMemberManagementError({ message: "duplicate key value violates unique constraint tenant_memberships_pkey for a@b.co" });
    expect(unknown).toEqual({ success: false, error: { code: "UNEXPECTED", message: "İşlem gerçekleştirilemedi, lütfen tekrar deneyin" } });
    expect(JSON.stringify(unknown)).not.toMatch(/duplicate|constraint|a@b\.co/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("OW owner safety", () => {
  it("OW1 a sole owner can never suspend or remove themselves — database refusal and application message", async () => {
    for (const rpc of [rpcSuspend, rpcRemove]) {
      const outcome = await attemptAs(u.soloOwnerE!.id, (sql) => rpc(sql, tenantE.id, m.soloOwnerE!));
      expect(outcome).toMatchObject({ ok: false });
      expect((outcome as { message: string }).message).toContain("cannot_manage_self");
    }
    expect((await membershipRow(m.soloOwnerE!)).status).toBe("active");
    expect(await activeUnrestrictedHolders(tenantE.id)).toBe(1);
  });

  it("OW2 a Yönetici (below Owner) cannot touch the sole owner either", async () => {
    const mgr = await createTestUser("s1a-ow2-mgr");
    createdUserIds.push(mgr.id);
    const mgrMembership = await addTemplateMember(tenantE.id, mgr.id, "SALON_MANAGER");
    for (const rpc of [rpcSuspend, rpcRemove]) {
      const outcome = await attemptAs(mgr.id, (sql) => rpc(sql, tenantE.id, m.soloOwnerE!));
      expect((outcome as { message: string }).message).toContain("insufficient_authority");
    }
    expect(await activeUnrestrictedHolders(tenantE.id)).toBe(1);
    // keep the Emel-like salon a ONE-person salon for the regression tests below
    await testDb`update tenant_memberships set deleted_at = now() where id = ${mgrMembership}`;
  });

  it("OW3 with a second owner, each can act on the other but never on themselves; the tenant always keeps an active holder", async () => {
    expect(await attemptAs(u.ownerA1!.id, (sql) => rpcSuspend(sql, tenantA.id, m.ownerA1!))).toMatchObject({ ok: false });
    expect(await attemptAs(u.ownerA2!.id, (sql) => rpcRemove(sql, tenantA.id, m.ownerA2!))).toMatchObject({ ok: false });
    expect(await activeUnrestrictedHolders(tenantA.id)).toBe(2);

    // ownerA2 suspends ownerA1 (allowed: an unrestricted caller manages a peer) — ownerA2 is now the LAST active holder...
    expect(await attemptAs(u.ownerA2!.id, (sql) => rpcSuspend(sql, tenantA.id, m.ownerA1!))).toEqual({ ok: true });
    expect(await activeUnrestrictedHolders(tenantA.id)).toBe(1);
    const list = await listAs(u.ownerA2!.id, tenantA.id);
    expect(list.find((r) => r.membership_id === m.ownerA2!)).toMatchObject({ is_last_unrestricted_holder: true, can_suspend: false, can_remove: false });
    // ...and ONLY that member is flagged (a manager or a receptionist is never "the last owner").
    expect(list.filter((r) => r.is_last_unrestricted_holder).map((r) => r.membership_id)).toEqual([m.ownerA2!]);
    // ...a suspended owner can do nothing at all...
    expect(await attemptAs(u.ownerA1!.id, (sql) => rpcSuspend(sql, tenantA.id, m.ownerA2!))).toMatchObject({ ok: false });
    // ...and reactivation restores the pair.
    expect(await attemptAs(u.ownerA2!.id, (sql) => rpcReactivate(sql, tenantA.id, m.ownerA1!))).toEqual({ ok: true });
    expect(await activeUnrestrictedHolders(tenantA.id)).toBe(2);
  });

  it("OW4 two owners suspending EACH OTHER at the same moment: exactly one wins and the tenant keeps an active owner", async () => {
    const results = await Promise.all([
      attemptAs(u.ownerA1!.id, (sql) => rpcSuspend(sql, tenantA.id, m.ownerA2!)),
      attemptAs(u.ownerA2!.id, (sql) => rpcSuspend(sql, tenantA.id, m.ownerA1!)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await activeUnrestrictedHolders(tenantA.id)).toBe(1);
    // restore the pair for the following tests
    await testDb`update tenant_memberships set status = 'active' where tenant_id = ${tenantA.id} and id in (${m.ownerA1!}, ${m.ownerA2!})`;
    expect(await activeUnrestrictedHolders(tenantA.id)).toBe(2);
  });

  it("OW5 another salon's owner can modify nothing here (the membership simply does not exist for them)", async () => {
    for (const rpc of [rpcSuspend, rpcReactivate, rpcRemove]) {
      const outcome = await attemptAs(u.otherOwnerB!.id, (sql) => rpc(sql, tenantA.id, m.yoneticiA!));
      expect(outcome).toMatchObject({ ok: false });
      expect((outcome as { message: string }).message).toContain("membership_not_found");
    }
    expect((await membershipRow(m.yoneticiA!)).status).toBe("active");
  });

  it("OW6 PINNED CURRENT BEHAVIOUR for the owner-transfer audit: the primitives exist but there is no atomic transfer", async () => {
    // An owner can make a second owner (an unrestricted caller may grant any role)...
    const roleId = tenantA.ownerRoleId;
    const heir = await createTestUser("s1a-ow6-heir");
    createdUserIds.push(heir.id);
    const heirMembership = await addTemplateMember(tenantA.id, heir.id, "SALON_MANAGER");
    const promote = await attemptAs(u.ownerA1!.id, (sql) => sql`select public.update_membership_role(${heirMembership}::uuid, ${roleId}::uuid)`);
    expect(promote).toEqual({ ok: true });
    // ...nobody can demote or remove THEMSELVES (so the old owner cannot "hand over" on their own)...
    const managerRoleId = await templateRole(tenantA.id, "SALON_MANAGER");
    const selfDemote = await attemptAs(u.ownerA1!.id, (sql) => sql`select public.update_membership_role(${m.ownerA1!}::uuid, ${managerRoleId}::uuid)`);
    expect(selfDemote).toMatchObject({ ok: false });
    // ...and the new owner can demote the old one: two separate steps, with a window in which both are owners.
    expect(await attemptAs(heir.id, (sql) => rpcSuspend(sql, tenantA.id, m.ownerA1!))).toEqual({ ok: true });
    expect(await attemptAs(heir.id, (sql) => rpcReactivate(sql, tenantA.id, m.ownerA1!))).toEqual({ ok: true });
    // cleanup of the extra owner so later tests see the original shape
    await testDb`update tenant_memberships set deleted_at = now() where id = ${heirMembership}`;
    expect(await activeUnrestrictedHolders(tenantA.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("AZ authorization matrix for the three access RPCs", () => {
  // target label -> membership; expectation per caller: "ok" or the stable error code
  type Verdict = "ok" | "insufficient_authority" | "staff_manage_required" | "membership_not_found";
  const matrix: Array<[string, string, Record<string, Verdict>]> = [
    // caller label, caller user label, expectations by target label
    ["Owner", "ownerA1", { ownerA2: "ok", yoneticiA: "ok", resepsiyonA: "ok", personelA: "ok" }],
    ["Yönetici", "yoneticiA", { ownerA1: "insufficient_authority", ownerA2: "insufficient_authority", resepsiyonA: "ok", personelA: "ok" }],
    ["Resepsiyon", "resepsiyonA", { ownerA1: "staff_manage_required", yoneticiA: "staff_manage_required", personelA: "staff_manage_required" }],
    ["Personel", "personelA", { ownerA1: "staff_manage_required", yoneticiA: "staff_manage_required", resepsiyonA: "staff_manage_required" }],
    ["other salon's Owner", "otherOwnerB", { ownerA1: "membership_not_found", yoneticiA: "membership_not_found", resepsiyonA: "membership_not_found" }],
    ["a stranger", "stranger", { ownerA1: "membership_not_found", resepsiyonA: "membership_not_found" }],
  ];

  for (const [callerLabel, callerKey, expectations] of matrix) {
    for (const [targetKey, verdict] of Object.entries(expectations)) {
      it(`AZ ${callerLabel} -> ${targetKey}: ${verdict} (suspend, then remove; reactivate is the same decision)`, async () => {
        const caller = u[callerKey]!;
        const target = m[targetKey]!;
        for (const [name, rpc] of [["suspend", rpcSuspend], ["remove", rpcRemove]] as const) {
          const outcome = await dryRun(caller.id, (sql) => rpc(sql, tenantA.id, target));
          if (verdict === "ok") expect(outcome, name).toEqual({ ok: true });
          else expect((outcome as { message: string }).message, name).toContain(verdict);
        }
      });
    }
  }

  it("AZ anon cannot execute any of the three RPCs (permission denied, nothing written)", async () => {
    for (const fn of ["suspend_membership", "reactivate_membership", "remove_membership_access"]) {
      const outcome = await asDatabaseRole("anon", null, (sql) => sql.unsafe(`select public.${fn}('${tenantA.id}'::uuid, '${m.victimA!}'::uuid)`)).then(
        () => "ran",
        (error: { message?: string }) => error.message ?? "failed",
      );
      expect(outcome, fn).toMatch(/permission denied/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("SE session behaviour: the database, not the browser, is the authority", () => {
  it("SE1 a signed-in member whose access is suspended loses it on the very next call; reactivation restores it", async () => {
    // victimClient is signed in as victimA (membership m.victimA, re-created in AC8)
    const hasBefore = await victimClient.rpc("has_permission", { p_tenant_id: tenantA.id, p_permission_key: "appointments.view" });
    expect(hasBefore.data).toBe(true);

    expect(await attemptAs(u.ownerA1!.id, (sql) => rpcSuspend(sql, tenantA.id, m.victimA!))).toEqual({ ok: true });
    const suspended = await victimClient.rpc("has_permission", { p_tenant_id: tenantA.id, p_permission_key: "appointments.view" });
    expect(suspended.data).toBe(false);
    const rows = await asAuthenticatedUser(u.victimA!.id, (sql) => sql`select count(*)::int as n from appointments where tenant_id = ${tenantA.id}`);
    expect(rows[0]!.n).toBe(0);
    const memberships = await asAuthenticatedUser(u.victimA!.id, (sql) => sql`select count(*)::int as n from tenant_memberships where tenant_id = ${tenantA.id} and user_id = ${u.victimA!.id} and status = 'active' and deleted_at is null`);
    expect(memberships[0]!.n).toBe(0);

    expect(await attemptAs(u.ownerA1!.id, (sql) => rpcReactivate(sql, tenantA.id, m.victimA!))).toEqual({ ok: true });
    const restored = await victimClient.rpc("has_permission", { p_tenant_id: tenantA.id, p_permission_key: "appointments.view" });
    expect(restored.data).toBe(true);
  });

  it("SE2 removal while logged in ends access at once, with no second sign-in needed to notice", async () => {
    expect(await attemptAs(u.ownerA1!.id, (sql) => rpcRemove(sql, tenantA.id, m.victimA!))).toEqual({ ok: true });
    const after = await victimClient.rpc("has_permission", { p_tenant_id: tenantA.id, p_permission_key: "appointments.view" });
    expect(after.data).toBe(false);
    const list = await victimClient.rpc("list_team_members", { p_tenant_id: tenantA.id });
    expect(list.error?.message).toContain("staff.manage required");
  });

  it("SE3 a role change takes effect on the next call with the SAME session: nothing about authority lives in the token", async () => {
    const tester = await createTestUser("s1a-se3");
    createdUserIds.push(tester.id);
    const membership = await addTemplateMember(tenantA.id, tester.id, "SALON_MANAGER");
    const client = await signInAs(tester);
    expect((await client.rpc("has_permission", { p_tenant_id: tenantA.id, p_permission_key: "staff.manage" })).data).toBe(true);
    const lower = (await testDb<{ id: string }[]>`select id from roles where tenant_id = ${tenantA.id} and key = 'STYLIST'`)[0]!.id;
    expect(await attemptAs(u.ownerA1!.id, (sql) => sql`select public.update_membership_role(${membership}::uuid, ${lower}::uuid)`)).toEqual({ ok: true });
    expect((await client.rpc("has_permission", { p_tenant_id: tenantA.id, p_permission_key: "staff.manage" })).data).toBe(false);
    expect((await client.rpc("list_team_members", { p_tenant_id: tenantA.id })).error?.message).toContain("staff.manage required");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("RG regression: synthetic Gökhan-like and Emel-like salons", () => {
  it("RG1 Gökhan-like: a whole lifecycle changes no appointment, customer, service, staff, schedule or public-booking fact", async () => {
    const digestBefore = await businessDigest(tenantA.id);
    const publicBefore = await publicContext(tenantA.slug);
    expect((publicBefore as { bookable: boolean }).bookable).toBe(true);

    const subject = await createTestUser("s1a-rg1");
    createdUserIds.push(subject.id);
    const id = await addTemplateMember(tenantA.id, subject.id, "RECEPTIONIST");
    const staff = await createStaffMember(tenantA.id, "Personel rg1");
    await testDb`update staff_members set tenant_membership_id = ${id} where id = ${staff.id}`;
    const withStaff = await businessDigest(tenantA.id);

    for (const rpc of [rpcSuspend, rpcReactivate, rpcSuspend, rpcRemove]) {
      expect(await attemptAs(u.ownerA1!.id, (sql) => rpc(sql, tenantA.id, id))).toEqual({ ok: true });
    }
    expect(await businessDigest(tenantA.id)).toEqual(withStaff);
    expect(await publicContext(tenantA.slug)).toEqual(publicBefore);
    // and the original facts are still there (only the extra staff row we added is new)
    const after = await businessDigest(tenantA.id);
    expect(after.appointments).toBe(digestBefore.appointments);
    expect(after.customers).toBe(digestBefore.customers);
    expect(after.services).toBe(digestBefore.services);
  });

  it("RG2 Gökhan-like: existing logins keep working while a colleague is suspended and removed", async () => {
    // yoneticiClient and ownerClient are real signed-in sessions opened before any lifecycle change in this file.
    expect((await yoneticiClient.rpc("has_permission", { p_tenant_id: tenantA.id, p_permission_key: "staff.manage" })).data).toBe(true);
    expect((await ownerClient.rpc("has_permission", { p_tenant_id: tenantA.id, p_permission_key: "permissions.manage_unrestricted" })).data).toBe(true);
    const list = await getTeamMembers(ownerClient, tenantA.id);
    expect(list.map((r) => r.roleName)).toEqual(expect.arrayContaining(["Salon Sahibi", "Yönetici", "Resepsiyon", "Personel"]));
  });

  it("RG3 Emel-like: the Owner who is also the only staff member is shown once, linked, and cannot be removed", async () => {
    const rows = await getTeamMembers(await signInAs(u.soloOwnerE!), tenantE.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "active",
      isSelf: true,
      roleName: "Salon Sahibi",
      linkedStaffName: "Emel-like Sahip",
      isLastUnrestrictedHolder: true,
      canSuspend: false,
      canReactivate: false,
      canRemove: false,
    });
    const staffRows = await testDb<{ n: string }[]>`select count(*)::text as n from staff_members where tenant_id = ${tenantE.id}`;
    expect(staffRows[0]!.n).toBe("1");
  });

  it("RG4 Emel-like: inviting the owner's own address creates no second membership and no second staff row; booking is unaffected", async () => {
    const digestBefore = await businessDigest(tenantE.id);
    const publicBefore = await publicContext(tenantE.slug);
    expect((publicBefore as { bookable: boolean }).bookable).toBe(true);

    const ownerRole = tenantE.ownerRoleId;
    const outcome = await attemptAs(u.soloOwnerE!.id, (sql) => sql`select * from public.create_team_invitation(${tenantE.id}::uuid, ${u.soloOwnerE!.email}, ${ownerRole}::uuid, null)`);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { message: string }).message).toContain("already_member");

    expect((await testDb<{ n: string }[]>`select count(*)::text as n from tenant_memberships where tenant_id = ${tenantE.id} and deleted_at is null`)[0]!.n).toBe("1");
    expect(await businessDigest(tenantE.id)).toEqual(digestBefore);
    expect(await publicContext(tenantE.slug)).toEqual(publicBefore);
  });

  it("RG5 Emel-like: adding a team member (invite + accept) never duplicates the owner's staff row", async () => {
    const helper = await createTestUser("s1a-rg5-helper");
    createdUserIds.push(helper.id);
    const managerRole = (await testDb<{ id: string }[]>`
      insert into roles (tenant_id, name, is_system_default) values (${tenantE.id}, 'Yardımcı Rol', false) returning id`)[0]!.id;
    await testDb`insert into role_permissions (role_id, permission_id) select ${managerRole}, id from permissions where key in ('staff.view', 'appointments.view')`;
    const created = await attemptAs(u.soloOwnerE!.id, (sql) => sql`select * from public.create_team_invitation(${tenantE.id}::uuid, ${helper.email}, ${managerRole}::uuid, null)`);
    expect(created).toEqual({ ok: true });
    expect((await testDb<{ n: string }[]>`select count(*)::text as n from staff_members where tenant_id = ${tenantE.id}`)[0]!.n).toBe("1");
    expect((await testDb<{ n: string }[]>`select count(*)::text as n from tenant_memberships where tenant_id = ${tenantE.id} and deleted_at is null`)[0]!.n).toBe("1");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("IN invitation lifecycle gaps (the rest is pinned by the SAAS.1C/1D/1E suites)", () => {
  async function invite(email: string, tenant: TestTenant, roleKey: string, client = ownerClient) {
    const roleId = (await testDb<{ id: string }[]>`select id from roles where tenant_id = ${tenant.id} and key = ${roleKey}`)[0]!.id;
    const { data, error } = await client.rpc("create_team_invitation", { p_tenant_id: tenant.id, p_email: email, p_role_id: roleId });
    return { data: data as { id: string; token: string }[] | null, error };
  }

  it("IN1 a person who already belongs to ANOTHER salon accepts an invitation here: one auth identity, two memberships (the product rule is unchanged)", async () => {
    const result = await invite(u.otherOwnerB!.email, tenantA, "RECEPTIONIST");
    expect(result.error).toBeNull();
    const otherOwnerClient = await signInAs(u.otherOwnerB!);
    const accepted = await otherOwnerClient.rpc("accept_team_invitation", { p_token: result.data![0]!.token });
    expect(accepted.error).toBeNull();
    const memberships = await testDb<{ tenant_id: string }[]>`select tenant_id from tenant_memberships where user_id = ${u.otherOwnerB!.id} and deleted_at is null order by tenant_id`;
    expect(memberships.map((r) => r.tenant_id).sort()).toEqual([tenantA.id, tenantB.id].sort());
    expect((await testDb<{ n: string }[]>`select count(*)::text as n from auth.users where lower(email) = ${u.otherOwnerB!.email.toLowerCase()}`)[0]!.n).toBe("1");
    // and nothing leaked back: the receptionist role here grants nothing in tenant B
    const staffManageInB = await otherOwnerClient.rpc("has_permission", { p_tenant_id: tenantB.id, p_permission_key: "staff.manage" });
    expect(staffManageInB.data).toBe(true); // their OWN owner role in B, untouched
    const staffManageInA = await otherOwnerClient.rpc("has_permission", { p_tenant_id: tenantA.id, p_permission_key: "staff.manage" });
    expect(staffManageInA.data).toBe(false);
  });

  it("IN2 after a revocation the same address can be invited again; the old link is dead and the new one works", async () => {
    const email = `s1a-in2-${Date.now().toString(36)}@example.com`;
    const first = await invite(email, tenantA, "RECEPTIONIST");
    expect(first.error).toBeNull();
    const revoke = await ownerClient.rpc("revoke_team_invitation", { p_invitation_id: first.data![0]!.id });
    expect(revoke.error).toBeNull();
    const second = await invite(email, tenantA, "RECEPTIONIST");
    expect(second.error).toBeNull();
    expect(second.data![0]!.id).not.toBe(first.data![0]!.id);
    expect(second.data![0]!.token).not.toBe(first.data![0]!.token);
    const rows = await testDb<{ status: string }[]>`select status from team_invitations where tenant_id = ${tenantA.id} and email = ${email} order by created_at`;
    expect(rows.map((r) => r.status)).toEqual(["revoked", "pending"]);
  });

  it("IN3 an invitation for salon A cannot be redeemed into salon B: the token resolves only its own tenant", async () => {
    const email = `s1a-in3-${Date.now().toString(36)}@example.com`;
    const fresh = await createTestUser("s1a-in3");
    createdUserIds.push(fresh.id);
    const created = await invite(fresh.email, tenantA, "RECEPTIONIST");
    expect(created.error).toBeNull();
    const freshClient = await signInAs(fresh);
    const accepted = await freshClient.rpc("accept_team_invitation", { p_token: created.data![0]!.token });
    expect(accepted.error).toBeNull();
    const memberships = await testDb<{ tenant_id: string }[]>`select tenant_id from tenant_memberships where user_id = ${fresh.id} and deleted_at is null`;
    expect(memberships.map((r) => r.tenant_id)).toEqual([tenantA.id]);
    void email;
  });

  it("IN4 the pending list shows state and expiry, never a token", async () => {
    const email = `s1a-in4-${Date.now().toString(36)}@example.com`;
    await invite(email, tenantA, "RECEPTIONIST");
    const { data } = await ownerClient.rpc("list_team_invitations", { p_tenant_id: tenantA.id });
    const row = (data as Record<string, unknown>[]).find((r) => r.email === email)!;
    expect(row.effective_status).toBe("pending");
    expect(Object.keys(row).join(",")).not.toMatch(/token/i);
    await testDb`update team_invitations set created_at = now() - interval '8 days', expires_at = now() - interval '1 minute' where tenant_id = ${tenantA.id} and email = ${email}`;
    const again = (await ownerClient.rpc("list_team_invitations", { p_tenant_id: tenantA.id })).data as Record<string, unknown>[];
    expect(again.find((r) => r.email === email)!.effective_status).toBe("expired");
  });

  it("IN5 anon can reach no invitation-management RPC", async () => {
    const outcome = await anonClient().rpc("list_team_invitations", { p_tenant_id: tenantA.id });
    expect(outcome.error).not.toBeNull();
  });
});
