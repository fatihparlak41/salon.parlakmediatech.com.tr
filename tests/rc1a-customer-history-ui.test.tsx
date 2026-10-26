// @vitest-environment jsdom
/**
 * RC.1A - ONE customer history screen: CUST.1A's history is the frame, BEAUTY.1B's treatment cards are a section inside it.
 * Completed visits are not listed twice, the access rule is CUST.1A's (a refused history shows no treatment section at all).
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const rpc = vi.fn();
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: (...a: unknown[]) => rpc(...a) }) }));

import { CustomerHistoryTab, CustomerHistoryView } from "@/components/customers/customer-history";
import { parseCustomerHistory } from "@/lib/modules/customers/import-model";

function history() {
  return parseCustomerHistory({
    timezone: "Asia/Nicosia",
    summary: { completedVisits: 2, lastVisitAt: "2026-09-20T08:00:00+00:00", upcoming: 1, cancelled: 1, noShow: 1, total: 5 },
    upcoming: [{ startAt: "2026-12-01T08:00:00+00:00", status: "confirmed", items: [{ service: "Kirpik Laminasyonu", staff: "Emel Kaynakkan" }] }],
    past: [
      { startAt: "2026-09-20T08:00:00+00:00", status: "completed", items: [{ service: "Kaş Alımı", staff: "Emel Kaynakkan" }] },
      { startAt: "2026-09-10T08:00:00+00:00", status: "cancelled", items: [{ service: "Nem Bakımı", staff: "Emel Kaynakkan" }] },
      { startAt: "2026-09-05T08:00:00+00:00", status: "no_show", items: [{ service: "Akne Tedavisi", staff: "Emel Kaynakkan" }] },
      { startAt: "2026-09-01T07:00:00+00:00", status: "completed", items: [{ service: "Kaş Laminasyonu", staff: "Emel Kaynakkan" }] },
    ],
    hasMorePast: false,
    servicesReceived: [{ service: "Kaş Alımı", count: 1 }],
    staff: [{ displayName: "Emel Kaynakkan", count: 2 }],
    finance: null,
  })!;
}

beforeEach(() => rpc.mockReset());
afterEach(() => cleanup());

describe("one history screen", () => {
  it("without a treatment section the screen is exactly CUST.1A's: completed visits listed under 'Geçmiş'", () => {
    const { container } = render(<CustomerHistoryView history={history()} />);
    expect(container.querySelector('[data-section="treatments"]')).toBeNull();
    expect(screen.getByRole("heading", { name: "Geçmiş" })).toBeTruthy();
    expect(screen.getByText("Kaş Alımı — Emel Kaynakkan")).toBeTruthy();
    expect(screen.getByText("Kaş Laminasyonu — Emel Kaynakkan")).toBeTruthy();
    expect(screen.getByText("Nem Bakımı — Emel Kaynakkan")).toBeTruthy();
  });

  it("with the treatment section: the cards appear once, completed visits are not repeated in the visit list, cancelled and no-show stay", () => {
    const { container } = render(<CustomerHistoryView history={history()} treatments={<div data-testid="cards">işlem kartları</div>} />);
    const section = container.querySelector('[data-section="treatments"]')!;
    expect(section.textContent).toContain("Tamamlanan işlemler");
    expect(section.querySelector('[data-testid="cards"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="cards"]')).toHaveLength(1);
    expect(screen.queryByText("Kaş Alımı — Emel Kaynakkan")).toBeNull();
    expect(screen.queryByText("Kaş Laminasyonu — Emel Kaynakkan")).toBeNull();
    expect(screen.getByText("Nem Bakımı — Emel Kaynakkan")).toBeTruthy();
    expect(screen.getByText("Akne Tedavisi — Emel Kaynakkan")).toBeTruthy();
    expect(container.querySelector('[data-status="completed"]')).toBeNull();
    // the summary tiles still count the completed visits, the upcoming appointment is still listed
    expect(container.querySelector('[data-metric="completed"]')!.textContent).toContain("2");
    expect(screen.getByText("Kirpik Laminasyonu — Emel Kaynakkan")).toBeTruthy();
  });

  it("section order: summary, upcoming, treatments, then the other past appointments", () => {
    const { container } = render(<CustomerHistoryView history={history()} treatments={<div>x</div>} />);
    const labels = [...container.querySelectorAll("section[aria-label]")].map((s) => s.getAttribute("aria-label"));
    expect(labels.indexOf("Özet")).toBeLessThan(labels.indexOf("Yaklaşan randevular"));
    expect(labels.indexOf("Yaklaşan randevular")).toBeLessThan(labels.indexOf("İşlem kayıtları"));
    expect(labels.indexOf("İşlem kayıtları")).toBeLessThan(labels.indexOf("Diğer geçmiş randevular"));
  });

  it("with no cancelled or no-show visit the 'other' section says so instead of repeating the completed ones", () => {
    const h = history();
    h.past = h.past.filter((a) => a.status === "completed");
    render(<CustomerHistoryView history={h} treatments={<div>x</div>} />);
    expect(screen.getByText("İptal edilen veya gelmediği kayıtlı randevu yok.")).toBeTruthy();
  });
});

describe("access follows CUST.1A: no history, no treatment section", () => {
  const Marker = () => <div data-testid="treatment-marker">treatments mounted</div>;

  it("a refused history (CH002) shows only the refusal; the treatment section is never mounted", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "CH002", message: "x" } });
    render(<CustomerHistoryTab customerId="c1" treatments={<Marker />} />);
    expect(await screen.findByText("Bu müşterinin geçmişini görüntüleme yetkiniz yok.")).toBeTruthy();
    expect(screen.queryByTestId("treatment-marker")).toBeNull();
  });

  it("a failed read shows the error and no treatment section", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    render(<CustomerHistoryTab customerId="c1" treatments={<Marker />} />);
    expect((await screen.findByRole("alert")).textContent).toContain("okunamadı");
    expect(screen.queryByTestId("treatment-marker")).toBeNull();
  });

  it("an allowed history mounts the treatment section inside the same tab", async () => {
    rpc.mockResolvedValue({
      data: { timezone: "Asia/Nicosia", summary: { completedVisits: 1, lastVisitAt: null, upcoming: 0, cancelled: 0, noShow: 0, total: 1 }, upcoming: [], past: [], hasMorePast: false, servicesReceived: [], staff: [], finance: null },
      error: null,
    });
    render(<CustomerHistoryTab customerId="c1" treatments={<Marker />} />);
    await waitFor(() => expect(screen.getByTestId("treatment-marker")).toBeTruthy());
    expect(rpc).toHaveBeenCalledWith("get_customer_history", { p_customer_id: "c1", p_limit: 50 });
  });
});
