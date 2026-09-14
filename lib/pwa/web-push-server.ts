import "server-only";
import webpush from "web-push";

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

export type TestPushSubscription = {
  endpoint: string;
  p256dh: string;
  authKey: string;
};

export type SendTestPushResult =
  | { outcome: "sent" }
  | { outcome: "stale" }
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
 */
export async function sendTestPush(subscription: TestPushSubscription): Promise<SendTestPushResult> {
  ensureConfigured();
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.authKey },
      },
      TEST_PUSH_PAYLOAD,
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
