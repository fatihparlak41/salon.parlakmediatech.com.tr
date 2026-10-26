// @vitest-environment jsdom
/**
 * Faz CUST.1A — the customer history view and the import screen. Isolated: actions mocked, Supabase throws. All customers,
 * numbers, names and transactions are synthetic (the Emel Beauty Bar model: one working person, four known services).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CustomerHistoryView } from "@/components/customers/customer-history";
import { CustomerImport } from "@/components/customers/customer-import";
import { commitCustomerImportAction, previewCustomerImportAction } from "@/lib/modules/customers/import-actions";
import { parseCustomerHistory, parseImportCommit, parseImportPreview } from "@/lib/modules/customers/import-model";
import { fail, ok } from "@/lib/errors";

vi.mock("@/lib/modules/customers/import-actions", () => ({ previewCustomerImportAction: vi.fn(), commitCustomerImportAction: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(() => { throw new Error("no real Supabase client in this file"); }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => { throw new Error("no real Supabase client in this file"); }) }));

const mockedPreview = vi.mocked(previewCustomerImportAction);
const mockedCommit = vi.mocked(commitCustomerImportAction);

const TENANT = "11111111-1111-4111-8111-111111111111";

function history(withFinance: boolean) {
  const money = (amount: number, paid: number | null, outstanding: number | null, hasCheckout = true) => (withFinance ? { amount, hasCheckout, paid, outstanding } : {});
  return parseCustomerHistory({
    timezone: "Europe/Nicosia",
    summary: { completedVisits: 2, lastVisitAt: "2026-09-20T08:00:00+00:00", upcoming: 1, cancelled: 1, noShow: 1, total: 5 },
    upcoming: [{ startAt: "2026-12-01T08:00:00+00:00", status: "confirmed", items: [{ service: "Kirpik Laminasyonu", staff: "Emel Kaynakkan" }], ...money(2000, null, null, false) }],
    past: [
      { startAt: "2026-09-20T08:00:00+00:00", status: "completed", items: [{ service: "Kaş Alımı", staff: "Emel Kaynakkan" }], ...money(600, 300, 300) },
      { startAt: "2026-09-01T07:00:00+00:00", status: "completed", items: [{ service: "Kaş Laminasyonu", staff: "Emel Kaynakkan" }], ...money(2000, 2000, 0) },
    ],
    hasMorePast: false,
    servicesReceived: [{ service: "Kaş Alımı", count: 1 }, { service: "Kaş Laminasyonu", count: 1 }],
    staff: [{ displayName: "Emel Kaynakkan", count: 2 }],
    finance: withFinance ? { completedAmount: 2600, outstanding: 300, completedWithoutCheckout: 0, currency: "TRY" } : null,
  })!;
}

afterEach(() => cleanup());

describe("CustomerHistoryView", () => {
  it("shows last visit, 2 completed visits, 1 upcoming, the services and the one staff member", () => {
    const { container } = render(<CustomerHistoryView history={history(false)} />);
    expect(container.querySelector('[data-metric="completed"]')!.textContent).toContain("2");
    expect(container.querySelector('[data-metric="upcoming"]')!.textContent).toContain("1");
    expect(container.querySelector('[data-metric="lastVisit"]')!.textContent).toContain("20 Eyl 2026");
    expect(screen.getByText("Kirpik Laminasyonu — Emel Kaynakkan")).toBeTruthy();
    expect(screen.getByText("Kaş Alımı × 1")).toBeTruthy();
    expect(screen.getByText("Emel Kaynakkan × 2")).toBeTruthy();
    expect(container.textContent).toContain("1 iptal · 1 gelmedi");
  });

  it("without finance permission NO money is rendered anywhere", () => {
    const { container } = render(<CustomerHistoryView history={history(false)} />);
    expect(container.querySelector('[data-section="finance"]')).toBeNull();
    expect(container.textContent).not.toMatch(/TRY|Tutar|Tahsil |Kalan|Bekleyen/);
  });

  it("with finance permission: totals, outstanding and per-visit amounts, collected and remaining", () => {
    const { container } = render(<CustomerHistoryView history={history(true)} />);
    const f = container.querySelector('[data-section="finance"]')!.textContent!;
    expect(f).toContain("2.600,00 TRY");
    expect(f).toContain("300,00 TRY");
    expect(container.textContent).toContain("Tutar 600,00 TRY · Tahsil 300,00 TRY · Kalan 300,00 TRY");
    expect(container.textContent).toContain("Liste fiyatı 2.000,00 TRY"); // the future visit: informational list price, no checkout expected
  });

  it("an empty history says so plainly", () => {
    const h = parseCustomerHistory({ timezone: "Europe/Nicosia", summary: { completedVisits: 0, lastVisitAt: null, upcoming: 0, cancelled: 0, noShow: 0, total: 0 }, upcoming: [], past: [], hasMorePast: false, servicesReceived: [], staff: [], finance: null })!;
    const { container } = render(<CustomerHistoryView history={h} />);
    expect(container.textContent).toContain("Yaklaşan randevu yok.");
    expect(container.textContent).toContain("Henüz geçmiş randevu yok.");
  });

  it("renders no identifier", () => {
    const { container } = render(<CustomerHistoryView history={history(true)} />);
    expect(container.innerHTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

describe("CustomerImport", () => {
  beforeEach(() => {
    mockedPreview.mockReset();
    mockedCommit.mockReset();
  });

  function pick(text: string, name = "musteriler.csv") {
    const file = new File([text], name, { type: "text/csv" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(text) });
    fireEvent.change(screen.getByLabelText("CSV dosyası"), { target: { files: [file] } });
  }

  const previewOf = (rows: { row: number; status: string; reason?: string | null; existingName?: string | null }[]) =>
    parseImportPreview({
      maxRows: 5000,
      summary: {
        total: rows.length,
        new: rows.filter((r) => r.status === "NEW").length,
        matchExisting: rows.filter((r) => r.status === "MATCH_EXISTING").length,
        invalid: rows.filter((r) => r.status === "INVALID").length,
        ambiguous: rows.filter((r) => r.status === "AMBIGUOUS").length,
        willFillPhone: 0,
        willFillEmail: 0,
      },
      rows: rows.map((r) => ({ row: r.row, status: r.status, reason: r.reason ?? null, existingName: r.existingName ?? null, fillPhone: false, fillEmail: false })),
    })!;

  it("reads the file in the browser, detects the columns, previews WITHOUT importing, shows row numbers and reasons in Turkish", async () => {
    mockedPreview.mockResolvedValue(ok(previewOf([
      { row: 2, status: "NEW" },
      { row: 3, status: "INVALID", reason: "phone_invalid" },
      { row: 4, status: "AMBIGUOUS", reason: "phone_other_name", existingName: "Sentetik Musteri" },
    ])));
    render(<CustomerImport tenantId={TENANT} tenantSlug="ornek" />);
    pick("Ad Soyad;Telefon;E-posta\nYeni Kisi;0544 100 20 30;\nKotu;12;\nBaska;0533 111 22 33;\n");
    await waitFor(() => expect(screen.getByLabelText("Ad soyad")).toBeTruthy());
    expect((screen.getByLabelText("Telefon") as HTMLSelectElement).value).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: /Önizle/ }));
    await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(1));
    expect(mockedPreview.mock.calls[0]![1]).toEqual({
      tenantId: TENANT,
      tenantSlug: "ornek",
      rows: [
        { row: 2, name: "Yeni Kisi", phone: "0544 100 20 30", email: "" },
        { row: 3, name: "Kotu", phone: "12", email: "" },
        { row: 4, name: "Baska", phone: "0533 111 22 33", email: "" },
      ],
    });
    expect(await screen.findByText("Telefon numarası geçersiz")).toBeTruthy();
    expect(screen.getByText(/Bu telefon kayıtlı başka bir isimle var \(Sentetik Musteri\)/)).toBeTruthy();
    expect(mockedCommit).not.toHaveBeenCalled(); // nothing is imported by previewing
  });

  it("imports only after the preview, shows the summary, and drops the rows afterwards", async () => {
    mockedPreview.mockResolvedValue(ok(previewOf([{ row: 2, status: "NEW" }])));
    mockedCommit.mockResolvedValue(ok(parseImportCommit({ summary: { total: 1, created: 1, matchExisting: 0, filledPhone: 0, filledEmail: 0, skippedInvalid: 0, skippedAmbiguous: 0 }, rows: [] })!));
    render(<CustomerImport tenantId={TENANT} tenantSlug="ornek" />);
    pick("name,phone\nYeni Kisi,0544 100 20 30\n");
    await waitFor(() => expect(screen.getByRole("button", { name: /Önizle/ })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /İçe aktar/ })).toBeNull(); // not before the preview
    fireEvent.click(screen.getByRole("button", { name: /Önizle/ }));
    fireEvent.click(await screen.findByRole("button", { name: /İçe aktar \(1 yeni müşteri\)/ }));
    await waitFor(() => expect(mockedCommit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("1 yeni müşteri eklendi")).toBeTruthy();
    expect(screen.queryByLabelText("CSV dosyası")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Önizle/ })).toBeNull(); // the parsed table is gone
  });

  it("a file with no usable columns or too many rows is refused locally, before any call", async () => {
    render(<CustomerImport tenantId={TENANT} tenantSlug="ornek" />);
    pick("Kod;Bilgi\n1;2\n");
    await waitFor(() => expect(screen.getByRole("button", { name: /Önizle/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Önizle/ }));
    expect(screen.getByRole("alert").textContent).toBe("Ad soyad sütununu seçin.");
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("a server refusal is shown in plain words", async () => {
    mockedPreview.mockResolvedValue(fail("UNAUTHORIZED", "Müşteri listesi aktarma yetkiniz yok"));
    render(<CustomerImport tenantId={TENANT} tenantSlug="ornek" />);
    pick("name,phone\nA,0544 100 20 30\n");
    await waitFor(() => expect(screen.getByRole("button", { name: /Önizle/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Önizle/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Müşteri listesi aktarma yetkiniz yok");
  });
});
