import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  attemptAs,
  cleanupTenants,
  cleanupUsers,
  createCustomRole,
  createTestTenant,
  createTestUser,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1E.1 — system-default role drift management:
 * roles.customized_at (the durable "an owner changed this role on purpose"
 * marker), private.role_template_drift (the read-only report) and
 * private.sync_pristine_default_roles (the only thing that ever pushes a
 * template change into existing roles — and only into PRISTINE ones).
 *
 * The templates themselves are shared, global reference data: these tests
 * never modify them. Template drift is simulated on a tenant's own
 * role_permissions rows instead (a key missing = the template gained it; a
 * key extra = the template lost it), which is exactly what the sync sees.
 */

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

async function newUser(label: string): Promise<TestUser> {
  const user = await createTestUser(`sdrift-${label}`);
  createdUserIds.push(user.id);
  return user;
}

type Fixture = { tenant: TestTenant; owner: TestUser; roleId: Record<string, string> };

/** A tenant with its unrestricted owner and the four primary roles. */
async function newFixture(label: string): Promise<Fixture> {
  const owner = await newUser(`${label}-owner`);
  const tenant = await createTestTenant(`test-tenant-sdrift-${label}-${randomUUID().slice(0, 6)}`, owner.id);
  createdTenantIds.push(tenant.id);
  await testDb`select * from private.provision_default_roles(${tenant.id}::uuid)`;
  const rows = await testDb<{ id: string; key: string }[]>`select id, key from roles where tenant_id = ${tenant.id} and deleted_at is null`;
  return { tenant, owner, roleId: Object.fromEntries(rows.map((r) => [r.key, r.id])) };
}

async function keysOf(roleId: string): Promise<string[]> {
  return (
    await testDb<{ key: string }[]>`select p.key from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = ${roleId} order by p.key`
  ).map((r) => r.key);
}

async function removeKey(roleId: string, key: string) {
  await testDb`delete from role_permissions where role_id = ${roleId} and permission_id = (select id from permissions where key = ${key})`;
}

async function addKey(roleId: string, key: string) {
  await testDb`insert into role_permissions (role_id, permission_id) select ${roleId}, id from permissions where key = ${key}`;
}

const customizedAt = async (roleId: string) =>
  (await testDb<{ c: string | null }[]>`select customized_at::text as c from roles where id = ${roleId}`)[0]!.c;

type DriftRow = {
  drift_role_id: string;
  drift_role_key: string;
  is_customized: boolean;
  drift_state: string;
  missing_keys: string[];
  extra_keys: string[];
};

const drift = async (tenantId: string) =>
  await testDb<DriftRow[]>`select drift_role_id, drift_role_key, is_customized, drift_state, missing_keys, extra_keys
                           from private.role_template_drift(${tenantId}::uuid) order by drift_role_key`;

type SyncRow = { synced_role_id: string; synced_role_key: string; added_keys: string[]; removed_keys: string[] };

const syncTenant = async (tenantId: string, removeExtra = false, templateKey: string | null = null) =>
  await testDb<SyncRow[]>`
    select synced_role_id, synced_role_key, added_keys, removed_keys
    from private.sync_pristine_default_roles(${tenantId}::uuid, ${removeExtra}::boolean, ${templateKey}::text)
    order by synced_role_key`;

/** The jsonb payload of role.permissions_updated / role.template_synced audit rows. */
type AuditPayload = { permissions: string[]; added?: string[]; removed?: string[]; remove_extra?: boolean };

const auditRowsFor = async (tenantId: string, action: string, roleId?: string) =>
  await testDb<{ id: string; actor_type: string; actor_user_id: string | null; before: AuditPayload; after: AuditPayload }[]>`
    select id, actor_type, actor_user_id, before, after from audit_logs
    where tenant_id = ${tenantId} and action = ${action} ${roleId ? testDb`and entity_id = ${roleId}` : testDb``}
    order by created_at, id`;

