import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client — bypasses RLS entirely (BYPASSRLS). Only for
 * trusted server contexts (cron jobs, webhooks, specific super-admin
 * flows) that filter by tenant_id explicitly in the query itself. Never
 * assume RLS is protecting a query made with this client.
 *
 * The `server-only` import above turns any accidental import from a
 * "use client" file into a build error — that's what actually keeps
 * SUPABASE_SERVICE_ROLE_KEY out of the browser bundle, not code review.
 */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
