"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { updateMyNotificationPreferenceAction } from "@/lib/modules/settings/actions";
import {
  NOTIFICATION_PREFERENCE_KEYS,
  type NotificationPreferenceKey,
  type NotificationPreferences,
} from "@/lib/modules/notifications/preference-keys";

/**
 * Faz ACCOUNT.1 — which appointment events the member wants to hear about.
 * Stored per membership (notification_preferences, Faz NOTIF.2A), so the
 * choice applies to every device the member has connected to this salon,
 * and the delivery worker re-reads it at both materialization and send
 * time. Personal only: nothing salon-wide is configurable from here.
 *
 * Each switch saves the moment it is flipped (no separate save step) and
 * sends only that ONE category — see updateMyNotificationPreferenceAction.
 * A rejected request snaps the switch back and says so, rather than
 * leaving the screen showing a preference the server never accepted.
 * All switches are disabled while one request is in flight so two answers
 * can never arrive out of order and repaint each other.
 */
export function NotificationPreferencesCard({
  tenantId,
  initialPreferences,
}: {
  tenantId: string;
  initialPreferences: NotificationPreferences;
}) {
  const t = useTranslations("TenantApp.account.categories");
  const [preferences, setPreferences] = useState(initialPreferences);
  const [pendingKey, setPendingKey] = useState<NotificationPreferenceKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(key: NotificationPreferenceKey, enabled: boolean) {
    const previous = preferences[key];
    setPreferences((current) => ({ ...current, [key]: enabled }));
    setPendingKey(key);
    setError(null);
    try {
      const result = await updateMyNotificationPreferenceAction(null, { tenantId, key, enabled });
      if (result.success) {
        // Resync every switch from the authoritative answer, not just the
        // one that was flipped.
        setPreferences(result.data);
      } else {
        setPreferences((current) => ({ ...current, [key]: previous }));
        setError(result.error.message);
      }
    } catch {
      setPreferences((current) => ({ ...current, [key]: previous }));
      setError(t("saveError"));
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-5">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{t("heading")}</span>
        <span className="text-muted-foreground text-sm">{t("description")}</span>
      </div>

      <ul className="flex flex-col divide-y">
        {NOTIFICATION_PREFERENCE_KEYS.map((key) => {
          const id = `notification-preference-${key}`;
          return (
            <li key={key} className="flex items-center justify-between gap-4 py-3 first:pt-0">
              <Label htmlFor={id} className="flex flex-col items-start gap-0.5">
                <span className="text-sm font-medium">{t(`${key}.label`)}</span>
                <span className="text-muted-foreground text-sm font-normal">
                  {t(`${key}.description`)}
                </span>
              </Label>
              <Switch
                id={id}
                checked={preferences[key]}
                disabled={pendingKey !== null}
                onCheckedChange={(checked) => handleToggle(key, checked)}
              />
            </li>
          );
        })}
        <li className="flex items-center justify-between gap-4 py-3 last:pb-0">
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-sm font-medium">{t("reminder.label")}</span>
            <span className="text-muted-foreground text-sm font-normal">
              {t("reminder.description")}
            </span>
          </div>
          <Badge variant="secondary">{t("reminder.soon")}</Badge>
        </li>
      </ul>

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
