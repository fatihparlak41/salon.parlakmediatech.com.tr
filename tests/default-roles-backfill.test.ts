import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAuthenticatedUser,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createCustomer,
  createCustomRole,
  createService,
  createStaffMember,
  createTestTenant,
  createTestUser,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  randomTokenHex,
  safeMorningStart,
  sha256Hex,
  testDb,
  allPermissionKeys,
  type TestUser,
} from "./helpers";
import { DEFAULT_ROLE_KEYS, DEFAULT_ROLE_NAMES, expectedKeysFor } from "./default-role-matrix";

/**
 * Faz SAAS.1E.1 — the existing-tenant backfill (migration 20260921113340).
 *
 * The migration is executed HERE, as written, against DEV inside a
 * transaction that is always rolled back — nothing global ever commits from a
 * test. The interesting tenants are mirrors built to have the shape of the two
 * real production tenants at the time of release:
 *
 *   - "stale owner": one role, Salon Sahibi holding 19 of the 23 permissions
 *     (it predates four keys), one owner membership, two accepted invitations
 *     and some audit history;
 *   - "live salon": a complete Salon Sahibi (23/23) plus four staff members
 *     (one linked to the owner's membership, one inactive), customers and
 *     appointments;
 *
 * plus the edge cases the release must survive: an Owner an owner customized
 * (audit evidence), a save that changed nothing, a tenant that already has all
 * four roles, a soft-deleted tenant and display-name collisions.
 *
 * For each, the snapshot taken before, after one run and after a second run
 * proves what changed (roles, permission rows, audit) and what did not (every
 * membership, staff, customer, appointment, invitation row; auth users).
 */

const TAG = randomUUID().replace(/-/g, "").slice(0, 8);
const MIGRATION = path.join(process.cwd(), "supabase", "migrations", "20260921113340_backfill_default_roles.sql");
const BACKFILL_SQL = readFileSync(MIGRATION, "utf8");

// The four keys the stale owner is missing (a Salon Sahibi created before the schedules/services keys existed).
const MISSING_FROM_STALE_OWNER = ["schedules.manage", "schedules.view", "services.manage", "services.view"];

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`bf-${label}`);
  createdUserIds.push(user.id);
  return user;
}

async function newTenant(label: string, owner: TestUser) {
  const tenant = await createTestTenant(`test-tenant-bf-${label}-${TAG}`, owner.id);
  createdTenantIds.push(tenant.id);
  return tenant;
}

