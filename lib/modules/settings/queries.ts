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
