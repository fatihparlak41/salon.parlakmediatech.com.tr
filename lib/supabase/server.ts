import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server client for Server Components, Server Actions and Route Handlers.
 * Uses the public anon key + the caller's session cookie; RLS still applies
 * — this is not a privilege escalation, just SSR-friendly auth plumbing.
 *
 * Create a fresh client per request (never module-level singleton — see the
 * @supabase/ssr createServerClient docs bundled in node_modules).
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component render, which can't set
            // cookies. Harmless as long as proxy.ts also refreshes the
            // session (it will, from Faz 1) so the write isn't lost.
          }
        },
      },
    },
  );
}
