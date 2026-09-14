"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, hasPermission } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { selfServicePolicySchema } from "./schemas";
import type { SelfServicePolicy } from "./queries";
import { sendTestPush, type TestPushSubscription } from "@/lib/pwa/web-push-server";

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

/**
 * Faz NOTIF.2D — persists (or reconciles) one browser's real
 * PushSubscription through the existing Faz NOTIF.2A RPC. No new
 * storage logic here at all: save_push_subscription itself derives the
 * caller's own active membership for tenantId from auth.uid() and
 * upserts on (endpoint, tenant_membership_id) — this action is a thin
 * pass-through, matching updateOnlineBookingSettingAction's own shape.
 *
 * Deliberately NOT gated on settings.manage — subscribing your OWN
 * device is a "my own notification settings" action, the same class as
 * update_my_notification_preferences (which also only requires an
 * active membership). The RPC's own NF003 check is the entire
 * authorization boundary here, on purpose.
 *
 * No revalidatePath: unlike the two actions above, no Server Component
 * on the settings page reads push_subscriptions to render initial
 * props — this device's subscription state is resolved entirely
 * client-side (the browser's own PushManager.getSubscription() is the
 * only source of truth for "does THIS device have one"), so there is
 * nothing server-rendered to invalidate.
 */
export async function savePushSubscriptionAction(
  _prevState: ActionResult<{ id: string; deviceLabel: string | null }> | null,
  input: {
    tenantId: string;
    endpoint: string;
    p256dh: string;
    authKey: string;
    deviceLabel?: string;
  },
): Promise<ActionResult<{ id: string; deviceLabel: string | null }>> {
  await requireUser();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_push_subscription", {
    p_tenant_id: input.tenantId,
    p_endpoint: input.endpoint,
    p_p256dh: input.p256dh,
    p_auth_key: input.authKey,
    p_device_label: input.deviceLabel ?? undefined,
  });

  if (error) {
    if (error.code === "NF003") {
      return fail("UNAUTHORIZED", "Bu işlem için aktif bir üyeliğiniz yok");
    }
    console.error("[savePushSubscriptionAction] failed", {
      tenantId: input.tenantId,
      code: error.code,
    });
    return fail("UNEXPECTED", "Cihaz bağlanamadı, lütfen tekrar deneyin");
  }

  const result = data as { id?: string; deviceLabel?: string | null } | null;
  if (!result?.id) {
    console.error("[savePushSubscriptionAction] RPC returned no id", { tenantId: input.tenantId });
    return fail("UNEXPECTED", "Cihaz bağlanamadı, lütfen tekrar deneyin");
  }

  return ok({ id: result.id, deviceLabel: result.deviceLabel ?? null });
}

/**
 * Faz NOTIF.2D — soft-revokes exactly one of the caller's own devices via
 * the existing remove_push_subscription RPC. "not found" and "belongs to
 * someone else" already collapse to the same NF004 inside the RPC (no
 * existence side-channel) — this action preserves that by mapping NF004
 * to one generic NOT_FOUND message, nothing more specific.
 */
export async function removePushSubscriptionAction(
  _prevState: ActionResult<null> | null,
  input: { subscriptionId: string },
): Promise<ActionResult<null>> {
  await requireUser();

  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_push_subscription", {
    p_subscription_id: input.subscriptionId,
  });

  if (error) {
    if (error.code === "NF004") {
      return fail("NOT_FOUND", "Cihaz bulunamadı");
    }
    console.error("[removePushSubscriptionAction] failed", { code: error.code });
    return fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
  }

  return ok(null);
}

/**
 * Faz NOTIF.2D, Steps 11-14 — the ONE manual test-send path. Not a
 * generic notification sender: the payload is fixed (see
 * lib/pwa/web-push-server.ts), nothing from the browser reaches it
 * except tenantId. Authorization is the new get_my_push_subscriptions_
 * for_test_send RPC's own job (active membership + settings.manage,
 * 20260914120000) — this action does not duplicate that check, only
 * maps its errors, matching updateOnlineBookingSettingAction's own
 * "settings.manage required" mapping exactly.
 *
 * Sends to every one of the caller's own active subscriptions for this
 * tenant (ordinarily one, but never assumes that). A 404/410 from the
 * push service soft-revokes only that one row via the existing
 * remove_push_subscription RPC — transient failures never revoke
 * anything. "sent" means the push service accepted the request for at
 * least one device, not that it has visibly appeared on any screen.
 */
/**
 * Faz NOTIF.2D.1 — security correction. The original version called an
 * `authenticated`-grantable RPC that returned raw endpoint/p256dh/
 * auth_key — reachable directly from browser devtools regardless of
 * what this action itself chose to show. Corrected flow, in order:
 *   1. requireUser() resolves the real signed-in user server-side.
 *   2. hasPermission() checks settings.manage through the NORMAL
 *      RLS-respecting client — has_permission derives auth.uid()
 *      internally, which only exists in this normal-session context.
 *   3. ONLY after that passes, createAdminClient() (service_role) calls
 *      get_push_subscriptions_for_test_send — granted to service_role
 *      ONLY (20260914121000); authenticated has zero execute on it, so
 *      this material cannot be read directly from the browser at all,
 *      not even by a legitimate settings-manager's own devtools.
 *   4. user.id is passed explicitly (service_role has no auth.uid());
 *      the browser is never asked for and never trusted with a user id.
 * Stale-subscription revocation still goes through the ordinary
 * (non-admin) client and the existing authenticated remove_push_
 * subscription RPC — that one already correctly derives ownership from
 * this same signed-in user's auth.uid(), so no broadened grant is
 * needed for it.
 */
export async function sendTestPushNotificationAction(
  _prevState: ActionResult<{ sent: boolean }> | null,
  input: { tenantId: string },
): Promise<ActionResult<{ sent: boolean }>> {
  const user = await requireUser();

  const authorized = await hasPermission(input.tenantId, "settings.manage");
  if (!authorized) {
    return fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok");
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_push_subscriptions_for_test_send", {
    p_tenant_id: input.tenantId,
    p_user_id: user.id,
  });

  if (error) {
    if (error.code === "NF003") {
      return fail("UNAUTHORIZED", "Bu işlem için aktif bir üyeliğiniz yok");
    }
    console.error("[sendTestPushNotificationAction] read failed", {
      tenantId: input.tenantId,
      code: error.code,
    });
    return fail("UNEXPECTED", "Test bildirimi gönderilemedi, lütfen tekrar deneyin");
  }

  const subscriptions = (data ?? []) as Array<{ id: string; endpoint: string; p256dh: string; authKey: string }>;
  if (subscriptions.length === 0) {
    return fail("NOT_FOUND", "Bu cihaz için kayıtlı bir bildirim aboneliği yok");
  }

  const supabase = await createClient();
  let anySent = false;
  for (const subscription of subscriptions) {
    const result: TestPushSubscription = {
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      authKey: subscription.authKey,
    };
    const sendResult = await sendTestPush(result);
    if (sendResult.outcome === "sent") {
      anySent = true;
    } else if (sendResult.outcome === "stale") {
      const { error: revokeError } = await supabase.rpc("remove_push_subscription", {
        p_subscription_id: subscription.id,
      });
      if (revokeError) {
        console.error("[sendTestPushNotificationAction] stale-subscription revoke failed", {
          code: revokeError.code,
        });
      }
    }
  }

  if (!anySent) {
    return fail("UNEXPECTED", "Test bildirimi gönderilemedi, lütfen tekrar deneyin");
  }

  return ok({ sent: true });
}
