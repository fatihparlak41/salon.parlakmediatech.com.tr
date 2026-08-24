"use client";

import { startTransition, useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { updateSelfServicePolicyAction } from "@/lib/modules/settings/actions";
import type { SelfServicePolicy } from "@/lib/modules/settings/queries";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Unit = "minutes" | "hours" | "days";
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };

/** Picks the coarsest unit that divides evenly into the stored minute
 * value, so e.g. 180 displays as "3 saat" not "180 dakika" on load —
 * purely a display convenience, the canonical value is always minutes. */
function splitMinutes(totalMinutes: number): { amount: number; unit: Unit } {
  if (totalMinutes !== 0 && totalMinutes % 1440 === 0) return { amount: totalMinutes / 1440, unit: "days" };
  if (totalMinutes !== 0 && totalMinutes % 60 === 0) return { amount: totalMinutes / 60, unit: "hours" };
  return { amount: totalMinutes, unit: "minutes" };
}

function CutoffInput({
  label,
  totalMinutes,
  onChange,
  disabled,
}: {
  label: string;
  totalMinutes: number;
  onChange: (minutes: number) => void;
  disabled: boolean;
}) {
  const t = useTranslations("Settings.units");
  const [{ amount, unit }, setLocal] = useState(() => splitMinutes(totalMinutes));

  function update(nextAmount: number, nextUnit: Unit) {
    setLocal({ amount: nextAmount, unit: nextUnit });
    onChange(Math.max(0, Math.round(nextAmount * UNIT_MINUTES[nextUnit])));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input
          type="number"
          min={0}
          value={amount}
          disabled={disabled}
          onChange={(e) => update(Number(e.target.value) || 0, unit)}
          className="w-24"
        />
        <Select value={unit} onValueChange={(value) => update(amount, value as Unit)} disabled={disabled}>
          <SelectTrigger className="w-32">
            {/* Base UI's Select.Value shows the raw stored value unless
                given an explicit label-lookup render function — same
                pattern as create-staff-dialog.tsx. */}
            <SelectValue>{(value: Unit) => t(value)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">{t("minutes")}</SelectItem>
            <SelectItem value="hours">{t("hours")}</SelectItem>
            <SelectItem value="days">{t("days")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function SelfServicePolicyForm({
  tenantId,
  tenantSlug,
  initialPolicy,
}: {
  tenantId: string;
  tenantSlug: string;
  initialPolicy: SelfServicePolicy;
}) {
  const t = useTranslations("Settings.selfService");
  const [policy, setPolicy] = useState(initialPolicy);
  const [state, action, isPending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof updateSelfServicePolicyAction>> | null,
      input: Parameters<typeof updateSelfServicePolicyAction>[1],
    ) => {
      const result = await updateSelfServicePolicyAction(prevState, input);
      if (result.success) setPolicy(result.data);
      return result;
    },
    null,
  );

  function handleSave() {
    startTransition(() =>
      action({
        tenantId,
        tenantSlug,
        cancellationEnabled: policy.cancellationEnabled,
        cancellationCutoffMinutes: policy.cancellationCutoffMinutes,
        rescheduleEnabled: policy.rescheduleEnabled,
        rescheduleCutoffMinutes: policy.rescheduleCutoffMinutes,
      }),
    );
  }

  return (
    <div className="flex flex-col gap-6 rounded-lg border p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{t("heading")}</h2>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>

      <div className="flex flex-col gap-4 border-t pt-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="cancellation-enabled" className="flex flex-col gap-0.5">
            <span>{t("cancellationEnabledLabel")}</span>
          </Label>
          <Switch
            id="cancellation-enabled"
            checked={policy.cancellationEnabled}
            onCheckedChange={(checked) => setPolicy((p) => ({ ...p, cancellationEnabled: checked }))}
          />
        </div>
        <CutoffInput
          label={t("cancellationCutoffLabel")}
          totalMinutes={policy.cancellationCutoffMinutes}
          disabled={!policy.cancellationEnabled}
          onChange={(minutes) => setPolicy((p) => ({ ...p, cancellationCutoffMinutes: minutes }))}
        />
      </div>

      <div className="flex flex-col gap-4 border-t pt-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="reschedule-enabled" className="flex flex-col gap-0.5">
            <span>{t("rescheduleEnabledLabel")}</span>
          </Label>
          <Switch
            id="reschedule-enabled"
            checked={policy.rescheduleEnabled}
            onCheckedChange={(checked) => setPolicy((p) => ({ ...p, rescheduleEnabled: checked }))}
          />
        </div>
        <CutoffInput
          label={t("rescheduleCutoffLabel")}
          totalMinutes={policy.rescheduleCutoffMinutes}
          disabled={!policy.rescheduleEnabled}
          onChange={(minutes) => setPolicy((p) => ({ ...p, rescheduleCutoffMinutes: minutes }))}
        />
      </div>

      {state && !state.success ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : null}
      {state?.success ? <p className="text-sm text-green-600 dark:text-green-500">{t("saved")}</p> : null}

      <Button type="button" onClick={handleSave} disabled={isPending} className="w-fit">
        {isPending ? t("saving") : t("save")}
      </Button>
    </div>
  );
}
