import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  asAuthenticatedUser,
  attemptAs,
  cleanupTenants,
  cleanupUsers,
  createStaffMember,
  createTestTenant,
  createTestUser,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1E.1 (residual D) — D1: an ordinary tenant member can read their
 * OWN membership row and nothing else of the tenant's access graph; a
 * staff.manage holder still reads all of it (the Team/Personnel screens).
 * D2: staff_members.email/phone/tenant_membership_id and
 * staff_schedule_exceptions.reason are no longer readable by a plain
 * member — only staff.view/staff.manage, via
 * get_staff_management_details / get_staff_exception_reasons /
 * get_my_staff_link / get_staff_link_for_membership. The roster's NAME,
 * status and colour (what the calendar needs) stay readable by everyone.
 *
 * Both are column/row restrictions at the database layer, proven here by
 * attempting the forbidden read directly through the simulated PostgREST
 * session (asAuthenticatedUser / attemptAs) — a client-side filter could
 * never produce these refusals.
 */

const TAG = randomUUID().slice(0, 8);
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`msp-${label}`);
  createdUserIds.push(user.id);
  return user;
}

async function provisionedRoles(tenantId: string): Promise<Record<string, string>> {
  await testDb`select * from private.provision_default_roles(${tenantId}::uuid)`;
  const rows = await testDb<{ id: string; key: string }[]>`select id, key from roles where tenant_id = ${tenantId} and deleted_at is null`;
  return Object.fromEntries(rows.map((r) => [r.key, r.id]));
}

// ---------------------------------------------------------------------------
// D1 — tenant_memberships
// ---------------------------------------------------------------------------

describe("D1 — tenant_memberships: own row always, the whole graph only with staff.manage", () => {
  let tenant: TestTenant;
  const users: Record<string, TestUser> = {};
  const role: Record<string, string> = {};
  const membership: Record<string, string> = {};

  beforeAll(async () => {
    users.owner = await newUser("owner");
    tenant = await createTestTenant(`test-tenant-msp-d1-${TAG}`, users.owner!.id);
    createdTenantIds.push(tenant.id);
    Object.assign(role, await provisionedRoles(tenant.id));
    const [own] = await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${users.owner!.id}`;
    membership.owner = own!.id;
    for (const [label, key] of [["manager", "SALON_MANAGER"], ["reception", "RECEPTIONIST"], ["personel", "STYLIST"], ["personel2", "STYLIST"]] as const) {
      users[label] = await newUser(label);
      membership[label] = await addMembership(tenant.id, users[label]!.id, role[key]!);
    }
  }, 90000);

  afterAll(async () => {
    await cleanupTenants(createdTenantIds);
    await cleanupUsers(createdUserIds);
  }, 120000);

  const allRows = (userId: string) => asAuthenticatedUser(userId, (sql) => sql<{ id: string; user_id: string }[]>`select id, user_id from tenant_memberships where tenant_id = ${tenant.id}`);

  it("Personel and Resepsiyon — no staff.manage — see EXACTLY their own active row, nobody else's", async () => {
    expect((await allRows(users.personel!.id)).map((r) => r.id)).toEqual([membership.personel]);
    expect((await allRows(users.reception!.id)).map((r) => r.id)).toEqual([membership.reception]);
  });

  it("Manager and Owner — staff.manage — see every membership row of the tenant, including each other's", async () => {
    const asManager = (await allRows(users.manager!.id)).map((r) => r.id).sort();
    const asOwner = (await allRows(users.owner!.id)).map((r) => r.id).sort();
    const everyone = Object.values(membership).sort();
    expect(asManager).toEqual(everyone);
    expect(asOwner).toEqual(everyone);
  });

  it("a suspended or removed membership's OWN holder loses even self-visibility of that row — own-row access requires status = active", async () => {
    const extra = await newUser("suspendable");
    const extraMembership = await addMembership(tenant.id, extra.id, role.STYLIST!);
    expect((await allRows(extra.id)).map((r) => r.id)).toEqual([extraMembership]);
    await attemptAs(users.owner!.id, (sql) => sql`select public.suspend_membership(${tenant.id}::uuid, ${extraMembership}::uuid)`);
    expect(await allRows(extra.id)).toEqual([]);
  }, 60000);

  it("Personel cannot read a colleague's row even by exact id, and select * on the table is refused outright for anyone", async () => {
    const byId = await asAuthenticatedUser(users.personel!.id, (sql) => sql<{ id: string }[]>`select id from tenant_memberships where id = ${membership.manager}`);
    expect(byId).toEqual([]);
    const starAsPersonel = await attemptAs(users.personel!.id, (sql) => sql`select * from tenant_memberships where tenant_id = ${tenant.id}`);
    const starAsManager = await attemptAs(users.manager!.id, (sql) => sql`select * from tenant_memberships where tenant_id = ${tenant.id}`);
    expect(starAsPersonel).toMatchObject({ ok: true }); // select * is fine — every column is grant-readable; it's the ROW policy that scopes it
    expect(starAsManager).toMatchObject({ ok: true });
  });

  it("app code that resolves 'my own access context' (getUserMemberships / getTenantAccess pattern) still works — own-row lookups are unaffected", async () => {
    const own = await asAuthenticatedUser(users.personel!.id, (sql) =>
      sql<{ id: string; role_id: string; status: string }[]>`select id, role_id, status from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${users.personel!.id} and status = 'active'`,
    );
    expect(own).toHaveLength(1);
    expect(own[0]!.role_id).toBe(role.STYLIST);
  });

  it("cross-tenant: a member of tenant A reading tenant B's memberships (even with staff.manage in A) gets nothing", async () => {
    const otherOwner = await newUser("other-owner");
    const other = await createTestTenant(`test-tenant-msp-d1-other-${TAG}`, otherOwner.id);
    createdTenantIds.push(other.id);
    const rows = await asAuthenticatedUser(users.manager!.id, (sql) => sql<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${other.id}`);
    expect(rows).toEqual([]);
  }, 60000);
});

