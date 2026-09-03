import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  safeMorningStart,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Phase 2I.2C — public booking must never expose price, duration, or
 * staff capacity to an unauthenticated customer. get_public_availability_slots
 * and get_public_eligible_staff already never included any of these
 * (bare time strings / {id, fullName} only) — these are regression tests
 * protecting that contract going forward, not a behavior change.
 *
 * The confirm-step and success-screen price/duration removed from the
 * UI this phase come from a DIFFERENT source (the initial page props and
 * create_guest_booking's own confirmation payload), both of which still
 * legitimately carry price/duration server-side — the exact same
 * UI-only-hiding treatment already approved for duration in Phase
 * 2I.2B, now applied consistently to price. That rendered-UI proof (no
 * price/duration/capacity anywhere on screen) lives in the DEV browser
 * E2E, not here — this codebase's Vitest suite has no DOM/component
 * rendering layer to assert against.
 */

let tenant: TestTenant;
let owner: TestUser;
let branchId: string;
let staff: { id: string; fullName: string };
let service: { id: string; name: string; durationMinutes: number; price: number };

async function enableOnlineBooking(tenantId: string) {
  const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
  if (!feature) throw new Error("online_booking feature missing from catalog");
  await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${tenantId}, ${feature.id}, true)`;
}

beforeAll(async () => {
  owner = await createTestUser("p2i2c-visibility-owner");
  tenant = await createTestTenant("test-p2i2c-visibility", owner.id);
  await enableOnlineBooking(tenant.id);
  branchId = await createBranch(tenant.id, "Visibility Branch");
  staff = await createStaffMember(tenant.id, "Visibility Staff", 2);
  service = await createService(tenant.id, "Visibility Service", 30, 750);
  await linkStaffBranch(staff.id, branchId);
  await linkServiceBranch(service.id, branchId);
  await linkStaffService(staff.id, service.id);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenant.id, staff.id, weekday, "00:00", "23:59");
  }
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenant.id]);
  await cleanupUsers([owner.id]);
});

describe("get_public_availability_slots — no price/duration/capacity in the response shape", () => {
  it("returns only bare HH:MM time strings", async () => {
    const start = safeMorningStart(10);
    const dateStr = start.toISOString().slice(0, 10);
    const { data, error } = await anonClient().rpc("get_public_availability_slots", {
      p_tenant_slug: tenant.slug,
      p_branch_id: branchId,
      p_service_id: service.id,
      p_date: dateStr,
      p_staff_member_id: staff.id,
    });
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    const slots = (data as unknown as string[]) ?? [];
    expect(slots.length).toBeGreaterThan(0);
    // A bare array of "HH:MM" strings has structurally nowhere for a
    // price/duration/capacity field to hide — asserted explicitly, not
    // just inferred from the array being non-empty.
    for (const slot of slots) {
      expect(slot).toMatch(/^\d{2}:\d{2}$/);
    }
  });
});

describe("get_public_eligible_staff — no capacity/price/duration in the response shape", () => {
  it("returns only {id, fullName} per staff member", async () => {
    const { data, error } = await anonClient().rpc("get_public_eligible_staff", {
      p_tenant_slug: tenant.slug,
      p_branch_id: branchId,
      p_service_id: service.id,
    });
    expect(error).toBeNull();
    const list = (data as unknown as Record<string, unknown>[]) ?? [];
    expect(list.length).toBe(1);
    expect(Object.keys(list[0]!).sort()).toEqual(["fullName", "id"]);
    expect(list[0]).not.toHaveProperty("concurrentCapacity");
    expect(list[0]).not.toHaveProperty("concurrent_capacity");
    expect(list[0]).not.toHaveProperty("price");
    expect(list[0]).not.toHaveProperty("durationMinutes");
  });
});
