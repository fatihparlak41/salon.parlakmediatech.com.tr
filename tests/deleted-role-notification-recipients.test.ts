import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMembership,
  admin,
  allPermissionKeys,
  asAuthenticatedUser,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createCustomRole,
  createCustomer,
  createTestTenant,
  createTestUser,
  testDb,
  type TestTenant,
  type TestUser,
} from "./helpers";

/**
 * Faz SAAS.1E.0 (part 3) — a DELETED ROLE grants nothing, in notification
 * recipient targeting too (20260921084648_deleted_role_notification_recipients.sql).
 *
 * private.materialize_notification_deliveries used to derive "salon-wide
 * admin" (appointments.create) and "may see this appointment"
 * (appointments.view) straight from role_permissions, and
 * private.claim_notification_delivery_targets did the same for its send-time
 * re-check, so a member whose role had been soft-deleted kept receiving
 * appointment notifications. Both now require a LIVE role of the membership's
 * own tenant — the same predicate has_permission uses.
 *
 * One roster, every gate at once. Recipients are resolved through the real
 * service_role RPC exactly as the outbox does; events are inserted directly
 * (the same technique tests/notification-delivery-worker.test.ts uses) so the
 * scenarios do not need appointment-lifecycle fixtures. Nothing is sent: the
 * send-time scenario stops at what claim_notification_delivery_targets
 * returns.
 *
 * notification_delivery_activation is a global singleton: its original state
 * is recorded and restored exactly.
 */

let tenant: TestTenant;
let owner: TestUser;
let allKeys: string[];
let appointmentId: string;
let originalActivation: { present: boolean; activatedAt: string | null } = { present: false, activatedAt: null };

const createdUserIds: string[] = [];
const roleOf: Record<string, string> = {};
const membershipOf: Record<string, string> = {};
const userOf: Record<string, TestUser> = {};
const staffOf: Record<string, string> = {};
let ownerMembershipId: string;

const ADMIN_KEYS = ["appointments.create", "appointments.view"];
const VIEW_KEYS = ["appointments.view"];

async function addMember(
  label: string,
  roleKey: string,
  options: { status?: "active" | "suspended"; removed?: boolean; staff?: boolean } = {},
) {
  const user = await createTestUser(`drn-${label}`);
  createdUserIds.push(user.id);
  userOf[label] = user;
  const membershipId = await addMembership(tenant.id, user.id, roleOf[roleKey]!);
  membershipOf[label] = membershipId;
  if (options.staff) {
    const [staff] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name, tenant_membership_id, status)
      values (${tenant.id}, ${`Staff ${label}`}, ${membershipId}, 'active')
      returning id`;
    staffOf[label] = staff!.id;
  }
  if (options.status === "suspended") {
    await testDb`update tenant_memberships set status = 'suspended' where id = ${membershipId}`;
  }
  if (options.removed) {
    await testDb`update tenant_memberships set deleted_at = now() where id = ${membershipId}`;
  }
}

async function insertEvent(eventType: string, eventData: unknown): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    insert into notification_events (tenant_id, appointment_id, event_type, actor_user_id, event_data)
    values (${tenant.id}, ${appointmentId}, ${eventType}, ${owner.id}, ${testDb.json(eventData as never)})
    returning id`;
  return row!.id;
}

async function materialize(eventId: string) {
  const { data, error } = await admin.rpc("materialize_notification_deliveries", { p_event_id: eventId });
  expect(error).toBeNull();
  return data as { created: number; alreadyMaterialized: boolean };
}

async function recipientLabels(eventId: string): Promise<string[]> {
  const rows = await testDb<{ tenant_membership_id: string }[]>`
    select tenant_membership_id from notification_deliveries where notification_event_id = ${eventId}`;
  const byMembership = new Map(Object.entries(membershipOf).map(([label, id]) => [id, label]));
  return rows.map((r) => byMembership.get(r.tenant_membership_id) ?? `unknown:${r.tenant_membership_id}`).sort();
}

/** Every permission key the user effectively holds in the tenant, judged by
 * private.has_permission with the user's JWT claims (auth.uid() resolves as
 * it does for a real request). */
