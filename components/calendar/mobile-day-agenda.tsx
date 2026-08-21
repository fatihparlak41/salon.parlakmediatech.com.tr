"use client";

import type { CalendarItemRow } from "@/lib/modules/appointments/queries";
import { AppointmentBlockContent } from "@/components/calendar/appointment-block";

/** Mobile fallback for Day view — squeezing desktop staff columns into
 * 375px is unreadable, so mobile gets a single chronological agenda
 * across all staff for the selected day instead, with the staff name
 * shown inline per row since there's no column to imply it. */
export function MobileDayAgenda({
  tenantTimezone,
  items,
  appointmentItemCounts,
  onItemClick,
  emptyMessage,
}: {
  tenantTimezone: string;
  items: CalendarItemRow[];
  /** Multi-service ("N hizmet") counts, keyed by appointment_id —
   * computed by the caller from the full range dataset (see
   * CalendarPageClient), not from this component's own `items`, so a
   * narrowed staff filter never makes a genuine multi-service
   * appointment undercount. */
  appointmentItemCounts: Map<string, number>;
  onItemClick: (appointmentId: string) => void;
  emptyMessage: string;
}) {
  if (items.length === 0) {
    return <p className="text-muted-foreground py-10 text-center text-sm">{emptyMessage}</p>;
  }

  return (
    <ul className="divide-border overflow-hidden rounded-xl border">
      {items.map((item, index) => (
        <li key={item.id} className={index > 0 ? "border-border border-t" : ""}>
          <button
            type="button"
            onClick={() => onItemClick(item.appointmentId)}
            className="hover:bg-muted/50 focus-visible:bg-muted/50 flex w-full items-center gap-3 px-3 py-2.5 text-left focus-visible:outline-none"
          >
            <div className="min-w-0 flex-1">
              <AppointmentBlockContent
                item={item}
                tenantTimezone={tenantTimezone}
                itemCountForAppointment={appointmentItemCounts.get(item.appointmentId) ?? 1}
              />
            </div>
            <span className="text-muted-foreground shrink-0 text-xs">{item.staffMemberFullName}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
