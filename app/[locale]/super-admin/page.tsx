import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminDashboard } from "@/lib/modules/platform/admin";
import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SignalList, LifecycleBadge } from "@/components/super-admin/status-badges";
import { StatCard } from "@/components/super-admin/stat-card";
import { formatDate } from "@/components/super-admin/format";

/**
 * Platform dashboard: operational counts and the two short lists an operator acts on (what was just created, what needs attention).
 * Read-only. All numbers come from public.admin_dashboard_summary(), which refuses everyone who is not an active platform admin; a refusal
 * here (the layout guard already ran) sends the visitor away without rendering anything.
 */
export default async function SuperAdminDashboardPage() {
  const supabase = await createClient();
  const result = await getAdminDashboard(supabase);
  if (!result.ok) {
    if (result.reason === "forbidden") redirect("/");
    throw new Error("super admin dashboard unavailable");
  }
  const d = result.data;
  const t = await getTranslations("SuperAdmin");

  const lifecycleLabels = {
    setup: t("lifecycle.setup"),
    active: t("lifecycle.active"),
    inactive: t("lifecycle.inactive"),
    suspended: t("lifecycle.suspended"),
    canceled: t("lifecycle.canceled"),
  };
  const levels = { critical: t("health.levels.critical"), warning: t("health.levels.warning"), info: t("health.levels.info"), ok: t("health.levels.ok") };
  const codes = {
    no_owner: t("health.codes.no_owner"),
    booking_broken: t("health.codes.booking_broken"),
    setup_stalled: t("health.codes.setup_stalled"),
    owner_never_signed_in: t("health.codes.owner_never_signed_in"),
    no_recent_activity: t("health.codes.no_recent_activity"),
    invite_pending: t("health.codes.invite_pending"),
    new_salon: t("health.codes.new_salon"),
    no_appointments_yet: t("health.codes.no_appointments_yet"),
    booking_off: t("health.codes.booking_off"),
    trial_ending: t("health.codes.trial_ending"),
    suspended: t("health.codes.suspended"),
    canceled: t("health.codes.canceled"),
  };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("dashboard.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("dashboard.subtitle")}</p>
      </div>

      {d.salonsTotal === 0 ? (
        <p className="text-muted-foreground text-sm">{t("dashboard.noSalons")}</p>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <StatCard label={t("dashboard.stats.salons")} value={d.salonsTotal} />
            <StatCard label={t("dashboard.stats.active")} value={d.lifecycle.active} />
            <StatCard label={t("dashboard.stats.setup")} value={d.lifecycle.setup} />
            <StatCard label={t("dashboard.stats.inactive")} value={d.lifecycle.inactive} />
            <StatCard label={t("dashboard.stats.suspended")} value={d.lifecycle.suspended + d.lifecycle.canceled} />
            <StatCard label={t("dashboard.stats.booking")} value={d.bookingActive} />
            <StatCard label={t("dashboard.stats.owners")} value={d.ownersTotal} />
            <StatCard label={t("dashboard.stats.users")} value={d.usersTotal} />
            <StatCard label={t("dashboard.stats.staff")} value={d.staffTotal} />
            <StatCard label={t("dashboard.stats.today")} value={d.appointmentsToday} />
            <StatCard label={t("dashboard.stats.week")} value={d.appointments7d} />
            <StatCard label={t("dashboard.stats.critical")} value={d.health.critical} tone="critical" />
            <StatCard label={t("dashboard.stats.warning")} value={d.health.warning} tone="warning" />
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t("dashboard.attention")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {d.needsAttention.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t("dashboard.noAttention")}</p>
                ) : (
                  d.needsAttention.map((s) => (
                    <div key={s.tenantId} className="flex flex-col gap-1.5" data-attention={s.slug}>
                      <Link href={`/super-admin/salons/${s.tenantId}`} className="text-sm font-medium underline-offset-4 hover:underline">
                        {s.name} <span className="text-muted-foreground font-mono text-xs">{s.slug}</span>
                      </Link>
                      <SignalList signals={s.health.filter((h) => h.severity !== "info")} codes={codes} levels={levels} />
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t("dashboard.recent")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {d.recentlyCreated.map((s) => (
                  <div key={s.tenantId} className="flex items-center justify-between gap-3" data-recent={s.slug}>
                    <Link href={`/super-admin/salons/${s.tenantId}`} className="text-sm font-medium underline-offset-4 hover:underline">
                      {s.name} <span className="text-muted-foreground font-mono text-xs">{s.slug}</span>
                    </Link>
                    <span className="flex items-center gap-2">
                      <LifecycleBadge lifecycle={s.lifecycle} labels={lifecycleLabels} />
                      <span className="text-muted-foreground text-xs tabular-nums">{formatDate(s.createdAt)}</span>
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <div>
            <Button variant="outline" render={<Link href="/super-admin/salons" />}>
              {t("dashboard.viewAll")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
