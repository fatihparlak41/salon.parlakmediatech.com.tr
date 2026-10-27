import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * A publishable-key client that holds NO session and touches NO cookies — for
 * the few server-side calls that must reach the auth service on behalf of
 * somebody who is not signed in (today: asking for a password-recovery e-mail).
 *
 * Why not lib/supabase/server.ts: that client persists whatever session or PKCE
 * code verifier the call produces into the visitor's cookies. A recovery request
 * needs neither, and with the implicit flow the e-mail carries a plain one-time
 * token hash (exchanged by app/auth/confirm/route.ts), not a code that depends on
 * a verifier cookie in the same browser — a person often opens the reset link on a
 * different device than the one they asked from.
 */
export function createStatelessAnonClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: "implicit",
      },
    },
  );
}
