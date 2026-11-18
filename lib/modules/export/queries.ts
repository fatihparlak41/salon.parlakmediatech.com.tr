import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Page, PageFetcher } from "./archive";

/**
 * Faz SAAS.1C.2b - thin wrappers over the export RPCs, always called with the CALLER's own authenticated client (never a service-role client:
 * the database re-checks Owner status, fresh sign-in, tenant and token on every call). Read helpers never throw; a failure is a result.
 */

type Client = SupabaseClient<Database>;

export type ExportStatus =
  | { allowed: false }
  | { allowed: true; remaining: number; limit: number; last_export_at: string | null; next_available_at: string | null; in_progress: boolean; fresh_auth: boolean };

export async function getTenantExportStatus(supabase: Client, tenantId: string): Promise<ExportStatus> {
  try {
    const { data, error } = await supabase.rpc("get_tenant_export_status", { p_tenant_id: tenantId });
    if (error || !data) return { allowed: false };
    return data as unknown as ExportStatus;
  } catch {
    return { allowed: false };
  }
}

export type RequestExportResult =
  | { ok: true; request_id: string; expires_at: string; remaining_after: number }
  | { ok: false; error: string; retry_at?: string };

export async function requestTenantExport(supabase: Client, tenantId: string, tokenHash: string, clientRequestId: string): Promise<RequestExportResult> {
  try {
    const { data, error } = await supabase.rpc("request_tenant_export", { p_tenant_id: tenantId, p_token_hash: tokenHash, p_client_request_id: clientRequestId });
    if (error || !data) return { ok: false, error: "unexpected" };
    return data as unknown as RequestExportResult;
  } catch {
    return { ok: false, error: "unexpected" };
  }
}

export type ConsumeResult = { ok: true; request_id: string; fence_at: string; tenant_timezone: string | null; tenant_currency: string | null } | { ok: false; error: "invalid_token" };

export async function consumeTenantExportToken(supabase: Client, tokenHash: string): Promise<ConsumeResult> {
  try {
    const { data, error } = await supabase.rpc("consume_tenant_export_token", { p_token_hash: tokenHash });
    if (error || !data) return { ok: false, error: "invalid_token" };
    return data as unknown as ConsumeResult;
  } catch {
    return { ok: false, error: "invalid_token" };
  }
}

export function sectionPageFetcher(supabase: Client, requestId: string, limit = 500): PageFetcher {
  return async (section, after) => {
    const { data, error } = await supabase.rpc("export_read_section", { p_request_id: requestId, p_section: section, p_after: after ?? undefined, p_limit: limit });
    if (error || !data) throw new Error(error?.code === "42501" ? "export_denied" : "read_failed");
    return data as unknown as Page;
  };
}

export async function completeTenantExport(supabase: Client, requestId: string, counts: Record<string, number>, bytes: number): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("complete_tenant_export", { p_request_id: requestId, p_counts: counts, p_bytes: bytes });
    return !error && (data as { ok?: boolean } | null)?.ok === true;
  } catch {
    return false;
  }
}

export async function failTenantExport(supabase: Client, requestId: string, code: string): Promise<void> {
  try {
    await supabase.rpc("fail_tenant_export", { p_request_id: requestId, p_error_code: code });
  } catch {
    /* the abandoned-download sweep closes it */
  }
}
