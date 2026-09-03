import "server-only";
import { createClient } from "@/lib/supabase/server";

export type SelfServicePolicy = {
  cancellationEnabled: boolean;
  cancellationCutoffMinutes: number;
  rescheduleEnabled: boolean;
  rescheduleCutoffMinutes: number;
};

const DEFAULT_POLICY: SelfServicePolicy = {
  cancellationEnabled: false,
  cancellationCutoffMinutes: 0,
  rescheduleEnabled: false,
  rescheduleCutoffMinutes: 0,
};

/** Plain column read on tenants, gated by the existing tenants_select_member
 * RLS policy (any member can read) — the UPDATE side is what's actually
 * restricted to settings.manage (see lib/modules/settings/actions.ts). */
export async function getSelfServicePolicy(tenantId: string): Promise<SelfServicePolicy> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tenants")
    .select(
      "customer_cancellation_enabled, customer_cancellation_cutoff_minutes, customer_reschedule_enabled, customer_reschedule_cutoff_minutes",
    )
    .eq("id", tenantId)
    .maybeSingle();

  if (error || !data) return DEFAULT_POLICY;

  return {
    cancellationEnabled: data.customer_cancellation_enabled,
    cancellationCutoffMinutes: data.customer_cancellation_cutoff_minutes,
    rescheduleEnabled: data.customer_reschedule_enabled,
    rescheduleCutoffMinutes: data.customer_reschedule_cutoff_minutes,
  };
}

/** Reuses the existing public.has_feature RPC (20260815120010/20260903120000)
 * — the same function private.resolve_bookable_tenant and every public
 * booking entry point already check — so this reads exactly the value
 * that governs real bookability, never a separate/out-of-sync copy. A
 * failed call (network error, RPC missing) fails closed to false: never
 * claim online booking is on when we couldn't actually confirm it. */
export async function getOnlineBookingEnabled(tenantId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("has_feature", {
    p_tenant_id: tenantId,
    p_feature_key: "online_booking",
  });
  if (error || data === null) return false;
  return data;
}
