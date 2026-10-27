import { authErrorLogFields } from "@/lib/auth/session-errors";
import type { PendingConfirmation } from "@/lib/auth/pending-confirmation";

/**
 * Faz SAAS.1A — the orchestration of PASSWORD RECOVERY, kept free of Next.js, cookies and Supabase
 * clients (no "use server", no "server-only") so the exact call sequence and every failure branch
 * can be tested directly with fakes. lib/modules/auth/actions.ts wires in the real dependencies.
 *
 * Security model (the reasons each rule exists):
 *
 *  - NON-ENUMERATING REQUEST. performPasswordRecoveryRequest never reports whether the address has an
 *    account, and the Server Action runs it AFTER the response has been produced (Next.js after()).
 *    Neither the response body nor its timing therefore depends on whether an e-mail was sent. (A fixed
 *    minimum duration would not be enough: handing a message to a real SMTP relay can take seconds, and
 *    any request that outlasts the floor would give the address away.) Every well-formed address gets
 *    the SAME answer: known, unknown, unconfirmed, a customer-only account, a suspended team member.
 *    The auth provider alone decides whether a message is sent; the application keeps no account
 *    lookup of its own for this surface (an earlier design used a service-role eligibility function;
 *    its premise, "customers have no password", was disproved by the 2026-10-23 restore drill).
 *
 *  - PREFETCH-SAFE, SINGLE USE. The e-mail link only PARKS the token (see app/auth/confirm/route.ts); it
 *    is verified here, on the explicit submit of the new-password form, and the parked cookie is cleared
 *    whatever the outcome. A link scanner that fetches the URL therefore cannot burn the person's link.
 *
 *  - ONLY A RECOVERY TOKEN. The reset step accepts a pending token of type "recovery" and nothing else: a
 *    signup, magic-link or invite token parked in the same cookie is not a recovery link and is left alone.
 *
 *  - NO LINGERING SESSION. verifyOtp(recovery) signs the person in; that session is used for exactly one
 *    updateUser call and then EVERY session of the account is revoked (signOut scope "global"), so a
 *    password reset also ends any session an attacker may have held. The person signs in again with the
 *    new password. (An already-issued access token stays cryptographically valid until it expires — see
 *    the SESSION_REVOCATION_BEHAVIOR section of the SAAS.1A report; the application re-validates the user
 *    with the auth service on every request, which fails once the session is gone.)
 */

export const PASSWORD_RECOVERY_NEUTRAL_MESSAGE =
  "Eğer bu e-posta ile kayıtlı bir hesabınız varsa, şifre yenileme bağlantısı gönderildi.";

export const RESET_INVALID_LINK_MESSAGE =
  "Bu bağlantının süresi dolmuş veya daha önce kullanılmış. Yeni bir şifre yenileme bağlantısı isteyin.";
export const RESET_SAME_PASSWORD_MESSAGE =
  "Yeni şifreniz eskisinden farklı olmalı. Yeni bir şifre yenileme bağlantısı isteyip tekrar deneyin.";
export const RESET_WEAK_PASSWORD_MESSAGE =
  "Bu şifre kabul edilmedi. Daha uzun ve tahmin edilmesi zor bir şifre seçin; yeni bir şifre yenileme bağlantısı isteyip tekrar deneyin.";
export const RESET_FAILED_MESSAGE =
  "Şifre güncellenemedi. Lütfen yeni bir şifre yenileme bağlantısı isteyip tekrar deneyin.";

type LogFields = { code?: string; status?: number };
const defaultLog = (message: string, fields: LogFields) => console.error(message, fields);

export type RecoveryRequestDeps = {
  /** Ask the auth provider to send the recovery e-mail. A returned `error` is logged, never surfaced. */
  sendRecoveryEmail: (email: string) => Promise<{ error?: unknown } | void>;
  log?: (message: string, fields: LogFields) => void;
};

/**
 * Never throws and never returns anything about the account. Designed to be run from after(): the
 * caller has already answered the person by the time this starts.
 */
export async function performPasswordRecoveryRequest(email: string, deps: RecoveryRequestDeps): Promise<void> {
  const log = deps.log ?? defaultLog;

  try {
    const result = await deps.sendRecoveryEmail(email);
    if (result && result.error) {
      log("[requestPasswordRecovery] sending the recovery e-mail failed", authErrorLogFields(result.error));
    }
  } catch (error) {
    // Safe diagnostic fields only — never the address, never error.message
    // (some auth errors embed the submitted e-mail in their text).
    log("[requestPasswordRecovery] unexpected error", authErrorLogFields(error));
  }
}

export type ResetOutcome =
  | { kind: "success" }
  /** No parked recovery token, or the token was not accepted (expired, used, wrong type). */
  | { kind: "invalid_link" }
  | { kind: "password_rejected"; reason: "same_password" | "weak_password" }
  | { kind: "failed" };

type StepResult = { ok: true } | { ok: false; error: unknown };

export type ResetPasswordDeps = {
  /** Verifies the token (single use). */
  verifyRecoveryToken: (tokenHash: string) => Promise<StepResult>;
  updatePassword: (password: string) => Promise<StepResult>;
  /** Revoke every session of the account (scope "global"). Errors are swallowed and logged by the caller's dep. */
  signOutEverywhere: () => Promise<void>;
  /** Delete the parked-token cookie. */
  clearPending: () => Promise<void>;
  log?: (message: string, fields: LogFields) => void;
};

function errorCode(error: unknown): string | undefined {
  return authErrorLogFields(error).code;
}

export async function completePasswordReset(
  input: { pending: PendingConfirmation | null; password: string },
  deps: ResetPasswordDeps,
): Promise<ResetOutcome> {
  const log = deps.log ?? defaultLog;
  const { pending } = input;

  // A signup / magic-link / invite token (or nothing) is not a recovery link.
  // Leave whatever is parked alone: it belongs to a different flow.
  if (!pending || pending.type !== "recovery") return { kind: "invalid_link" };

  const verified = await deps.verifyRecoveryToken(pending.tokenHash);
  // Single use whatever happens next: a spent or failed token must not sit in the cookie.
  await deps.clearPending();

  if (!verified.ok) {
    log("[resetPassword] recovery token not accepted", authErrorLogFields(verified.error));
    return { kind: "invalid_link" };
  }

  const updated = await deps.updatePassword(input.password);
  // The recovery session has served its one purpose; end every session of the account.
  await deps.signOutEverywhere();

  if (!updated.ok) {
    const code = errorCode(updated.error);
    log("[resetPassword] password update failed", authErrorLogFields(updated.error));
    if (code === "same_password") return { kind: "password_rejected", reason: "same_password" };
    if (code === "weak_password") return { kind: "password_rejected", reason: "weak_password" };
    return { kind: "failed" };
  }

  return { kind: "success" };
}