async function heldKeys(userId: string): Promise<string[]> {
  return await testDb.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true),
                     set_config('request.jwt.claim.sub', ${userId}, true)`;
    const rows = await sql<{ key: string }[]>`
      select k as key from unnest(${sql.array(allKeys, 1009)}::text[]) as k
      where private.has_permission(${tenant.id}::uuid, k)
      order by k`;
    return rows.map((r) => r.key);
  });
}

async function addDevice(membershipId: string, label: string): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    insert into push_subscriptions (tenant_membership_id, endpoint, p256dh, auth_key)
    values (${membershipId}, ${`https://example-push.test/drn-${label}-${Date.now()}`}, ${`p256dh-${label}`}, ${`authkey-${label}`})
    returning id`;
  return row!.id;
}

beforeAll(async () => {
  allKeys = await allPermissionKeys();
  const [activation] = await testDb<{ activated_at: string }[]>`
    select activated_at::text as activated_at from notification_delivery_activation where id = 1`;
  originalActivation = { present: activation !== undefined, activatedAt: activation?.activated_at ?? null };

  owner = await createTestUser("drn-owner");
  createdUserIds.push(owner.id);
  tenant = await createTestTenant("test-tenant-drn", owner.id);
  const [ownerMembership] = await testDb<{ id: string }[]>`
    select id from tenant_memberships where tenant_id = ${tenant.id} and user_id = ${owner.id}`;
  ownerMembershipId = ownerMembership!.id;
  membershipOf.owner = ownerMembershipId;

  roleOf.admin = await createCustomRole(tenant.id, "Bildirim Yöneticisi", ADMIN_KEYS);
  roleOf.view = await createCustomRole(tenant.id, "Bildirim Görüntüleyici", VIEW_KEYS);
  roleOf.noView = await createCustomRole(tenant.id, "Görüntüleyemeyen", ["customers.view"]);
  roleOf.late = await createCustomRole(tenant.id, "Sonradan Silinen", ADMIN_KEYS);
  // The roles that will be soft-deleted AFTER members are attached to them.
  roleOf.deletedAdmin = await createCustomRole(tenant.id, "Silinmiş Yönetici", ADMIN_KEYS);
  roleOf.deletedView = await createCustomRole(tenant.id, "Silinmiş Görüntüleyici", VIEW_KEYS);
  roleOf.deletedAll = await createCustomRole(tenant.id, "Silinmiş Sahip Gibi", allKeys);

  // admin path (appointments.create + appointments.view)
  await addMember("activeAdmin", "admin");
  await addMember("deletedAdmin", "deletedAdmin");
  await addMember("deletedAll", "deletedAll");
  await addMember("suspendedAdmin", "admin", { status: "suspended" });
  await addMember("removedAdmin", "admin", { removed: true });
  // staff path (assigned staff with a linked membership, appointments.view)
  await addMember("activeStaff", "view", { staff: true });
  await addMember("deletedStaff", "deletedView", { staff: true });
  await addMember("suspendedStaff", "view", { staff: true, status: "suspended" });
  await addMember("removedStaff", "view", { staff: true, removed: true });
  await addMember("noViewStaff", "noView", { staff: true });

  await testDb`update roles set deleted_at = now() where id in ${testDb([roleOf.deletedAdmin!, roleOf.deletedView!, roleOf.deletedAll!])}`;

  const branchId = await createBranch(tenant.id, "DRN Branch");
  const customer = await createCustomer(tenant.id, "DRN Customer");
  const [appointment] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, source, scheduled_start_at, scheduled_end_at, created_by, status)
    values (${tenant.id}, ${branchId}, ${customer.id}, 'internal', now() + interval '1 day', now() + interval '1 day 30 minutes', ${owner.id}, 'scheduled')
    returning id`;
  appointmentId = appointment!.id;
}, 180000);

afterAll(async () => {
  if (originalActivation.present) {
    await testDb`
      insert into notification_delivery_activation (id, activated_at) values (1, ${originalActivation.activatedAt}::timestamptz)
      on conflict (id) do update set activated_at = excluded.activated_at`;
  } else {
    await testDb`delete from notification_delivery_activation where id = 1`;
  }
  await cleanupTenants([tenant.id]);
  await cleanupUsers(createdUserIds);
}, 120000);

