import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * TEMPORARY (SAAS.1D confirmation-continuity) — presence-only diagnostics.
 *
 * Why: a real PROD run lost the pending-invitation cookie between the
 * invitation click and the post-confirmation /accept-invite visit, in the
 * same browser profile, and no code path in this repository explains it
 * (see the SAAS.1D investigation report). These structured one-line logs
 * let the NEXT controlled PROD run show, hop by hop, whether the cookie
 * was present — so the loss can be located instead of guessed. Remove
 * this module (and its call sites) once that run has been analysed.
 *
 * Privacy is enforced structurally, not by convention:
 *  - every exported logger takes a fixed shape of booleans, small counts
 *    and members of closed enums — there is no free-text parameter;
 *  - `emit` re-checks every field at runtime and DROPS anything that is
 *    not a boolean, a small non-negative integer, or an allowlisted enum
 *    member, so even a mistyped caller cannot leak a value;
 *  - it never receives, and so cannot log: cookie values, the invitation
 *    token or hash, a confirmation URL or token_hash, an email address,
 *    a session/access token, or any invitation/membership/user/tenant id.
 *
 * Output is one JSON line per event on console.info, tagged
 * "invite-continuity", easy to filter in Vercel runtime logs.
 */

export type ContinuityHop =
  | "sign-up"
  | "auth-confirm-get"
  | "confirm-email-success"
  | "accept-invite-render"
  | "proxy-stale-session-sweep";

const ENUM_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  confirmType: new Set(["signup", "invite", "magiclink", "recovery", "email_change", "email"]),
  destinationSource: new Set(["explicit", "metadata", "default"]),
  view: new Set(["no-pending", "continuation", "accept-panel"]),
};

const MAX_COUNT = 10_000;

function sanitize(fields: Readonly<Record<string, unknown>>): Record<string, boolean | number | string> {
  const safe: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "number") {
      if (Number.isInteger(value) && value >= 0 && value <= MAX_COUNT) safe[key] = value;
    } else if (typeof value === "string") {
      if (ENUM_VALUES[key]?.has(value)) safe[key] = value;
    }
  }
  return safe;
}

function emit(hop: ContinuityHop, fields: Readonly<Record<string, unknown>>): void {
  console.info(JSON.stringify({ tag: "invite-continuity", hop, ...sanitize(fields) }));
}

type CookiePresence = {
  /** The cookie exists in the request (any value). */
  pendingInvitationCookiePresent: boolean;
  /** …and its value has the shape of an invitation token. */
  pendingInvitationCookieShapeValid: boolean;
};

/** POST /sign-up (the server action). */
export function logSignUpContinuity(fields: CookiePresence & { metadataHintWritten: boolean }): void {
  emit("sign-up", fields);
}

/** GET /auth/confirm — the confirmation email link was opened. */
export function logAuthConfirmContinuity(
  fields: CookiePresence & {
    confirmType: EmailOtpType;
    pendingConfirmationCookiePresent: boolean;
    explicitNextPresent: boolean;
  },
): void {
  emit("auth-confirm-get", fields);
}

/** POST /confirm-email — verification SUCCEEDED, just before redirecting. */
export function logConfirmSuccessContinuity(
  fields: CookiePresence & {
    confirmType: EmailOtpType;
    pendingConfirmationCookiePresent: boolean;
    explicitNextPresent: boolean;
    metadataNextPresent: boolean;
    metadataNextAccepted: boolean;
    destinationSource: "explicit" | "metadata" | "default";
  },
): void {
  emit("confirm-email-success", fields);
}

/** GET /accept-invite — which state the page is about to render. */
export function logAcceptInviteRender(
  fields: CookiePresence & { authenticated: boolean; view: "no-pending" | "continuation" | "accept-panel" },
): void {
  emit("accept-invite-render", fields);
}

/** proxy.ts stale-session cleanup actually ran (currently unreachable with
 * the pinned auth-js, so any occurrence is itself a finding). */
export function logProxyStaleSessionSweep(fields: {
  sweptCookieCount: number;
  preservedCookieCount: number;
  pendingInvitationCookiePreserved: boolean;
}): void {
  emit("proxy-stale-session-sweep", fields);
}
