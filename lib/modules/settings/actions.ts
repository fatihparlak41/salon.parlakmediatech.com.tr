"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { selfServicePolicySchema } from "./schemas";
import type { SelfServicePolicy } from "./queries";

/**
 * Reuses the tenants table's existing UPDATE RLS policy
 * (tenants_update_settings_manage, 20260815120016) — no new permission,
 * no new policy, exactly per Faz 2G.2 architecture approval. That policy
 * is a USING/WITH CHECK clause, not an error-raising check: a caller
 * without settings.manage doesn't get a Postgres error back, the UPDATE
 * just matches zero rows. .maybeSingle() after .select() is the
 * ground-truth check for that — `data === null` means "RLS silently
 * blocked this", which must never be read as success just because
 * `error` was also null.
 */
export async function updateSelfServicePolicyAction(
  _prevState: ActionResult<SelfServicePolicy> | null,
  input: {
    tenantId: string;
    tenantSlug: string;
    cancellationEnabled: boolean;
    cancellationCutoffMinutes: number;
    rescheduleEnabled: boolean;
    rescheduleCutoffMinutes: number;
  },
): Promise<ActionResult<SelfServicePolicy>> {
  await requireUser();

  const parsed = selfServicePolicySchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tenants")
    .update({
      customer_cancellation_enabled: parsed.data.cancellationEnabled,
      customer_cancellation_cutoff_minutes: parsed.data.cancellationCutoffMinutes,
      customer_reschedule_enabled: parsed.data.rescheduleEnabled,
      customer_reschedule_cutoff_minutes: parsed.data.rescheduleCutoffMinutes,
    })
    .eq("id", parsed.data.tenantId)
    .select(
      "customer_cancellation_enabled, customer_cancellation_cutoff_minutes, customer_reschedule_enabled, customer_reschedule_cutoff_minutes",
    )
    .maybeSingle();

  if (error) {
    return fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
  }
  if (!data) {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }

  revalidatePath(`/app/${parsed.data.tenantSlug}/settings`);

  return ok({
    cancellationEnabled: data.customer_cancellation_enabled,
    cancellationCutoffMinutes: data.customer_cancellation_cutoff_minutes,
    rescheduleEnabled: data.customer_reschedule_enabled,
    rescheduleCutoffMinutes: data.customer_reschedule_cutoff_minutes,
  });
}
