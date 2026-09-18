import "server-only";
import nodemailer from "nodemailer";
import { buildTeamInvitationEmail } from "@/lib/email/templates/team-invitation";

/**
 * Faz SAAS.1C.2A (foundation) / SAAS.1C.2D (transport swap) — the
 * server-only email transport. The `server-only` import above turns an
 * accidental import from a "use client" file into a build error, exactly
 * like the admin Supabase client module does for
 * SUPABASE_SERVICE_ROLE_KEY and lib/pwa/web-push-server.ts does for
 * WEB_PUSH_VAPID_PRIVATE_KEY — that's what actually keeps
 * SMTP_APP_PASSWORD out of the browser bundle, not code review. No
 * nodemailer import exists anywhere outside this file.
 *
 * SAAS.1C.2D replaced the original Resend HTTP adapter with Google
 * Workspace SMTP (the already-owned, already-active
 * noreply@parlakmediatech.com.tr mailbox) — a pure provider/transport
 * swap. Nothing about the business-facing contract changed except: (a)
 * `provider` is now the literal "google_workspace_smtp", and (b)
 * `idempotencyKey` was removed from the input shape (SMTP has no
 * equivalent to Resend's HTTP idempotency-key header — see this file's
 * own note below).
 *
 * This module is transport ONLY: no invitation RPC is called from here,
 * no invitation token ever reaches this file beyond what's already
 * embedded in the caller-supplied acceptUrl, and no orchestration
 * (SAAS.1C.2C) lives here. It delegates actual copy to the pure
 * lib/email/templates/team-invitation.ts module and returns a
 * classified send outcome — nothing more.
 */

export type TeamInvitationEmailInput = {
  to: string;
  tenantName: string;
  roleName: string;
  inviterName: string | null;
  acceptUrl: string;
  expiresAt: Date;
  /** Faz SAAS.1C.2B: added to the originally-sketched shape — the real
   * template (lib/email/templates/team-invitation.ts) renders expiresAt
   * in the tenant's own local time and must never invent a timezone or
   * silently fall back to UTC, so this adapter has to carry it through
   * from whatever already fetched it. */
  tenantTimezone: string;
  locale: "tr";
};

export type EmailErrorClass =
  | "not_configured"
  | "rate_limited"
  | "authentication_failed"
  | "invalid_recipient"
  | "provider_rejected"
  | "provider_unavailable"
  | "network_error"
  | "unknown";

export type EmailSendOutcome =
  | { outcome: "sent"; provider: "google_workspace_smtp"; providerMessageId: string }
  | { outcome: "failed"; provider: "google_workspace_smtp"; errorClass: EmailErrorClass };

/** Injectable transport — production default calls real SMTP via
 * nodemailer; tests inject a deterministic fake, never a real mailbox or
 * App Password. Same pattern as
 * lib/modules/notifications/delivery-worker.ts's own injectable
 * `sendPush`. */
export type SendEmailTransport = (input: TeamInvitationEmailInput) => Promise<EmailSendOutcome>;

type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  appPassword: string;
  fromAddress: string;
};

/** Lazy, per-call — deliberately NOT read at module import time, so this
 * module can be imported freely (including by every test file that only
 * ever uses the injected fake transport) without a real DEV/CI
 * environment needing any SMTP_* var set at all. Returns null instead of
 * throwing: "missing/malformed config" is an expected, classified
 * outcome (not_configured), never a raw thrown env-detail error. */
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

/** Real nodemailer send-failure shape at runtime: the SDK's own type
 * declarations (@types/nodemailer, inspected directly under
 * node_modules) type every send error as a bare `Error`, but nodemailer
 * itself documents and attaches `code` (e.g. EAUTH, EENVELOPE,
 * ECONNECTION, ETIMEDOUT, ESOCKET, EDNS), `responseCode` (the SMTP
 * server's own numeric status, e.g. 535, 550), and `command` at runtime
 * — this narrows that undeclared-but-real shape rather than guessing at
 * a nonexistent typed error class. */
