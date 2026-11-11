import { Link } from "@/lib/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/components/super-admin/format";
import { accessTone, type AccessState, type AdminBillingRow, type AdminTenantBilling, type BillingNotice, type LimitStatus, type Usage } from "@/lib/modules/billing/model";
import type { BillingLabels } from "@/components/billing/labels";
import { cn } from "@/lib/utils";

/**
 * Faz SAAS.1C.1 - presentational billing views. Pure: every string arrives resolved, no data is fetched here, there is NO form, NO button and
 * NO write control anywhere in this file. Colour is never the only carrier: every state is also printed.
 */

export function AccessBadge({ state, labels }: { state: Pick<AccessState, "mode">; labels: BillingLabels }) {
  const tone = accessTone(state.mode);
  return (
    <Badge
      variant={tone === "critical" ? "destructive" : "outline"}
      data-access-mode={state.mode}
      className={cn(tone === "warning" && "border-amber-500/60 text-amber-700 dark:text-amber-400")}
    >
      {labels.modes[state.mode] ?? state.mode}
    </Badge>
  );
}

const USAGE_ORDER: (keyof Usage)[] = ["activeStaff", "branches", "services", "customers", "activeMembers", "appointmentsCreated30d", "appointmentsTotal", "treatmentPhotos", "emailsSent30d"];

