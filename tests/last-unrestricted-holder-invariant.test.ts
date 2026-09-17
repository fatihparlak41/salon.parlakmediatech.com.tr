import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMembership,
  cleanupTenants,
  cleanupUsers,
  createRoleForTenant,
  createTestTenant,
  createTestUser,
  signInAs,
  testDb,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1C.1 — the last-unrestricted-holder invariant: a tenant must
 * never reach a COMMITTED state with zero active, non-deleted
 * tenant_memberships whose effective role holds
 * permissions.manage_unrestricted (never a role-name check). Enforced
 * entirely by two DEFERRABLE INITIALLY DEFERRED constraint triggers on
 * tenant_memberships and role_permissions — see
 * 20260917080000_last_unrestricted_holder_invariant_and_invitation_rpcs.sql's
 * own header for the full design and concurrency argument. These tests
 * exercise the trigger layer directly, independent of which RPC (or
 * direct grant) performs the underlying mutation — update_membership_role
 * and update_role_permissions were not changed at all by that migration.
 */

let ownerA: TestUser;
let ownerB: TestUser;
let bypassCaller: TestUser;
let bypassCallerClient: SupabaseClient;

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  ownerA = await createTestUser("luh-owner-a");
  ownerB = await createTestUser("luh-owner-b");
  bypassCaller = await createTestUser("luh-bypass-caller");
  createdUserIds.push(ownerA.id, ownerB.id, bypassCaller.id);
  bypassCallerClient = await signInAs(bypassCaller);
}, 30000);

afterAll(async () => {
  await cleanupTenants(createdTenantIds);
  await cleanupUsers(createdUserIds);
}, 60000);

async function activeUnrestrictedHolderCount(tenantId: string): Promise<number> {
  const rows = await testDb<{ count: string }[]>`
    select count(*)::text as count
    from tenant_memberships tm
    join role_permissions rp on rp.role_id = tm.role_id
    join permissions p on p.id = rp.permission_id
    where tm.tenant_id = ${tenantId}
      and tm.status = 'active'
      and tm.deleted_at is null
      and p.key = 'permissions.manage_unrestricted'
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Fresh tenant with two independent unrestricted holders (ownerA,
 * ownerB, both SALON_OWNER-template clones) plus a membership for the
 * shared bypassCaller under a role holding only staff.manage +
 * appointments.view — enough to pass has_permission(staff.manage) and
 * caller_can_grant_permissions for a non-unrestricted target role,
 * without bypassCaller ever being counted as a holder themselves or
 * hitting update_membership_role's own "cannot change your own role"
 * guard when acting on ownerA/ownerB. */
async function setupTwoHolderTenant(slugSuffix: string) {
  const tenant = await createTestTenant(`test-tenant-luh-${slugSuffix}`, ownerA.id);
  createdTenantIds.push(tenant.id);

  const [template] = await testDb<{ id: string }[]>`
    select id from role_templates where key = 'SALON_OWNER'
  `;
  if (!template) throw new Error("SALON_OWNER role template is missing");

  const [ownerRoleB] = await testDb<{ id: string }[]>`
    insert into roles (tenant_id, name, is_system_default, cloned_from_template_id)
    values (${tenant.id}, 'Owner Clone B', true, ${template.id})
    returning id
  `;
  if (!ownerRoleB) throw new Error("failed to clone second owner role");

  const templatePerms = await testDb<{ permission_id: string }[]>`
    select permission_id from role_template_permissions where role_template_id = ${template.id}
  `;
  await testDb`
    insert into role_permissions ${testDb(
      templatePerms.map((p) => ({ role_id: ownerRoleB.id, permission_id: p.permission_id })),
    )}
  `;
  const membershipB = await addMembership(tenant.id, ownerB.id, ownerRoleB.id);

  const [membershipA] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${ownerA.id}
  `;

  const limitedRoleId = await createRoleForTenant(tenant.id, "Sınırlı", [
    "staff.manage",
    "appointments.view",
  ]);
  const nonUnrestrictedRoleId = await createRoleForTenant(tenant.id, "Sınırsız Değil", [
    "appointments.view",
  ]);
  await addMembership(tenant.id, bypassCaller.id, limitedRoleId);

  return {
    tenantId: tenant.id,
    membershipA: membershipA!.id,
    membershipB,
    ownerRoleAId: tenant.ownerRoleId,
    ownerRoleBId: ownerRoleB.id,
    nonUnrestrictedRoleId,
  };
}

