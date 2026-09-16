import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildDeliveryPushPayload } from "@/lib/modules/notifications/payload";
import {
  processNotificationDeliveryBatch,
  type ClaimedNotificationDeliveryTarget,
  type SendPushFn,
} from "@/lib/modules/notifications/delivery-worker";
import {
  testDb,
  createTestUser,
  createTestTenant,
  createRoleForTenant,
  addMembership,
  createBranch,
  createCustomer,
  cleanupTenants,
  cleanupUsers,
  type TestUser,
  type TestTenant,
} from "./helpers";

/**
 * Faz NOTIF.2F.2 — bounded 30-day purge for notification_event_display_
 * snapshots (supabase/migrations/20260916080000_*). Covers deletion
 * boundary semantics, batching, concurrency safety (FOR UPDATE SKIP
 * LOCKED), browser-role denial, and that purging is completely isolated
 * from notification_events/deliveries/targets/activation and from the
 * worker's own backward-compatible generic-copy fallback.
 *
 * notification_delivery_activation is a global, non-tenant-scoped
 * singleton — cleared explicitly wherever a test sets it, and in
 * afterAll, matching tests/notification-delivery-worker.test.ts's own
 * established convention.
 */

const admin = createAdminClient();

let tenant: TestTenant;
let owner: TestUser;
let appointmentId: string;
const cleanupUserIds: string[] = [];

async function setActivation(activatedAt: Date): Promise<void> {
  await testDb`
    insert into notification_delivery_activation (id, activated_at) values (1, ${activatedAt.toISOString()})
    on conflict (id) do update set activated_at = excluded.activated_at
  `;
}
async function clearActivation(): Promise<void> {
  await testDb`delete from notification_delivery_activation where id = 1`;
}

async function insertRawEvent(staffMemberIds: string[] = []): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    insert into notification_events (tenant_id, appointment_id, event_type, actor_user_id, event_data)
    values (${tenant.id}, ${appointmentId}, 'appointment.created', ${owner.id}, ${testDb.json({ staffMemberIds })})
    returning id
  `;
  if (!row) throw new Error("failed to insert test notification_events row");
  return row.id;
}

async function insertSnapshot(eventId: string, createdAt: Date): Promise<void> {
  await testDb`
    insert into notification_event_display_snapshots
      (event_id, tenant_id, customer_name, service_names, appointment_start_at, tenant_timezone, created_at)
    values (
      ${eventId}, ${tenant.id}, 'Test Customer', ${testDb.array(["Test Service"])},
      ${new Date().toISOString()}, 'UTC', ${createdAt.toISOString()}
    )
  `;
}

async function snapshotExists(eventId: string): Promise<boolean> {
  const rows = await testDb<{ event_id: string }[]>`
    select event_id from notification_event_display_snapshots where event_id = ${eventId}
  `;
  return rows.length > 0;
}

async function purge(batchSize = 500): Promise<number> {
  const { data, error } = await admin.rpc("purge_expired_notification_event_display_snapshots", {
    p_batch_size: batchSize,
  });
  if (error) throw new Error(`purge failed: ${error.message}`);
  return data as number;
}

/** now - n days, shifted by extraMs (positive = further into the past /
 * older, negative = closer to now / younger) — a deliberate few-second
 * margin around the 30-day boundary absorbs real network/DB latency
 * between this call and the SQL now() the purge function evaluates
 * against, without weakening what the boundary test actually proves. */
function daysAgo(n: number, extraMs = 0): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000 - extraMs);
}

beforeAll(async () => {
  owner = await createTestUser("notif2f2-owner");
  const tenantRow = await createTestTenant("notif2f2-retention", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug, ownerRoleId: tenantRow.ownerRoleId };
  cleanupUserIds.push(owner.id);

  const branchId = await createBranch(tenant.id, "NOTIF.2F.2 Branch");
  const customer = await createCustomer(tenant.id, "NOTIF.2F.2 Customer");
  const [appointment] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, source, scheduled_start_at, scheduled_end_at, created_by, status)
    values (${tenant.id}, ${branchId}, ${customer.id}, 'internal', now() + interval '1 day', now() + interval '1 day 30 minutes', ${owner.id}, 'scheduled')
    returning id
  `;
  if (!appointment) throw new Error("failed to create test appointment");
  appointmentId = appointment.id;
}, 60000);

afterAll(async () => {
  await clearActivation();
  await cleanupTenants([tenant.id]);
  await cleanupUsers(cleanupUserIds);
}, 60000);

