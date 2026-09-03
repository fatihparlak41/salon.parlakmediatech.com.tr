import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anonClient,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createRoleForTenant,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  safeMorningStart,
  signInAs,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Phase 2I.2C.1 — a tenant-facing toggle for the online_booking feature
 * (20260903120000). tenant_features itself keeps its existing, unchanged
 * grants (no table write access to authenticated at all — it backs
 * platform/billing-controlled feature overrides for every OTHER feature
 * too) — the entire write path is the narrowly-scoped
 * set_online_booking_enabled RPC, gated by settings.manage, touching
 * only the online_booking row for the caller's own tenant.
 */

let tenant: TestTenant;
let tenantB: TestTenant;
let owner: TestUser; // SALON_OWNER — has settings.manage
let ownerB: TestUser;
let limitedUser: TestUser; // real member, but no settings.manage
let outsiderUser: TestUser; // authenticated, zero membership anywhere (customer-portal-shaped)
let ownerClient: SupabaseClient;
let ownerBClient: SupabaseClient;

let branchId: string;
let staff: { id: string; fullName: string };
let service: { id: string; name: string; durationMinutes: number; price: number };

async function currentEnabled(tenantId: string): Promise<boolean | null> {
  const [row] = await testDb<{ enabled: boolean }[]>`
    select tf.enabled from tenant_features tf
    join features f on f.id = tf.feature_id
    where tf.tenant_id = ${tenantId} and f.key = 'online_booking'`;
  return row ? row.enabled : null;
}

beforeAll(async () => {
  owner = await createTestUser("p2i2c1-owner");
  ownerB = await createTestUser("p2i2c1-owner-b");
  limitedUser = await createTestUser("p2i2c1-limited");
  outsiderUser = await createTestUser("p2i2c1-outsider");

  tenant = await createTestTenant("test-p2i2c1", owner.id);
  tenantB = await createTestTenant("test-p2i2c1-b", ownerB.id);

  const limitedRole = await createRoleForTenant(tenant.id, "Sınırlı Rol", ["appointments.view"]);
  await testDb`insert into tenant_memberships (tenant_id, user_id, role_id, status)
    values (${tenant.id}, ${limitedUser.id}, ${limitedRole}, 'active')`;

  ownerClient = await signInAs(owner);
  ownerBClient = await signInAs(ownerB);

  branchId = await createBranch(tenant.id, "Ana Şube");
  staff = await createStaffMember(tenant.id, "Test Personel");
  service = await createService(tenant.id, "Test Hizmet", 30, 300);
  await linkStaffBranch(staff.id, branchId);
  await linkServiceBranch(service.id, branchId);
  await linkStaffService(staff.id, service.id);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenant.id, staff.id, weekday, "00:00", "23:59");
  }
}, 60000);

afterAll(async () => {
  await ownerClient.auth.signOut();
  await ownerBClient.auth.signOut();
  await cleanupTenants([tenant.id, tenantB.id]);
  await cleanupUsers([owner.id, ownerB.id, limitedUser.id, outsiderUser.id]);
});

