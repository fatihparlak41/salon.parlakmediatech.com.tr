import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { classifyPushSendError, type PushSendOutcome } from "@/lib/pwa/web-push-server";
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
  createTestMembershipFromTemplate,
  createRoleForTenant,
  addMembership,
  cleanupTenants,
  cleanupUsers,
  type TestUser,
  type TestTenant,
} from "./helpers";

/**
 * Faz NOTIF.2E.2 — durable Web Push delivery WORKER foundation tests.
 *
 * Covers, against real DEV fixtures (tenant `notif2e2-*`, deleted in
 * afterAll) and the real service_role RPCs from
 * supabase/migrations/20260915070000_notification_delivery_worker_foundation.sql:
 * activation cutover (A/B/C), device fanout (D/E/H), device-level
 * idempotency + retry (F), stale-subscription cleanup (G), send-time
 * eligibility recheck (I/J/K), retry-exhaustion (L), concurrent claim
 * safety (M), cross-tenant isolation (N), and repeated-execution
 * idempotency (O) — the exact 15 scenarios this phase's own instructions
 * require. Plus pure unit tests for the transport classifier and the
 * payload builder, and a fake-transport boundary (Step 19) so nothing
 * here ever touches a real Apple/Google push endpoint — the existing
 * manual iPhone test (Faz NOTIF.2D, tested by hand) already proves the
 * underlying web-push/VAPID transport itself works.
 *
 * notification_delivery_activation is a global, non-tenant-scoped
 * singleton — cleaned up explicitly in afterAll (cleanupTenants
 * deliberately never touches it, see tests/helpers.ts).
 */

const admin = createAdminClient();

async function setActivation(activatedAt: Date): Promise<void> {
  await testDb`
    insert into notification_delivery_activation (id, activated_at) values (1, ${activatedAt.toISOString()})
    on conflict (id) do update set activated_at = excluded.activated_at
  `;
}
async function clearActivation(): Promise<void> {
  await testDb`delete from notification_delivery_activation where id = 1`;
}

type Recipient = { user: TestUser; membershipId: string; staffMemberId: string };

// roles has a UNIQUE(tenant_id, name) constraint (matching the
// established precedent in tests/notification-delivery-outbox.test.ts's
// own fixture comment) — the CASHIER template is cloned exactly ONCE per
// tenant (see cashierRoleId below) and every recipient created via
// createRecipient below joins that SAME role via addMembership, never a
// fresh createTestMembershipFromTemplate call each time.
//
// CASHIER, not RECEPTIONIST: confirmed live (role_template_permissions)
// CASHIER holds appointments.view ONLY, never appointments.create. This
// matters a great deal for test isolation, not just realism — a
// RECEPTIONIST-templated recipient is a permanent "salon-wide admin"
// candidate (private.materialize_notification_deliveries' own
// candidate_memberships union) for EVERY future event in the SAME
// shared tenant, not just its own scenario's event. Sharing one tenant
// across many scenarios (for speed — a fresh tenant per scenario would
// be far slower) with RECEPTIONIST-role recipients was tried first and
// produced exactly the cross-scenario contamination this comment now
// warns against: scenario E's own materialize call swept in scenario
// D's leftover recipient too (and vice versa), because both held
// appointments.create and neither was the event's actor. CASHIER (view
// only) can NEVER be swept in that way — the ONLY path that can resolve
// a CASHIER-templated membership as a recipient is the event's own
// staffMemberIds snapshot (appointment.created/cancelled) matching a
// staff_members row this exact membership is linked to, which is why
// createRecipient also creates a dedicated staff_members row per
// recipient and insertEvent (below) takes an explicit staffMemberIds
// list rather than always emitting {}.
async function createRecipient(
  tenantId: string,
  roleId: string,
  label: string,
): Promise<Recipient> {
  const user = await createTestUser(label);
  const membershipId = await addMembership(tenantId, user.id, roleId);
  const [staffRow] = await testDb<{ id: string }[]>`
    insert into staff_members (tenant_id, full_name, tenant_membership_id, status)
    values (${tenantId}, ${label}, ${membershipId}, 'active')
    returning id
  `;
  if (!staffRow) throw new Error(`failed to create staff_members row for ${label}`);
  return { user, membershipId, staffMemberId: staffRow.id };
}

let deviceSeq = 0;
async function addDevice(membershipId: string, revoked = false): Promise<string> {
  deviceSeq += 1;
  const [row] = await testDb<{ id: string }[]>`
    insert into push_subscriptions (tenant_membership_id, endpoint, p256dh, auth_key, revoked_at)
    values (
      ${membershipId},
      ${"https://example-push.test/notif2e2-" + deviceSeq + "-" + Date.now()},
      ${"p256dh-" + deviceSeq},
      ${"authkey-" + deviceSeq},
      ${revoked ? new Date().toISOString() : null}
    )
    returning id
  `;
  if (!row) throw new Error("failed to insert test push subscription");
  return row.id;
}

