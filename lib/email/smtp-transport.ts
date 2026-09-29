import "server-only";
import nodemailer from "nodemailer";

/**
 * Faz NOTIF.1A — the generic, server-only Google Workspace SMTP
 * transport, split out of lib/email/email-server.ts so that BOTH the
 * team-invitation email and the customer appointment-confirmation email
 * go through exactly one nodemailer usage, one configuration reader, one
 * safety guard and one failure classifier. There is no second transport
 * anywhere in this project.
 *
 * The `server-only` import turns an accidental import from a "use client"
 * file into a build error — that (not code review) keeps SMTP_APP_PASSWORD
 * out of the browser bundle. Nothing here reads a Supabase client, an
 * RPC, or any tenant/customer data: it is transport only. Callers hand it
 * an already-rendered message and get a classified outcome back.
 *
 * -----------------------------------------------------------------
 * FAIL-CLOSED DEV/TEST GUARD
 * -----------------------------------------------------------------
 * A developer's .env.local can legitimately contain the real Google
 * Workspace credentials (and vitest.config.ts used to pass every
 * .env.local variable straight into the test processes). Nothing may
 * therefore be able to reach the real SMTP endpoint by accident. The
 * rule, enforced here at the only place a connection is ever opened:
 *
 *   a NON-LOOPBACK SMTP host is used only when VERCEL_ENV === "production".
 *
 * Everywhere else — local `next dev`, `next start`, vitest, Vercel
 * preview deployments — only a loopback host (127.0.0.1, localhost, ::1)
 * can be connected to, i.e. a local SMTP catcher. A real-provider host
 * outside production is refused BEFORE nodemailer is even asked to create
 * a transport, and is reported as `not_configured`. There is no override
 * flag: a flag that can be set in .env.local is a flag a test process can
 * inherit. Production behavior is unchanged (VERCEL_ENV is set by Vercel
 * itself; no new environment variable is required anywhere).
 */

export type EmailErrorClass =
  | "not_configured"
  | "rate_limited"
  | "authentication_failed"
  | "invalid_recipient"
  | "provider_rejected"
  | "provider_unavailable"
  | "network_error"
  | "unknown";

export type SmtpProvider = "google_workspace_smtp";

/**
 * What a failed attempt means for the caller's retry decision — the
 * distinction the customer-email worker is built on.
 *
 *   retryable — the provider provably did NOT accept the message and the
 *               cause is transient (or configuration that may be fixed).
 *               Safe to attempt again later.
 *   permanent — retrying cannot help (the recipient is rejected, the
 *               provider refuses the message, credentials are refused, or
 *               the environment is not allowed to send). Do not retry.
 *   uncertain — the message MAY have been accepted (the connection died
 *               or timed out after the payload could have been delivered,
 *               or the failure cannot be placed before the payload).
 *               NEVER retry automatically: that would risk a duplicate.
 */
export type FailureDisposition = "retryable" | "permanent" | "uncertain";

export type SmtpSendResult =
  | { outcome: "sent"; provider: SmtpProvider; providerMessageId: string }
  | { outcome: "failed"; provider: SmtpProvider; errorClass: EmailErrorClass; disposition: FailureDisposition };

export type OutboundEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Local part of a stable RFC 5322 Message-ID; the transport appends
   * the sender's domain. A stable id per logical message lets an operator
   * find the message in the mailbox when an outcome is `uncertain`. */
  messageIdLocalPart?: string;
  /** Extra headers (e.g. Auto-Submitted). Never carries user content. */
  headers?: Record<string, string>;
};

export type SendMailFn = (message: OutboundEmail) => Promise<SmtpSendResult>;

export type SmtpTimeouts = {
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
};

type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  appPassword: string;
  fromAddress: string;
};

/** Lazy, per-call — deliberately NOT read at module import time, so this
 * module can be imported freely (including by every test file that only
 * ever uses an injected fake transport) without any SMTP_* var set at
 * all. Returns null instead of throwing: "missing/malformed config" is an
 * expected, classified outcome (not_configured), never a raw thrown
 * env-detail error. */
