import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fillTemplate, monthTitle } from "@/lib/modules/expenses/format";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import { formatMoney } from "@/lib/modules/expenses/money";
import type { ExpenseOverview } from "@/lib/modules/expenses/types";

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
        <p className="text-xl font-semibold tracking-tight tabular-nums">
          {value}
        </p>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

/**
 * The four overview cards for the primary currency, the overdue line under them, and any other currency as a compact line
 * (currencies are never summed). "Bu ay gider" and "Bu ay ödenen" follow the selected month; the outstanding balance is the
 * CURRENT all-time figure and says so ("Seçili aydan bağımsız, güncel toplam"). Nothing here is profit or a margin.
 */
export function ExpenseOverviewCards({
  overview,
  labels,
  onShowOverdue,
}: {
  overview: ExpenseOverview;
  labels: ExpenseLabels;
  onShowOverdue?: () => void;
}) {
  const primary =
    overview.byCurrency.find((c) => c.currency === overview.primaryCurrency) ??
    overview.byCurrency[0];
  const others = overview.byCurrency.filter((c) => c !== primary);
  if (!primary) return null;
  const money = (amount: number) => formatMoney(amount, primary.currency);

  return (
    <section
      className="flex flex-col gap-3"
      aria-label={monthTitle(overview.month)}
    >
      <p className="text-muted-foreground text-sm font-medium">
        {monthTitle(overview.month)}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={labels.cards.incurred}
          value={money(primary.incurred)}
        />
        <StatCard label={labels.cards.paid} value={money(primary.paid)} />
        <StatCard
          label={labels.cards.outstanding}
          value={money(primary.outstanding.total)}
          hint={`${labels.cards.outstandingHint} · ${fillTemplate(labels.cards.countLine, { count: primary.outstanding.count })}`}
        />
        <StatCard
          label={labels.cards.upcoming}
          value={money(primary.upcoming.total)}
          hint={`${fillTemplate(labels.cards.upcomingHint, { days: primary.upcoming.withinDays })} · ${fillTemplate(labels.cards.countLine, { count: primary.upcoming.count })}`}
        />
      </div>

      {primary.overdue.count > 0 && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
          <span>
            {fillTemplate(labels.cards.overdueLine, {
              count: primary.overdue.count,
              amount: money(primary.overdue.total),
            })}
          </span>
          {onShowOverdue ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onShowOverdue}
            >
              {labels.cards.overdueAction}
            </Button>
          ) : null}
        </div>
      )}

      {others.length > 0 && (
        <div className="text-muted-foreground flex flex-col gap-1 text-xs">
          <p className="font-medium">{labels.cards.otherCurrencies}</p>
          {others.map((c) => (
            <p key={c.currency} className="tabular-nums">
              {fillTemplate(labels.cards.otherCurrencyLine, {
                currency: c.currency,
                incurred: formatMoney(c.incurred, c.currency),
                paid: formatMoney(c.paid, c.currency),
                outstanding: formatMoney(c.outstanding.total, c.currency),
              })}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
