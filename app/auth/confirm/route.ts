import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { setPendingConfirmation } from "@/lib/auth/pending-confirmation";
import { pendingTeamInvitationPresence } from "@/lib/auth/pending-team-invitation";
import { logAuthConfirmContinuity } from "@/lib/auth/invite-continuity-log";

/**
 * Prefetch-safe by design — this GET NEVER calls verifyOtp() and never
 * changes auth state. It only stores the token server-side (HttpOnly
 * cookie, see lib/auth/pending-confirmation.ts) and redirects to a
 * token-free URL. Verification only happens on the explicit POST from
 * /confirm-email's button (lib/modules/auth/actions.ts,
 * confirmEmailAction).
 *
 * This replaces an earlier version of this route that called verifyOtp()
 * directly on GET — which worked, but meant an automated link scanner
 * (observed in practice: Google Workspace's Safe Browsing prefetch)
 * could silently consume the single-use token before the real user's
 * click, landing them on a confusing "expired" error despite never
 * having clicked anything themselves.
 *
 * Outside app/[locale] on purpose, same as /auth/callback (excluded from
 * the next-intl proxy matcher, see proxy.ts) — not a page a user browses
 * to directly, Supabase's email template links straight to it.
 *
 * /auth/callback is untouched and stays in place for OAuth / future PKCE
 * flows; this route is only for email OTP links (signup confirmation
 * today, and any future recovery/magic-link/email-change flows that
 * reuse the same token_hash + verifyOtp() mechanism).
 */

const KNOWN_EMAIL_OTP_TYPES = new Set<EmailOtpType>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

function parseEmailOtpType(value: string | null): EmailOtpType | null {
  return value && KNOWN_EMAIL_OTP_TYPES.has(value as EmailOtpType)
    ? (value as EmailOtpType)
    : null;
}

const MAX_ESCAPE_FOLD_ROUNDS = 5;

/** Control characters (and DEL) never belong in a redirect target. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** The same characters percent-encoded (%00-%1f, %7f) — e.g. an encoded CR/LF
 * that a downstream decoder could turn into a header break. */
const ENCODED_CONTROL_CHARACTER = /%(?:[01][0-9a-f]|7f)/i;

/**
 * True for an ordinary same-site path: "/" itself, or exactly one leading "/"
 * followed by a character that is neither "/" nor "\". Checked again after
 * folding the escapes an intermediary might decode (%2f, %5c, %25 for double
 * encoding) and the tab/CR/LF the URL parser silently drops, so a value that
 * only BECOMES "//host" or "/\host" once decoded is refused as well. A value
 * that is still changing after a few rounds is too deeply encoded to vouch for.
 */
function isPlainLocalPath(pathname: string): boolean {
  let current = pathname;
  for (let round = 0; round < MAX_ESCAPE_FOLD_ROUNDS; round++) {
    if (!(current === "/" || /^\/[^\/\\]/.test(current))) return false;
    const folded = current
      .replace(/%(?:09|0a|0d)/gi, "")
      .replace(/%2f/gi, "/")
      .replace(/%5c/gi, "\\")
      .replace(/%25/gi, "%");
    if (folded === current) return true;
    current = folded;
  }
  return false;
}

/** Open-redirect guard — see the same check in the old callback route for
 * why this resolves against `origin` rather than a bare startsWith("/"):
 * Supabase's `{{ .RedirectTo }}` template variable is a full URL.
 *
 * The result is ALWAYS either "/" or a plain same-site path (one leading
 * "/", never "//", "///" or "/\"), with no control characters, raw or
 * encoded — and applying the function to its own result changes nothing
 * (idempotent), so it stays safe however many times a value is normalized
 * on its way through a page, a hidden form field, a cookie and an action.
 * Faz SAAS.1D release review (F4): it used to return `pathname + search +
 * hash` for ANY same-origin URL, and URL normalization can make that
 * pathname start with "//" — via dot segments ("/.//evil.com"), a
 * same-site absolute URL ("https://<site>//evil.com") or slash/backslash
 * mixes — which a redirect treats as the off-site "//evil.com". Anything
 * that would not be a plain path now falls back to "/".
 *
 * Exported for direct unit testing (Faz 2G.3.1A) — a pure function, safe
 * to import, matching this project's established "test the real
 * function directly" style rather than driving it through an HTTP
 * request this test suite has no harness for. */
export function resolveSafeNext(next: string, origin: string): string {
  if (typeof next !== "string" || hasControlCharacter(next)) return "/";
  try {
    const resolved = new URL(next, origin);
    if (resolved.origin !== origin) return "/";
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    return isPlainLocalPath(resolved.pathname) && !ENCODED_CONTROL_CHARACTER.test(path) ? path : "/";
  } catch {
    return "/";
  }
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = parseEmailOtpType(searchParams.get("type"));

  if (tokenHash && type) {
    const next = resolveSafeNext(searchParams.get("next") ?? "/", origin);
    await setPendingConfirmation({ tokenHash, type, next });

    // Faz SAAS.1D confirmation-continuity — TEMPORARY, presence-only
    // diagnostics (lib/auth/invite-continuity-log.ts): booleans about
    // this request only, never a cookie value, the token_hash, the URL
    // or any identity. Still no verification here: this GET remains
    // prefetch-safe.
    const invitationPresence = await pendingTeamInvitationPresence();
    logAuthConfirmContinuity({
      confirmType: type,
      pendingInvitationCookiePresent: invitationPresence.present,
      pendingInvitationCookieShapeValid: invitationPresence.shapeValid,
      pendingConfirmationCookiePresent: true,
      explicitNextPresent: next !== "/",
    });
  }
  // No token_hash/type at all: nothing to store. /confirm-email will
  // correctly render its "no pending confirmation" state either way —
  // no error branch needed here, since this handler never attempts
  // verification and so has nothing that can fail.

  return NextResponse.redirect(`${origin}/confirm-email`);
}
