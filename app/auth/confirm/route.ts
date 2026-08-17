import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { authErrorLogFields } from "@/lib/auth/session-errors";

/**
 * token_hash-based confirmation — the current Supabase/Next.js SSR
 * recommendation for email OTP flows (signup, recovery, email change,
 * magic link). Supabase's Auth email template must build the link as
 * `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&next=/`
 * rather than using `{{ .ConfirmationURL }}` — that default macro (which
 * points at Supabase's own /auth/v1/verify) is a PKCE flow tied to a
 * code_verifier cookie set in whichever browser called signUp(), so it
 * silently fails whenever a user opens the email on a different
 * device/browser than the one they signed up in (empirically confirmed,
 * see Faz 1.5 report). verifyOtp() has no such requirement — the
 * token_hash alone is the credential, so this route works from any
 * browser.
 *
 * Outside app/[locale] on purpose, same as /auth/callback (excluded from
 * the next-intl proxy matcher, see proxy.ts) — not a page a user browses
 * to directly.
 *
 * /auth/callback is untouched and stays in place for OAuth / future PKCE
 * flows, which do need the code_verifier cookie; this route is only for
 * email OTP links.
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

/**
 * Open-redirect guard. Supabase's `{{ .RedirectTo }}` template variable
 * (used below to carry signUpAction's intended post-confirmation
 * destination through the email) is a full URL, not a bare path, so a
 * simple `startsWith("/")` check isn't enough — this resolves `next`
 * against `origin` and only accepts it if the resulting origin matches
 * exactly, falling back to "/" for anything else (cross-origin,
 * unparsable, protocol-relative "//evil.com", etc.).
 */
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
  const safeNext = resolveSafeNext(searchParams.get("next") ?? "/", origin);

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(`${origin}${safeNext}`);
    }
    // Safe diagnostic fields only — never the token_hash itself
    // (single-use credential) or the request URL (would include it).
    console.error("[auth/confirm] verifyOtp failed", authErrorLogFields(error));
  } else {
    console.error("[auth/confirm] missing or invalid token_hash/type parameter");
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
