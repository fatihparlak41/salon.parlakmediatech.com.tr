import { Link } from "@/lib/i18n/navigation";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  TodaySchedule,
  type TodayScheduleLabels,
} from "@/components/dashboard/today-schedule";
import type { DashboardTodayAppointment } from "@/lib/modules/dashboard/queries";

export type PersonalDashboardLabels = {
  greetingWord: string;
  greetingFallback: string;
  todayCount: (count: number) => string;
  todayNone: string;
  workingHoursLabel: string;
  performanceTitle: string;
  viewReport: string;
  schedule: TodayScheduleLabels;
};

/**
 * Faz DASHBOARD.1 section 14 — a staff-linked user who lacks salon-wide
 * management access (staff.manage) sees only their own day: their own
 * appointments (already filtered by the caller to those where they are
 * one of the assigned staff), their own working hours if any, and
 * nothing about other staff, salon-wide totals, customers list, billing,
 * or settings — none of that data is even fetched for this branch, not
 * merely hidden in the UI.
 */
export function PersonalDashboard({
  firstName,
  myAppointmentsToday,
  myInProgress,
  myNext,
  workingHours,
  canViewOwnReports,
  tenantId,
  tenantSlug,
  tenantTimezone,
  canUpdate,
  canCancel,
  labels,
}: {
  firstName: string | null;
  myAppointmentsToday: DashboardTodayAppointment[];
  myInProgress: DashboardTodayAppointment | null;
  myNext: DashboardTodayAppointment | null;
  workingHours: { startTime: string; endTime: string } | null;
  canViewOwnReports: boolean;
  tenantId: string;
  tenantSlug: string;
  tenantTimezone: string;
  canUpdate: boolean;
  canCancel: boolean;
  labels: PersonalDashboardLabels;
}) {
  const heading = firstName
    ? `${labels.greetingWord}, ${firstName} 👋`
    : labels.greetingFallback;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          {heading}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {myAppointmentsToday.length === 0
            ? labels.todayNone
            : labels.todayCount(myAppointmentsToday.length)}
        </p>
      </div>

      {workingHours && (
        <Card size="sm">
          <CardContent className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              {labels.workingHoursLabel}
            </span>
            <span className="font-medium tabular-nums">
              {workingHours.startTime.slice(0, 5)}–
              {workingHours.endTime.slice(0, 5)}
            </span>
          </CardContent>
        </Card>
      )}

      <TodaySchedule
        items={myAppointmentsToday}
        inProgress={myInProgress}
        next={myNext}
        tenantId={tenantId}
        tenantSlug={tenantSlug}
        tenantTimezone={tenantTimezone}
        canUpdate={canUpdate}
        canCancel={canCancel}
        viewAllHref={`/app/${tenantSlug}/calendar`}
        labels={labels.schedule}
      />

      {canViewOwnReports && (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">{labels.performanceTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              render={<Link href={`/app/${tenantSlug}/reports/staff`} />}
              nativeButton={false}
            >
              {labels.viewReport}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
