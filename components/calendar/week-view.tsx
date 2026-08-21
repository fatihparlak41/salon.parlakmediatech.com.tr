"use client";

import { useMemo } from "react";
import type { CalendarItemRow } from "@/lib/modules/appointments/queries";
import { utcIsoToTenantLocalParts } from "@/lib/modules/appointments/timezone";
import { AppointmentBlockContent } from "@/components/calendar/appointment-block";

const WEEKDAY_LABELS_TR = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"]; // days[] is always Monday-first

/** 7 day columns for ONE selected staff member (a chronological stacked
 * list per day, not a full vertical time-grid) — the "all staff × 7
 * days" mega-grid this deliberately avoids is unusable on an ordinary
 * screen; a single staff member's week is the operationally common
 * question ("what does Ayşe have this week") and stays readable at any
 * width. See the Phase 2E report for the full rationale. */
export function WeekView({
  days,
  tenantTimezone,
  items,
  appointmentItemCounts,
  todayDateStr,
  onItemClick,
  onDayHeaderClick,
}: {
  days: string[];
  tenantTimezone: string;
  items: CalendarItemRow[];
  /** Multi-service ("N hizmet") counts, keyed by appointment_id — MUST be
   * computed by the caller from the full (unfiltered-by-staff) range
   * dataset. Week view is always filtered to a single staff member, so
   * a count derived only from `items` here would almost always show 1
   * even for a genuine multi-service appointment whose other item
   * belongs to a different staff member. See CalendarPageClient. */
  appointmentItemCounts: Map<string, number>;
  todayDateStr: string;
  onItemClick: (appointmentId: string) => void;
  onDayHeaderClick: (dateStr: string) => void;
}) {
  const itemsByDay = useMemo(() => {
    const map = new Map<string, CalendarItemRow[]>();
    for (const item of items) {
      const localDate = utcIsoToTenantLocalParts(item.scheduledStartAt, tenantTimezone).date;
      const list = map.get(localDate) ?? [];
      list.push(item);
      map.set(localDate, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.scheduledStartAt.localeCompare(b.scheduledStartAt));
    return map;
  }, [items, tenantTimezone]);

  return (
    <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
      {days.map((dateStr, index) => {
        const dayItems = itemsByDay.get(dateStr) ?? [];
        const isToday = dateStr === todayDateStr;
        const [, m, d] = dateStr.split("-") as [string, string, string];
        return (
          <div key={dateStr} className="flex min-w-0 flex-col gap-1.5">
            <button
              type="button"
              onClick={() => onDayHeaderClick(dateStr)}
              className={`hover:bg-muted/50 flex flex-col items-center rounded-lg border px-1 py-1.5 text-center focus-visible:outline-none ${isToday ? "border-primary bg-primary/5" : ""}`}
            >
              <span className="text-muted-foreground text-[10px] font-medium">{WEEKDAY_LABELS_TR[index]}</span>
              <span className="text-xs font-semibold tabular-nums">
                {d}.{m}
              </span>
            </button>
            <div className="flex flex-col gap-1">
              {dayItems.length === 0 ? (
                <p className="text-muted-foreground px-1 text-[10px]">—</p>
              ) : (
                dayItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onItemClick(item.appointmentId)}
                    className="border-primary/40 bg-primary/10 hover:bg-primary/15 focus-visible:ring-ring rounded-md border p-1 text-left focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <AppointmentBlockContent
                      item={item}
                      tenantTimezone={tenantTimezone}
                      itemCountForAppointment={appointmentItemCounts.get(item.appointmentId) ?? 1}
                    />
                  </button>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
