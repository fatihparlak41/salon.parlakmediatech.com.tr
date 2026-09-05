"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { updateSelfServicePolicyAction } from "@/lib/modules/settings/actions";
import type { SelfServicePolicy } from "@/lib/modules/settings/queries";
import { splitMinutes, toMinutes, resolveCutoffOnToggle, type Unit } from "@/lib/modules/settings/cutoff";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Faz 2I.4A — `inactive` is visual only (dimmed, matching the previous
 * `disabled` look) and no longer maps to the HTML `disabled` attribute.
 * Diagnosed root cause (see the Faz 2I.4A report): a disabled input
 * silently discards every keystroke/selection with zero feedback — a
 * real owner who configures the cutoff BEFORE flipping the enable
 * toggle (a completely natural order) had their input thrown away
 * without ever knowing it, then saved a stale/zero cutoff believing
 * they'd set 12 hours. Reproduced exactly on DEV via the real settings
 * UI (see report). Keeping the control genuinely interactive regardless
 * of the toggle's state — while still looking secondary when off, per
 * spec — means no interaction with it is ever silently thrown away.
 */
function CutoffInput({
  label,
  totalMinutes,
  onChange,
  inactive,
}: {
  label: string;
  totalMinutes: number;
  onChange: (minutes: number) => void;
  inactive: boolean;
}) {
  const t = useTranslations("Settings.units");
  const [{ amount, unit }, setLocal] = useState(() => splitMinutes(totalMinutes));
  // Tracks the last value THIS component itself reported via onChange —
  // lets the effect below tell "the parent echoed my own edit back down
  // as a prop" (skip; local state is already exactly right, and
  // re-deriving from minutes would fight in-progress typing, e.g.
  // snapping "60 dakika" to "1 saat" before the owner finishes typing
  // "600") apart from "this value changed for some OTHER reason" (a
  // toggle's auto-suggestion, or a fresh value after save/reload —
  // genuinely resync so the field never displays a stale number, which
  // is exactly the display half of the bug this fixes: the save itself
  // was already using the right value, but the input kept showing 0).
  const lastReportedRef = useRef(totalMinutes);

  useEffect(() => {
    if (totalMinutes !== lastReportedRef.current) {
      setLocal(splitMinutes(totalMinutes));
      lastReportedRef.current = totalMinutes;
    }
  }, [totalMinutes]);

  function update(nextAmount: number, nextUnit: Unit) {
    const minutes = toMinutes(nextAmount, nextUnit);
    setLocal({ amount: nextAmount, unit: nextUnit });
    lastReportedRef.current = minutes;
    onChange(minutes);
  }

  return (
    <div className={`flex flex-col gap-1.5 ${inactive ? "opacity-50" : ""}`}>
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input
          type="number"
          min={0}
          value={amount}
          onChange={(e) => update(Number(e.target.value) || 0, unit)}
          className="w-24"
        />
        <Select value={unit} onValueChange={(value) => update(amount, value as Unit)}>
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

  // Faz 2I.4A — distinguishes "this cutoff is still exactly its
  // untouched, as-loaded value" from "the owner explicitly typed/picked
  // this value, including possibly 0" — the two are otherwise
  // indistinguishable by value alone (0 is itself a valid, meaningful
  // choice: "up to the appointment start itself"). Only ever read by
  // resolveCutoffOnToggle to decide whether the toggle-on suggestion is
  // allowed to touch the cutoff; never affects what actually gets saved
  // beyond that.
  const cancellationCutoffTouched = useRef(false);
  const rescheduleCutoffTouched = useRef(false);

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
            onCheckedChange={(checked) =>
              setPolicy((p) => ({
                ...p,
                cancellationEnabled: checked,
                cancellationCutoffMinutes: resolveCutoffOnToggle({
                  turningOn: checked,
                  currentMinutes: p.cancellationCutoffMinutes,
                  touched: cancellationCutoffTouched.current,
                }),
              }))
            }
          />
        </div>
        <CutoffInput
          label={t("cancellationCutoffLabel")}
          totalMinutes={policy.cancellationCutoffMinutes}
          inactive={!policy.cancellationEnabled}
          onChange={(minutes) => {
            cancellationCutoffTouched.current = true;
            setPolicy((p) => ({ ...p, cancellationCutoffMinutes: minutes }));
          }}
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
            onCheckedChange={(checked) =>
              setPolicy((p) => ({
                ...p,
                rescheduleEnabled: checked,
                rescheduleCutoffMinutes: resolveCutoffOnToggle({
                  turningOn: checked,
                  currentMinutes: p.rescheduleCutoffMinutes,
                  touched: rescheduleCutoffTouched.current,
                }),
              }))
            }
          />
        </div>
        <CutoffInput
          label={t("rescheduleCutoffLabel")}
          totalMinutes={policy.rescheduleCutoffMinutes}
          inactive={!policy.rescheduleEnabled}
          onChange={(minutes) => {
            rescheduleCutoffTouched.current = true;
            setPolicy((p) => ({ ...p, rescheduleCutoffMinutes: minutes }));
          }}
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
