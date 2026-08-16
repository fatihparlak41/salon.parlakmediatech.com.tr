import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Outside app/[locale] on purpose — this is the fixed URL Supabase's own
 * email templates link to (configured in the project's Auth redirect
 * allowlist), not a page a user browses to directly, so it doesn't need
 * locale routing. Excluded from the next-intl proxy matcher (see proxy.ts).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  // Open-redirect guard: only ever redirect to a relative, same-origin path.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${safeNext}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
