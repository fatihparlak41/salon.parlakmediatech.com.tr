import { afterAll, describe, expect, it } from "vitest";
import { cleanupTenants, cleanupUsers, createTestUser, signInAs, testDb } from "./helpers";

/**
 * Phase 2I.2C — every new tenant must get exactly one initial branch
 * ("Merkez Şube"), created atomically inside create_tenant_with_owner
 * (20260903090000). This replaces the Phase 2I.2 finding that no
 * application path anywhere could create a branch at all — a real,
 * pre-existing, launch-blocking gap (staff/service eligibility and
 * appointments all require a branch to attach to). Also covers the same
 * migration's one-time backfill for any pre-existing zero-branch tenant.
 *
 * Deliberately calls the REAL public.create_tenant RPC throughout (never
 * createTestTenant, which inserts directly into `tenants` and so never
 * exercises create_tenant_with_owner at all) — this suite proves the
 * actual onboarding path, not a shortcut around it.
 */

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
});

async function createRealTenant(slugPrefix: string): Promise<{ tenantId: string; slug: string; userId: string }> {
  const user = await createTestUser(`p2i2c-${slugPrefix}`);
  createdUserIds.push(user.id);
  const client = await signInAs(user);
  const slug = `test-p2i2c-${slugPrefix}-${crypto.randomUUID().slice(0, 8)}`;
  const { data, error } = await client.rpc("create_tenant", { p_name: `Test ${slugPrefix}`, p_slug: slug });
  if (error || !data) throw new Error(`failed to create tenant: ${error?.message}`);
  const tenantId = data as unknown as string;
  createdTenantIds.push(tenantId);
  await client.auth.signOut();
  return { tenantId, slug, userId: user.id };
}

