import "server-only";
import webpush from "web-push";
import {
  extraAllowedPushHostsFromEnv,
  validatePushEndpoint,
  validatePushKeys,
} from "./push-endpoint-policy";

/**
 * Faz NOTIF.2D — the ONLY place WEB_PUSH_VAPID_PRIVATE_KEY is read. The
 * `server-only` import above turns an accidental import from a
 * "use client" file into a build error, exactly like lib/supabase/
 * admin.ts does for SUPABASE_SERVICE_ROLE_KEY — that's what actually
 * keeps the private key out of the browser bundle, not code review.
 *
 * This module sends exactly one thing: the fixed, privacy-safe manual
 * test notification (Faz NOTIF.2D, Step 11). It is NOT a general-purpose
 * push sender — there is no function here that accepts an arbitrary
 * title/body/path from a caller. A future automatic-delivery phase that
 * needs to send real event notifications should still funnel through
 * web-push's setVapidDetails/sendNotification the same way, but that is
 * a new function to add then, not a reason to widen this one now.
 *
 * Faz ACCOUNT.1 (security) — EVERY send in this file first passes
 * checkSubscriptionForSend: the endpoint must be a canonical https URL on a
 * listed push-service host (lib/pwa/push-endpoint-policy.ts) and the keys
 * must be well-formed, otherwise NO network request is made. The stored
 * endpoint is client-supplied and the database accepts any string, so this
 * is the boundary that keeps a member from making the server call an
 * arbitrary host. The request always goes to the validated canonical href,
 * never to the original string, and carries a hard timeout.
 */

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  const publicKey = process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const subject = process.env.WEB_PUSH_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    throw new Error("Web Push VAPID environment variables are not configured");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

/** No push service needs longer; a slower answer is treated as a network error. */
const SEND_TIMEOUT_MS = 10_000;

export type TestPushSubscription = {
  endpoint: string;
  p256dh: string;
  authKey: string;
};

export type SubscriptionSendCheck =
  | { ok: true; endpoint: string }
  | { ok: false; reason: string };

/**
 * The gate every send goes through. `env` is injectable for tests; in
 * production the extra-host escape hatch used by local browser tests is
 * ignored regardless of what the environment says.
 */
export function checkSubscriptionForSend(
  subscription: TestPushSubscription,
  env: Record<string, string | undefined> = process.env,
): SubscriptionSendCheck {
  const endpoint = validatePushEndpoint(subscription.endpoint, {
    extraAllowedHosts: extraAllowedPushHostsFromEnv(env),
  });
  if (!endpoint.ok) return { ok: false, reason: `endpoint:${endpoint.reason}` };
  const keys = validatePushKeys(subscription.p256dh, subscription.authKey);
  if (!keys.ok) return { ok: false, reason: `keys:${keys.reason}` };
  return { ok: true, endpoint: endpoint.href };
}

/** Log line for a refused subscription: the reason code only — never the endpoint or keys. */
function logRefused(where: string, reason: string): void {
  console.warn(`[${where}] subscription refused before any network request`, { reason });
}

export type SendTestPushResult =
  | { outcome: "sent" }
  | { outcome: "stale" }
  | { outcome: "rejected" }
  | { outcome: "failed" };

const TEST_PUSH_PAYLOAD = JSON.stringify({
  title: "SalonOS",
  body: "Test bildirimi başarıyla ulaştı.",
  path: "/",
});

/**
 * Sends the fixed manual test payload to exactly one subscription.
 * "stale" (push service responded 404/410 — the endpoint is permanently
 * gone) is distinguished from "failed" (any other error, e.g. a
 * transient network/5xx issue) so the caller soft-revokes only on the
 * former, per Faz NOTIF.2D Step 14 — never on a transient failure.
 * "rejected" (Faz ACCOUNT.1) means the subscription can never be sent to
 * (disallowed host, malformed keys): nothing was sent, and the caller
 * treats it like a dead device.
 */
