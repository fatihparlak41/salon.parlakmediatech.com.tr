"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, CalendarClock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { AppointmentListRow, AppointmentListScope } from "@/lib/modules/appointments/queries";
import { APPOINTMENTS_PAGE_SIZE } from "@/lib/modules/appointments/constants";
import { getTenantTodayRangeUtc } from "@/lib/modules/appointments/timezone";
import { APPOINTMENT_STATUSES, STATUS_LABELS_TR } from "@/lib/modules/appointments/status";
import type { BranchOption } from "@/lib/modules/staff/queries";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppointmentList } from "@/components/appointments/appointment-list";
import { CreateAppointmentSheet } from "@/components/appointments/create-appointment-sheet";
import { AppointmentDetailSheet } from "@/components/appointments/appointment-detail-sheet";

type Labels = {
  title: string;
  description: string;
  addAppointment: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyCta: string;
  noResults: string;
  loadMore: string;
  filterUpcoming: string;
  filterToday: string;
  filterAll: string;
  statusFilterAll: string;
};

// Mirrors getAppointmentList's query/mapping exactly (lib/modules/appointments/queries.ts)
// — that module is server-only, so the browser-side list/filter/pagination
// path (same "one query shape for browse and filter" rule as Phase 2C's
// customer search) needs its own copy here, the only client call site.
// Faz 5A.1: staff_members!appointment_items_staff_member_id_fkey is
// required — appointment_items now has three relationships to
// staff_members, so an unqualified embed is ambiguous to PostgREST. Keep
// this in sync with lib/modules/appointments/queries.ts's own
// LIST_SELECT (see its comment for the full explanation).
const LIST_SELECT = `
  id, status, scheduled_start_at, scheduled_end_at,
  customers(full_name),
  branches(name),
  appointment_items(services(name), staff_members!appointment_items_staff_member_id_fkey(full_name))
`;

type RawAppointmentRow = {
  id: string;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  customers: { full_name: string } | null;
  branches: { name: string } | null;
  appointment_items: { services: { name: string } | null; staff_members: { full_name: string } | null }[];
};

function mapListRow(r: RawAppointmentRow): AppointmentListRow {
  return {
    id: r.id,
    status: r.status,
    scheduledStartAt: r.scheduled_start_at,
    scheduledEndAt: r.scheduled_end_at,
    customerName: r.customers?.full_name ?? "—",
    branchName: r.branches?.name ?? "—",
    serviceNames: Array.from(new Set(r.appointment_items.map((i) => i.services?.name).filter((n): n is string => !!n))),
    staffNames: Array.from(new Set(r.appointment_items.map((i) => i.staff_members?.full_name).filter((n): n is string => !!n))),
  };
}

async function fetchAppointments(
  tenantId: string,
  scope: AppointmentListScope,
  statusFilter: string | null,
  offset: number,
  tenantTimezone: string,
): Promise<AppointmentListRow[]> {
  const supabase = createClient();
  let query = supabase
    .from("appointments")
    .select(LIST_SELECT)
    .eq("tenant_id", tenantId)
    .range(offset, offset + APPOINTMENTS_PAGE_SIZE - 1);

  if (scope === "upcoming") {
    query = query.gte("scheduled_start_at", new Date().toISOString()).order("scheduled_start_at", { ascending: true });
  } else if (scope === "today") {
    const range = getTenantTodayRangeUtc(tenantTimezone);
    query = query
      .gte("scheduled_start_at", range.startUtc)
      .lt("scheduled_start_at", range.endUtc)
      .order("scheduled_start_at", { ascending: true });
  } else {
    query = query.order("scheduled_start_at", { ascending: false });
  }

  if (statusFilter) query = query.eq("status", statusFilter);

  const { data, error } = await query;
  if (error || !data) return [];
  return (data as unknown as RawAppointmentRow[]).map(mapListRow);
}

