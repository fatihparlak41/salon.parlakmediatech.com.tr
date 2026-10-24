"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { parseCustomerHistory, type CustomerHistory, type HistoryAppointment } from "@/lib/modules/customers/import-model";

const STATUS_TR: Record<string, string> = {
  scheduled: "Planlandı",
  confirmed: "Onaylandı",
  in_progress: "Devam ediyor",
  completed: "Tamamlandı",
  cancelled: "İptal",
  no_show: "Gelmedi",
};

function formatWhen(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(date);
}

function money(amount: number, currency: string): string {
  return `${amount.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

/** Pure view of one history answer (exported for tests); the money columns exist only when the model carries them. */
export function CustomerHistoryView({ history }: { history: CustomerHistory }) {
  const s = history.summary;
  const currency = history.finance?.currency ?? "TRY";
  const row = (a: HistoryAppointment, i: number) => (
    <li key={`${a.startAt}-${i}`} className="flex flex-col gap-0.5 border-t py-2 first:border-t-0" data-status={a.status}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{formatWhen(a.startAt, history.timezone)}</span>
        <span className="text-muted-foreground text-xs">{STATUS_TR[a.status] ?? a.status}</span>
      </div>
      <span className="text-sm">
        {a.items.map((it) => (it.staff ? `${it.service} — ${it.staff}` : it.service)).join(", ") || "—"}
      </span>
      {a.money ? (
        <span className="text-muted-foreground text-xs tabular-nums">
          {a.status === "completed" || a.money.hasCheckout
            ? a.money.hasCheckout
              ? `Tutar ${money(a.money.amount, currency)} · Tahsil ${money(a.money.paid ?? 0, currency)}${(a.money.outstanding ?? 0) > 0 ? ` · Kalan ${money(a.money.outstanding ?? 0, currency)}` : ""}`
              : `Liste fiyatı ${money(a.money.amount, currency)} · ödeme kaydı açılmadı`
            : `Liste fiyatı ${money(a.money.amount, currency)}`}
        </span>
      ) : null}
    </li>
  );

  return (
    <div className="flex flex-col gap-5" data-testid="customer-history">
      <section aria-label="Özet" className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border p-3" data-metric="lastVisit">
          <div className="text-sm font-semibold">{s.lastVisitAt ? formatWhen(s.lastVisitAt, history.timezone) : "—"}</div>
          <div className="text-muted-foreground text-xs">Son ziyaret</div>
        </div>
        <div className="rounded-lg border p-3" data-metric="completed">
          <div className="text-xl font-semibold tabular-nums">{s.completedVisits}</div>
          <div className="text-muted-foreground text-xs">Tamamlanan ziyaret</div>
        </div>
        <div className="rounded-lg border p-3" data-metric="upcoming">
          <div className="text-xl font-semibold tabular-nums">{s.upcoming}</div>
          <div className="text-muted-foreground text-xs">Yaklaşan randevu</div>
        </div>
      </section>
      {s.cancelled + s.noShow > 0 ? (
        <p className="text-muted-foreground text-xs">
          {s.cancelled} iptal · {s.noShow} gelmedi
        </p>
      ) : null}

      {history.finance ? (
        <section aria-label="Finans" className="rounded-lg border p-3 text-sm" data-section="finance">
          <div>
            Tamamlanan işlem tutarı: <span className="font-semibold tabular-nums">{money(history.finance.completedAmount, currency)}</span>
          </div>
          <div>
            Bekleyen tahsilat: <span className="font-semibold tabular-nums">{money(history.finance.outstanding, currency)}</span>
          </div>
          {history.finance.completedWithoutCheckout > 0 ? (
            <div className="text-muted-foreground text-xs">{history.finance.completedWithoutCheckout} ziyaretin ödeme kaydı açılmadı.</div>
          ) : null}
        </section>
      ) : null}

      <section aria-label="Yaklaşan randevular">
        <h3 className="mb-1 text-sm font-semibold">Yaklaşan</h3>
        {history.upcoming.length === 0 ? <p className="text-muted-foreground text-sm">Yaklaşan randevu yok.</p> : <ul>{history.upcoming.map(row)}</ul>}
      </section>

      <section aria-label="Geçmiş">
        <h3 className="mb-1 text-sm font-semibold">Geçmiş</h3>
        {history.past.length === 0 ? <p className="text-muted-foreground text-sm">Henüz geçmiş randevu yok.</p> : <ul>{history.past.map(row)}</ul>}
        {history.hasMorePast ? <p className="text-muted-foreground mt-1 text-xs">Daha eski randevular var; en yeni {history.past.length} gösteriliyor.</p> : null}
      </section>

      {history.servicesReceived.length > 0 ? (
        <section aria-label="Alınan hizmetler">
          <h3 className="mb-1 text-sm font-semibold">Alınan hizmetler</h3>
          <ul className="text-sm">
            {history.servicesReceived.map((x) => (
              <li key={x.service}>
                {x.service} × {x.count}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {history.staff.length > 0 ? (
        <section aria-label="İşlemi yapanlar">
          <h3 className="mb-1 text-sm font-semibold">İşlemi yapan</h3>
          <ul className="text-sm">
            {history.staff.map((x) => (
              <li key={x.displayName}>
                {x.displayName} × {x.count}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function CustomerHistoryTab({ customerId }: { customerId: string }) {
  const [history, setHistory] = useState<CustomerHistory | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "failed">("loading");

  useEffect(() => {
    let cancelled = false;
    createClient()
      .rpc("get_customer_history", { p_customer_id: customerId, p_limit: 50 })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setState(error.code === "CH002" || error.code === "42501" ? "denied" : "failed");
          return;
        }
        const parsed = parseCustomerHistory(data);
        if (!parsed) {
          setState("failed");
          return;
        }
        setHistory(parsed);
        setState("ready");
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  if (state === "loading") {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (state === "denied") return <p className="text-muted-foreground text-sm">Bu müşterinin geçmişini görüntüleme yetkiniz yok.</p>;
  if (state === "failed" || !history) return <p className="text-destructive text-sm" role="alert">Geçmiş şu an okunamadı. Lütfen tekrar deneyin.</p>;
  return <CustomerHistoryView history={history} />;
}
