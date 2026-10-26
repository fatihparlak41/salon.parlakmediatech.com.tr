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
  getHasActiveService,
  buildSetupHealth,
  getStaffLinkByMembership,
  getMyFirstName,
  getMyTodayWorkingHours,
  computeTodayKpis,
  selectNextAppointment,
  type DashboardActiveStaff,
  type DashboardMonthSummary,
  type DashboardTodayAppointment,
} from "@/lib/modules/dashboard/queries";
import { greetingBandForHour } from "@/lib/modules/dashboard/greeting";
import {
  TodayScheduleProvider,
  NextAppointmentHighlight,
  TodayScheduleList,
  type TodayScheduleLabels,
} from "@/components/dashboard/today-schedule";
import { PersonalDashboard } from "@/components/dashboard/personal-dashboard";
import { SetupCard } from "@/components/onboarding/setup-card";
import { shouldOfferOnboarding, type OnboardingStatus } from "@/lib/modules/onboarding/model";
import { getOnboardingStatus } from "@/lib/modules/onboarding/queries";
import { DailyOwnerOverview } from "@/components/dashboard/daily-owner-overview";
import { getDailyOwnerOverview } from "@/lib/modules/finance-daily/queries";
import type { DailyOverview } from "@/lib/modules/finance-daily/model";
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
  const tSetup = await getTranslations("Setup");
  const supabase = await createClient();

  // Faz PERF.4 — this page used to be ten sequential awaits, each one a
  // network round trip to the database. The reads are now grouped by what
  // they truly depend on: step 1 needs nothing but the tenant and the
  // caller (permissions, timezone, greeting name, the caller's own staff
  // link, the online-booking flag); step 2 needs step 1's answers (which
  // kind of dashboard this is, the timezone, which sections the caller may
  // see). Same queries, same conditions, same results — only the waiting
  // overlaps.
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
    canViewFinance,
    canManageFinance,
    tenantTimezone,
    firstName,
    myStaffLink,
    onlineBookingEnabled,
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
    hasPermission(tenantId, "finance.view"),
    hasPermission(tenantId, "finance.manage"),
    getTenantTimezone(tenantId),
    getMyFirstName(supabase, access.user.id),
    // The membership id comes from the access check above (it already read
    // this very row), so there is no separate "find my membership" query.
    getStaffLinkByMembership(supabase, tenantId, access.membershipId),
    getOnlineBookingEnabled(tenantId),
  ]);

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
    // Step 2 (personal dashboard): today's list and the working hours do
    // not depend on each other.
    const [allToday, workingHours] = await Promise.all([
      canViewAppointments
        ? getTodayAppointments(supabase, tenantId, tenantTimezone)
        : Promise.resolve<DashboardTodayAppointment[]>([]),
      getMyTodayWorkingHours(supabase, myStaffLink.id, nowLocal.weekday),
    ]);
    const myAppointmentsToday = allToday.filter((a) =>
      a.staff.some((s) => s.id === myStaffLink.id),
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
          canViewFinance={canViewFinance}
          canManageFinance={canManageFinance}
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

  // Step 2 (salon-wide dashboard): every section's own read, each only when
  // the caller may see that section — all of them independent of each other.
  const [todayAppointments, activeStaff, monthSummary, hasActiveService, onboardingStatus, dailyOverview] =
    await Promise.all([
      canViewAppointments
        ? getTodayAppointments(supabase, tenantId, tenantTimezone)
        : Promise.resolve<DashboardTodayAppointment[]>([]),
      canViewStaffList
        ? getActiveStaffRoster(supabase, tenantId)
        : Promise.resolve<DashboardActiveStaff[]>([]),
      canViewBasicReports
        ? getMonthSummary(supabase, tenantId, tenantTimezone, today)
        : Promise.resolve<DashboardMonthSummary | null>(null),
      canManageStaff
        ? getHasActiveService(supabase, tenantId)
        : Promise.resolve<boolean | null>(null),
      // Faz LAUNCH.1C — the one readiness answer, read in parallel with the rest (no added wait). Only salon managers
      // are offered the guided setup, and only while the salon is not ready and has never taken an appointment.
      canManageStaff || canManageServices || canManageSettings
        ? getOnboardingStatus(tenantId)
        : Promise.resolve<OnboardingStatus | null>(null),
      // Faz FIN.2A — the one canonical daily finance read model, read in parallel with the rest. Only a caller who
      // holds finance.view is asked (the database re-checks); everyone else gets no finance block at all.
      canViewFinance ? getDailyOwnerOverview(tenantId) : Promise.resolve<DailyOverview | null>(null),
    ]);
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

  const bookingUrl = `${getSiteUrl()}/book/${tenantSlug}`;
  const settingsHref = `/app/${tenantSlug}/settings`;

  const setupHealth =
    hasActiveService === null
      ? null
      : buildSetupHealth(onlineBookingEnabled, hasActiveService, activeStaff);

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

      {onboardingStatus && shouldOfferOnboarding(onboardingStatus) && (
        <SetupCard
          status={onboardingStatus}
          href={`/app/${tenantSlug}/setup`}
          labels={{
            title: tSetup("dashboardCard.title"),
            body: tSetup("dashboardCard.body"),
            cta: tSetup("dashboardCard.cta"),
            progress: (done, total) => tSetup("progress", { done, total }),
          }}
        />
      )}
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
        canViewFinance={canViewFinance}
        canManageFinance={canManageFinance}
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
            {canViewStaffList && activeStaff.length > 1 && (
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
            {setupHealth && !(onboardingStatus && shouldOfferOnboarding(onboardingStatus)) && (
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

      {/* RC.1C: the money summary comes AFTER the day (appointments first on a phone). The two appointment counts it used to repeat
          are already in the cards above, and a one-person salon does not need a staff table of one row. */}
      {dailyOverview && (
        <DailyOwnerOverview overview={dailyOverview} tenantSlug={tenantSlug} hideAppointmentCounts hideStaff={activeStaff.length <= 1} />
      )}
    </div>
  );
}