const editRole = (caller: string, roleId: string, keys: string[]) =>
  attemptAs(caller, (sql) => sql`select public.update_role_permissions(${roleId}::uuid, ${sql.array(keys, 1009)}::text[])`);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 120000);

// ---------------------------------------------------------------------------
// The durable customization marker
// ---------------------------------------------------------------------------

describe("roles.customized_at — the durable 'an owner changed this' marker", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await newFixture("marker");
  }, 60000);

  it("a freshly provisioned system-default role is pristine and in sync with its template", async () => {
    for (const key of ["SALON_OWNER", "SALON_MANAGER", "RECEPTIONIST", "STYLIST"]) {
      expect(await customizedAt(fx.roleId[key]!), key).toBeNull();
    }
    const report = await drift(fx.tenant.id);
    expect(report.map((r) => `${r.drift_role_key}:${r.drift_state}`)).toEqual([
      "RECEPTIONIST:in_sync", "SALON_MANAGER:in_sync", "SALON_OWNER:in_sync", "STYLIST:in_sync",
    ]);
    for (const r of report) expect([r.missing_keys, r.extra_keys, r.is_customized], r.drift_role_key).toEqual([[], [], false]);
  });

  it("an edit that changes nothing does not mark the role", async () => {
    expect(await editRole(fx.owner.id, fx.roleId.STYLIST!, ["appointments.view"])).toEqual({ ok: true });
    expect(await customizedAt(fx.roleId.STYLIST!)).toBeNull();
    expect((await drift(fx.tenant.id)).find((r) => r.drift_role_key === "STYLIST")!.drift_state).toBe("in_sync");
  });

  it("an ordinary Manager cannot edit a system-default role at all — and the marker stays clean", async () => {
    const manager = await newUser("marker-manager");
    await addMembership(fx.tenant.id, manager.id, fx.roleId.SALON_MANAGER!);
    for (const key of ["SALON_MANAGER", "RECEPTIONIST", "STYLIST", "SALON_OWNER"]) {
      expect(await editRole(manager.id, fx.roleId[key]!, ["appointments.view"]), key).toMatchObject({
        ok: false,
        message: "system_role_edit_not_permitted",
      });
      expect(await customizedAt(fx.roleId[key]!), key).toBeNull();
    }
  }, 60000);

  it("the unrestricted owner changing a system-default role sets the marker — on that role only", async () => {
    expect(await editRole(fx.owner.id, fx.roleId.STYLIST!, ["appointments.view", "customers.view"])).toEqual({ ok: true });

    const marker = await customizedAt(fx.roleId.STYLIST!);
    expect(marker).not.toBeNull();
    for (const key of ["SALON_OWNER", "SALON_MANAGER", "RECEPTIONIST"]) {
      expect(await customizedAt(fx.roleId[key]!), key).toBeNull();
    }
    const [row] = (await drift(fx.tenant.id)).filter((r) => r.drift_role_key === "STYLIST");
    expect(row).toMatchObject({ is_customized: true, drift_state: "customized_drift", missing_keys: [], extra_keys: ["customers.view"] });

    // The change is auditable through the existing role audit trail as well. (The earlier no-op save
    // was audited too — update_role_permissions has always audited every call — so it is the LAST row
    // that carries this change.)
    const audit = await auditRowsFor(fx.tenant.id, "role.permissions_updated", fx.roleId.STYLIST!);
    expect(audit).toHaveLength(2);
    const last = audit[audit.length - 1]!;
    expect(last).toMatchObject({ actor_user_id: fx.owner.id, actor_type: "user" });
    expect(last.before.permissions).toEqual(["appointments.view"]);
    expect(last.after.permissions).toEqual(["appointments.view", "customers.view"]);
  }, 60000);

  it("the marker is never cleared: editing the role back to the exact template set leaves it 'customized_in_sync'", async () => {
    const before = await customizedAt(fx.roleId.STYLIST!);
    expect(await editRole(fx.owner.id, fx.roleId.STYLIST!, ["appointments.view"])).toEqual({ ok: true });
    expect(await customizedAt(fx.roleId.STYLIST!)).toBe(before); // coalesce(customized_at, now()) — the FIRST edit time is kept
    const [row] = (await drift(fx.tenant.id)).filter((r) => r.drift_role_key === "STYLIST");
    expect(row).toMatchObject({ is_customized: true, drift_state: "customized_in_sync", missing_keys: [], extra_keys: [] });
  }, 60000);

  it("editing an owner-created custom role never sets the marker, and custom roles never appear in the drift report", async () => {
    const custom = await createCustomRole(fx.tenant.id, "Kuaför Ustası", ["appointments.view"]);
    expect(await editRole(fx.owner.id, custom, ["appointments.view", "appointments.update"])).toEqual({ ok: true });
    expect(await customizedAt(custom)).toBeNull();
    expect((await drift(fx.tenant.id)).map((r) => r.drift_role_id)).not.toContain(custom);
  }, 60000);

  it("the database refuses a marker on a role that is not a system default (the two can never disagree)", async () => {
    const custom = await createCustomRole(fx.tenant.id, "Sahte İşaretli", ["appointments.view"]);
    await expect(testDb`update roles set customized_at = now() where id = ${custom}`).rejects.toMatchObject({
      code: "23514",
      constraint_name: "roles_customized_requires_system_default",
    });
  });
});

