"use client";

import type { AppointmentListRow } from "@/lib/modules/appointments/queries";
import { formatTenantLocalDateTime, formatTenantLocalTime } from "@/lib/modules/appointments/timezone";
import { STATUS_LABELS_TR, type AppointmentStatus } from "@/lib/modules/appointments/status";
import { Badge } from "@/components/ui/badge";

const STATUS_BADGE_VARIANT: Record<AppointmentStatus, "default" | "secondary" | "destructive" | "outline"> = {
  scheduled: "outline",
  confirmed: "default",
  in_progress: "default",
  completed: "secondary",
  cancelled: "destructive",
  no_show: "destructive",
};

function sameLocalDay(startIso: string, endIso: string, tz: string): boolean {
  const start = formatTenantLocalDateTime(startIso, tz).slice(0, 10);
  const end = formatTenantLocalDateTime(endIso, tz).slice(0, 10);
  return start === end;
}

export function AppointmentList({
  items,
  tenantTimezone,
  onSelect,
}: {
  items: AppointmentListRow[];
  tenantTimezone: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="border-border divide-border overflow-hidden rounded-xl border">
      {items.map((appt) => (
        <li key={appt.id}>
          <button
            type="button"
            onClick={() => onSelect(appt.id)}
            className="hover:bg-muted/50 flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors focus-visible:bg-muted/50 focus-visible:outline-none sm:flex-row sm:items-center sm:justify-between sm:gap-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  {sameLocalDay(appt.scheduledStartAt, appt.scheduledEndAt, tenantTimezone)
                    ? `${formatTenantLocalDateTime(appt.scheduledStartAt, tenantTimezone)}–${formatTenantLocalTime(appt.scheduledEndAt, tenantTimezone)}`
                    : `${formatTenantLocalDateTime(appt.scheduledStartAt, tenantTimezone)} → ${formatTenantLocalDateTime(appt.scheduledEndAt, tenantTimezone)}`}
                </span>
                <Badge variant={STATUS_BADGE_VARIANT[appt.status as AppointmentStatus] ?? "outline"}>
                  {STATUS_LABELS_TR[appt.status as AppointmentStatus] ?? appt.status}
                </Badge>
              </div>
              <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <span className="font-medium text-foreground/80">{appt.customerName}</span>
                <span>·</span>
                <span>{appt.branchName}</span>
                {appt.serviceNames.length > 0 && (
                  <>
                    <span>·</span>
                    <span>{appt.serviceNames.join(", ")}</span>
                  </>
                )}
              </div>
            </div>
            {appt.staffNames.length > 0 && (
              <div className="text-muted-foreground shrink-0 text-xs sm:text-right">
                {appt.staffNames.join(", ")}
              </div>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
