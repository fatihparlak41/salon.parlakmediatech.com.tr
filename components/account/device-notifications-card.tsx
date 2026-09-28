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
import { enforceDeviceOwnership, isForeignDevice } from "@/lib/pwa/device-session";
import { browserDeviceDeps, browserDeviceIdentity } from "@/lib/pwa/device-session-browser";

/**
 * Faz ACCOUNT.1 — the personal, per-device notification control. It lives
 * on the member's own "Hesabım" page, NOT on the settings page: turning
 * notifications on for THIS browser is a personal act every active member
 * of a salon may perform, whereas /settings is salon configuration behind
 * settings.manage. (Faz NOTIF.2C/2D built this as a card on /settings;
 * everything below the state model is that same, already-shipped logic.)
 *
 * States the member can be in, all derived from what the browser and the
 * database actually report — never assumed:
 *   unsupported        browser lacks Notification / Service Worker / Push
 *   ios-needs-install  iPhone/iPad Safari tab: needs "Add to Home Screen"
 *   default            permission not asked yet -> one button asks AND
 *                      connects
 *   denied             blocked in the browser; only the browser settings
 *                      can undo that, so we explain instead of re-asking
 *   granted            + connected      -> ready, test / turn off
 *                      + not-connected  -> permission is fine but this
 *                        browser holds no subscription the server knows
 *                        (never connected, cleared, or expired) -> one
 *                        button reconnects
 *
 * Hard rules kept from NOTIF.2C/2D:
 *   - Notification.requestPermission() and pushManager.subscribe() are
 *     only ever reached from the click handler below, never from render or
 *     a mount effect. The mount effect only READS the browser's existing
 *     subscription and re-saves it (idempotent) so the saved state can
 *     self-heal — it never subscribes or unsubscribes.
 *   - Every RPC behind the Server Actions derives the caller's own active
 *     membership from auth.uid(); this component never sends a user or
 *     membership id, so it cannot address anyone else's device.
 *
 * Shared browsers (Faz ACCOUNT.1 security, lib/pwa/device-session.ts): the
 * browser remembers WHO connected it (a hash tag, never the user id). This
 * card never adopts a subscription that another person connected — it drops
 * it and makes this member switch notifications on themselves — and it
 * records the tag and the saved row id whenever THIS member connects, so
 * signing out can disconnect exactly what this member created.
 *
 * Which business-event categories the member wants is a separate concern
 * (notification-preferences-card.tsx).
 */

/** The one button this page exists for is mostly tapped on a phone: 40px
 * high there (a comfortable touch target), the design system's normal 32px
 * from the md breakpoint up. */
const ENABLE_BUTTON_CLASS = "h-10 self-start px-4 md:h-8 md:px-2.5";

type DeviceState =
  | { status: "checking" }
  | { status: "not-connected"; expired: boolean }
  | { status: "connecting" }
  | { status: "connected"; subscriptionId: string }
  | { status: "disconnecting"; subscriptionId: string };

type TestSendState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent" }
  | { status: "error"; message: string };

