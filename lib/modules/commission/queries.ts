import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  parseCommissionDetail,
  parseCommissionRules,
  parseCommissionSummary,
  type CommissionDetail,
  type CommissionRules,
  type CommissionSummary,
} from "./model";

/** Null = "could not be read" (no finance.view, failed call, malformed answer): the page then shows an error, never zeros. */
export async function getStaffCommission(tenantId: string, from: string | null, to: string | null): Promise<CommissionSummary | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_staff_commission", { p_tenant_id: tenantId, ...(from ? { p_from: from } : {}), ...(to ? { p_to: to } : {}) });
  return error ? null : parseCommissionSummary(data);
}

export async function getStaffCommissionDetail(tenantId: string, staffId: string, from: string | null, to: string | null): Promise<CommissionDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_staff_commission_detail", {
    p_tenant_id: tenantId,
    p_staff_id: staffId,
    ...(from ? { p_from: from } : {}),
    ...(to ? { p_to: to } : {}),
  });
  return error ? null : parseCommissionDetail(data);
}

export async function getCommissionRules(tenantId: string): Promise<CommissionRules | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_commission_rules", { p_tenant_id: tenantId });
  return error ? null : parseCommissionRules(data);
}