function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const appPassword = process.env.SMTP_APP_PASSWORD;
  const fromAddress = process.env.EMAIL_FROM_ADDRESS;
  if (!host || !portRaw || !user || !appPassword || !fromAddress) return null;

  const port = Number(portRaw);
  if (!Number.isFinite(port)) return null;

  return { host, port, user, appPassword, fromAddress };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackSmtpHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** True only inside a Vercel PRODUCTION deployment. Vercel sets VERCEL_ENV
 * itself (project setting "Automatically expose System Environment
 * Variables", on by default). Exported so the cron endpoint can report it
 * to an authenticated operator — the way to confirm, after a deploy, that
 * production really is allowed to reach the real mail server. */
export function isRealSmtpPermitted(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "production";
}

/** The fail-closed guard's single decision — exported so a test can pin
 * it without opening any connection. */
export function isSmtpHostAllowed(host: string, env: Record<string, string | undefined> = process.env): boolean {
  return isLoopbackSmtpHost(host) || isRealSmtpPermitted(env);
}

/** Real nodemailer send-failure shape at runtime: the SDK's own type
 * declarations type every send error as a bare `Error`, but nodemailer
 * itself attaches `code` (EAUTH, EENVELOPE, EMESSAGE, ECONNECTION,
 * ETIMEDOUT, ESOCKET, EDNS, ETLS, EPROTOCOL, ...), `responseCode` (the
 * SMTP server's own numeric reply), `command` (the SMTP stage: CONN,
 * AUTH PLAIN, MAIL FROM, RCPT TO, DATA, API) and, for socket errors,
 * `syscall` — this narrows that undeclared-but-real shape rather than
 * guessing at a nonexistent typed error class. */
type NodemailerErrorShape = {
  code?: string;
  responseCode?: number;
  command?: string;
  message?: unknown;
  syscall?: unknown;
};

function isNodemailerErrorShape(error: unknown): error is NodemailerErrorShape {
  return typeof error === "object" && error !== null;
}

/**
 * Classifier over nodemailer's real (undeclared) runtime error shape.
 * `code` is checked first (nodemailer's own, transport-level
 * classification); `responseCode` (the SMTP server's own numeric
 * response) is the fallback when `code` doesn't resolve it.
 *
 * UNCHANGED since Faz SAAS.1C.2D — the team-invitation flow's contract.
 * The customer-email worker uses classifySmtpFailure below, which builds
 * the retry disposition on top of the same signals.
 */
export function classifySmtpError(error: unknown): EmailErrorClass {
  if (!isNodemailerErrorShape(error)) return "unknown";

  switch (error.code) {
    case "EAUTH":
      return "authentication_failed";
    case "EENVELOPE":
      return "invalid_recipient";
    case "ECONNECTION":
    case "ETIMEDOUT":
    case "ESOCKET":
    case "EDNS":
      return "network_error";
  }

  if (typeof error.responseCode === "number") {
    if (error.responseCode === 535) return "authentication_failed";
    // 454 "Temporary authentication failure" is RFC 4954's own SMTP AUTH
    // extension code for exactly this: back off and retry, not a
    // permanent credential rejection — the standards-grounded signal for
    // rate_limited, distinct from 535's permanent authentication_failed.
    if (error.responseCode === 454) return "rate_limited";
    if (error.responseCode === 550) return "invalid_recipient";
    if (error.responseCode === 421 || (error.responseCode >= 450 && error.responseCode <= 452)) {
      return "provider_unavailable";
    }
    if (error.responseCode >= 550 && error.responseCode <= 559) {
      return "provider_rejected";
    }
  }

  return "unknown";
}

/** Anything thrown by the transport function itself (real or injected
 * fake) that doesn't go through classifySmtpError at all — outside any
 * documented contract, by construction a lower-level fault. Classified
 * uniformly as network_error rather than guessed at from the thrown
 * value's shape. */
export function classifyThrownEmailError(_error: unknown): EmailErrorClass {
  void _error;
  return "network_error";
}

export type SmtpFailureClassification = {
  errorClass: EmailErrorClass;
  disposition: FailureDisposition;
};

function messageOf(error: NodemailerErrorShape): string {
  return typeof error.message === "string" ? error.message : "";
}

/**
 * RETRYABLE / PERMANENT / UNCERTAIN, from evidence nodemailer actually
 * provides (verified against real SMTP sessions — see
 * tests/smtp-transport.test.ts, which drives the real nodemailer against
 * a scripted loopback server for every branch below).
 *
 * 1. THE SERVER ANSWERED (a numeric SMTP reply is present): the verdict
 *    is definitive — the message was not accepted.
 *      4xx (any stage)              -> retryable   (421/450/451/452 =
 *                                      provider_unavailable, 454 =
 *                                      rate_limited)
 *      5xx at RCPT TO               -> permanent   invalid_recipient
 *      5xx at MAIL FROM / DATA      -> permanent   provider_rejected
 *      AUTH refused (535/534/530..) -> permanent   authentication_failed
 *                                      (repeating a refused login only
 *                                      risks locking the mailbox)
 *
 * 2. NO REPLY, but provably BEFORE the message payload was sent: no
 *    payload means the server cannot have accepted anything -> retryable
 *    network_error. Recognised by nodemailer's own stage signatures: DNS
 *    failure (EDNS), a failed TCP connect (ESOCKET with syscall
 *    "connect"), the connect timeout and the greeting timeout
 *    (ETIMEDOUT "Connection timeout" / "Greeting never received"), a
 *    failed TLS negotiation (ETLS) and an unusable greeting.
 *
 * 3. EVERYTHING ELSE WITHOUT A REPLY is UNCERTAIN. nodemailer reports a
 *    connection that closes ("Connection closed unexpectedly") or a
 *    socket that goes idle ("Timeout") identically whether that happened
 *    during EHLO or after the full payload was written but before the
 *    final 250 — so it cannot be told apart, and the only safe reading is
 *    that the message may have been delivered. An unrecognised failure is
 *    treated the same way: unknown is not "safe to retry".
 */
export function classifySmtpFailure(error: unknown): SmtpFailureClassification {
  if (!isNodemailerErrorShape(error)) return { errorClass: "unknown", disposition: "uncertain" };

  const code = error.code;
  const command = error.command;
  const reply = error.responseCode;
  const message = messageOf(error);

  // (1) the server answered
  if (typeof reply === "number") {
    if (code === "EAUTH" || (typeof command === "string" && command.startsWith("AUTH"))) {
      if (reply === 454) return { errorClass: "rate_limited", disposition: "retryable" };
      if (reply >= 400 && reply < 500) return { errorClass: "provider_unavailable", disposition: "retryable" };
      return { errorClass: "authentication_failed", disposition: "permanent" };
    }
    if (reply >= 400 && reply < 500) {
      return { errorClass: reply === 454 ? "rate_limited" : "provider_unavailable", disposition: "retryable" };
    }
    if (reply >= 500 && reply < 600) {
      if (command === "RCPT TO") return { errorClass: "invalid_recipient", disposition: "permanent" };
      return { errorClass: "provider_rejected", disposition: "permanent" };
    }
    return { errorClass: "unknown", disposition: "uncertain" };
  }

  // Rejected by nodemailer itself before any network I/O.
  if (code === "EAUTH") return { errorClass: "authentication_failed", disposition: "permanent" };
  if (code === "EENVELOPE") return { errorClass: "invalid_recipient", disposition: "permanent" };

  // (2) provably before the payload
  if (code === "EDNS") return { errorClass: "network_error", disposition: "retryable" };
  if (code === "ETLS") return { errorClass: "network_error", disposition: "retryable" };
  if (code === "ESOCKET" && error.syscall === "connect") {
    return { errorClass: "network_error", disposition: "retryable" };
  }
  if (code === "ETIMEDOUT" && (message.startsWith("Connection timeout") || message.startsWith("Greeting never received"))) {
    return { errorClass: "network_error", disposition: "retryable" };
  }
  if (code === "EPROTOCOL" && /^Invalid (greeting|HELO|LHLO)/.test(message)) {
    return { errorClass: "provider_unavailable", disposition: "retryable" };
  }

  // (3) everything else: the outcome cannot be established.
  const transportLevel =
    code === "ECONNECTION" ||
    code === "ETIMEDOUT" ||
    code === "ESOCKET" ||
    message === "Unexpected socket close";
  return { errorClass: transportLevel ? "network_error" : "unknown", disposition: "uncertain" };
}

/** nodemailer's own default timeouts are 2 minutes to connect and 10
 * minutes of socket inactivity — irrelevant for an interactive server
 * action, unacceptable inside a cron invocation with a function-duration
 * limit. The customer-email worker passes these; the invitation path
 * keeps nodemailer's defaults exactly as before. */
export const WORKER_SMTP_TIMEOUTS: SmtpTimeouts = {
  connectionTimeoutMs: 6_000,
  greetingTimeoutMs: 6_000,
  socketTimeoutMs: 12_000,
};

function messageIdDomain(fromAddress: string): string {
  const match = fromAddress.match(/@([A-Za-z0-9.-]+)>?\s*$/);
  return match?.[1]?.toLowerCase() ?? "salonos.invalid";
}

const MESSAGE_ID_LOCAL_PART = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Sends one already-rendered message. Never throws — every failure path
 * (missing/malformed config, the fail-closed guard, a classified SMTP
 * rejection, a thrown transport exception) is classified and returned.
 *
 * No console logging here by design: the caller receives a fully
 * classified, already-safe outcome and decides what, if anything, to log.
 * SMTP credentials, recipient addresses and message bodies are never
 * logged anywhere in this module.
 *
 * Residual risk, documented honestly: SMTP has no idempotency key. When a
 * connection dies after the payload was written, the outcome is genuinely
 * unknown; that is exactly what the `uncertain` disposition exists for.
 */
export async function sendSmtpMail(
  message: OutboundEmail,
  options: { timeouts?: SmtpTimeouts } = {},
): Promise<SmtpSendResult> {
  const provider: SmtpProvider = "google_workspace_smtp";

  const config = readSmtpConfig();
  if (!config) {
    return { outcome: "failed", provider, errorClass: "not_configured", disposition: "retryable" };
  }

  // Fail closed BEFORE a transport object exists. See the file header.
  if (!isSmtpHostAllowed(config.host)) {
    return { outcome: "failed", provider, errorClass: "not_configured", disposition: "permanent" };
  }

  const timeouts = options.timeouts;
  let transporter: ReturnType<typeof nodemailer.createTransport>;
  try {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.appPassword },
      ...(timeouts
        ? {
            connectionTimeout: timeouts.connectionTimeoutMs,
            greetingTimeout: timeouts.greetingTimeoutMs,
            socketTimeout: timeouts.socketTimeoutMs,
          }
        : {}),
    });
  } catch {
    // Constructing a transport performs no I/O: nothing can have been sent.
    return { outcome: "failed", provider, errorClass: "unknown", disposition: "retryable" };
  }

  const messageId =
    message.messageIdLocalPart && MESSAGE_ID_LOCAL_PART.test(message.messageIdLocalPart)
      ? `<${message.messageIdLocalPart}@${messageIdDomain(config.fromAddress)}>`
      : undefined;

  try {
    const info = await transporter.sendMail({
      from: config.fromAddress,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(messageId ? { messageId } : {}),
      ...(message.headers ? { headers: message.headers } : {}),
    });
    return { outcome: "sent", provider, providerMessageId: info.messageId };
  } catch (error) {
    const { errorClass, disposition } = classifySmtpFailure(error);
    return { outcome: "failed", provider, errorClass, disposition };
  }
}
