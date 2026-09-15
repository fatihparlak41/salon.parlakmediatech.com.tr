import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getTenantTimezone } from "@/lib/modules/appointments/queries";
import {
  getTenantTodayRangeUtc,
  getTenantNowLocalParts,
  formatTenantLocalTime,
} from "@/lib/modules/appointments/timezone";
import { getOnlineBookingEnabled } from "@/lib/modules/settings/queries";
import { getSiteUrl } from "@/lib/site-url";
import {
  getTodayAppointments,
  getMonthSummary,
  getActiveStaffRoster,
  getSetupHealth,
  getMyMembershipId,
  getStaffLinkByMembership,
  getMyFirstName,
  getMyTodayWorkingHours,
  computeTodayKpis,
  selectNextAppointment,
} from "@/lib/modules/dashboard/queries";
import { greetingBandForHour } from "@/lib/modules/dashboard/greeting";
import {
  TodayScheduleProvider,
  NextAppointmentHighlight,
  TodayScheduleList,
  type TodayScheduleLabels,
} from "@/components/dashboard/today-schedule";
import { PersonalDashboard } from "@/components/dashboard/personal-dashboard";
import {
  TodayKpiCards,
  QuickActions,
  QUICK_ACTION_ICONS,
  StaffTodaySummary,
  MonthSummaryCard,
  OnlineBookingCard,
  AttentionSection,
  staffCountMap,
  type QuickAction,
} from "@/components/dashboard/dashboard-sections";

