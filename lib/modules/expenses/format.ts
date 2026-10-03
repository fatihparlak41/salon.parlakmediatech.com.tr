import type { ExpenseLabels } from "./labels";
import type {
  ExpenseCategoryKind,
  ExpensePaymentMethod,
  ExpenseStatus,
} from "./types";

/** Replaces {name} placeholders; an unknown placeholder is left as written. */
export function fillTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/** "2026-09-01" (or "2026-09") → "Eylül 2026". Pure UTC arithmetic: no timezone can shift the month. */
export function monthTitle(isoMonth: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(isoMonth);
  if (!match) return isoMonth;
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, 1),
  ).toLocaleDateString("tr-TR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function categoryLabel(labels: ExpenseLabels, key: string): string {
  return (labels.categories as Record<string, string>)[key] ?? key;
}

export function kindLabel(
  labels: ExpenseLabels,
  kind: ExpenseCategoryKind,
): string {
  return labels.kind[kind];
}

export function statusLabel(
  labels: ExpenseLabels,
  status: ExpenseStatus,
): string {
  return labels.status[status];
}

export function methodLabel(
  labels: ExpenseLabels,
  method: ExpensePaymentMethod | string,
): string {
  return (labels.methods as Record<string, string>)[method] ?? method;
}

/** "250.5" → "250,50": how a canonical amount is shown inside an editable field. */
export function toEditableAmount(amount: number): string {
  return amount.toFixed(2).replace(".", ",");
}
