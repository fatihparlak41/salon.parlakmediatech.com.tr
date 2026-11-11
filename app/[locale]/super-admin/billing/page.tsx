import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { BILLING_FILTERS, parseBillingFilter } from "@/lib/modules/billing/model";
import { getAdminBillingDashboard, getAdminBillingList } from "@/lib/modules/billing/queries";
import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/super-admin/stat-card";
import { AdminBillingTable } from "@/components/billing/billing-views";
import { loadBillingLabels } from "@/components/billing/labels";
import { adminTableLabels } from "@/components/billing/page-labels";
import { cn } from "@/lib/utils";

/**
 * Super Admin billing overview, READ-ONLY: counts by commercial state and one table of every salon's plan, trial and access state. All data
 * comes from public.admin_billing_dashboard / admin_billing_list, which refuse everyone who is not an active platform admin. No write control.
 */
export default async function SuperAdminBillingPage({ searchParams }: PageProps<"/[locale]/super-admin/billing">) {
  const raw = await searchParams;
  const filter = parseBillingFilter(raw.filter);
  const qRaw = Array.isArray(raw.q) ? raw.q[0] : raw.q;
  const search = (qRaw ?? "").trim().slice(0, 100);

  const supabase = await createClient();
  const [dash, list] = await Promise.all([getAdminBillingDashboard(supabase), getAdminBillingList(supabase, filter, search)]);
  if (!dash.ok || !list.ok) {
    if ((!dash.ok && dash.reason === "forbidden") || (!list.ok && list.reason === "forbidden")) redirect("/");
    throw new Error("super admin billing unavailable");
  }
  const d = dash.data;
  const t = await getTranslations("SuperAdmin.billing");
  const labels = await loadBillingLabels("SuperAdmin.billing");
  const href = (f: string) => {
    const q = new URLSearchParams();
    if (search) q.set("q", search);
    if (f !== "all") q.set("filter", f);
    const s = q.toString();
    return s ? `/super-admin/billing?${s}` : "/super-admin/billing";
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("subtitle")}</p>
        <p className="text-muted-foreground mt-2 text-xs" data-enforcement={d.enforcementEnabled ? "on" : "off"}>
          {d.enforcementEnabled ? t("enforcementOn") : t("enforcementOff")}
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label={t("stats.total")} value={d.total} />
        <StatCard label={t("stats.trialNotStarted")} value={d.trialNotStarted} />
        <StatCard label={t("stats.trialActive")} value={d.trialActive} />
        <StatCard label={t("stats.trialEnding")} value={d.trialEnding} tone="warning" />
        <StatCard label={t("stats.grace")} value={d.grace} tone="warning" />
        <StatCard label={t("stats.readOnly")} value={d.readOnly} tone="critical" />
        <StatCard label={t("stats.paidActive")} value={d.paidActive} />
        <StatCard label={t("stats.pilot")} value={d.pilot} />
        <StatCard label={t("stats.complimentary")} value={d.complimentary} />
        <StatCard label={t("stats.internal")} value={d.internal} />
        <StatCard label={t("stats.overLimit")} value={d.overLimit} tone="warning" />
        <StatCard label={t("stats.readyNotStarted")} value={d.readyTrialNotStarted} tone="warning" />
        <StatCard label={t("stats.noSubscription")} value={d.noSubscription} tone="warning" />
      </section>

      <div className="flex flex-col gap-3">
        <form method="get" action="/super-admin/billing" className="flex flex-wrap items-center gap-2" role="search">
          <label className="sr-only" htmlFor="billing-search">
            {t("search")}
          </label>
          <Input id="billing-search" name="q" defaultValue={search} placeholder={t("search")} className="w-full sm:w-80" maxLength={100} autoComplete="off" />
          {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
          <Button type="submit">{t("searchButton")}</Button>
        </form>
        <nav className="flex flex-wrap gap-1.5" aria-label="filter">
          {BILLING_FILTERS.map((f) => (
            <Link
              key={f}
              href={href(f)}
              aria-current={filter === f ? "true" : undefined}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === f ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t(`filters.${f}`)}
            </Link>
          ))}
        </nav>
      </div>

      <AdminBillingTable rows={list.data} labels={labels} t={await adminTableLabels()} />
    </div>
  );
}