async function dropKeys(roleId: string, keys: string[]) {
  await testDb`delete from role_permissions where role_id = ${roleId} and permission_id in (select id from permissions where key in ${testDb(keys)})`;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

type RoleSnap = { id: string; key: string | null; name: string; system: boolean; customized_at: string | null; deleted: boolean; perms: string[] };
type AuditSnap = {
  id: string;
  action: string;
  actor_type: string;
  actor_user_id: string | null;
  entity_id: string | null;
  after: { added?: string[]; removed?: string[] } | null;
};
type TenantSnap = { roles: RoleSnap[]; fingerprints: Record<string, string>; audit: AuditSnap[] };
type Snap = { tenants: Record<string, TenantSnap>; authUsers: number; invitations: number; memberships: number };

const FINGERPRINTED = ["tenant_memberships", "staff_members", "customers", "appointments", "appointment_items", "team_invitations", "branches", "services"];

async function snapshotTenant(sql: TransactionSql, tenantId: string): Promise<TenantSnap> {
  const roles = await sql<RoleSnap[]>`
    select r.id, r.key, r.name, r.is_system_default as system, r.customized_at::text as customized_at, (r.deleted_at is not null) as deleted,
           coalesce((select array_agg(p.key order by p.key) from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = r.id), '{}') as perms
    from roles r where r.tenant_id = ${tenantId} order by r.key nulls last, r.name`;
  const fingerprints: Record<string, string> = {};
  for (const table of FINGERPRINTED) {
    const [row] = await sql.unsafe(`select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as h from public.${table} t where t.tenant_id = '${tenantId}'`);
    fingerprints[table] = String(row!.h);
  }
  const audit = await sql<AuditSnap[]>`
    select id, action, actor_type, actor_user_id, entity_id, after from audit_logs where tenant_id = ${tenantId} order by created_at, id`;
  return { roles: [...roles], fingerprints, audit: [...audit] };
}

async function snapshotAll(sql: TransactionSql, tenantIds: Record<string, string>): Promise<Snap> {
  const tenants: Record<string, TenantSnap> = {};
  for (const [label, id] of Object.entries(tenantIds)) tenants[label] = await snapshotTenant(sql, id);
  const [users] = await sql<{ n: number }[]>`select count(*)::int as n from auth.users`;
  const [invitations] = await sql<{ n: number }[]>`select count(*)::int as n from team_invitations`;
  const [memberships] = await sql<{ n: number }[]>`select count(*)::int as n from tenant_memberships`;
  return { tenants, authUsers: users!.n, invitations: invitations!.n, memberships: memberships!.n };
}

class RolledBack extends Error {
  constructor(public readonly payload: unknown) {
    super("rolled back on purpose");
  }
}

/** Runs `fn` in a transaction that is ALWAYS rolled back, returning what `fn` returned. */
async function inRolledBackTransaction<T>(fn: (sql: TransactionSql) => Promise<T>): Promise<T> {
  try {
    await testDb.begin(async (sql) => {
      throw new RolledBack(await fn(sql));
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.payload as T;
    throw error;
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ids: Record<string, string> = {}; // label -> tenant id
const ownerRole: Record<string, string> = {}; // label -> Owner role id
const ownerMembership: Record<string, string> = {}; // label -> owner membership id
const customRole: Record<string, string> = {}; // owner-created custom roles of the collision tenant
let catalog: string[];
let evidenceAt: string; // the audit timestamp planted for the customized owner
let before: Snap;
let first: Snap;
let second: Snap;
let deferredChecksPassed = false;

beforeAll(async () => {
  catalog = await allPermissionKeys();

  const membershipOf = async (tenantId: string, userId: string) =>
    (await testDb<{ id: string }[]>`select id from tenant_memberships where tenant_id = ${tenantId} and user_id = ${userId}`)[0]!.id;

  // --- stale owner: one role at 19/23, one owner membership, two accepted invitations, some audit history -----------
  {
    const owner = await newUser("stale-owner");
    const tenant = await newTenant("stale", owner);
    ids.stale = tenant.id;
    ownerRole.stale = tenant.ownerRoleId;
    await dropKeys(tenant.ownerRoleId, MISSING_FROM_STALE_OWNER);
    ownerMembership.stale = await membershipOf(tenant.id, owner.id);
    for (const label of ["stale-guest-1", "stale-guest-2"]) {
      const guest = await newUser(label);
      await testDb`
        insert into team_invitations (tenant_id, email, role_id, invited_by, status, token_hash, expires_at, accepted_at, accepted_by)
        values (${tenant.id}, ${`${label}-${TAG}@example.com`}, ${tenant.ownerRoleId}, ${owner.id}, 'accepted', ${sha256Hex(randomTokenHex())},
                now() + interval '7 days', now(), ${guest.id})`;
    }
    await testDb`
      insert into audit_logs (tenant_id, actor_user_id, actor_type, action, entity_type, entity_id)
      values (${tenant.id}, ${owner.id}, 'user', 'tenant.created', 'tenant', ${tenant.id}),
             (${tenant.id}, ${owner.id}, 'user', 'team.invitation_accepted', 'team_invitation', ${randomUUID()})`;
  }

  // --- live salon: complete Owner, four staff (one linked, one inactive), customers, appointments ------------------
  {
    const owner = await newUser("live-owner");
    const tenant = await newTenant("live", owner);
    ids.live = tenant.id;
    ownerRole.live = tenant.ownerRoleId;
    ownerMembership.live = await membershipOf(tenant.id, owner.id);
    const branch = await createBranch(tenant.id, "Merkez");
    const service = await createService(tenant.id, "Saç Kesimi", 30, 250);
    await linkServiceBranch(service.id, branch);
    const staff = [];
    for (const name of ["Personel Bir", "Personel İki", "Personel Üç", "Personel Dört"]) {
      const s = await createStaffMember(tenant.id, name);
      await linkStaffBranch(s.id, branch);
      await linkStaffService(s.id, service.id);
      staff.push(s);
    }
    await testDb`update staff_members set tenant_membership_id = ${ownerMembership.live} where id = ${staff[0]!.id}`;
    await testDb`update staff_members set status = 'inactive' where id = ${staff[3]!.id}`;
    const customers = [];
    for (const name of ["Müşteri A", "Müşteri B", "Müşteri C"]) customers.push(await createCustomer(tenant.id, name));
    for (const [i, c] of customers.slice(0, 2).entries()) {
      const start = new Date(safeMorningStart(2).getTime() + i * 3600_000);
      const end = new Date(start.getTime() + 30 * 60_000);
      const [appt] = await testDb<{ id: string }[]>`
        insert into appointments (tenant_id, branch_id, customer_id, source, scheduled_start_at, scheduled_end_at, status, created_by)
        values (${tenant.id}, ${branch}, ${c.id}, 'internal', ${start.toISOString()}, ${end.toISOString()}, 'scheduled', ${owner.id}) returning id`;
      await testDb`
        insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
        values (${tenant.id}, ${appt!.id}, ${service.id}, ${staff[i]!.id}, ${start.toISOString()}, ${end.toISOString()}, 30, 250, 1)`;
    }
  }

  // --- an Owner an owner customized on purpose: audit evidence of a REAL change -----------------------------------
  {
    const owner = await newUser("edited-owner");
    const tenant = await newTenant("edited", owner);
    ids.edited = tenant.id;
    ownerRole.edited = tenant.ownerRoleId;
    const removed = ["reports.financial", "inventory.manage"];
    const heldBefore = [...catalog].sort();
    await dropKeys(tenant.ownerRoleId, removed);
    const heldAfter = heldBefore.filter((k) => !removed.includes(k));
    const [row] = await testDb<{ created_at: string }[]>`
      insert into audit_logs (tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, before, after, created_at)
      values (${tenant.id}, ${owner.id}, 'user', 'role.permissions_updated', 'role', ${tenant.ownerRoleId},
              ${testDb.json({ permissions: heldBefore })}, ${testDb.json({ permissions: heldAfter })}, now() - interval '3 days')
      returning created_at::text as created_at`;
    evidenceAt = row!.created_at;
  }

  // --- a save that changed nothing (same SET, different order) — NOT evidence of customization -------------------
  {
    const owner = await newUser("noop-owner");
    const tenant = await newTenant("noop", owner);
    ids.noop = tenant.id;
    ownerRole.noop = tenant.ownerRoleId;
    await dropKeys(tenant.ownerRoleId, ["reports.staff"]);
    const held = catalog.filter((k) => k !== "reports.staff");
    await testDb`
      insert into audit_logs (tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, before, after, created_at)
      values (${tenant.id}, ${owner.id}, 'user', 'role.permissions_updated', 'role', ${tenant.ownerRoleId},
              ${testDb.json({ permissions: [...held].sort() })}, ${testDb.json({ permissions: [...held].sort().reverse() })}, now() - interval '2 days')`;
  }

  // --- a tenant that already has all four roles (created the normal way) ------------------------------------------
  {
    const owner = await newUser("complete-owner");
    const tenantId = await asAuthenticatedUser(owner.id, async (sql) => {
      const [row] = await sql<{ id: string }[]>`select public.create_tenant(${"Backfill Complete"}, ${`bf-complete-${TAG}`}) as id`;
      return row!.id;
    });
    createdTenantIds.push(tenantId);
    ids.complete = tenantId;
  }

  // --- a soft-deleted tenant ---------------------------------------------------------------------------------------
  {
    const owner = await newUser("deleted-owner");
    const tenant = await newTenant("deleted", owner);
    ids.deleted = tenant.id;
    await testDb`update tenants set deleted_at = now() where id = ${tenant.id}`;
  }

  // --- display-name collisions: custom roles that already use two of the standard names ---------------------------
  {
    const owner = await newUser("collision-owner");
    const tenant = await newTenant("collision", owner);
    ids.collision = tenant.id;
    ownerRole.collision = tenant.ownerRoleId;
    customRole.manager = await createCustomRole(tenant.id, "Yönetici", ["appointments.view", "staff.view"]);
    customRole.personel = await createCustomRole(tenant.id, "Personel", ["appointments.view", "customers.view"]);
  }

  // --- run the migration, exactly as written, twice, inside a transaction that is always rolled back --------------
  const snapshots = await inRolledBackTransaction(async (sql) => {
    const b = await snapshotAll(sql, ids);
    await sql.unsafe(BACKFILL_SQL);
    // The deferred last-unrestricted-holder / role-integrity constraint triggers must be satisfied by what the migration did.
    await sql`set constraints all immediate`;
    deferredChecksPassed = true;
    const f = await snapshotAll(sql, ids);
    await sql.unsafe(BACKFILL_SQL);
    const s = await snapshotAll(sql, ids);
    return { b, f, s };
  });
  before = snapshots.b;
  first = snapshots.f;
  second = snapshots.s;
}, 240000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 120000);

const rolesByKey = (snap: TenantSnap) => Object.fromEntries(snap.roles.filter((r) => r.key && !r.deleted).map((r) => [r.key!, r]));
const newAudit = (a: TenantSnap, b: TenantSnap) => b.audit.filter((row) => !a.audit.some((old) => old.id === row.id));
const sortedCatalog = () => [...catalog].sort();

// ---------------------------------------------------------------------------
// The migration itself
// ---------------------------------------------------------------------------

describe("the backfill migration", () => {
  it("ran to completion, and every deferred constraint (last unrestricted holder, role integrity) holds afterwards", () => {
    expect(deferredChecksPassed).toBe(true);
    expect(BACKFILL_SQL).toContain("provision_default_roles");
    expect(BACKFILL_SQL).toContain("sync_pristine_default_roles(null, false, null)"); // additive, never the removing form
  });

  it("does not, anywhere, create users, invitations or memberships", () => {
    for (const run of [first, second]) {
      expect(run.authUsers).toBe(before.authUsers);
      expect(run.invitations).toBe(before.invitations);
      expect(run.memberships).toBe(before.memberships);
    }
  });

  it("is idempotent: a second run changes nothing at all — no role, no permission row, no audit row", () => {
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// The stale-owner tenant (Owner 19/23, one role)
// ---------------------------------------------------------------------------

describe("stale owner: one role with 19 of 23 permissions", () => {
  it("starts as one role, Salon Sahibi, missing exactly the four keys", () => {
    const roles = before.tenants.stale!.roles;
    expect(roles).toHaveLength(1);
    expect(roles[0]!.perms).toEqual(sortedCatalog().filter((k) => !MISSING_FROM_STALE_OWNER.includes(k)));
    expect(roles[0]!.perms).toHaveLength(19);
  });

  it("ends with the four primary roles, exactly their matrix sets, all pristine", () => {
    const after = first.tenants.stale!;
    expect(after.roles.filter((r) => !r.deleted)).toHaveLength(4);
    const byKey = rolesByKey(after);
    expect(Object.keys(byKey).sort()).toEqual([...DEFAULT_ROLE_KEYS]);
    for (const key of DEFAULT_ROLE_KEYS) {
      expect(byKey[key]!.name, key).toBe(DEFAULT_ROLE_NAMES[key]);
      expect(byKey[key]!.perms, key).toEqual(expectedKeysFor(key, catalog));
      expect(byKey[key]!.system, key).toBe(true);
      expect(byKey[key]!.customized_at, key).toBeNull();
    }
  });

  it("the Salon Sahibi is the SAME role row (same id), now 23/23, and the owner's membership was neither recreated nor changed", () => {
    const owner = rolesByKey(first.tenants.stale!).SALON_OWNER!;
    expect(owner.id).toBe(ownerRole.stale);
    expect(owner.perms).toHaveLength(23);
    expect(first.tenants.stale!.fingerprints.tenant_memberships).toBe(before.tenants.stale!.fingerprints.tenant_memberships);
    expect(first.tenants.stale!.fingerprints.team_invitations).toBe(before.tenants.stale!.fingerprints.team_invitations);
  });

  it("writes exactly: three role.provisioned rows and one role.template_synced row (adding the four keys) — all by the system", () => {
    const added = newAudit(before.tenants.stale!, first.tenants.stale!);
    expect(added.map((a) => a.action).sort()).toEqual(["role.provisioned", "role.provisioned", "role.provisioned", "role.template_synced"]);
    for (const row of added) expect(row).toMatchObject({ actor_type: "system", actor_user_id: null });
    const synced = added.find((a) => a.action === "role.template_synced")!;
    expect(synced.entity_id).toBe(ownerRole.stale);
    expect(synced.after?.added).toEqual(MISSING_FROM_STALE_OWNER);
    expect(synced.after?.removed).toEqual([]);
    // history that was already there is untouched
    for (const old of before.tenants.stale!.audit) expect(first.tenants.stale!.audit).toContainEqual(old);
  });

  it("leaves every other row of the tenant untouched (memberships, staff, customers, appointments, invitations, branches, services)", () => {
    expect(first.tenants.stale!.fingerprints).toEqual(before.tenants.stale!.fingerprints);
  });
});

// ---------------------------------------------------------------------------
// The live salon (Owner 23/23, staff, customers, appointments)
// ---------------------------------------------------------------------------

describe("live salon: a complete Owner with staff, customers and appointments", () => {
  it("Salon Sahibi is unchanged — same row, same permissions, no sync audit — and exactly three roles are added", () => {
    const b = before.tenants.live!;
    const a = first.tenants.live!;
    expect(b.roles).toHaveLength(1);
    expect(a.roles.filter((r) => !r.deleted)).toHaveLength(4);
    const ownerBefore = b.roles[0]!;
    const ownerAfter = rolesByKey(a).SALON_OWNER!;
    expect(ownerAfter).toEqual(ownerBefore);
    expect(ownerAfter.id).toBe(ownerRole.live);
    const added = newAudit(b, a);
    expect(added.map((x) => x.action)).toEqual(["role.provisioned", "role.provisioned", "role.provisioned"]);
    expect(added.every((x) => x.entity_id !== ownerRole.live)).toBe(true);
  });

  it("the three new roles hold exactly the Yönetici / Resepsiyon / Personel sets", () => {
    const byKey = rolesByKey(first.tenants.live!);
    for (const key of ["SALON_MANAGER", "RECEPTIONIST", "STYLIST"]) {
      expect(byKey[key]!.name, key).toBe(DEFAULT_ROLE_NAMES[key]);
      expect(byKey[key]!.perms, key).toEqual(expectedKeysFor(key, catalog));
    }
    expect(byKey.STYLIST!.perms).toEqual(["appointments.view"]);
  });

  it("no staff row is modified — the linked staff member stays linked to the same membership, the inactive one stays inactive", () => {
    expect(first.tenants.live!.fingerprints.staff_members).toBe(before.tenants.live!.fingerprints.staff_members);
    expect(first.tenants.live!.fingerprints).toEqual(before.tenants.live!.fingerprints);
  });

  it("the live salon's real membership rows are byte-identical (no recreation, no role change)", () => {
    expect(first.tenants.live!.fingerprints.tenant_memberships).toBe(before.tenants.live!.fingerprints.tenant_memberships);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("customization evidence decides what the backfill may touch", () => {
  it("an Owner with an audit-evidenced REAL change is marked customized (at the first change's time) and is NOT synced", () => {
    const owner = rolesByKey(first.tenants.edited!).SALON_OWNER!;
    expect(owner.customized_at).not.toBeNull();
    expect(owner.customized_at).toBe(evidenceAt);
    expect(owner.perms).toEqual(before.tenants.edited!.roles[0]!.perms); // still without its two removed keys
    expect(owner.perms).toHaveLength(21);
    expect(newAudit(before.tenants.edited!, first.tenants.edited!).map((a) => a.action)).toEqual(["role.provisioned", "role.provisioned", "role.provisioned"]);
    // Its three siblings are created pristine.
    const byKey = rolesByKey(first.tenants.edited!);
    for (const key of ["SALON_MANAGER", "RECEPTIONIST", "STYLIST"]) expect(byKey[key]!.customized_at, key).toBeNull();
  });

  it("a saved-without-change audit row is not evidence: that Owner stays pristine and DOES receive its missing key", () => {
    const owner = rolesByKey(first.tenants.noop!).SALON_OWNER!;
    expect(owner.customized_at).toBeNull();
    expect(owner.perms).toEqual(sortedCatalog());
    expect(newAudit(before.tenants.noop!, first.tenants.noop!).map((a) => a.action).sort()).toEqual([
      "role.provisioned", "role.provisioned", "role.provisioned", "role.template_synced",
    ]);
  });
});

describe("tenants that need nothing, or must not be touched", () => {
  it("a tenant that already has the four roles is left exactly as it was — no change, no audit row", () => {
    expect(first.tenants.complete).toEqual(before.tenants.complete);
    expect(before.tenants.complete!.roles.filter((r) => !r.deleted)).toHaveLength(4);
  });

  it("a soft-deleted tenant gets no roles provisioned", () => {
    expect(first.tenants.deleted!.roles.filter((r) => !r.deleted)).toHaveLength(1);
    expect(newAudit(before.tenants.deleted!, first.tenants.deleted!).filter((a) => a.action === "role.provisioned")).toEqual([]);
  });

  it("owner-created custom roles named like the standard ones are untouched; the provisioned roles take the deterministic suffix", () => {
    const b = before.tenants.collision!;
    const a = first.tenants.collision!;
    for (const id of [customRole.manager!, customRole.personel!]) {
      expect(a.roles.find((r) => r.id === id)).toEqual(b.roles.find((r) => r.id === id));
    }
    const byKey = rolesByKey(a);
    expect(byKey.SALON_MANAGER!.name).toBe("Yönetici (varsayılan)");
    expect(byKey.STYLIST!.name).toBe("Personel (varsayılan)");
    expect(byKey.RECEPTIONIST!.name).toBe("Resepsiyon");
    expect(byKey.SALON_MANAGER!.perms).toEqual(expectedKeysFor("SALON_MANAGER", catalog));
    expect(byKey.STYLIST!.perms).toEqual(["appointments.view"]);
  });
});
