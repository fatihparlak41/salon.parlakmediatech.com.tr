import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Faz LAUNCH.1A — creating a salon is owner-approval only during the Founding
 * Salon phase. The AUTHORITY is private.create_tenant_with_owner (migration
 * 20261022150000), which refuses anyone without a platform-admin row or a live
 * approval for their own confirmed e-mail address; nothing in this module can
 * grant or widen that. These helpers only let the UI (a) hide a form that could
 * not succeed and (b) say why a refusal happened.
 */

export const TENANT_PROVISIONING_NOT_APPROVED_MESSAGE =
  "Salon oluşturma şu anda yalnızca onaylanmış hesaplar için açık. Onay için SalonOS ekibiyle iletişime geçin.";

/** The exact exception text private.create_tenant_with_owner raises. */
const NOT_APPROVED_MARKER = "tenant_provisioning_not_approved";

export function isTenantProvisioningNotApprovedError(error: { message?: string } | null | undefined): boolean {
  return typeof error?.message === "string" && error.message.includes(NOT_APPROVED_MARKER);
}

/**
 * Whether the SIGNED-IN caller may create a salon right now (platform admin,
 * or a live approval for their own confirmed address). It answers about the
 * caller only — the RPC takes no argument — so it cannot be used to ask about
 * anybody else.
 *
 * Fails CLOSED: an error, a missing function (the new application running
 * before the migration) or any non-true answer means "not approved", so the
 * worst outcome of a transient failure is an explanatory page, never an open
 * form that the database would refuse anyway.
 */
export async function getMyTenantProvisioningStatus(supabase: SupabaseClient<Database>): Promise<boolean> {
  const { data, error } = await supabase.rpc("get_my_tenant_provisioning_status");
  if (error) return false;
  return data === true;
}
