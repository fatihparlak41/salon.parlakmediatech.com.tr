import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { setPendingConfirmation } from "@/lib/auth/pending-confirmation";
import { resolveSafeNext } from "@/lib/auth/safe-redirect";

/**
 * Prefetch-safe by design — this GET NEVER calls verifyOtp() and never
 * changes auth state. It only stores the token server-side (HttpOnly
 * cookie, see lib/auth/pending-confirmation.ts) and redirects to a
 * token-free URL. Verification only happens on an explicit POST: the
 * button on /confirm-email (lib/modules/auth/actions.ts,
 * confirmEmailAction) or, for a password-recovery link, the new-password
 * form on /reset-password (resetPasswordAction).
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
 * /auth/callback is untouched in purpose and stays in place for OAuth / future PKCE
 * flows; this route is only for email OTP links (signup confirmation,
 * customer magic links and, since Faz SAAS.1A, password recovery).
 */

// The one sanitizer lives in lib/auth/safe-redirect.ts (a route file may export only HTTP handlers).

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

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = parseEmailOtpType(searchParams.get("type"));

  // Faz SAAS.1A: a password-recovery link goes to the reset-password form,
  // never to /confirm-email, and it ignores any `next` entirely: the only
  // destination after a reset is the staff login, decided by the server
  // action, so a crafted link cannot steer where the person ends up. Still
  // prefetch-safe: this handler only PARKS the token, exactly like the
  // signup / magic-link branch; the form's POST is what verifies it.
  const destination = type === "recovery" ? "/reset-password" : "/confirm-email";

  if (tokenHash && type) {
    const next = type === "recovery" ? "/" : resolveSafeNext(searchParams.get("next") ?? "/", origin);
    await setPendingConfirmation({ tokenHash, type, next });
  }
  // No token_hash/type at all: nothing to store. The destination page
  // renders its own "no pending link" state either way — no error branch
  // needed here, since this handler never attempts verification and so has
  // nothing that can fail.

  const response = NextResponse.redirect(`${origin}${destination}`);
  // A redirect that carries Set-Cookie for a single-use credential must never
  // be served from a shared cache to anyone else.
  response.headers.set("Cache-Control", "no-store");
  return response;
}
