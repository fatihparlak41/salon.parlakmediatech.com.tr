import "server-only";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processNotificationDeliveryBatch } from "@/lib/modules/notifications/delivery-worker";
import { isAuthorizedCronRequest } from "@/lib/modules/notifications/cron-auth";

/**
 * Faz NOTIF.2E.3 — the internal worker trigger. Wires the existing,
 * unchanged NOTIF.2E.2 worker core (processNotificationDeliveryBatch) to
 * a scheduled invocation. This route does NOT decide who gets notified,
 * does not implement retry/lease/eligibility logic, and does not read
 * notification_delivery_activation itself — every one of those
 * decisions already lives in the worker core and the SQL RPCs it
 * orchestrates. This file is deliberately thin: authenticate, call the
 * worker exactly once, return a safe summary.
 *
 * Node runtime, explicit and required: web-push (used deep inside
 * sendDeliveryPush, itself inside the worker's default transport) signs
 * outgoing VAPID requests using Node's own `crypto` module, which the
 * Edge runtime does not support (freshly confirmed this phase, not
 * assumed) — this route would fail at the first real send if it ever
 * ran on Edge. force-dynamic + revalidate: 0 ensure Vercel's cron
 * invocation is never served a cached response and always executes this
 * handler fresh — critical here, since a cached "activationAbsent: true"
 * response would silently stop the worker from ever noticing a real
 * activation.
 *
 * GET, not POST: Vercel Cron Jobs invoke the configured path with GET
 * (freshly confirmed against Vercel's current docs this phase), sending
 * `Authorization: Bearer <CRON_SECRET>` automatically when CRON_SECRET
 * is configured on the project — see lib/modules/notifications/
 * cron-auth.ts for the verification itself, including why it fails
 * closed with no CRON_SECRET configured at all.
 *
 * Request surface is intentionally empty: no tenant id, no event id, no
 * subscription id, and no batch-size override are ever read from the
 * request (query string, headers, or body) — an authenticated caller
 * can only ever trigger "process the next bounded batch", nothing more
 * targeted. Batch sizes are the worker core's own defaults (Faz
 * NOTIF.2E.2's already-reviewed 25/50/25/120s bounds) — this route does
 * not override them, so there is nothing here to widen into an
 * unbounded drain.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function sanitizedErrorFields(error: unknown): { errorClass: string; message: string } {
  const errorClass = error instanceof Error ? error.constructor.name : typeof error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  // Defense in depth against a pathologically long or unexpectedly
  // detailed underlying message reaching the log — never the HTTP
  // response either way (see the catch block below).
  return { errorClass, message: rawMessage.slice(0, 300) };
}

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!isAuthorizedCronRequest(authorization)) {
    // Never logs the header value itself (Step 12's explicit "do not
    // log ... Authorization header") — only the fact that a request was
    // rejected.
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const result = await processNotificationDeliveryBatch({ supabase: createAdminClient() });
    const durationMs = Date.now() - startedAt;

    // One concise structured log line per invocation (Step 12) — counts
    // and booleans only, never endpoint/subscription/customer/event data.
    console.info("notification-worker batch complete", {
      durationMs,
      activationAbsent: result.activationAbsent,
      materializedCount: result.eventsMaterialized,
      preparedCount: result.deliveriesPrepared,
      skippedNoDeviceCount: result.deliveriesSkippedNoDevice,
      claimedCount: result.targetsClaimed,
      sentCount: result.sent,
      retryCount: result.retried,
      staleCount: result.stale,
      failedCount: result.failed,
    });

    return NextResponse.json({
      ok: true,
      activationAbsent: result.activationAbsent,
      materialized: result.eventsMaterialized,
      prepared: result.deliveriesPrepared,
      claimed: result.targetsClaimed,
      sent: result.sent,
      retried: result.retried,
      stale: result.stale,
      failed: result.failed,
      skipped: result.deliveriesSkippedNoDevice,
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const { errorClass, message } = sanitizedErrorFields(error);

    console.error("notification-worker batch failed", { durationMs, errorClass, message });

    // Generic response body only — never the caught error's own
    // message/stack/database details (Step 13's explicit "do not expose
    // internal stack/database details in response"). Target leases
    // remain recoverable by the worker's own existing expiring-lease
    // design; this route never touches notification_delivery_activation
    // and never disables anything on failure — the next scheduled
    // invocation simply tries again.
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
