"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { selfServicePolicySchema } from "./schemas";
import type { SelfServicePolicy } from "./queries";
import { sendTestPush, type TestPushSubscription } from "@/lib/pwa/web-push-server";
import {
  extraAllowedPushHostsFromEnv,
  validatePushEndpoint,
  validatePushKeys,
} from "@/lib/pwa/push-endpoint-policy";
import {
  MAX_DEVICES_PER_TEST_SEND,
  retryAfterPhrase,
  testSendLimiters,
} from "@/lib/pwa/test-send-limiter";
import {
  parseNotificationPreferences,
  type NotificationPreferenceKey,
  type NotificationPreferences,
} from "@/lib/modules/notifications/preference-keys";

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
 *
 * Faz ACCOUNT.1 (security) — the endpoint and keys are validated HERE,
 * before the RPC: only a canonical https URL on a supported push-service
 * host (lib/pwa/push-endpoint-policy.ts) with well-formed keys is stored,
 * and the canonical href — not the raw string — is what gets saved. This
 * is a fast, friendly refusal for the normal browser path; it is NOT the
 * security boundary, because a member can also call the save RPC directly
 * with any string. The boundary is the sender (lib/pwa/web-push-server.ts),
 * which re-checks every subscription before making any request and turns
 * a refused one into "stale" so the database revokes the row.
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

  const endpoint = validatePushEndpoint(input.endpoint, {
    extraAllowedHosts: extraAllowedPushHostsFromEnv(),
  });
  const keys = validatePushKeys(input.p256dh, input.authKey);
  if (!endpoint.ok || !keys.ok) {
    // Reason codes only — never the endpoint or the keys — in the log.
    console.warn("[savePushSubscriptionAction] subscription refused", {
      tenantId: input.tenantId,
      reason: !endpoint.ok ? `endpoint:${endpoint.reason}` : `keys:${(keys as { reason: string }).reason}`,
    });
    return fail("VALIDATION", "Bu tarayıcı veya cihaz için bildirim bağlantısı kurulamıyor");
  }
  // A label is coarse platform text ("Windows"); keep it short and printable.
  const deviceLabel =
    typeof input.deviceLabel === "string"
      ? input.deviceLabel.replace(/[^\x20-\x7eÀ-ɏ]/g, "").slice(0, 60) || undefined
      : undefined;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_push_subscription", {
    p_tenant_id: input.tenantId,
    p_endpoint: endpoint.href,
    p_p256dh: input.p256dh,
    p_auth_key: input.authKey,
    p_device_label: deviceLabel,
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
 * Faz NOTIF.2D.1 — security correction. The original version called an
 * `authenticated`-grantable RPC that returned raw endpoint/p256dh/
 * auth_key — reachable directly from browser devtools regardless of
 * what this action itself chose to show. Corrected flow, in order:
 *   1. requireUser() resolves the real signed-in user server-side.
 *   2. createAdminClient() (service_role) calls
 *      get_push_subscriptions_for_test_send — granted to service_role
 *      ONLY (20260914121000); authenticated has zero execute on it, so
 *      this material cannot be read directly from the browser at all.
 *   3. user.id is passed explicitly (service_role has no auth.uid());
 *      the browser is never asked for and never trusted with a user id.
 *      The RPC itself re-verifies that (tenantId, user.id) is an ACTIVE
 *      membership (NF003 otherwise) and returns only that one
 *      membership's own non-revoked rows — never another person's, never
 *      another tenant's.
 * Stale-subscription revocation still goes through the ordinary
 * (non-admin) client and the existing authenticated remove_push_
 * subscription RPC — that one already correctly derives ownership from
 * this same signed-in user's auth.uid(), so no broadened grant is
 * needed for it.
 *
 * Faz ACCOUNT.1 — this action is NO LONGER gated on settings.manage.
 * That gate only made sense while the notification card lived on the
 * settings page; it never was what kept the read scoped (steps 2-3 above
 * are). The card now lives on every member's own account page, and "send
 * a test to MY OWN devices" is the same class of action as saving or
 * removing them (savePushSubscriptionAction, removePushSubscriptionAction,
 * neither of which ever required settings.manage). Salon-level
 * configuration stays behind settings.manage; nothing salon-wide is
 * readable or writable from here.
 *
 * When every one of the caller's subscriptions turns out stale (push
 * service 404/410) or refused by the endpoint policy, they are revoked and
 * the caller gets NOT_FOUND with a "connection expired" message — the
 * account page reads that as the "subscription expired" state and offers
 * to reconnect this device.
 *
 * Faz ACCOUNT.1 (security) — abuse limits (lib/pwa/test-send-limiter.ts):
 * per user (>= 5 s apart, <= 6 per 10 min), per device (<= 3 per 10 min)
 * and at most MAX_DEVICES_PER_TEST_SEND devices per press. The user gate
 * runs BEFORE any database or admin-client work, so a hammering caller
 * costs almost nothing. The only devices ever contacted are the ones the
 * RPC returns for (tenantId, the session's own user id): there is no
 * input that can name another member's device.
 */
export async function sendTestPushNotificationAction(
  _prevState: ActionResult<{ sent: boolean }> | null,
  input: { tenantId: string },
): Promise<ActionResult<{ sent: boolean }>> {
  const user = await requireUser();

  const userGate = testSendLimiters.user.check(user.id);
  if (!userGate.allowed) {
    return fail(
      "RATE_LIMITED",
      `Çok sık test bildirimi gönderdiniz. Lütfen ${retryAfterPhrase(userGate.retryAfterMs)} sonra tekrar deneyin.`,
    );
  }
  testSendLimiters.user.record(user.id);

  const admin = createAdminClient();
  const { data, error, status, statusText } = await admin.rpc("get_push_subscriptions_for_test_send", {
    p_tenant_id: input.tenantId,
    p_user_id: user.id,
  });

  if (error) {
    if (error.code === "NF003") {
      return fail("UNAUTHORIZED", "Bu işlem için aktif bir üyeliğiniz yok");
    }
    // Faz NOTIF.2D.2 — the previous version of this log line printed
    // only `code`, which is undefined for whole classes of failure
    // (an auth-layer rejection from an invalid/wrong-project service
    // key, a network error) and left a real PROD failure
    // undiagnosable. PostgrestError's own fields, in the order its own
    // doc comment recommends reading them (hint first — Postgres often
    // puts the actual fix there, not in message): name, message, code,
    // details, hint, plus the HTTP status/statusText that PostgREST
    // returns alongside the error (a sibling of `error`, not a field on
    // it). None of these can ever contain the service_role key, the
    // VAPID private key, or subscription material — they only ever
    // describe the RPC call's own outcome.
    console.error("[sendTestPushNotificationAction] read failed", {
      tenantId: input.tenantId,
      name: error.name,
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      status,
      statusText,
    });
    return fail("UNEXPECTED", "Test bildirimi gönderilemedi, lütfen tekrar deneyin");
  }

  const allSubscriptions = (data ?? []) as Array<{ id: string; endpoint: string; p256dh: string; authKey: string }>;
  if (allSubscriptions.length === 0) {
    return fail("NOT_FOUND", "Bu cihaz için kayıtlı bir bildirim aboneliği yok");
  }

  // Bounded fan-out, then the per-device brake. A device over its limit is
  // skipped (not an error) as long as another one can be tested.
  const subscriptions: typeof allSubscriptions = [];
  let soonestDeviceRetryMs = Number.POSITIVE_INFINITY;
  for (const subscription of allSubscriptions.slice(0, MAX_DEVICES_PER_TEST_SEND)) {
    const deviceGate = testSendLimiters.device.check(subscription.id);
    if (deviceGate.allowed) subscriptions.push(subscription);
    else soonestDeviceRetryMs = Math.min(soonestDeviceRetryMs, deviceGate.retryAfterMs);
  }
  if (subscriptions.length === 0) {
    return fail(
      "RATE_LIMITED",
      `Bu cihaza çok sık test bildirimi gönderildi. Lütfen ${retryAfterPhrase(soonestDeviceRetryMs)} sonra tekrar deneyin.`,
    );
  }
  for (const subscription of subscriptions) testSendLimiters.device.record(subscription.id);

  const supabase = await createClient();
  let anySent = false;
  let anyStale = false;
  for (const subscription of subscriptions) {
    const result: TestPushSubscription = {
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      authKey: subscription.authKey,
    };
    const sendResult = await sendTestPush(result);
    if (sendResult.outcome === "sent") {
      anySent = true;
    } else if (sendResult.outcome === "stale" || sendResult.outcome === "rejected") {
      // "rejected": the subscription can never be delivered to (a host the
      // endpoint policy refuses, malformed keys) — same fate as a dead one.
      anyStale = true;
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
    if (anyStale) {
      return fail("NOT_FOUND", "Bu cihazın bildirim bağlantısı sona ermiş. Bildirimleri yeniden açın.");
    }
    return fail("UNEXPECTED", "Test bildirimi gönderilemedi, lütfen tekrar deneyin");
  }

  return ok({ sent: true });
}

/** Preference key -> update_my_notification_preferences parameter name. */
const PREFERENCE_RPC_PARAM = {
  newAppointment: "p_new_appointment",
  cancellation: "p_cancellation",
  reschedule: "p_reschedule",
  assignmentChange: "p_assignment_change",
} as const satisfies Record<NotificationPreferenceKey, string>;

/**
 * Faz ACCOUNT.1 — one notification category toggle for the CALLER's own
 * membership. The same "my own notification settings" class as the push
 * subscription actions above: not gated on settings.manage, because
 * update_my_notification_preferences derives the membership from
 * auth.uid() inside the database and raises NF003 for anyone without an
 * active membership in tenantId — there is no parameter that could name
 * another member's row, and no field but the four named booleans.
 *
 * Accepts exactly one category per call (the switch that was flipped):
 * the RPC treats an omitted parameter as "leave unchanged", so a stale tab
 * that still shows an old value for a category it never touched cannot
 * revert it — the same partial-update discipline as
 * updateSelfServicePolicyAction. The full, authoritative preference set
 * comes back so the client can resync every switch from it.
 */
export async function updateMyNotificationPreferenceAction(
  _prevState: ActionResult<NotificationPreferences> | null,
  input: { tenantId: string; key: NotificationPreferenceKey; enabled: boolean },
): Promise<ActionResult<NotificationPreferences>> {
  await requireUser();

  // Object.hasOwn: a key like "constructor" or "__proto__" must never
  // resolve through the prototype chain to something truthy.
  if (
    typeof input.enabled !== "boolean" ||
    typeof input.key !== "string" ||
    !Object.hasOwn(PREFERENCE_RPC_PARAM, input.key)
  ) {
    return fail("VALIDATION", "Geçersiz bildirim tercihi");
  }

  const args: {
    p_tenant_id: string;
    p_new_appointment?: boolean;
    p_cancellation?: boolean;
    p_reschedule?: boolean;
    p_assignment_change?: boolean;
  } = { p_tenant_id: input.tenantId };
  args[PREFERENCE_RPC_PARAM[input.key]] = input.enabled;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("update_my_notification_preferences", args);

  if (error) {
    if (error.code === "NF003") {
      return fail("UNAUTHORIZED", "Bu işlem için aktif bir üyeliğiniz yok");
    }
    console.error("[updateMyNotificationPreferenceAction] failed", {
      tenantId: input.tenantId,
      code: error.code,
    });
    return fail("UNEXPECTED", "Tercih kaydedilemedi, lütfen tekrar deneyin");
  }

  const preferences = parseNotificationPreferences(data);
  if (!preferences) {
    console.error("[updateMyNotificationPreferenceAction] RPC returned an unexpected shape", {
      tenantId: input.tenantId,
    });
    return fail("UNEXPECTED", "Tercih kaydedilemedi, lütfen tekrar deneyin");
  }

  return ok(preferences);
}
