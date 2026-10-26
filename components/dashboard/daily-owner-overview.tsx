import { useTranslations } from "next-intl";
import { Link } from "@/lib/i18n/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "@/lib/modules/expenses/money";
import { formatOverviewDate, type DailyOverview } from "@/lib/modules/finance-daily/model";

/**
 * Faz FIN.2A — the Owner's "how did today go" block. Purely presentational: every number comes from the one daily
 * read model (get_daily_owner_overview) and is shown as given; nothing here adds, subtracts or re-derives. Sales
 * value, money received, expenses and the cash difference are different numbers and are labelled as such. Nothing is
 * called profit.
 */
export function DailyOwnerOverview({
  overview,
  tenantSlug,
  hideAppointmentCounts = false,
  hideStaff = false,
}: {
  overview: DailyOverview;
  tenantSlug: string;
  /** The dashboard already shows today's appointment counts right above; the block can leave its own two out. */
  hideAppointmentCounts?: boolean;
  /** A salon with one provider does not need a one-row staff table. */
  hideStaff?: boolean;
}) {
  const t = useTranslations("DailyOverview");
  const money = (n: number) => formatMoney(n, overview.currency);
  const a = overview.appointments;
  const p = overview.payments;
  const e = overview.expenses;

  const cards: { key: string; label: string; value: string; note?: string; href?: string }[] = [
    {
      key: "appointments",
      label: t("appointments"),
      value: String(a.total),
      note: t("appointmentsNote", { scheduled: a.scheduled + a.confirmed + a.inProgress, cancelled: a.cancelled, noShow: a.noShow }),
      href: `/app/${tenantSlug}/appointments`,
    },
    { key: "completed", label: t("completed"), value: String(a.completed), href: `/app/${tenantSlug}/appointments` },
    {
      key: "serviceAmount",
      label: t("serviceAmount"),
      value: money(overview.services.completedAmount),
      note:
        overview.services.completedWithoutCheckout > 0
          ? t("serviceAmountNoCheckout", { count: overview.services.completedWithoutCheckout, amount: money(overview.services.withoutCheckoutAmount) })
          : t("serviceAmountNote"),
    },
    { key: "collected", label: t("collected"), value: money(p.totalCollected), note: t("collectedNote", { count: p.count }) },
    {
      key: "outstanding",
      label: t("outstanding"),
      value: money(overview.outstanding.amount),
      note: t("outstandingNote", { count: overview.outstanding.count, today: money(overview.outstanding.todayAmount) }),
    },
    {
      key: "expense",
      label: t("expense"),
      value: money(e.accruedTotal),
      note: t("expenseNote", { paid: money(e.paidOutTotal) }),
      href: `/app/${tenantSlug}/finance/expenses`,
    },
    { key: "cashDifference", label: t("cashDifference"), value: money(overview.cash.difference), note: t("cashDifferenceNote", { cash: money(overview.cash.cashCollected), out: money(overview.cash.cashPaidOut) }) },
  ];

  const shownCards = hideAppointmentCounts ? cards.filter((c) => c.key !== "appointments" && c.key !== "completed") : cards;

  const methods: { key: string; label: string; collected: number; paidOut: number }[] = [
    { key: "cash", label: t("methods.cash"), collected: p.cash, paidOut: e.paidOutCash },
    { key: "card", label: t("methods.card"), collected: p.card, paidOut: e.paidOutCard },
    { key: "transfer", label: t("methods.transfer"), collected: p.bankTransfer, paidOut: e.paidOutBankTransfer },
    { key: "other", label: t("methods.other"), collected: p.other, paidOut: e.paidOutOther },
  ];

  return (
    <section className="flex flex-col gap-3" aria-label={t("title")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-base font-semibold">{t("title")}</h2>
        <span className="text-muted-foreground text-xs">{formatOverviewDate(overview.date)}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {shownCards.map((c) => {
          const body = (
            <CardContent className="flex flex-col gap-1">
              <span className="font-heading text-xl font-semibold tabular-nums">{c.value}</span>
              <span className="text-sm">{c.label}</span>
              {c.note ? <span className="text-muted-foreground text-xs">{c.note}</span> : null}
            </CardContent>
          );
          return (
            <Card key={c.key} size="sm" data-metric={c.key}>
              {c.href ? (
                <Link href={c.href} className="block rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
                  {body}
                </Link>
              ) : (
                body
              )}
            </Card>
          );
        })}
      </div>

      <div className={hideStaff ? "grid gap-3" : "grid gap-3 lg:grid-cols-2"}>
        <Card size="sm" data-section="methods">
          <CardContent className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("methodsTitle")}</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground text-xs">
                  <th scope="col" className="text-left font-normal" />
                  <th scope="col" className="text-right font-normal">{t("methodsCollected")}</th>
                  <th scope="col" className="text-right font-normal">{t("methodsPaidOut")}</th>
                </tr>
              </thead>
              <tbody>
                {methods.map((m) => (
                  <tr key={m.key} data-method={m.key}>
                    <th scope="row" className="py-0.5 text-left font-normal">{m.label}</th>
                    <td className="text-right tabular-nums">{money(m.collected)}</td>
                    <td className="text-right tabular-nums">{money(m.paidOut)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {p.voidedCount > 0 ? <p className="text-muted-foreground text-xs">{t("voidedNote", { count: p.voidedCount, amount: money(p.voidedAmount) })}</p> : null}
          </CardContent>
        </Card>

        {hideStaff ? null : (
        <Card size="sm" data-section="staff">
          <CardContent className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("staffTitle")}</h3>
            {overview.staff.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("staffEmpty")}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs">
                    <th scope="col" className="text-left font-normal" />
                    <th scope="col" className="text-right font-normal">{t("staffItems")}</th>
                    <th scope="col" className="text-right font-normal">{t("staffAmount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.staff.map((s, i) => (
                    <tr key={`${i}-${s.displayName}`}>
                      <th scope="row" className="py-0.5 text-left font-normal">{s.displayName}</th>
                      <td className="text-right tabular-nums">{s.completedItems}</td>
                      <td className="text-right tabular-nums">{money(s.serviceAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {overview.services.discountTotal > 0 ? <p className="text-muted-foreground text-xs">{t("staffDiscountNote", { amount: money(overview.services.discountTotal) })}</p> : null}
          </CardContent>
        </Card>
        )}
      </div>

      {overview.currencyMixed ? (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
          {t("currencyMixed")}
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">{t("footnote")}</p>
    </section>
  );
}
