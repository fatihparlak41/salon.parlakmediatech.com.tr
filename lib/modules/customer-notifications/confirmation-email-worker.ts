import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { sendSmtpMail, WORKER_SMTP_TIMEOUTS, type SendMailFn, type SmtpSendResult } from "@/lib/email/smtp-transport";
import { buildAppointmentConfirmationEmail } from "@/lib/email/templates/appointment-confirmation";

/**
 * Faz NOTIF.1A — the server-only worker core for the customer
 * appointment-confirmation email.
 *
 * Deliberately thin, like lib/modules/notifications/delivery-worker.ts:
 * every real decision — whether a tenant is activated, which jobs are due,
 * whether the appointment is still confirmed and still in the future,
 * lease/fencing, the retry schedule, the attempt cap — lives in the SQL
 * RPCs this orchestrates (supabase/migrations/20260928100000_*). This
 * function's own job: claim -> render -> mark send started -> send ->
 * record, one job at a time, with one job's failure never able to stop
 * the others.
 *
 * Invariants this file upholds:
 *   - The appointment's status is never touched here. Approval happened
 *     (and committed) long before; nothing that can go wrong in this file
 *     can un-approve it.
 *   - `begin_customer_notification_send` is called immediately before the
 *     SMTP call and its result is honored: if the lease was lost the
 *     message is NOT sent.
 *   - A failed attempt is recorded by its retry disposition (see
 *     lib/email/smtp-transport.ts): retryable -> retry, permanent ->
 *     failed, uncertain -> uncertain (never retried automatically).
 *   - Nothing that identifies a customer is ever logged or returned:
 *     the result carries counts only.
 */

type AdminClient = SupabaseClient<Database>;

export type ClaimedConfirmationJob = {
  jobId: string;
  lockToken: string;
  attemptCount: number;
  recipientEmail: string;
  greetingName: string | null;
  salonName: string;
  tenantTimezone: string;
  appointmentStartAt: string;
  serviceNames: string[];
  locationUrl: string | null;
};

export type ProcessConfirmationEmailBatchOptions = {
  supabase: AdminClient;
  /** Injectable transport — production default is the real, guarded
   * Google Workspace SMTP sender; tests inject a deterministic fake or
   * point the real one at a loopback catcher. */
  send?: SendMailFn;
  batchSize?: number;
  leaseSeconds?: number;
  /** Soft wall-clock budget for one invocation: once exceeded, no further
   * send is STARTED (claimed-but-unstarted jobs are simply re-claimed
   * after their lease expires — nothing was sent, so that is safe). */
  timeBudgetMs?: number;
  now?: () => number;
};

export type ProcessConfirmationEmailBatchResult = {
  activationAbsent: boolean;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  uncertain: number;
  skipped: number;
  /** Claimed but not started because the time budget ran out. */
  deferred: number;
  /** begin_customer_notification_send said the lease was lost. */
  leaseLost: number;
  /** A result could not be written back (job stays leased; see above). */
  recordFailed: number;
};

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_LEASE_SECONDS = 180;
const DEFAULT_TIME_BUDGET_MS = 20_000;

const MESSAGE_ID_PREFIX = "confirmation.";

/** Recording the outcome of a send that may already have happened must not
 * be lost to one flaky round trip: a delivered message left "processing"
 * would only surface later as `uncertain`. The write is fenced by the lease
 * token, so repeating it is harmless. */
const RECORD_ATTEMPTS = 3;
const RECORD_RETRY_DELAY_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const AUTO_SUBMITTED_HEADERS = { "Auto-Submitted": "auto-generated" } as const;

/** One mailbox, nothing that could smuggle a second recipient or a
 * header: no whitespace/control characters, no comma/semicolon list
 * separators, no display-name/route syntax. */
