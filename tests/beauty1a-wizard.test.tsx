// @vitest-environment jsdom
/**
 * Faz BEAUTY.1A - the public booking page with the data layer replaced by fakes. The catalogue uses the business's real facts
 * (names, prices, customer-facing ranges, salon wording); contacts, dates and identities are synthetic, and no booking duration is
 * ever shown because none is part of the public payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";

const fetchEligible = vi.fn();
const fetchSlots = vi.fn();
const submit = vi.fn();
vi.mock("@/lib/modules/public-booking/client-queries", () => ({
  fetchPublicEligibleStaff: (...a: unknown[]) => fetchEligible(...a),
  fetchPublicAvailabilitySlots: (...a: unknown[]) => fetchSlots(...a),
}));
vi.mock("@/lib/modules/public-booking/actions", () => ({ submitGuestBookingAction: (...a: unknown[]) => submit(...a) }));
vi.mock("@/lib/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/public-booking/turnstile-widget", async () => {
  const React = await import("react");
  return { TurnstileWidget: ({ onVerify }: { onVerify: (t: string) => void }) => { React.useEffect(() => onVerify("tok"), [onVerify]); return null; } };
});

import { BookingWizard } from "@/components/public-booking/booking-wizard";
import type { PublicBookingBranch, PublicBookingService } from "@/lib/modules/public-booking/client-queries";

type Props = ComponentProps<typeof BookingWizard>;
const labels = new Proxy({}, { get: (_t, k) => (k === "minutesShort" ? "dk" : String(k)) }) as Props["labels"];

const base: PublicBookingService = {
  id: "", name: "", category: null, pricingMode: "fixed", bookingMode: "direct", price: null, displayDurationMin: null, displayDurationMax: null,
  summary: null, details: null, preparationNote: null, aftercareNote: null, importantNote: null, badge: null,
};
const svc = (o: Partial<PublicBookingService>): PublicBookingService => ({ ...base, ...o });
const SKIN = "Cildiniz değerlendirildikten sonra sizin için uygun bakım netleştirilebilir.";

const services: PublicBookingService[] = [
  svc({ id: "s-alim", name: "Kaş Alımı", price: 600, displayDurationMin: 10, displayDurationMax: 15 }),
  svc({ id: "s-lam", name: "Kaş Laminasyonu", price: 2000, displayDurationMin: 30, displayDurationMax: 40, summary: "Şekillendirme ve bakım odaklı.", importantNote: "Yaklaşık 4–8 hafta kullanılabilir.", preparationNote: "Lütfen kaşlarınızı almadan geliniz." }),
  svc({ id: "s-kirpik", name: "Kirpik Laminasyonu", price: 2000, displayDurationMin: 40, displayDurationMax: null }),
  svc({ id: "s-yosun", name: "Yosun Peeling", price: 5000, displayDurationMin: 50, displayDurationMax: 70, badge: "Klasik bakım dahil", details: "Leke ve gözenek bakımı.", importantNote: SKIN }),
  svc({ id: "s-gelin", name: "Gelin / Nişan / Kına Makyajı", pricingMode: "inquiry", bookingMode: "inquiry" }),
  svc({ id: "s-gece", name: "Gece / Günlük Makyaj", price: 5000, bookingMode: "inquiry" }),
  svc({ id: "s-hair", name: "Saç Kesimi" }),
];

function branch(over: Partial<PublicBookingBranch> = {}): PublicBookingBranch {
  return { id: "b1", name: "Merkez", address: null, phone: "+905550000000", whatsappPhone: "+905550000000", instagramHandle: "sentetik.salon", locationUrl: null, services, ...over };
}

function renderWizard(b: PublicBookingBranch = branch()) {
  return render(
    <BookingWizard tenantSlug="sentetik" tenantName="Sentetik Salon" tenantTimezone="Europe/Nicosia" branches={[b]} turnstileSiteKey="k" isAuthenticated={false} prefill={null} labels={labels} />,
  );
}
const card = (name: string) => screen.getAllByTestId("service-card").find((c) => c.textContent!.includes(name))!;

beforeEach(() => {
  fetchEligible.mockReset();
  fetchSlots.mockReset().mockResolvedValue(["10:00", "10:15"]);
  submit.mockReset();
});
afterEach(() => cleanup());

describe("service cards", () => {
  it("fixed price + display range on the card, summary and badge only where the salon wrote them, no preparation text on any card", () => {
    renderWizard();
    expect(card("Kaş Laminasyonu").textContent).toContain("2.000 ₺ · 30–40 dk");
    expect(card("Kaş Laminasyonu").textContent).toContain("Şekillendirme ve bakım odaklı.");
    expect(card("Kaş Alımı").textContent).toContain("600 ₺ · 10–15 dk");
    expect(card("Kirpik Laminasyonu").textContent).toContain("2.000 ₺ · 40 dk");
    expect(card("Yosun Peeling").textContent).toContain("Klasik bakım dahil");
    for (const c of screen.getAllByTestId("service-card")) {
      expect(c.textContent).not.toContain("Lütfen kaşlarınızı almadan geliniz.");
      expect(c.textContent).not.toContain("Yaklaşık 4–8 hafta");
      expect(c.textContent).not.toContain(SKIN);
    }
  });

  it("an inquiry service says 'priceInquiry' and offers 'inquiryAction' - never a 0 amount, never an invented duration", () => {
    renderWizard();
    const c = card("Gelin / Nişan / Kına Makyajı");
    expect(c.textContent).toContain("priceInquiry");
    expect(c.textContent).toContain("inquiryAction");
    expect(document.body.textContent).not.toMatch(/\b0 ₺|0,00 ₺/);
    expect(c.textContent).not.toMatch(/dk\b/);
  });

  it("a service with a price but no display duration shows the price only; one with neither shows no meta line at all (as before)", () => {
    renderWizard();
    expect(card("Gece / Günlük Makyaj").textContent).toContain("5.000 ₺");
    expect(card("Gece / Günlük Makyaj").textContent).not.toMatch(/dk\b/);
    expect(card("Saç Kesimi").textContent).toBe("Saç Kesimi");
  });

  it("no medical or system-generated claim: the page adds no wording of its own beyond labels and salon text", () => {
    renderWizard();
    const text = document.body.textContent!.toLowerCase();
    for (const w of ["tedavi eder", "garanti", "teşhis", "adet", "regl", "hamile"]) expect(text, w).not.toContain(w);
  });
});

describe("inquiry services never enter booking", () => {
  it("opens the information panel with contact actions, offers no booking button, never asks for staff or date", async () => {
    renderWizard();
    fireEvent.click(card("Gelin / Nişan / Kına Makyajı"));
    const panel = await screen.findByTestId("service-info");
    expect(within(panel).getByText("inquiryIntro")).toBeTruthy();
    const contact = within(panel).getByTestId("inquiry-contact");
    const hrefs = [...contact.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h!.startsWith("tel:"))).toBe(true);
    expect(hrefs.some((h) => h!.includes("wa.me"))).toBe(true);
    expect(hrefs.some((h) => h!.includes("instagram.com"))).toBe(true);
    expect(screen.queryByText("bookAction")).toBeNull();
    expect(screen.queryByText("chooseDateTitle")).toBeNull();
    expect(screen.queryByText("chooseStaffTitle")).toBeNull();
    expect(fetchEligible).not.toHaveBeenCalled();
    expect(fetchSlots).not.toHaveBeenCalled();
  });

  it("a fixed-price service whose duration is not confirmed is also contact-only", async () => {
    renderWizard();
    fireEvent.click(card("Gece / Günlük Makyaj"));
    const panel = await screen.findByTestId("service-info");
    expect(within(panel).getByText(/5\.000 ₺/)).toBeTruthy();
    expect(screen.queryByText("bookAction")).toBeNull();
    expect(fetchEligible).not.toHaveBeenCalled();
  });

  it("without any configured contact it says to contact the salon directly (no dead buttons)", async () => {
    renderWizard(branch({ phone: null, whatsappPhone: null, instagramHandle: null }));
    fireEvent.click(card("Gelin / Nişan / Kına Makyajı"));
    expect(await screen.findByText("noContactConfigured")).toBeTruthy();
    expect(screen.queryByTestId("inquiry-contact")).toBeNull();
  });
});

describe("one eligible person is selected automatically", () => {
  it("skips the staff step, goes straight to the date, and asks for slots for THAT person", async () => {
    fetchEligible.mockResolvedValue([{ id: "emel-id", fullName: "Emel Kaynakkan" }]);
    renderWizard();
    fireEvent.click(card("Kaş Alımı"));
    expect(await screen.findByText("chooseDateTitle")).toBeTruthy();
    expect(screen.queryByText("chooseStaffTitle")).toBeNull();
    expect(screen.queryByText("stepStaff")).toBeNull(); // the progress bar has no staff dot either
    fireEvent.click(screen.getAllByRole("button").find((b) => /^\d\d\.\d\d$/.test(b.textContent!.replace(/^[^\d]*/, "")) || /\d\d\.\d\d/.test(b.textContent!))!);
    await waitFor(() => expect(fetchSlots).toHaveBeenCalled());
    expect(fetchSlots.mock.calls[0]![0]).toBe("sentetik");
    expect(fetchSlots.mock.calls[0]![2]).toBe("s-alim");
    expect(fetchSlots.mock.calls[0]![4]).toBe("emel-id");
  });

  it("back from the date goes to the service list (there is no staff step to return to)", async () => {
    fetchEligible.mockResolvedValue([{ id: "emel-id", fullName: "Emel Kaynakkan" }]);
    renderWizard();
    fireEvent.click(card("Kaş Alımı"));
    await screen.findByText("chooseDateTitle");
    fireEvent.click(screen.getByText("back"));
    expect(await screen.findByText("chooseServiceTitle")).toBeTruthy();
  });

  it("two eligible people keep the normal staff choice, including 'any staff'", async () => {
    fetchEligible.mockResolvedValue([{ id: "a", fullName: "Ayşe" }, { id: "b", fullName: "Banu" }]);
    renderWizard();
    fireEvent.click(card("Kaş Alımı"));
    expect(await screen.findByText("chooseStaffTitle")).toBeTruthy();
    expect(screen.getByText("anyStaff")).toBeTruthy();
    expect(screen.getByText("Ayşe")).toBeTruthy();
    expect(screen.getByText("Banu")).toBeTruthy();
    expect(screen.queryByText("chooseDateTitle")).toBeNull();
  });

  it("nobody eligible: a notice, no date step", async () => {
    fetchEligible.mockResolvedValue([]);
    renderWizard();
    fireEvent.click(card("Kaş Alımı"));
    expect(await screen.findByText("noEligibleStaff")).toBeTruthy();
    expect(screen.queryByText("chooseDateTitle")).toBeNull();
    expect(screen.queryByText("chooseStaffTitle")).toBeNull();
  });
});