describe("notification_event_display_snapshots retention purge (Faz NOTIF.2F.2)", () => {
  it("1. a snapshot older than 30 days is deleted", async () => {
    const eventId = await insertRawEvent();
    await insertSnapshot(eventId, daysAgo(31));

    const deleted = await purge();

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await snapshotExists(eventId)).toBe(false);
  });

  it("2. 30-day boundary: retained just under 30 days, deleted just past it", async () => {
    const underEventId = await insertRawEvent();
    await insertSnapshot(underEventId, daysAgo(30, -10_000)); // ~10s younger than 30 days
    const overEventId = await insertRawEvent();
    await insertSnapshot(overEventId, daysAgo(30, 10_000)); // ~10s older than 30 days

    await purge();

    expect(await snapshotExists(underEventId)).toBe(true);
    expect(await snapshotExists(overEventId)).toBe(false);

    await testDb`delete from notification_event_display_snapshots where event_id = ${underEventId}`;
  });

  it("3. a snapshot younger than 30 days is retained", async () => {
    const eventId = await insertRawEvent();
    await insertSnapshot(eventId, daysAgo(10));

    await purge();

    expect(await snapshotExists(eventId)).toBe(true);
  });

  it("4. batch size bounds a single call", async () => {
    const eventIds = await Promise.all(Array.from({ length: 5 }, () => insertRawEvent()));
    for (const id of eventIds) await insertSnapshot(id, daysAgo(40));

    const firstBatch = await purge(2);
    expect(firstBatch).toBe(2);

    const stillPresent = await Promise.all(eventIds.map(snapshotExists));
    expect(stillPresent.filter(Boolean).length).toBe(3);

    const secondBatch = await purge(100);
    expect(secondBatch).toBe(3);
  });

  // ===========================================================================
  // Faz NOTIF.2F.2 hardening — the database itself enforces a hard ceiling of
  // 500 via least(greatest(coalesce(p_batch_size,0),0),500), regardless of
  // what a caller requests. Runtime checks below use small (1-2 row)
  // fixtures deliberately — proving "500/501/999999 all behave safely and
  // delete only what actually exists, never erroring or overshooting" does
  // not require hundreds of real rows. The exact ceiling CONSTANT (500, not
  // some other number) is instead verified directly against the deployed
  // function's own source below, which is the efficient, authoritative way
  // to confirm the true ceiling without a thousand-row fixture.
  // ===========================================================================

  it("the deployed function's own source enforces the exact hard ceiling of 500", async () => {
    const [row] = await testDb<{ src: string }[]>`
      select pg_get_functiondef(
        'private.purge_expired_notification_event_display_snapshots(integer)'::regprocedure
      ) as src
    `;
    expect(row).toBeDefined();
    expect(row!.src).toContain("least(greatest(coalesce(p_batch_size, 0), 0), 500)");
  });

  it("negative batch size deletes 0, leaves expired rows in place", async () => {
    const eventId = await insertRawEvent();
    await insertSnapshot(eventId, daysAgo(40));

    expect(await purge(-5)).toBe(0);
    expect(await snapshotExists(eventId)).toBe(true);

    expect(await purge(500)).toBeGreaterThanOrEqual(1); // cleanup
  });

  it("zero batch size deletes 0, leaves expired rows in place", async () => {
    const eventId = await insertRawEvent();
    await insertSnapshot(eventId, daysAgo(40));

    expect(await purge(0)).toBe(0);
    expect(await snapshotExists(eventId)).toBe(true);

    expect(await purge(500)).toBeGreaterThanOrEqual(1); // cleanup
  });

  it("explicit NULL batch size, through the real client RPC path, deletes 0", async () => {
    const eventId = await insertRawEvent();
    await insertSnapshot(eventId, daysAgo(40));

    const { data, error } = await admin.rpc("purge_expired_notification_event_display_snapshots", {
      p_batch_size: null as unknown as number,
    });
    expect(error).toBeNull();
    expect(data).toBe(0);
    expect(await snapshotExists(eventId)).toBe(true);

    expect(await purge(500)).toBeGreaterThanOrEqual(1); // cleanup
  });

  it.each([
    ["500 (the documented default/ceiling)", 500],
    ["501 (one past the ceiling)", 501],
    ["999999 (far past the ceiling)", 999_999],
  ])("batch size %s deletes exactly the small number of real expired rows, never erroring or overshooting", async (_label, batchSize) => {
    const eventIds = await Promise.all(Array.from({ length: 2 }, () => insertRawEvent()));
    for (const id of eventIds) await insertSnapshot(id, daysAgo(40));

    const deleted = await purge(batchSize);

    expect(deleted).toBe(2);
    const remaining = await Promise.all(eventIds.map(snapshotExists));
    expect(remaining.every((exists) => !exists)).toBe(true);
  });

  it("5. concurrent purge calls do not double-process the same rows", async () => {
    const eventIds = await Promise.all(Array.from({ length: 10 }, () => insertRawEvent()));
    for (const id of eventIds) await insertSnapshot(id, daysAgo(40));

    const [a, b] = await Promise.all([purge(100), purge(100)]);
    expect(a + b).toBe(10);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);

    const stillPresent = await Promise.all(eventIds.map(snapshotExists));
    expect(stillPresent.every((exists) => !exists)).toBe(true);
  });

  it("6. anon/authenticated cannot execute the purge function", async () => {
    const rows = await testDb<{ role: string; can: boolean }[]>`
      select role, has_function_privilege(
        role, 'public.purge_expired_notification_event_display_snapshots(integer)', 'EXECUTE'
      ) as can
      from unnest(array['authenticated', 'anon']) as role
    `;
    for (const row of rows) expect(row.can).toBe(false);
  });

  it("7. purging leaves notification_events completely untouched", async () => {
    const eventId = await insertRawEvent();
    await insertSnapshot(eventId, daysAgo(40));

    const [before] = await testDb<{ id: string; event_type: string; created_at: string }[]>`
      select id, event_type, created_at from notification_events where id = ${eventId}
    `;

    await purge();

    const [after] = await testDb<{ id: string; event_type: string; created_at: string }[]>`
      select id, event_type, created_at from notification_events where id = ${eventId}
    `;
    expect(after).toEqual(before);
  });

  it("8. purging does not touch notification_deliveries/notification_delivery_targets", async () => {
    const eventId = await insertRawEvent();
    await insertSnapshot(eventId, daysAgo(40));

    const { error: materializeError } = await admin.rpc("materialize_notification_deliveries", {
      p_event_id: eventId,
    });
    expect(materializeError).toBeNull();

    const before = await testDb<{ id: string; status: string }[]>`
      select id, status from notification_deliveries where notification_event_id = ${eventId}
    `;

    await purge();

    const after = await testDb<{ id: string; status: string }[]>`
      select id, status from notification_deliveries where notification_event_id = ${eventId}
    `;
    expect(after).toEqual(before);
  });

  it("9. purging does not touch notification_delivery_activation", async () => {
    const activatedAt = new Date(Date.now() - 60_000);
    await setActivation(activatedAt);

    const eventId = await insertRawEvent();
    await insertSnapshot(eventId, daysAgo(40));

    await purge();

    const [row] = await testDb<{ activated_at: string }[]>`
      select activated_at from notification_delivery_activation where id = 1
    `;
    expect(row).toBeDefined();
    expect(new Date(row!.activated_at).getTime()).toBe(activatedAt.getTime());

    await clearActivation();
  });

  it("10. worker remains backward-compatible after its snapshot is purged (extremely delayed delivery)", async () => {
    await setActivation(new Date(Date.now() - 60_000));

    const roleId = await createRoleForTenant(tenant.id, "NOTIF.2F.2 Viewer", ["appointments.view"]);
    const recipientUser = await createTestUser("notif2f2-recipient");
    cleanupUserIds.push(recipientUser.id);
    const membershipId = await addMembership(tenant.id, recipientUser.id, roleId);
    const [staffRow] = await testDb<{ id: string }[]>`
      insert into staff_members (tenant_id, full_name, tenant_membership_id, status)
      values (${tenant.id}, 'NOTIF.2F.2 Recipient', ${membershipId}, 'active')
      returning id
    `;
    if (!staffRow) throw new Error("failed to create staff_members row");
    const [device] = await testDb<{ id: string }[]>`
      insert into push_subscriptions (tenant_membership_id, endpoint, p256dh, auth_key)
      values (${membershipId}, ${"https://example-push.test/notif2f2-" + Date.now()}, 'p256dh-x', 'authkey-x')
      returning id
    `;
    if (!device) throw new Error("failed to create push_subscriptions row");

    const eventId = await insertRawEvent([staffRow.id]);
    await insertSnapshot(eventId, daysAgo(40));

    const { error: materializeError } = await admin.rpc("materialize_notification_deliveries", {
      p_event_id: eventId,
    });
    expect(materializeError).toBeNull();
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });

    // Simulate the purge having already run before the worker ever
    // claimed this target — the "extremely delayed delivery" scenario
    // this phase's own requirements describe.
    await purge();
    expect(await snapshotExists(eventId)).toBe(false);

    let claimedTarget: ClaimedNotificationDeliveryTarget | undefined;
    const captureSend: SendPushFn = async (target) => {
      claimedTarget = target;
      return { outcome: "sent" };
    };
    const result = await processNotificationDeliveryBatch({ supabase: admin, sendPush: captureSend, claimBatchSize: 100 });

    expect(result.sent).toBe(1);
    expect(claimedTarget).toBeDefined();
    expect(claimedTarget!.customerName).toBeNull();
    expect(claimedTarget!.serviceNames).toBeNull();
    expect(claimedTarget!.appointmentStartAt).toBeNull();
    expect(claimedTarget!.tenantTimezone).toBeNull();

    const payload = buildDeliveryPushPayload(claimedTarget!.eventType, claimedTarget!.tenantSlug, {
      customerName: claimedTarget!.customerName,
      serviceNames: claimedTarget!.serviceNames,
      appointmentStartAt: claimedTarget!.appointmentStartAt,
      tenantTimezone: claimedTarget!.tenantTimezone,
    });
    expect(payload.title).toBe("SalonOS");
    expect(payload.body).toBe("Yeni randevu oluşturuldu.");

    await clearActivation();
  });
});
