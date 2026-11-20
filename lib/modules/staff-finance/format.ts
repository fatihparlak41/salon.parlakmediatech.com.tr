import type { StaffFinanceLabels } from "./labels";
import type { StaffLifecycle, StaffPaymentState } from "./types";

/** Replaces {name} placeholders; an unknown placeholder is left as written. */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

/** "2026-09-01" (or "2026-09") → "Eylül 2026". Pure UTC arithmetic: no timezone can shift the month. */
export function monthTitle(isoMonth: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(isoMonth);
  if (!match) return isoMonth;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleDateString("tr-TR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function kindLabel(labels: StaffFinanceLabels, kind: string): string {
  return (labels.kinds as Record<string, string>)[kind] ?? kind;
}

export function groupLabel(labels: StaffFinanceLabels, group: string): string {
  return (labels.groups as Record<string, string>)[group] ?? group;
}

export function purposeLabel(labels: StaffFinanceLabels, purpose: string): string {
  return (labels.purposes as Record<string, string>)[purpose] ?? purpose;
}

export function methodLabel(labels: StaffFinanceLabels, method: string): string {
  return (labels.methods as Record<string, string>)[method] ?? method;
}

export function lifecycleLabel(labels: StaffFinanceLabels, lifecycle: StaffLifecycle | string): string {
  return (labels.lifecycle as Record<string, string>)[lifecycle] ?? lifecycle;
}

export function paymentStateLabel(labels: StaffFinanceLabels, state: StaffPaymentState | "overdue" | string): string {
  return (labels.paymentState as Record<string, string>)[state] ?? state;
}

/** "250.5" → "250,50": how a canonical amount is shown inside an editable field. */
export function toEditableAmount(amount: number): string {
  return amount.toFixed(2).replace(".", ",");
}
