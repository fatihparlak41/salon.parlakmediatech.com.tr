import "server-only";
import { createClient } from "@/lib/supabase/server";
import { parseDailyOverview, type DailyOverview } from "./model";

/**
 * The one daily read model. Null means "could not be read" (no finance.view, a failed call, a malformed answer) — the
 * caller then renders nothing, never zeros.
 */
export async function getDailyOwnerOverview(tenantId: string): Promise<DailyOverview | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_daily_owner_overview", { p_tenant_id: tenantId });
  if (error) return null;
  return parseDailyOverview(data);
}
