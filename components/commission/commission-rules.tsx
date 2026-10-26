"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setCommissionRuleAction } from "@/lib/modules/commission/actions";
import { describeRule, parseRuleValue, type CommissionRules } from "@/lib/modules/commission/model";

const selectClass = "border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm";

/**
 * Faz COMM.1A — the Owner's configuration: one rule per person + service (none / percentage / fixed), effective from a date
 * (default today). Rules already in force are listed; a person or service without a rule earns no commission. Changing a rule
 * never rewrites past totals (rules are effective-dated).
 */
export function CommissionRulesPanel({ tenantId, tenantSlug, rules, currency, canManage }: { tenantId: string; tenantSlug: string; rules: CommissionRules; currency: string; canManage: boolean }) {
  const router = useRouter();
  const [staffId, setStaffId] = useState(rules.staff[0]?.id ?? "");
  const [serviceId, setServiceId] = useState(rules.services[0]?.id ?? "");
  const [kind, setKind] = useState<"none" | "percentage" | "fixed">("percentage");
  const [value, setValue] = useState("");
  const [from, setFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    setSaved(false);
    let numeric: number | null = null;
    if (kind !== "none") {
      numeric = parseRuleValue(value);
      if (numeric === null) {
        setError(kind === "percentage" ? "Yüzde için geçerli bir sayı girin (en fazla 2 ondalık)." : "Tutar için geçerli bir sayı girin (en fazla 2 ondalık).");
        return;
      }
      if (kind === "percentage" && numeric > 100) {
        setError("Yüzde 0 ile 100 arasında olmalı.");
        return;
      }
    }
    startTransition(async () => {
      const res = await setCommissionRuleAction(null, { tenantId, tenantSlug, staffId, serviceId, kind, value: numeric, effectiveFrom: from || null });
      if (!res.success) {
        setError(res.error.message);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label="Komisyon kuralları">
      <h2 className="text-base font-semibold">Komisyon kuralları</h2>
      {rules.rules.length === 0 ? (
        <p className="text-muted-foreground text-sm">Tanımlı komisyon kuralı yok; tüm personel için komisyon 0,00.</p>
      ) : (
        <ul className="text-sm" data-testid="rule-list">
          {rules.rules.map((r) => (
            <li key={`${r.staffId}-${r.serviceId}`} className="flex flex-wrap justify-between gap-2 border-t py-1 first:border-t-0">
              <span>
                {r.staffName} · {r.serviceName}
              </span>
              <span className="tabular-nums">{describeRule({ kind: r.kind, percentage: r.percentage, fixedAmount: r.fixedAmount }, currency)}</span>
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cm-staff">Personel</Label>
            <select id="cm-staff" className={selectClass} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              {rules.staff.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cm-service">Hizmet</Label>
            <select id="cm-service" className={selectClass} value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              {rules.services.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cm-kind">Komisyon türü</Label>
            <select id="cm-kind" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="percentage">Yüzde</option>
              <option value="fixed">Sabit tutar (işlem başına)</option>
              <option value="none">Komisyon yok</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cm-value">{kind === "percentage" ? "Yüzde" : kind === "fixed" ? `Tutar (${currency})` : "Değer"}</Label>
            <Input id="cm-value" inputMode="decimal" disabled={kind === "none"} value={kind === "none" ? "" : value} onChange={(e) => setValue(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cm-from">Geçerlilik başlangıcı (boşsa bugün)</Label>
            <Input id="cm-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={pending || !staffId || !serviceId}>
              {pending ? "Kaydediliyor…" : "Kuralı kaydet"}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? <p className="text-sm text-emerald-700 dark:text-emerald-400">Kural kaydedildi.</p> : null}
      <p className="text-muted-foreground text-xs">Kural, belirtilen tarihten itibaren yapılan işlemlere uygulanır; geçmiş toplamlar kendiliğinden değişmez. Kuralı olmayan personelin komisyonu 0,00 olur.</p>
    </section>
  );
}