describe("bootstrap compatibility", () => {
  it("create_tenant_with_owner still succeeds and yields exactly one active unrestricted holder", async () => {
    const owner = await createTestUser("luh-bootstrap-owner");
    createdUserIds.push(owner.id);
    const client = await signInAs(owner);

    const { data, error } = await client.rpc("create_tenant", {
      p_name: "Bootstrap Test Tenant",
      p_slug: `test-tenant-luh-bootstrap-${Date.now().toString(36)}`,
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();

    const newTenantId = data as unknown as string;
    createdTenantIds.push(newTenantId);

    const count = await activeUnrestrictedHolderCount(newTenantId);
    expect(count).toBe(1);
  });
});

describe("direct membership status update — item 20", () => {
  it("suspending a normal non-last member still works", async () => {
    const fx = await setupTwoHolderTenant("status-normal");

    const throwaway = await createTestUser("luh-bystander");
    createdUserIds.push(throwaway.id);
    const [bystanderMembership] = await testDb<{ id: string }[]>`
      insert into tenant_memberships (tenant_id, user_id, role_id, status)
      values (${fx.tenantId}, ${throwaway.id}, ${fx.nonUnrestrictedRoleId}, 'active')
      returning id
    `;

    await testDb`update tenant_memberships set status = 'suspended' where id = ${bystanderMembership!.id}`;

    const [row] = await testDb<{ status: string }[]>`
      select status from tenant_memberships where id = ${bystanderMembership!.id}
    `;
    expect(row?.status).toBe("suspended");
    expect(await activeUnrestrictedHolderCount(fx.tenantId)).toBe(2);
  });

  it("suspending the LAST active unrestricted holder fails at transaction completion", async () => {
    const fx = await setupTwoHolderTenant("status-last");

    await expect(
      testDb.begin(async (sql) => {
        await sql`update tenant_memberships set status = 'suspended' where id = ${fx.membershipB}`;
        await sql`update tenant_memberships set status = 'suspended' where id = ${fx.membershipA}`;
      }),
    ).rejects.toThrow(/tenant_would_lose_last_unrestricted_holder/);

    expect(await activeUnrestrictedHolderCount(fx.tenantId)).toBe(2);
    const [rowA] = await testDb<{ status: string }[]>`select status from tenant_memberships where id = ${fx.membershipA}`;
    const [rowB] = await testDb<{ status: string }[]>`select status from tenant_memberships where id = ${fx.membershipB}`;
    expect(rowA?.status).toBe("active");
    expect(rowB?.status).toBe("active");
  });
});

describe("direct DELETE / soft-delete — structural coverage", () => {
  it("soft-deleting (deleted_at) the last active unrestricted holder fails", async () => {
    const fx = await setupTwoHolderTenant("soft-delete-last");

    await expect(
      testDb.begin(async (sql) => {
        await sql`update tenant_memberships set deleted_at = now() where id = ${fx.membershipB}`;
        await sql`update tenant_memberships set deleted_at = now() where id = ${fx.membershipA}`;
      }),
    ).rejects.toThrow(/tenant_would_lose_last_unrestricted_holder/);

    expect(await activeUnrestrictedHolderCount(fx.tenantId)).toBe(2);
  });

  it("hard DELETE of the last active unrestricted holder's row is blocked even from a privileged connection", async () => {
    // testDb's own Postgres role bypasses RLS/grants entirely — this
    // proves the guard is a real database-level constraint trigger, not
    // merely an RLS/grant-layer safeguard that a privileged connection
    // could route around.
    const fx = await setupTwoHolderTenant("hard-delete-last");

    await expect(
      testDb.begin(async (sql) => {
        await sql`delete from tenant_memberships where id = ${fx.membershipB}`;
        await sql`delete from tenant_memberships where id = ${fx.membershipA}`;
      }),
    ).rejects.toThrow(/tenant_would_lose_last_unrestricted_holder/);

    expect(await activeUnrestrictedHolderCount(fx.tenantId)).toBe(2);
    const remaining = await testDb<{ id: string }[]>`
      select id from tenant_memberships where id in ${testDb([fx.membershipA, fx.membershipB])}
    `;
    expect(remaining).toHaveLength(2);
  });
});

describe("role change protection via update_membership_role — item 21", () => {
  it("can change a non-last unrestricted holder's role when another active unrestricted holder remains", async () => {
    const fx = await setupTwoHolderTenant("role-change-nonlast");

    const { error } = await bypassCallerClient.rpc("update_membership_role", {
      p_membership_id: fx.membershipB,
      p_new_role_id: fx.nonUnrestrictedRoleId,
    });
    expect(error).toBeNull();

    const [row] = await testDb<{ role_id: string }[]>`select role_id from tenant_memberships where id = ${fx.membershipB}`;
    expect(row?.role_id).toBe(fx.nonUnrestrictedRoleId);
    expect(await activeUnrestrictedHolderCount(fx.tenantId)).toBe(1);
  });

  it("cannot move the last active unrestricted holder to a non-unrestricted role", async () => {
    const fx = await setupTwoHolderTenant("role-change-last");

    // Strip B first (allowed — A remains), leaving A as the sole holder.
    await testDb`update tenant_memberships set role_id = ${fx.nonUnrestrictedRoleId} where id = ${fx.membershipB}`;
    expect(await activeUnrestrictedHolderCount(fx.tenantId)).toBe(1);

    const { error } = await bypassCallerClient.rpc("update_membership_role", {
      p_membership_id: fx.membershipA,
      p_new_role_id: fx.nonUnrestrictedRoleId,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/tenant_would_lose_last_unrestricted_holder/);

    const [row] = await testDb<{ role_id: string }[]>`select role_id from tenant_memberships where id = ${fx.membershipA}`;
    expect(row?.role_id).toBe(fx.ownerRoleAId);
    expect(await activeUnrestrictedHolderCount(fx.tenantId)).toBe(1);
  });
});

describe("role permission edit protection via update_role_permissions — item 22", () => {
  it("can remove manage_unrestricted from a role when another active membership with another unrestricted role remains", async () => {
    const fx = await setupTwoHolderTenant("perm-edit-nonlast");

    const { error } = await bypassCallerClient.rpc("update_role_permissions", {
      p_role_id: fx.ownerRoleBId,
      p_permission_keys: ["appointments.view"],
    });
    expect(error).toBeNull();
    expect(await activeUnrestrictedHolderCount(fx.tenantId)).toBe(1);
  });

  it("cannot remove manage_unrestricted from the role backing the LAST active unrestricted membership", async () => {
    const fx = await setupTwoHolderTenant("perm-edit-last");

    // Strip B's role first (allowed), leaving A's role as the sole
    // unrestricted-backing role in this tenant.
    await testDb`delete from role_permissions where role_id = ${fx.ownerRoleBId} and permission_id in (select id from permissions where key = 'permissions.manage_unrestricted')`;
    expect(await activeUnrestrictedHolderCount(fx.tenantId)).toBe(1);

    const { error } = await bypassCallerClient.rpc("update_role_permissions", {
      p_role_id: fx.ownerRoleAId,
      p_permission_keys: ["appointments.view"],
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/tenant_would_lose_last_unrestricted_holder/);

    const remaining = await testDb<{ key: string }[]>`
      select p.key from role_permissions rp join permissions p on p.id = rp.permission_id
      where rp.role_id = ${fx.ownerRoleAId} and p.key = 'permissions.manage_unrestricted'
    `;
    expect(remaining).toHaveLength(1);
    expect(await activeUnrestrictedHolderCount(fx.tenantId)).toBe(1);
  });
});

describe("concurrency — item 23", () => {
  it("two concurrent transactions stripping the two different holders cannot both commit", async () => {
    const fx = await setupTwoHolderTenant("concurrency");

    const conn1 = await testDb.reserve();
    const conn2 = await testDb.reserve();

    try {
      await conn1`begin`;
      await conn2`begin`;

      // Both UPDATEs touch different rows, so neither blocks on the
      // other here — the deferred trigger doesn't fire until commit.
      await conn1`update tenant_memberships set role_id = ${fx.nonUnrestrictedRoleId} where id = ${fx.membershipA}`;
      await conn2`update tenant_memberships set role_id = ${fx.nonUnrestrictedRoleId} where id = ${fx.membershipB}`;

      // Fire both commits genuinely concurrently — Postgres's own
      // per-tenant row lock (acquired inside the deferred trigger) must
      // serialize them so at most one succeeds.
      const [result1, result2] = await Promise.all([
        conn1`commit`.then(() => ({ ok: true as const })).catch((e: Error) => ({ ok: false as const, error: e })),
        conn2`commit`.then(() => ({ ok: true as const })).catch((e: Error) => ({ ok: false as const, error: e })),
      ]);

      const outcomes = [result1, result2];
      const succeeded = outcomes.filter((r) => r.ok);
      const failed = outcomes.filter((r) => !r.ok);

      // At most one of the two conflicting removals may commit.
      expect(succeeded.length).toBeLessThanOrEqual(1);
      expect(succeeded.length + failed.length).toBe(2);
      if (failed.length > 0) {
        const failedError = failed[0] as { ok: false; error: Error };
        expect(failedError.error.message).toMatch(/tenant_would_lose_last_unrestricted_holder/);
      }

      // The final committed state must never contain zero holders.
      expect(await activeUnrestrictedHolderCount(fx.tenantId)).toBeGreaterThanOrEqual(1);
    } finally {
      // A connection left inside a failed/aborted transaction must be
      // rolled back before it's safe to return to the pool.
      await conn1`rollback`.catch(() => {});
      await conn2`rollback`.catch(() => {});
      await conn1.release();
      await conn2.release();
    }
  }, 30000);
});