describe("F2 — a member on a deleted role holds no application permission at all", () => {
  it("holds zero permissions, although the deleted role still owns permission rows", async () => {
    for (const label of ["deletedAdmin", "deletedAll", "deletedStaff"]) {
      expect(await heldKeys(userOf[label]!.id), label).toEqual([]);
    }
    const [{ n }] = await testDb<{ n: number }[]>`
      select count(*)::int as n from role_permissions where role_id = ${roleOf.deletedAll}`;
    expect(n).toBe(allKeys.length); // the rows are still there; they simply grant nothing
    // ...and the same people with a LIVE role hold exactly what their role says.
    expect(await heldKeys(userOf.activeAdmin!.id)).toEqual([...ADMIN_KEYS].sort());
    expect(await heldKeys(userOf.activeStaff!.id)).toEqual([...VIEW_KEYS].sort());
  }, 60000);

  it("is not an unrestricted holder: the tenant loses its last holder when the real owner is suspended, despite a deleted all-permissions role", async () => {
    expect(await heldKeys(userOf.deletedAll!.id)).not.toContain("permissions.manage_unrestricted");
    await expect(
      testDb.begin(async (sql) => {
        await sql`update tenant_memberships set status = 'suspended' where id = ${ownerMembershipId}`;
      }),
    ).rejects.toThrow(/tenant_would_lose_last_unrestricted_holder/);
    const [row] = await testDb<{ status: string }[]>`select status from tenant_memberships where id = ${ownerMembershipId}`;
    expect(row!.status).toBe("active");
  }, 60000);

  it("sees no row through RLS that needs appointments.view, while the same tenant's live-role member does", async () => {
    const count = (userId: string) =>
      asAuthenticatedUser(userId, async (sql) => {
        const [row] = await sql<{ n: number }[]>`select count(*)::int as n from appointments where tenant_id = ${tenant.id}`;
        return row!.n;
      });
    expect(await count(userOf.activeAdmin!.id)).toBe(1);
    expect(await count(userOf.deletedAdmin!.id)).toBe(0);
    expect(await count(userOf.deletedAll!.id)).toBe(0);
  }, 60000);

  it("cannot use a staff.manage RPC even though the deleted role held every key", async () => {
    await expect(
      asAuthenticatedUser(userOf.deletedAll!.id, (sql) =>
        sql`select * from public.create_team_invitation(${tenant.id}::uuid, ${"drn-nobody@example.com"}::text, ${roleOf.view}::uuid, null::uuid)`,
      ),
    ).rejects.toThrow(/staff\.manage required/);
  }, 40000);
});

describe("F2 — permission-based notification recipients", () => {
  const EXPECTED = ["activeAdmin", "activeStaff"];

  const scenarios: [string, () => unknown][] = [
    [
      "appointment.created",
      () => ({ staffMemberIds: ["activeStaff", "deletedStaff", "suspendedStaff", "removedStaff", "noViewStaff"].map((l) => staffOf[l]) }),
    ],
    [
      "appointment.cancelled",
      () => ({ staffMemberIds: ["activeStaff", "deletedStaff", "suspendedStaff", "removedStaff", "noViewStaff"].map((l) => staffOf[l]) }),
    ],
    [
      "appointment.rescheduled",
      () => ({ after: ["activeStaff", "deletedStaff", "suspendedStaff", "removedStaff", "noViewStaff"].map((l) => ({ staffMemberId: staffOf[l] })) }),
    ],
    [
      "appointment.staff_reassigned",
      () => ({
        previousStaffMemberIds: [staffOf.deletedStaff, staffOf.suspendedStaff, staffOf.noViewStaff],
        newStaffMemberIds: [staffOf.activeStaff, staffOf.removedStaff],
      }),
    ],
  ];

  for (const [eventType, data] of scenarios) {
    it(`${eventType}: only the active members with a LIVE role that grants the permission are selected`, async () => {
      const eventId = await insertEvent(eventType, data());
      const result = await materialize(eventId);
      expect(result.alreadyMaterialized).toBe(false);
      expect(result.created).toBe(EXPECTED.length);

      const recipients = await recipientLabels(eventId);
      expect(recipients).toEqual(EXPECTED);

      // Each excluded label for a reason of its own:
      //   deletedAdmin / deletedAll / deletedStaff -> role deleted (the F2 fix)
      //   suspendedAdmin / suspendedStaff          -> membership suspended
      //   removedAdmin / removedStaff              -> membership removed
      //   noViewStaff                              -> live role without appointments.view
      //   owner                                    -> the event's actor
      for (const excluded of [
        "deletedAdmin", "deletedAll", "deletedStaff", "suspendedAdmin", "suspendedStaff",
        "removedAdmin", "removedStaff", "noViewStaff", "owner",
      ]) {
        expect(recipients, excluded).not.toContain(excluded);
      }

      // Idempotent: a second call creates nothing and changes nothing.
      const again = await materialize(eventId);
      expect(again).toMatchObject({ created: 0, alreadyMaterialized: true });
      expect(await recipientLabels(eventId)).toEqual(EXPECTED);
    }, 60000);
  }

  it("a role deleted BEFORE materialization stops mattering the moment it is restored: the same member is selected again (the decision follows the role's live state)", async () => {
    await testDb`update roles set deleted_at = null where id = ${roleOf.deletedAdmin}`;
    try {
      // No assigned staff in this event, so only the admin path (appointments.create) applies.
      const eventId = await insertEvent("appointment.created", { staffMemberIds: [] });
      await materialize(eventId);
      expect(await recipientLabels(eventId)).toEqual(["activeAdmin", "deletedAdmin"]);
    } finally {
      await testDb`update roles set deleted_at = now() where id = ${roleOf.deletedAdmin}`;
    }
    const eventId = await insertEvent("appointment.created", { staffMemberIds: [] });
    await materialize(eventId);
    expect(await recipientLabels(eventId)).toEqual(["activeAdmin"]);
  }, 60000);
});

