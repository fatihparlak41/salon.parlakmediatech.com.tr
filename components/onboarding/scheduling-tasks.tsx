"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/lib/i18n/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setServiceCalendarDurationAction } from "@/lib/modules/services/actions";

function formatLira(price: string): string {
  const n = Number(price);
  return Number.isFinite(n) ? `${n.toLocaleString("tr-TR", { maximumFractionDigits: 2 })} ₺` : `${price} ₺`;
}

export type PendingService = { id: string; name: string; price: string };

/**
 * RC.1C - "how long does this take in the calendar?" for the fixed-price services that are still contact-only. One short row per
 * service: type the minutes, Kaydet. Saving stores the real duration and opens that service for booking; the row disappears.
 * No value is pre-filled: nothing here is presented as already confirmed business data.
 */
export function SchedulingTasks({ tenantSlug, services, canManage }: { tenantSlug: string; services: PendingService[]; canManage: boolean }) {
  const t = useTranslations("Setup.almost");
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (services.length === 0) return null;

  const save = (service: PendingService) => {
    const minutes = Number(values[service.id]);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) {
      setErrors((e) => ({ ...e, [service.id]: t("invalid") }));
      return;
    }
    setErrors((e) => ({ ...e, [service.id]: "" }));
    setPendingId(service.id);
    startTransition(async () => {
      const result = await setServiceCalendarDurationAction(null, { tenantSlug, serviceId: service.id, durationMinutes: minutes });
      setPendingId(null);
      if (!result.success) {
        setErrors((e) => ({ ...e, [service.id]: result.error.message }));
        return;
      }
      router.refresh();
    });
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label={t("durationsTitle")}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{t("durationsTitle")}</h2>
        <p className="text-muted-foreground text-sm">{canManage ? t("durationsBody") : t("durationsOwnerOnly")}</p>
      </div>
      <ul className="flex flex-col gap-3">
        {services.map((s) => (
          <li key={s.id} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{s.name}</span>
              <span className="text-muted-foreground tabular-nums">{formatLira(s.price)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={5}
                max={600}
                className="w-28"
                placeholder={t("minutesPlaceholder")}
                aria-label={t("minutesLabel", { name: s.name })}
                value={values[s.id] ?? ""}
                disabled={!canManage || pendingId === s.id}
                onChange={(e) => setValues((v) => ({ ...v, [s.id]: e.target.value }))}
              />
              <span className="text-muted-foreground text-sm">{t("minutesUnit")}</span>
              <Button type="button" size="sm" disabled={!canManage || pendingId === s.id || !(values[s.id] ?? "").trim()} onClick={() => save(s)}>
                {pendingId === s.id ? t("saving") : t("save")}
              </Button>
            </div>
            {errors[s.id] ? (
              <p className="text-destructive text-xs" role="alert">
                {errors[s.id]}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
