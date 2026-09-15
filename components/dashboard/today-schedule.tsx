"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Link } from "@/lib/i18n/navigation";
import { formatTenantLocalTime } from "@/lib/modules/appointments/timezone";
import {
  STATUS_LABELS_TR,
  type AppointmentStatus,
} from "@/lib/modules/appointments/status";
import type { DashboardTodayAppointment } from "@/lib/modules/dashboard/queries";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AppointmentDetailSheet } from "@/components/appointments/appointment-detail-sheet";

// Same mapping as components/appointments/appointment-list.tsx — kept as
// a small local literal rather than importing (that module doesn't
// export it), not a second source of truth for status semantics itself
// (STATUS_LABELS_TR, the actual meaning, is still imported). Status
// labels themselves are this app's one existing exception to the
// next-intl convention (lib/modules/appointments/status.ts hardcodes
// them directly) — matched here as-is, not reintroduced through
// messages/tr.json.
const STATUS_BADGE_VARIANT: Record<
  AppointmentStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  scheduled: "outline",
  confirmed: "default",
  in_progress: "default",
  completed: "secondary",
  cancelled: "destructive",
  no_show: "destructive",
};

function StatusBadge({ status }: { status: string }) {
  const s = status as AppointmentStatus;
  return (
    <Badge variant={STATUS_BADGE_VARIANT[s] ?? "outline"}>
      {STATUS_LABELS_TR[s] ?? status}
    </Badge>
  );
}

export type TodayScheduleLabels = {
  nextTitle: string;
  nowTitle: string;
  title: string;
  description: string;
  viewAll: string;
  empty: string;
};

/**
 * Faz DASHBOARD.1A — the highlight cards ("Şu an"/"Sıradaki") and the
 * full list ("Bugünün Takvimi") need to sit in different visual
 * positions on mobile (highlight before Hızlı İşlemler, the list after
 * it) vs desktop (both stacked together in the wide left column) — see
 * app/[locale]/app/[tenantSlug]/page.tsx's own layout comment. Splitting
 * them into two components lets the page interleave Hızlı İşlemler
 * between them per breakpoint without duplicating either one; this
 * context is only how those two still share ONE click-to-open-detail
 * state and ONE mounted AppointmentDetailSheet, exactly as the single
 * combined component did before the split.
 */
const SelectAppointmentContext = createContext<((id: string) => void) | null>(
  null,
);

function useSelectAppointment(): (id: string) => void {
  const ctx = useContext(SelectAppointmentContext);
  if (!ctx)
    throw new Error(
      "NextAppointmentHighlight/TodayScheduleList must be rendered inside a TodayScheduleProvider",
    );
  return ctx;
}

/** Wraps NextAppointmentHighlight + TodayScheduleList (rendered as
 * children, possibly with other content — e.g. Hızlı İşlemler —
 * physically between them) and owns the one shared selectedId state +
 * the one AppointmentDetailSheet both open. */
export function TodayScheduleProvider({
  tenantId,
  tenantSlug,
  tenantTimezone,
  canUpdate,
  canCancel,
  children,
}: {
  tenantId: string;
  tenantSlug: string;
  tenantTimezone: string;
  canUpdate: boolean;
  canCancel: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <SelectAppointmentContext.Provider value={setSelectedId}>
      {children}
      <AppointmentDetailSheet
        appointmentId={selectedId}
        onOpenChange={(open) => !open && setSelectedId(null)}
        tenantId={tenantId}
        tenantSlug={tenantSlug}
        tenantTimezone={tenantTimezone}
        canUpdate={canUpdate}
        canCancel={canCancel}
        onSaved={() => router.refresh()}
      />
    </SelectAppointmentContext.Provider>
  );
}

function HighlightCard({
  label,
  appointment,
  tenantTimezone,
  onSelect,
}: {
  label: string;
  appointment: DashboardTodayAppointment;
  tenantTimezone: string;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <button
          type="button"
          onClick={() => onSelect(appointment.id)}
          className="flex w-full items-baseline gap-3 text-left"
        >
          <span className="font-heading text-2xl font-semibold tabular-nums">
            {formatTenantLocalTime(
              appointment.scheduledStartAt,
              tenantTimezone,
            )}
          </span>
          <span className="min-w-0 truncate text-sm">
            <span className="font-medium">{appointment.customerName}</span>
            {appointment.serviceNames.length > 0 && (
              <span className="text-muted-foreground">
                {" "}
                · {appointment.serviceNames.join(", ")}
              </span>
            )}
            {appointment.staff.length > 0 && (
              <span className="text-muted-foreground">
                {" "}
                · {appointment.staff.map((s) => s.fullName).join(", ")}
              </span>
            )}
          </span>
        </button>
      </CardContent>
    </Card>
  );
}