export function DeviceNotificationsCard({
  tenantId,
  vapidPublicKey,
  recipientNote,
  ownerTag,
}: {
  tenantId: string;
  vapidPublicKey: string | undefined;
  /** Server-computed tag of the signed-in user (lib/pwa/device-owner-tag.ts). */
  ownerTag: string;
  /** Server-computed, role-aware one-liner about which appointments this
   * member's devices will actually be notified about. */
  recipientNote: string | null;
}) {
  const t = useTranslations("TenantApp.account.notifications");
  const env = useNotificationEnv();
  const [device, setDevice] = useState<DeviceState>({ status: "checking" });
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [testSend, setTestSend] = useState<TestSendState>({ status: "idle" });

  const view = env ? deriveNotificationView(env) : null;
  const granted = view?.kind === "granted";
  const permissionIsDefault = view?.kind === "default";

  // Reconcile-on-mount: if the browser already holds a PushSubscription
  // (created in an earlier session), persist its association again
  // through the idempotent save RPC. This is NOT "silently subscribing" —
  // it never calls pushManager.subscribe(), only re-saves metadata about
  // a subscription the browser already has, which is how this device's
  // saved state self-heals (a database reset, a revoked row after a
  // previous member used this browser) without making the member go
  // through connect/disconnect again. save_push_subscription never
  // returns endpoint/p256dh/auth_key to the browser, so there is no way to
  // ask "is my current endpoint already saved" other than calling save.
  //
  // `reconciledFor` is set only when a run FINISHES uncancelled — never up
  // front. React StrictMode (development) mounts an effect, cleans it up
  // and mounts it again; marking the tenant "done" before the first run
  // completed made the second run bail out while the first run's result
  // was already discarded as cancelled, leaving the card on "checking"
  // forever whenever the page was reached by client-side navigation.
  const reconciledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!granted) return;
    if (reconciledFor.current === tenantId) return;

    let cancelled = false;
    (async () => {
      setDevice({ status: "checking" });
      try {
        // A subscription that ANOTHER person connected on this browser is
        // not this member's: drop it, never adopt it (shared-browser policy).
        if (isForeignDevice(browserDeviceIdentity(), ownerTag)) {
          await enforceDeviceOwnership(ownerTag, browserDeviceDeps());
          if (!cancelled) setDevice({ status: "not-connected", expired: false });
          return;
        }
        const subscription = await getExistingPushSubscription();
        if (cancelled) return;
        if (!subscription) {
          setDevice({ status: "not-connected", expired: false });
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
          const identity = browserDeviceIdentity();
          identity.setOwnerTag(ownerTag);
          identity.rememberDevice(tenantId, result.data.id);
          setDevice({ status: "connected", subscriptionId: result.data.id });
        } else {
          // The browser has a subscription but it could not be saved —
          // offer the connect action again rather than claiming "ready".
          setDevice({ status: "not-connected", expired: false });
        }
      } catch {
        if (!cancelled) setDevice({ status: "not-connected", expired: false });
      } finally {
        if (!cancelled) reconciledFor.current = tenantId;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [granted, tenantId, ownerTag]);

  const connectDevice = useCallback(
    async (replaceExisting: boolean) => {
      if (!vapidPublicKey) {
        setDevice({ status: "not-connected", expired: false });
        setDeviceError(t("connectError"));
        return;
      }
      setDevice({ status: "connecting" });
      try {
        if (replaceExisting || isForeignDevice(browserDeviceIdentity(), ownerTag)) {
          // Either the server told us this browser's subscription is dead
          // (push service 404/410), or somebody else connected it. Drop the
          // browser-side object too, otherwise subscribe() below would hand
          // the same one back — this member gets a fresh subscription of
          // their own.
          const stale = await getExistingPushSubscription();
          if (stale) await unsubscribeFromPush(stale);
        }
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
          const identity = browserDeviceIdentity();
          identity.setOwnerTag(ownerTag);
          identity.rememberDevice(tenantId, result.data.id);
          setDevice({ status: "connected", subscriptionId: result.data.id });
        } else {
          // The server refused this subscription (unsupported push service,
          // no membership, ...): do not leave the browser holding one the
          // app can never use — or that the next person on this browser
          // could be offered as if it were theirs.
          void unsubscribeFromPush(subscription).catch(() => undefined);
          setDevice({ status: "not-connected", expired: false });
          setDeviceError(result.error.message);
        }
      } catch {
        setDevice({ status: "not-connected", expired: false });
        setDeviceError(t("connectError"));
      }
    },
    [tenantId, vapidPublicKey, ownerTag, t],
  );

  // The single "Bu cihazda bildirimleri aç" button. Permission (if still
  // undecided) and the device connection happen in ONE gesture, so a
  // member never has to find a second button. If the browser refuses the
  // subscribe half right after granting (Safari can be strict about
  // gesture propagation), the card falls back to the not-connected state
  // and the same button connects on the next tap — permission is already
  // granted by then, so no second prompt.
  const handleEnableClick = useCallback(async () => {
    setDeviceError(null);
    setTestSend({ status: "idle" });
    // From here this handler owns the device state. Without this, the
    // reconcile effect above would fire the instant permission flips to
    // "granted", read "no subscription yet" and overwrite "connecting".
    reconciledFor.current = tenantId;

    if (permissionIsDefault) {
      setDevice({ status: "connecting" });
      const permission = await requestNotificationPermissionOnGesture();
      refreshNotificationEnv();
      if (permission !== "granted") {
        setDevice({ status: "not-connected", expired: false });
        if (permission === "default") setDeviceError(t("permissionDismissed"));
        return;
      }
    }
    await connectDevice(device.status === "not-connected" && device.expired);
  }, [tenantId, permissionIsDefault, connectDevice, device, t]);

  const handleDisconnectClick = useCallback(
    async (subscriptionId: string) => {
      setDeviceError(null);
      setTestSend({ status: "idle" });
      setDevice({ status: "disconnecting", subscriptionId });
      try {
        const subscription = await getExistingPushSubscription();
        if (subscription) {
          const browserOk = await unsubscribeFromPush(subscription);
          if (!browserOk) {
            setDevice({ status: "connected", subscriptionId });
            setDeviceError(t("disconnectError"));
            return;
          }
        }
        // Browser side is now unsubscribed (or was already gone) —
        // proceed to remove the SalonOS association. If this fails, the
        // honest state is still "not connected" (the browser truth),
        // but surfaced as an error rather than a silent success.
        const result = await removePushSubscriptionAction(null, { subscriptionId });
        // The browser-side subscription is gone, so nothing is connected
        // here any more: forget who owned it and which rows it had.
        browserDeviceIdentity().clear();
        setDevice({ status: "not-connected", expired: false });
        if (!result.success && result.error.code !== "NOT_FOUND") {
          setDeviceError(t("disconnectPartialError"));
        }
      } catch {
        setDevice({ status: "connected", subscriptionId });
        setDeviceError(t("disconnectError"));
      }
    },
    [t],
  );

  const handleTestSendClick = useCallback(async () => {
    setDeviceError(null);
    setTestSend({ status: "sending" });
    try {
      const result = await sendTestPushNotificationAction(null, { tenantId });
      if (result.success) {
        setTestSend({ status: "sent" });
      } else if (result.error.code === "NOT_FOUND") {
        // The server holds no live subscription for this member any more
        // (it was stale and has just been revoked): this device is no
        // longer connected, whatever the button used to say.
        setTestSend({ status: "idle" });
        setDevice({ status: "not-connected", expired: true });
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

  const enableBusy = device.status === "connecting";

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-5">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{t("heading")}</span>
        <span className="text-muted-foreground text-sm">{t("description")}</span>
      </div>

      {recipientNote && <p className="text-muted-foreground text-sm">{recipientNote}</p>}

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
            disabled={enableBusy}
            className={ENABLE_BUTTON_CLASS}
          >
            <BellRing />
            {enableBusy ? t("enabling") : t("enableAction")}
          </Button>
        </div>
      )}

      {view?.kind === "granted" && (
        <div className="flex flex-col gap-3">
          {(device.status === "connected" || device.status === "disconnecting") && (
            <div className="flex items-center gap-2 text-sm" role="status">
              <Check className="text-primary size-4" />
              <span className="font-medium">{t("readyTitle")}</span>
            </div>
          )}

          {device.status === "checking" && (
            <p className="text-muted-foreground text-sm">{t("checkingDevice")}</p>
          )}

          {(device.status === "not-connected" || device.status === "connecting") && (
            <>
              <p className="text-muted-foreground text-sm">
                {device.status === "not-connected" && device.expired
                  ? t("expired")
                  : t("notConnected")}
              </p>
              <Button
                type="button"
                onClick={handleEnableClick}
                disabled={enableBusy}
                className={ENABLE_BUTTON_CLASS}
              >
                <BellRing />
                {enableBusy ? t("enabling") : t("enableAction")}
              </Button>
            </>
          )}

          {(device.status === "connected" || device.status === "disconnecting") && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleTestSendClick}
                disabled={testSend.status === "sending" || device.status !== "connected"}
              >
                <Send />
                {testSend.status === "sending" ? t("testSending") : t("testSendAction")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  device.status === "connected" && handleDisconnectClick(device.subscriptionId)
                }
                disabled={device.status !== "connected"}
              >
                <X />
                {device.status === "disconnecting" ? t("disconnecting") : t("disconnectAction")}
              </Button>
            </div>
          )}

          {(device.status === "connected" || device.status === "disconnecting") && (
            <p className="text-muted-foreground text-xs">{t("signOutNote")}</p>
          )}

          {testSend.status === "sent" && (
            <p className="text-muted-foreground text-sm" role="status">
              {t("testSent")}
            </p>
          )}
          {testSend.status === "error" && (
            <p className="text-destructive text-sm" role="alert">
              {testSend.message}
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

      {deviceError && (
        <p className="text-destructive text-sm" role="alert">
          {deviceError}
        </p>
      )}
    </div>
  );
}
