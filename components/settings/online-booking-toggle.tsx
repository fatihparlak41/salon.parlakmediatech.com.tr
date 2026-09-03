"use client";

import { startTransition, useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { updateOnlineBookingSettingAction } from "@/lib/modules/settings/actions";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function OnlineBookingToggle({
  tenantId,
  tenantSlug,
  initialEnabled,
}: {
  tenantId: string;
  tenantSlug: string;
  initialEnabled: boolean;
}) {
  const t = useTranslations("Settings.onlineBooking");
  const [enabled, setEnabled] = useState(initialEnabled);
  const [state, action, isPending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof updateOnlineBookingSettingAction>> | null,
      input: Parameters<typeof updateOnlineBookingSettingAction>[1],
    ) => {
      const result = await updateOnlineBookingSettingAction(prevState, input);
      if (result.success) {
        setEnabled(result.data);
      } else {
        // Revert the optimistic switch position on failure — the toggle
        // itself already fires the request on change (no separate save
        // step), so a rejected request must visibly snap back rather
        // than leave the UI showing a state the server didn't accept.
        setEnabled((current) => !current);
      }
      return result;
    },
    null,
  );

  function handleToggle(checked: boolean) {
    setEnabled(checked);
    startTransition(() => action({ tenantId, tenantSlug, enabled: checked }));
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-5">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="online-booking-enabled" className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{t("heading")}</span>
          <span className="text-muted-foreground text-sm font-normal">{t("description")}</span>
        </Label>
        <Switch
          id="online-booking-enabled"
          checked={enabled}
          disabled={isPending}
          onCheckedChange={handleToggle}
        />
      </div>
      {state && !state.success ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : null}
    </div>
  );
}