type NodemailerErrorShape = { code?: string; responseCode?: number; command?: string };

function isNodemailerErrorShape(error: unknown): error is NodemailerErrorShape {
  return typeof error === "object" && error !== null;
}

/**
 * Faz SAAS.1C.2D — classifier over nodemailer's real (undeclared)
 * runtime error shape. `code` is checked first (nodemailer's own,
 * transport-level classification); `responseCode` (the SMTP server's own
 * numeric response) is the fallback when `code` doesn't resolve it,
 * since some rejections only carry a bare SMTP status.
 *
 * Unlike Resend (SAAS.1C.2A/2B), SMTP CAN produce a genuine, synchronous
 * invalid_recipient signal — a 550 "mailbox unavailable"/"user unknown"
 * response from the receiving server during the RCPT TO stage — so this
 * classifier actually produces that class, where Resend's never could.
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
 * value's shape, mirroring lib/pwa/web-push-server.ts's own uniform
 * catch-all. */
export function classifyThrownEmailError(_error: unknown): EmailErrorClass {
  void _error;
  return "network_error";
}

async function sendViaGoogleWorkspaceSmtp(input: TeamInvitationEmailInput): Promise<EmailSendOutcome> {
  const config = readSmtpConfig();
  if (!config) {
    return { outcome: "failed", provider: "google_workspace_smtp", errorClass: "not_configured" };
  }

  const { subject, html, text } = buildTeamInvitationEmail({
    tenantName: input.tenantName,
    roleName: input.roleName,
    inviterName: input.inviterName,
    acceptUrl: input.acceptUrl,
    expiresAt: input.expiresAt,
    tenantTimezone: input.tenantTimezone,
    locale: input.locale,
  });

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.appPassword },
  });

  try {
    const info = await transporter.sendMail({
      from: config.fromAddress,
      to: input.to,
      subject,
      html,
      text,
    });
    return { outcome: "sent", provider: "google_workspace_smtp", providerMessageId: info.messageId };
  } catch (error) {
    return { outcome: "failed", provider: "google_workspace_smtp", errorClass: classifySmtpError(error) };
  }
}

/**
 * Sends one team-invitation email. Never throws — every failure path
 * (missing/malformed config, a classified SMTP rejection, or a thrown
 * transport-level exception, including one from an injected test
 * transport) is classified and returned, mirroring
 * lib/pwa/web-push-server.ts's sendDeliveryPush contract exactly.
 *
 * No console logging here by design (Section 18 of SAAS.1C.2B: prefer
 * none unless operationally useful) — the caller receives a fully
 * classified, already-safe outcome and decides what, if anything, to
 * log. SMTP credentials are never logged anywhere in this module.
 *
 * Residual risk (SAAS.1C.2D Section 11, documented honestly, not
 * engineered around): unlike Resend's HTTP idempotency-key header, SMTP
 * has no equivalent. If the SMTP server accepts a message but the
 * connection drops before this function receives confirmation, a caller
 * cannot distinguish "definitely not sent" from "sent, but we never
 * heard back" — it surfaces here as a thrown/classified failure
 * (typically network_error) even though the message may have actually
 * gone out. This is not solved by inventing fake SMTP idempotency; it is
 * bounded by the orchestration layer's own protections instead (the
 * duplicate-pending-invitation DB constraint, resend's optimistic
 * concurrency fencing, and — later — UI in-flight disable), none of
 * which this module needs to know about.
 */
export async function sendTeamInvitationEmail(
  input: TeamInvitationEmailInput,
  options?: { send?: SendEmailTransport },
): Promise<EmailSendOutcome> {
  const send = options?.send ?? sendViaGoogleWorkspaceSmtp;
  try {
    return await send(input);
  } catch (error) {
    return { outcome: "failed", provider: "google_workspace_smtp", errorClass: classifyThrownEmailError(error) };
  }
}
