"use client";

import { useMemo } from "react";
import type { CalendarItemRow, CalendarStaffOption } from "@/lib/modules/appointments/queries";
import { utcIsoToTenantLocalParts, getTenantNowLocalParts } from "@/lib/modules/appointments/timezone";
import { AppointmentBlockContent } from "@/components/calendar/appointment-block";

const PX_PER_MINUTE = 1.5;
// Broad documented fallback (not a real working-hours derivation — see
// Phase 2E report) — appointments outside this range are never dropped,
// only ever widen the grid for that day (see gridStartMin/gridEndMin below).
const DEFAULT_START_MIN = 7 * 60;
const DEFAULT_END_MIN = 23 * 60;
const SLOT_MINUTES = 30; // empty-slot click granularity — purely a UI grid reference, never quantizes stored times
const MIN_BLOCK_MINUTES = 20; // visual floor only, never alters the real stored duration

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

function minutesToTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

type PositionedItem = { item: CalendarItemRow; startMin: number; endMin: number; lane: number; laneCount: number };

/** Greedy interval-graph-coloring lane assignment — renders any number
 * of items that visually overlap for the SAME staff member side by
 * side. Before Phase 2I.2B (staff_members.concurrent_capacity) this only
 * ever mattered for exceptional/historical data, since the DB exclusion
 * constraint made an active overlap essentially impossible; a staff
 * member with capacity > 1 now overlaps by design, and this same
 * general-purpose packing logic handles it with no further changes. */
