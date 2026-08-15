import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser client — safe to import from "use client" components. Uses the
 * public anon key only; every table it touches is protected by RLS.
 *
 * Faz 1 wires in `Database` (from `supabase gen types typescript`) once the
 * first real migrations exist, e.g. createBrowserClient<Database>(...).
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
