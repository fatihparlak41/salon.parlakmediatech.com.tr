import { resolveSafeNext } from "@/app/auth/confirm/route";
import { TEAM_INVITATION_ROUTE_PATH } from "@/lib/auth/team-invitation-token";

/**
 * SAAS.1D confirmation-continuity fix (Part A) — a durable, NON-SECRET
 * "where to go after confirming" hint carried on the ACCOUNT.
 *
 * Why it exists: PROD's shared "Confirm signup" email template does not
 * forward Supabase's RedirectTo as `next`, so the confirmation link a real
 * user receives is just `/auth/confirm?token_hash=…&type=signup`. Until
 * SAAS.1D every sign-up used the bare site URL, where "no next" and
 * "next = site root" are indistinguishable, so nothing ever noticed. An
 * invited team member's sign-up must continue to /accept-invite, so the
 * destination is stored in the new user's `user_metadata` at sign-up time
 * and read back after a SUCCESSFUL signup confirmation. It therefore does
 * not depend on the email template, on any cookie surviving, or on the
 * confirmation opening in the same browser. (The template is shared with
 * new customers created by signInWithOtp, whose RedirectTo already
 * contains `/auth/confirm?next=…`, so changing it risks nested URLs.)
 *
 * Security model:
 *  - The value is a bare local ROUTE, never data: only an exact
 *    allowlist of routes (today: /accept-invite) is ever stored. No
 *    invitation token, invitation/tenant/role/user id, email or cookie
 *    content goes into user_metadata — this module cannot express any of
 *    them.
 *  - user_metadata is user-editable (auth.updateUser), so the hint is
 *    treated as untrusted on READ, exactly as on write: it is re-validated
 *    with the existing resolveSafeNext AND must still be an allowlisted
 *    route. A tampered value can, at worst, send the account owner to
 *    /accept-invite — a page that needs an explicit, authenticated,
 *    email-matched acceptance before anything happens.
 *  - It is used only for `signup` confirmations. magiclink, recovery,
 *    email_change, email and invite never inherit it.
 *  - An explicit destination from the confirmation link always wins.
 *  - Nothing here accepts an invitation, creates a membership, links
 *    staff or touches an invitation: it only chooses a redirect path.
 */

export const POST_CONFIRM_NEXT_METADATA_KEY = "post_confirm_next";

/** The exact routes a sign-up may ask to be returned to after confirming.
 * Deliberately a one-entry allowlist: widening it is a separate,
 * reviewed decision (e.g. a customer-portal follow-up). */
const ALLOWED_POST_CONFIRM_DESTINATIONS: ReadonlySet<string> = new Set([TEAM_INVITATION_ROUTE_PATH]);

/** The only confirmation type the hint applies to. */
const POST_CONFIRM_APPLIES_TO_TYPE = "signup";

const MAX_RAW_HINT_LENGTH = 200;

function validatedAllowlistedRoute(raw: unknown, siteOrigin: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_HINT_LENGTH) return null;
  const safe = resolveSafeNext(raw, siteOrigin);
  return ALLOWED_POST_CONFIRM_DESTINATIONS.has(safe) ? safe : null;
}

/** WRITE side (signUpAction): the value to store in user_metadata for the
 * already-validated `next`, or null when nothing should be stored. */
export function resolvePostConfirmHintForWrite(next: string | null | undefined, siteOrigin: string): string | null {
  return validatedAllowlistedRoute(next, siteOrigin);
}

/** True when user_metadata is a plain object that carries the hint key at all (any value). */
function hasPostConfirmHintKey(userMetadata: unknown): boolean {
  return (
    typeof userMetadata === "object" &&
    userMetadata !== null &&
    !Array.isArray(userMetadata) &&
    Object.prototype.hasOwnProperty.call(userMetadata, POST_CONFIRM_NEXT_METADATA_KEY)
  );
}

/** READ side: the validated, allowlisted hint from user_metadata, or null. */
export function readPostConfirmHint(userMetadata: unknown, siteOrigin: string): string | null {
  if (!hasPostConfirmHintKey(userMetadata)) return null;
  return validatedAllowlistedRoute((userMetadata as Record<string, unknown>)[POST_CONFIRM_NEXT_METADATA_KEY], siteOrigin);
}

/** An ordinary same-site path: exactly one leading "/", never "//" (protocol-relative, and "///" is read the same way) and never "/\"
 * (a backslash is read as a slash). */
function isPlainLocalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}

export type ConfirmationDestinationSource = "explicit" | "metadata" | "default";

export type ConfirmationDestination = {
  destination: string;
  source: ConfirmationDestinationSource;
};

/**
 * Precedence after a successful confirmation:
 *   1. an explicit, valid, non-root destination from the confirmation link
 *   2. the validated post_confirm_next hint — signup confirmations only
 *   3. "/"
 * `pendingNext` is what /auth/confirm stored ("/" when the link carried no
 * next, or only the site root); it is re-validated here rather than trusted.
 */
export function chooseConfirmationDestination(input: {
  confirmType: string;
  pendingNext: string;
  userMetadata: unknown;
  siteOrigin: string;
}): ConfirmationDestination {
  // Defense in depth. resolveSafeNext now guarantees a plain same-site path, but this
  // value is client-influenced state (a cookie) sitting one step from redirect(), and
  // before the F4 fix the guard was NOT idempotent: "/.//evil.example" normalized to the
  // protocol-relative "//evil.example", and "//<this-site>//evil.example" normalized once
  // more to the off-site "//evil.example". Its output is therefore still used only when
  // it is a plain local path; anything else counts as "no explicit destination".
  const normalized = resolveSafeNext(input.pendingNext, input.siteOrigin);
  const explicit = isPlainLocalPath(normalized) ? normalized : "/";
  const hint = readPostConfirmHint(input.userMetadata, input.siteOrigin);

  if (explicit !== "/") return { destination: explicit, source: "explicit" };
  if (hint !== null && input.confirmType === POST_CONFIRM_APPLIES_TO_TYPE) return { destination: hint, source: "metadata" };
  return { destination: "/", source: "default" };
}
