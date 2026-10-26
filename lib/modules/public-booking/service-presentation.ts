/**
 * Faz BEAUTY.1A — pure presentation rules for the public booking page. No React, no I/O: everything the page decides about a
 * service (price line, duration line, whether it can be booked, whether it has an information step) and about the staff step
 * lives here so it is unit-tested once and the component only renders.
 */
import type { PublicBookingService, PublicBookingStaffOption } from "./client-queries";

const nf = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** "2.000 ₺" - whole liras without decimals, otherwise two decimals; never rounds a value to a different amount. */
export function formatPublicPrice(price: number): string {
  const s = Number.isInteger(price) ? nf.format(price) : price.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${s} ₺`;
}

export type PriceLine = { kind: "price"; text: string } | { kind: "inquiry" } | { kind: "none" };

/** Fixed + shown -> the amount; inquiry -> the inquiry wording (never an amount, never 0); fixed but not shown -> nothing. */
export function priceLine(s: Pick<PublicBookingService, "pricingMode" | "price">): PriceLine {
  if (s.pricingMode === "inquiry") return { kind: "inquiry" };
  if (s.price === null || s.price === undefined) return { kind: "none" };
  return { kind: "price", text: formatPublicPrice(s.price) };
}

/** "30–40 dk", "40 dk", or null when the salon configured no display duration (nothing is derived from the calendar duration). */
export function durationLine(s: Pick<PublicBookingService, "displayDurationMin" | "displayDurationMax">, unit: string): string | null {
  const min = s.displayDurationMin;
  const max = s.displayDurationMax;
  if (min === null || min === undefined) return null;
  if (max === null || max === undefined || max === min) return `${min} ${unit}`;
  return `${min}–${max} ${unit}`;
}

export function isDirectlyBookable(s: Pick<PublicBookingService, "bookingMode">): boolean {
  return s.bookingMode === "direct";
}

/** The information step exists only when the salon wrote something beyond the card line; otherwise the flow is exactly as before. */
export function hasServiceInfo(s: Pick<PublicBookingService, "details" | "preparationNote" | "aftercareNote" | "importantNote">): boolean {
  return !!(s.details || s.preparationNote || s.aftercareNote || s.importantNote);
}

export type StaffStep = { kind: "auto"; staffId: string } | { kind: "choose" } | { kind: "none" };

/** Exactly one eligible person -> select them and skip the step; several -> the normal choice; none -> not bookable. */
export function resolveStaffStep(options: PublicBookingStaffOption[]): StaffStep {
  if (options.length === 1) return { kind: "auto", staffId: options[0]!.id };
  if (options.length === 0) return { kind: "none" };
  return { kind: "choose" };
}
