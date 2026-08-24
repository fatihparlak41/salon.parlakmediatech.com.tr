"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { rescheduleMyAppointmentAction } from "@/lib/modules/customer-account/actions";
import { fetchMyRescheduleSlots } from "@/lib/modules/customer-account/client-queries";
import { tenantLocalToUtcIso, getTenantTodayRangeUtc } from "@/lib/modules/appointments/timezone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";

/**
 * Faz 2G.2B.1 — the customer's reschedule business date is tenant-local,
 * never the browser's own local date (the same rule every other date
 * boundary in this codebase already follows — see timezone.ts's own
 * header). Reuses getTenantTodayRangeUtc rather than new Date() getters;
 * the +30 day ceiling is pure calendar-date string arithmetic (no
 * further zone conversion needed — see getTenantWeekRangeUtc's own
 * comment for why that's safe), matching get_my_reschedule_slots' own
 * server-side horizon exactly.
 */
export function tenantMaxDateString(tenantTz: string): string {
  const { today } = getTenantTodayRangeUtc(tenantTz);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const max = new Date(Date.UTC(y, m - 1, d + 30));
  return `${max.getUTCFullYear()}-${String(max.getUTCMonth() + 1).padStart(2, "0")}-${String(max.getUTCDate()).padStart(2, "0")}`;
}

export function RescheduleAppointmentSheet({
  appointmentId,
  tenantTimezone,
  serviceCount,
  open,
  onOpenChange,
  onRescheduled,
}: {
  appointmentId: string;
  tenantTimezone: string;
  serviceCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRescheduled: () => void;
}) {
  const t = useTranslations("Account.appointments");
  const tenantToday = getTenantTodayRangeUtc(tenantTimezone).today;
  const [date, setDate] = useState(tenantToday);
  const [slots, setSlots] = useState<string[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Deferred one tick — same pattern as booking-wizard.tsx's own slot
    // fetch effect, to avoid a synchronous setState directly in the
    // effect body.
    const timer = setTimeout(() => {
      setLoadingSlots(true);
      fetchMyRescheduleSlots(appointmentId, date)
        .then((result) => {
          setSlots(result);
          setSelectedTime(null);
        })
        .finally(() => setLoadingSlots(false));
    }, 0);
    return () => clearTimeout(timer);
  }, [open, appointmentId, date]);

  const [state, action, isPending] = useActionState<
    Awaited<ReturnType<typeof rescheduleMyAppointmentAction>> | null,
    { appointmentId: string; newStartAtIso: string }
  >(async (prevState, input) => {
    const result = await rescheduleMyAppointmentAction(prevState, input);
    if (result.success) {
      onOpenChange(false);
      onRescheduled();
    }
    return result;
  }, null);

  function handleConfirm() {
    if (!selectedTime) return;
    const newStartAtIso = tenantLocalToUtcIso(date, selectedTime, tenantTimezone);
    startTransition(() => action({ appointmentId, newStartAtIso }));
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full max-w-sm flex-col">
        <SheetHeader>
          <SheetTitle>{t("rescheduleTitle")}</SheetTitle>
          <SheetDescription>
            {serviceCount > 1 ? t("rescheduleMultiServiceNote", { count: serviceCount }) : t("rescheduleSingleServiceNote")}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reschedule-date">{t("rescheduleDateLabel")}</Label>
            <Input
              id="reschedule-date"
              type="date"
              value={date}
              min={tenantToday}
              max={tenantMaxDateString(tenantTimezone)}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("rescheduleTimeLabel")}</Label>
            {loadingSlots ? (
              <p className="text-muted-foreground text-sm">{t("rescheduleLoadingSlots")}</p>
            ) : slots.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("rescheduleNoSlots")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {slots.map((slot) => (
                  <Button
                    key={slot}
                    type="button"
                    variant={selectedTime === slot ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedTime(slot)}
                  >
                    {slot}
                  </Button>
                ))}
              </div>
            )}
          </div>

          {selectedTime ? (
            <p className="text-sm">
              {t("rescheduleSummary", { date, time: selectedTime })}
            </p>
          ) : null}

          {state && !state.success ? (
            <p className="text-destructive text-sm" role="alert">
              {state.error.message}
            </p>
          ) : null}
        </div>

        <SheetFooter>
          <Button type="button" disabled={!selectedTime || isPending} onClick={handleConfirm}>
            {isPending ? t("rescheduleConfirming") : t("rescheduleConfirmAction")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
