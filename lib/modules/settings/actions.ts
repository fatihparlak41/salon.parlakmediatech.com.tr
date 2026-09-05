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
 *
 * Faz 2I.4B — PARTIAL update by construction: `input` (and therefore
 * `parsed.data`) carries only whichever policy fields the client
 * actually changed since its own last successful save (see
 * SelfServicePolicyForm's dirty-tracking) — never all four unconditionally.
 * The `columns` object below is built from only the keys actually
 * present in the validated input, so an omitted field is never part of
 * the UPDATE statement at all and is left completely untouched in
 * Postgres. This is the fix for the real PROD incident where a stale
 * browser tab, holding an outdated snapshot of a field it never
 * touched, resent that stale value and silently reverted a different,
 * more recent save — see the Faz 2I.4B diagnosis report. `.select()`
 * still requests all four columns regardless of which were written, so
 * the returned row is always the complete, authoritative current state
 * — the caller (SelfServicePolicyForm) resyncs its ENTIRE local display
 * from this, not just the fields it wrote, which also self-heals any
 * field this same tab had a stale view of without ever having written
 * to it.
 */
export async function updateSelfServicePolicyAction(
  _prevState: ActionResult<SelfServicePolicy> | null,
  input: {
    tenantId: string;
    tenantSlug: string;
    cancellationEnabled?: boolean;
    cancellationCutoffMinutes?: number;
    rescheduleEnabled?: boolean;
    rescheduleCutoffMinutes?: number;
  },
): Promise<ActionResult<SelfServicePolicy>> {
  await requireUser();

  const parsed = selfServicePolicySchema.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz form");
  }

  const columns: {
    customer_cancellation_enabled?: boolean;
    customer_cancellation_cutoff_minutes?: number;
    customer_reschedule_enabled?: boolean;
    customer_reschedule_cutoff_minutes?: number;
  } = {};
  if (parsed.data.cancellationEnabled !== undefined) columns.customer_cancellation_enabled = parsed.data.cancellationEnabled;
  if (parsed.data.cancellationCutoffMinutes !== undefined) columns.customer_cancellation_cutoff_minutes = parsed.data.cancellationCutoffMinutes;
  if (parsed.data.rescheduleEnabled !== undefined) columns.customer_reschedule_enabled = parsed.data.rescheduleEnabled;
  if (parsed.data.rescheduleCutoffMinutes !== undefined) columns.customer_reschedule_cutoff_minutes = parsed.data.rescheduleCutoffMinutes;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tenants")
    .update(columns)
    .eq("id", parsed.data.tenantId)
    .select(
      "customer_cancellation_enabled, customer_cancellation_cutoff_minutes, customer_reschedule_enabled, customer_reschedule_cutoff_minutes",
    )
    .maybeSingle();

  // Faz 2I.4A — diagnostic-only, server-side (Vercel function logs, never
  // sent to the client). No PII: tenantId is a UUID, error.code/message
  // are Postgres/PostgREST diagnostic codes and class names, never
  // user-entered content. Turns a future occurrence of "settings say
  // saved but the DB didn't change" into a log lookup instead of a full
  // code trace — see the Faz 2I.4A diagnosis report for why this branch
  // previously left zero trace anywhere.
  if (error) {
    console.error("[updateSelfServicePolicyAction] update failed", {
      tenantId: parsed.data.tenantId,
      code: error.code,
      message: error.message,
    });
    return fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
  }
  if (!data) {
    console.error("[updateSelfServicePolicyAction] RLS matched zero rows (unauthorized or wrong tenant)", {
      tenantId: parsed.data.tenantId,
    });
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

/**
 * Faz 2I.2C.1 — tenant_features has no direct write grant at all (it
 * backs platform/billing-controlled feature overrides, 20260815120012),
 * so this goes through the narrowly-scoped set_online_booking_enabled
 * RPC (20260903120000) rather than a table update — that RPC is the
 * entire write path, checks settings.manage itself, and touches only
 * the online_booking row for this one tenant. A permission failure
 * surfaces as a raised Postgres error (not a silently-empty result, this
 * isn't an RLS-gated table write), mapped to UNAUTHORIZED below.
 */
export async function updateOnlineBookingSettingAction(
  _prevState: ActionResult<boolean> | null,
  input: { tenantId: string; tenantSlug: string; enabled: boolean },
): Promise<ActionResult<boolean>> {
  await requireUser();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_online_booking_enabled", {
    p_tenant_id: input.tenantId,
    p_enabled: input.enabled,
  });

  if (error) {
    if (error.message.includes("settings.manage required")) {
      return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
    }
    return fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
  }

  revalidatePath(`/app/${input.tenantSlug}/settings`);

  return ok(data ?? input.enabled);
}