describe("progressive information and the unchanged simple flow", () => {
  it("a service with information shows it BEFORE the booking steps: details, preparation, important info; 'bookAction' continues", async () => {
    fetchEligible.mockResolvedValue([{ id: "emel-id", fullName: "Emel Kaynakkan" }]);
    renderWizard();
    fireEvent.click(card("Kaş Laminasyonu"));
    const panel = await screen.findByTestId("service-info");
    expect(within(panel).getByText("beforeAppointment")).toBeTruthy();
    expect(within(panel).getByText("Lütfen kaşlarınızı almadan geliniz.")).toBeTruthy();
    expect(within(panel).getByText("Yaklaşık 4–8 hafta kullanılabilir.")).toBeTruthy();
    expect(within(panel).getByText("importantInfo")).toBeTruthy();
    expect(fetchEligible).not.toHaveBeenCalled(); // nothing is asked of the database until the customer decides to book
    fireEvent.click(screen.getByText("bookAction"));
    expect(await screen.findByText("chooseDateTitle")).toBeTruthy();
  });

  it("Yosun Peeling: the salon's badge, its wording, and the general skin note appear on the information panel only", async () => {
    renderWizard();
    fireEvent.click(card("Yosun Peeling"));
    const panel = await screen.findByTestId("service-info");
    expect(within(panel).getByText("Klasik bakım dahil")).toBeTruthy();
    expect(within(panel).getByText("Leke ve gözenek bakımı.")).toBeTruthy();
    expect(within(panel).getByText(SKIN)).toBeTruthy();
    expect(within(panel).getByText("aboutService")).toBeTruthy();
  });

  it("a plain service (no beauty fields) skips the information step and goes straight on, as before", async () => {
    fetchEligible.mockResolvedValue([{ id: "a", fullName: "Ahmet" }, { id: "b", fullName: "Burak" }]);
    renderWizard();
    fireEvent.click(card("Saç Kesimi"));
    expect(await screen.findByText("chooseStaffTitle")).toBeTruthy();
    expect(screen.queryByTestId("service-info")).toBeNull();
  });
});

