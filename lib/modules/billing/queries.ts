import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { AdminBillingDashboard, AdminBillingRow, AdminTenantBilling, BillingFilter, MyBillingSummary } from "./model";

/**
 * Faz SAAS.1C.1 - the billing READ layer. Every call is a SECURITY DEFINER RPC invoked with the CALLER's own authenticated client; there is no
 * service-role client, no table read and no write here. The salon summary is refused by the database for anyone who is not an Owner / Yönetici
 * of that salon; the admin reads are refused for anyone who is not an active platform admin. A failure NEVER breaks the page that asks: the
 * billing information is informational, so the salon helpers answer null and the admin helpers answer a small failure reason.
 */

type Client = SupabaseClient<Database>;

export type BillingAdminResult<T> = { ok: true; data: T } | { ok: false; reason: "forbidden" | "not_found" | "error" };

function mapError(error: { message?: string; code?: string } | null): "forbidden" | "error" {
  const message = error?.message ?? "";
  return /platform admin required|authentication required|permission denied/i.test(message) || error?.code === "42501" ? "forbidden" : "error";
}

/** The salon's own safe billing summary, or null when the caller may not see it (or anything goes wrong). Never throws. */
export async function getMyBillingSummary(supabase: Client, tenantId: string): Promise<MyBillingSummary | null> {
  try {
    const { data, error } = await supabase.rpc("get_my_billing_summary", { p_tenant_id: tenantId });
    if (error || !data) return null;
    return data as unknown as MyBillingSummary;
  } catch {
    return null;
  }
}

export async function getAdminBillingDashboard(supabase: Client): Promise<BillingAdminResult<AdminBillingDashboard>> {
  const { data, error } = await supabase.rpc("admin_billing_dashboard");
  if (error || !data) return { ok: false, reason: mapError(error) };
  return { ok: true, data: data as unknown as AdminBillingDashboard };
}

export async function getAdminBillingList(supabase: Client, filter: BillingFilter, search: string): Promise<BillingAdminResult<AdminBillingRow[]>> {
  const { data, error } = await supabase.rpc("admin_billing_list", { p_filter: filter, p_search: search });
  if (error || !data) return { ok: false, reason: mapError(error) };
  return { ok: true, data: data as unknown as AdminBillingRow[] };
}

export async function getAdminTenantBilling(supabase: Client, tenantId: string): Promise<BillingAdminResult<AdminTenantBilling>> {
  const { data, error } = await supabase.rpc("admin_tenant_billing", { p_tenant_id: tenantId });
  if (error) return { ok: false, reason: mapError(error) };
  if (!data) return { ok: false, reason: "not_found" };
  return { ok: true, data: data as unknown as AdminTenantBilling };
}
