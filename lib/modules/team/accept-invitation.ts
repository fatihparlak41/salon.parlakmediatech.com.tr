import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { AppErrorCode } from "@/lib/errors";
import { isValidTeamInvitationTokenShape } from "@/lib/auth/team-invitation-token";

/**
 * Faz SAAS.1D.2 — the invitation-acceptance orchestration, split from the
 * "use server" wrapper (./accept-actions.ts) for the same reason
 * actions.ts is split into ...Core functions: the wrapper needs Next.js's
 * request-scoped cookies (the raw token lives ONLY in an HttpOnly cookie,
 * see lib/auth/pending-team-invitation.ts), which can't exist under
 * Vitest, while everything security-relevant here — the RPC call, error
 * mapping, and destination resolution — takes an already-authenticated
 * client and a plain token string, so it can be tested with a REAL
 * signed-in client over the network, same discipline as the rest of this
 * suite. Also not a "use server" file itself, because it exports plain
 * types/constants/helpers, and every export of a "use server" module must
 * be an async function (see helpers.ts for the same lesson learned in
 * SAAS.1D.1).
 *
 * accept_team_invitation (20260917080000, hardened by 20260917081000)
 * remains the only authorization source of truth: authenticated caller
 * required, the caller's normalized email must equal the invitation's, no
 * bypass of any kind. Nothing here re-implements, second-guesses, or
 * weakens any of that — this module only maps its real, current outcomes
 * and error strings, re-read from the deployed function body for this
 * phase, not recalled from memory.
 */

export type AcceptInvitationOutcome = "accepted" | "already_member" | "already_accepted";

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<AcceptInvitationOutcome>([
  "accepted",
  "already_member",
  "already_accepted",
]);

export type AcceptInvitationFailureReason =
  | "missing_token"
  | "unauthenticated"
  | "email_mismatch"
  | "expired"
  | "revoked"
  | "not_found"
  | "already_accepted_by_other"
  | "membership_suspended"
  | "unexpected";

/** Safe to return to the browser: no token, no token hash, no
 * membership/role/tenant id, no provider data. `destination` is an
 * internal path resolved server-side from the caller's own (now-real)
 * tenant access, never from client input. */
export type AcceptInvitationData = {
  outcome: AcceptInvitationOutcome;
  destination: string;
  staffLinked: boolean;
};

/** Structurally a superset of ActionResult (lib/errors.ts): `error`
 * carries an extra machine-readable `reason` the accept panel needs to
 * pick its UI (e.g. only email_mismatch offers a sign-out button) —
 * AppErrorCode alone can't distinguish expired from revoked from
 * already-used, since all three are CONFLICT. */
export type AcceptInvitationResult =
  | { success: true; data: AcceptInvitationData }
  | {
      success: false;
      error: { code: AppErrorCode; message: string; reason: AcceptInvitationFailureReason };
    };

const FAILURES: Record<AcceptInvitationFailureReason, { code: AppErrorCode; message: string }> = {
  missing_token: {
    code: "NOT_FOUND",
    message: "Davet bağlantısı bulunamadı veya süresi dolmuş. Lütfen e-postanızdaki davet bağlantısına tekrar tıklayın.",
  },
  unauthenticated: {
    code: "UNAUTHENTICATED",
    message: "Devam etmek için giriş yapmanız gerekiyor.",
  },
  // Deliberately never says WHICH e-posta the invitation was sent to.
  email_mismatch: {
    code: "UNAUTHORIZED",
    message: "Bu davet farklı bir e-posta adresi için gönderilmiş. Davette kullanılan hesapla giriş yapın.",
  },
  expired: { code: "CONFLICT", message: "Bu davetin süresi dolmuş." },
  revoked: { code: "CONFLICT", message: "Bu davet iptal edilmiş." },
  not_found: { code: "NOT_FOUND", message: "Bu davet geçerli değil veya artık kullanılamıyor." },
  // Same public copy as not_found: a caller who isn't the accepting user
  // learns nothing beyond "this can't be used", not that someone else
  // already used it.
  already_accepted_by_other: {
    code: "CONFLICT",
    message: "Bu davet geçerli değil veya artık kullanılamıyor.",
  },
  membership_suspended: {
    code: "CONFLICT",
    message: "Bu salondaki üyeliğiniz askıya alınmış. Lütfen salon yöneticisiyle iletişime geçin.",
  },
  unexpected: { code: "UNEXPECTED", message: "Davet kabul edilemedi, lütfen tekrar deneyin." },
};

