"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { BranchOption } from "@/lib/modules/staff/queries";
import type { CalendarItemRow, CalendarStaffOption } from "@/lib/modules/appointments/queries";
import { fetchCalendarItems, fetchBranchStaff } from "@/lib/modules/appointments/client-queries";
import { getTenantDayRangeUtc, getTenantWeekRangeUtc, getTenantTodayRangeUtc } from "@/lib/modules/appointments/timezone";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DayView } from "@/components/calendar/day-view";
import { WeekView } from "@/components/calendar/week-view";
import { MobileDayAgenda } from "@/components/calendar/mobile-day-agenda";
import { StaffFilter } from "@/components/calendar/staff-filter";
import { CreateAppointmentSheet } from "@/components/appointments/create-appointment-sheet";
import { AppointmentDetailSheet } from "@/components/appointments/appointment-detail-sheet";

type ViewMode = "day" | "week";

type Labels = {
  title: string;
  description: string;
  addAppointment: string;
  today: string;
  dayView: string;
  weekView: string;
  noBranchStaff: string;
  noItems: string;
  selectBranch: string;
  selectStaffForWeek: string;
  noBranches: string;
};

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function formatHeaderDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.${y}`;
}

export function CalendarPageClient({
  tenantId,
  tenantSlug,
  tenantTimezone,
  branches,
  initialBranchId,
  initialDate,
  initialStaff,
  initialItems,
  canCreate,
  canUpdate,
  canCancel,
  labels,
}: {
  tenantId: string;
  tenantSlug: string;
  tenantTimezone: string;
  branches: BranchOption[];
  initialBranchId: string;
  initialDate: string;
  initialStaff: CalendarStaffOption[];
  initialItems: CalendarItemRow[];
  canCreate: boolean;
  canUpdate: boolean;
  canCancel: boolean;
  labels: Labels;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("day");
  const [branchId, setBranchId] = useState(initialBranchId);
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [branchStaff, setBranchStaff] = useState<CalendarStaffOption[]>(initialStaff);
  const [itemsRaw, setItemsRaw] = useState<CalendarItemRow[]>(initialItems);
  const [loading, setLoading] = useState(false);
  const [selectedStaffIds, setSelectedStaffIds] = useState<Set<string>>(() => new Set(initialStaff.map((s) => s.id)));
  const [weekStaffId, setWeekStaffId] = useState<string>(initialStaff[0]?.id ?? "");
  const [createOpen, setCreateOpen] = useState(false);
  const [createInitial, setCreateInitial] = useState<{ staffMemberId?: string; startTime?: string }>({});
  const [selectedAppointmentId, setSelectedAppointmentId] = useState<string | null>(null);

  const isFirstRun = useRef(true);

  const todayDateStr = useMemo(() => getTenantTodayRangeUtc(tenantTimezone).today, [tenantTimezone]);
  const weekInfo = useMemo(
    () => (viewMode === "week" ? getTenantWeekRangeUtc(tenantTimezone, selectedDate) : null),
    [viewMode, selectedDate, tenantTimezone],
  );

  async function refresh(nextBranchId: string, nextDate: string, nextViewMode: ViewMode) {
    if (!nextBranchId) return null;
    setLoading(true);
    const range =
      nextViewMode === "day" ? getTenantDayRangeUtc(tenantTimezone, nextDate) : getTenantWeekRangeUtc(tenantTimezone, nextDate);
    const [items, staff] = await Promise.all([
      fetchCalendarItems(tenantId, nextBranchId, range.startUtc, range.endUtc),
      fetchBranchStaff(tenantId, nextBranchId),
    ]);
    setItemsRaw(items);
    setBranchStaff(staff);
    setLoading(false);
    return staff;
  }

  // The server component already provided the initial (branchId, date,
  // "day" view) range — skip the redundant refetch on mount, same
  // convention as every other page-client in this codebase.
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    refresh(branchId, selectedDate, viewMode).then((staff) => {
      if (!staff) return;
      setSelectedStaffIds(new Set(staff.map((s) => s.id)));
      setWeekStaffId((prev) => (staff.some((s) => s.id === prev) ? prev : (staff[0]?.id ?? "")));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is stable in shape (closes over tenantId/tenantTimezone only), re-deriving it every render would defeat the isFirstRun skip
  }, [branchId, selectedDate, viewMode]);

  async function refreshCurrentRange() {
    await refresh(branchId, selectedDate, viewMode);
  }

  function goPrev() {
    setSelectedDate((d) => addDays(d, viewMode === "day" ? -1 : -7));
  }
  function goNext() {
    setSelectedDate((d) => addDays(d, viewMode === "day" ? 1 : 7));
  }
  function goToday() {
    setSelectedDate(todayDateStr);
  }

  function openCreate(initial: { staffMemberId?: string; startTime?: string }) {
    setCreateInitial(initial);
    setCreateOpen(true);
  }

  const dayViewStaff = useMemo(() => branchStaff.filter((s) => selectedStaffIds.has(s.id)), [branchStaff, selectedStaffIds]);
  const dayViewItems = useMemo(() => itemsRaw.filter((i) => selectedStaffIds.has(i.staffMemberId)), [itemsRaw, selectedStaffIds]);
  const weekViewItems = useMemo(() => itemsRaw.filter((i) => i.staffMemberId === weekStaffId), [itemsRaw, weekStaffId]);

  // Multi-service ("N hizmet") counts computed from the FULL range
  // dataset, never from a staff-filtered subset: a multi-service
  // appointment's items can belong to different staff members (the
  // whole point of Phase 2E's item model), so counting only what's
  // currently visible under a narrowed day-view staff filter — or
  // week-view's always-single-staff filter — would silently undercount.
  const appointmentItemCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of itemsRaw) counts.set(item.appointmentId, (counts.get(item.appointmentId) ?? 0) + 1);
    return counts;
  }, [itemsRaw]);

  if (branches.length === 0) {
    return <p className="text-muted-foreground py-16 text-center text-sm">{labels.noBranches}</p>;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{labels.title}</h1>
        <p className="text-muted-foreground text-sm">{labels.description}</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon-sm" onClick={goPrev} aria-label="Önceki">
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="sm" onClick={goToday}>
            {labels.today}
          </Button>
          <Button variant="outline" size="icon-sm" onClick={goNext} aria-label="Sonraki">
            <ChevronRight />
          </Button>
          <span className="text-sm font-medium tabular-nums">
            {viewMode === "day"
              ? formatHeaderDate(selectedDate)
              : weekInfo && `${formatHeaderDate(weekInfo.days[0]!)} – ${formatHeaderDate(weekInfo.days[6]!)}`}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
            <TabsList>
              <TabsTrigger value="day">{labels.dayView}</TabsTrigger>
              <TabsTrigger value="week">{labels.weekView}</TabsTrigger>
            </TabsList>
          </Tabs>

          {branches.length > 1 && (
            <Select value={branchId} onValueChange={(v) => setBranchId(v as string)}>
              <SelectTrigger className="w-40">
                {/* Base UI's Select.Value shows the raw value string
                    unless given an explicit label-lookup render function. */}
                <SelectValue placeholder={labels.selectBranch}>
                  {(value: string) => branches.find((b) => b.id === value)?.name ?? labels.selectBranch}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {viewMode === "day" && branchStaff.length > 0 && (
            <StaffFilter staff={branchStaff} selectedIds={selectedStaffIds} onChange={setSelectedStaffIds} />
          )}

          {viewMode === "week" && branchStaff.length > 0 && (
            // Keyed on the value: weekStaffId can change programmatically
            // (branch switch resets it outside this Select's own
            // interaction) — see the identical, directly-confirmed Base
            // UI Select desync in appointment-items-editor.tsx.
            <Select key={weekStaffId} value={weekStaffId || undefined} onValueChange={(v) => setWeekStaffId(v as string)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder={labels.selectStaffForWeek}>
                  {(value: string) => branchStaff.find((s) => s.id === value)?.fullName ?? labels.selectStaffForWeek}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {branchStaff.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {canCreate && (
            <Button size="sm" onClick={() => openCreate({})}>
              <Plus />
              {labels.addAppointment}
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-muted-foreground py-16 text-center text-sm">…</p>
      ) : viewMode === "day" ? (
        <>
          <div className="hidden md:block">
            <DayView
              dateStr={selectedDate}
              tenantTimezone={tenantTimezone}
              staff={dayViewStaff}
              items={dayViewItems}
              appointmentItemCounts={appointmentItemCounts}
              isToday={selectedDate === todayDateStr}
              canCreate={canCreate}
              onItemClick={setSelectedAppointmentId}
              onEmptySlotClick={(staffMemberId, startTime) => openCreate({ staffMemberId, startTime })}
              emptyStaffMessage={labels.noBranchStaff}
            />
          </div>
          <div className="md:hidden">
            <MobileDayAgenda
              tenantTimezone={tenantTimezone}
              items={dayViewItems}
              appointmentItemCounts={appointmentItemCounts}
              onItemClick={setSelectedAppointmentId}
              emptyMessage={labels.noItems}
            />
          </div>
        </>
      ) : (
        weekInfo &&
        (branchStaff.length === 0 ? (
          <p className="text-muted-foreground py-16 text-center text-sm">{labels.noBranchStaff}</p>
        ) : (
          <WeekView
            days={weekInfo.days}
            tenantTimezone={tenantTimezone}
            items={weekViewItems}
            appointmentItemCounts={appointmentItemCounts}
            todayDateStr={todayDateStr}
            onItemClick={setSelectedAppointmentId}
            onDayHeaderClick={(dateStr) => {
              setSelectedDate(dateStr);
              setViewMode("day");
            }}
          />
        ))
      )}

      {canCreate && (
        <CreateAppointmentSheet
          open={createOpen}
          onOpenChange={setCreateOpen}
          tenantId={tenantId}
          tenantSlug={tenantSlug}
          tenantTimezone={tenantTimezone}
          branches={branches}
          initialBranchId={branchId}
          initialStaffMemberId={createInitial.staffMemberId}
          initialDate={selectedDate}
          initialStartTime={createInitial.startTime}
          onCreated={async (id) => {
            setCreateOpen(false);
            await refreshCurrentRange();
            setSelectedAppointmentId(id);
          }}
        />
      )}

      <AppointmentDetailSheet
        appointmentId={selectedAppointmentId}
        onOpenChange={(open) => {
          if (!open) setSelectedAppointmentId(null);
        }}
        tenantId={tenantId}
        tenantSlug={tenantSlug}
        tenantTimezone={tenantTimezone}
        canUpdate={canUpdate}
        canCancel={canCancel}
        onSaved={refreshCurrentRange}
      />
    </div>
  );
}