describe("create_tenant — default branch bootstrap", () => {
  it("a newly created tenant gets exactly 1 branch", async () => {
    const { tenantId } = await createRealTenant("count");
    const branches = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${tenantId}`;
    expect(branches.length).toBe(1);
  });

  it("the branch is named exactly 'Merkez Şube'", async () => {
    const { tenantId } = await createRealTenant("name");
    const [branch] = await testDb<{ name: string }[]>`select name from branches where tenant_id = ${tenantId}`;
    expect(branch!.name).toBe("Merkez Şube");
  });

  it("the branch carries the correct tenant_id and is active + primary", async () => {
    const { tenantId } = await createRealTenant("state");
    const [branch] = await testDb<{ tenant_id: string; deleted_at: string | null; is_primary: boolean }[]>`
      select tenant_id, deleted_at, is_primary from branches where tenant_id = ${tenantId}`;
    expect(branch!.tenant_id).toBe(tenantId);
    expect(branch!.deleted_at).toBeNull();
    expect(branch!.is_primary).toBe(true);
  });

  it("no address or phone is invented for it", async () => {
    const { tenantId } = await createRealTenant("noinvent");
    const [branch] = await testDb<{ address: string | null; phone: string | null }[]>`
      select address, phone from branches where tenant_id = ${tenantId}`;
    expect(branch!.address).toBeNull();
    expect(branch!.phone).toBeNull();
  });

  it("tenant + branch creation is atomic — no tenant created this suite exists without one", async () => {
    const orphans = await testDb<{ id: string }[]>`
      select t.id from tenants t
      where t.id = any(${createdTenantIds})
        and not exists (select 1 from branches b where b.tenant_id = t.id and b.deleted_at is null)`;
    expect(orphans.length).toBe(0);
  });
});

describe("zero-branch tenant backfill (20260903090000)", () => {
  // The migration's own backfill runs exactly once, at migration-apply
  // time, over whatever tenants existed then — it can't be re-invoked
  // from a test. These tests instead re-run its exact predicate directly
  // against a freshly-simulated "legacy" tenant (inserted the same way
  // createTestTenant does: direct SQL, bypassing create_tenant_with_owner
  // entirely), proving the predicate itself is correct and idempotent.
  async function backfillOnce(tenantId: string) {
    await testDb`
      insert into branches (tenant_id, name, is_primary)
      select t.id, 'Merkez Şube', true from tenants t
      where t.id = ${tenantId}
        and not exists (select 1 from branches b where b.tenant_id = t.id and b.deleted_at is null)`;
  }

  it("a legacy zero-branch tenant is backfilled with exactly one Merkez Şube", async () => {
    const legacyOwner = await createTestUser("p2i2c-legacy");
    createdUserIds.push(legacyOwner.id);
    const [tenant] = await testDb<{ id: string }[]>`
      insert into tenants (name, slug, created_by)
      values ('Legacy Tenant', ${"test-p2i2c-legacy-" + crypto.randomUUID().slice(0, 8)}, ${legacyOwner.id})
      returning id`;
    const tenantId = tenant!.id;
    createdTenantIds.push(tenantId);

    const before = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${tenantId}`;
    expect(before.length).toBe(0);

    await backfillOnce(tenantId);

    const after = await testDb<{ name: string; is_primary: boolean }[]>`
      select name, is_primary from branches where tenant_id = ${tenantId}`;
    expect(after.length).toBe(1);
    expect(after[0]!.name).toBe("Merkez Şube");
    expect(after[0]!.is_primary).toBe(true);
  });

  it("running the backfill predicate twice never duplicates", async () => {
    const legacyOwner = await createTestUser("p2i2c-idempotent");
    createdUserIds.push(legacyOwner.id);
    const [tenant] = await testDb<{ id: string }[]>`
      insert into tenants (name, slug, created_by)
      values ('Idempotent Tenant', ${"test-p2i2c-idem-" + crypto.randomUUID().slice(0, 8)}, ${legacyOwner.id})
      returning id`;
    const tenantId = tenant!.id;
    createdTenantIds.push(tenantId);

    await backfillOnce(tenantId);
    await backfillOnce(tenantId);

    const branches = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${tenantId}`;
    expect(branches.length).toBe(1);
  });

  it("a tenant that already has a branch (the normal path) is left untouched by the backfill predicate", async () => {
    const { tenantId } = await createRealTenant("has-branch");
    const before = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${tenantId}`;
    expect(before.length).toBe(1);

    await backfillOnce(tenantId);

    const after = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${tenantId}`;
    expect(after.length).toBe(1);
    expect(after[0]!.id).toBe(before[0]!.id);
  });
});

describe("cross-tenant branch isolation", () => {
  it("tenant A's Merkez Şube never appears among tenant B's branches, or vice versa", async () => {
    const { tenantId: tenantA } = await createRealTenant("iso-a");
    const { tenantId: tenantB } = await createRealTenant("iso-b");

    const branchesA = await testDb<{ tenant_id: string }[]>`select tenant_id from branches where tenant_id = ${tenantA}`;
    const branchesB = await testDb<{ tenant_id: string }[]>`select tenant_id from branches where tenant_id = ${tenantB}`;

    expect(branchesA.length).toBe(1);
    expect(branchesB.length).toBe(1);
    expect(branchesA.every((b) => b.tenant_id === tenantA)).toBe(true);
    expect(branchesB.every((b) => b.tenant_id === tenantB)).toBe(true);
  });
});

describe("forged branch UUID is rejected", () => {
  it("assigning staff to a nonexistent branch id fails with a foreign-key violation", async () => {
    const { tenantId } = await createRealTenant("forged");
    const [staff] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name) values (${tenantId}, 'Forged Branch Test Staff') returning id`;

    await expect(
      testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff!.id}, ${crypto.randomUUID()})`,
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("staff can be assigned to the bootstrapped branch", () => {
  it("a staff member links successfully to the tenant's auto-created Merkez Şube", async () => {
    const { tenantId } = await createRealTenant("assign");
    const [branch] = await testDb<{ id: string }[]>`select id from branches where tenant_id = ${tenantId}`;
    const [staff] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name) values (${tenantId}, 'Assign Test Staff') returning id`;

    await testDb`insert into staff_branches (staff_member_id, branch_id) values (${staff!.id}, ${branch!.id})`;

    const links = await testDb<{ staff_member_id: string; branch_id: string }[]>`
      select staff_member_id, branch_id from staff_branches where staff_member_id = ${staff!.id}`;
    expect(links.length).toBe(1);
    expect(links[0]!.branch_id).toBe(branch!.id);
  });
});
