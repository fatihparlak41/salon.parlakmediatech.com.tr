"use client";

import { startTransition, useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { cancelMyAppointmentAction } from "@/lib/modules/customer-account/actions";
import type { MyAppointment } from "@/lib/modules/customer-account/queries";
import { RescheduleAppointmentSheet } from "@/components/customer-account/reschedule-appointment-sheet";
import { formatTenantLocalDateTime } from "@/lib/modules/appointments/timezone";
import { STATUS_LABELS_TR, type AppointmentStatus } from "@/lib/modules/appointments/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import type { ActionResult } from "@/lib/errors";

function CancelAppointmentDialog({
  appointmentId,
  open,
  onOpenChange,
  onCancelled,
}: {
  appointmentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancelled: () => void;
}) {
  const t = useTranslations("Account.appointments");
  const [state, action, isPending] = useActionState<
    ActionResult<{ appointmentId: string; status: string }> | null,
    string
  >(async (prevState, id) => {
    const result = await cancelMyAppointmentAction(prevState, id);
    if (result.success) {
      onOpenChange(false);
      onCancelled();
    }
    return result;
  }, null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("cancelConfirmTitle")}</DialogTitle>
          <DialogDescription>{t("cancelConfirmDescription")}</DialogDescription>
        </DialogHeader>
        {state && !state.success ? (
          <p className="text-destructive text-sm" role="alert">
            {state.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={isPending} />}>
            {t("cancelConfirmDismiss")}
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={isPending}
            onClick={() => startTransition(() => action(appointmentId))}
          >
            {isPending ? t("cancelling") : t("cancelConfirmAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AppointmentsList({ appointments }: { appointments: MyAppointment[] }) {
  const t = useTranslations("Account.appointments");
  const [dialogFor, setDialogFor] = useState<string | null>(null);
  const [rescheduleFor, setRescheduleFor] = useState<string | null>(null);

  if (appointments.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("emptyDescription")}</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {appointments.map((a) => (
        <li key={a.appointmentId} className="flex flex-col gap-2 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{a.tenantName}</span>
            <Badge variant="secondary">{STATUS_LABELS_TR[a.status as AppointmentStatus] ?? a.status}</Badge>
          </div>
          <p className="text-muted-foreground text-sm">{a.branchName}</p>
          <p className="text-sm">{formatTenantLocalDateTime(a.scheduledStartAt, a.tenantTimezone)}</p>
          <ul className="text-muted-foreground flex flex-col gap-0.5 text-sm">
            {a.services.map((s, i) => (
              <li key={i}>
                {s.serviceName} — {s.staffName} ({s.durationMinutes} {t("minutesShort")}, {s.price} ₺)
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {a.canReschedule ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => setRescheduleFor(a.appointmentId)}
              >
                {t("rescheduleAction")}
              </Button>
            ) : null}
            {a.canCancel ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="w-fit"
                onClick={() => setDialogFor(a.appointmentId)}
              >
                {t("cancelAction")}
              </Button>
            ) : null}
          </div>
          {dialogFor === a.appointmentId ? (
            <CancelAppointmentDialog
              appointmentId={a.appointmentId}
              open={dialogFor === a.appointmentId}
              onOpenChange={(open) => setDialogFor(open ? a.appointmentId : null)}
              onCancelled={() => setDialogFor(null)}
            />
          ) : null}
          {rescheduleFor === a.appointmentId ? (
            <RescheduleAppointmentSheet
              appointmentId={a.appointmentId}
              tenantTimezone={a.tenantTimezone}
              serviceCount={a.services.length}
              open={rescheduleFor === a.appointmentId}
              onOpenChange={(open) => setRescheduleFor(open ? a.appointmentId : null)}
              onRescheduled={() => setRescheduleFor(null)}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
