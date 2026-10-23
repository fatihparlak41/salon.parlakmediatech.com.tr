// @vitest-environment jsdom
/**
 * Faz LAUNCH.1B — the Owner's "Müşteri Bildirimleri" settings card. Fully isolated: the
 * Server Action is mocked and both Supabase client factories throw, so nothing here can
 * reach a real project. What matters: the four switches and their Turkish wording, that a
 * switch moves only on the server's confirmation (a refusal leaves it where it was and says
 * so), that no request is made for anything but the one switch touched, and the delivery
 * health line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import trMessages from "@/messages/tr.json";
import { CustomerNotificationSettings } from "@/components/settings/customer-notification-settings";
import { updateCustomerNotificationSettingAction } from "@/lib/modules/settings/actions";
import { fail, ok } from "@/lib/errors";
import {
  parseCustomerNotificationHealth,
  parseCustomerNotificationSettings,
  type CustomerNotificationHealth,
  type CustomerNotificationSettings as Settings,
} from "@/lib/modules/settings/queries";

vi.mock("@/lib/modules/settings/actions", () => ({
  updateCustomerNotificationSettingAction: vi.fn(),
}));
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

const mockedAction = vi.mocked(updateCustomerNotificationSettingAction);

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ALL_OFF: Settings = {
  appointment_confirmation: false,
  appointment_update: false,
  appointment_cancellation: false,
  appointment_reminder_24h: false,
};

function renderCard(settings: Settings = ALL_OFF, health: CustomerNotificationHealth | null = null) {
  return render(
    <NextIntlClientProvider locale="tr" messages={trMessages}>
      <CustomerNotificationSettings tenantId={TENANT_ID} tenantSlug="ornek-salon" initialSettings={settings} health={health} />
    </NextIntlClientProvider>,
  );
}

const LABELS = ["Randevu onay e-postası", "Değişiklik e-postası", "İptal e-postası", "24 saat hatırlatma"];

beforeEach(() => {
  mockedAction.mockReset();
});
afterEach(() => cleanup());

describe("the card", () => {
  it("shows the four switches in Turkish, in the product's order, each with its own hint", () => {
    renderCard({ ...ALL_OFF, appointment_cancellation: true });
    expect(screen.getByRole("heading", { name: "Müşteri Bildirimleri" })).toBeTruthy();
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(4);
    LABELS.forEach((label, index) => {
      expect(screen.getByText(label)).toBeTruthy();
      expect(switches[index]!.getAttribute("aria-labelledby")).toContain("customer-notification-");
    });
    expect(switches.map((control) => control.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
    expect(screen.getByText(/Randevudan 24 saat önce gönderilir/)).toBeTruthy();
    // SMS / WhatsApp are not offered in this version
    expect(screen.queryByText(/sms|whatsapp/i)).toBeNull();
  });

  it("turning one switch on sends exactly that one change and moves only on the server's confirmation", async () => {
    mockedAction.mockResolvedValue(ok({ type: "appointment_update", enabled: true }));
    renderCard();
    const control = screen.getAllByRole("switch")[1]!;
    fireEvent.click(control);
    await waitFor(() => expect(mockedAction).toHaveBeenCalledTimes(1));
    expect(mockedAction).toHaveBeenCalledWith(null, {
      tenantId: TENANT_ID,
      tenantSlug: "ornek-salon",
      type: "appointment_update",
      enabled: true,
    });
    await waitFor(() => expect(screen.getAllByRole("switch")[1]!.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("Kaydedildi.")).toBeTruthy();
    expect(screen.getAllByRole("switch").map((el) => el.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false"]);
  });

  it("a refusal leaves the switch where it was and shows the error", async () => {
    mockedAction.mockResolvedValue(fail("UNAUTHORIZED", "Bu işlem için yetkiniz yok"));
    renderCard({ ...ALL_OFF, appointment_confirmation: true });
    fireEvent.click(screen.getAllByRole("switch")[0]!);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Bu işlem için yetkiniz yok"));
    expect(screen.getAllByRole("switch")[0]!.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Kaydedildi.")).toBeNull();
  });

  it("while a change is being saved no second request can be started", async () => {
    let release: (value: Awaited<ReturnType<typeof updateCustomerNotificationSettingAction>>) => void = () => {};
    mockedAction.mockReturnValue(new Promise((resolve) => (release = resolve)));
    renderCard();
    fireEvent.click(screen.getAllByRole("switch")[0]!);
    await waitFor(() => expect(screen.getAllByRole("switch").every((el) => el.getAttribute("aria-disabled") === "true")).toBe(true));
    fireEvent.click(screen.getAllByRole("switch")[2]!);
    expect(mockedAction).toHaveBeenCalledTimes(1);
    release(ok({ type: "appointment_confirmation", enabled: true }));
    await waitFor(() => expect(screen.getAllByRole("switch").every((el) => el.getAttribute("aria-disabled") !== "true")).toBe(true));
  });

  it("makes delivery problems visible; a healthy salon sees a calm summary; unavailable health shows nothing", () => {
    const base: CustomerNotificationHealth = { windowDays: 14, sent: 12, failed: 0, uncertain: 0, waiting: 1, skippedNoRecipient: 3 };
    const { unmount } = renderCard(ALL_OFF, { ...base, failed: 2, uncertain: 1 });
    expect(screen.getByTestId("customer-notification-health").textContent).toBe("Son 14 günde 3 e-posta gönderilemedi veya teslimi doğrulanamadı.");
    unmount();
    const ok2 = renderCard(ALL_OFF, base);
    expect(screen.getByTestId("customer-notification-health").textContent).toBe("Son 14 günde 12 e-posta gönderildi, sorun yok.");
    ok2.unmount();
    renderCard(ALL_OFF, null);
    expect(screen.queryByTestId("customer-notification-health")).toBeNull();
  });
});

describe("what the page reads is parsed defensively", () => {
  it("settings: anything that is not exactly true is OFF; a non-object is all OFF", () => {
    expect(parseCustomerNotificationSettings({ appointment_confirmation: true, appointment_update: "yes", appointment_cancellation: 1 })).toEqual({
      appointment_confirmation: true,
      appointment_update: false,
      appointment_cancellation: false,
      appointment_reminder_24h: false,
    });
    for (const junk of [null, undefined, "x", 3, [], [true]]) expect(parseCustomerNotificationSettings(junk)).toEqual(ALL_OFF);
  });

  it("health: counts only, negatives and junk become 0, a non-object is unavailable", () => {
    expect(parseCustomerNotificationHealth({ windowDays: 14, sent: 5, failed: -1, uncertain: "x", waiting: 2 })).toEqual({
      windowDays: 14,
      sent: 5,
      failed: 0,
      uncertain: 0,
      waiting: 2,
      skippedNoRecipient: 0,
    });
    expect(parseCustomerNotificationHealth(null)).toBeNull();
    expect(parseCustomerNotificationHealth([])).toBeNull();
  });
});
