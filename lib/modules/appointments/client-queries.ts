/**
 * Browser-client versions of the branch-scoped lookups in queries.ts
 * (which is server-only and cannot be imported from client components).
 * Same query shape, same "UX convenience filter only" caveat — the
 * create/reschedule RPC re-validates all of this server-side regardless
 * of what the client sends. Shared here rather than duplicated per
 * component since appointment-items-editor.tsx and
 * create-appointment-sheet.tsx and appointment-detail-sheet.tsx all need
 * the identical shape.
 */
import { createClient } from "@/lib/supabase/client";
import type { ServiceForBranch } from "./queries";

export async function fetchServicesForBranch(tenantId: string, branchId: string): Promise<ServiceForBranch[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("service_branches")
    .select("services!inner(id, name, duration_minutes, price, status, tenant_id, deleted_at)")
    .eq("branch_id", branchId);
  return (data ?? [])
    .map((r) => r.services)
    .filter((s): s is NonNullable<typeof s> => !!s && s.tenant_id === tenantId && s.status === "active" && !s.deleted_at)
    .map((s) => ({ id: s.id, name: s.name, durationMinutes: s.duration_minutes, price: String(s.price) }));
}

export type StaffOption = { id: string; fullName: string };

export async function fetchEligibleStaff(serviceId: string, branchId: string): Promise<StaffOption[]> {
  if (!serviceId || !branchId) return [];
  const supabase = createClient();
  const [eligibleRes, branchRes] = await Promise.all([
    supabase.from("staff_services").select("staff_member_id").eq("service_id", serviceId),
    supabase.from("staff_branches").select("staff_member_id").eq("branch_id", branchId),
  ]);
  const eligibleIds = new Set((eligibleRes.data ?? []).map((r) => r.staff_member_id));
  const branchIds = new Set((branchRes.data ?? []).map((r) => r.staff_member_id));
  const candidateIds = [...eligibleIds].filter((id) => branchIds.has(id));
  if (candidateIds.length === 0) return [];
  const { data } = await supabase
    .from("staff_members")
    .select("id, full_name")
    .eq("status", "active")
    .is("deleted_at", null)
    .in("id", candidateIds);
  return (data ?? []).map((s) => ({ id: s.id, fullName: s.full_name }));
}