describe("F2 — send-time re-check (claim_notification_delivery_targets)", () => {
  it("a role deleted AFTER materialization stops the push: the target is skipped as recipient_no_longer_eligible and is never returned; a live-role member is still returned", async () => {
    await testDb`
      insert into notification_delivery_activation (id, activated_at) values (1, now() - interval '1 hour')
      on conflict (id) do update set activated_at = excluded.activated_at`;

    await addMember("lateAdmin", "late");
    const lateDevice = await addDevice(membershipOf.lateAdmin!, "late");
    const liveDevice = await addDevice(membershipOf.activeAdmin!, "live");

    const eventId = await insertEvent("appointment.created", { staffMemberIds: [] });
    await materialize(eventId);
    expect(await recipientLabels(eventId)).toEqual(["activeAdmin", "lateAdmin"]);

    const deliveries = await testDb<{ id: string; tenant_membership_id: string }[]>`
      select id, tenant_membership_id from notification_deliveries where notification_event_id = ${eventId}`;
    const deliveryOf = (label: string) => deliveries.find((d) => d.tenant_membership_id === membershipOf[label])!.id;

    const { error: prepareError } = await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });
    expect(prepareError).toBeNull();

    const targetsBefore = await testDb<{ id: string; status: string; push_subscription_id: string }[]>`
      select id, status, push_subscription_id from notification_delivery_targets
      where notification_delivery_id in ${testDb([deliveryOf("lateAdmin"), deliveryOf("activeAdmin")])}`;
    expect(targetsBefore.map((t) => t.status).sort()).toEqual(["pending", "pending"]);

    // The role is deleted between materialization and sending.
    await testDb`update roles set deleted_at = now() where id = ${roleOf.late}`;

    const { data, error } = await admin.rpc("claim_notification_delivery_targets", { p_batch_size: 200, p_lease_seconds: 120 });
    expect(error).toBeNull();
    const claimed = (data as { notificationDeliveryId: string; pushSubscriptionId: string }[]).filter((c) =>
      [deliveryOf("lateAdmin"), deliveryOf("activeAdmin")].includes(c.notificationDeliveryId),
    );
    expect(claimed.map((c) => c.pushSubscriptionId)).toEqual([liveDevice]);

    const lateTarget = await testDb<{ status: string; last_error_code: string | null }[]>`
      select status, last_error_code from notification_delivery_targets
      where notification_delivery_id = ${deliveryOf("lateAdmin")} and push_subscription_id = ${lateDevice}`;
    expect(lateTarget).toEqual([{ status: "skipped", last_error_code: "recipient_no_longer_eligible" }]);
  }, 120000);
});
