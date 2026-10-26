// @vitest-environment jsdom
/**
 * Faz BEAUTY.1B - the treatment-history panel and the quick-rebook preselection, with the data layer replaced by fakes.
 * All identities, notes, dates and photo bytes are synthetic; the services and the single provider are the business's supplied facts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const push = vi.fn();
vi.mock("@/lib/i18n/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }), Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

const fetchHistory = vi.fn();
const fetchDefaults = vi.fn();
const fetchUrl = vi.fn();
const upload = vi.fn();
const del = vi.fn();
const saveNote = vi.fn();
vi.mock("@/lib/modules/treatment-history/client-queries", () => ({
  fetchTreatmentHistory: (...a: unknown[]) => fetchHistory(...a),
  fetchRebookDefaults: (...a: unknown[]) => fetchDefaults(...a),
  fetchPhotoUrl: (...a: unknown[]) => fetchUrl(...a),
  uploadTreatmentPhoto: (...a: unknown[]) => upload(...a),
  deleteTreatmentPhoto: (...a: unknown[]) => del(...a),
  saveTreatmentNote: (...a: unknown[]) => saveNote(...a),
}));
const prepare = vi.fn();
vi.mock("@/lib/modules/treatment-history/prepare-image", () => ({ prepareTreatmentImage: (...a: unknown[]) => prepare(...a) }));

import { TreatmentHistoryPanel } from "@/components/customers/treatment-history";
import type { TreatmentHistory, TreatmentItem } from "@/lib/modules/treatment-history/model";

const T = "11111111-1111-4111-8111-111111111111";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const item = (o: Partial<TreatmentItem> = {}): TreatmentItem => ({
  itemId: "i1", appointmentId: "a1", date: "2026-10-10", serviceId: SERVICE, serviceName: "Kaş Laminasyonu", staffName: "Emel Kaynakkan",
  value: "2000.00", note: null, media: [], rebook: null, ...o,
});
const hist = (items: TreatmentItem[], o: Partial<TreatmentHistory> = {}): TreatmentHistory => ({ today: "2026-10-26", timezone: "Europe/Nicosia", canSeeValue: true, hasMore: false, items, ...o });

function renderPanel(h: TreatmentHistory | null, props: { canWrite?: boolean; canRebook?: boolean } = {}) {
  fetchHistory.mockResolvedValue(h);
  return render(<TreatmentHistoryPanel tenantId={T} tenantSlug="emel" customerId="c1" canWrite={props.canWrite ?? true} canRebook={props.canRebook ?? true} />);
}

beforeEach(() => {
  [push, fetchHistory, fetchDefaults, fetchUrl, upload, del, saveNote, prepare].forEach((m) => m.mockReset());
  fetchUrl.mockResolvedValue("https://signed.example/photo?token=abc");
  prepare.mockResolvedValue({ ok: true, blob: new Blob(["x"], { type: "image/jpeg" }) });
  upload.mockResolvedValue({ ok: true });
});
afterEach(() => cleanup());

describe("history cards", () => {
  it("date, service, the performing person and the value where allowed; the page asks for exactly this customer's history", async () => {
    renderPanel(hist([item()]));
    const card = await screen.findByTestId("treatment-card");
    expect(card.textContent).toContain("Kaş Laminasyonu");
    expect(card.textContent).toContain("10.10.2026 · Emel Kaynakkan");
    expect(card.textContent).toContain("2.000,00 ₺");
    expect(fetchHistory).toHaveBeenCalledWith(T, "c1");
  });

  it("no value is shown when the database sent none; empty, error and 'older not shown' states are worded", async () => {
    renderPanel(hist([item({ value: null })], { canSeeValue: false, hasMore: true }));
    const card = await screen.findByTestId("treatment-card");
    expect(card.textContent).not.toContain("₺");
    expect(screen.getByText("Daha eski işlemler gösterilmiyor.")).toBeTruthy();
    cleanup();
    renderPanel(hist([]));
    expect(await screen.findByText("Henüz tamamlanmış bir işlem yok.")).toBeTruthy();
    cleanup();
    renderPanel(null);
    expect((await screen.findByRole("alert")).textContent).toContain("okunamadı");
  });

  it("says plainly that photos are internal documentation, not sharing or marketing consent; adds no health wording", async () => {
    renderPanel(hist([item()]));
    await screen.findByTestId("treatment-card");
    expect(document.body.textContent).toContain("paylaşım veya pazarlama izni anlamına gelmez");
    fireEvent.click(screen.getByText("Not ekle")); // the note editor discourages diagnosis and health content
    expect(document.body.textContent).toContain("Teşhis veya sağlık bilgisi yazmayın");
    const text = document.body.textContent!.toLowerCase();
    for (const w of ["garanti", "tedavi eder", "hasta", "adet", "alerji"]) expect(text, w).not.toContain(w);
  });
});

describe("recommended re-booking window and quick rebook", () => {
  const rebook = (state: "booked" | "not_due" | "due" | "overdue") => ({ minDays: 28, maxDays: 56, windowStart: "2026-11-07", windowEnd: "2026-12-05", state });

  it("shows the supplied 4-8 week example as data, and the state headline", async () => {
    renderPanel(hist([item({ rebook: rebook("due") })]));
    const hint = await screen.findByTestId("rebook-hint");
    expect(hint.textContent).toContain("Tekrar randevu zamanı");
    expect(hint.textContent).toContain("Önerilen tekrar dönemi: 4–8 hafta");
  });

  it("no hint for a service without an interval, but the quick-rebook action is still there", async () => {
    renderPanel(hist([item()]));
    await screen.findByTestId("treatment-card");
    expect(screen.getByTestId("rebook-hint").textContent).toBe("");
    expect(screen.getByText("Tekrar Randevu")).toBeTruthy();
  });

  it("'Tekrar Randevu' opens the appointments page with the service, branch and staff and the customer id it started from - date and time stay to be chosen", async () => {
    fetchDefaults.mockResolvedValue({ ok: true, defaults: { serviceId: SERVICE, serviceName: "Kaş Laminasyonu", branchId: "55555555-5555-4555-8555-555555555555", staffId: "66666666-6666-4666-8666-666666666666" } });
    renderPanel(hist([item()]));
    fireEvent.click(await screen.findByText("Tekrar Randevu"));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(fetchDefaults).toHaveBeenCalledWith(T, "i1");
    const href = push.mock.calls[0]![0] as string;
    expect(href).toBe(`/app/emel/appointments?rebookService=${SERVICE}&rebookCustomer=c1&rebookBranch=55555555-5555-4555-8555-555555555555&rebookStaff=66666666-6666-4666-8666-666666666666`);
    expect(href).not.toMatch(/date|time|name|email|phone/i);
  });

  it("when the staff is gone the link simply has no staff; when the service is gone the message is shown and nothing opens", async () => {
    fetchDefaults.mockResolvedValue({ ok: true, defaults: { serviceId: SERVICE, serviceName: "x", branchId: null, staffId: null } });
    renderPanel(hist([item()]));
    fireEvent.click(await screen.findByText("Tekrar Randevu"));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/app/emel/appointments?rebookService=${SERVICE}&rebookCustomer=c1`));
    push.mockReset();
    fetchDefaults.mockResolvedValue({ ok: false, message: "Bu hizmet artık sunulmuyor" });
    fireEvent.click(screen.getByText("Tekrar Randevu"));
    expect(await screen.findByText("Bu hizmet artık sunulmuyor")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("without appointments.create there is no quick-rebook button", async () => {
    renderPanel(hist([item({ rebook: rebook("not_due") })]), { canRebook: false });
    await screen.findByTestId("treatment-card");
    expect(screen.queryByText("Tekrar Randevu")).toBeNull();
    expect(screen.getByTestId("rebook-hint").textContent).toContain("4–8 hafta");
  });
});

describe("notes and photos", () => {
  const media = [{ id: "m1", kind: "before" as const, createdAt: "2026-10-10T10:00:00Z" }, { id: "m2", kind: "after" as const, createdAt: "2026-10-10T10:05:00Z" }];

  it("each photo is shown through its own signed URL, labelled Önce / Sonra, with a referrer-less image", async () => {
    renderPanel(hist([item({ media })]));
    const photos = await screen.findAllByTestId("treatment-photo");
    expect(photos).toHaveLength(2);
    await waitFor(() => expect(photos[0]!.querySelector("img")).not.toBeNull());
    expect(photos[0]!.querySelector("img")!.getAttribute("src")).toBe("https://signed.example/photo?token=abc");
    expect(photos[0]!.querySelector("img")!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(photos[0]!.textContent).toContain("Önce");
    expect(photos[1]!.textContent).toContain("Sonra");
    expect(fetchUrl).toHaveBeenCalledWith(T, "m1");
    expect(fetchUrl).toHaveBeenCalledWith(T, "m2");
  });

  it("a photo whose link cannot be made says so and shows no image", async () => {
    fetchUrl.mockResolvedValue(null);
    renderPanel(hist([item({ media: [media[0]!] })]));
    const p = await screen.findByTestId("treatment-photo");
    await waitFor(() => expect(p.textContent).toContain("Gösterilemedi"));
    expect(p.querySelector("img")).toBeNull();
  });

  it("read-only viewers get no upload, delete or note editing", async () => {
    renderPanel(hist([item({ media, note: "Ton kodu 3" })]), { canWrite: false });
    await screen.findByTestId("treatment-card");
    expect(screen.queryByText("Fotoğraf ekle")).toBeNull();
    expect(screen.queryByLabelText("Fotoğrafı sil")).toBeNull();
    expect(screen.queryByText("Düzenle")).toBeNull();
    expect(screen.getByText("Ton kodu 3")).toBeTruthy();
  });

  it("upload: the chosen kind and the PREPARED image (not the original file) go to the uploader, then the history reloads", async () => {
    renderPanel(hist([item()]));
    await screen.findByTestId("treatment-card");
    fireEvent.change(screen.getByLabelText("Fotoğraf türü"), { target: { value: "after" } });
    const original = new File(["orig"], "IMG_1234_Ayse_Yilmaz.heic", { type: "image/heic" });
    fireEvent.change(screen.getByTestId("photo-input"), { target: { files: [original] } });
    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(prepare).toHaveBeenCalledWith(original);
    const arg = upload.mock.calls[0]![0] as { tenantId: string; itemId: string; kind: string; file: Blob };
    expect(arg).toMatchObject({ tenantId: T, itemId: "i1", kind: "after" });
    expect(arg.file.type).toBe("image/jpeg");
    expect((arg.file as File).name).toBeUndefined(); // the original file name never travels
    await waitFor(() => expect(fetchHistory).toHaveBeenCalledTimes(2));
  });

  it("a photo the browser cannot prepare, or a refused upload, shows the message and does not reload", async () => {
    renderPanel(hist([item()]));
    await screen.findByTestId("treatment-card");
    prepare.mockResolvedValueOnce({ ok: false, message: "Bu fotoğraf okunamadı. JPEG, PNG veya WEBP deneyin" });
    fireEvent.change(screen.getByTestId("photo-input"), { target: { files: [new File(["x"], "a.heic", { type: "image/heic" })] } });
    expect(await screen.findByText(/okunamadı/)).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
    upload.mockResolvedValueOnce({ ok: false, message: "Bir işleme en fazla 8 fotoğraf eklenebilir" });
    fireEvent.change(screen.getByTestId("photo-input"), { target: { files: [new File(["x"], "a.jpg", { type: "image/jpeg" })] } });
    expect(await screen.findByText("Bir işleme en fazla 8 fotoğraf eklenebilir")).toBeTruthy();
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("deleting asks first; cancel keeps the photo, confirm deletes and reloads", async () => {
    renderPanel(hist([item({ media: [media[0]!] })]));
    const btn = await screen.findByLabelText("Fotoğrafı sil");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(btn);
    expect(del).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    del.mockResolvedValue(null);
    fireEvent.click(btn);
    await waitFor(() => expect(del).toHaveBeenCalledWith(T, "m1"));
    await waitFor(() => expect(fetchHistory).toHaveBeenCalledTimes(2));
    confirm.mockRestore();
  });

  it("the note: edit, save through the operation, a database refusal is shown", async () => {
    saveNote.mockResolvedValueOnce("Bu işlem için yetkiniz yok").mockResolvedValueOnce(null);
    renderPanel(hist([item({ note: null })]));
    fireEvent.click(await screen.findByText("Not ekle"));
    const box = screen.getByLabelText("Uygulama notu") as HTMLTextAreaElement;
    expect(box.maxLength).toBe(500);
    fireEvent.change(box, { target: { value: "Ton kodu 3" } });
    fireEvent.click(screen.getByText("Kaydet"));
    expect(await screen.findByText("Bu işlem için yetkiniz yok")).toBeTruthy();
    fireEvent.click(screen.getByText("Kaydet"));
    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
    expect(saveNote).toHaveBeenLastCalledWith(T, "i1", "Ton kodu 3");
    await waitFor(() => expect(fetchHistory).toHaveBeenCalledTimes(2));
    void within;
  });
});

describe("quick rebook preselection in the create sheet", () => {
  it("the service is preselected, the staff is only a preference, the customer and time stay empty", async () => {
    vi.resetModules();
    const captured: { items?: unknown; preferred?: unknown } = {};
    vi.doMock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: async () => ({ data: [] }) }) }));
    vi.doMock("@/lib/modules/appointments/client-queries", () => ({ fetchServicesForBranch: async () => [] }));
    vi.doMock("@/lib/modules/customers/actions", () => ({ createCustomerAction: vi.fn() }));
    vi.doMock("@/lib/modules/appointments/actions", () => ({ createAppointmentAction: vi.fn() }));
    vi.doMock("@/components/appointments/appointment-items-editor", () => ({
      AppointmentItemsEditor: (p: { items: unknown; preferredStaffMemberId?: string }) => {
        captured.items = p.items;
        captured.preferred = p.preferredStaffMemberId;
        return <div data-testid="items-editor" />;
      },
    }));
    const { CreateAppointmentSheet } = await import("@/components/appointments/create-appointment-sheet");
    render(
      <CreateAppointmentSheet open onOpenChange={() => {}} tenantId={T} tenantSlug="emel" tenantTimezone="Europe/Nicosia" branches={[{ id: "b1", name: "Merkez" } as never]}
        initialServiceId={SERVICE} initialStaffMemberId="staff-1" initialBranchId="b1" onCreated={() => {}} />,
    );
    await screen.findByTestId("items-editor");
    const items = captured.items as { serviceId: string; staffMemberId: string; startTime: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ serviceId: SERVICE, staffMemberId: "", startTime: "" });
    expect(captured.preferred).toBe("staff-1");
    expect(screen.queryByText("Değiştir")).toBeNull(); // no customer selected
    expect((screen.getByRole("button", { name: "Randevuyu oluştur" }) as HTMLButtonElement).disabled).toBe(true);
    vi.doUnmock("@/components/appointments/appointment-items-editor");
  });
});
