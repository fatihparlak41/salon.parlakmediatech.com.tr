import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  asAuthenticatedUser,
  attemptAs,
  cleanupTenants,
  cleanupUsers,
  createTestTenant,
  createTestUser,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1E.1 — full audit-log read requires permissions.manage_unrestricted.
 *
 * audit_logs_select_scoped previously let ANY staff.manage holder — in
 * practice every Yönetici — read the entire tenant audit log: rows recording
 * staff members' e-mail/phone via the audit trigger's to_jsonb(old/new),
 * every role/permission/membership change including the Owner's own, and
 * every customer/invitation event. A Yönetici manages the team; that does
 * not make them the tenant's auditor. No new permission was introduced — the
 * existing permissions.manage_unrestricted (the one permission that already
 * means "the Owner") is the gate. audit_logs keeps zero write grant for
 * authenticated either way (append-only, untouched by this change) — every
 * row is still written exclusively by SECURITY DEFINER functions.
 */

const TAG = randomUUID().slice(0, 8);
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`alp-${label}`);
  createdUserIds.push(user.id);
  return user;
}

async function provisionedRoles(tenantId: string): Promise<Record<string, string>> {
  await testDb`select * from private.provision_default_roles(${tenantId}::uuid)`;
  const rows = await testDb<{ id: string; key: string }[]>`select id, key from roles where tenant_id = ${tenantId} and deleted_at is null`;
  return Object.fromEntries(rows.map((r) => [r.key, r.id]));
}

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 120000);

describe("audit_logs — read requires permissions.manage_unrestricted, not merely staff.manage", () => {
  let tenant: TestTenant;
  const users: Record<string, TestUser> = {};
  const role: Record<string, string> = {};

  beforeAll(async () => {
    users.owner = await newUser("owner");
    tenant = await createTestTenant(`test-tenant-alp-${TAG}`, users.owner!.id);
    createdTenantIds.push(tenant.id);
    Object.assign(role, await provisionedRoles(tenant.id));
    for (const [label, key] of [["manager", "SALON_MANAGER"], ["reception", "RECEPTIONIST"], ["personel", "STYLIST"]] as const) {
      users[label] = await newUser(label);
      await addMembership(tenant.id, users[label]!.id, role[key]!);
    }
    // Guaranteed non-empty audit trail: the tenant itself, plus one role edit by the Owner.
    await attemptAs(users.owner!.id, (sql) => sql`select public.update_role_permissions(${role.STYLIST!}::uuid, ${sql.array(["appointments.view"], 1009)}::text[])`);
  }, 120000);

  const readAudit = (userId: string) => asAuthenticatedUser(userId, (sql) => sql<{ id: string; action: string }[]>`select id, action from audit_logs where tenant_id = ${tenant.id}`);

  it("Owner (unrestricted) reads every tenant audit row, non-empty", async () => {
    // createTestTenant is a direct-insert fixture (not the create_tenant
    // RPC), so it writes no tenant.created row itself — the guaranteed,
    // non-empty signal here is the role.permissions_updated edit made in
    // beforeAll.
    const rows = await readAudit(users.owner!.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.action)).toContain("role.permissions_updated");
  });

  it("Manager, Receptionist and Personel — none unrestricted — read ZERO audit rows, even though Manager holds staff.manage", async () => {
    expect(await readAudit(users.manager!.id)).toEqual([]);
    expect(await readAudit(users.reception!.id)).toEqual([]);
    expect(await readAudit(users.personel!.id)).toEqual([]);
  });

  it("a custom role with permissions.manage_unrestricted (even without staff.manage) can still read the log — the gate is the permission, not the role", async () => {
    const auditorOnly = await testDb<{ id: string }[]>`insert into roles (tenant_id, name, is_system_default) values (${tenant.id}, 'Sadece Denetim', false) returning id`;
    await testDb`insert into role_permissions (role_id, permission_id) select ${auditorOnly[0]!.id}, id from permissions where key = 'permissions.manage_unrestricted'`;
    const auditor = await newUser("auditor-only");
    await addMembership(tenant.id, auditor.id, auditorOnly[0]!.id);
    const rows = await readAudit(auditor.id);
    expect(rows.length).toBeGreaterThan(0);
  }, 60000);

  it("select * is refused for nobody at the column level (every column is grant-readable) — the ROW policy is what scopes it", async () => {
    const starOwner = await attemptAs(users.owner!.id, (sql) => sql`select * from audit_logs where tenant_id = ${tenant.id} limit 1`);
    const starManager = await attemptAs(users.manager!.id, (sql) => sql`select * from audit_logs where tenant_id = ${tenant.id} limit 1`);
    expect(starOwner).toEqual({ ok: true });
    expect(starManager).toEqual({ ok: true }); // succeeds syntactically; RLS simply returns nothing
  });

  it("cross-tenant: a Manager holding staff.manage in tenant A cannot read tenant B's audit log even indirectly", async () => {
    const otherOwner = await newUser("other-owner");
    const other = await createTestTenant(`test-tenant-alp-other-${TAG}`, otherOwner.id);
    createdTenantIds.push(other.id);
    const rows = await asAuthenticatedUser(users.manager!.id, (sql) => sql<{ id: string }[]>`select id from audit_logs where tenant_id = ${other.id}`);
    expect(rows).toEqual([]);
  }, 60000);

  it("platform-level rows (tenant_id IS NULL) are unaffected — still platform-admin-only, unchanged by this migration", async () => {
    const rows = await asAuthenticatedUser(users.owner!.id, (sql) => sql<{ id: string }[]>`select id from audit_logs where tenant_id is null limit 1`);
    expect(rows).toEqual([]); // this tenant's Owner is not a platform admin
  });

  it("no normal Manager application path depended on direct audit access — the Team/staff screens never query audit_logs", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    function walk(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        if (["node_modules", ".next", ".git"].includes(entry)) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
      }
      return out;
    }
    const files = ["app", "components", "lib"].flatMap((d) => walk(path.join(process.cwd(), d)));
    const offenders = files.filter((f) => /\.from\(\s*["']audit_logs["']\s*\)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("audit writing is unchanged: authenticated still has zero INSERT/UPDATE/DELETE grant on audit_logs", async () => {
    const insertAttempt = await attemptAs(users.owner!.id, (sql) => sql`insert into audit_logs (tenant_id, action, entity_type) values (${tenant.id}, 'forged', 'x')`);
    expect(insertAttempt).toMatchObject({ ok: false, message: expect.stringContaining("permission denied") });
    // A real write still happens (through the SECURITY DEFINER path) for the next role edit.
    const before = (await readAudit(users.owner!.id)).length;
    await attemptAs(users.owner!.id, (sql) => sql`select public.update_role_permissions(${role.STYLIST!}::uuid, ${sql.array(["appointments.view", "customers.view"], 1009)}::text[])`);
    expect((await readAudit(users.owner!.id)).length).toBeGreaterThan(before);
  }, 60000);
});

