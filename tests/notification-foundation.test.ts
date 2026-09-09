import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anonClient,
  testDb,
  signInAs,
  createTestUser,
  createTestTenant,
  addMembership,
  cleanupTenants,
  cleanupUsers,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz NOTIF.2A — push_subscriptions / notification_preferences schema +
 * RPCs (20260908090000). "Verify the actual query/RPC behavior against
 * a real signed-in client", same convention as every other RPC test
 * file in this project — no TypeScript wrapper layer exists yet for
 * these (that's NOTIF.2B's job, once a UI needs one), so every test
 * here calls .rpc() directly, matching how 5A.3A/5A.3B were tested
 * before their own UI layer (5A.3C) existed.
 *
 * Fixture shape: tenantA (ownerA + staffB, both active, same role —
 * role differentiation isn't what these tests are about) for same-
 * tenant multi-user isolation; tenantB (ownerC, plus ownerA ALSO
 * holding a second active membership there) for cross-tenant isolation
 * AND the "one auth user, two memberships" case in one fixture;
 * suspendedUser/deletedUser, each with exactly one non-active
 * membership in tenantA, for the membership-status gate tests.
 */

let tenantA: TestTenant;
let tenantB: TestTenant;
let ownerA: TestUser;
let staffB: TestUser;
let ownerC: TestUser;
let suspendedUser: TestUser;
let deletedUser: TestUser;

let ownerAClient: SupabaseClient;
let staffBClient: SupabaseClient;
let ownerCClient: SupabaseClient;
let suspendedClient: SupabaseClient;
let deletedClient: SupabaseClient;

function endpoint(label: string): string {
  // Globally unique per test run — mirrors a real Web Push endpoint's
  // shape closely enough for these tests (an opaque https URL), never
  // reused across tests unless a test deliberately wants that reuse
  // (the account-switch and re-subscribe tests pass the SAME value on
  // purpose).
  return `https://push.example.test/ep/${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

beforeAll(async () => {
  ownerA = await createTestUser("notif2a-ownerA");
  staffB = await createTestUser("notif2a-staffB");
  ownerC = await createTestUser("notif2a-ownerC");
  suspendedUser = await createTestUser("notif2a-suspended");
  deletedUser = await createTestUser("notif2a-deleted");

  tenantA = await createTestTenant("notif2a-tenant-a", ownerA.id);
  tenantB = await createTestTenant("notif2a-tenant-b", ownerC.id);

  await addMembership(tenantA.id, staffB.id, tenantA.ownerRoleId);
  // ownerA also active in tenantB — the "one auth user, two memberships"
  // fixture, without a third tenant.
  await addMembership(tenantB.id, ownerA.id, tenantB.ownerRoleId);

  const suspendedMembershipId = await addMembership(tenantA.id, suspendedUser.id, tenantA.ownerRoleId);
  await testDb`update tenant_memberships set status = 'suspended' where id = ${suspendedMembershipId}`;

  const deletedMembershipId = await addMembership(tenantA.id, deletedUser.id, tenantA.ownerRoleId);
  await testDb`update tenant_memberships set deleted_at = now() where id = ${deletedMembershipId}`;

  ownerAClient = await signInAs(ownerA);
  staffBClient = await signInAs(staffB);
  ownerCClient = await signInAs(ownerC);
  suspendedClient = await signInAs(suspendedUser);
  deletedClient = await signInAs(deletedUser);
});

afterAll(async () => {
  await cleanupTenants([tenantA.id, tenantB.id]);
  await cleanupUsers([ownerA.id, staffB.id, ownerC.id, suspendedUser.id, deletedUser.id]);
});

describe("save_push_subscription", () => {
  it("1. active member saves first device", async () => {
    const ep = endpoint("first-device");
    const { data, error } = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh-value-1",
      p_auth_key: "auth-value-1",
      p_device_label: "iPhone",
    });
    expect(error).toBeNull();
    expect(data.id).toBeTruthy();
    expect(data.deviceLabel).toBe("iPhone");

    const { data: devices } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    expect(devices.some((d: { id: string }) => d.id === data.id)).toBe(true);
  });

  it("2. same membership saves multiple devices", async () => {
    const ep1 = endpoint("device-a");
    const ep2 = endpoint("device-b");
    const r1 = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep1,
      p_p256dh: "p256dh-a",
      p_auth_key: "auth-a",
      p_device_label: "Phone A",
    });
    const r2 = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep2,
      p_p256dh: "p256dh-b",
      p_auth_key: "auth-b",
      p_device_label: "Phone B",
    });
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect(r1.data.id).not.toBe(r2.data.id);

    const { data: devices } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    const ids = devices.map((d: { id: string }) => d.id);
    expect(ids).toContain(r1.data.id);
    expect(ids).toContain(r2.data.id);
  });

  it("3. duplicate endpoint does not create duplicate row", async () => {
    const ep = endpoint("dup-check");
    const r1 = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh-x",
      p_auth_key: "auth-x",
    });
    const r2 = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh-x",
      p_auth_key: "auth-x",
    });
    expect(r1.data.id).toBe(r2.data.id);

    const rows = await testDb`select id from push_subscriptions where endpoint = ${ep}`;
    expect(rows.length).toBe(1);
  });

  it("4. same endpoint re-subscribe updates keys safely", async () => {
    const ep = endpoint("rekey");
    await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "old-p256dh",
      p_auth_key: "old-auth",
    });
    await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "new-p256dh",
      p_auth_key: "new-auth",
    });

    const [row] = await testDb<{ p256dh: string; auth_key: string }[]>`
      select p256dh, auth_key from push_subscriptions where endpoint = ${ep}
    `;
    expect(row?.p256dh).toBe("new-p256dh");
    expect(row?.auth_key).toBe("new-auth");
  });

  it("5. account/membership switch on same endpoint revokes the old owner's row and creates the new owner's own (Faz NOTIF.2A.1 contract)", async () => {
    // Corrected in Faz NOTIF.2A.1: UNIQUE(endpoint) (one row,
    // reassigned wholesale) became UNIQUE(endpoint, tenant_membership_id)
    // specifically so the SAME user's other tenant memberships are never
    // disturbed by a save — see that migration's own header. A
    // genuinely DIFFERENT auth user claiming the endpoint therefore now
    // produces a NEW row (their own membership's row) and REVOKES the
    // old owner's, rather than reassigning one shared row — this test
    // asserts that corrected contract; see the dedicated "multi-tenant
    // device ownership" describe block below for the fuller matrix
    // (same user/two tenants, revoke-one-preserves-other, etc.).
    const ep = endpoint("switch");
    const saveA = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh-shared",
      p_auth_key: "auth-shared",
      p_device_label: "Shared Device (A)",
    });
    expect(saveA.error).toBeNull();

    // staffB subscribes from the SAME physical endpoint (e.g. a shared
    // salon iPad, or ownerA signed out and staffB signed in on the same
    // browser) — the old owner's row must be revoked, not left active.
    const saveB = await staffBClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh-shared",
      p_auth_key: "auth-shared",
      p_device_label: "Shared Device (B)",
    });
    expect(saveB.error).toBeNull();
    expect(saveB.data.id).not.toBe(saveA.data.id); // a new row for staffB's own membership, not a reassignment

    const { data: devicesA } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    expect(devicesA.find((d: { id: string }) => d.id === saveA.data.id)?.revoked).toBe(true);

    const { data: devicesB } = await staffBClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    expect(devicesB.find((d: { id: string }) => d.id === saveB.data.id)?.revoked).toBe(false);

    const rows = await testDb<{ id: string; tenant_membership_id: string; revoked_at: string | null }[]>`
      select id, tenant_membership_id, revoked_at from push_subscriptions where endpoint = ${ep}
    `;
    expect(rows.length).toBe(2); // both rows preserved (audit trail), never deleted
    const staffBMembership = rows.find((r) => r.id === saveB.data.id);
    expect(staffBMembership?.revoked_at).toBeNull();
    const ownerARow = rows.find((r) => r.id === saveA.data.id);
    expect(ownerARow?.revoked_at).not.toBeNull();
  });

  it("6. wrong tenant membership rejected (caller has no membership in the target tenant)", async () => {
    const { error } = await ownerCClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id, // ownerC has no membership in tenantA
      p_endpoint: endpoint("wrong-tenant"),
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/active tenant membership required/i);
  });

  it("7. a different auth user in the SAME tenant cannot see or affect another member's device", async () => {
    const ep = endpoint("cross-user-same-tenant");
    const saved = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(saved.error).toBeNull();

    const { data: staffBDevices } = await staffBClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    expect(staffBDevices.some((d: { id: string }) => d.id === saved.data.id)).toBe(false);
  });

  it("8. suspended membership rejected", async () => {
    const { error } = await suspendedClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: endpoint("suspended"),
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/active tenant membership required/i);
  });

  it("9. deleted membership rejected", async () => {
    const { error } = await deletedClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: endpoint("deleted"),
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/active tenant membership required/i);
  });

  it("10. anon rejected", async () => {
    const { error } = await anonClient().rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: endpoint("anon"),
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(error).not.toBeNull();
  });
});

describe("remove_push_subscription / list_my_devices", () => {
  it("11. revoke own subscription succeeds", async () => {
    const ep = endpoint("revoke-own");
    const saved = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    const { error } = await ownerAClient.rpc("remove_push_subscription", { p_subscription_id: saved.data.id });
    expect(error).toBeNull();

    const [row] = await testDb<{ revoked_at: string | null }[]>`
      select revoked_at from push_subscriptions where id = ${saved.data.id}
    `;
    expect(row?.revoked_at).not.toBeNull();
  });

  it("12. revoke another user's subscription fails", async () => {
    const ep = endpoint("revoke-other");
    const saved = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    const { error } = await staffBClient.rpc("remove_push_subscription", { p_subscription_id: saved.data.id });
    expect(error).not.toBeNull();

    const [row] = await testDb<{ revoked_at: string | null }[]>`
      select revoked_at from push_subscriptions where id = ${saved.data.id}
    `;
    expect(row?.revoked_at).toBeNull(); // untouched by the rejected attempt
  });

  it("13. list_my_devices returns metadata only — exact key shape", async () => {
    const ep = endpoint("shape-check");
    await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
      p_device_label: "Shape Device",
    });
    const { data: devices } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    const device = devices.find((d: { deviceLabel: string }) => d.deviceLabel === "Shape Device");
    expect(device).toBeTruthy();
    expect(Object.keys(device).sort()).toEqual(["createdAt", "deviceLabel", "id", "lastSeenAt", "revoked"].sort());
  });

  it("14. list_my_devices never returns endpoint/p256dh/auth", async () => {
    const ep = endpoint("no-secrets");
    await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "very-secret-p256dh",
      p_auth_key: "very-secret-auth",
    });
    const { data: devices } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    const serialized = JSON.stringify(devices);
    expect(serialized).not.toContain(ep);
    expect(serialized).not.toContain("very-secret-p256dh");
    expect(serialized).not.toContain("very-secret-auth");
    for (const d of devices as Record<string, unknown>[]) {
      expect(d).not.toHaveProperty("endpoint");
      expect(d).not.toHaveProperty("p256dh");
      expect(d).not.toHaveProperty("authKey");
      expect(d).not.toHaveProperty("auth_key");
    }
  });

  it("15. revoked device stays listed, clearly marked (not silently excluded) — the locked contract for this RPC", async () => {
    const ep = endpoint("revoked-visible");
    const saved = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
      p_device_label: "Will Be Revoked",
    });
    await ownerAClient.rpc("remove_push_subscription", { p_subscription_id: saved.data.id });

    const { data: devices } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    const device = devices.find((d: { id: string }) => d.id === saved.data.id);
    expect(device).toBeTruthy();
    expect(device.revoked).toBe(true);
  });
});

describe("notification preferences", () => {
  it("16. no-row-yet reads as default true, and creates no row", async () => {
    const freshUser = await createTestUser("notif2a-prefs-fresh");
    const membershipId = await addMembership(tenantA.id, freshUser.id, tenantA.ownerRoleId);
    const freshClient = await signInAs(freshUser);

    const { data, error } = await freshClient.rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });
    expect(error).toBeNull();
    expect(data).toEqual({
      newAppointment: true,
      cancellation: true,
      reschedule: true,
      assignmentChange: true,
    });

    const rows = await testDb`select 1 from notification_preferences where tenant_membership_id = ${membershipId}`;
    expect(rows.length).toBe(0);

    // The tenant_memberships row (and any notification_preferences row
    // hanging off it) must go BEFORE the user — auth.users has no
    // cascade from tenant_memberships.user_id, so deleting the user
    // first raises a foreign-key violation cleanupUsers now correctly
    // surfaces instead of silently swallowing (see that function's own
    // comment). Not routed through cleanupTenants: these fixtures are
    // one extra membership on the shared tenantA, not a whole tenant of
    // their own.
    await testDb`delete from notification_preferences where tenant_membership_id = ${membershipId}`;
    await testDb`delete from tenant_memberships where id = ${membershipId}`;
    await cleanupUsers([freshUser.id]);
  });

  it("17. first update lazily creates the row, preserving unspecified fields as default true", async () => {
    const freshUser = await createTestUser("notif2a-prefs-lazy");
    const membershipId = await addMembership(tenantA.id, freshUser.id, tenantA.ownerRoleId);
    const freshClient = await signInAs(freshUser);

    const { data, error } = await freshClient.rpc("update_my_notification_preferences", {
      p_tenant_id: tenantA.id,
      p_cancellation: false,
    });
    expect(error).toBeNull();
    expect(data).toEqual({
      newAppointment: true,
      cancellation: false,
      reschedule: true,
      assignmentChange: true,
    });

    const rows = await testDb`select 1 from notification_preferences where tenant_membership_id = ${membershipId}`;
    expect(rows.length).toBe(1);

    // The tenant_memberships row (and any notification_preferences row
    // hanging off it) must go BEFORE the user — auth.users has no
    // cascade from tenant_memberships.user_id, so deleting the user
    // first raises a foreign-key violation cleanupUsers now correctly
    // surfaces instead of silently swallowing (see that function's own
    // comment). Not routed through cleanupTenants: these fixtures are
    // one extra membership on the shared tenantA, not a whole tenant of
    // their own.
    await testDb`delete from notification_preferences where tenant_membership_id = ${membershipId}`;
    await testDb`delete from tenant_memberships where id = ${membershipId}`;
    await cleanupUsers([freshUser.id]);
  });

  it("18. each preference can be independently toggled across separate calls", async () => {
    const freshUser = await createTestUser("notif2a-prefs-toggle");
    const membershipId = await addMembership(tenantA.id, freshUser.id, tenantA.ownerRoleId);
    const freshClient = await signInAs(freshUser);

    await freshClient.rpc("update_my_notification_preferences", { p_tenant_id: tenantA.id, p_new_appointment: false });
    const r1 = await freshClient.rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });
    expect(r1.data).toEqual({ newAppointment: false, cancellation: true, reschedule: true, assignmentChange: true });

    await freshClient.rpc("update_my_notification_preferences", { p_tenant_id: tenantA.id, p_reschedule: false });
    const r2 = await freshClient.rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });
    // new_appointment stays false from the previous call — coalesce(null, existing), not reset to default.
    expect(r2.data).toEqual({ newAppointment: false, cancellation: true, reschedule: false, assignmentChange: true });

    await freshClient.rpc("update_my_notification_preferences", {
      p_tenant_id: tenantA.id,
      p_new_appointment: true,
      p_assignment_change: false,
    });
    const r3 = await freshClient.rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });
    expect(r3.data).toEqual({ newAppointment: true, cancellation: true, reschedule: false, assignmentChange: false });

    // The tenant_memberships row (and any notification_preferences row
    // hanging off it) must go BEFORE the user — auth.users has no
    // cascade from tenant_memberships.user_id, so deleting the user
    // first raises a foreign-key violation cleanupUsers now correctly
    // surfaces instead of silently swallowing (see that function's own
    // comment). Not routed through cleanupTenants: these fixtures are
    // one extra membership on the shared tenantA, not a whole tenant of
    // their own.
    await testDb`delete from notification_preferences where tenant_membership_id = ${membershipId}`;
    await testDb`delete from tenant_memberships where id = ${membershipId}`;
    await cleanupUsers([freshUser.id]);
  });

  it("19. a different membership's preferences remain fully isolated", async () => {
    await ownerAClient.rpc("update_my_notification_preferences", { p_tenant_id: tenantA.id, p_new_appointment: false });
    const { data } = await staffBClient.rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });
    expect(data.newAppointment).toBe(true); // untouched by ownerA's own update
  });

  it("20. a caller can only ever update their OWN derived membership — no target-id exists to attack", async () => {
    // There is no membership-id or user-id parameter on this RPC at
    // all (see the migration's own header) — this test proves the
    // structural guarantee empirically: staffB's update never touches
    // ownerA's row, using the two ACTIVE memberships in the same
    // tenant this fixture already sets up.
    await ownerAClient.rpc("update_my_notification_preferences", { p_tenant_id: tenantA.id, p_cancellation: true });
    const before = await ownerAClient.rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });

    await staffBClient.rpc("update_my_notification_preferences", { p_tenant_id: tenantA.id, p_cancellation: false });

    const after = await ownerAClient.rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });
    expect(after.data.cancellation).toBe(before.data.cancellation);
  });

  it("21. suspended membership rejected", async () => {
    const { error: getError } = await suspendedClient.rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });
    expect(getError).not.toBeNull();

    const { error: updateError } = await suspendedClient.rpc("update_my_notification_preferences", {
      p_tenant_id: tenantA.id,
      p_cancellation: false,
    });
    expect(updateError).not.toBeNull();
  });

  it("22. anon rejected", async () => {
    const anon = anonClient();
    const { error: getError } = await anon.rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });
    expect(getError).not.toBeNull();
    const { error: updateError } = await anon.rpc("update_my_notification_preferences", {
      p_tenant_id: tenantA.id,
      p_cancellation: false,
    });
    expect(updateError).not.toBeNull();
  });

  it("23. no unrelated fields can be changed — the row only ever has these exact columns", async () => {
    const freshUser = await createTestUser("notif2a-prefs-shape");
    const membershipId = await addMembership(tenantA.id, freshUser.id, tenantA.ownerRoleId);
    const freshClient = await signInAs(freshUser);

    await freshClient.rpc("update_my_notification_preferences", { p_tenant_id: tenantA.id, p_new_appointment: false });

    const [row] = await testDb<Record<string, unknown>[]>`
      select * from notification_preferences where tenant_membership_id = ${membershipId}
    `;
    expect(Object.keys(row!).sort()).toEqual(
      ["tenant_membership_id", "new_appointment", "cancellation", "reschedule", "assignment_change", "updated_at"].sort(),
    );

    // The tenant_memberships row (and any notification_preferences row
    // hanging off it) must go BEFORE the user — auth.users has no
    // cascade from tenant_memberships.user_id, so deleting the user
    // first raises a foreign-key violation cleanupUsers now correctly
    // surfaces instead of silently swallowing (see that function's own
    // comment). Not routed through cleanupTenants: these fixtures are
    // one extra membership on the shared tenantA, not a whole tenant of
    // their own.
    await testDb`delete from notification_preferences where tenant_membership_id = ${membershipId}`;
    await testDb`delete from tenant_memberships where id = ${membershipId}`;
    await cleanupUsers([freshUser.id]);
  });
});

describe("security — grants and schema access", () => {
  it("24. authenticated has zero table grants on either new table", async () => {
    const rows = await testDb<{ grantee: string }[]>`
      select grantee from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name in ('push_subscriptions', 'notification_preferences')
        and grantee in ('authenticated', 'anon')
    `;
    expect(rows).toEqual([]);
  });

  it("25. authenticated has no EXECUTE grant on the private.* implementations", async () => {
    const rows = await testDb<{ routine_name: string; grantee: string }[]>`
      select routine_name, grantee from information_schema.role_routine_grants
      where routine_schema = 'private'
        and routine_name in (
          'save_push_subscription', 'remove_push_subscription', 'list_my_devices',
          'get_my_notification_preferences', 'update_my_notification_preferences'
        )
        and grantee in ('authenticated', 'anon')
    `;
    expect(rows).toEqual([]);
  });

  it("26. private.* implementations retain no execute grant to PUBLIC either — the third layer, on top of test 25's authenticated/anon check", async () => {
    // PostgREST itself only ever exposes the public schema, so there is
    // no routable path from .rpc() to private.* regardless of grants —
    // that's a project-level PostgREST config, not something this
    // migration controls, so it isn't what this test proves. What this
    // migration DOES control is the grant itself: every "create
    // function private.X" below is immediately followed by "revoke
    // execute ... from public" (see the migration), so even a role
    // that inherits from PUBLIC — which includes every role in
    // Postgres by default — has no path to these five functions
    // through any connection method, not just PostgREST.
    const rows = await testDb<{ routine_name: string }[]>`
      select routine_name from information_schema.role_routine_grants
      where routine_schema = 'private'
        and routine_name in (
          'save_push_subscription', 'remove_push_subscription', 'list_my_devices',
          'get_my_notification_preferences', 'update_my_notification_preferences'
        )
        and grantee = 'PUBLIC'
    `;
    expect(rows).toEqual([]);
  });

  it("27. public wrappers are granted to authenticated, not anon, not PUBLIC", async () => {
    const rows = await testDb<{ routine_name: string; grantee: string }[]>`
      select routine_name, grantee from information_schema.role_routine_grants
      where routine_schema = 'public'
        and routine_name in (
          'save_push_subscription', 'remove_push_subscription', 'list_my_devices',
          'get_my_notification_preferences', 'update_my_notification_preferences'
        )
    `;
    const byFunction = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!byFunction.has(r.routine_name)) byFunction.set(r.routine_name, new Set());
      byFunction.get(r.routine_name)!.add(r.grantee);
    }
    for (const fn of [
      "save_push_subscription",
      "remove_push_subscription",
      "list_my_devices",
      "get_my_notification_preferences",
      "update_my_notification_preferences",
    ]) {
      const grantees = byFunction.get(fn) ?? new Set();
      // postgres (the function owner) always carries an implicit grant
      // too — expected and harmless, not a role any client can ever
      // authenticate as. The actual security assertion is that
      // authenticated is present and anon/PUBLIC are not.
      expect(Array.from(grantees).sort(), fn).toEqual(["authenticated", "postgres"].sort());
    }
  });
});

describe("multi-tenant isolation", () => {
  it("28. same auth user with two memberships stays tenant-scoped", async () => {
    const epA = endpoint("multi-tenant-a");
    const epB = endpoint("multi-tenant-b");
    // ownerA is active in BOTH tenantA and tenantB (fixture setup).
    const savedInA = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: epA,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
      p_device_label: "In Tenant A",
    });
    const savedInB = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantB.id,
      p_endpoint: epB,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
      p_device_label: "In Tenant B",
    });
    expect(savedInA.error).toBeNull();
    expect(savedInB.error).toBeNull();

    const { data: listA } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    const { data: listB } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantB.id });

    expect(listA.some((d: { id: string }) => d.id === savedInA.data.id)).toBe(true);
    expect(listA.some((d: { id: string }) => d.id === savedInB.data.id)).toBe(false);
    expect(listB.some((d: { id: string }) => d.id === savedInB.data.id)).toBe(true);
    expect(listB.some((d: { id: string }) => d.id === savedInA.data.id)).toBe(false);
  });

  it("29. tenant A's subscriptions/preferences cannot be observed through a tenant-B-only membership", async () => {
    // ownerC has an active membership in tenantB only, never tenantA.
    const { error: listError } = await ownerCClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    // list_my_devices returns [] rather than raising for "no active
    // membership" (see the migration's own comment on that RPC) — the
    // isolation proof here is that it comes back empty, not that it
    // errors.
    expect(listError).toBeNull();
    const { data: devices } = await ownerCClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    expect(devices).toEqual([]);

    const { error: prefsError } = await ownerCClient.rpc("get_my_notification_preferences", { p_tenant_id: tenantA.id });
    expect(prefsError).not.toBeNull();
    expect(prefsError!.message).toMatch(/active tenant membership required/i);
  });
});

/**
 * Faz NOTIF.2A.1 — corrects push_subscriptions from a globally-unique
 * endpoint (one row reassigned wholesale on every save) to UNIQUE
 * (endpoint, tenant_membership_id): the same physical device may now
 * legitimately back one row per tenant the SAME auth user is actively
 * in, while a save from a genuinely DIFFERENT auth user still revokes
 * every one of the previous user's rows for that endpoint. Reuses this
 * file's own fixture directly — ownerA is already active in BOTH
 * tenantA and tenantB (set up for test 28 above), which is exactly the
 * shape these tests need; ownerC (tenantB only) and staffB (tenantA
 * only) stand in for "a different auth user".
 */
describe("multi-tenant device ownership (Faz NOTIF.2A.1)", () => {
  it("1. same auth user, Tenant A + Tenant B, SAME endpoint -> both tenant device lists contain it", async () => {
    const ep = endpoint("same-user-two-tenants");
    const savedA = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
      p_device_label: "Shared iPhone",
    });
    const savedB = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantB.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
      p_device_label: "Shared iPhone",
    });
    expect(savedA.error).toBeNull();
    expect(savedB.error).toBeNull();
    expect(savedA.data.id).not.toBe(savedB.data.id); // two distinct rows, same endpoint

    const { data: listA } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    const { data: listB } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantB.id });
    expect(listA.some((d: { id: string; revoked: boolean }) => d.id === savedA.data.id && !d.revoked)).toBe(true);
    expect(listB.some((d: { id: string; revoked: boolean }) => d.id === savedB.data.id && !d.revoked)).toBe(true);
  });

  it("2. saving Tenant B does not remove Tenant A for the same user", async () => {
    const ep = endpoint("no-removal-on-second-save");
    const savedA = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    // Save Tenant B AFTER Tenant A — this is exactly the sequence
    // NOTIF.2A's bug lost: the second save must not steal/revoke the
    // first.
    await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantB.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });

    const [row] = await testDb<{ revoked_at: string | null }[]>`
      select revoked_at from push_subscriptions where id = ${savedA.data.id}
    `;
    expect(row?.revoked_at).toBeNull();
  });

  it("3. same user / same tenant / same endpoint re-save -> one row only, keys updated", async () => {
    const ep = endpoint("same-tenant-resave");
    const first = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "old-p256dh",
      p_auth_key: "old-auth",
    });
    const second = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "new-p256dh",
      p_auth_key: "new-auth",
    });
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data.id).toBe(first.data.id);

    const rows = await testDb<{ p256dh: string; auth_key: string }[]>`
      select p256dh, auth_key from push_subscriptions where endpoint = ${ep}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.p256dh).toBe("new-p256dh");
    expect(rows[0]?.auth_key).toBe("new-auth");
  });

  it("4. same endpoint reused by a DIFFERENT auth user -> previous user's active rows for it are revoked", async () => {
    const ep = endpoint("ownership-transfer");
    // ownerA registers it for BOTH of their tenants first.
    const savedA1 = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    const savedA2 = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantB.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(savedA1.error).toBeNull();
    expect(savedA2.error).toBeNull();

    // staffB (a genuinely different auth user, active in tenantA) now
    // claims the same physical endpoint.
    const savedByStaffB = await staffBClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(savedByStaffB.error).toBeNull();

    const rows = await testDb<{ id: string; revoked_at: string | null }[]>`
      select id, revoked_at from push_subscriptions where id in (${savedA1.data.id}, ${savedA2.data.id})
    `;
    for (const row of rows) {
      expect(row.revoked_at, `row ${row.id} should be revoked`).not.toBeNull();
    }
  });

  it("5. after ownership transfer, the previous user sees no ACTIVE device for that endpoint in ANY of their tenants", async () => {
    const ep = endpoint("transfer-then-check-old-owner");
    const savedA1 = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    const savedA2 = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantB.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(savedA1.error).toBeNull();
    expect(savedA2.error).toBeNull();
    const claimedByStaffB = await staffBClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(claimedByStaffB.error).toBeNull();

    const { data: listA } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    const { data: listB } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantB.id });
    const rowA = listA.find((d: { id: string }) => d.id === savedA1.data.id);
    const rowB = listB.find((d: { id: string }) => d.id === savedA2.data.id);
    // Locked list_my_devices contract (NOTIF.2A test 15): revoked rows
    // stay listed, clearly marked — never silently excluded. "No active
    // device" means revoked: true here, not "absent from the list".
    expect(rowA?.revoked).toBe(true);
    expect(rowB?.revoked).toBe(true);
  });

  it("6. the new user sees the claimed device only in their own valid tenant membership", async () => {
    const ep = endpoint("new-owner-scoped-view");
    const savedByA = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(savedByA.error).toBeNull();
    const claimed = await staffBClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id, // staffB is only ever active in tenantA in this fixture
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(claimed.error).toBeNull();

    const { data: staffBListA } = await staffBClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    expect(staffBListA.some((d: { id: string; revoked: boolean }) => d.id === claimed.data.id && !d.revoked)).toBe(
      true,
    );

    // staffB has no membership in tenantB at all — the existing
    // no-active-membership contract applies (empty array, not a raise).
    const { data: staffBListB } = await staffBClient.rpc("list_my_devices", { p_tenant_id: tenantB.id });
    expect(staffBListB).toEqual([]);
  });

  it("7. disabling the Tenant A association leaves the Tenant B association on the same endpoint active", async () => {
    const ep = endpoint("disable-one-tenant");
    const savedA = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    const savedB = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantB.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(savedA.error).toBeNull();
    expect(savedB.error).toBeNull();

    const { error: revokeError } = await ownerAClient.rpc("remove_push_subscription", {
      p_subscription_id: savedA.data.id,
    });
    expect(revokeError).toBeNull();

    const { data: listA } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    const { data: listB } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantB.id });
    expect(listA.find((d: { id: string }) => d.id === savedA.data.id)?.revoked).toBe(true);
    expect(listB.find((d: { id: string }) => d.id === savedB.data.id)?.revoked).toBe(false);
  });

  it("8. revoking Tenant B afterward leaves no active association for that endpoint/user", async () => {
    const ep = endpoint("disable-both-tenants");
    const savedA = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    const savedB = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantB.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(savedA.error).toBeNull();
    expect(savedB.error).toBeNull();
    await ownerAClient.rpc("remove_push_subscription", { p_subscription_id: savedA.data.id });
    await ownerAClient.rpc("remove_push_subscription", { p_subscription_id: savedB.data.id });

    const { data: listA } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    const { data: listB } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantB.id });
    expect(listA.find((d: { id: string }) => d.id === savedA.data.id)?.revoked).toBe(true);
    expect(listB.find((d: { id: string }) => d.id === savedB.data.id)?.revoked).toBe(true);
  });

  it("9. a different user sharing a tenant cannot enumerate another user's row for a shared endpoint", async () => {
    const ep = endpoint("cross-user-enumeration");
    const savedByA = await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantB.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(savedByA.error).toBeNull();

    // ownerC is active in tenantB too (a different user than ownerA,
    // same tenant) — must never see ownerA's row via their own,
    // identically-scoped list call.
    const { data: ownerCListB } = await ownerCClient.rpc("list_my_devices", { p_tenant_id: tenantB.id });
    expect(ownerCListB.some((d: { id: string }) => d.id === savedByA.data.id)).toBe(false);
  });

  it("10. list_my_devices still exposes no endpoint/p256dh/auth material in the multi-row-per-endpoint shape", async () => {
    const ep = endpoint("no-secrets-still");
    await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "still-secret-p256dh",
      p_auth_key: "still-secret-auth",
    });
    await ownerAClient.rpc("save_push_subscription", {
      p_tenant_id: tenantB.id,
      p_endpoint: ep,
      p_p256dh: "still-secret-p256dh",
      p_auth_key: "still-secret-auth",
    });
    const { data: listA } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantA.id });
    const { data: listB } = await ownerAClient.rpc("list_my_devices", { p_tenant_id: tenantB.id });
    const serialized = JSON.stringify([...listA, ...listB]);
    expect(serialized).not.toContain(ep);
    expect(serialized).not.toContain("still-secret-p256dh");
    expect(serialized).not.toContain("still-secret-auth");
  });

  it("11. suspended/deleted memberships still cannot create or reactivate a subscription", async () => {
    const ep = endpoint("suspended-deleted-still-blocked");
    const suspendedResult = await suspendedClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: ep,
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(suspendedResult.error).not.toBeNull();
    expect(suspendedResult.error!.message).toMatch(/active tenant membership required/i);

    const deletedResult = await deletedClient.rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: endpoint("suspended-deleted-still-blocked-2"),
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(deletedResult.error).not.toBeNull();
    expect(deletedResult.error!.message).toMatch(/active tenant membership required/i);
  });

  it("12. an anonymous caller is still rejected", async () => {
    const { error } = await anonClient().rpc("save_push_subscription", {
      p_tenant_id: tenantA.id,
      p_endpoint: endpoint("anon-still-blocked"),
      p_p256dh: "p256dh",
      p_auth_key: "auth",
    });
    expect(error).not.toBeNull();
  });
});