describe("reading the setting", () => {
  it("defaults to false for a freshly-created tenant (no tenant_features row, no subscription)", async () => {
    expect(await currentEnabled(tenant.id)).toBeNull();
    const { data, error } = await ownerClient.rpc("has_feature", {
      p_tenant_id: tenant.id,
      p_feature_key: "online_booking",
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("renders the actual stored value once toggled on", async () => {
    const { error } = await ownerClient.rpc("set_online_booking_enabled", {
      p_tenant_id: tenant.id,
      p_enabled: true,
    });
    expect(error).toBeNull();
    expect(await currentEnabled(tenant.id)).toBe(true);
    const { data } = await ownerClient.rpc("has_feature", {
      p_tenant_id: tenant.id,
      p_feature_key: "online_booking",
    });
    expect(data).toBe(true);
  });
});

describe("authorized toggling", () => {
  it("owner (settings.manage) can toggle OFF → ON", async () => {
    await testDb`update tenant_features set enabled = false
      where tenant_id = ${tenant.id} and feature_id = (select id from features where key = 'online_booking')`;
    const { data, error } = await ownerClient.rpc("set_online_booking_enabled", {
      p_tenant_id: tenant.id,
      p_enabled: true,
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
    expect(await currentEnabled(tenant.id)).toBe(true);
  });

  it("owner (settings.manage) can toggle ON → OFF", async () => {
    const { data, error } = await ownerClient.rpc("set_online_booking_enabled", {
      p_tenant_id: tenant.id,
      p_enabled: false,
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
    expect(await currentEnabled(tenant.id)).toBe(false);
  });
});

describe("unauthorized access is denied", () => {
  it("a real member without settings.manage is denied", async () => {
    const client = await signInAs(limitedUser);
    const { error } = await client.rpc("set_online_booking_enabled", {
      p_tenant_id: tenant.id,
      p_enabled: true,
    });
    expect(error).not.toBeNull();
    await client.auth.signOut();
    // Untouched — the earlier ON→OFF test left it false.
    expect(await currentEnabled(tenant.id)).toBe(false);
  });

  it("an authenticated user with zero membership on the tenant (customer-account-shaped) is denied", async () => {
    const client = await signInAs(outsiderUser);
    const { error } = await client.rpc("set_online_booking_enabled", {
      p_tenant_id: tenant.id,
      p_enabled: true,
    });
    expect(error).not.toBeNull();
    await client.auth.signOut();
    expect(await currentEnabled(tenant.id)).toBe(false);
  });

  it("cross-tenant: tenant B's owner cannot modify tenant A's setting (forged tenant id)", async () => {
    const { error } = await ownerBClient.rpc("set_online_booking_enabled", {
      p_tenant_id: tenant.id,
      p_enabled: true,
    });
    expect(error).not.toBeNull();
    expect(await currentEnabled(tenant.id)).toBe(false);
  });

  it("anon cannot even reach the function — rejected at the grant level, not just has_permission", async () => {
    const { error } = await anonClient().rpc("set_online_booking_enabled", {
      p_tenant_id: tenant.id,
      p_enabled: true,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501"); // insufficient_privilege — no EXECUTE grant at all
    expect(await currentEnabled(tenant.id)).toBe(false);
  });
});

describe("public booking respects the toggle", () => {
  // A near-future date (not "today") so every slot on it is guaranteed
  // still in the future regardless of what time it happens to be right
  // now — "today" could genuinely have zero remaining slots if the
  // suite runs late in the day, an unrelated flake this avoids entirely.
  function futureDateStr(): string {
    return safeMorningStart(5).toISOString().slice(0, 10);
  }

  async function slotsOnFutureDate() {
    return anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenant.slug,
      p_branch_id: branchId,
      p_service_id: service.id,
      p_date: futureDateStr(),
      p_staff_member_id: staff.id,
    });
  }

  it("OFF: booking context reports unbookable, no salon data leaks, no slots offered", async () => {
    expect(await currentEnabled(tenant.id)).toBe(false);

    const context = await anonClient().rpc("get_public_booking_context", { p_tenant_slug: tenant.slug });
    expect(context.error).toBeNull();
    const body = context.data as unknown as Record<string, unknown>;
    expect(body.bookable).toBe(false);
    // Enumeration-safe: nothing beyond the bare bookable:false flag —
    // same shape a wrong/suspended/nonexistent slug would produce.
    expect(Object.keys(body)).toEqual(["bookable"]);

    const staffList = await anonClient().rpc("get_public_eligible_staff", {
      p_tenant_slug: tenant.slug,
      p_branch_id: branchId,
      p_service_id: service.id,
    });
    expect(staffList.data).toEqual([]);

    const slots = await slotsOnFutureDate();
    expect(slots.data).toEqual([]);
  });

  it("ON: booking context, staff, and availability all load normally", async () => {
    const { error: toggleError } = await ownerClient.rpc("set_online_booking_enabled", {
      p_tenant_id: tenant.id,
      p_enabled: true,
    });
    expect(toggleError).toBeNull();

    const context = await anonClient().rpc("get_public_booking_context", { p_tenant_slug: tenant.slug });
    expect(context.error).toBeNull();
    const body = context.data as unknown as { bookable: boolean; salon?: { slug: string } };
    expect(body.bookable).toBe(true);
    expect(body.salon?.slug).toBe(tenant.slug);

    const staffList = await anonClient().rpc("get_public_eligible_staff", {
      p_tenant_slug: tenant.slug,
      p_branch_id: branchId,
      p_service_id: service.id,
    });
    expect((staffList.data as unknown[]).length).toBe(1);

    const slots = await slotsOnFutureDate();
    expect((slots.data as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("no grant/security drift", () => {
  it("set_online_booking_enabled is executable by authenticated but not anon or public", async () => {
    // role_routine_grants includes the owner implicitly (unlike a raw
    // proacl/has_function_privilege check) — excluded here since only
    // non-owner grantees are the actual question.
    const rows = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'set_online_booking_enabled'
        and grantee <> (select rolname from pg_roles where oid = (
          select p.proowner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'set_online_booking_enabled'
        ))`;
    const grantees = rows.map((r) => r.grantee).sort();
    expect(grantees).toEqual(["authenticated"]);
  });

  it("tenant_features still has zero write grants to authenticated — the RPC is the only path", async () => {
    const rows = await testDb<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'tenant_features'
        and grantee = 'authenticated' and privilege_type <> 'SELECT'`;
    expect(rows).toEqual([]);
  });
});