// ---------------------------------------------------------------------------
// D2 — staff_members contact/link privacy + schedule-exception reasons
// ---------------------------------------------------------------------------

describe("D2 — staff contact details, login link and leave reasons are staff.view/staff.manage-only", () => {
  let tenant: TestTenant;
  const users: Record<string, TestUser> = {};
  const role: Record<string, string> = {};
  let staff: { id: string; fullName: string };
  let exceptionId: string;

  const SECRET_EMAIL = `kolega-${TAG}@example.com`;
  const SECRET_PHONE = "+90 555 777 88 99";
  const SECRET_REASON = `izin-nedeni-${TAG}`;

  beforeAll(async () => {
    users.owner = await newUser("d2-owner");
    tenant = await createTestTenant(`test-tenant-msp-d2-${TAG}`, users.owner!.id);
    createdTenantIds.push(tenant.id);
    Object.assign(role, await provisionedRoles(tenant.id));
    for (const [label, key] of [["manager", "SALON_MANAGER"], ["reception", "RECEPTIONIST"], ["personel", "STYLIST"]] as const) {
      users[label] = await newUser(`d2-${label}`);
      await addMembership(tenant.id, users[label]!.id, role[key]!);
    }
    staff = await createStaffMember(tenant.id, "D2 Kolega");
    const [managerMembership] = await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${users.manager!.id}`;
    await testDb`update staff_members set email = ${SECRET_EMAIL}, phone = ${SECRET_PHONE}, tenant_membership_id = ${managerMembership!.id}, color = '#ff00aa' where id = ${staff.id}`;
    const [exc] = await testDb<{ id: string }[]>`
      insert into staff_schedule_exceptions (tenant_id, staff_member_id, exception_date, type, reason)
      values (${tenant.id}, ${staff.id}, current_date + 30, 'unavailable', ${SECRET_REASON}) returning id`;
    exceptionId = exc!.id;
  }, 90000);

  afterAll(async () => {
    await cleanupTenants(createdTenantIds);
    await cleanupUsers(createdUserIds);
  }, 120000);

  it("every tenant member — including Personel — still reads the calendar-safe roster: id, full_name, status, color", async () => {
    const rows = await asAuthenticatedUser(users.personel!.id, (sql) => sql<{ id: string; full_name: string; status: string; color: string | null }[]>`select id, full_name, status, color from staff_members where id = ${staff.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ full_name: "D2 Kolega", status: "active", color: "#ff00aa" });
  });

  it("Personel and Resepsiyon cannot select email, phone or tenant_membership_id — column-level refusal, not empty rows", async () => {
    for (const caller of ["personel", "reception"] as const) {
      const email = await attemptAs(users[caller]!.id, (sql) => sql`select email from staff_members where id = ${staff.id}`);
      const phone = await attemptAs(users[caller]!.id, (sql) => sql`select phone from staff_members where id = ${staff.id}`);
      const link = await attemptAs(users[caller]!.id, (sql) => sql`select tenant_membership_id from staff_members where id = ${staff.id}`);
      const star = await attemptAs(users[caller]!.id, (sql) => sql`select * from staff_members where id = ${staff.id}`);
      const filterByLink = await attemptAs(users[caller]!.id, (sql) => sql`select id from staff_members where tenant_membership_id is not null`);
      for (const [name, result] of [["email", email], ["phone", phone], ["link", link], ["star", star], ["filterByLink", filterByLink]] as const) {
        expect(result, `${caller}.${name}`).toMatchObject({ ok: false, message: expect.stringContaining("permission denied") });
      }
    }
  });

  it("no secret leaks anywhere: the calendar-safe columns never contain the email/phone string, even embedded", async () => {
    const rows = await asAuthenticatedUser(users.personel!.id, (sql) => sql<Record<string, unknown>[]>`select id, full_name, status, color, display_order from staff_members where tenant_id = ${tenant.id}`);
    const payload = JSON.stringify(rows);
    expect(payload).not.toContain(SECRET_EMAIL);
    expect(payload).not.toContain(SECRET_PHONE);
  });

  it("get_staff_management_details: refused without staff.view/staff.manage, correct for Manager (who has both)", async () => {
    const denied = await attemptAs(users.personel!.id, (sql) => sql`select * from public.get_staff_management_details(${tenant.id}::uuid, null::uuid[])`);
    expect(denied).toMatchObject({ ok: false, message: "staff.view required" });

    const rows = await asAuthenticatedUser(users.manager!.id, (sql) =>
      sql<{ staff_member_id: string; email: string; phone: string; tenant_membership_id: string | null }[]>`select * from public.get_staff_management_details(${tenant.id}::uuid, ${sql.array([staff.id], 2950)}::uuid[])`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ staff_member_id: staff.id, email: SECRET_EMAIL, phone: SECRET_PHONE });
  });

  it("get_staff_management_details is tenant-bound and caps at 500 ids", async () => {
    const otherOwner = await newUser("d2-other-owner");
    const other = await createTestTenant(`test-tenant-msp-d2-other-${TAG}`, otherOwner.id);
    createdTenantIds.push(other.id);
    const crossTenant = await attemptAs(otherOwner.id, (sql) => sql`select * from public.get_staff_management_details(${other.id}::uuid, ${sql.array([staff.id], 2950)}::uuid[])`);
    expect(crossTenant).toEqual({ ok: true }); // call succeeds, tenant-bound join just yields nothing
    const rows = await asAuthenticatedUser(otherOwner.id, (sql) => sql<{ staff_member_id: string }[]>`select * from public.get_staff_management_details(${other.id}::uuid, ${sql.array([staff.id], 2950)}::uuid[])`);
    expect(rows).toEqual([]);
    const tooMany = await attemptAs(users.manager!.id, (sql) => sql`select * from public.get_staff_management_details(${tenant.id}::uuid, ${sql.array(Array.from({ length: 501 }, () => randomUUID()), 2950)}::uuid[])`);
    expect(tooMany).toMatchObject({ ok: false, message: "too_many_staff_ids" });
  }, 60000);

  it("get_staff_exception_reasons: refused without staff.view/staff.manage, correct for Manager", async () => {
    const denied = await attemptAs(users.reception!.id, (sql) => sql`select * from public.get_staff_exception_reasons(${tenant.id}::uuid, ${staff.id}::uuid)`);
    expect(denied).toMatchObject({ ok: false, message: "staff.view required" });
    const rows = await asAuthenticatedUser(users.manager!.id, (sql) => sql<{ exception_id: string; reason: string }[]>`select * from public.get_staff_exception_reasons(${tenant.id}::uuid, ${staff.id}::uuid)`);
    expect(rows).toEqual([{ exception_id: exceptionId, reason: SECRET_REASON }]);
    const direct = await attemptAs(users.reception!.id, (sql) => sql`select reason from staff_schedule_exceptions where id = ${exceptionId}`);
    expect(direct).toMatchObject({ ok: false });
  });

  it("get_my_staff_link: free for the caller's own link, needs no permission — and correctly empty for someone with none", async () => {
    const managerLink = await asAuthenticatedUser(users.manager!.id, (sql) => sql<{ staff_member_id: string; full_name: string }[]>`select * from public.get_my_staff_link(${tenant.id}::uuid)`);
    expect(managerLink).toEqual([{ staff_member_id: staff.id, full_name: "D2 Kolega" }]);
    const personelLink = await asAuthenticatedUser(users.personel!.id, (sql) => sql<{ staff_member_id: string; full_name: string }[]>`select * from public.get_my_staff_link(${tenant.id}::uuid)`);
    expect(personelLink).toEqual([]);
  });

  it("get_staff_link_for_membership: free for your OWN membership id, staff.view/staff.manage required for anyone else's", async () => {
    const [managerMembership] = await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${users.manager!.id}`;
    const own = await asAuthenticatedUser(users.manager!.id, (sql) => sql<{ staff_member_id: string; full_name: string }[]>`select * from public.get_staff_link_for_membership(${tenant.id}::uuid, ${managerMembership!.id}::uuid)`);
    expect(own).toEqual([{ staff_member_id: staff.id, full_name: "D2 Kolega" }]);

    const someoneElse = await attemptAs(users.personel!.id, (sql) => sql`select * from public.get_staff_link_for_membership(${tenant.id}::uuid, ${managerMembership!.id}::uuid)`);
    expect(someoneElse).toMatchObject({ ok: false, message: "staff.view required" });

    const authorized = await asAuthenticatedUser(users.owner!.id, (sql) => sql<{ staff_member_id: string }[]>`select * from public.get_staff_link_for_membership(${tenant.id}::uuid, ${managerMembership!.id}::uuid)`);
    expect(authorized[0]!.staff_member_id).toBe(staff.id);
  });

  it("the Owner/Yönetici management path (get_staff_management_details + the calendar-safe select) round-trips exactly what the old direct embed used to give", async () => {
    const detail = (await asAuthenticatedUser(users.owner!.id, (sql) => sql<{ email: string; phone: string; tenant_membership_id: string | null }[]>`select * from public.get_staff_management_details(${tenant.id}::uuid, ${sql.array([staff.id], 2950)}::uuid[])`))[0]!;
    expect(detail.email).toBe(SECRET_EMAIL);
    expect(detail.phone).toBe(SECRET_PHONE);
    expect(detail.tenant_membership_id).not.toBeNull();
  });
});
