"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { BellOff, BellRing, Check, Send, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  deriveNotificationView,
  requestNotificationPermissionOnGesture,
} from "@/lib/pwa/notification-permission";
import {
  refreshNotificationEnv,
  useNotificationEnv,
} from "@/lib/pwa/use-notification-env";
import {
  deriveDeviceLabel,
  extractSubscriptionKeys,
  getExistingPushSubscription,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/pwa/push-subscription";
import {
  removePushSubscriptionAction,
  savePushSubscriptionAction,
  sendTestPushNotificationAction,
} from "@/lib/modules/settings/actions";

/**
 * Faz NOTIF.2C — device notification permission UX. Faz NOTIF.2D adds the
 * real subscription layer below it (Steps 4-10, 16-17): whether THIS
 * device has an actual PushSubscription saved against this tenant
 * membership, and manual connect/disconnect/test-send actions.
 *
 * The permission half is unchanged from NOTIF.2C — deriveNotificationView
 * and requestNotificationPermissionOnGesture still never know a
 * PushSubscription exists. The subscription half only ever runs once
 * view.kind === "granted": there is nothing to check or reconcile before
 * permission is granted, since getSubscription() would just be null.
 *
 * Which business-event categories a salon user wants (Yeni randevu /
 * Randevu iptali / …) is still a separate concern (the NOTIF.2A
 * preference RPCs), deliberately not merged in here.
 */

type DeviceState =
  | { status: "checking" }
  | { status: "not-subscribed" }
  | { status: "connecting" }
  | { status: "subscribed"; subscriptionId: string }
  | { status: "disconnecting"; subscriptionId: string };

type TestSendState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent" }
  | { status: "error"; message: string };

export function NotificationSettingsCard({
  tenantId,
  vapidPublicKey,
}: {
  tenantId: string;
  vapidPublicKey: string | undefined;
}) {
  const t = useTranslations("Settings.notifications");
  const env = useNotificationEnv();
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<DeviceState>({ status: "checking" });
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [testSend, setTestSend] = useState<TestSendState>({ status: "idle" });

  const view = env ? deriveNotificationView(env) : null;
  const granted = view?.kind === "granted";

  // Reconcile-on-mount: if the browser already holds a PushSubscription
  // (created in an earlier session), persist its association again
  // through the idempotent save RPC. This is NOT "silently subscribing"
  // per Step 4 — it never calls pushManager.subscribe(), only re-saves
  // metadata about a subscription the browser already has, which is how
  // this device's saved state can self-heal (e.g. after a DEV database
  // reset) without forcing the user through connect/disconnect again.
  // save_push_subscription never returns endpoint/p256dh/auth_key back
  // to the browser (Faz NOTIF.2A), so there is no way to ask "is my
  // current endpoint already saved" other than calling save again.
  const reconcileRanFor = useRef<string | null>(null);
  useEffect(() => {
    if (!granted) return;
    if (reconcileRanFor.current === tenantId) return;
    reconcileRanFor.current = tenantId;

    let cancelled = false;
    (async () => {
      setDevice({ status: "checking" });
      try {
        const subscription = await getExistingPushSubscription();
        if (cancelled) return;
        if (!subscription) {
          setDevice({ status: "not-subscribed" });
          return;
        }
        const keys = extractSubscriptionKeys(subscription);
        const result = await savePushSubscriptionAction(null, {
          tenantId,
          endpoint: keys.endpoint,
          p256dh: keys.p256dh,
          authKey: keys.authKey,
          deviceLabel: deriveDeviceLabel(),
        });
        if (cancelled) return;
        if (result.success) {
          setDevice({ status: "subscribed", subscriptionId: result.data.id });
        } else {
          // Browser has a subscription but we couldn't reconcile it —
          // offer the connect action again rather than claiming "ready".
          setDevice({ status: "not-subscribed" });
        }
      } catch {
        if (!cancelled) setDevice({ status: "not-subscribed" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [granted, tenantId]);

  const handleEnableClick = useCallback(async () => {
    setBusy(true);
    try {
      await requestNotificationPermissionOnGesture();
      refreshNotificationEnv();
    } finally {
      setBusy(false);
    }
  }, []);

  const handleConnectClick = useCallback(async () => {
    if (!vapidPublicKey) {
      setDeviceError(t("connectError"));
      return;
    }
    setDeviceError(null);
    setDevice({ status: "connecting" });
    try {
      const subscription = await subscribeToPush(vapidPublicKey);
      const keys = extractSubscriptionKeys(subscription);
      const result = await savePushSubscriptionAction(null, {
        tenantId,
        endpoint: keys.endpoint,
        p256dh: keys.p256dh,
        authKey: keys.authKey,
        deviceLabel: deriveDeviceLabel(),
      });
      if (result.success) {
        setDevice({ status: "subscribed", subscriptionId: result.data.id });
      } else {
        setDevice({ status: "not-subscribed" });
        setDeviceError(result.error.message);
      }
    } catch {
      setDevice({ status: "not-subscribed" });
      setDeviceError(t("connectError"));
    }
  }, [tenantId, vapidPublicKey, t]);

  const handleDisconnectClick = useCallback(
    async (subscriptionId: string) => {
      setDeviceError(null);
      setDevice({ status: "disconnecting", subscriptionId });
      try {
        const subscription = await getExistingPushSubscription();
        if (subscription) {
          const browserOk = await unsubscribeFromPush(subscription);
          if (!browserOk) {
            setDevice({ status: "subscribed", subscriptionId });
            setDeviceError(t("disconnectError"));
            return;
          }
        }
        // Browser side is now unsubscribed (or was already gone) —
        // proceed to remove the SalonOS association. If this fails, the
        // honest state is still "not-subscribed" (the browser truth),
        // but surfaced as an error rather than a silent success.
        const result = await removePushSubscriptionAction(null, { subscriptionId });
        setDevice({ status: "not-subscribed" });
        if (!result.success && result.error.code !== "NOT_FOUND") {
          setDeviceError(t("disconnectPartialError"));
        }
      } catch {
        setDevice({ status: "subscribed", subscriptionId });
        setDeviceError(t("disconnectError"));
      }
    },
    [t],
  );

  const handleTestSendClick = useCallback(async () => {
    setTestSend({ status: "sending" });
    try {
      const result = await sendTestPushNotificationAction(null, { tenantId });
      if (result.success) {
        setTestSend({ status: "sent" });
      } else {
        setTestSend({ status: "error", message: result.error.message });
      }
    } catch {
      // Faz NOTIF.2D.2 — sendTestPushNotificationAction is designed to
      // always return an ActionResult, never throw, but a Server Action
      // call can still reject the promise it returns (a misconfigured
      // server-only client throwing during construction — confirmed as
      // PROD's own first failure, "Error: supabaseKey is required" —
      // or requireUser()'s redirect() on an expired session). Without
      // this catch, that left the button on "Gönderiliyor…" forever
      // with no feedback at all.
      setTestSend({ status: "error", message: t("testSendError") });
    }
  }, [tenantId, t]);

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-5">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{t("heading")}</span>
        <span className="text-muted-foreground text-sm">{t("description")}</span>
      </div>

      {view === null && (
        <p className="text-muted-foreground text-sm">{t("checking")}</p>
      )}

      {view?.kind === "unsupported" && (
        <p className="text-muted-foreground text-sm">{t("unsupported")}</p>
      )}

      {view?.kind === "ios-needs-install" && (
        <div className="bg-muted flex items-start gap-2.5 rounded-md p-3">
          <Smartphone className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t("iosInstall.title")}</span>
            <span className="text-muted-foreground text-sm">{t("iosInstall.steps")}</span>
          </div>
        </div>
      )}

      {view?.kind === "default" && (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">{t("enablePrompt")}</p>
          <Button
            type="button"
            onClick={handleEnableClick}
            disabled={busy}
            className="self-start"
          >
            <BellRing />
            {t("enableAction")}
          </Button>
        </div>
      )}

      {view?.kind === "granted" && (
        <div className="flex flex-col gap-3">
          {device.status === "subscribed" ? (
            <div className="flex items-center gap-2 text-sm">
              <Check className="text-primary size-4" />
              <span className="font-medium">{t("readyTitle")}</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm">
                <Check className="text-primary size-4" />
                <span className="font-medium">{t("granted")}</span>
              </div>
              <p className="text-muted-foreground text-sm">
                {device.status === "checking" ? t("checkingDevice") : t("notConnected")}
              </p>
            </>
          )}

          {(device.status === "not-subscribed" ||
            device.status === "connecting" ||
            device.status === "checking") && (
            <Button
              type="button"
              onClick={handleConnectClick}
              disabled={device.status !== "not-subscribed"}
              className="self-start"
            >
              <Smartphone />
              {device.status === "connecting" ? t("connecting") : t("connectAction")}
            </Button>
          )}

          {(device.status === "subscribed" || device.status === "disconnecting") && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleTestSendClick}
                disabled={testSend.status === "sending"}
              >
                <Send />
                {testSend.status === "sending" ? t("testSending") : t("testSendAction")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  device.status === "subscribed" && handleDisconnectClick(device.subscriptionId)
                }
                disabled={device.status !== "subscribed"}
              >
                <X />
                {device.status === "disconnecting" ? t("disconnecting") : t("disconnectAction")}
              </Button>
            </div>
          )}

          {testSend.status === "sent" && (
            <p className="text-muted-foreground text-sm">{t("testSent")}</p>
          )}
          {testSend.status === "error" && (
            <p className="text-destructive text-sm" role="alert">
              {testSend.message}
            </p>
          )}
          {deviceError && (
            <p className="text-destructive text-sm" role="alert">
              {deviceError}
            </p>
          )}
        </div>
      )}

      {view?.kind === "denied" && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-sm">
            <BellOff className="text-muted-foreground size-4" />
            <span className="font-medium">{t("deniedTitle")}</span>
          </div>
          <p className="text-muted-foreground text-sm">{t("deniedHelp")}</p>
        </div>
      )}
    </div>
  );
}