// ---------------------------------------------------------------------------
// The drift report
// ---------------------------------------------------------------------------

describe("private.role_template_drift — detectable and reportable", () => {
  let fx: Fixture;
  let other: Fixture;

  beforeAll(async () => {
    fx = await newFixture("report");
    other = await newFixture("report-other");
  }, 90000);

  it("reports a pristine role that lacks a template key as pristine_missing, naming the key", async () => {
    await removeKey(fx.roleId.RECEPTIONIST!, "services.view");
    const row = (await drift(fx.tenant.id)).find((r) => r.drift_role_key === "RECEPTIONIST")!;
    expect(row).toMatchObject({ is_customized: false, drift_state: "pristine_missing", missing_keys: ["services.view"], extra_keys: [] });
  });

  it("reports a pristine role that holds more than its template as pristine_extra, naming the key", async () => {
    await addKey(fx.roleId.STYLIST!, "customers.view");
    const row = (await drift(fx.tenant.id)).find((r) => r.drift_role_key === "STYLIST")!;
    expect(row).toMatchObject({ is_customized: false, drift_state: "pristine_extra", missing_keys: [], extra_keys: ["customers.view"] });
  });

  it("is tenant-scoped: one tenant's drift never shows in another's report", async () => {
    const otherReport = await drift(other.tenant.id);
    expect(otherReport.every((r) => r.drift_state === "in_sync")).toBe(true);
    expect(otherReport).toHaveLength(4);
  });

  it("without a tenant argument it reports every tenant (the operator view) and the detached two show up in it", async () => {
    const all = await testDb<{ drift_tenant_id: string; drift_role_key: string; drift_state: string }[]>`
      select drift_tenant_id, drift_role_key, drift_state from private.role_template_drift() where drift_tenant_id in (${fx.tenant.id}, ${other.tenant.id})`;
    expect(all.filter((r) => r.drift_tenant_id === fx.tenant.id && r.drift_state !== "in_sync").map((r) => r.drift_role_key).sort()).toEqual(["RECEPTIONIST", "STYLIST"]);
    expect(all.filter((r) => r.drift_tenant_id === other.tenant.id)).toHaveLength(4);
  });

  it("ignores soft-deleted roles, custom roles and system roles whose key has no template", async () => {
    const legacy = await createCustomRole(fx.tenant.id, "Eski Sistem Rolü", ["appointments.view"], { key: "LEGACY_NO_TEMPLATE", isSystemDefault: true });
    const deleted = await createCustomRole(fx.tenant.id, "Silinmiş Yönetici", ["appointments.view"], { key: "TEMP_DELETED", isSystemDefault: true });
    await testDb`update roles set deleted_at = now() where id = ${deleted}`;
    const ids = (await drift(fx.tenant.id)).map((r) => r.drift_role_id);
    expect(ids).not.toContain(legacy);
    expect(ids).not.toContain(deleted);
    expect(ids).toHaveLength(4);
  }, 60000);

  it("is read-only: reporting changes no role, no permission and writes no audit row", async () => {
    const before = await testDb<{ n: number }[]>`select count(*)::int as n from audit_logs where tenant_id = ${fx.tenant.id}`;
    const keysBefore = await keysOf(fx.roleId.RECEPTIONIST!);
    await drift(fx.tenant.id);
    await drift(fx.tenant.id);
    expect(await keysOf(fx.roleId.RECEPTIONIST!)).toEqual(keysBefore);
    const after = await testDb<{ n: number }[]>`select count(*)::int as n from audit_logs where tenant_id = ${fx.tenant.id}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

// ---------------------------------------------------------------------------
// The pristine-only sync
// ---------------------------------------------------------------------------

describe("private.sync_pristine_default_roles — pristine roles follow the template, customized roles never do", () => {
  it("adds a missing template key to a pristine role, audits it as the system, and a second run is a no-op", async () => {
    const fx = await newFixture("sync-add");
    await removeKey(fx.roleId.RECEPTIONIST!, "services.view");
    await removeKey(fx.roleId.RECEPTIONIST!, "schedules.view");

    const first = await syncTenant(fx.tenant.id);
    expect(first).toEqual([
      { synced_role_id: fx.roleId.RECEPTIONIST, synced_role_key: "RECEPTIONIST", added_keys: ["schedules.view", "services.view"], removed_keys: [] },
    ]);
    expect(await keysOf(fx.roleId.RECEPTIONIST!)).toEqual(
      ["appointments.cancel", "appointments.create", "appointments.update", "appointments.view", "customers.create", "customers.update", "customers.view", "schedules.view", "services.view"],
    );
    expect(await customizedAt(fx.roleId.RECEPTIONIST!)).toBeNull(); // syncing is not customizing

    const audit = await auditRowsFor(fx.tenant.id, "role.template_synced", fx.roleId.RECEPTIONIST!);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: "system", actor_user_id: null });
    expect(audit[0]!.after).toMatchObject({ added: ["schedules.view", "services.view"], removed: [], remove_extra: false });
    expect(audit[0]!.before.permissions).toHaveLength(7);
    expect(audit[0]!.after.permissions).toHaveLength(9);

    expect(await syncTenant(fx.tenant.id)).toEqual([]);
    expect(await auditRowsFor(fx.tenant.id, "role.template_synced")).toHaveLength(1);
    expect((await drift(fx.tenant.id)).every((r) => r.drift_state === "in_sync")).toBe(true);
  }, 90000);

  it("is ADDITIVE by default: extra keys on a pristine role stay; removing them needs remove_extra and can be scoped to one template", async () => {
    const fx = await newFixture("sync-extra");
    await addKey(fx.roleId.STYLIST!, "customers.view");
    await addKey(fx.roleId.RECEPTIONIST!, "reports.basic");

    expect(await syncTenant(fx.tenant.id)).toEqual([]); // nothing missing, nothing removed
    expect(await keysOf(fx.roleId.STYLIST!)).toEqual(["appointments.view", "customers.view"]);
    expect(await keysOf(fx.roleId.RECEPTIONIST!)).toContain("reports.basic");

    // Tightening only the Personel template: Resepsiyon's extra key is left alone.
    const scoped = await syncTenant(fx.tenant.id, true, "STYLIST");
    expect(scoped).toEqual([{ synced_role_id: fx.roleId.STYLIST, synced_role_key: "STYLIST", added_keys: [], removed_keys: ["customers.view"] }]);
    expect(await keysOf(fx.roleId.STYLIST!)).toEqual(["appointments.view"]);
    expect(await keysOf(fx.roleId.RECEPTIONIST!)).toContain("reports.basic");
    const audit = await auditRowsFor(fx.tenant.id, "role.template_synced", fx.roleId.STYLIST!);
    expect(audit[0]!.after).toMatchObject({ removed: ["customers.view"], remove_extra: true });

    // Unscoped tightening reaches the rest of the tenant's pristine roles.
    const rest = await syncTenant(fx.tenant.id, true);
    expect(rest.map((r) => `${r.synced_role_key}:-${r.removed_keys.join(",")}`)).toEqual(["RECEPTIONIST:-reports.basic"]);
    expect((await drift(fx.tenant.id)).every((r) => r.drift_state === "in_sync")).toBe(true);
  }, 90000);

  it("NEVER touches a customized role — not to add, not to remove — while its pristine siblings are synced", async () => {
    const fx = await newFixture("sync-custom");
    // The owner narrows Personel on purpose... and Manager loses a key some other way (pristine).
    expect(await editRole(fx.owner.id, fx.roleId.STYLIST!, [])).toEqual({ ok: true });
    expect(await customizedAt(fx.roleId.STYLIST!)).not.toBeNull();
    await removeKey(fx.roleId.SALON_MANAGER!, "reports.staff");
    // And the owner deliberately widens Resepsiyon.
    const wide = [...(await keysOf(fx.roleId.RECEPTIONIST!)), "reports.basic"];
    expect(await editRole(fx.owner.id, fx.roleId.RECEPTIONIST!, wide)).toEqual({ ok: true });

    const stylistBefore = await keysOf(fx.roleId.STYLIST!);
    const receptionBefore = await keysOf(fx.roleId.RECEPTIONIST!);

    for (const removeExtra of [false, true]) {
      const result = await syncTenant(fx.tenant.id, removeExtra);
      expect(result.map((r) => r.synced_role_key), `removeExtra=${removeExtra}`).toEqual(removeExtra ? [] : ["SALON_MANAGER"]);
      expect(await keysOf(fx.roleId.STYLIST!), `stylist removeExtra=${removeExtra}`).toEqual(stylistBefore);
      expect(await keysOf(fx.roleId.RECEPTIONIST!), `reception removeExtra=${removeExtra}`).toEqual(receptionBefore);
    }
    expect(await auditRowsFor(fx.tenant.id, "role.template_synced", fx.roleId.STYLIST!)).toHaveLength(0);
    expect(await auditRowsFor(fx.tenant.id, "role.template_synced", fx.roleId.RECEPTIONIST!)).toHaveLength(0);
    // The pristine Manager did get its key back, and is the only role the sync wrote to.
    expect(await keysOf(fx.roleId.SALON_MANAGER!)).toContain("reports.staff");
    expect(await auditRowsFor(fx.tenant.id, "role.template_synced")).toHaveLength(1);
    // The report still tells the truth about the two customized roles.
    const report = await drift(fx.tenant.id);
    expect(report.find((r) => r.drift_role_key === "STYLIST")).toMatchObject({ drift_state: "customized_drift", missing_keys: ["appointments.view"] });
    expect(report.find((r) => r.drift_role_key === "RECEPTIONIST")).toMatchObject({ drift_state: "customized_drift", extra_keys: ["reports.basic"] });
  }, 120000);

  it("an owner-created custom role — even one named exactly like a standard role — is never changed by the sync", async () => {
    const fx = await newFixture("sync-name");
    // A tenant whose Personel/Yönetici names are already taken by custom roles gets suffixed standard roles;
    // here the custom roles are added AFTER provisioning under the freed-up look-alike names.
    const custom = await createCustomRole(fx.tenant.id, "Personel Özel", []);
    const customKeyless = await createCustomRole(fx.tenant.id, "Yönetici Özel", ["appointments.view"]);
    await removeKey(fx.roleId.STYLIST!, "appointments.view"); // make a pristine role drift so the sync has work to do

    const result = await syncTenant(fx.tenant.id);
    expect(result.map((r) => r.synced_role_key)).toEqual(["STYLIST"]);
    expect(await keysOf(custom)).toEqual([]);
    expect(await keysOf(customKeyless)).toEqual(["appointments.view"]);
    expect(await customizedAt(custom)).toBeNull();
  }, 90000);

  it("does not touch a soft-deleted pristine role", async () => {
    const fx = await newFixture("sync-deleted");
    await removeKey(fx.roleId.RECEPTIONIST!, "customers.update");
    await testDb`update roles set deleted_at = now() where id = ${fx.roleId.RECEPTIONIST}`;
    expect(await syncTenant(fx.tenant.id)).toEqual([]);
    expect(await keysOf(fx.roleId.RECEPTIONIST!)).not.toContain("customers.update");
  }, 90000);

  it("is tenant-scoped: syncing one tenant leaves another tenant's pristine drift untouched", async () => {
    const a = await newFixture("sync-scope-a");
    const b = await newFixture("sync-scope-b");
    await removeKey(a.roleId.SALON_MANAGER!, "staff.view");
    await removeKey(b.roleId.SALON_MANAGER!, "staff.view");

    expect((await syncTenant(a.tenant.id)).map((r) => r.synced_role_key)).toEqual(["SALON_MANAGER"]);
    expect(await keysOf(a.roleId.SALON_MANAGER!)).toContain("staff.view");
    expect(await keysOf(b.roleId.SALON_MANAGER!)).not.toContain("staff.view");
    expect(await auditRowsFor(b.tenant.id, "role.template_synced")).toHaveLength(0);
  }, 120000);

  it("two concurrent syncs of one tenant apply the change once (per-tenant lock) and write one audit row", async () => {
    const fx = await newFixture("sync-race");
    await removeKey(fx.roleId.RECEPTIONIST!, "services.view");
    const results = await Promise.all([syncTenant(fx.tenant.id), syncTenant(fx.tenant.id)]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 1]);
    expect(await auditRowsFor(fx.tenant.id, "role.template_synced", fx.roleId.RECEPTIONIST!)).toHaveLength(1);
    expect(await keysOf(fx.roleId.RECEPTIONIST!)).toContain("services.view");
  }, 90000);

  it("syncing never weakens the last-unrestricted-holder invariant: the Owner role only ever gains keys by default", async () => {
    const fx = await newFixture("sync-owner");
    await removeKey(fx.roleId.SALON_OWNER!, "reports.financial");
    await removeKey(fx.roleId.SALON_OWNER!, "inventory.manage");
    const result = await syncTenant(fx.tenant.id);
    expect(result).toEqual([
      { synced_role_id: fx.roleId.SALON_OWNER, synced_role_key: "SALON_OWNER", added_keys: ["inventory.manage", "reports.financial"], removed_keys: [] },
    ]);
    const [holder] = await testDb<{ ok: boolean }[]>`select private.tenant_has_active_unrestricted_holder(${fx.tenant.id}::uuid) as ok`;
    expect(holder!.ok).toBe(true);
    // The owner's membership is on the SAME role row it always was — the sync edits permissions, never memberships.
    const [m] = await testDb<{ role_id: string }[]>`select role_id from tenant_memberships where tenant_id = ${fx.tenant.id} and user_id = ${fx.owner.id}`;
    expect(m!.role_id).toBe(fx.roleId.SALON_OWNER);
  }, 90000);

  it("none of the drift functions can be called by a client role", async () => {
    const fx = await newFixture("sync-grants");
    // Even the tenant's own unrestricted owner, as `authenticated`, has no way in: the private schema is not reachable at all.
    for (const fn of ["select * from private.sync_pristine_default_roles(null, false, null)", "select * from private.role_template_drift(null)", "select * from private.provision_default_roles(gen_random_uuid())"]) {
      const outcome = await attemptAs(fx.owner.id, (sql) => sql.unsafe(fn));
      expect(outcome, fn).toMatchObject({ ok: false, message: expect.stringContaining("permission denied") });
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// The strategy for FUTURE template / permission-catalog migrations
// ---------------------------------------------------------------------------

describe("the migration convention that keeps existing tenants from drifting again", () => {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const FIRST_GOVERNED = "20260921113345"; // everything after the SAAS.1E.1 backfill migration

  function stripComments(sql: string): string {
    return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
  }

  /** True when a migration changes a template or the permission catalog but never runs the pristine sync. */
  function violatesConvention(rawSql: string): boolean {
    const sql = stripComments(rawSql);
    const changesTemplates = /\b(insert\s+into|update|delete\s+from)\s+(public\.)?(role_template_permissions|role_templates)\b/i.test(sql);
    const changesCatalog = /\b(insert\s+into|update|delete\s+from)\s+(public\.)?permissions\b/i.test(sql);
    return (changesTemplates || changesCatalog) && !/sync_pristine_default_roles\s*\(/i.test(sql);
  }

  const later = readdirSync(dir)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f) && f.slice(0, 14) >= FIRST_GOVERNED)
    .sort();

  it("every migration from here on that changes a role template or the permission catalog also runs the pristine sync", () => {
    const offenders: string[] = [];
    for (const file of later) {
      if (violatesConvention(readFileSync(path.join(dir, file), "utf8"))) offenders.push(file);
    }
    expect(offenders, "add `select * from private.sync_pristine_default_roles();` (see supabase/migrations/README.md)").toEqual([]);
  });

  it("the detector itself recognises the cases it exists for (so this guard cannot silently rot)", () => {
    const changeTemplate = "insert into public.role_template_permissions (role_template_id, permission_id) select 1, 2;";
    const addKey = "insert into public.permissions (key, description) values ('x.y', 'z');";
    const sync = "select * from private.sync_pristine_default_roles();";
    expect(violatesConvention(changeTemplate)).toBe(true);
    expect(violatesConvention(addKey)).toBe(true);
    expect(violatesConvention("delete from role_templates where key = 'X';")).toBe(true);
    expect(violatesConvention(`${changeTemplate}\n${sync}`)).toBe(false);
    expect(violatesConvention(`${addKey}\n${changeTemplate}\n${sync}`)).toBe(false);
    // Mentions inside comments do not count, either way.
    expect(violatesConvention(`-- ${sync}\n${changeTemplate}`)).toBe(true);
    expect(violatesConvention("-- insert into public.permissions is not run here\nselect 1;")).toBe(false);
    // Unrelated migrations are not governed.
    expect(violatesConvention("alter table public.roles add column x int;")).toBe(false);
  });

  it("the convention is written down where migration authors look", () => {
    const readme = readFileSync(path.join(dir, "README.md"), "utf8");
    expect(readme).toContain("sync_pristine_default_roles");
    expect(readme).toContain("role_template_drift");
  });

  it("the Owner template always holds the ENTIRE permission catalog, so a new key can never be forgotten there", async () => {
    const rows = await testDb<{ missing: string[] }[]>`
      select coalesce(array_agg(p.key order by p.key), '{}') as missing
      from permissions p
      where p.id not in (
        select rtp.permission_id from role_template_permissions rtp join role_templates rt on rt.id = rtp.role_template_id where rt.key = 'SALON_OWNER'
      )`;
    expect(rows[0]!.missing).toEqual([]);
  });
});
