import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { setPendingConfirmation } from "@/lib/auth/pending-confirmation";

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

/** Open-redirect guard — see the same check in the old callback route for
 * why this resolves against `origin` rather than a bare startsWith("/"):
 * Supabase's `{{ .RedirectTo }}` template variable is a full URL. */
function resolveSafeNext(next: string, origin: string): string {
  try {
    const resolved = new URL(next, origin);
    return resolved.origin === origin
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : "/";
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
  }
  // No token_hash/type at all: nothing to store. /confirm-email will
  // correctly render its "no pending confirmation" state either way —
  // no error branch needed here, since this handler never attempts
  // verification and so has nothing that can fail.

  return NextResponse.redirect(`${origin}/confirm-email`);
}
