import {
  CalendarPlus,
  UserPlus,
  Users,
  Scissors,
  ExternalLink,
  TriangleAlert,
} from "lucide-react";
import { Link } from "@/lib/i18n/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardAction,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyLinkButton } from "@/components/dashboard/copy-link-button";
import type {
  DashboardActiveStaff,
  DashboardMonthSummary,
  DashboardSetupHealth,
  DashboardStaffRef,
} from "@/lib/modules/dashboard/queries";

/**
 * Faz DASHBOARD.1 — the purely presentational, permission-agnostic
 * pieces of the dashboard. Every section here takes already-resolved
 * data, already-resolved booleans, and already-translated label strings
 * as props; permission checks, data fetching, and next-intl resolution
 * all stay in app/[locale]/app/[tenantSlug]/page.tsx (same "labels"-
 * object-as-prop pattern already used by
 * app/[locale]/app/[tenantSlug]/calendar/page.tsx), so a section that
 * shouldn't render for a given user is simply never mounted by the
 * caller — nothing here re-derives or second-guesses authorization on
 * its own.
 */

// ---------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------

export function TodayKpiCards({
  total,
  pending,
  completed,
  cancelledOrNoShow,
  labels,
}: {
  total: number;
  pending: number;
  completed: number;
  cancelledOrNoShow: number;
  labels: {
    total: string;
    pending: string;
    completed: string;
    cancelledOrNoShow: string;
  };
}) {
  const cards = [
    { label: labels.total, value: total },
    { label: labels.pending, value: pending },
    { label: labels.completed, value: completed },
    { label: labels.cancelledOrNoShow, value: cancelledOrNoShow },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label} size="sm">
          <CardContent className="flex flex-col gap-1">
            <span className="font-heading text-2xl font-semibold tabular-nums">
              {c.value}
            </span>
            <span className="text-muted-foreground text-xs">{c.label}</span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------

export type QuickAction = {
  key: string;
  label: string;
  href: string;
  icon: React.ReactNode;
};

export function QuickActions({
  actions,
  title,
}: {
  actions: QuickAction[];
  title: string;
}) {
  if (actions.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button
            key={a.key}
            variant="outline"
            size="sm"
            render={<Link href={a.href} />}
            nativeButton={false}
          >
            {a.icon}
            {a.label}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}

export const QUICK_ACTION_ICONS = {
  appointment: <CalendarPlus className="size-3.5" />,
  customer: <UserPlus className="size-3.5" />,
  staff: <Users className="size-3.5" />,
  service: <Scissors className="size-3.5" />,
  external: <ExternalLink className="size-3.5" />,
};

// ---------------------------------------------------------------------
// Today's staff
// ---------------------------------------------------------------------

export function StaffTodaySummary({
  staff,
  counts,
  labels,
}: {
  staff: DashboardActiveStaff[];
  counts: Map<string, number>;
  labels: {
    title: string;
    empty: string;
    appointmentCount: (count: number) => string;
  };
}) {
  if (staff.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{labels.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">{labels.empty}</p>
        </CardContent>
      </Card>
    );
  }

  const sorted = [...staff].sort(
    (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-border -mx-(--card-spacing) divide-y">
          {sorted.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between px-(--card-spacing) py-2 text-sm"
            >
              <span className="truncate font-medium">{s.fullName}</span>
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {labels.appointmentCount(counts.get(s.id) ?? 0)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
// This month
// ---------------------------------------------------------------------

export function MonthSummaryCard({
  summary,
  labels,
}: {
  summary: DashboardMonthSummary;
  labels: {
    title: string;
    total: string;
    completed: string;
    newCustomers: string;
    cancelled: string;
    empty: string;
  };
}) {
  const items = [
    { label: labels.total, value: summary.total },
    { label: labels.completed, value: summary.completed },
    { label: labels.newCustomers, value: summary.newCustomers },
    { label: labels.cancelled, value: summary.cancelled },
  ];
  const isEmpty = summary.total === 0 && summary.newCustomers === 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <p className="text-muted-foreground text-sm">{labels.empty}</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {items.map((i) => (
              <div key={i.label} className="flex flex-col gap-0.5">
                <span className="font-heading text-xl font-semibold tabular-nums">
                  {i.value}
                </span>
                <span className="text-muted-foreground text-xs">{i.label}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
// Online booking card
// ---------------------------------------------------------------------

export function OnlineBookingCard({
  enabled,
  bookingUrl,
  settingsHref,
  canManageSettings,
  labels,
}: {
  enabled: boolean;
  bookingUrl: string;
  settingsHref: string;
  canManageSettings: boolean;
  labels: {
    title: string;
    active: string;
    inactive: string;
    activeNote: string;
    copyLink: string;
    copied: string;
    openPage: string;
    disabledNote: string;
    openInSettings: string;
  };
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardAction>
          <Badge variant={enabled ? "default" : "outline"}>
            {enabled ? labels.active : labels.inactive}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {enabled ? (
          <>
            <p className="text-sm">{labels.activeNote}</p>
            <p className="text-muted-foreground truncate text-xs">
              {bookingUrl}
            </p>
            <div className="flex flex-wrap gap-2">
              <CopyLinkButton
                value={bookingUrl}
                label={labels.copyLink}
                copiedLabel={labels.copied}
              />
              <Button
                variant="outline"
                size="sm"
                render={
                  <Link
                    href={bookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
                nativeButton={false}
              >
                {QUICK_ACTION_ICONS.external}
                {labels.openPage}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              {labels.disabledNote}
            </p>
            {canManageSettings && (
              <Button
                variant="link"
                size="sm"
                className="h-auto self-start p-0"
                render={<Link href={settingsHref} />}
                nativeButton={false}
              >
                {labels.openInSettings}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
// Attention / setup health
// ---------------------------------------------------------------------

export function AttentionSection({
  health,
  settingsHref,
  labels,
}: {
  health: DashboardSetupHealth;
  settingsHref: string;
  labels: {
    title: string;
    onlineBookingDisabled: string;
    noActiveService: string;
    noActiveStaff: string;
    staffMissingSchedule: string;
    goToSettings: string;
  };
}) {
  const items: string[] = [];
  if (!health.onlineBookingEnabled) items.push(labels.onlineBookingDisabled);
  if (!health.hasActiveService) items.push(labels.noActiveService);
  if (!health.hasActiveStaff) items.push(labels.noActiveStaff);
  if (health.hasActiveStaff && health.staffMissingSchedule)
    items.push(labels.staffMissingSchedule);

  if (items.length === 0) return null;

  return (
    <Card className="border-amber-500/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <TriangleAlert className="size-4 text-amber-500" />
          {labels.title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1.5">
          {items.map((label) => (
            <li key={label} className="text-muted-foreground text-sm">
              {label}
            </li>
          ))}
        </ul>
        <Button
          variant="link"
          size="sm"
          className="mt-2 h-auto p-0"
          render={<Link href={settingsHref} />}
          nativeButton={false}
        >
          {labels.goToSettings}
        </Button>
      </CardContent>
    </Card>
  );
}

export function staffCountMap(
  staff: DashboardStaffRef[][],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const perAppointment of staff) {
    for (const s of perAppointment) {
      counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
    }
  }
  return counts;
}
