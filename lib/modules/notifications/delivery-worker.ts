import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { sendDeliveryPush, type PushSendOutcome } from "@/lib/pwa/web-push-server";
import { buildDeliveryPushPayload } from "@/lib/modules/notifications/payload";

/**
 * Faz NOTIF.2E.2 Step 15 — the reusable server-only worker core.
 *
 * NOT wired to anything automatic in this phase: no API route, no cron,
 * no webhook, no Supabase Edge Function (that is NOTIF.2E.3). The only
 * callers today are fixture tests, invoking this function directly.
 *
 * Deliberately thin: every real decision — whether activation exists,
 * which events/deliveries/targets are eligible, how retries are
 * scheduled, how a delivery's aggregate status is derived — lives in the
 * SQL RPCs this orchestrates (supabase/migrations/20260915070000_*),
 * never duplicated here. This function's own job is exactly five steps:
 * materialize -> prepare device targets -> claim -> send -> record.
 */

type AdminClient = SupabaseClient<Database>;

export type ClaimedNotificationDeliveryTarget = {
  targetId: string;
  lockToken: string;
  tenantId: string;
  tenantSlug: string;
  notificationDeliveryId: string;
  pushSubscriptionId: string;
  attemptCount: number;
  eventType: string;
  endpoint: string;
  p256dh: string;
  authKey: string;
  /** Faz NOTIF.2F.1 — from notification_event_display_snapshots, null for
   * any event with no snapshot row (every pre-2F.1 historical event). */
  customerName: string | null;
  serviceNames: string[] | null;
  appointmentStartAt: string | null;
  tenantTimezone: string | null;
};

export type SendPushFn = (
  target: ClaimedNotificationDeliveryTarget,
) => Promise<PushSendOutcome>;

export type ProcessNotificationDeliveryBatchOptions = {
  supabase: AdminClient;
  /** Injectable transport — production default calls the real
   * web-push/VAPID sender; tests inject a deterministic fake (Step 19),
   * never a real Apple/Google push endpoint. */
  sendPush?: SendPushFn;
  eventBatchSize?: number;
  prepareBatchSize?: number;
  claimBatchSize?: number;
  leaseSeconds?: number;
};

export type ProcessNotificationDeliveryBatchResult = {
  activationAbsent: boolean;
  eventsMaterialized: number;
  deliveriesPrepared: number;
  deliveriesSkippedNoDevice: number;
  targetsClaimed: number;
  sent: number;
  stale: number;
  retried: number;
  failed: number;
};

const defaultSendPush: SendPushFn = (target) =>
  sendDeliveryPush(
    { endpoint: target.endpoint, p256dh: target.p256dh, authKey: target.authKey },
    buildDeliveryPushPayload(target.eventType, target.tenantSlug, {
      customerName: target.customerName,
      serviceNames: target.serviceNames,
      appointmentStartAt: target.appointmentStartAt,
      tenantTimezone: target.tenantTimezone,
    }),
  );

function rpcErrorMessage(fn: string, error: { message: string }): string {
  return `${fn} failed: ${error.message}`;
}

export async function processNotificationDeliveryBatch(
  options: ProcessNotificationDeliveryBatchOptions,
): Promise<ProcessNotificationDeliveryBatchResult> {
  const {
    supabase,
    sendPush = defaultSendPush,
    eventBatchSize = 25,
    prepareBatchSize = 50,
    claimBatchSize = 25,
    leaseSeconds = 120,
  } = options;

  const result: ProcessNotificationDeliveryBatchResult = {
    activationAbsent: false,
    eventsMaterialized: 0,
    deliveriesPrepared: 0,
    deliveriesSkippedNoDevice: 0,
    targetsClaimed: 0,
    sent: 0,
    stale: 0,
    retried: 0,
    failed: 0,
  };

  // Cheap short-circuit — every RPC below independently fails closed on
  // an absent activation too (defense in depth), so this check is a
  // convenience, not the only thing standing between "inactive" and
  // "processed".
  const { data: activatedAt, error: activationError } = await supabase.rpc(
    "get_notification_delivery_activation",
  );
  if (activationError) {
    throw new Error(rpcErrorMessage("get_notification_delivery_activation", activationError));
  }
  if (!activatedAt) {
    result.activationAbsent = true;
    return result;
  }

  const { data: materializeResult, error: materializeError } = await supabase.rpc(
    "materialize_pending_notification_events",
    { p_batch_size: eventBatchSize },
  );
  if (materializeError) {
    throw new Error(rpcErrorMessage("materialize_pending_notification_events", materializeError));
  }
  result.eventsMaterialized = (materializeResult as { processed?: number } | null)?.processed ?? 0;

  const { data: prepareResult, error: prepareError } = await supabase.rpc(
    "prepare_notification_delivery_targets",
    { p_batch_size: prepareBatchSize },
  );
  if (prepareError) {
    throw new Error(rpcErrorMessage("prepare_notification_delivery_targets", prepareError));
  }
  result.deliveriesPrepared = (prepareResult as { prepared?: number } | null)?.prepared ?? 0;
  result.deliveriesSkippedNoDevice =
    (prepareResult as { skippedNoDevice?: number } | null)?.skippedNoDevice ?? 0;

  const { data: claimed, error: claimError } = await supabase.rpc(
    "claim_notification_delivery_targets",
    { p_batch_size: claimBatchSize, p_lease_seconds: leaseSeconds },
  );
  if (claimError) {
    throw new Error(rpcErrorMessage("claim_notification_delivery_targets", claimError));
  }

  const targets = (claimed ?? []) as ClaimedNotificationDeliveryTarget[];
  result.targetsClaimed = targets.length;

  for (const target of targets) {
    const outcome = await sendPush(target);

    if (outcome.outcome === "sent") result.sent++;
    else if (outcome.outcome === "stale") result.stale++;
    else if (outcome.outcome === "retry") result.retried++;
    else result.failed++;

    const { error: recordError } = await supabase.rpc("record_notification_delivery_target_result", {
      p_target_id: target.targetId,
      p_lock_token: target.lockToken,
      p_outcome: outcome.outcome,
      p_error_code: outcome.outcome === "sent" ? undefined : outcome.errorCode,
      p_error_message: outcome.outcome === "sent" ? undefined : outcome.errorMessage,
    });
    if (recordError) {
      throw new Error(rpcErrorMessage("record_notification_delivery_target_result", recordError));
    }
  }

  return result;
}
