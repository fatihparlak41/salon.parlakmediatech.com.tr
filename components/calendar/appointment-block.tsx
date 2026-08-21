"use client";

import { STATUS_LABELS_TR, type AppointmentStatus } from "@/lib/modules/appointments/status";
import type { CalendarItemRow } from "@/lib/modules/appointments/queries";
import { formatTenantLocalTime } from "@/lib/modules/appointments/timezone";

// Cancelled items are filtered out of every calendar query (see
// getCalendarItems/fetchCalendarItems) — those two keys are kept here
// only so this Record stays exhaustive against AppointmentStatus.
const STATUS_DOT_CLASS: Record<AppointmentStatus, string> = {
  scheduled: "bg-muted-foreground",
  confirmed: "bg-blue-500",
  in_progress: "bg-amber-500",
  completed: "bg-emerald-500",
  cancelled: "bg-destructive",
  no_show: "bg-destructive",
};

/** Shared block content — used by the day-view grid (absolutely
 * positioned by the caller), the week-view day columns, and the mobile
 * agenda. Never relies on color alone for status: "scheduled" (the
 * default, no-special-meaning state) shows no extra label to keep the
 * common case quiet, but every other status — confirmed/in_progress/
 * completed/no_show — prints its Turkish label as visible text next to
 * the dot, not just a color. */
export function AppointmentBlockContent({
  item,
  tenantTimezone,
  itemCountForAppointment,
  showTimeRange = true,
}: {
  item: CalendarItemRow;
  tenantTimezone: string;
  itemCountForAppointment: number;
  showTimeRange?: boolean;
}) {
  const status = item.status as AppointmentStatus;
  const statusLabel = STATUS_LABELS_TR[status] ?? item.status;

  return (
    <div className="flex h-full min-w-0 flex-col gap-0.5 overflow-hidden text-left leading-tight">
      <div className="flex min-w-0 items-center gap-1">
        <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[status] ?? "bg-muted-foreground"}`} aria-hidden="true" />
        <span className="truncate text-[11px] font-medium">{item.customerName}</span>
      </div>
      <span className="text-muted-foreground truncate text-[10px]">
        {item.serviceName}
        {itemCountForAppointment > 1 && ` · ${itemCountForAppointment} hizmet`}
      </span>
      {showTimeRange && (
        <span className="text-muted-foreground truncate text-[10px]">
          {formatTenantLocalTime(item.scheduledStartAt, tenantTimezone)}–{formatTenantLocalTime(item.scheduledEndAt, tenantTimezone)}
        </span>
      )}
      {status !== "scheduled" && <span className="truncate text-[10px] font-medium">{statusLabel}</span>}
    </div>
  );
}
