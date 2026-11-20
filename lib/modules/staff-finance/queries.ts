import { createClient } from "@/lib/supabase/server";
import type { StaffLineKindInfo, StaffOverview, StaffReadResult, StaffRef } from "./types";

/**
 * Faz FIN.1C.1 — server-side reads for the personnel page. Every read goes through the narrow, finance.staff_view-gated RPCs
 * through the caller's own session (never the service role, never a table): the database is the authority, and a failure
 * comes back as { ok: false, code } so the page can render an explicit error state with a retry instead of a blank screen.
 */

function failed<T>(error: { code?: string | null } | null): StaffReadResult<T> {
  return { ok: false, code: error?.code ?? null };
}

export async function getStaffOverview(
  tenantId: string,
  /** First day of the month, YYYY-MM-DD; omit for the month of the tenant-local reference date. */
  month?: string | null,
): Promise<StaffReadResult<StaffOverview>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_staff_finance_overview", {
    p_tenant_id: tenantId,
    p_month: month ?? undefined,
  });
  if (error || !data) return failed(error);
  return { ok: true, data: data as unknown as StaffOverview };
}

export async function getStaffLineKinds(tenantId: string): Promise<StaffReadResult<StaffLineKindInfo[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_staff_line_kinds", { p_tenant_id: tenantId });
  if (error || !data) return failed(error);
  return { ok: true, data: data as unknown as StaffLineKindInfo[] };
}

export async function getFinanceStaff(tenantId: string): Promise<StaffReadResult<StaffRef[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_finance_staff", { p_tenant_id: tenantId });
  if (error || !data) return failed(error);
  return { ok: true, data: data as unknown as StaffRef[] };
}