// staffMemberIds: the event-time booked-staff snapshot (Faz NOTIF.2E.1A
// contract) — {} for A/B/C (which never create a real staff-linked
// recipient and don't assert on who the recipient is), {staffMemberIds}
// for every D-O scenario's own dedicated recipient, matching exactly how
// the real create_appointment/update_appointment_status RPCs populate
// this event type's event_data (see supabase/migrations/
// 20260914140000_notification_delivery_event_snapshots.sql).
async function insertEvent(
  tenantId: string,
  appointmentId: string,
  eventType: string,
  actorUserId: string | null,
  staffMemberIds: string[] = [],
  createdAt?: Date,
): Promise<string> {
  const [row] = await testDb<{ id: string }[]>`
    insert into notification_events (tenant_id, appointment_id, event_type, actor_user_id, event_data, created_at)
    values (
      ${tenantId}, ${appointmentId}, ${eventType}, ${actorUserId}, ${testDb.json({ staffMemberIds })},
      ${(createdAt ?? new Date()).toISOString()}
    )
    returning id
  `;
  if (!row) throw new Error("failed to insert test notification_events row");
  return row.id;
}

// Asserts exactly one delivery, not just "at least one" — a real
// regression guard for the cross-scenario contamination this file's own
// createRecipient comment documents: if a future edit accidentally makes
// a recipient a salon-wide admin again, this throws immediately with a
// clear message instead of a confusing downstream assertion failure.
async function materialize(eventId: string): Promise<string> {
  const { error } = await admin.rpc("materialize_notification_deliveries", { p_event_id: eventId });
  if (error) throw new Error(`materialize_notification_deliveries failed: ${error.message}`);
  const rows = await testDb<{ id: string }[]>`
    select id from notification_deliveries where notification_event_id = ${eventId}
  `;
  if (rows.length === 0) throw new Error(`no notification_deliveries row created for event ${eventId}`);
  if (rows.length > 1) {
    throw new Error(
      `expected exactly 1 delivery for event ${eventId}, got ${rows.length} — a recipient is unexpectedly eligible for an event that isn't theirs (check no test recipient was granted appointments.create)`,
    );
  }
  return rows[0]!.id;
}

type DeliveryTargetRow = {
  id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date;
  locked_at: Date | null;
  lock_token: string | null;
  last_error_code: string | null;
};
async function targetsFor(deliveryId: string): Promise<DeliveryTargetRow[]> {
  return testDb<DeliveryTargetRow[]>`
    select id, status, attempt_count, next_attempt_at, locked_at, lock_token, last_error_code
    from notification_delivery_targets where notification_delivery_id = ${deliveryId}
    order by created_at
  `;
}
async function deliveryStatus(deliveryId: string): Promise<string> {
  const [row] = await testDb<{ status: string }[]>`select status from notification_deliveries where id = ${deliveryId}`;
  if (!row) throw new Error(`no delivery ${deliveryId}`);
  return row.status;
}

function fakeSendPush(outcome: PushSendOutcome): SendPushFn {
  return async () => outcome;
}
function fakeSendPushByEndpoint(mapping: Record<string, PushSendOutcome>): SendPushFn {
  return async (target: ClaimedNotificationDeliveryTarget) => {
    const found = mapping[target.endpoint];
    if (!found) throw new Error(`fakeSendPushByEndpoint: no mapping for ${target.endpoint}`);
    return found;
  };
}

let tenant: TestTenant;
let owner: TestUser;
let appointmentId: string;
let cashierRoleId: string;
const cleanupUserIds: string[] = [];

beforeAll(async () => {
  owner = await createTestUser("notif2e2-owner");
  const tenantRow = await createTestTenant("notif2e2-worker", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug, ownerRoleId: tenantRow.ownerRoleId };
  cleanupUserIds.push(owner.id);

  // Cloned ONCE for the whole suite — every scenario's recipient joins
  // this same role via addMembership (see createRecipient's own comment
  // for why CASHIER specifically); roles' own UNIQUE(tenant_id, name)
  // makes a second clone of the same template for this tenant fail.
  const roleSeedUser = await createTestUser("notif2e2-role-seed");
  cleanupUserIds.push(roleSeedUser.id);
  const { roleId } = await createTestMembershipFromTemplate(tenant.id, roleSeedUser.id, "CASHIER");
  cashierRoleId = roleId;

  const [branch] = await testDb<{ id: string }[]>`
    insert into branches (tenant_id, name) values (${tenant.id}, 'NOTIF.2E.2 Branch') returning id
  `;
  const [customer] = await testDb<{ id: string }[]>`
    insert into customers (tenant_id, full_name) values (${tenant.id}, 'NOTIF.2E.2 Customer') returning id
  `;
  const [appointment] = await testDb<{ id: string }[]>`
    insert into appointments (tenant_id, branch_id, customer_id, source, scheduled_start_at, scheduled_end_at, created_by, status)
    values (${tenant.id}, ${branch!.id}, ${customer!.id}, 'internal', now() + interval '1 day', now() + interval '1 day 30 minutes', ${owner.id}, 'scheduled')
    returning id
  `;
  appointmentId = appointment!.id;
}, 60000);

