import "server-only";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAuthorizedCronRequest } from "@/lib/modules/notifications/cron-auth";
import { isRealSmtpPermitted } from "@/lib/email/smtp-transport";
import {
  processCustomerConfirmationEmailBatch,
  purgeCustomerNotificationData,
} from "@/lib/modules/customer-notifications/confirmation-email-worker";

/**
 * Faz NOTIF.1A — the internal worker trigger for the customer
 * appointment-confirmation email. Same architecture as
 * app/api/internal/notifications/process/route.ts (the Web Push worker
 * trigger), reused rather than reinvented: authenticate with the SAME
 * CRON_SECRET check, call the worker core exactly once, return a safe
 * counts-only summary.
 *
 * NOT a public endpoint. Without `Authorization: Bearer <CRON_SECRET>`
 * (which Vercel Cron sends automatically to the path in vercel.json) it
 * answers 401 and does nothing; with no CRON_SECRET configured it fails
 * closed for every caller in every environment. A signed-in salon user's
 * session token is not the cron secret and is refused the same way.
 *
 * The request surface is intentionally empty: no tenant id, no job id, no
 * appointment id, no batch size and no recipient is ever read from the
 * query string, headers (other than Authorization) or body. A caller can
 * only ever trigger "process the next bounded batch" — the batch size,
 * the lease, the retry schedule and the tenant activation switch all live
 * in the worker core and the SQL RPCs. Tenant isolation is therefore not
 * a per-request decision at all: each job carries its own tenant, and the
 * claim RPC only hands out jobs of tenants with the feature ENABLED.
 *
 * The response and the log line carry COUNTS ONLY — never an address, a
 * name, a phone number, an appointment, a tenant, an SMTP message or a
 * credential. A failure returns a generic body; the error detail stays
 * out of the response.
 *
 * Node runtime (nodemailer needs Node's net/tls); force-dynamic +
 * revalidate: 0 so a scheduled invocation is never served a cached
 * "activationAbsent" answer after a tenant is activated.
 *
 * Retention of the booking-time recipient snapshots runs at the end of
 * every invocation as a separate, bounded, isolated step: its failure can
 * never affect delivery, and a delivery failure never skips it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
// One invocation sends at most a handful of messages sequentially with
// short SMTP timeouts and a 20 s soft budget; this is the hard ceiling.
export const maxDuration = 60;

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!isAuthorizedCronRequest(authorization)) {
    // Never logs the header value — only that a request was rejected.
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const supabase = createAdminClient();
    const batch = await processCustomerConfirmationEmailBatch({ supabase });

    let purged = 0;
    try {
      purged = await purgeCustomerNotificationData(supabase);
    } catch (purgeError) {
      // Class name only: the message is the database's own text.
      console.error("customer-confirmation-email purge failed", {
        errorClass: purgeError instanceof Error ? purgeError.constructor.name : typeof purgeError,
      });
    }

    const durationMs = Date.now() - startedAt;
    console.info("customer-confirmation-email batch complete", {
      durationMs,
      activationAbsent: batch.activationAbsent,
      claimedCount: batch.claimed,
      sentCount: batch.sent,
      retryCount: batch.retried,
      failedCount: batch.failed,
      uncertainCount: batch.uncertain,
      skippedCount: batch.skipped,
      deferredCount: batch.deferred,
      leaseLostCount: batch.leaseLost,
      recordFailedCount: batch.recordFailed,
      purgedCount: purged,
      realSmtpPermitted: isRealSmtpPermitted(),
    });

    return NextResponse.json({
      ok: true,
      activationAbsent: batch.activationAbsent,
      claimed: batch.claimed,
      sent: batch.sent,
      retried: batch.retried,
      failed: batch.failed,
      uncertain: batch.uncertain,
      skipped: batch.skipped,
      deferred: batch.deferred,
      leaseLost: batch.leaseLost,
      recordFailed: batch.recordFailed,
      purged,
      // Only an authenticated caller ever sees this: true means this
      // deployment is a Vercel production one, i.e. allowed to reach the
      // real mail server (see lib/email/smtp-transport.ts).
      realSmtpPermitted: isRealSmtpPermitted(),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    console.error("customer-confirmation-email batch failed", {
      durationMs,
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
    });

    // Generic body only. Leases left behind are recoverable by the worker's
    // own expiring-lease design; the next scheduled invocation retries.
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
