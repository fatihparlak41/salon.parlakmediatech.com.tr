// @vitest-environment jsdom
/**
 * Faz FIN.2A — the parsing and the presentation of the daily overview. Isolated: no Supabase, no network. The block
 * must show exactly what the read model gave (no arithmetic), name the different numbers differently, never call the
 * cash difference profit, and refuse a malformed or self-contradictory answer instead of showing zeros.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import trMessages from "@/messages/tr.json";
import { DailyOwnerOverview } from "@/components/dashboard/daily-owner-overview";
import { parseDailyOverview, formatOverviewDate } from "@/lib/modules/finance-daily/model";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error("a real Supabase client was requested — this file must never touch Supabase");
  }),
}));
vi.mock("@/lib/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function raw(overrides: Record<string, unknown> = {}) {
  return {
    date: "2026-10-10",
    timezone: "Europe/Nicosia",
    currency: "TRY",
    currencyMixed: false,
    scope: "tenant",
    appointments: { total: 9, scheduled: 1, confirmed: 1, inProgress: 0, completed: 5, cancelled: 1, noShow: 1 },
    services: { completedAmount: 5000, completedWithCheckout: 4, completedWithoutCheckout: 1, withoutCheckoutAmount: 500, discountTotal: 100 },
    payments: { totalCollected: 4100, count: 7, cash: 2000, card: 1900, bankTransfer: 200, other: 0, voidedCount: 1, voidedAmount: 50 },
    outstanding: { supported: true, amount: 1100, count: 2, todayAmount: 800 },
    expenses: { accruedTotal: 3650, accruedCount: 3, paidOutTotal: 1950, paidOutCount: 3, paidOutCash: 1500, paidOutCard: 450, paidOutBankTransfer: 0, paidOutOther: 0 },
    cash: { supported: true, cashCollected: 2000, cashPaidOut: 1500, difference: 500 },
    staff: [
      { displayName: "Ayşe Demir", completedAppointments: 4, completedItems: 4, serviceAmount: 4000 },
      { displayName: "Mehmet Kaya", completedAppointments: 2, completedItems: 2, serviceAmount: 1100 },
    ],
    staffServiceAmountTotal: 5100,
    unsupported: ["refunds", "personnelPayments", "profit"],
    ...overrides,
  };
}

function view(overrides: Record<string, unknown> = {}) {
  const parsed = parseDailyOverview(raw(overrides));
  if (!parsed) throw new Error("fixture must parse");
  return render(
    <NextIntlClientProvider locale="tr" messages={trMessages}>
      <DailyOwnerOverview overview={parsed} tenantSlug="ornek" />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe("parseDailyOverview", () => {
  it("accepts the database answer and keeps every figure", () => {
    const o = parseDailyOverview(raw())!;
    expect(o.payments.totalCollected).toBe(4100);
    expect(o.cash.difference).toBe(500);
    expect(o.staff).toHaveLength(2);
  });

  it("a negative cash difference is legitimate (more cash out than in); other negatives are not", () => {
    const negative = raw({
      payments: { totalCollected: 100, count: 1, cash: 100, card: 0, bankTransfer: 0, other: 0, voidedCount: 0, voidedAmount: 0 },
      cash: { supported: true, cashCollected: 100, cashPaidOut: 1500, difference: -1400 },
    });
    expect(parseDailyOverview(negative)!.cash.difference).toBe(-1400);
    expect(parseDailyOverview(raw({ services: { completedAmount: -1, completedWithCheckout: 0, completedWithoutCheckout: 0, withoutCheckoutAmount: 0, discountTotal: 0 } }))).toBeNull();
  });

  it("malformed or self-contradictory answers are UNKNOWN, never zeros", () => {
    const bad: unknown[] = [
      null,
      "x",
      [],
      raw({ date: 20261010 }),
      raw({ appointments: null }),
      raw({ payments: { totalCollected: 4100, count: 7, cash: 2000, card: 1900, bankTransfer: 200, other: 5, voidedCount: 0, voidedAmount: 0 } }), // methods do not add up
      raw({ cash: { supported: true, cashCollected: 2000, cashPaidOut: 1500, difference: 400 } }), // difference wrong
      raw({ cash: { supported: true, cashCollected: 1999, cashPaidOut: 1500, difference: 499 } }), // not the cash payments
      raw({ cash: { supported: false, cashCollected: 2000, cashPaidOut: 1500, difference: 500 } }),
      raw({ expenses: { accruedTotal: 1, accruedCount: 1, paidOutTotal: 10, paidOutCount: 1, paidOutCash: 1, paidOutCard: 1, paidOutBankTransfer: 0, paidOutOther: 0 } }),
      raw({ staff: [{ displayName: 5 }] }),
      raw({ staff: "none" }),
      raw({ staffServiceAmountTotal: "5100" }),
      raw({ outstanding: { amount: Number.NaN, count: 1, todayAmount: 0 } }),
    ];
    for (const b of bad) expect(parseDailyOverview(b), JSON.stringify(b)?.slice(0, 80)).toBeNull();
  });

  it("formats a calendar date without ever passing through a Date", () => {
    expect(formatOverviewDate("2026-10-10")).toBe("10.10.2026");
    expect(formatOverviewDate("garbage")).toBe("garbage");
  });
});

describe("DailyOwnerOverview", () => {
  it("shows the seven metrics with the Owner-facing Turkish names, as given", () => {
    const { container } = view();
    const metric = (key: string) => container.querySelector(`[data-metric="${key}"]`) as HTMLElement;
    expect(within(metric("appointments")).getByText("Bugünkü randevular")).toBeTruthy();
    expect(metric("appointments").textContent).toContain("9");
    expect(metric("completed").textContent).toContain("5");
    expect(within(metric("serviceAmount")).getByText("Tamamlanan işlem tutarı")).toBeTruthy();
    expect(metric("serviceAmount").textContent).toContain("5.000,00 TRY");
    expect(within(metric("collected")).getByText("Tahsil edilen")).toBeTruthy();
    expect(metric("collected").textContent).toContain("4.100,00 TRY");
    expect(within(metric("outstanding")).getByText("Bekleyen tahsilat")).toBeTruthy();
    expect(metric("outstanding").textContent).toContain("1.100,00 TRY");
    expect(metric("expense").textContent).toContain("3.650,00 TRY");
    expect(within(metric("cashDifference")).getByText("Günlük nakit farkı")).toBeTruthy();
    expect(metric("cashDifference").textContent).toContain("500,00 TRY");
  });

  it("explains the difference between value, received money and outstanding in the notes", () => {
    const { container } = view();
    expect(container.textContent).toContain("1 işlemin ödeme kaydı açılmadı (500,00 TRY, liste fiyatı)");
    expect(container.textContent).toContain("Bugün ödenen: 1.950,00 TRY");
    expect(container.textContent).toContain("Nakit tahsilat 2.000,00 TRY − nakit ödeme 1.500,00 TRY");
  });

  it("without unrecorded checkouts the value note says it is not money received", () => {
    const { container } = view({ services: { completedAmount: 4500, completedWithCheckout: 4, completedWithoutCheckout: 0, withoutCheckoutAmount: 0, discountTotal: 100 } });
    expect(container.textContent).toContain("Hizmet bedeli; alınan para değildir");
    expect(container.textContent).not.toContain("ödeme kaydı açılmadı");
  });

  it("shows the per-method breakdown from the model (collected and paid out side by side)", () => {
    const { container } = view();
    const row = (m: string) => container.querySelector(`[data-method="${m}"]`)!.textContent!;
    expect(row("cash")).toContain("2.000,00 TRY");
    expect(row("cash")).toContain("1.500,00 TRY");
    expect(row("card")).toContain("1.900,00 TRY");
    expect(row("transfer")).toContain("200,00 TRY");
    expect(row("other")).toContain("0,00 TRY");
    expect(container.textContent).toContain("Bugün iptal edilen 1 ödeme (50,00 TRY) toplama dahil değildir");
  });

  it("lists the staff with item counts and amounts, and says the discount is not split between people", () => {
    const { container } = view();
    const staff = container.querySelector('[data-section="staff"]')!;
    expect(staff.textContent).toContain("Ayşe Demir");
    expect(staff.textContent).toContain("4.000,00 TRY");
    expect(staff.textContent).toContain("Mehmet Kaya");
    expect(staff.textContent).toContain("Tutarlar indirim öncesidir; 100,00 TRY indirim kişilere paylaştırılmaz");
  });

  it("never calls anything profit; says it is not accounting; links only to existing authorised screens", () => {
    const { container } = view();
    expect(container.textContent!.toLowerCase()).not.toMatch(/kâr(?! değildir)/);
    expect(container.textContent).toContain("Bu bir muhasebe raporu değildir");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href")).sort();
    expect(hrefs).toEqual(["/app/ornek/appointments", "/app/ornek/appointments", "/app/ornek/finance/expenses"]);
  });

  it("a mixed-currency warning appears only when the model says so; an empty day shows an empty staff line", () => {
    expect(view().container.textContent).not.toContain("para biriminden farklı");
    cleanup();
    expect(view({ currencyMixed: true }).container.textContent).toContain("para biriminden farklı");
    cleanup();
    expect(view({ staff: [], staffServiceAmountTotal: 0 }).container.textContent).toContain("Bugün tamamlanan işlem yok");
  });

  it("renders no identifier", () => {
    const { container } = view();
    expect(container.innerHTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
