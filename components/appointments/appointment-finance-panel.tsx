"use client";

import { useEffect, useState, useActionState, startTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import {
  fetchAppointmentFinanceSummary,
  type AppointmentFinanceSummary,
  type AppointmentSalePayment,
} from "@/lib/modules/finance/client-queries";
import {
  getOrCreateAppointmentSaleAction,
  recordAppointmentPaymentAction,
  voidAppointmentPaymentAction,
  adjustAppointmentSaleItemPriceAction,
  adjustAppointmentSaleDiscountAction,
  type RecordAppointmentPaymentInput,
} from "@/lib/modules/finance/actions";

const STATUS_LABELS_TR: Record<AppointmentFinanceSummary["status"], string> = {
  open: "Ödenmedi",
  partially_paid: "Kısmi Ödendi",
  paid: "Ödendi",
  voided: "İptal",
};

const STATUS_BADGE_VARIANT: Record<AppointmentFinanceSummary["status"], "default" | "secondary" | "destructive" | "outline"> = {
  open: "outline",
  partially_paid: "default",
  paid: "secondary",
  voided: "destructive",
};

const METHOD_LABELS_TR: Record<string, string> = {
  cash: "Nakit",
  card: "Kart",
  bank_transfer: "Havale/EFT",
  other: "Diğer",
};

function formatMoney(amount: number, currency: string): string {
  return `${amount.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

/**
 * Faz FIN.1A — the appointment detail sheet's "Tahsilat" tab. Only ever
 * rendered when the caller holds finance.view (see appointment-detail-
 * sheet.tsx) — canManage further gates the mutating controls
 * (Ödeme Al / Fiyat-İndirim Düzenle / İptal Et), mirroring canUpdate/
 * canCancel's own split for the Detaylar tab. Every mutation re-fetches
 * the whole summary from the read RPC afterward rather than trusting a
 * locally-patched value, same "reload from source of truth" convention
 * StatusActions/CompletionPanel already use elsewhere in this file's
 * sibling component.
 */
export function AppointmentFinancePanel({
  appointmentId,
  canManage,
  isCompleted,
}: {
  appointmentId: string;
  canManage: boolean;
  // Faz FIN.1A Owner review — the completed-only checkout gate. Opening
  // this tab must NEVER itself be a financial write: the lazy
  // get_or_create_appointment_sale call below only ever fires once BOTH
  // canManage AND isCompleted hold, mirroring the DB's own FN010 gate
  // (private.get_or_create_appointment_sale refuses a non-completed
  // appointment) — this is a UX convenience that avoids a round trip
  // the server would reject anyway, not the real enforcement boundary.
  isCompleted: boolean;
}) {
  const [summary, setSummary] = useState<AppointmentFinanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [showAdjustPanel, setShowAdjustPanel] = useState(false);

  async function reload() {
    const result = await fetchAppointmentFinanceSummary(appointmentId);
    setSummary(result);
  }

  useEffect(() => {
    // No setLoading(true) here: this panel is only ever mounted fresh
    // (AppointmentDetailBody keys its whole subtree on appointmentId, so
    // a different appointment is a full remount) — `loading`'s own
    // useState(true) initializer already covers it, avoiding a
    // synchronous setState-in-effect call.
    let active = true;
    (async () => {
      // Lazy creation: opening this tab as a finance.manage holder on an
      // ALREADY-COMPLETED appointment IS the "first real use" the spec
      // means by lazy creation. A finance.view-only visitor (canManage
      // false) or a non-completed appointment never triggers it — both
      // fall through to the plain read below, which is null-safe for
      // "no sale yet" (see fetchAppointmentFinanceSummary's own doc).
      if (canManage && isCompleted) {
        await getOrCreateAppointmentSaleAction(null, { appointmentId });
      }
      const result = await fetchAppointmentFinanceSummary(appointmentId);
      if (active) {
        setSummary(result);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [appointmentId, canManage, isCompleted]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!summary) {
    return (
      <p className="text-muted-foreground text-sm">
        {isCompleted ? "Henüz bir tahsilat işlemi başlatılmadı." : "Randevu tamamlandıktan sonra tahsilat başlatılabilir."}
      </p>
    );
  }

  const isVoided = summary.status === "voided";
  const canAct = canManage && isCompleted;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Tahsilat</p>
        <Badge variant={STATUS_BADGE_VARIANT[summary.status]}>{STATUS_LABELS_TR[summary.status]}</Badge>
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg border p-3 text-sm">
        <Row label="İşlem Tutarı" value={formatMoney(summary.subtotal, summary.currency)} />
        <Row label="İndirim" value={formatMoney(summary.discountAmount, summary.currency)} />
        <Row label="Toplam" value={formatMoney(summary.totalAmount, summary.currency)} strong />
        <Row label="Tahsil Edilen" value={formatMoney(summary.collected, summary.currency)} />
        <Row label="Kalan" value={formatMoney(summary.outstanding, summary.currency)} strong />
      </div>

      {canAct && !isVoided && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={summary.outstanding <= 0} onClick={() => setShowPaymentDialog(true)}>
            Ödeme Al
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setShowAdjustPanel((v) => !v)}>
            Fiyat / İndirim Düzenle
          </Button>
        </div>
      )}

      {showAdjustPanel && canAct && (
        <AdjustPanel
          summary={summary}
          onClose={() => setShowAdjustPanel(false)}
          onSaved={async () => {
            setShowAdjustPanel(false);
            await reload();
          }}
        />
      )}

      {summary.payments.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Ödemeler</p>
          {summary.payments.map((p) => (
            <PaymentRow key={p.id} payment={p} currency={summary.currency} canManage={canAct} onVoided={reload} />
          ))}
        </div>
      )}

      {canAct && (
        <PaymentDialog
          open={showPaymentDialog}
          onOpenChange={setShowPaymentDialog}
          saleId={summary.id}
          currency={summary.currency}
          outstanding={summary.outstanding}
          onRecorded={async () => {
            setShowPaymentDialog(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{value}</span>
    </div>
  );
}

function PaymentRow({
  payment,
  currency,
  canManage,
  onVoided,
}: {
  payment: AppointmentSalePayment;
  currency: string;
  canManage: boolean;
  onVoided: () => void;
}) {
  const [showVoidForm, setShowVoidForm] = useState(false);
  const [reason, setReason] = useState("");
  const [state, action, isPending] = useActionState(
    async (prevState: ActionResult<null> | null, input: { paymentId: string; reason: string }) => {
      const result = await voidAppointmentPaymentAction(prevState, input);
      if (result.success) onVoided();
      return result;
    },
    null,
  );

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border p-2.5 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className={payment.status === "voided" ? "text-muted-foreground line-through" : "font-medium"}>
          {formatMoney(payment.amount, currency)} · {METHOD_LABELS_TR[payment.method] ?? payment.method}
        </span>
        <span className="text-muted-foreground text-xs whitespace-nowrap">
          {new Date(payment.paidAt).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })}
        </span>
      </div>
      {payment.status === "voided" && payment.voidReason && (
        <p className="text-muted-foreground text-xs">İptal nedeni: {payment.voidReason}</p>
      )}
      {canManage && payment.status === "posted" && !showVoidForm && (
        <Button type="button" size="sm" variant="ghost" className="h-auto w-fit p-0 text-xs" onClick={() => setShowVoidForm(true)}>
          İptal Et
        </Button>
      )}
      {showVoidForm && (
        <div className="flex flex-col gap-1.5 pt-1">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="İptal nedeni"
            className="h-8 text-xs"
            maxLength={500}
          />
          {state && !state.success && (
            <p className="text-destructive text-xs" role="alert">
              {state.error.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={isPending || !reason.trim()}
              onClick={() => startTransition(() => action({ paymentId: payment.id, reason: reason.trim() }))}
            >
              {isPending ? "İptal ediliyor…" : "Ödemeyi İptal Et"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={isPending} onClick={() => setShowVoidForm(false)}>
              Vazgeç
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PaymentDialog({
  open,
  onOpenChange,
  saleId,
  currency,
  outstanding,
  onRecorded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saleId: string;
  currency: string;
  outstanding: number;
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState(() => outstanding.toFixed(2));
  const [method, setMethod] = useState<"cash" | "card" | "bank_transfer" | "other">("cash");
  const [note, setNote] = useState("");
  // Stable for the lifetime of this open dialog instance — a failed
  // submit retried by the same click-through reuses it (safe retry);
  // closing and reopening the dialog remounts it with a fresh key,
  // exactly matching booking-wizard.tsx's own idempotencyKey reasoning.
  const [idempotencyKey] = useState(() => (typeof crypto !== "undefined" ? crypto.randomUUID() : ""));

  const [state, action, isPending] = useActionState(
    async (prevState: ActionResult<{ id: string }> | null, input: RecordAppointmentPaymentInput) => {
      const result = await recordAppointmentPaymentAction(prevState, input);
      if (result.success) onRecorded();
      return result;
    },
    null,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(() =>
      action({
        saleId,
        amount: Number(amount),
        method,
        paidAt: new Date().toISOString(),
        note: note.trim() || undefined,
        idempotencyKey,
      }),
    );
  }

  const amountValid = Number(amount) > 0 && Number.isFinite(Number(amount));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Ödeme Al</DialogTitle>
            <DialogDescription>Kalan: {formatMoney(outstanding, currency)}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment-amount">Tutar ({currency})</Label>
              <Input id="payment-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Yöntem</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Nakit</SelectItem>
                  <SelectItem value="card">Kart</SelectItem>
                  <SelectItem value="bank_transfer">Havale/EFT</SelectItem>
                  <SelectItem value="other">Diğer</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="payment-note">Not (opsiyonel)</Label>
              <Input id="payment-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </div>

            {state && !state.success && (
              <p className="text-destructive text-sm" role="alert">
                {state.error.message}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isPending || !amountValid}>
              {isPending ? "Kaydediliyor…" : "Ödemeyi Kaydet"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AdjustPanel({
  summary,
  onClose,
  onSaved,
}: {
  summary: AppointmentFinanceSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(summary.items.map((i) => [i.id, i.unitPrice.toFixed(2)])),
  );
  const [discount, setDiscount] = useState(summary.discountAmount.toFixed(2));
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sequential, not parallel: each RPC re-locks and re-reads the sale
  // row, so firing them together would just serialize at the DB anyway
  // — doing it here keeps the first real error visible instead of a
  // racy mix of partial results.
  async function handleSave() {
    setPending(true);
    setError(null);

    for (const item of summary.items) {
      const newPrice = prices[item.id];
      if (newPrice === undefined || Number(newPrice) === item.unitPrice) continue;
      const result = await adjustAppointmentSaleItemPriceAction(null, {
        saleItemId: item.id,
        unitPrice: Number(newPrice),
      });
      if (!result.success) {
        setError(result.error.message);
        setPending(false);
        return;
      }
    }

    if (Number(discount) !== summary.discountAmount) {
      const result = await adjustAppointmentSaleDiscountAction(null, {
        saleId: summary.id,
        discountAmount: Number(discount),
        reason: reason.trim() || undefined,
      });
      if (!result.success) {
        setError(result.error.message);
        setPending(false);
        return;
      }
    }

    setPending(false);
    onSaved();
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <p className="text-sm font-medium">Fiyat / İndirim Düzenle</p>

      <div className="flex flex-col gap-2">
        {summary.items.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-2">
            <Label htmlFor={`price-${item.id}`} className="text-xs font-normal">
              {item.serviceName}
            </Label>
            <Input
              id={`price-${item.id}`}
              inputMode="decimal"
              className="h-8 w-28 text-right"
              value={prices[item.id] ?? ""}
              onChange={(e) => setPrices((prev) => ({ ...prev, [item.id]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sale-discount" className="text-xs">
          İndirim ({summary.currency})
        </Label>
        <Input id="sale-discount" inputMode="decimal" className="h-8" value={discount} onChange={(e) => setDiscount(e.target.value)} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="discount-reason" className="text-xs">
          İndirim nedeni (opsiyonel)
        </Label>
        <Input id="discount-reason" className="h-8" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </div>

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={handleSave}>
          {pending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onClose}>
          Vazgeç
        </Button>
      </div>
    </div>
  );
}