/**
 * "Şu an" (in_progress, if any) + "Sıradaki" (the next upcoming
 * scheduled/confirmed appointment, if any) — both selected by
 * lib/modules/dashboard/queries.ts's selectNextAppointment, computed
 * once by the caller and passed in here as plain props (this is a "use
 * client" component; that module carries `import "server-only"`, so it
 * cannot be imported here — see this file's git history for the build
 * error that caught this the first time). Renders nothing when neither
 * exists.
 */
export function NextAppointmentHighlight({
  inProgress,
  next,
  tenantTimezone,
  labels,
}: {
  inProgress: DashboardTodayAppointment | null;
  next: DashboardTodayAppointment | null;
  tenantTimezone: string;
  labels: Pick<TodayScheduleLabels, "nextTitle" | "nowTitle">;
}) {
  const onSelect = useSelectAppointment();
  if (!inProgress && !next) return null;
  return (
    <>
      {inProgress && (
        <HighlightCard
          label={labels.nowTitle}
          appointment={inProgress}
          tenantTimezone={tenantTimezone}
          onSelect={onSelect}
        />
      )}
      {next && (
        <HighlightCard
          label={labels.nextTitle}
          appointment={next}
          tenantTimezone={tenantTimezone}
          onSelect={onSelect}
        />
      )}
    </>
  );
}

/** "Bugünün Takvimi" — the full (capped) list. Reuses the existing,
 * only detail system in this app (AppointmentDetailSheet, local-state-
 * driven via TodayScheduleProvider — there is no `?appointment=` URL
 * convention anywhere in this codebase to reuse instead) rather than
 * inventing a second one. */
export function TodayScheduleList({
  items,
  tenantTimezone,
  viewAllHref,
  labels,
  maxVisible = 8,
}: {
  items: DashboardTodayAppointment[];
  tenantTimezone: string;
  viewAllHref: string;
  labels: Pick<
    TodayScheduleLabels,
    "title" | "description" | "viewAll" | "empty"
  >;
  maxVisible?: number;
}) {
  const onSelect = useSelectAppointment();
  const visible = items.slice(0, maxVisible);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription>{labels.description}</CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            render={<Link href={viewAllHref} />}
            nativeButton={false}
          >
            {labels.viewAll}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {labels.empty}
          </p>
        ) : (
          <ul className="divide-border -mx-(--card-spacing) divide-y">
            {visible.map((appt) => (
              <li key={appt.id}>
                <button
                  type="button"
                  onClick={() => onSelect(appt.id)}
                  className="hover:bg-muted/50 focus-visible:bg-muted/50 flex w-full items-center gap-3 px-(--card-spacing) py-2.5 text-left transition-colors focus-visible:outline-none"
                >
                  <span className="w-12 shrink-0 text-sm font-medium tabular-nums">
                    {formatTenantLocalTime(
                      appt.scheduledStartAt,
                      tenantTimezone,
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {appt.customerName}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {appt.serviceNames.join(", ") || "—"}
                      {appt.staff.length > 0 && (
                        <> · {appt.staff.map((s) => s.fullName).join(", ")}</>
                      )}
                    </span>
                  </span>
                  <StatusBadge status={appt.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Faz DASHBOARD.1 — the original combined shape (highlight cards + list
 * + its own provider/sheet, no reordering needs of its own), kept for
 * the personal dashboard's single-column use — it has no Hızlı İşlemler
 * to interleave anything between, so there is nothing to split there.
 */
export function TodaySchedule({
  items,
  inProgress,
  next,
  tenantId,
  tenantSlug,
  tenantTimezone,
  canUpdate,
  canCancel,
  viewAllHref,
  labels,
  maxVisible = 8,
}: {
  items: DashboardTodayAppointment[];
  inProgress: DashboardTodayAppointment | null;
  next: DashboardTodayAppointment | null;
  tenantId: string;
  tenantSlug: string;
  tenantTimezone: string;
  canUpdate: boolean;
  canCancel: boolean;
  viewAllHref: string;
  labels: TodayScheduleLabels;
  maxVisible?: number;
}) {
  return (
    <TodayScheduleProvider
      tenantId={tenantId}
      tenantSlug={tenantSlug}
      tenantTimezone={tenantTimezone}
      canUpdate={canUpdate}
      canCancel={canCancel}
    >
      <NextAppointmentHighlight
        inProgress={inProgress}
        next={next}
        tenantTimezone={tenantTimezone}
        labels={labels}
      />
      <TodayScheduleList
        items={items}
        tenantTimezone={tenantTimezone}
        viewAllHref={viewAllHref}
        labels={labels}
        maxVisible={maxVisible}
      />
    </TodayScheduleProvider>
  );
}