export async function sendTestPush(subscription: TestPushSubscription): Promise<SendTestPushResult> {
  ensureConfigured();
  const check = checkSubscriptionForSend(subscription);
  if (!check.ok) {
    logRefused("sendTestPush", check.reason);
    return { outcome: "rejected" };
  }
  try {
    await webpush.sendNotification(
      {
        endpoint: check.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.authKey },
      },
      TEST_PUSH_PAYLOAD,
      { timeout: SEND_TIMEOUT_MS },
    );
    return { outcome: "sent" };
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      return { outcome: "stale" };
    }
    console.error("[sendTestPush] delivery failed", {
      statusCode: statusCode ?? null,
      message: error instanceof Error ? error.message : "unknown error",
    });
    return { outcome: "failed" };
  }
}

/**
 * Faz NOTIF.2E.2 — the automatic-delivery sender this module's own
 * header anticipated: a NEW function, not a widening of sendTestPush
 * (untouched above). Reuses the same lazy, module-cached ensureConfigured
 * — no second VAPID setup path. Accepts a real, privacy-safe
 * {title,body,path} payload for one of the 4 locked V1 event types
 * (lib/modules/notifications/payload.ts builds it) rather than a fixed
 * string constant.
 */
export type DeliveryPushSubscription = {
  endpoint: string;
  p256dh: string;
  authKey: string;
};

export type DeliveryPushPayload = {
  title: string;
  body: string;
  path: string;
};

export type PushSendOutcome =
  | { outcome: "sent" }
  | { outcome: "stale"; errorCode: string; errorMessage: string }
  | { outcome: "retry"; errorCode: string; errorMessage: string }
  | { outcome: "failed"; errorCode: string; errorMessage: string };

/**
 * Faz NOTIF.2E.2 Step 12 — deliberate outcome classification, pure and
 * independently testable (never touches the network itself):
 *   404/410            -> stale (endpoint permanently gone, never retry)
 *   429 or 5xx          -> retry (transient)
 *   any other 4xx       -> failed (permanent/config — e.g. bad key, 400/401/403/413)
 *   3xx                 -> failed (a redirect is never followed, so it is never a success)
 *   no statusCode at all -> retry (a network-level exception — ECONNRESET/
 *                            ETIMEDOUT/DNS failure/etc — rather than a
 *                            push-service HTTP response, transient by
 *                            nature)
 * errorMessage is capped at 300 chars here; the DB layer
 * (private.record_notification_delivery_target_result) independently
 * re-caps to its own column limit regardless — defense in depth, not a
 * single trusted layer.
 */
export function classifyPushSendError(error: unknown): PushSendOutcome {
  const statusCode = (error as { statusCode?: number } | null)?.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  const errorMessage = message.slice(0, 300);

  if (statusCode === 404 || statusCode === 410) {
    return { outcome: "stale", errorCode: `http_${statusCode}`, errorMessage };
  }
  if (statusCode === 429 || (typeof statusCode === "number" && statusCode >= 500)) {
    return { outcome: "retry", errorCode: `http_${statusCode}`, errorMessage };
  }
  if (typeof statusCode === "number") {
    return { outcome: "failed", errorCode: `http_${statusCode}`, errorMessage };
  }
  return { outcome: "retry", errorCode: "network_error", errorMessage };
}

/** Sends one real automatic-delivery push. Never throws — every failure
 * path is classified and returned, never propagated, so a caller looping
 * over many targets never has one bad send abort the batch.
 *
 * A subscription the endpoint policy refuses is reported as "stale": it
 * can never be delivered to, and "stale" is the outcome that makes the
 * database revoke the row (record_notification_delivery_target_result), so
 * junk registered through a direct RPC call cleans itself up on its first
 * delivery attempt instead of being retried or lingering. */
export async function sendDeliveryPush(
  subscription: DeliveryPushSubscription,
  payload: DeliveryPushPayload,
): Promise<PushSendOutcome> {
  ensureConfigured();
  const check = checkSubscriptionForSend(subscription);
  if (!check.ok) {
    logRefused("sendDeliveryPush", check.reason);
    return {
      outcome: "stale",
      errorCode: "endpoint_rejected",
      errorMessage: "subscription refused by the push endpoint policy",
    };
  }
  try {
    await webpush.sendNotification(
      {
        endpoint: check.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.authKey },
      },
      JSON.stringify(payload),
      { timeout: SEND_TIMEOUT_MS },
    );
    return { outcome: "sent" };
  } catch (error) {
    return classifyPushSendError(error);
  }
}
