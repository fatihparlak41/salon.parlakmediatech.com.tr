import "server-only";
import { createClient } from "@/lib/supabase/server";
import { parseOnboardingStatus, type OnboardingStatus } from "./model";

/**
 * The one readiness answer (public.get_onboarding_status). Returns null — "could not check" — when the caller has no
 * onboarding permission, the call fails or the answer is malformed. Never a guessed "ready".
 */
export async function getOnboardingStatus(tenantId: string): Promise<OnboardingStatus | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_onboarding_status", { p_tenant_id: tenantId });
  if (error) return null;
  return parseOnboardingStatus(data);
}

export type OnboardingWorkspace = {
  branch: { phone: string; address: string };
  services: { id: string; name: string; category: string | null; durationMinutes: number; price: string }[];
  staff: { id: string; fullName: string; hasHours: boolean }[];
  /** `${staffId}:${serviceId}` for every existing staff ↔ service pair */
  pairs: string[];
};

/** What the wizard prefills from, so reopening it (resume) shows everything already entered. RLS scopes every read to the caller's salon. */
export async function getOnboardingWorkspace(tenantId: string): Promise<OnboardingWorkspace> {
  const supabase = await createClient();
  const [branchRes, servicesRes, staffRes, hoursRes] = await Promise.all([
    supabase
      .from("branches")
      .select("phone, address")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("services")
      .select("id, name, category, duration_minutes, price")
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("display_order", { ascending: true })
      .order("name", { ascending: true }),
    supabase
      .from("staff_members")
      .select("id, full_name")
      .eq("tenant_id", tenantId)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("display_order", { ascending: true })
      .order("full_name", { ascending: true }),
    supabase.from("staff_schedules").select("staff_member_id").eq("tenant_id", tenantId).is("deleted_at", null),
  ]);

  const services = (servicesRes.data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    durationMinutes: s.duration_minutes,
    price: String(s.price),
  }));
  const staffRows = staffRes.data ?? [];
  const withHours = new Set((hoursRes.data ?? []).map((h) => h.staff_member_id));

  let pairs: string[] = [];
  if (staffRows.length > 0 && services.length > 0) {
    const pairRes = await supabase
      .from("staff_services")
      .select("staff_member_id, service_id")
      .in(
        "staff_member_id",
        staffRows.map((s) => s.id),
      );
    const serviceIds = new Set(services.map((s) => s.id));
    pairs = (pairRes.data ?? []).filter((p) => serviceIds.has(p.service_id)).map((p) => `${p.staff_member_id}:${p.service_id}`);
  }

  return {
    branch: { phone: branchRes.data?.phone ?? "", address: branchRes.data?.address ?? "" },
    services,
    staff: staffRows.map((s) => ({ id: s.id, fullName: s.full_name, hasHours: withHours.has(s.id) })),
    pairs,
  };
}