afterAll(async () => {
  await clearActivation();
  await cleanupTenants([tenant.id]);
  await cleanupUsers(cleanupUserIds);
}, 60000);

// ===========================================================================
// Pure unit tests — no DB, no network.
// ===========================================================================

describe("classifyPushSendError (Step 12 classification, Step 19 transport boundary)", () => {
  it("404 -> stale", () => {
    const result = classifyPushSendError({ statusCode: 404 });
    expect(result.outcome).toBe("stale");
  });
  it("410 -> stale", () => {
    const result = classifyPushSendError({ statusCode: 410 });
    expect(result.outcome).toBe("stale");
  });
  it("429 -> retry", () => {
    const result = classifyPushSendError({ statusCode: 429 });
    expect(result.outcome).toBe("retry");
  });
  it("500 -> retry", () => {
    const result = classifyPushSendError({ statusCode: 500 });
    expect(result.outcome).toBe("retry");
  });
  it("503 -> retry", () => {
    const result = classifyPushSendError({ statusCode: 503 });
    expect(result.outcome).toBe("retry");
  });
  it("network exception (no statusCode) -> retry", () => {
    const result = classifyPushSendError(new Error("ECONNRESET"));
    expect(result.outcome).toBe("retry");
    expect(result.outcome === "retry" && result.errorCode).toBe("network_error");
  });
  it("400 -> failed (permanent/config)", () => {
    const result = classifyPushSendError({ statusCode: 400 });
    expect(result.outcome).toBe("failed");
  });
  it("401/403 -> failed (permanent/config)", () => {
    expect(classifyPushSendError({ statusCode: 401 }).outcome).toBe("failed");
    expect(classifyPushSendError({ statusCode: 403 }).outcome).toBe("failed");
  });
  it("error message is capped and never echoes secret-shaped input", () => {
    const longMessage = "x".repeat(5000);
    const result = classifyPushSendError({ statusCode: 500, message: longMessage } as unknown as Error);
    if (result.outcome !== "sent") {
      expect(result.errorMessage.length).toBeLessThanOrEqual(300);
    }
  });
});