/** Failures after which the parked token can never work again — the
 * accept action clears the cookie for exactly these. Everything else
 * (unauthenticated, email_mismatch, membership_suspended, unexpected)
 * keeps it: the right user may still sign in and succeed, the membership
 * may be reactivated, or a transient error may clear on retry. */
export const TERMINAL_ACCEPT_FAILURE_REASONS: ReadonlySet<AcceptInvitationFailureReason> = new Set([
  "expired",
  "revoked",
  "not_found",
  "already_accepted_by_other",
]);

export function acceptInvitationFailure(reason: AcceptInvitationFailureReason): AcceptInvitationResult {
  const { code, message } = FAILURES[reason];
  return { success: false, error: { code, message, reason } };
}

/** Exact live RPC error strings — private.accept_team_invitation, latest
 * definition in 20260917081000_role_integrity_hardening.sql. */
export function mapAcceptInvitationError(error: { message: string }): AcceptInvitationResult {
  const msg = error.message;
  if (msg.includes("authentication required")) return acceptInvitationFailure("unauthenticated");
  if (msg.includes("invitation_email_mismatch")) return acceptInvitationFailure("email_mismatch");
  if (msg.includes("invitation_expired")) return acceptInvitationFailure("expired");
  if (msg.includes("invitation_revoked")) return acceptInvitationFailure("revoked");
  if (msg.includes("invitation_already_accepted")) return acceptInvitationFailure("already_accepted_by_other");
  if (msg.includes("invitation_not_found")) return acceptInvitationFailure("not_found");
  if (msg.includes("membership_suspended")) return acceptInvitationFailure("membership_suspended");
  return acceptInvitationFailure("unexpected");
}

type AnySupabaseClient = SupabaseClient<Database>;

export async function acceptTeamInvitationCore(
  supabase: AnySupabaseClient,
  rawToken: string,
): Promise<AcceptInvitationResult> {
  // Input hygiene only; the RPC's own hash lookup remains authoritative.
  if (!isValidTeamInvitationTokenShape(rawToken)) {
    return acceptInvitationFailure("not_found");
  }

  const { data, error } = await supabase.rpc("accept_team_invitation", { p_token: rawToken });
  if (error) {
    return mapAcceptInvitationError(error);
  }

  const row = data?.[0];
  if (!row || !KNOWN_OUTCOMES.has(row.outcome)) {
    return acceptInvitationFailure("unexpected");
  }

  // The caller is a real member of this tenant now (or already was), so
  // the ordinary RLS-scoped tenants SELECT — the same one
  // lib/auth/session.ts's getTenantAccess uses — resolves the slug. No
  // service_role, and nothing here reads a slug from client input.
  const { data: tenant } = await supabase
    .from("tenants")
    .select("slug")
    .eq("id", row.tenant_id)
    .is("deleted_at", null)
    .maybeSingle();

  // /app on its own isn't a route in this app — home (/) is where the
  // signed-in user's salon list lives, so it's the safe fallback.
  const destination = tenant?.slug ? `/app/${encodeURIComponent(tenant.slug)}` : "/";

  return {
    success: true,
    data: {
      outcome: row.outcome as AcceptInvitationOutcome,
      destination,
      staffLinked: row.staff_linked === true,
    },
  };
}