export function UsageGrid({ usage, labels }: { usage: Usage; labels: BillingLabels }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3" data-usage>
      {USAGE_ORDER.map((k) => (
        <div key={k} className="flex flex-col gap-0.5" data-usage-item={k}>
          <dt className="text-muted-foreground text-xs">{labels.usage[k] ?? k}</dt>
          <dd className="text-lg font-semibold tabular-nums">{usage[k]}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LimitList({ limits, labels, ofLabel, noLimits }: { limits: LimitStatus[]; labels: BillingLabels; ofLabel: (used: number, limit: number) => string; noLimits: string }) {
  if (limits.length === 0) return <p className="text-muted-foreground text-sm">{noLimits}</p>;
  return (
    <ul className="flex flex-col gap-2" data-limits>
      {limits.map((l) => (
        <li key={l.key} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-limit={l.key} data-limit-state={l.state}>
          <span>{labels.limitKeys[l.key] ?? l.key}</span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums">{ofLabel(l.used, l.limit)}</span>
            <Badge variant={l.state === "ok" ? "outline" : "secondary"} className={cn(l.state === "over" && "border-amber-500/60 text-amber-700 dark:text-amber-400")}>
              {labels.limitState[l.state] ?? l.state}
            </Badge>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The informational strip an Owner / Yönetici sees; it never blocks anything (a plain paragraph with one link). */
export function BillingNoticeStrip({ notice, text, href, cta }: { notice: BillingNotice; text: string; href: string; cta: string }) {
  return (
    <div role="status" data-billing-notice={notice.kind} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
      <span>{text}</span>
      <Link href={href} className="font-medium underline-offset-4 hover:underline">
        {cta}
      </Link>
    </div>
  );
}

/** The soft staff-limit hint: informational, never a refusal. */
export function StaffLimitHint({ text }: { text: string }) {
  return (
    <p role="status" data-staff-limit-hint className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The salon's own page
// ---------------------------------------------------------------------------------------------------------------------------------------
export type TenantPlanLabels = {
  plan: string;
  status: string;
  access: string;
  billingMode: string;
  usageHeading: string;
  limitsHeading: string;
  softNote: string;
  noLimits: string;
  trialLine: string;
  ofLabel: (used: number, limit: number) => string;
};

export function TenantPlanView({ planName, state, usage, limits, labels, t }: { planName: string; state: AccessState; usage: Usage; limits: LimitStatus[]; labels: BillingLabels; t: TenantPlanLabels }) {
  return (
    <div className="flex flex-col gap-6" data-tenant-plan>
      <Card>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">{t.plan}</span>
            <span className="font-medium" data-plan-name>
              {planName}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">{t.billingMode}</span>
            <span>{state.billingMode ? (labels.billingModes[state.billingMode] ?? state.billingMode) : ""}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">{t.status}</span>
            <span>{state.status ? (labels.statuses[state.status] ?? state.status) : ""}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t.access}</span>
            <span className="flex flex-wrap items-center gap-2">
              <AccessBadge state={state} labels={labels} />
              <span className="text-sm">{labels.reasons[state.reason] ?? state.reason}</span>
            </span>
          </div>
          <p className="text-sm sm:col-span-2" data-trial-line>
            {t.trialLine}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.usageHeading}</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageGrid usage={usage} labels={labels} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.limitsHeading}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <LimitList limits={limits} labels={labels} ofLabel={t.ofLabel} noLimits={t.noLimits} />
          <p className="text-muted-foreground text-xs">{t.softNote}</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Super Admin
// ---------------------------------------------------------------------------------------------------------------------------------------
export type AdminBillingTableLabels = {
  columns: { salon: string; plan: string; mode: string; status: string; access: string; days: string; trialEnd: string; limits: string };
  overLimit: string;
  atLimit: string;
  noPlan: string;
  noDate: string;
  empty: string;
};

export function AdminBillingTable({ rows, labels, t }: { rows: AdminBillingRow[]; labels: BillingLabels; t: AdminBillingTableLabels }) {
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{t.empty}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm" data-billing-table>
        <thead className="bg-muted/50 text-muted-foreground text-xs">
          <tr>
            {Object.values(t.columns).map((c) => (
              <th key={c} className="px-3 py-2 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tenantId} className="border-t" data-billing-row={r.slug}>
              <td className="px-3 py-2">
                <Link href={`/super-admin/salons/${r.tenantId}`} className="font-medium underline-offset-4 hover:underline">
                  {r.name}
                </Link>
                <div className="text-muted-foreground font-mono text-xs">{r.slug}</div>
              </td>
              <td className="px-3 py-2">{r.planKey ?? t.noPlan}</td>
              <td className="px-3 py-2">{r.billingMode ? (labels.billingModes[r.billingMode] ?? r.billingMode) : t.noDate}</td>
              <td className="px-3 py-2">{r.status ? (labels.statuses[r.status] ?? r.status) : t.noDate}</td>
              <td className="px-3 py-2">
                <div className="flex flex-col gap-1">
                  <AccessBadge state={{ mode: r.accessMode }} labels={labels} />
                  <span className="text-muted-foreground text-xs">{labels.reasons[r.accessReason] ?? r.accessReason}</span>
                </div>
              </td>
              <td className="px-3 py-2 tabular-nums">{r.daysRemaining ?? t.noDate}</td>
              <td className="px-3 py-2 tabular-nums">{r.trialEndsAt ? formatDate(r.trialEndsAt) : t.noDate}</td>
              <td className="px-3 py-2">{r.overLimit ? t.overLimit : r.atLimit ? t.atLimit : t.noDate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type AdminBillingSectionLabels = {
  heading: string;
  noSubscription: string;
  plan: string;
  price: string;
  priceUnset: string;
  billingMode: string;
  status: string;
  access: string;
  reason: string;
  trialStarted: string;
  trialEnds: string;
  graceEnds: string;
  daysRemaining: string;
  cancelAtPeriodEnd: string;
  yes: string;
  no: string;
  readyNotStarted: string;
  usage: string;
  limits: string;
  events: string;
  noEvents: string;
  noLimits: string;
  noDate: string;
  ofLabel: (used: number, limit: number) => string;
  eventTypes: Record<string, string>;
};

export function AdminBillingSection({ billing, labels, t }: { billing: AdminTenantBilling; labels: BillingLabels; t: AdminBillingSectionLabels }) {
  const s = billing.accessState;
  const row = (label: string, value: React.ReactNode, key: string) => (
    <div className="flex flex-col gap-0.5" data-billing-field={key}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
  return (
    <section className="flex flex-col gap-4" data-billing-section>
      <h2 className="text-lg font-semibold tracking-tight">{t.heading}</h2>
      {!billing.subscriptionPresent ? <p className="text-muted-foreground text-sm">{t.noSubscription}</p> : null}
      {billing.readyTrialNotStarted ? (
        <p role="status" data-ready-not-started className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          {t.readyNotStarted}
        </p>
      ) : null}
      <Card>
        <CardContent className="pt-4">
          <dl className="grid gap-4 sm:grid-cols-3">
            {row(t.plan, billing.planName ?? "—", "plan")}
            {row(t.price, billing.planPriceMonthly == null ? t.priceUnset : String(billing.planPriceMonthly), "price")}
            {row(t.billingMode, s.billingMode ? (labels.billingModes[s.billingMode] ?? s.billingMode) : t.noDate, "billingMode")}
            {row(t.status, s.status ? (labels.statuses[s.status] ?? s.status) : t.noDate, "status")}
            {row(t.access, <AccessBadge key="a" state={s} labels={labels} />, "access")}
            {row(t.reason, labels.reasons[s.reason] ?? s.reason, "reason")}
            {row(t.trialStarted, s.trialStartedAt ? formatDate(s.trialStartedAt) : t.noDate, "trialStarted")}
            {row(t.trialEnds, s.trialEndsAt ? formatDate(s.trialEndsAt) : t.noDate, "trialEnds")}
            {row(t.graceEnds, s.graceEndsAt ? formatDate(s.graceEndsAt) : t.noDate, "graceEnds")}
            {row(t.daysRemaining, s.daysRemaining ?? t.noDate, "daysRemaining")}
            {row(t.cancelAtPeriodEnd, s.cancelAtPeriodEnd ? t.yes : t.no, "cancelAtPeriodEnd")}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.usage}</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageGrid usage={billing.usage} labels={labels} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.limits}</CardTitle>
        </CardHeader>
        <CardContent>
          <LimitList limits={billing.limits} labels={labels} ofLabel={t.ofLabel} noLimits={t.noLimits} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.events}</CardTitle>
        </CardHeader>
        <CardContent>
          {billing.events.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t.noEvents}</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm" data-billing-events>
              {billing.events.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">{formatDate(e.at)}</span>
                  <span>{t.eventTypes[e.type] ?? e.type}</span>
                  {e.reason ? <span className="text-muted-foreground">{e.reason}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