describe("the whole one-person flow and the confirmation", () => {
  it("service -> information -> date -> time -> contact -> confirm -> success: assigned staff sent, preparation note on the summary and the success screen", async () => {
    fetchEligible.mockResolvedValue([{ id: "emel-id", fullName: "Emel Kaynakkan" }]);
    submit.mockResolvedValue({ success: true, data: { appointmentReference: "ref-1", branchName: "Merkez", serviceName: "Kaş Laminasyonu", staffName: "Emel Kaynakkan", scheduledStartAt: "2026-11-02T08:00:00.000Z", durationMinutes: 30, price: 2000, tenantTimezone: "Europe/Nicosia", claimIssued: false } });
    renderWizard();
    fireEvent.click(card("Kaş Laminasyonu"));
    fireEvent.click(await screen.findByText("bookAction"));
    await screen.findByText("chooseDateTitle");
    fireEvent.click(screen.getAllByRole("button").find((b) => /\d\d\.\d\d/.test(b.textContent!))!);
    fireEvent.click(await screen.findByText("10:00"));
    fireEvent.change(await screen.findByLabelText("fullNameLabel"), { target: { value: "Sentetik Kişi" } });
    fireEvent.change(screen.getByLabelText("phoneLabel"), { target: { value: "+905550001111" } });
    fireEvent.change(screen.getByLabelText("emailLabel"), { target: { value: "sentetik@example.com" } });
    fireEvent.click(screen.getByText("next"));
    const prep = await screen.findByTestId("prep-note");
    expect(prep.textContent).toContain("Lütfen kaşlarınızı almadan geliniz.");
    expect(document.body.textContent).toContain("2.000 ₺");
    expect(document.body.textContent).toContain("Emel Kaynakkan");
    fireEvent.click(screen.getByText("submit"));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit.mock.calls[0]![0]).toMatchObject({ serviceId: "s-lam", staffMemberId: "emel-id", branchId: "b1" });
    const done = await screen.findByText("confirmedTitle");
    expect(done).toBeTruthy();
    expect(screen.getByTestId("prep-note").textContent).toContain("Lütfen kaşlarınızı almadan geliniz.");
  });
});
