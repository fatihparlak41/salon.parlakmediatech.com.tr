import "server-only";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAuthorizedCronRequest } from "@/lib/modules/notifications/cron-auth";

/**
 * Faz NOTIF.2F.3 — the internal retention trigger. Wires the existing,
 * unchanged NOTIF.2F.2 purge primitive (public.purge_expired_
 * notification_event_display_snapshots — supabase/migrations/
 * 20260916080000_*, hard-capped at 500 rows per call) to a scheduled
 * invocation.
 *
 * Deliberately isolated from notification delivery: this route never
 * imports or calls processNotificationDeliveryBatch, and app/api/
 * internal/notifications/process/route.ts never calls this one or the
 * purge RPC. A retention failure can never interfere with push delivery,
 * and a delivery failure can never interfere with retention — two
 * independent cron entries (vercel.json), two independent endpoints,
 * two independent RPC surfaces.
 *
 * Exactly ONE RPC call per invocation, batch size fixed at 500 (the
 * primitive's own hard ceiling — reused, not re-implemented; this route
 * does not itself enforce the cap, the SQL function already does)
 * — never overridable by any request parameter (none are ever read —
 * same "intentionally empty request surface" contract as the existing
 * worker trigger), never looped, never recursively drained within one
 * invocation. Hourly cadence (vercel.json, "17 * * * *", a non-zero
 * minute to avoid top-of-hour scheduling concentration) accepts a
 * bounded per-tick backlog — up to 12,000 rows/day theoretical maximum —
 * rather than draining everything in one call; the next scheduled tick
 * picks up wherever this one left off, via the same FOR UPDATE SKIP
 * LOCKED discipline the primitive itself already provides.
 *
 * Same CRON_SECRET auth (isAuthorizedCronRequest, reused verbatim — no
 * second authentication system), same Node runtime + force-dynamic +
 * revalidate:0 caching contract, same generic-error-response discipline
 * as the existing worker trigger.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const PURGE_BATCH_SIZE = 500;

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
    // Never logs the header value itself — only the fact that a request
    // was rejected, same discipline as the worker trigger.
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const { data, error } = await createAdminClient().rpc(
      "purge_expired_notification_event_display_snapshots",
      { p_batch_size: PURGE_BATCH_SIZE },
    );
    if (error) {
      throw new Error(`purge_expired_notification_event_display_snapshots failed: ${error.message}`);
    }
    const purgedCount = data ?? 0;
    const durationMs = Date.now() - startedAt;

    // One concise structured log line per invocation — counts only,
    // never a snapshot row, event id, tenant id, or customer name.
    console.info("notification-display-snapshot-purge complete", { durationMs, purgedCount });

    return NextResponse.json({ ok: true, purged: purgedCount });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const { errorClass, message } = sanitizedErrorFields(error);

    console.error("notification-display-snapshot-purge failed", { durationMs, errorClass, message });

    // Generic response body only — never the caught error's own
    // message/stack/database details. Future hourly ticks retry
    // naturally; this route never touches notification_delivery_
    // activation and never disables anything on failure.
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
