import { Link } from "@/lib/i18n/navigation";
import { formatMoney } from "@/lib/modules/expenses/money";
import { describeRule, type CommissionDetail, type CommissionSummary } from "@/lib/modules/commission/model";

function dateTr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/**
 * Faz COMM.1A — presentational only. Every figure is the database's; nothing is added or rounded here. Personel are listed with the
 * completed service count, the service amount and the commission; a person with work but no rule shows 0,00 (never an error).
 */
export function CommissionSummaryView({
  summary,
  basePath,
  selectedStaffId,
  query,
}: {
  summary: CommissionSummary;
  basePath: string;
  selectedStaffId: string | null;
  query: string;
}) {
  const money = (n: number) => formatMoney(n, summary.currency);
  return (
    <section className="flex flex-col gap-3" aria-label="Personel komisyonları">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Personel komisyonları</h2>
        <span className="text-muted-foreground text-xs">
          {summary.from === summary.to ? dateTr(summary.from) : `${dateTr(summary.from)} – ${dateTr(summary.to)}`}
        </span>
      </div>
      {summary.staff.length === 0 ? (
        <p className="text-muted-foreground text-sm">Bu aralıkta tamamlanan işlem yok.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="commission-table">
            <thead>
              <tr className="text-muted-foreground text-left text-xs">
                <th scope="col" className="pr-3 font-normal">Personel</th>
                <th scope="col" className="pr-3 text-right font-normal">Tamamlanan işlem</th>
                <th scope="col" className="pr-3 text-right font-normal">İşlem tutarı</th>
                <th scope="col" className="text-right font-normal">Komisyon</th>
              </tr>
            </thead>
            <tbody>
              {summary.staff.map((s) => (
                <tr key={s.staffId} className="border-t" data-selected={s.staffId === selectedStaffId ? "true" : undefined}>
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    <Link href={`${basePath}?${query}${query ? "&" : ""}staff=${s.staffId}`} className="underline underline-offset-4">
                      {s.displayName}
                    </Link>
                  </th>
                  <td className="pr-3 text-right tabular-nums">{s.completedServices}</td>
                  <td className="pr-3 text-right tabular-nums">{money(s.serviceAmount)}</td>
                  <td className="text-right font-medium tabular-nums">{money(s.commissionAmount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-1.5 pr-3">Toplam</td>
                <td className="pr-3 text-right tabular-nums">{summary.totals.completedServices}</td>
                <td className="pr-3 text-right tabular-nums">{money(summary.totals.serviceAmount)}</td>
                <td className="text-right tabular-nums">{money(summary.totals.commissionAmount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        Komisyon, tamamlanan hizmetlerin tutarı üzerinden hesaplanır; tahsilat yöntemi ve ödeme durumu komisyonu değiştirmez. Satış düzeyindeki indirim komisyondan düşülmez. Bu bir bordro değildir.
      </p>
    </section>
  );
}

export function CommissionDetailView({ detail }: { detail: CommissionDetail }) {
  const money = (n: number) => formatMoney(n, detail.currency);
  return (
    <section className="flex flex-col gap-2" aria-label={`${detail.displayName} komisyon dökümü`} data-testid="commission-detail">
      <h2 className="text-base font-semibold">{detail.displayName} — döküm</h2>
      {detail.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Bu aralıkta tamamlanan işlem yok.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground text-left text-xs">
                <th scope="col" className="pr-3 font-normal">Tarih</th>
                <th scope="col" className="pr-3 font-normal">Hizmet</th>
                <th scope="col" className="pr-3 text-right font-normal">Hizmet tutarı</th>
                <th scope="col" className="pr-3 font-normal">Kural</th>
                <th scope="col" className="text-right font-normal">Komisyon</th>
              </tr>
            </thead>
            <tbody>
              {detail.rows.map((r, i) => (
                <tr key={`${r.date}-${r.service}-${i}`} className="border-t">
                  <td className="py-1 pr-3 tabular-nums">{dateTr(r.date)}</td>
                  <td className="pr-3">
                    {r.service}
                    {r.saleDiscount ? <span className="text-muted-foreground ml-1 text-xs">(satışta indirim var, düşülmedi)</span> : null}
                  </td>
                  <td className="pr-3 text-right tabular-nums">{money(r.serviceValue)}</td>
                  <td className="pr-3">{describeRule(r.rule, detail.currency)}</td>
                  <td className="text-right tabular-nums">{money(r.commission)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-1 pr-3" colSpan={2}>Toplam</td>
                <td className="pr-3 text-right tabular-nums">{money(detail.total.serviceAmount)}</td>
                <td />
                <td className="text-right tabular-nums">{money(detail.total.commissionAmount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {detail.hasMore ? <p className="text-muted-foreground text-xs">Liste kısaltıldı; toplam tüm satırları içerir. Aralığı daraltın.</p> : null}
    </section>
  );
}
