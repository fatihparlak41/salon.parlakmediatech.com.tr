import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveSafeNext } from "@/lib/auth/safe-redirect";

/**
 * Outside app/[locale] on purpose — this is the fixed URL Supabase's own
 * email templates link to (configured in the project's Auth redirect
 * allowlist), not a page a user browses to directly, so it doesn't need
 * locale routing. Excluded from the next-intl proxy matcher (see proxy.ts).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  // Open-redirect guard: the ONE sanitizer every auth return path uses
  // (lib/auth/safe-redirect.ts, Faz SAAS.1A). This route used to carry its own
  // weaker hand-rolled prefix check; the result is now always "/" or a plain
  // same-site path, never a protocol-relative, backslash or control-character value.
  const safeNext = resolveSafeNext(searchParams.get("next") ?? "/", origin);

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${safeNext}`);
    }
    // Safe diagnostic fields only — never the code itself (single-use
    // credential) or the request URL (would include it as a query param).
    console.error("[auth/callback] exchangeCodeForSession failed", {
      code: error.code,
      status: error.status,
    });
  } else {
    console.error("[auth/callback] request had no code parameter");
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
