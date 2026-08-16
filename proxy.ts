import { createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "@/lib/i18n/routing";

const handleI18nRouting = createMiddleware(routing);

/**
 * Next.js 16 renamed Middleware to Proxy (functionality unchanged) — this
 * file must be named `proxy.ts`, not `middleware.ts`.
 *
 * Runs next-intl's routing first (it may rewrite the URL), then refreshes
 * the Supabase session on top of that SAME response — writing the
 * refreshed cookies onto a brand-new NextResponse.next() here would silently
 * discard next-intl's rewrite.
 *
 * This is optimistic/UX-only: it keeps the session cookie fresh so pages
 * don't see a stale-but-not-yet-expired token. It is NOT the authorization
 * boundary — every Server Component/Action/Route Handler re-checks via RLS
 * or lib/auth/session.ts regardless of what happens here (see architecture
 * report section C, and Next's own guidance: proxy/middleware should not be
 * used as a full session management or authorization solution).
 */
export async function proxy(request: NextRequest) {
  const response = handleI18nRouting(request);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: ["/((?!api|auth|_next|_vercel|.*\\..*).*)"],
};