describe("subscriptions / tenant_features — the same migration also narrows these to unrestricted-only", () => {
  let tenant: TestTenant;
  const users: Record<string, TestUser> = {};
  const role: Record<string, string> = {};

  beforeAll(async () => {
    users.owner = await newUser("billing-owner");
    tenant = await createTestTenant(`test-tenant-alp-billing-${TAG}`, users.owner!.id);
    createdTenantIds.push(tenant.id);
    Object.assign(role, await provisionedRoles(tenant.id));
    users.manager = await newUser("billing-manager");
    await addMembership(tenant.id, users.manager!.id, role.SALON_MANAGER!);
  }, 90000);

  it("subscriptions: Owner reads (if a row exists), Manager reads nothing", async () => {
    const asManager = await asAuthenticatedUser(users.manager!.id, (sql) => sql<{ id: string }[]>`select id from subscriptions where tenant_id = ${tenant.id}`);
    expect(asManager).toEqual([]);
    const starAttempt = await attemptAs(users.manager!.id, (sql) => sql`select * from subscriptions where tenant_id = ${tenant.id}`);
    expect(starAttempt).toEqual({ ok: true }); // grant-readable, just row-filtered to nothing
  });

  it("tenant_features: Owner reads (if a row exists), Manager reads nothing", async () => {
    const asManager = await asAuthenticatedUser(users.manager!.id, (sql) => sql<{ id: string }[]>`select id from tenant_features where tenant_id = ${tenant.id}`);
    expect(asManager).toEqual([]);
  });

  it("no application code reads either table directly (both go through SECURITY DEFINER RPCs/feature checks)", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    function walk(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        if (["node_modules", ".next", ".git"].includes(entry)) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
      }
      return out;
    }
    const files = ["app", "components", "lib"].flatMap((d) => walk(path.join(process.cwd(), d)));
    const offenders = files.filter((f) => /\.from\(\s*["'](subscriptions|tenant_features)["']\s*\)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