function layoutStaffColumn(items: CalendarItemRow[], tenantTimezone: string): PositionedItem[] {
  const withTimes = items
    .map((item) => {
      const start = timeToMinutes(utcIsoToTenantLocalParts(item.scheduledStartAt, tenantTimezone).time);
      let end = timeToMinutes(utcIsoToTenantLocalParts(item.scheduledEndAt, tenantTimezone).time);
      if (end <= start) end = 24 * 60; // rare midnight-spanning edge case: clamp visually to end of day
      return { item, startMin: start, endMin: end };
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const laneEndTimes: number[] = [];
  const withLanes = withTimes.map(({ item, startMin, endMin }) => {
    let lane = laneEndTimes.findIndex((end) => end <= startMin);
    if (lane === -1) {
      lane = laneEndTimes.length;
      laneEndTimes.push(endMin);
    } else {
      laneEndTimes[lane] = endMin;
    }
    return { item, startMin, endMin, lane };
  });

  const laneCount = Math.max(1, laneEndTimes.length);
  return withLanes.map((w) => ({ ...w, laneCount }));
}

export function DayView({
  dateStr,
  tenantTimezone,
  staff,
  items,
  appointmentItemCounts,
  isToday,
  canCreate,
  onItemClick,
  onEmptySlotClick,
  emptyStaffMessage,
}: {
  dateStr: string;
  tenantTimezone: string;
  staff: CalendarStaffOption[];
  items: CalendarItemRow[];
  /** Multi-service ("N hizmet") counts, keyed by appointment_id — must be
   * computed by the caller from the full range dataset, never from this
   * component's own (possibly staff-filtered) `items`: a multi-service
   * appointment's items can belong to DIFFERENT staff members, so
   * counting only what's currently visible under a narrowed staff
   * filter would silently undercount. See CalendarPageClient. */
  appointmentItemCounts: Map<string, number>;
  isToday: boolean;
  /** When false (view-only permission), the empty-slot "create
   * appointment" buttons are not rendered at all — a view-only user
   * must never be offered a click/keyboard-focusable affordance whose
   * label promises an action ("... için ... saatinde randevu
   * oluştur") that then silently does nothing, since the create sheet
   * itself isn't even mounted by the caller in that case. */
  canCreate: boolean;
  onItemClick: (appointmentId: string) => void;
  onEmptySlotClick: (staffMemberId: string, startTime: string) => void;
  emptyStaffMessage: string;
}) {
  const itemsByStaff = useMemo(() => {
    const map = new Map<string, CalendarItemRow[]>();
    for (const item of items) {
      const list = map.get(item.staffMemberId) ?? [];
      list.push(item);
      map.set(item.staffMemberId, list);
    }
    return map;
  }, [items]);

  const { gridStartMin, gridEndMin } = useMemo(() => {
    let start = DEFAULT_START_MIN;
    let end = DEFAULT_END_MIN;
    for (const item of items) {
      const s = timeToMinutes(utcIsoToTenantLocalParts(item.scheduledStartAt, tenantTimezone).time);
      let e = timeToMinutes(utcIsoToTenantLocalParts(item.scheduledEndAt, tenantTimezone).time);
      if (e <= s) e = 24 * 60;
      if (s < start) start = Math.floor(s / 60) * 60;
      if (e > end) end = Math.ceil(e / 60) * 60;
    }
    return { gridStartMin: start, gridEndMin: end };
  }, [items, tenantTimezone]);

  const totalMinutes = gridEndMin - gridStartMin;
  const gridHeightPx = totalMinutes * PX_PER_MINUTE;

  const hourMarks: number[] = [];
  for (let h = Math.ceil(gridStartMin / 60); h <= Math.floor(gridEndMin / 60); h++) hourMarks.push(h * 60);

  const slotStarts: number[] = [];
  for (let m = gridStartMin; m < gridEndMin; m += SLOT_MINUTES) slotStarts.push(m);

  const nowParts = isToday ? getTenantNowLocalParts(tenantTimezone) : null;
  const showNowLine = !!nowParts && nowParts.date === dateStr && nowParts.minutesSinceMidnight >= gridStartMin && nowParts.minutesSinceMidnight <= gridEndMin;

  if (staff.length === 0) {
    return <p className="text-muted-foreground py-10 text-center text-sm">{emptyStaffMessage}</p>;
  }

  return (
    <div className="flex overflow-x-auto rounded-xl border">
      <div className="bg-background sticky left-0 z-20 w-14 shrink-0 border-r">
        <div className="h-10 border-b" />
        <div className="relative" style={{ height: gridHeightPx }}>
          {hourMarks.map((min) => (
            <div
              key={min}
              className="text-muted-foreground absolute right-1.5 -translate-y-1/2 text-[11px] tabular-nums"
              style={{ top: (min - gridStartMin) * PX_PER_MINUTE }}
            >
              {minutesToTime(min)}
            </div>
          ))}
        </div>
      </div>

      {staff.map((s) => {
        const positioned = layoutStaffColumn(itemsByStaff.get(s.id) ?? [], tenantTimezone);
        return (
          <div key={s.id} className="w-40 shrink-0 border-r last:border-r-0">
            <div className="text-foreground/90 flex h-10 items-center justify-center border-b px-2 text-center text-xs font-medium">
              <span className="truncate">{s.fullName}</span>
            </div>
            <div className="relative" style={{ height: gridHeightPx }}>
              {hourMarks.map((min) => (
                <div key={min} className="border-border/60 absolute inset-x-0 border-t" style={{ top: (min - gridStartMin) * PX_PER_MINUTE }} />
              ))}

              {canCreate &&
                slotStarts.map((min) => (
                  <button
                    key={min}
                    type="button"
                    onClick={() => onEmptySlotClick(s.id, minutesToTime(min))}
                    className="hover:bg-muted/40 focus-visible:bg-muted/40 absolute inset-x-0 focus-visible:outline-none"
                    style={{ top: (min - gridStartMin) * PX_PER_MINUTE, height: SLOT_MINUTES * PX_PER_MINUTE }}
                    aria-label={`${s.fullName} için ${minutesToTime(min)} saatinde randevu oluştur`}
                  />
                ))}

              {showNowLine && (
                <div
                  className="bg-destructive pointer-events-none absolute inset-x-0 z-10 h-px"
                  style={{ top: (nowParts!.minutesSinceMidnight - gridStartMin) * PX_PER_MINUTE }}
                  aria-hidden="true"
                />
              )}

              {positioned.map(({ item, startMin, endMin, lane, laneCount }) => {
                const heightMin = Math.max(endMin - startMin, MIN_BLOCK_MINUTES);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onItemClick(item.appointmentId)}
                    className="border-primary/40 bg-primary/10 hover:bg-primary/15 focus-visible:ring-ring absolute z-10 overflow-hidden rounded-md border p-1 focus-visible:ring-2 focus-visible:outline-none"
                    style={{
                      top: (startMin - gridStartMin) * PX_PER_MINUTE,
                      height: heightMin * PX_PER_MINUTE,
                      left: `${(lane / laneCount) * 100}%`,
                      width: `${(1 / laneCount) * 100}%`,
                    }}
                  >
                    <AppointmentBlockContent
                      item={item}
                      tenantTimezone={tenantTimezone}
                      itemCountForAppointment={appointmentItemCounts.get(item.appointmentId) ?? 1}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