export function AppointmentsPageClient({
  tenantId,
  tenantSlug,
  tenantTimezone,
  branches,
  canCreate,
  canUpdate,
  canCancel,
  initialAppointments,
  labels,
}: {
  tenantId: string;
  tenantSlug: string;
  tenantTimezone: string;
  branches: BranchOption[];
  canCreate: boolean;
  canUpdate: boolean;
  canCancel: boolean;
  initialAppointments: AppointmentListRow[];
  labels: Labels;
}) {
  const [scope, setScope] = useState<AppointmentListScope>("upcoming");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [appointments, setAppointments] = useState(initialAppointments);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(initialAppointments.length === APPOINTMENTS_PAGE_SIZE);
  const [hasAnyEver, setHasAnyEver] = useState<boolean | null>(initialAppointments.length > 0 ? true : null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedAppointmentId, setSelectedAppointmentId] = useState<string | null>(null);

  const isFirstRun = useRef(true);

  // The server component already provided page 1 of the default
  // (upcoming, no filter) view — skip the redundant refetch on mount,
  // same convention as customers-page-client.tsx.
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      const results = await fetchAppointments(tenantId, scope, statusFilter, 0, tenantTimezone);
      setAppointments(results);
      setHasMore(results.length === APPOINTMENTS_PAGE_SIZE);
      setLoading(false);
    }, 150);
    return () => clearTimeout(handle);
  }, [scope, statusFilter, tenantId, tenantTimezone]);

  // Only checked once, lazily — distinguishes "this tenant has zero
  // appointments at all" (show the big empty state) from "zero match
  // the current scope/status filter" (show the plain no-results line).
  useEffect(() => {
    if (hasAnyEver !== null) return;
    const supabase = createClient();
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .then(({ count }) => setHasAnyEver((count ?? 0) > 0));
  }, [hasAnyEver, tenantId]);

  async function refreshList() {
    const results = await fetchAppointments(tenantId, scope, statusFilter, 0, tenantTimezone);
    setAppointments(results);
    setHasMore(results.length === APPOINTMENTS_PAGE_SIZE);
    setHasAnyEver(results.length > 0 ? true : hasAnyEver);
  }

  async function loadMore() {
    setLoading(true);
    const results = await fetchAppointments(tenantId, scope, statusFilter, appointments.length, tenantTimezone);
    setAppointments((prev) => [...prev, ...results]);
    setHasMore(results.length === APPOINTMENTS_PAGE_SIZE);
    setLoading(false);
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{labels.title}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{labels.description}</p>
        </div>
        {canCreate && hasAnyEver && (
          <Button onClick={() => setCreateOpen(true)} className="shrink-0">
            <Plus />
            {labels.addAppointment}
          </Button>
        )}
      </div>

      {hasAnyEver && (
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={scope} onValueChange={(v) => setScope(v as AppointmentListScope)}>
            <TabsList>
              <TabsTrigger value="upcoming">{labels.filterUpcoming}</TabsTrigger>
              <TabsTrigger value="today">{labels.filterToday}</TabsTrigger>
              <TabsTrigger value="all">{labels.filterAll}</TabsTrigger>
            </TabsList>
          </Tabs>

          <Select value={statusFilter ?? "all"} onValueChange={(v) => setStatusFilter(v === "all" ? null : (v as string))}>
            <SelectTrigger className="w-full sm:w-44">
              {/* Base UI's Select.Value shows the raw value string unless
                  given an explicit label-lookup render function. */}
              <SelectValue>
                {(value: string) =>
                  value === "all" ? labels.statusFilterAll : (STATUS_LABELS_TR[value as keyof typeof STATUS_LABELS_TR] ?? value)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{labels.statusFilterAll}</SelectItem>
              {APPOINTMENT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS_TR[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="mt-4">
        {hasAnyEver === false ? (
          <div className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <div className="bg-muted flex size-12 items-center justify-center rounded-full">
              <CalendarClock className="text-muted-foreground size-6" />
            </div>
            <h2 className="text-base font-medium">{labels.emptyTitle}</h2>
            <p className="text-muted-foreground max-w-sm text-sm">{labels.emptyDescription}</p>
            {canCreate && (
              <Button onClick={() => setCreateOpen(true)} className="mt-2">
                <Plus />
                {labels.emptyCta}
              </Button>
            )}
          </div>
        ) : appointments.length === 0 && !loading ? (
          <p className="text-muted-foreground py-10 text-center text-sm">{labels.noResults}</p>
        ) : (
          <>
            <AppointmentList items={appointments} tenantTimezone={tenantTimezone} onSelect={setSelectedAppointmentId} />
            {hasMore && (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" onClick={loadMore} disabled={loading}>
                  {loading ? "…" : labels.loadMore}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {canCreate && (
        <CreateAppointmentSheet
          open={createOpen}
          onOpenChange={setCreateOpen}
          tenantId={tenantId}
          tenantSlug={tenantSlug}
          tenantTimezone={tenantTimezone}
          branches={branches}
          onCreated={async (id) => {
            setCreateOpen(false);
            await refreshList();
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
        onSaved={refreshList}
      />
    </div>
  );
}