const SINGLE_MAILBOX = /^[^\s@,;:<>()[\]\\"\x00-\x1f\x7f]+@[^\s@,;:<>()[\]\\"\x00-\x1f\x7f]+\.[^\s@,;:<>()[\]\\"\x00-\x1f\x7f]+$/;

export function isSingleMailboxAddress(value: string): boolean {
  return value.length >= 3 && value.length <= 254 && SINGLE_MAILBOX.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseClaimedJob(raw: unknown): ClaimedConfirmationJob | null {
  if (!isRecord(raw)) return null;
  const jobId = asString(raw.jobId);
  const lockToken = asString(raw.lockToken);
  const recipientEmail = asString(raw.recipientEmail);
  const salonName = asString(raw.salonName);
  const tenantTimezone = asString(raw.tenantTimezone);
  const appointmentStartAt = asString(raw.appointmentStartAt);
  if (!jobId || !lockToken || !recipientEmail || !salonName || !tenantTimezone || !appointmentStartAt) return null;

  const serviceNames = Array.isArray(raw.serviceNames)
    ? raw.serviceNames.filter((name): name is string => typeof name === "string")
    : [];

  return {
    jobId,
    lockToken,
    attemptCount: typeof raw.attemptCount === "number" ? raw.attemptCount : 0,
    recipientEmail,
    greetingName: asString(raw.greetingName),
    salonName,
    tenantTimezone,
    appointmentStartAt,
    serviceNames,
    locationUrl: asString(raw.locationUrl),
  };
}

type RecordArgs = {
  disposition: "sent" | "retry" | "failed" | "uncertain" | "skipped";
  errorClass?: string;
  providerMessageId?: string;
  skipReason?: string;
};

function dispositionFor(result: SmtpSendResult): RecordArgs {
  if (result.outcome === "sent") {
    return { disposition: "sent", providerMessageId: result.providerMessageId };
  }
  if (result.disposition === "retryable") return { disposition: "retry", errorClass: result.errorClass };
  if (result.disposition === "permanent") return { disposition: "failed", errorClass: result.errorClass };
  return { disposition: "uncertain", errorClass: result.errorClass };
}

export async function processCustomerConfirmationEmailBatch(
  options: ProcessConfirmationEmailBatchOptions,
): Promise<ProcessConfirmationEmailBatchResult> {
  const {
    supabase,
    send = (message) => sendSmtpMail(message, { timeouts: WORKER_SMTP_TIMEOUTS }),
    batchSize = DEFAULT_BATCH_SIZE,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
    now = Date.now,
  } = options;

  const result: ProcessConfirmationEmailBatchResult = {
    activationAbsent: false,
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    uncertain: 0,
    skipped: 0,
    deferred: 0,
    leaseLost: 0,
    recordFailed: 0,
  };

  const startedAt = now();

  const { data: claimData, error: claimError } = await supabase.rpc("claim_customer_notification_jobs", {
    p_batch_size: batchSize,
    p_lease_seconds: leaseSeconds,
  });
  if (claimError) {
    // The SQLSTATE only — never the message (it is the database's text).
    throw new Error(`claim_customer_notification_jobs failed (${claimError.code ?? "unknown"})`);
  }

  const claim = isRecord(claimData) ? claimData : {};
  const activeTenantCount = typeof claim.activeTenantCount === "number" ? claim.activeTenantCount : 0;
  if (activeTenantCount === 0) {
    result.activationAbsent = true;
    return result;
  }

  const rawJobs = Array.isArray(claim.jobs) ? claim.jobs : [];
  result.claimed = rawJobs.length;

  async function record(job: { jobId: string; lockToken: string }, args: RecordArgs): Promise<void> {
    let data: unknown = null;
    let failed = true;
    for (let attempt = 0; attempt < RECORD_ATTEMPTS && failed; attempt++) {
      if (attempt > 0) await sleep(RECORD_RETRY_DELAY_MS * attempt);
      const response = await supabase.rpc("record_customer_notification_result", {
        p_job_id: job.jobId,
        p_lock_token: job.lockToken,
        p_disposition: args.disposition,
        p_error_class: args.errorClass,
        p_provider_message_id: args.providerMessageId,
        p_skip_reason: args.skipReason,
      });
      data = response.data;
      failed = Boolean(response.error);
    }
    if (failed || !isRecord(data) || data.applied !== true) {
      // Lease lost or a database error: the job keeps whatever state it
      // has; if a send had begun, lease expiry turns it into `uncertain`
      // (never a blind retry).
      result.recordFailed++;
      return;
    }
    const status = asString(data.status) ?? args.disposition;
    if (status === "sent") result.sent++;
    else if (status === "retry") result.retried++;
    else if (status === "failed") result.failed++;
    else if (status === "uncertain") result.uncertain++;
    else if (status === "skipped") result.skipped++;
  }

  for (const rawJob of rawJobs) {
    const job = parseClaimedJob(rawJob);
    if (!job) {
      // A malformed row cannot be attributed to a job we could release;
      // its lease simply expires (nothing was sent).
      result.recordFailed++;
      continue;
    }

    if (now() - startedAt > timeBudgetMs) {
      result.deferred++;
      continue;
    }

    try {
      if (!isSingleMailboxAddress(job.recipientEmail)) {
        await record(job, { disposition: "skipped", skipReason: "invalid_recipient" });
        continue;
      }

      let content;
      try {
        content = buildAppointmentConfirmationEmail({
          salonName: job.salonName,
          greetingName: job.greetingName,
          appointmentStartAt: job.appointmentStartAt,
          tenantTimezone: job.tenantTimezone,
          serviceNames: job.serviceNames,
          locationUrl: job.locationUrl,
        });
      } catch {
        // Nothing was sent (a bad timezone/date makes rendering throw).
        await record(job, { disposition: "failed", errorClass: "render_error" });
        continue;
      }

      const { data: begun, error: beginError } = await supabase.rpc("begin_customer_notification_send", {
        p_job_id: job.jobId,
        p_lock_token: job.lockToken,
      });
      if (beginError || begun !== true) {
        // Lease lost (or the database is unreachable): do NOT send.
        result.leaseLost++;
        continue;
      }

      let sendResult: SmtpSendResult | null = null;
      try {
        sendResult = await send({
          to: job.recipientEmail,
          subject: content.subject,
          html: content.html,
          text: content.text,
          messageIdLocalPart: `${MESSAGE_ID_PREFIX}${job.jobId}`,
          headers: { ...AUTO_SUBMITTED_HEADERS },
        });
      } catch {
        // The transport contract is "never throws". A throw is therefore a
        // bug or a crash whose effect on the wire is unknown -> uncertain,
        // never a retry.
        sendResult = null;
      }

      await record(job, sendResult ? dispositionFor(sendResult) : { disposition: "uncertain", errorClass: "transport_exception" });
    } catch {
      // Anything unexpected for THIS job (a transport-level RPC failure,
      // ...). It must not take the rest of the batch down with it.
      result.recordFailed++;
    }
  }

  return result;
}

/** Retention of the booking-time recipient snapshots (see the migration).
 * One bounded call; failures are the caller's to log without detail. */
export async function purgeCustomerNotificationData(supabase: AdminClient): Promise<number> {
  const { data, error } = await supabase.rpc("purge_customer_notification_data", {
    p_retention_days: 30,
    p_batch_size: 200,
  });
  if (error) {
    throw new Error(`purge_customer_notification_data failed (${error.code ?? "unknown"})`);
  }
  return typeof data === "number" ? data : 0;
}
