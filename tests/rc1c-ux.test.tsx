// @vitest-environment jsdom
/**
 * RC.1C - the product-QA fixes that change what an owner sees. Isolated (no Supabase, no network): the display date helper, the
 * dashboard money block without its duplicates, the single-provider salon, the grouped service fields and the plain-Turkish copy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import trMessages from "@/messages/tr.json";
import { DailyOwnerOverview } from "@/components/dashboard/daily-owner-overview";
import { parseDailyOverview } from "@/lib/modules/finance-daily/model";
import { ServiceExperienceFields } from "@/components/services/service-experience-fields";
import { emptyExperienceForm } from "@/lib/modules/services/experience";
import { formatTenantLocalDateTime, formatTenantLocalDateTimeDisplay } from "@/lib/modules/appointments/timezone";
import { parseRebookParams, rebookHref } from "@/lib/modules/treatment-history/model";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error("a real Supabase client was requested - this file must never touch Supabase");
  }),
}));
vi.mock("@/lib/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => cleanup());

function overview() {
  const parsed = parseDailyOverview({
    date: "2026-10-26",
    timezone: "Europe/Nicosia",
    currency: "TRY",
    currencyMixed: false,
    scope: "tenant",
    appointments: { total: 3, scheduled: 1, confirmed: 1, inProgress: 0, completed: 1, cancelled: 0, noShow: 0 },
    services: { completedAmount: 2000, completedWithCheckout: 1, completedWithoutCheckout: 0, withoutCheckoutAmount: 0, discountTotal: 0 },
    payments: { totalCollected: 2000, count: 1, cash: 2000, card: 0, bankTransfer: 0, other: 0, voidedCount: 0, voidedAmount: 0 },
    outstanding: { supported: true, amount: 0, count: 0, todayAmount: 0 },
    expenses: { accruedTotal: 0, accruedCount: 0, paidOutTotal: 0, paidOutCount: 0, paidOutCash: 0, paidOutCard: 0, paidOutBankTransfer: 0, paidOutOther: 0 },
    cash: { supported: true, cashCollected: 2000, cashPaidOut: 0, difference: 2000 },
    staff: [{ displayName: "Emel Kaynakkan", completedAppointments: 1, completedItems: 1, serviceAmount: 2000 }],
    staffServiceAmountTotal: 2000,
    unsupported: ["refunds", "personnelPayments", "profit"],
  });
  if (!parsed) throw new Error("fixture must parse");
  return parsed;
}

function renderOverview(props: { hideAppointmentCounts?: boolean; hideStaff?: boolean }) {
  return render(
    <NextIntlClientProvider locale="tr" messages={trMessages}>
      <DailyOwnerOverview overview={overview()} tenantSlug="ornek" {...props} />
    </NextIntlClientProvider>,
  );
}

describe("people read dates the same way everywhere", () => {
  it("26.10.2026 14:00 for the screen, the machine form is unchanged", () => {
    const iso = "2026-10-26T12:00:00.000Z"; // 14:00 in Nicosia (EET, UTC+2 after the October fall-back)
    expect(formatTenantLocalDateTimeDisplay(iso, "Europe/Nicosia")).toBe("26.10.2026 14:00");
    expect(formatTenantLocalDateTime(iso, "Europe/Nicosia")).toBe("2026-10-26 14:00");
  });
  it("follows the salon's clock across the DST change (summer time the day before)", () => {
    expect(formatTenantLocalDateTimeDisplay("2026-10-24T12:00:00.000Z", "Europe/Nicosia")).toBe("24.10.2026 15:00");
    expect(formatTenantLocalDateTimeDisplay("2026-10-25T12:00:00.000Z", "Europe/Nicosia")).toBe("25.10.2026 14:00");
  });
});

describe("dashboard money block", () => {
  it("default: unchanged (appointment counts and the staff table are there, for the other tests and other callers)", () => {
    const { container } = renderOverview({});
    expect(container.querySelector('[data-metric="appointments"]')).not.toBeNull();
    expect(container.querySelector('[data-metric="completed"]')).not.toBeNull();
    expect(container.querySelector('[data-section="staff"]')).not.toBeNull();
  });
  it("on the dashboard the repeated appointment counts are left out; the money cards stay", () => {
    const { container } = renderOverview({ hideAppointmentCounts: true });
    expect(container.querySelector('[data-metric="appointments"]')).toBeNull();
    expect(container.querySelector('[data-metric="completed"]')).toBeNull();
    for (const key of ["serviceAmount", "collected", "outstanding", "expense", "cashDifference"]) expect(container.querySelector(`[data-metric="${key}"]`), key).not.toBeNull();
  });
  it("a one-provider salon gets no one-row staff table; the payment-method table stays", () => {
    const { container } = renderOverview({ hideStaff: true });
    expect(container.querySelector('[data-section="staff"]')).toBeNull();
    expect(container.querySelector('[data-section="methods"]')).not.toBeNull();
  });
  it("the cash difference is never called profit", () => {
    const { container } = renderOverview({});
    expect(container.textContent).not.toMatch(/\bkâr\b(?! değildir)/i);
  });
});

describe("service fields are grouped for an owner, with the same ids", () => {
  it("four plain-language groups, nothing lost", () => {
    const { container } = render(<ServiceExperienceFields value={emptyExperienceForm()} onChange={() => {}} idPrefix="g" />);
    const titles = [...container.querySelectorAll("h4")].map((h) => h.textContent);
    expect(titles).toEqual(["Fiyat ve randevu", "Online sayfada nasıl görünsün?", "Müşteriye notlar", "Tekrar randevu (yalnızca sizin için)"]);
    for (const id of ["pricing", "booking", "dmin", "dmax", "rmin", "rmax", "summary", "badge", "details", "prep", "important", "after"]) {
      expect(container.querySelector(`#g-${id}`), id).not.toBeNull();
    }
  });
  it("the re-booking group says it is internal and sends nothing; aftercare says it is shown, not sent", () => {
    const { container } = render(<ServiceExperienceFields value={emptyExperienceForm()} onChange={() => {}} idPrefix="g" />);
    expect(container.textContent).toContain("müşteriye otomatik mesaj gitmez");
    expect(container.textContent).toContain("müşteriye ayrıca mesaj gönderilmez");
  });
});

describe("plain Turkish", () => {
  it("first screens carry no English or technical words", () => {
    const o = trMessages.Onboarding;
    expect(JSON.stringify(o)).not.toMatch(/owner|URL/);
    expect(trMessages.Settings.selfService.heading).not.toMatch(/Self-Servis/);
    expect(trMessages.Settings.selfService.description).not.toContain("/account");
  });
  it("the single-person hint exists on the staff/service step", () => {
    expect(trMessages.Setup.mapping.singleHint).toContain("tek başınıza");
  });
});

describe("quick rebook keeps the customer it started from", () => {
  const S = "11111111-1111-4111-8111-111111111111";
  const C = "22222222-2222-4222-8222-222222222222";
  it("the link carries only an id, the receiving side keeps it only when well-formed", () => {
    const href = rebookHref("ornek", { serviceId: S, serviceName: "Kaş Laminasyonu", branchId: null, staffId: null }, C);
    expect(href).toBe(`/app/ornek/appointments?rebookService=${S}&rebookCustomer=${C}`);
    expect(href).not.toMatch(/Kaş|@|\+90/);
    expect(parseRebookParams({ rebookService: S, rebookCustomer: C })?.customerId).toBe(C);
    expect(parseRebookParams({ rebookService: S, rebookCustomer: "ayse@example.com" })?.customerId).toBeUndefined();
    expect(parseRebookParams({ rebookCustomer: C })).toBeNull();
  });
  it("without a customer the link is exactly what it was", () => {
    expect(rebookHref("ornek", { serviceId: S, serviceName: "x", branchId: null, staffId: null })).toBe(`/app/ornek/appointments?rebookService=${S}`);
  });
});
