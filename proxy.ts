import createMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";
import { routing } from "@/lib/i18n/routing";

const handleI18nRouting = createMiddleware(routing);

/**
 * Next.js 16 renamed Middleware to Proxy (functionality unchanged) — this
 * file must be named `proxy.ts`, not `middleware.ts`.
 *
 * i18n routing only for now. Faz 1 adds Supabase session refresh here too.
 */
export function proxy(request: NextRequest) {
  return handleI18nRouting(request);
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
