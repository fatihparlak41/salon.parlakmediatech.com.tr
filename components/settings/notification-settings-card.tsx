"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { BellOff, BellRing, Check, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  deriveNotificationView,
  requestNotificationPermissionOnGesture,
} from "@/lib/pwa/notification-permission";
import {
  refreshNotificationEnv,
  useNotificationEnv,
} from "@/lib/pwa/use-notification-env";

/**
 * Faz NOTIF.2C — device notification permission UX.
 *
 * This card is ONLY about the browser/device permission to show
 * notifications. Which business-event categories a salon user wants
 * (Yeni randevu / Randevu iptali / …) is a separate concern handled by
 * the NOTIF.2A preference RPCs — deliberately not merged in here (see the
 * Faz NOTIF.2C report, "preference toggle UI").
 *
 * It never creates a PushSubscription and never calls VAPID/save — that
 * is NOTIF.2D. "Granted" here means exactly "izin verildi", nothing more.
 *
 * requestPermission() runs from one place only: the "Bildirimleri Aç"
 * button's onClick. Never on mount, never from an effect — the card has
 * no effect at all; environment reads go through useNotificationEnv's
 * external store.
 */
export function NotificationSettingsCard() {
  const t = useTranslations("Settings.notifications");
  const env = useNotificationEnv();
  const [busy, setBusy] = useState(false);

  const handleEnableClick = useCallback(async () => {
    setBusy(true);
    try {
      await requestNotificationPermissionOnGesture();
      // Reflect the new permission immediately, without waiting for a
      // focus event.
      refreshNotificationEnv();
    } finally {
      setBusy(false);
    }
  }, []);

  const view = env ? deriveNotificationView(env) : null;

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
        <div className="flex items-center gap-2 text-sm">
          <Check className="text-primary size-4" />
          <span className="font-medium">{t("granted")}</span>
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
