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

type PolicyField = keyof SelfServicePolicy;

/**
 * Faz 2I.4B — the real PROD incident this fixes: SelfServicePolicyForm
 * used to send all 4 policy fields on every save, unconditionally. A
 * stale tab/window — one that loaded before some OTHER save happened
 * elsewhere (another tab, another device) — would resend its own
 * outdated belief about a field it never touched, silently reverting
 * whatever that other, more recent save had set. Reproduced exactly on
 * DEV with two tabs (see the Faz 2I.4B diagnosis report).
 *
 * `dirty` is the fix: the set of fields that differ from the last
 * *successful save* this component instance made — never "touched at
 * some point in this component's lifetime". A field leaves `dirty` the
 * moment a save containing it succeeds, and `handleSave` sends only
 * whatever is currently in `dirty` — so a stale tab that never touched
 * a field never sends it, and can no longer clobber it. `useState`, not
 * `useRef`: the Save button's disabled state depends on it.
 */
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
  const [dirty, setDirty] = useState<Set<PolicyField>>(new Set());

  const [state, action, isPending] = useActionState(
    async (
      prevState: Awaited<ReturnType<typeof updateSelfServicePolicyAction>> | null,
      input: Parameters<typeof updateSelfServicePolicyAction>[1],
    ) => {
      const result = await updateSelfServicePolicyAction(prevState, input);
      if (result.success) {
        // The returned row is the complete, authoritative state right
        // after the write — resync ALL 4 fields from it, not just the
        // ones this particular save sent. That also self-heals any
        // field this same tab had a stale view of, without this save
        // ever having written to it. Dirty resets to empty: a LATER
        // save from this tab must never resend anything from this one
        // merely because it was touched earlier in the tab's lifetime.
        setPolicy(result.data);
        setDirty(new Set());
      }
      // On failure: policy/dirty are deliberately left untouched above
      // — unsaved edits and what still needs to be sent both survive a
      // failed attempt, per spec.
      return result;
    },
    null,
  );

  function markDirty(...fields: PolicyField[]) {
    setDirty((d) => {
      const next = new Set(d);
      for (const f of fields) next.add(f);
      return next;
    });
  }

  function handleSave() {
    if (isPending || dirty.size === 0) return; // never send an empty update
    const payload: Parameters<typeof updateSelfServicePolicyAction>[1] = { tenantId, tenantSlug };
    if (dirty.has("cancellationEnabled")) payload.cancellationEnabled = policy.cancellationEnabled;
    if (dirty.has("cancellationCutoffMinutes")) payload.cancellationCutoffMinutes = policy.cancellationCutoffMinutes;
    if (dirty.has("rescheduleEnabled")) payload.rescheduleEnabled = policy.rescheduleEnabled;
    if (dirty.has("rescheduleCutoffMinutes")) payload.rescheduleCutoffMinutes = policy.rescheduleCutoffMinutes;
    startTransition(() => action(payload));
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
            onCheckedChange={(checked) => {
              const { minutes, suggested } = resolveCutoffOnToggle({
                turningOn: checked,
                currentMinutes: policy.cancellationCutoffMinutes,
                cutoffDirty: dirty.has("cancellationCutoffMinutes"),
              });
              setPolicy((p) => ({ ...p, cancellationEnabled: checked, cancellationCutoffMinutes: minutes }));
              markDirty("cancellationEnabled", ...(suggested ? (["cancellationCutoffMinutes"] as const) : []));
            }}
          />
        </div>
        <CutoffInput
          label={t("cancellationCutoffLabel")}
          totalMinutes={policy.cancellationCutoffMinutes}
          inactive={!policy.cancellationEnabled}
          onChange={(minutes) => {
            setPolicy((p) => ({ ...p, cancellationCutoffMinutes: minutes }));
            markDirty("cancellationCutoffMinutes");
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
            onCheckedChange={(checked) => {
              const { minutes, suggested } = resolveCutoffOnToggle({
                turningOn: checked,
                currentMinutes: policy.rescheduleCutoffMinutes,
                cutoffDirty: dirty.has("rescheduleCutoffMinutes"),
              });
              setPolicy((p) => ({ ...p, rescheduleEnabled: checked, rescheduleCutoffMinutes: minutes }));
              markDirty("rescheduleEnabled", ...(suggested ? (["rescheduleCutoffMinutes"] as const) : []));
            }}
          />
        </div>
        <CutoffInput
          label={t("rescheduleCutoffLabel")}
          totalMinutes={policy.rescheduleCutoffMinutes}
          inactive={!policy.rescheduleEnabled}
          onChange={(minutes) => {
            setPolicy((p) => ({ ...p, rescheduleCutoffMinutes: minutes }));
            markDirty("rescheduleCutoffMinutes");
          }}
        />
      </div>

      {state && !state.success ? (
        <p className="text-destructive text-sm" role="alert">
          {state.error.message}
        </p>
      ) : null}
      {state?.success ? <p className="text-sm text-green-600 dark:text-green-500">{t("saved")}</p> : null}

      <Button type="button" onClick={handleSave} disabled={isPending || dirty.size === 0} className="w-fit">
        {isPending ? t("saving") : t("save")}
      </Button>
    </div>
  );
}
