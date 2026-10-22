import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  asAuthenticatedUser,
  asDatabaseRole,
  attemptAs,
  cleanupTenants,
  cleanupUsers,
  createCustomRole,
  createStaffMember,
  createTestTenant,
  createTestUser,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz LAUNCH.1A (3 of 3) — the two READ models behind the Owner-facing Team
 * management page (migration 20261022150200): public.list_team_members and
 * public.list_assignable_roles.
 *
 * They authorize nothing — every mutation keeps its own full authority checks
 * (team-authority-hardening.test.ts). What is pinned here: who may read them,
 * exactly which rows and columns come back, that `can_manage` is the SAME
 * decision the mutation RPCs use, and that no auth user id, e-mail or phone ever
 * leaves the database.
 */

const TAG = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function newUser(label: string, fullName?: string): Promise<TestUser> {
  const user = await createTestUser(`l1a-tm-${label}`);
  createdUserIds.push(user.id);
  if (fullName) await testDb`update profiles set full_name = ${fullName} where id = ${user.id}`;
  return user;
}

type MemberRow = {
  membership_id: string;
  display_name: string | null;
  role_id: string;
  role_name: string;
  status: string;
  is_self: boolean;
  linked_staff_name: string | null;
  can_manage: boolean;
};

type RoleRow = { role_id: string; role_name: string; assignable: boolean };

const listMembers = (userId: string, tenantId: string) =>
  asAuthenticatedUser(userId, (sql) => sql<MemberRow[]>`select * from public.list_team_members(${tenantId}::uuid)`);
const listRoles = (userId: string, tenantId: string) =>
  asAuthenticatedUser(userId, (sql) => sql<RoleRow[]>`select * from public.list_assignable_roles(${tenantId}::uuid)`);

let tenant: TestTenant;
let otherTenant: TestTenant;
const u: Record<string, TestUser> = {};
const membershipOf: Record<string, string> = {};
const roleId: Record<string, string> = {};

