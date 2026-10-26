"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { updateCustomerNotificationSettingAction } from "@/lib/modules/settings/actions";
import type {
  CustomerNotificationHealth,
  CustomerNotificationSettingKey,
  CustomerNotificationSettings as Settings,
} from "@/lib/modules/settings/queries";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const ORDER: CustomerNotificationSettingKey[] = [
  "appointment_confirmation",
  "appointment_update",
  "appointment_cancellation",
  "appointment_reminder_24h",
];

/**
 * Faz LAUNCH.1B — "Müşteri Bildirimleri": one e-mail switch per appointment event,
 * for one salon. Each switch saves on its own (like the online-booking toggle) and is
 * only moved when the server confirms: the position shown always comes from the
 * server's answer, never from a guess. A refusal leaves the switch where it was and
 * says so. Rendered only for settings.manage holders (the page redirects everyone else
 * and the RPC re-checks).
 */
export function CustomerNotificationSettings({
  tenantId,
  tenantSlug,
  initialSettings,
  health,
}: {
  tenantId: string;
  tenantSlug: string;
  initialSettings: Settings;
  health: CustomerNotificationHealth | null;
}) {
  const t = useTranslations("Settings.customerNotifications");
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [pendingKey, setPendingKey] = useState<CustomerNotificationSettingKey | null>(null);
  const [savedKey, setSavedKey] = useState<CustomerNotificationSettingKey | null>(null);
  const [errorKey, setErrorKey] = useState<CustomerNotificationSettingKey | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleToggle(key: CustomerNotificationSettingKey, checked: boolean) {
    setPendingKey(key);
    setSavedKey(null);
    setErrorKey(null);
    setErrorMessage(null);
    startTransition(async () => {
      const result = await updateCustomerNotificationSettingAction(null, {
        tenantId,
        tenantSlug,
        type: key,
        enabled: checked,
      });
      setPendingKey(null);
      if (result.success) {
        setSettings((current) => ({ ...current, [key]: result.data.enabled }));
        setSavedKey(key);
      } else {
        setErrorKey(key);
        setErrorMessage(result.error.message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-5" data-testid="customer-notification-settings">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium">{t("heading")}</h2>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>

      <ul className="flex flex-col gap-4">
        {ORDER.map((key) => (
          <li key={key} className="flex items-center justify-between gap-4">
            <Label htmlFor={`customer-notification-${key}`} className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{t(`${key}.label`)}</span>
              <span className="text-muted-foreground text-sm font-normal">{t(`${key}.hint`)}</span>
              {savedKey === key ? (
                <span className="text-sm font-normal text-emerald-700" role="status">
                  {t("saved")}
                </span>
              ) : null}
              {errorKey === key && errorMessage ? (
                <span className="text-destructive text-sm font-normal" role="alert">
                  {errorMessage}
                </span>
              ) : null}
            </Label>
            <Switch
              id={`customer-notification-${key}`}
              checked={settings[key]}
              disabled={pendingKey !== null}
              onCheckedChange={(checked) => handleToggle(key, checked)}
            />
          </li>
        ))}
      </ul>

      {health ? (
        <p
          className={`text-sm ${health.failed + health.uncertain > 0 ? "text-destructive" : "text-muted-foreground"}`}
          data-testid="customer-notification-health"
        >
          {health.failed + health.uncertain > 0
            ? t("health.problems", { count: health.failed + health.uncertain, days: health.windowDays })
            : t("health.ok", { sent: health.sent, days: health.windowDays })}
        </p>
      ) : null}
    </div>
  );
}
