import "server-only";
import { buildTeamInvitationEmail } from "@/lib/email/templates/team-invitation";
import { classifyThrownEmailError, sendSmtpMail, type EmailErrorClass } from "@/lib/email/smtp-transport";

/**
 * Faz SAAS.1C.2A (foundation) / SAAS.1C.2D (transport swap) — the
 * team-invitation email adapter. The `server-only` import above turns an
 * accidental import from a "use client" file into a build error, exactly
 * like the admin Supabase client module does for
 * SUPABASE_SERVICE_ROLE_KEY and lib/pwa/web-push-server.ts does for
 * WEB_PUSH_VAPID_PRIVATE_KEY — that's what actually keeps
 * SMTP_APP_PASSWORD out of the browser bundle, not code review.
 *
 * Faz NOTIF.1A moved the actual transport (the one and only nodemailer
 * usage, the SMTP configuration reader, the fail-closed dev/test guard
 * and the failure classifier) into lib/email/smtp-transport.ts so the
 * customer appointment-confirmation email can share it. This file kept
 * its public contract EXACTLY: the same input type, the same outcome
 * shape (no retry-disposition field leaks into it), the same injectable
 * `send`, the same classifier exports (re-exported below). It delegates
 * actual copy to the pure lib/email/templates/team-invitation.ts module
 * and returns a classified send outcome — nothing more. No invitation RPC
 * is called from here, and no orchestration (SAAS.1C.2C) lives here.
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

export type { EmailErrorClass };
export { classifySmtpError, classifyThrownEmailError } from "@/lib/email/smtp-transport";

export type EmailSendOutcome =
  | { outcome: "sent"; provider: "google_workspace_smtp"; providerMessageId: string }
  | { outcome: "failed"; provider: "google_workspace_smtp"; errorClass: EmailErrorClass };

/** Injectable transport — production default calls real SMTP via
 * nodemailer; tests inject a deterministic fake, never a real mailbox or
 * App Password. Same pattern as
 * lib/modules/notifications/delivery-worker.ts's own injectable
 * `sendPush`. */
export type SendEmailTransport = (input: TeamInvitationEmailInput) => Promise<EmailSendOutcome>;

async function sendViaGoogleWorkspaceSmtp(input: TeamInvitationEmailInput): Promise<EmailSendOutcome> {
  const { subject, html, text } = buildTeamInvitationEmail({
    tenantName: input.tenantName,
    roleName: input.roleName,
    inviterName: input.inviterName,
    acceptUrl: input.acceptUrl,
    expiresAt: input.expiresAt,
    tenantTimezone: input.tenantTimezone,
    locale: input.locale,
  });

  const result = await sendSmtpMail({ to: input.to, subject, html, text });

  // The retry disposition is a concern of the customer-email worker only;
  // the invitation flow's outcome shape is deliberately unchanged.
  if (result.outcome === "sent") {
    return { outcome: "sent", provider: result.provider, providerMessageId: result.providerMessageId };
  }
  return { outcome: "failed", provider: result.provider, errorClass: result.errorClass };
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
 * which this module needs to know about. (The customer-email worker, by
 * contrast, models exactly this case explicitly as `uncertain`.)
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