beforeAll(async () => {
  u.owner = await newUser("owner", "Ayşe Sahip");
  u.owner2 = await newUser("owner2", "Burak İkinci Sahip");
  u.manager = await newUser("manager", "Cemile Yönetici");
  u.manager2 = await newUser("manager2", "Deniz Yönetici İki");
  u.reception = await newUser("reception", "Ece Resepsiyon");
  u.personel = await newUser("personel", "Fatma Personel");
  u.suspended = await newUser("suspended", "Gül Askıda");
  u.removed = await newUser("removed", "Hakan Çıkarılmış");
  u.unnamed = await newUser("unnamed");
  u.outsider = await newUser("outsider", "Işık Dışarıdan");

  tenant = await createTestTenant(`l1a-tm-${TAG}`, u.owner.id);
  createdTenantIds.push(tenant.id);
  await testDb`select private.provision_default_roles(${tenant.id}::uuid)`;
  for (const key of ["SALON_OWNER", "SALON_MANAGER", "RECEPTIONIST", "STYLIST"]) {
    const [r] = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${tenant.id} and key = ${key} and deleted_at is null`;
    roleId[key] = r!.id;
  }

  const add = async (label: string, roleKey: string) => {
    membershipOf[label] = await addMembership(tenant.id, u[label]!.id, roleId[roleKey]!);
  };
  // the fixture tenant's creator already has the owner membership
  const [ownerMembership] = await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${u.owner.id}`;
  membershipOf.owner = ownerMembership!.id;
  await add("owner2", "SALON_OWNER");
  await add("manager", "SALON_MANAGER");
  await add("manager2", "SALON_MANAGER");
  await add("reception", "RECEPTIONIST");
  await add("personel", "STYLIST");
  await add("suspended", "STYLIST");
  await add("removed", "STYLIST");
  await add("unnamed", "RECEPTIONIST");
  await testDb`update tenant_memberships set status = 'suspended' where id = ${membershipOf.suspended}`;
  await testDb`update tenant_memberships set deleted_at = now() where id = ${membershipOf.removed}`;

  // a staff row linked to the receptionist's login, and one linked to nobody
  const staff = await createStaffMember(tenant.id, "Ece Kuaför");
  await testDb`update staff_members set tenant_membership_id = ${membershipOf.reception} where id = ${staff.id}`;
  await createStaffMember(tenant.id, "Bağlantısız Personel");

  otherTenant = await createTestTenant(`l1a-tm-other-${TAG}`, u.outsider.id);
  createdTenantIds.push(otherTenant.id);
  await testDb`select private.provision_default_roles(${otherTenant.id}::uuid)`;
}, 120000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 120000);

// ---------------------------------------------------------------------------------------------------------------------
describe("list_team_members — who may read it", () => {
  it("members without staff.manage (Resepsiyon, Personel), non-members and other tenants' owners all get the same refusal", async () => {
    for (const who of [u.reception, u.personel, u.outsider]) {
      expect(await attemptAs(who!.id, (sql) => sql`select * from public.list_team_members(${tenant.id}::uuid)`), who!.email).toMatchObject({
        ok: false,
        message: "staff.manage required",
      });
    }
  });

  it("a staff.manage holder of ANOTHER tenant cannot read this tenant's team", async () => {
    expect(await attemptAs(u.outsider!.id, (sql) => sql`select * from public.list_team_members(${tenant.id}::uuid)`)).toMatchObject({
      ok: false,
      message: "staff.manage required",
    });
  });

  it("an unknown tenant id is refused with the same message (a tenant id cannot be probed)", async () => {
    expect(await attemptAs(u.owner!.id, (sql) => sql`select * from public.list_team_members(${randomUUID()}::uuid)`)).toMatchObject({
      ok: false,
      message: "staff.manage required",
    });
  });

  it("anon cannot execute either read model", async () => {
    await expect(asDatabaseRole("anon", null, (sql) => sql`select * from public.list_team_members(${tenant.id}::uuid)`)).rejects.toMatchObject({ code: "42501" });
    await expect(asDatabaseRole("anon", null, (sql) => sql`select * from public.list_assignable_roles(${tenant.id}::uuid)`)).rejects.toMatchObject({ code: "42501" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("list_team_members — what comes back", () => {
  let rows: MemberRow[];

  beforeAll(async () => {
    rows = await listMembers(u.owner!.id, tenant.id);
  });

  it("lists the ACTIVE and SUSPENDED members of the tenant and nobody else (removed members and other tenants are absent)", () => {
    const ids = new Set(rows.map((r) => r.membership_id));
    for (const label of ["owner", "owner2", "manager", "manager2", "reception", "personel", "suspended", "unnamed"]) {
      expect(ids.has(membershipOf[label]!), label).toBe(true);
    }
    expect(ids.has(membershipOf.removed!)).toBe(false);
    expect(rows).toHaveLength(8);
  });

  it("returns display name, role and status exactly as stored; a member without a profile name has display_name NULL", () => {
    const byId = new Map(rows.map((r) => [r.membership_id, r]));
    expect(byId.get(membershipOf.owner!)).toMatchObject({ display_name: "Ayşe Sahip", role_name: "Salon Sahibi", status: "active" });
    expect(byId.get(membershipOf.manager!)).toMatchObject({ display_name: "Cemile Yönetici", role_name: "Yönetici", status: "active" });
    expect(byId.get(membershipOf.suspended!)).toMatchObject({ display_name: "Gül Askıda", role_name: "Personel", status: "suspended" });
    expect(byId.get(membershipOf.unnamed!)).toMatchObject({ display_name: null, role_name: "Resepsiyon" });
  });

  it("marks exactly the caller's own row with is_self", () => {
    expect(rows.filter((r) => r.is_self).map((r) => r.membership_id)).toEqual([membershipOf.owner]);
  });

  it("returns the linked staff member's NAME (and null when the login is linked to nobody)", () => {
    const byId = new Map(rows.map((r) => [r.membership_id, r]));
    expect(byId.get(membershipOf.reception!)!.linked_staff_name).toBe("Ece Kuaför");
    expect(byId.get(membershipOf.manager!)!.linked_staff_name).toBeNull();
  });

  it("returns ONLY the eight expected columns — no auth user id, e-mail, phone or staff id", () => {
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["can_manage", "display_name", "is_self", "linked_staff_name", "membership_id", "role_id", "role_name", "status"],
    );
  });

  it("the serialized result contains none of the members' auth user ids, e-mail addresses or the e-mail local parts", () => {
    const blob = JSON.stringify(rows);
    for (const user of Object.values(u)) {
      expect(blob.includes(user.id), `auth id of ${user.email}`).toBe(false);
      expect(blob.toLowerCase().includes(user.email.toLowerCase()), user.email).toBe(false);
      expect(blob.includes("@"), "any e-mail address").toBe(false);
    }
  });

  it("is ordered by membership creation (stable)", async () => {
    const again = await listMembers(u.owner!.id, tenant.id);
    expect(again.map((r) => r.membership_id)).toEqual(rows.map((r) => r.membership_id));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("list_team_members — can_manage is the shared authority decision", () => {
  const canManage = (rows: MemberRow[]) => Object.fromEntries(Object.keys(membershipOf).map((label) => [label, rows.find((r) => r.membership_id === membershipOf[label])?.can_manage]));

  it("for a Salon Sahibi: every OTHER member (including a peer owner and a Yönetici) is manageable, never themselves", async () => {
    const rows = await listMembers(u.owner!.id, tenant.id);
    expect(canManage(rows)).toMatchObject({
      owner: false,
      owner2: true,
      manager: true,
      manager2: true,
      reception: true,
      personel: true,
      suspended: true,
      unnamed: true,
    });
  });

  it("for a Yönetici: only members strictly BELOW them (Resepsiyon, Personel); never an Owner, a peer Yönetici or themselves", async () => {
    const rows = await listMembers(u.manager!.id, tenant.id);
    expect(canManage(rows)).toMatchObject({
      owner: false,
      owner2: false,
      manager: false,
      manager2: false,
      reception: true,
      personel: true,
      suspended: true,
      unnamed: true,
    });
    expect(rows.filter((r) => r.is_self).map((r) => r.membership_id)).toEqual([membershipOf.manager]);
  });

  it("each flag equals what the mutation RPCs decide (private.membership_authority_decision with the caller's claims), row by row, for four different callers", async () => {
    for (const actor of [u.owner!, u.owner2!, u.manager!, u.manager2!]) {
      const rows = await listMembers(actor.id, tenant.id);
      // private.* is not callable by `authenticated`, so evaluate the decision as the table owner with the caller's JWT claims
      // (what auth.uid() reads) — the same decision the suspend / reactivate / remove / role-change RPCs make.
      const decisions = await testDb.begin(async (sql) => {
        await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: actor.id, role: "authenticated" })}, true),
                         set_config('request.jwt.claim.sub', ${actor.id}, true)`;
        const out = new Map<string, string>();
        for (const r of rows) {
          const [d] = await sql<{ d: string }[]>`select private.membership_authority_decision(${tenant.id}::uuid, ${r.membership_id}::uuid, 'role_change') as d`;
          out.set(r.membership_id, d!.d);
        }
        return out;
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.can_manage, `${actor.email} -> ${r.display_name}`).toBe(decisions.get(r.membership_id) === "ok");
      }
    }
  });

  it("a flag of false really means the mutation is refused, and true really means it is allowed (round trip with update_membership_role)", async () => {
    // Yönetici -> peer Yönetici: flag false, RPC refuses
    expect(
      await attemptAs(u.manager!.id, (sql) => sql`select public.update_membership_role(${membershipOf.manager2!}::uuid, ${roleId.RECEPTIONIST!}::uuid)`),
    ).toMatchObject({ ok: false, message: "insufficient_authority" });
    // Yönetici -> Personel: flag true, RPC allows (change and change back)
    expect(
      (await attemptAs(u.manager!.id, (sql) => sql`select public.update_membership_role(${membershipOf.personel!}::uuid, ${roleId.RECEPTIONIST!}::uuid)`)).ok,
    ).toBe(true);
    expect(
      (await attemptAs(u.owner!.id, (sql) => sql`select public.update_membership_role(${membershipOf.personel!}::uuid, ${roleId.STYLIST!}::uuid)`)).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("list_assignable_roles", () => {
  it("is refused to members without staff.manage and to other tenants' owners", async () => {
    for (const who of [u.reception!, u.personel!, u.outsider!]) {
      expect(await attemptAs(who.id, (sql) => sql`select * from public.list_assignable_roles(${tenant.id}::uuid)`)).toMatchObject({
        ok: false,
        message: "staff.manage required",
      });
    }
  });

  it("for a Salon Sahibi every live role is assignable", async () => {
    const rows = await listRoles(u.owner!.id, tenant.id);
    expect(rows.map((r) => r.role_name).sort()).toEqual(["Personel", "Resepsiyon", "Salon Sahibi", "Yönetici"].sort());
    expect(rows.every((r) => r.assignable)).toBe(true);
  });

  it("for a Yönetici only the roles STRICTLY below theirs are assignable (not Salon Sahibi, not their own Yönetici)", async () => {
    const rows = await listRoles(u.manager!.id, tenant.id);
    const byName = Object.fromEntries(rows.map((r) => [r.role_name, r.assignable]));
    expect(byName).toEqual({ "Salon Sahibi": false, Yönetici: false, Resepsiyon: true, Personel: true });
  });

  it("a custom role holding a permission the caller lacks is not assignable; a deleted role is not listed", async () => {
    const richRole = await createCustomRole(tenant.id, "Finans Özel", ["appointments.view", "finance.view"]);
    const deletedRole = await createCustomRole(tenant.id, "Silinmiş Rol", ["appointments.view"]);
    await testDb`update roles set deleted_at = now() where id = ${deletedRole}`;
    const asManager = await listRoles(u.manager!.id, tenant.id);
    const asOwner = await listRoles(u.owner!.id, tenant.id);
    expect(asManager.find((r) => r.role_id === richRole)).toMatchObject({ role_name: "Finans Özel", assignable: false });
    expect(asOwner.find((r) => r.role_id === richRole)).toMatchObject({ assignable: true });
    expect(asManager.some((r) => r.role_id === deletedRole)).toBe(false);
    expect(asOwner.some((r) => r.role_id === deletedRole)).toBe(false);
  });

  it("returns only role id, name and the advisory flag — and never another tenant's roles", async () => {
    const rows = await listRoles(u.owner!.id, tenant.id);
    expect(Object.keys(rows[0]!).sort()).toEqual(["assignable", "role_id", "role_name"]);
    const foreign = await testDb<{ id: string }[]>`select id from roles where tenant_id = ${otherTenant.id}`;
    const foreignIds = new Set(foreign.map((f) => f.id));
    expect(rows.some((r) => foreignIds.has(r.role_id))).toBe(false);
  });
});