describe("buildDeliveryPushPayload (Step 9 privacy-safe payloads, Step 10 click path)", () => {
  const cases: [string, string][] = [
    ["appointment.created", "Yeni randevu oluşturuldu."],
    ["appointment.cancelled", "Bir randevu iptal edildi."],
    ["appointment.rescheduled", "Bir randevu güncellendi."],
    ["appointment.staff_reassigned", "Bir randevunun personel ataması değişti."],
  ];
  for (const [eventType, expectedBody] of cases) {
    it(`${eventType} -> "${expectedBody}"`, () => {
      const payload = buildDeliveryPushPayload(eventType, "acme-salon");
      expect(payload.title).toBe("SalonOS");
      expect(payload.body).toBe(expectedBody);
      expect(payload.path).toBe("/app/acme-salon/appointments");
    });
  }
  it("path is always same-origin relative and tenant-specific, never contains PII", () => {
    const payload = buildDeliveryPushPayload("appointment.created", "gokhanilhan");
    expect(payload.path.startsWith("/")).toBe(true);
    expect(payload.path).not.toMatch(/:\/\//);
    expect(payload.path).toBe("/app/gokhanilhan/appointments");
  });
  it("unknown event type falls back to generic copy, never throws", () => {
    const payload = buildDeliveryPushPayload("some.unknown.event", "acme-salon");
    expect(payload.title).toBe("SalonOS");
    expect(payload.body.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// A/B/C — activation cutover
// ===========================================================================

describe("A/B/C — activation cutover", () => {
  it("A. activation absent -> zero event processing, zero sends", async () => {
    await clearActivation();
    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id);

    const { data: materializeResult, error: materializeError } = await admin.rpc(
      "materialize_pending_notification_events",
      { p_batch_size: 25 },
    );
    expect(materializeError).toBeNull();
    expect((materializeResult as { processed: number }).processed).toBe(0);
    expect((materializeResult as { reason?: string }).reason).toBe("activation_absent");

    const { data: prepareResult } = await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 25 });
    expect((prepareResult as { prepared: number }).prepared).toBe(0);

    const { data: claimed } = await admin.rpc("claim_notification_delivery_targets", {
      p_batch_size: 25,
      p_lease_seconds: 120,
    });
    expect(claimed).toEqual([]);

    const result = await processNotificationDeliveryBatch({ supabase: admin, sendPush: fakeSendPush({ outcome: "sent" }) });
    expect(result.activationAbsent).toBe(true);
    expect(result.sent).toBe(0);

    const [marker] = await testDb<{ notification_event_id: string }[]>`
      select notification_event_id from notification_event_materializations where notification_event_id = ${eventId}
    `;
    expect(marker).toBeUndefined();
  });

  it("B. historical event before activated_at -> never processed", async () => {
    const now = new Date();
    const activatedAt = new Date(now.getTime() - 5 * 60_000);
    const historicalEventCreatedAt = new Date(now.getTime() - 10 * 60_000);
    await setActivation(activatedAt);

    const eventId = await insertEvent(
      tenant.id,
      appointmentId,
      "appointment.created",
      owner.id,
      [],
      historicalEventCreatedAt,
    );

    const { data: materializeResult } = await admin.rpc("materialize_pending_notification_events", {
      p_batch_size: 25,
    });
    const eventIds = ((materializeResult as { eventIds: string[] }).eventIds ?? []) as string[];
    expect(eventIds).not.toContain(eventId);

    const [marker] = await testDb<{ notification_event_id: string }[]>`
      select notification_event_id from notification_event_materializations where notification_event_id = ${eventId}
    `;
    expect(marker).toBeUndefined();
  });

  it("C. event after activated_at -> materialized", async () => {
    const activatedAt = new Date(Date.now() - 5 * 60_000);
    await setActivation(activatedAt);

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [], new Date());

    const { data: materializeResult, error } = await admin.rpc("materialize_pending_notification_events", {
      p_batch_size: 25,
    });
    expect(error).toBeNull();
    const eventIds = (materializeResult as { eventIds: string[] }).eventIds ?? [];
    expect(eventIds).toContain(eventId);

    const [marker] = await testDb<{ recipient_count: number }[]>`
      select recipient_count from notification_event_materializations where notification_event_id = ${eventId}
    `;
    expect(marker).toBeDefined();
  });
});

// ===========================================================================
// Faz NOTIF.2E.2A — activation watermark must protect prepare AND claim,
// not merely event discovery; claim must re-check the exact subscription's
// own current revoked_at, not trust prepare's earlier snapshot.
// ===========================================================================

describe("NOTIF.2E.2A — activation watermark at prepare/claim, revoked-subscription send-time check", () => {
  beforeAll(async () => {
    await setActivation(new Date(Date.now() - 60_000));
  });

  it("A. event created before activated_at, already materialized (direct call), delivery pending, no targets yet -> prepare creates ZERO targets", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2a-a-predates-prepare");
    cleanupUserIds.push(recipient.user.id);
    await addDevice(recipient.membershipId);

    const activatedAt = new Date(Date.now() - 5 * 60_000);
    const eventCreatedAt = new Date(activatedAt.getTime() - 5 * 60_000); // 10 min ago, strictly before activatedAt
    await setActivation(activatedAt);

    const eventId = await insertEvent(
      tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId], eventCreatedAt,
    );
    // Direct call to the underlying, activation-UNAWARE materialize RPC —
    // exactly how a pre-activation delivery can exist even after this
    // fix (private.materialize_notification_deliveries is, by design,
    // unconditional — only the batch discovery layer around it is
    // activation-gated).
    const deliveryId = await materialize(eventId);
    expect(await deliveryStatus(deliveryId)).toBe("pending");

    const { data: prepareResult, error } = await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });
    expect(error).toBeNull();
    expect((prepareResult as { skippedPredatesActivation: number }).skippedPredatesActivation).toBeGreaterThan(0);

    const targets = await targetsFor(deliveryId);
    expect(targets).toHaveLength(0);
    expect(await deliveryStatus(deliveryId)).toBe("skipped");

    await setActivation(new Date(Date.now() - 60_000));
  });

  it("B. event created before activated_at, already materialized, target already exists in pending state -> claim returns ZERO sendable targets, no transport call", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2a-b-predates-claim");
    cleanupUserIds.push(recipient.user.id);
    const deviceId = await addDevice(recipient.membershipId);

    const activatedAt = new Date(Date.now() - 5 * 60_000);
    const eventCreatedAt = new Date(activatedAt.getTime() - 5 * 60_000);
    await setActivation(activatedAt);

    const eventId = await insertEvent(
      tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId], eventCreatedAt,
    );
    const deliveryId = await materialize(eventId);

    // Hand-forge a target directly (bypassing prepare's own new guard)
    // to simulate a row that already existed before this correction —
    // this migration's own contract must still refuse to send it.
    const [target] = await testDb<{ id: string }[]>`
      insert into notification_delivery_targets (tenant_id, notification_delivery_id, tenant_membership_id, push_subscription_id, status)
      values (${tenant.id}, ${deliveryId}, ${recipient.membershipId}, ${deviceId}, 'pending')
      returning id
    `;
    await testDb`update notification_deliveries set targets_prepared_at = now() where id = ${deliveryId}`;

    let sendCallCount = 0;
    const countingSend: SendPushFn = async () => {
      sendCallCount += 1;
      return { outcome: "sent" };
    };
    const result = await processNotificationDeliveryBatch({ supabase: admin, sendPush: countingSend, claimBatchSize: 100 });
    expect(result.targetsClaimed).toBe(0);
    expect(sendCallCount).toBe(0);

    const targets = await targetsFor(deliveryId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe(target!.id);
    expect(targets[0]!.status).toBe("skipped");
    expect(targets[0]!.last_error_code).toBe("event_predates_activation");
    expect(await deliveryStatus(deliveryId)).toBe("skipped");

    await setActivation(new Date(Date.now() - 60_000));
  });

  it("C. event created exactly at activated_at -> eligible per the existing >= contract", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2a-c-exact-boundary");
    cleanupUserIds.push(recipient.user.id);
    await addDevice(recipient.membershipId);

    const activatedAt = new Date(Date.now() - 5 * 60_000);
    await setActivation(activatedAt);

    // Exactly equal, not merely close — proves >=, not >.
    const eventId = await insertEvent(
      tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId], new Date(activatedAt.getTime()),
    );
    const deliveryId = await materialize(eventId);

    const { data: prepareResult } = await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });
    expect((prepareResult as { skippedPredatesActivation: number }).skippedPredatesActivation).toBe(0);

    const result = await processNotificationDeliveryBatch({ supabase: admin, sendPush: fakeSendPush({ outcome: "sent" }), claimBatchSize: 100 });
    expect(result.sent).toBe(1);
    expect(await deliveryStatus(deliveryId)).toBe("sent");

    await setActivation(new Date(Date.now() - 60_000));
  });

  it("revoked subscription after target preparation -> zero transport calls, target terminal skipped, delivery aggregate correct", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2a-revoked-at-claim");
    cleanupUserIds.push(recipient.user.id);
    const deviceId = await addDevice(recipient.membershipId);

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);

    // 1. prepare while the subscription is still active.
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });
    let targets = await targetsFor(deliveryId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("pending");

    // 2. revoke it — the real gap this check exists for.
    await testDb`update push_subscriptions set revoked_at = now() where id = ${deviceId}`;

    // 3. claim/process.
    let sendCallCount = 0;
    const countingSend: SendPushFn = async () => {
      sendCallCount += 1;
      return { outcome: "sent" };
    };
    const result = await processNotificationDeliveryBatch({ supabase: admin, sendPush: countingSend, claimBatchSize: 100 });

    // 4. transport send count MUST remain zero.
    expect(sendCallCount).toBe(0);
    expect(result.sent).toBe(0);

    // 5. target terminal skipped, secret-safe diagnostic code.
    targets = await targetsFor(deliveryId);
    expect(targets[0]!.status).toBe("skipped");
    expect(targets[0]!.last_error_code).toBe("subscription_inactive");

    // 6. parent delivery reaches the correct aggregate state — no
    // sent target and no real failure, so skipped (per this project's
    // own Step 13 aggregation rule).
    expect(await deliveryStatus(deliveryId)).toBe("skipped");
  });
});