export default async function TenantAppPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]">) {
  const { locale, tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);

  // Layout above already guards unauthenticated/not_found — this satisfies
  // the type narrowing without repeating the redirect/notFound logic.
  if (access.reason !== "ok") {
    return null;
  }

  const tenantId = access.tenant.id;
  const t = await getTranslations("TenantApp.dashboard");
  const supabase = await createClient();

  const [
    canViewAppointments,
    canCreateAppointments,
    canUpdateAppointments,
    canCancelAppointments,
    canCreateCustomers,
    canManageStaff,
    canManageServices,
    canViewBasicReports,
    canViewStaffReports,
    canManageSettings,
    canViewStaffList,
  ] = await Promise.all([
    hasPermission(tenantId, "appointments.view"),
    hasPermission(tenantId, "appointments.create"),
    hasPermission(tenantId, "appointments.update"),
    hasPermission(tenantId, "appointments.cancel"),
    hasPermission(tenantId, "customers.create"),
    hasPermission(tenantId, "staff.manage"),
    hasPermission(tenantId, "services.manage"),
    hasPermission(tenantId, "reports.basic"),
    hasPermission(tenantId, "reports.staff"),
    hasPermission(tenantId, "settings.manage"),
    hasPermission(tenantId, "staff.view"),
  ]);

  const tenantTimezone = await getTenantTimezone(tenantId);
  const { today } = getTenantTodayRangeUtc(tenantTimezone);
  const nowLocal = getTenantNowLocalParts(tenantTimezone);
  const greetingBand = greetingBandForHour(
    Math.floor(nowLocal.minutesSinceMidnight / 60),
  );
  const greetingWord = t(
    greetingBand === "morning"
      ? "greetingGoodMorning"
      : greetingBand === "day"
        ? "greetingGoodDay"
        : "greetingGoodEvening",
  );

  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const longDate = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));

  const scheduleLabels: TodayScheduleLabels = {
    nextTitle: t("next.title"),
    nowTitle: t("next.nowTitle"),
    title: t("todaySchedule.title"),
    description: t("todaySchedule.description"),
    viewAll: t("todaySchedule.viewAll"),
    empty: t("todaySchedule.empty"),
  };

  const [firstName, membershipId] = await Promise.all([
    getMyFirstName(supabase, access.user.id),
    getMyMembershipId(supabase, tenantId, access.user.id),
  ]);
  const myStaffLink = membershipId
    ? await getStaffLinkByMembership(supabase, tenantId, membershipId)
    : null;

  // "Salon-wide management access" = staff.manage — the one permission
  // SALON_OWNER and SALON_MANAGER both hold and every other role
  // template does not (confirmed against the seed in
  // 20260815120006_create_role_templates.sql). A management-capable
  // user who happens to ALSO be staff-linked (e.g. an owner who also
  // works appointments themselves) still gets the salon-wide dashboard,
  // matching section 14's own "AND lacks salon-wide management access"
  // wording.
  const isPersonal = myStaffLink !== null && !canManageStaff;

  if (isPersonal) {
    const allToday = canViewAppointments
      ? await getTodayAppointments(supabase, tenantId, tenantTimezone)
      : [];
    const myAppointmentsToday = allToday.filter((a) =>
      a.staff.some((s) => s.id === myStaffLink.id),
    );
    const workingHours = await getMyTodayWorkingHours(
      supabase,
      myStaffLink.id,
      nowLocal.weekday,
    );
    const { inProgress: myInProgress, next: myNext } = selectNextAppointment(
      myAppointmentsToday,
      new Date().toISOString(),
    );

    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <PersonalDashboard
          firstName={firstName}
          myAppointmentsToday={myAppointmentsToday}
          myInProgress={myInProgress}
          myNext={myNext}
          workingHours={workingHours}
          canViewOwnReports={canViewStaffReports}
          tenantId={tenantId}
          tenantSlug={tenantSlug}
          tenantTimezone={tenantTimezone}
          canUpdate={canUpdateAppointments}
          canCancel={canCancelAppointments}
          labels={{
            greetingWord,
            greetingFallback: t("greetingFallback"),
            todayCount: (count) => t("personal.todayCount", { count }),
            todayNone: t("personal.todayNone"),
            workingHoursLabel: t("personal.workingHoursLabel"),
            performanceTitle: t("personal.performanceTitle"),
            viewReport: t("personal.viewReport"),
            schedule: scheduleLabels,
          }}
        />
      </div>
    );
  }

  const todayAppointments = canViewAppointments
    ? await getTodayAppointments(supabase, tenantId, tenantTimezone)
    : [];
  const kpis = computeTodayKpis(todayAppointments);
  const { inProgress, next } = selectNextAppointment(
    todayAppointments,
    new Date().toISOString(),
  );
  const firstAppointmentLocalTime = todayAppointments[0]
    ? formatTenantLocalTime(
        todayAppointments[0].scheduledStartAt,
        tenantTimezone,
      )
    : null;

  const onlineBookingEnabled = await getOnlineBookingEnabled(tenantId);
  const bookingUrl = `${getSiteUrl()}/book/${tenantSlug}`;
  const settingsHref = `/app/${tenantSlug}/settings`;

  const activeStaff = canViewStaffList
    ? await getActiveStaffRoster(supabase, tenantId)
    : [];
  const monthSummary = canViewBasicReports
    ? await getMonthSummary(supabase, tenantId, tenantTimezone, today)
    : null;
  const setupHealth = canManageStaff
    ? await getSetupHealth(
        supabase,
        tenantId,
        onlineBookingEnabled,
        activeStaff,
      )
    : null;

  const candidateQuickActions: (QuickAction | null)[] = [
    canCreateAppointments
      ? {
          key: "appointment",
          label: t("quickActions.addAppointment"),
          href: `/app/${tenantSlug}/calendar`,
          icon: QUICK_ACTION_ICONS.appointment,
        }
      : null,
    canCreateCustomers
      ? {
          key: "customer",
          label: t("quickActions.addCustomer"),
          href: `/app/${tenantSlug}/customers`,
          icon: QUICK_ACTION_ICONS.customer,
        }
      : null,
    canManageStaff
      ? {
          key: "staff",
          label: t("quickActions.addStaff"),
          href: `/app/${tenantSlug}/staff`,
          icon: QUICK_ACTION_ICONS.staff,
        }
      : null,
    canManageServices
      ? {
          key: "service",
          label: t("quickActions.addService"),
          href: `/app/${tenantSlug}/services`,
          icon: QUICK_ACTION_ICONS.service,
        }
      : null,
    {
      key: "open-booking",
      label: t("quickActions.openBookingPage"),
      href: bookingUrl,
      icon: QUICK_ACTION_ICONS.external,
    },
  ];
  const quickActions = candidateQuickActions.filter(
    (a): a is QuickAction => a !== null,
  );

  const heading = firstName
    ? `${greetingWord}, ${firstName} 👋`
    : t("greetingFallback");
  const summarySentence =
    todayAppointments.length === 0
      ? t("summaryNone")
      : firstAppointmentLocalTime
        ? t("summaryWithFirst", {
            count: todayAppointments.length,
            time: firstAppointmentLocalTime,
          })
        : t("summaryCountOnly", { count: todayAppointments.length });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">
          {heading}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{longDate}</p>
        {canViewAppointments && (
          <p className="mt-2 text-sm">{summarySentence}</p>
        )}
      </div>

      {canViewAppointments && (
        <TodayKpiCards
          total={kpis.total}
          pending={kpis.pending}
          completed={kpis.completed}
          cancelledOrNoShow={kpis.cancelledOrNoShow}
          labels={{
            total: t("kpi.total"),
            pending: t("kpi.pending"),
            completed: t("kpi.completed"),
            cancelledOrNoShow: t("kpi.cancelledOrNoShow"),
          }}
        />
      )}

      {/*
        Faz DASHBOARD.1A — mobile order: Sıradaki/Şu an -> Hızlı
        İşlemler -> Bugünün Takvimi -> everything else, matching the
        "create an appointment within ~10s" acceptance goal exactly.
        Desktop keeps the original visual (Şu an/Sıradaki + the full
        list stacked together in the wide left column; Quick Actions at
        the top of the narrow right column) via explicit grid
        row/column placement rather than `order` (auto-placed row-span
        guessing would misalign the right column against a left column
        of varying height). NextAppointmentHighlight and
        TodayScheduleList are two components specifically so Hızlı
        İşlemler can sit between them on mobile without duplicating
        either — both share the one selectedId state and the one
        mounted AppointmentDetailSheet via TodayScheduleProvider.
      */}
      <TodayScheduleProvider
        tenantId={tenantId}
        tenantSlug={tenantSlug}
        tenantTimezone={tenantTimezone}
        canUpdate={canUpdateAppointments}
        canCancel={canCancelAppointments}
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="order-1 flex flex-col gap-4 lg:order-none lg:col-span-2 lg:col-start-1 lg:row-start-1">
            {canViewAppointments && (
              <NextAppointmentHighlight
                inProgress={inProgress}
                next={next}
                tenantTimezone={tenantTimezone}
                labels={scheduleLabels}
              />
            )}
          </div>

          <div className="order-2 lg:order-none lg:col-start-3 lg:row-start-1">
            <QuickActions
              actions={quickActions}
              title={t("quickActions.title")}
            />
          </div>

          <div className="order-3 lg:order-none lg:col-span-2 lg:col-start-1 lg:row-start-2">
            {canViewAppointments && (
              <TodayScheduleList
                items={todayAppointments}
                tenantTimezone={tenantTimezone}
                viewAllHref={`/app/${tenantSlug}/calendar`}
                labels={scheduleLabels}
              />
            )}
          </div>

          <div className="order-4 flex flex-col gap-4 lg:order-none lg:col-start-3 lg:row-start-2">
            {canViewStaffList && (
              <StaffTodaySummary
                staff={activeStaff}
                counts={staffCountMap(todayAppointments.map((a) => a.staff))}
                labels={{
                  title: t("staffToday.title"),
                  empty: t("staffToday.empty"),
                  appointmentCount: (count) =>
                    t("staffToday.appointmentCount", { count }),
                }}
              />
            )}
            {monthSummary && (
              <MonthSummaryCard
                summary={monthSummary}
                labels={{
                  title: t("month.title"),
                  total: t("month.total"),
                  completed: t("month.completed"),
                  newCustomers: t("month.newCustomers"),
                  cancelled: t("month.cancelled"),
                  empty: t("month.empty"),
                }}
              />
            )}
            <OnlineBookingCard
              enabled={onlineBookingEnabled}
              bookingUrl={bookingUrl}
              settingsHref={settingsHref}
              canManageSettings={canManageSettings}
              labels={{
                title: t("onlineBooking.title"),
                active: t("onlineBooking.active"),
                inactive: t("onlineBooking.inactive"),
                activeNote: t("onlineBooking.activeNote"),
                copyLink: t("onlineBooking.copyLink"),
                copied: t("onlineBooking.copied"),
                openPage: t("onlineBooking.openPage"),
                disabledNote: t("onlineBooking.disabledNote"),
                openInSettings: t("onlineBooking.openInSettings"),
              }}
            />
            {setupHealth && (
              <AttentionSection
                health={setupHealth}
                settingsHref={settingsHref}
                labels={{
                  title: t("attention.title"),
                  onlineBookingDisabled: t("attention.onlineBookingDisabled"),
                  noActiveService: t("attention.noActiveService"),
                  noActiveStaff: t("attention.noActiveStaff"),
                  staffMissingSchedule: t("attention.staffMissingSchedule"),
                  goToSettings: t("attention.goToSettings"),
                }}
              />
            )}
          </div>
        </div>
      </TodayScheduleProvider>
    </div>
  );
}
