import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Faz LAUNCH.1A — reads for the owner-approval section of /super-admin. The
 * rows come from public.platform_list_tenant_owner_approvals, a SECURITY
 * DEFINER function that answers only a PLATFORM OWNER (a support-level
 * platform admin, a tenant owner or anyone else is refused); the table itself
 * has no grant for any API role. Takes an already-authenticated client for the
 * same reason lib/modules/team/queries.ts does: so it can be exercised with a
 * real signed-in client outside a Next.js request.
 */

export type TenantOwnerApprovalRow = {
  id: string;
  email: string;
  note: string | null;
  status: string;
  effectiveStatus: string;
  approvedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedTenantName: string | null;
  revokedAt: string | null;
};

export type TenantOwnerApprovalsResult =
  /** The caller may not manage approvals (or the read failed): show nothing, say nothing. */
  | { allowed: false }
  | { allowed: true; rows: TenantOwnerApprovalRow[] };

export async function listTenantOwnerApprovals(
  supabase: SupabaseClient<Database>,
): Promise<TenantOwnerApprovalsResult> {
  const { data, error } = await supabase.rpc("platform_list_tenant_owner_approvals");
  // Fail closed. A support-level admin gets "platform_owner_required"; a
  // missing function (application released before the migration) or a
  // transient error gets the same: the section is simply not rendered.
  if (error) return { allowed: false };

  return {
    allowed: true,
    rows: (data ?? []).map((row) => ({
      id: row.id,
      email: row.email,
      note: (row.note as string | null) ?? null,
      status: row.status,
      effectiveStatus: row.effective_status,
      approvedAt: row.approved_at,
      expiresAt: row.expires_at,
      consumedAt: (row.consumed_at as string | null) ?? null,
      consumedTenantName: (row.consumed_tenant_name as string | null) ?? null,
      revokedAt: (row.revoked_at as string | null) ?? null,
    })),
  };
}