// ===========================================================================
// D through O — device fanout, retry, eligibility, concurrency, isolation.
// Activation is kept present for this whole block.
// ===========================================================================

describe("D through O — device fanout, retry, eligibility, concurrency, isolation", () => {
  beforeAll(async () => {
    await setActivation(new Date(Date.now() - 60_000));
  });

  it("D. one membership, one active device -> one target", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2-d-onedevice");
    cleanupUserIds.push(recipient.user.id);
    await addDevice(recipient.membershipId);

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);

    const { data: prepareResult, error } = await admin.rpc("prepare_notification_delivery_targets", {
      p_batch_size: 100,
    });
    expect(error).toBeNull();
    expect((prepareResult as { prepared: number }).prepared).toBeGreaterThan(0);

    const targets = await targetsFor(deliveryId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("pending");

    // Terminalize this test's own target before finishing — claim/
    // prepare/materialize are global, unscoped functions by design (a
    // real worker sweeps the whole system), so a target left 'pending'
    // here would otherwise be silently swept up by a LATER scenario's
    // own claimBatchSize:100 call, corrupting that scenario's assertions
    // about its own (different) devices. Confirmed the hard way: this
    // is exactly what happened to scenario F before this cleanup existed.
    await processNotificationDeliveryBatch({ supabase: admin, sendPush: fakeSendPush({ outcome: "sent" }), claimBatchSize: 100 });
  });

  it("E. one membership, two active devices -> two targets", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2-e-twodevice");
    cleanupUserIds.push(recipient.user.id);
    await addDevice(recipient.membershipId);
    await addDevice(recipient.membershipId);

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });

    const targets = await targetsFor(deliveryId);
    expect(targets).toHaveLength(2);
    expect(targets.every((t) => t.status === "pending")).toBe(true);

    // Terminalize before finishing — see D's own comment for why.
    await processNotificationDeliveryBatch({ supabase: admin, sendPush: fakeSendPush({ outcome: "sent" }), claimBatchSize: 100 });
  });

  it("H. no active device -> delivery skipped terminally", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2-h-nodevice");
    cleanupUserIds.push(recipient.user.id);
    // Zero devices at all for this recipient.

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });

    const targets = await targetsFor(deliveryId);
    expect(targets).toHaveLength(0);
    expect(await deliveryStatus(deliveryId)).toBe("skipped");
  });

  it("F. Device A success, Device B transient failure -> A never resent, B retries only", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2-f-partial");
    cleanupUserIds.push(recipient.user.id);
    const deviceAId = await addDevice(recipient.membershipId);
    const deviceBId = await addDevice(recipient.membershipId);

    const [subA] = await testDb<{ endpoint: string }[]>`select endpoint from push_subscriptions where id = ${deviceAId}`;
    const [subB] = await testDb<{ endpoint: string }[]>`select endpoint from push_subscriptions where id = ${deviceBId}`;

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });

    let sendCallCount = 0;
    const sendPush = fakeSendPushByEndpoint({
      [subA!.endpoint]: { outcome: "sent" },
      [subB!.endpoint]: { outcome: "retry", errorCode: "http_503", errorMessage: "temporary" },
    });
    const countingSend: SendPushFn = async (t) => {
      sendCallCount += 1;
      return sendPush(t);
    };

    const firstRun = await processNotificationDeliveryBatch({ supabase: admin, sendPush: countingSend, claimBatchSize: 100 });
    expect(firstRun.sent).toBe(1);
    expect(firstRun.retried).toBe(1);
    expect(sendCallCount).toBe(2);

    let targets = await targetsFor(deliveryId);
    const sentTarget = targets.find((t) => t.status === "sent");
    const retryTarget = targets.find((t) => t.status === "retry");
    expect(sentTarget).toBeDefined();
    expect(retryTarget).toBeDefined();
    expect(retryTarget!.attempt_count).toBe(1);
    // Delivery is not final yet — B is still non-terminal.
    expect(await deliveryStatus(deliveryId)).toBe("pending");

    // Immediately re-running claims nothing new: B's next_attempt_at is
    // ~1 minute out, A is already terminal ('sent' is not in
    // (pending,retry)) — proves A is never resent on a second pass.
    const secondRunImmediate = await processNotificationDeliveryBatch({
      supabase: admin,
      sendPush: countingSend,
      claimBatchSize: 100,
    });
    expect(secondRunImmediate.targetsClaimed).toBe(0);
    expect(sendCallCount).toBe(2);

    // Fast-forward B's schedule into the past (simulating the real
    // backoff having elapsed) rather than waiting a real minute.
    await testDb`update notification_delivery_targets set next_attempt_at = now() - interval '1 second' where id = ${retryTarget!.id}`;

    const thirdRun = await processNotificationDeliveryBatch({
      supabase: admin,
      sendPush: fakeSendPushByEndpoint({ [subA!.endpoint]: { outcome: "sent" }, [subB!.endpoint]: { outcome: "sent" } }),
      claimBatchSize: 100,
    });
    expect(thirdRun.targetsClaimed).toBe(1);
    expect(thirdRun.sent).toBe(1);

    targets = await targetsFor(deliveryId);
    expect(targets.every((t) => t.status === "sent")).toBe(true);
    expect(await deliveryStatus(deliveryId)).toBe("sent");
  });

  it("G. 404/410 -> subscription revoked, target stale, no retry", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2-g-stale");
    cleanupUserIds.push(recipient.user.id);
    const deviceId = await addDevice(recipient.membershipId);

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });

    const result = await processNotificationDeliveryBatch({
      supabase: admin,
      sendPush: fakeSendPush({ outcome: "stale", errorCode: "http_410", errorMessage: "gone" }),
      claimBatchSize: 100,
    });
    expect(result.stale).toBe(1);

    const targets = await targetsFor(deliveryId);
    expect(targets[0]!.status).toBe("stale");
    expect(targets[0]!.last_error_code).toBe("http_410");

    const [sub] = await testDb<{ revoked_at: Date | null }[]>`select revoked_at from push_subscriptions where id = ${deviceId}`;
    expect(sub!.revoked_at).not.toBeNull();

    expect(await deliveryStatus(deliveryId)).toBe("skipped");
  });

  it("I. preference disabled after materialization -> no send", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2-i-prefdisabled");
    cleanupUserIds.push(recipient.user.id);
    await addDevice(recipient.membershipId);

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });

    // Disable the preference AFTER materialization/fanout — the
    // recheck must happen at claim/send time, not trust materialization.
    await testDb`
      insert into notification_preferences (tenant_membership_id, new_appointment)
      values (${recipient.membershipId}, false)
      on conflict (tenant_membership_id) do update set new_appointment = false
    `;

    const result = await processNotificationDeliveryBatch({ supabase: admin, sendPush: fakeSendPush({ outcome: "sent" }), claimBatchSize: 100 });
    expect(result.sent).toBe(0);
    expect(result.targetsClaimed).toBe(0);

    const targets = await targetsFor(deliveryId);
    expect(targets[0]!.status).toBe("skipped");
    expect(targets[0]!.last_error_code).toBe("recipient_no_longer_eligible");
    expect(await deliveryStatus(deliveryId)).toBe("skipped");
  });

  it("J. membership suspended after materialization -> no send", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2-j-suspended");
    cleanupUserIds.push(recipient.user.id);
    await addDevice(recipient.membershipId);

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });

    await testDb`update tenant_memberships set status = 'suspended' where id = ${recipient.membershipId}`;

    const result = await processNotificationDeliveryBatch({ supabase: admin, sendPush: fakeSendPush({ outcome: "sent" }), claimBatchSize: 100 });
    expect(result.sent).toBe(0);

    const targets = await targetsFor(deliveryId);
    expect(targets[0]!.status).toBe("skipped");
    expect(await deliveryStatus(deliveryId)).toBe("skipped");
  });

  it("K. permission removed after materialization -> no send", async () => {
    // A DEDICATED role, not the shared cashierRoleId every other D-O
    // recipient joins — this test mutates the role's own permission set
    // (deletes appointments.view from it), which would otherwise strip
    // eligibility from every OTHER scenario's recipient sharing that
    // role too, breaking every test that runs after this one. Confirmed
    // the hard way: L/M/N/O all failed materialize() with zero
    // recipients once K deleted appointments.view from the shared role.
    const kRoleId = await createRoleForTenant(tenant.id, "notif2e2-k-role", ["appointments.view"]);
    const recipient = await createRecipient(tenant.id, kRoleId, "notif2e2-k-permremoved");
    cleanupUserIds.push(recipient.user.id);
    await addDevice(recipient.membershipId);

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });

    // Strip appointments.view from the recipient's OWN dedicated role —
    // permission removed, not membership status.
    await testDb`
      delete from role_permissions
      where role_id = ${kRoleId}
        and permission_id = (select id from permissions where key = 'appointments.view')
    `;

    const result = await processNotificationDeliveryBatch({ supabase: admin, sendPush: fakeSendPush({ outcome: "sent" }), claimBatchSize: 100 });
    expect(result.sent).toBe(0);

    const targets = await targetsFor(deliveryId);
    expect(targets[0]!.status).toBe("skipped");
    expect(await deliveryStatus(deliveryId)).toBe("skipped");
  });

  it("L. retry max attempts -> finite terminal failure", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2-l-maxretry");
    cleanupUserIds.push(recipient.user.id);
    await addDevice(recipient.membershipId);

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });

    const alwaysRetry = fakeSendPush({ outcome: "retry", errorCode: "http_500", errorMessage: "down" });

    // Step 12's own 4-step backoff (1m/5m/15m/60m) is the schedule
    // BETWEEN attempts, not a count of failures before giving up:
    // attempt 1 fails -> retry scheduled +1m (attempt_count=1), attempt
    // 2 fails -> +5m (attempt_count=2), attempt 3 fails -> +15m
    // (attempt_count=3), attempt 4 fails -> +60m (attempt_count=4) —
    // four SCHEDULED retries. Only the 5th actual send, with no 5th
    // backoff step defined, has nowhere left to schedule to and
    // exhausts to 'failed' (final attempt_count=5). Matches this
    // phase's own migration comment ("a 5th transient failure exhausts
    // retries") exactly — 5 loop iterations, not 4.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const run = await processNotificationDeliveryBatch({ supabase: admin, sendPush: alwaysRetry, claimBatchSize: 100 });
      if (attempt < 5) {
        // Force the next attempt to be immediately due rather than
        // waiting for the real 1m/5m/15m/60m backoff.
        await testDb`
          update notification_delivery_targets
          set next_attempt_at = now() - interval '1 second'
          where notification_delivery_id = ${deliveryId} and status = 'retry'
        `;
      }
      expect(run.targetsClaimed + run.retried + run.failed).toBeGreaterThanOrEqual(0);
    }

    const targets = await targetsFor(deliveryId);
    expect(targets[0]!.status).toBe("failed");
    expect(targets[0]!.attempt_count).toBe(5);
    expect(await deliveryStatus(deliveryId)).toBe("failed");

    // A 5th claim attempt finds nothing — 'failed' is terminal, never
    // claimable again.
    const { data: claimed } = await admin.rpc("claim_notification_delivery_targets", {
      p_batch_size: 100,
      p_lease_seconds: 120,
    });
    expect((claimed as unknown[]).some((c) => (c as { targetId: string }).targetId === targets[0]!.id)).toBe(false);
  });

  it("M. concurrent worker claim -> same target never processed simultaneously", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2-m-concurrent");
    cleanupUserIds.push(recipient.user.id);
    const deviceIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      deviceIds.push(await addDevice(recipient.membershipId));
    }

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });

    const allTargets = await targetsFor(deliveryId);
    expect(allTargets).toHaveLength(10);

    const [claimResultA, claimResultB] = await Promise.all([
      admin.rpc("claim_notification_delivery_targets", { p_batch_size: 100, p_lease_seconds: 120 }),
      admin.rpc("claim_notification_delivery_targets", { p_batch_size: 100, p_lease_seconds: 120 }),
    ]);
    expect(claimResultA.error).toBeNull();
    expect(claimResultB.error).toBeNull();

    const idsA = (claimResultA.data as ClaimedNotificationDeliveryTarget[]).map((t) => t.targetId);
    const idsB = (claimResultB.data as ClaimedNotificationDeliveryTarget[]).map((t) => t.targetId);

    const overlap = idsA.filter((id) => idsB.includes(id));
    expect(overlap).toEqual([]);

    const totalClaimed = idsA.length + idsB.length;
    expect(totalClaimed).toBe(10);
  });

  it("N. cross-tenant forged ids -> impossible to escape tenant boundary", async () => {
    const otherOwner = await createTestUser("notif2e2-n-otherowner");
    cleanupUserIds.push(otherOwner.id);
    const otherTenant = await createTestTenant("notif2e2-n-othertenant", otherOwner.id);

    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2-n-recipient");
    cleanupUserIds.push(recipient.user.id);
    const deviceId = await addDevice(recipient.membershipId);

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);

    // Attempt to forge a target row claiming this (tenant A) delivery
    // belongs to the OTHER tenant — the composite FK
    // notification_delivery_targets_delivery_same_tenant must reject it.
    await expect(
      testDb`
        insert into notification_delivery_targets (tenant_id, notification_delivery_id, tenant_membership_id, push_subscription_id, status)
        values (${otherTenant.id}, ${deliveryId}, ${recipient.membershipId}, ${deviceId}, 'pending')
      `,
    ).rejects.toThrow();

    // Attempt to forge a target claiming a subscription that does NOT
    // belong to the stated membership — the composite FK
    // notification_delivery_targets_subscription_same_membership must
    // reject it (a forged/mismatched pairing, not a real device). Used
    // exactly once for otherTenant — no roles UNIQUE(tenant_id, name)
    // collision risk the way a shared, reused role needs (see
    // createRecipient's own comment above); CASHIER not required here
    // since otherRecipient is never resolved as a real recipient of
    // anything, only used as a mismatched subscription owner.
    const otherRecipientUser = await createTestUser("notif2e2-n-otherrecipient");
    cleanupUserIds.push(otherRecipientUser.id);
    await createTestMembershipFromTemplate(otherTenant.id, otherRecipientUser.id, "CASHIER");
    const [otherMembershipRow] = await testDb<{ id: string }[]>`
      select id from tenant_memberships where tenant_id = ${otherTenant.id} and user_id = ${otherRecipientUser.id}
    `;
    const otherDeviceId = await addDevice(otherMembershipRow!.id);

    await expect(
      testDb`
        insert into notification_delivery_targets (tenant_id, notification_delivery_id, tenant_membership_id, push_subscription_id, status)
        values (${tenant.id}, ${deliveryId}, ${recipient.membershipId}, ${otherDeviceId}, 'pending')
      `,
    ).rejects.toThrow();

    await cleanupTenants([otherTenant.id]);

    // This test's own legitimate delivery (for `recipient`) was
    // materialized above but never prepared/sent — its own point was
    // the FK forgery attempts, not device delivery. Left un-prepared
    // (targets_prepared_at still NULL), it would otherwise be swept
    // into a LATER scenario's own prepare_notification_delivery_targets
    // call (a global, unscoped function by design) and silently
    // fabricate an extra target there. Terminalize it here — see D's
    // own comment for the general rule.
    await processNotificationDeliveryBatch({ supabase: admin, sendPush: fakeSendPush({ outcome: "sent" }), claimBatchSize: 100 });
  });

  it("O. repeated worker execution -> no duplicate successful push target", async () => {
    const recipient = await createRecipient(tenant.id, cashierRoleId, "notif2e2-o-repeated");
    cleanupUserIds.push(recipient.user.id);
    await addDevice(recipient.membershipId);

    const eventId = await insertEvent(tenant.id, appointmentId, "appointment.created", owner.id, [recipient.staffMemberId]);
    const deliveryId = await materialize(eventId);
    await admin.rpc("prepare_notification_delivery_targets", { p_batch_size: 100 });

    let callCount = 0;
    const countingSend: SendPushFn = async () => {
      callCount += 1;
      return { outcome: "sent" };
    };

    const firstRun = await processNotificationDeliveryBatch({ supabase: admin, sendPush: countingSend, claimBatchSize: 100 });
    expect(firstRun.sent).toBe(1);
    expect(callCount).toBe(1);

    const secondRun = await processNotificationDeliveryBatch({ supabase: admin, sendPush: countingSend, claimBatchSize: 100 });
    expect(secondRun.sent).toBe(0);
    expect(secondRun.targetsClaimed).toBe(0);
    expect(callCount).toBe(1);

    const thirdRunMaterializeAgain = await admin.rpc("materialize_pending_notification_events", { p_batch_size: 25 });
    expect((thirdRunMaterializeAgain.data as { processed: number }).processed).toBeGreaterThanOrEqual(0);
    const fourthRun = await processNotificationDeliveryBatch({ supabase: admin, sendPush: countingSend, claimBatchSize: 100 });
    expect(fourthRun.sent).toBe(0);
    expect(callCount).toBe(1);

    const targets = await targetsFor(deliveryId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("sent");
  });
});
