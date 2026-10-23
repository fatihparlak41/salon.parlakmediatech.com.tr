// @vitest-environment jsdom
/**
 * Faz LAUNCH.1C — the guided setup wizard. Fully isolated: every Server Action is mocked and both Supabase client
 * factories throw. What matters: the steps and their Turkish wording follow the server's answer (done / not done),
 * the wizard opens on the first open step, each step sends exactly what was typed, the closing step never says
 * "ready" unless the server did, a caller without permission is told so, and no identifier is rendered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import trMessages from "@/messages/tr.json";
import { SetupWizard, type SetupWizardProps } from "@/components/onboarding/setup-wizard";
import {
  addServicesAction,
  addStaffAction,
  applyWeeklyHoursAction,
  saveSalonProfileAction,
  setStaffServicesAction,
} from "@/lib/modules/onboarding/actions";
import { updateOnlineBookingSettingAction } from "@/lib/modules/settings/actions";
import { parseOnboardingStatus, type OnboardingStatus } from "@/lib/modules/onboarding/model";
import { fail, ok } from "@/lib/errors";

const refresh = vi.fn();
vi.mock("@/lib/i18n/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/lib/modules/onboarding/actions", () => ({
  addServicesAction: vi.fn(),
  addStaffAction: vi.fn(),
  applyWeeklyHoursAction: vi.fn(),
  saveSalonProfileAction: vi.fn(),
  setStaffServicesAction: vi.fn(),
}));
vi.mock("@/lib/modules/settings/actions", () => ({ updateOnlineBookingSettingAction: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error("a real server Supabase client was requested — this file must never touch Supabase");
  }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => {
    throw new Error("a real browser Supabase client was requested — this file must never touch Supabase");
  }),
}));

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SERVICE_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const STEP_KEYS = ["profile", "services", "staff", "hours", "mapping", "booking", "ready"];

function statusFor(done: string[], blockers: string[] = [], extra: Record<string, unknown> = {}): OnboardingStatus {
  const parsed = parseOnboardingStatus({
    ready: blockers.length === 0,
    blockers,
    tenantSlug: "ornek-salon",
    profile: { name: "Örnek Salon", timezone: "Europe/Istanbul", currency: "TRY", phone: done.includes("profile") ? "05320000000" : null, missing: [] },
    counts: { services: done.includes("services") ? 2 : 0, staff: done.includes("staff") ? 2 : 0, staffWithHours: done.includes("hours") ? 2 : 0, bookablePaths: done.includes("mapping") ? 4 : 0 },
    onlineBookingEnabled: done.includes("booking"),
    hasAppointments: false,
    firstAvailableSlotAt: blockers.length === 0 ? "2026-10-27T06:00:00.000Z" : null,
    steps: STEP_KEYS.map((key) => ({ key, done: done.includes(key) })),
    ...extra,
  });
  if (!parsed) throw new Error("fixture status is invalid");
  return parsed;
}

const WORKSPACE = {
  branch: { phone: "", address: "" },
  services: [
    { id: SERVICE_1, name: "Saç Kesimi", category: "Saç", durationMinutes: 45, price: "800.00" },
    { id: SERVICE_2, name: "Manikür", category: "Tırnak", durationMinutes: 45, price: "600.00" },
  ],
  staff: [
    { id: STAFF_A, fullName: "Ayşe Demir", hasHours: false },
    { id: STAFF_B, fullName: "Mehmet Kaya", hasHours: true },
  ],
  pairs: [`${STAFF_A}:${SERVICE_1}`],
};

function renderWizard(overrides: Partial<SetupWizardProps> = {}) {
  const props: SetupWizardProps = {
    tenantId: TENANT_ID,
    tenantSlug: "ornek-salon",
    bookingUrl: "https://salon.example.test/book/ornek-salon",
    dashboardHref: "/app/ornek-salon",
    initialStatus: statusFor([], ["salon_profile_missing", "no_services", "no_staff", "no_working_hours", "no_bookable_staff", "public_booking_disabled"]),
    workspace: WORKSPACE,
    firstSlotLabel: null,
    can: { profile: true, services: true, staff: true, hours: true, booking: true },
    ...overrides,
  };
  return render(
    <NextIntlClientProvider locale="tr" messages={trMessages}>
      <SetupWizard {...props} />
    </NextIntlClientProvider>,
  );
}

const stepButton = (label: string) => screen.getByRole("button", { name: new RegExp("^" + label + "\\s*(Tamamlandı|Bekliyor)$") });

beforeEach(() => {
  vi.mocked(addServicesAction).mockReset();
  vi.mocked(addStaffAction).mockReset();
  vi.mocked(applyWeeklyHoursAction).mockReset();
  vi.mocked(saveSalonProfileAction).mockReset();
  vi.mocked(setStaffServicesAction).mockReset();
  vi.mocked(updateOnlineBookingSettingAction).mockReset();
  refresh.mockReset();
});
afterEach(() => cleanup());

describe("steps follow the server's answer", () => {
  it("lists the seven steps, marks done ones, shows progress, and opens on the first open step", () => {
    renderWizard({ initialStatus: statusFor(["profile"], ["no_services", "no_staff", "no_working_hours", "no_bookable_staff", "public_booking_disabled"]) });
    for (const label of ["Salon bilgileri", "Hizmetler", "Personel", "Çalışma saatleri", "Kim hangi hizmeti yapıyor", "Online rezervasyon", "Hazır"]) {
      expect(stepButton(label)).toBeTruthy();
    }
    expect(screen.getByText("1/6 adım tamamlandı")).toBeTruthy();
    expect(stepButton("Hizmetler").getAttribute("aria-expanded")).toBe("true");
    expect(stepButton("Salon bilgileri").getAttribute("aria-expanded")).toBe("false");
    expect(within(stepButton("Salon bilgileri")).getByText("Tamamlandı")).toBeTruthy();
    expect(within(stepButton("Hizmetler")).getByText("Bekliyor")).toBeTruthy();
  });

  it("optional commercial features are explicitly postponed, never required", () => {
    renderWizard();
    expect(screen.getByText("Sonra ayarlayabilirsiniz")).toBeTruthy();
    expect(screen.getByText(/Müşteri bildirimleri, paketler, komisyon, finans, WhatsApp/)).toBeTruthy();
  });

  it("resume: the same server state renders the same wizard (nothing lives in the page)", () => {
    const status = statusFor(["profile", "services"], ["no_staff", "no_working_hours", "no_bookable_staff", "public_booking_disabled"]);
    const first = renderWizard({ initialStatus: status });
    const html = first.container.innerHTML;
    first.unmount();
    expect(renderWizard({ initialStatus: status }).container.innerHTML).toBe(html);
  });
});

describe("services step", () => {
  const open = () => renderWizard({ initialStatus: statusFor(["profile"], ["no_services", "no_staff", "no_working_hours", "no_bookable_staff", "public_booking_disabled"]) });

  it("sends exactly the filled rows (empty rows are dropped) and shows the server's created/skipped count", async () => {
    vi.mocked(addServicesAction).mockResolvedValue(ok({ status: statusFor(["profile", "services"], ["no_staff"]), created: 2, skipped: 1 }));
    open();
    const names = screen.getAllByLabelText("Hizmet adı");
    const durations = screen.getAllByLabelText("Süre (dk)");
    const prices = screen.getAllByLabelText("Fiyat");
    const categories = screen.getAllByLabelText("Kategori");
    fireEvent.change(categories[0]!, { target: { value: "Saç" } });
    fireEvent.change(names[0]!, { target: { value: "Saç Kesimi" } });
    fireEvent.change(durations[0]!, { target: { value: "45" } });
    fireEvent.change(prices[0]!, { target: { value: "800" } });
    fireEvent.change(names[1]!, { target: { value: "Fön" } });
    fireEvent.change(durations[1]!, { target: { value: "30" } });
    fireEvent.change(prices[1]!, { target: { value: "400" } });
    fireEvent.click(screen.getByRole("button", { name: "Hizmetleri ekle" }));
    await waitFor(() => expect(addServicesAction).toHaveBeenCalledTimes(1));
    expect(vi.mocked(addServicesAction).mock.calls[0]![1]).toEqual({
      tenantId: TENANT_ID,
      tenantSlug: "ornek-salon",
      items: [
        { category: "Saç", name: "Saç Kesimi", durationMinutes: "45", price: "800" },
        { category: "", name: "Fön", durationMinutes: "30", price: "400" },
      ],
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("pasting lines fills the grid for review before anything is saved", () => {
    open();
    fireEvent.click(screen.getByText("Yapıştırarak ekle"));
    fireEvent.change(screen.getByLabelText("Yapıştırarak ekle", { selector: "textarea" }), {
      target: { value: "# Saç\nSaç Kesimi; 45; 800\nBoya; 120; 2.500,50 ₺" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Satırlara dönüştür" }));
    const names = screen.getAllByLabelText("Hizmet adı") as HTMLInputElement[];
    expect(names.map((n) => n.value)).toEqual(["Saç Kesimi", "Boya"]);
    expect((screen.getAllByLabelText("Fiyat") as HTMLInputElement[]).map((n) => n.value)).toEqual(["800", "2500.50"]);
    expect(addServicesAction).not.toHaveBeenCalled();
  });

  it("an empty grid is refused locally and an action failure is shown in plain words", async () => {
    vi.mocked(addServicesAction).mockResolvedValue(fail("VALIDATION", "Girdiğiniz bilgiler kabul edilmedi, lütfen kontrol edin"));
    open();
    fireEvent.click(screen.getByRole("button", { name: "Hizmetleri ekle" }));
    expect(screen.getByRole("alert").textContent).toBe("Eklenecek dolu satır yok");
    expect(addServicesAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getAllByLabelText("Hizmet adı")[0]!, { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Hizmetleri ekle" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("kabul edilmedi"));
  });
});

describe("staff step", () => {
  it("roster only — says no login or invitation is needed, sends parsed lines", async () => {
    vi.mocked(addStaffAction).mockResolvedValue(ok({ status: statusFor(["profile", "services", "staff"], ["no_working_hours"]), created: 2, skipped: 0 }));
    renderWizard({ initialStatus: statusFor(["profile", "services"], ["no_staff", "no_working_hours", "no_bookable_staff", "public_booking_disabled"]) });
    expect(screen.getByText(/Giriş yapmaları ya da davet edilmeleri gerekmez/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Her satıra bir kişi/), { target: { value: "Ayşe Demir\nMehmet Kaya; 0533 111 22 33" } });
    fireEvent.click(screen.getByRole("button", { name: "Personeli ekle" }));
    await waitFor(() => expect(addStaffAction).toHaveBeenCalledTimes(1));
    expect(vi.mocked(addStaffAction).mock.calls[0]![1]).toEqual({
      tenantId: TENANT_ID,
      tenantSlug: "ornek-salon",
      items: [
        { fullName: "Ayşe Demir", phone: "" },
        { fullName: "Mehmet Kaya", phone: "0533 111 22 33" },
      ],
    });
  });
});

describe("hours step", () => {
  const open = () => renderWizard({ initialStatus: statusFor(["profile", "services", "staff"], ["no_working_hours", "no_bookable_staff", "public_booking_disabled"]) });

  it("one template for everyone chosen: staff without hours are pre-selected; Monday copies to the working days", async () => {
    vi.mocked(applyWeeklyHoursAction).mockResolvedValue(ok({ status: statusFor(["profile", "services", "staff", "hours"], ["no_bookable_staff"]) }));
    open();
    const checkboxFor = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
    expect(checkboxFor(/Ayşe Demir/).checked).toBe(true);
    expect(checkboxFor(/Mehmet Kaya/).checked).toBe(false);

    fireEvent.change(screen.getByLabelText("Pazartesi Başlangıç"), { target: { value: "10:00" } });
    fireEvent.click(screen.getByRole("button", { name: /Pazartesi saatlerini diğer iş günlerine kopyala/ }));
    expect((screen.getByLabelText("Cuma Başlangıç") as HTMLInputElement).value).toBe("10:00");
    expect(screen.queryByLabelText("Pazar Başlangıç")).toBeNull(); // Sunday stays closed

    fireEvent.click(screen.getByRole("button", { name: "Saatleri uygula" }));
    await waitFor(() => expect(applyWeeklyHoursAction).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(applyWeeklyHoursAction).mock.calls[0]![1] as { staffIds: string[]; days: { weekday: number; start: string }[] };
    expect(sent.staffIds).toEqual([STAFF_A]);
    expect(sent.days.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sent.days.every((d) => d.start === "10:00")).toBe(true);
  });

  it("a day can be closed; an inconsistent day is explained and not sent", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Salı Başlangıç"), { target: { value: "20:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Saatleri uygula" }));
    expect(screen.getByRole("alert").textContent).toBe("Bitiş saati başlangıçtan sonra olmalı");
    expect(applyWeeklyHoursAction).not.toHaveBeenCalled();
  });
});

describe("the workspace arrives AFTER the step switch (router.refresh)", () => {
  it("the hours step re-seeds its staff selection when the refreshed workspace brings the new people", () => {
    const status = statusFor(["profile", "services", "staff"], ["no_working_hours", "no_bookable_staff", "public_booking_disabled"]);
    const empty = { ...WORKSPACE, staff: [], pairs: [] };
    const view = renderWizard({ initialStatus: status, workspace: empty });
    expect(screen.getByText("Önce personel ekleyin.")).toBeTruthy();
    view.rerender(
      <NextIntlClientProvider locale="tr" messages={trMessages}>
        <SetupWizard
          tenantId={TENANT_ID}
          tenantSlug="ornek-salon"
          bookingUrl="https://salon.example.test/book/ornek-salon"
          dashboardHref="/app/ornek-salon"
          initialStatus={status}
          workspace={WORKSPACE}
          firstSlotLabel={null}
          can={{ profile: true, services: true, staff: true, hours: true, booking: true }}
        />
      </NextIntlClientProvider>,
    );
    expect((screen.getByRole("checkbox", { name: /Ayşe Demir/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("button", { name: "Saatleri uygula" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("mapping step", () => {
  it("'everyone does everything' checks the whole matrix and sends one assignment per person", async () => {
    vi.mocked(setStaffServicesAction).mockResolvedValue(ok({ status: statusFor(["profile", "services", "staff", "hours", "mapping"], ["public_booking_disabled"]) }));
    renderWizard({ initialStatus: statusFor(["profile", "services", "staff", "hours"], ["no_bookable_staff", "public_booking_disabled"]) });
    fireEvent.click(screen.getByRole("button", { name: "Herkes tüm hizmetleri yapıyor" }));
    for (const box of screen.getAllByRole("checkbox")) expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Eşleştirmeyi kaydet" }));
    await waitFor(() => expect(setStaffServicesAction).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(setStaffServicesAction).mock.calls[0]![1] as { assignments: { staffId: string; serviceIds: string[] }[] };
    expect(sent.assignments).toEqual([
      { staffId: STAFF_A, serviceIds: [SERVICE_1, SERVICE_2] },
      { staffId: STAFF_B, serviceIds: [SERVICE_1, SERVICE_2] },
    ]);
  });

  it("existing pairs are pre-checked (resume) and unchecking one is honoured", async () => {
    vi.mocked(setStaffServicesAction).mockResolvedValue(ok({ status: statusFor(["profile"], ["no_services"]) }));
    renderWizard({ initialStatus: statusFor(["profile", "services", "staff", "hours", "mapping"], ["public_booking_disabled"]) });
    fireEvent.click(stepButton("Kim hangi hizmeti yapıyor"));
    const first = screen.getByRole("checkbox", { name: "Ayşe Demir – Saç Kesimi" }) as HTMLInputElement;
    expect(first.checked).toBe(true);
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "Eşleştirmeyi kaydet" }));
    await waitFor(() => expect(setStaffServicesAction).toHaveBeenCalled());
    const sent = vi.mocked(setStaffServicesAction).mock.calls[0]![1] as { assignments: { staffId: string; serviceIds: string[] }[] };
    expect(sent.assignments[0]).toEqual({ staffId: STAFF_A, serviceIds: [] });
  });
});

describe("booking and the closing step", () => {
  it("turning online booking on uses the existing action, then refreshes", async () => {
    vi.mocked(updateOnlineBookingSettingAction).mockResolvedValue(ok(true));
    renderWizard({ initialStatus: statusFor(["profile", "services", "staff", "hours", "mapping"], ["public_booking_disabled"]) });
    fireEvent.click(screen.getByRole("button", { name: "Online rezervasyonu aç" }));
    await waitFor(() => expect(updateOnlineBookingSettingAction).toHaveBeenCalledWith(null, { tenantId: TENANT_ID, tenantSlug: "ornek-salon", enabled: true }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("READY only when the server says so: shows the address and the first free time", () => {
    renderWizard({
      initialStatus: statusFor(["profile", "services", "staff", "hours", "mapping", "booking", "ready"]),
      firstSlotLabel: "27 Ekim 2026 09:00",
    });
    expect(screen.getByText("Rezervasyon sayfanız hazır")).toBeTruthy();
    expect(screen.getByText("https://salon.example.test/book/ornek-salon")).toBeTruthy();
    expect(screen.getByText("İlk müsait zaman: 27 Ekim 2026 09:00")).toBeTruthy();
    expect(screen.queryByText("Rezervasyon sayfanız henüz hazır değil")).toBeNull();
  });

  it("NOT ready: no 'ready' claim, every blocker named with a way to fix it", () => {
    renderWizard({
      initialStatus: statusFor(["profile", "services", "staff", "hours", "mapping", "booking"], ["no_available_slot"]),
    });
    fireEvent.click(stepButton("Hazır"));
    expect(screen.queryByText("Rezervasyon sayfanız hazır")).toBeNull();
    expect(screen.getByText("Rezervasyon sayfanız henüz hazır değil")).toBeTruthy();
    expect(screen.getByText("Önümüzdeki 14 günde randevu alınabilecek boş saat yok.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Düzelt" }));
    expect(stepButton("Çalışma saatleri").getAttribute("aria-expanded")).toBe("true");
  });
});

describe("authorization and privacy in the UI", () => {
  it("a caller without permission for a step is told so and gets no form", () => {
    renderWizard({
      can: { profile: false, services: false, staff: false, hours: false, booking: false },
      initialStatus: statusFor([], ["salon_profile_missing"]),
    });
    expect(screen.getByText("Bu adımı salon sahibi tamamlayabilir.")).toBeTruthy();
    expect(screen.queryByLabelText("Salon adı")).toBeNull();
  });

  it("no identifier (tenant, staff, service) is ever rendered as text", () => {
    const { container } = renderWizard({ initialStatus: statusFor(["profile", "services", "staff", "hours", "mapping"], ["public_booking_disabled"]) });
    fireEvent.click(stepButton("Kim hangi hizmeti yapıyor"));
    const text = container.textContent ?? "";
    for (const id of [TENANT_ID, STAFF_A, STAFF_B, SERVICE_1, SERVICE_2]) expect(text).not.toContain(id);
  });
});
