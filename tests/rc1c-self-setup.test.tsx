// @vitest-environment jsdom
/**
 * RC.1C - the owner completes the last bits of her own setup in the app: what is still open is derived (never replacing the readiness
 * answer), a fixed-price service waiting for its calendar duration shows no pre-filled value, and saving writes ONLY the real duration
 * and opens that service for booking. No database: a recording fake client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import trMessages from "@/messages/tr.json";

const calls: { table: string; payload: Record<string, unknown>; filters: [string, unknown][] }[] = [];
let returned: { data: { id: string }[] | null; error: { code?: string; message: string } | null } = { data: [{ id: "s1" }], error: null };
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => {
        const filters: [string, unknown][] = [];
        const chain = {
          eq: (c: string, v: unknown) => {
            filters.push([c, v]);
            return chain;
          },
          select: async () => {
            calls.push({ table, payload, filters });
            return returned;
          },
        };
        return chain;
      },
    }),
  })),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => ({ id: "u" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const refresh = vi.fn();
vi.mock("@/lib/i18n/navigation", () => ({ useRouter: () => ({ refresh, push: () => undefined }), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { pendingSchedulingServices, remainingSetupTasks, type OnboardingStatus } from "@/lib/modules/onboarding/model";
import { setServiceCalendarDurationAction } from "@/lib/modules/services/actions";
import { SchedulingTasks } from "@/components/onboarding/scheduling-tasks";

beforeEach(() => {
  calls.length = 0;
  refresh.mockClear();
  returned = { data: [{ id: "s1" }], error: null };
});
afterEach(() => cleanup());

function status(over: Partial<OnboardingStatus> & { done?: string[] } = {}): OnboardingStatus {
  const done = new Set(over.done ?? ["profile", "services", "staff", "mapping"]);
  return {
    ready: false,
    blockers: ["no_working_hours", "public_booking_disabled"],
    tenantSlug: "ornek",
    profile: { name: "Emel Beauty Bar", phone: "+905338798069", missing: [], currency: "TRY", timezone: "Europe/Nicosia" },
    counts: { staff: 1, services: 12, bookablePaths: 12, staffWithHours: 0 },
    onlineBookingEnabled: false,
    hasAppointments: false,
    firstAvailableSlotAt: null,
    bookingEngineReady: false,
    bookingEngineBlockers: ["no_working_hours"],
    steps: (["profile", "services", "staff", "hours", "mapping", "booking", "ready"] as const).map((key) => ({ key, done: done.has(key) })),
    ...over,
  } as OnboardingStatus;
}

describe("what is left is derived, in plain order", () => {
  const services = [
    { pricingMode: "fixed", bookingMode: "inquiry", name: "Kaş Alımı" },
    { pricingMode: "fixed", bookingMode: "direct", name: "Kirpik Laminasyonu" },
    { pricingMode: "inquiry", bookingMode: "inquiry", name: "Nedime Makyajı" },
  ];
  it("only fixed-price services that are still contact-only wait for a duration (inquiry-priced ones never do)", () => {
    expect(pendingSchedulingServices(services).map((s) => s.name)).toEqual(["Kaş Alımı"]);
    expect(pendingSchedulingServices([{} as { pricingMode?: string; bookingMode?: string }])).toEqual([]); // facts missing -> nothing invented
  });
  it("provisioned salon: almost ready, hours then durations, booking not offered yet", () => {
    const r = remainingSetupTasks(status(), ["Kaş Alımı", "Klasik Bakım"]);
    expect(r.almost).toBe(true);
    expect(r.tasks).toEqual([{ key: "hours" }, { key: "durations", names: ["Kaş Alımı", "Klasik Bakım"] }]);
  });
  it("hours in and a real slot exists: only the explicit 'open online booking' remains - never opened automatically", () => {
    const r = remainingSetupTasks(status({ done: ["profile", "services", "staff", "hours", "mapping"], bookingEngineReady: true, firstAvailableSlotAt: "2026-11-02T08:00:00Z" }), []);
    expect(r.tasks).toEqual([{ key: "booking" }]);
  });
  it("a salon missing its basic facts is not 'almost ready'; a ready salon has nothing left", () => {
    expect(remainingSetupTasks(status({ done: ["services"] }), []).almost).toBe(false);
    expect(remainingSetupTasks(status({ ready: true, blockers: [], done: ["profile", "services", "staff", "hours", "mapping", "booking", "ready"], onlineBookingEnabled: true }), []).tasks).toEqual([]);
  });
});

describe("the one write", () => {
  const input = { tenantSlug: "ornek", serviceId: "s1", durationMinutes: 45 };
  it("stores ONLY the duration and opens the fixed-price service for booking", async () => {
    const r = await setServiceCalendarDurationAction(null, input);
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe("services");
    expect(calls[0]!.payload).toEqual({ duration_minutes: 45, booking_mode: "direct" }); // no name, price or text is touched
    expect(calls[0]!.filters).toEqual([["id", "s1"], ["pricing_mode", "fixed"]]); // an inquiry-priced service is never opened this way
  });
  it("refuses nonsense durations before any write", async () => {
    for (const d of [0, 4, 601, 12.5, Number.NaN]) {
      const r = await setServiceCalendarDurationAction(null, { ...input, durationMinutes: d });
      expect(r.success, String(d)).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });
  it("someone without the right (RLS returns no row) gets a plain refusal, not a success", async () => {
    returned = { data: [], error: null };
    const r = await setServiceCalendarDurationAction(null, input);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/yetkiniz yok/);
  });
});

describe("the task list", () => {
  function view(canManage = true) {
    return render(
      <NextIntlClientProvider locale="tr" messages={trMessages}>
        <SchedulingTasks tenantSlug="ornek" canManage={canManage} services={[{ id: "s1", name: "Kaş Alımı", price: "600.00" }, { id: "s2", name: "Klasik Bakım", price: "4000.00" }]} />
      </NextIntlClientProvider>,
    );
  }
  it("one row per service, nothing pre-filled, save disabled until minutes are typed", () => {
    view();
    const input = screen.getByLabelText("Kaş Alımı takvim süresi (dakika)") as HTMLInputElement;
    expect(input.value).toBe("");
    const buttons = screen.getAllByRole("button", { name: "Kaydet" }) as HTMLButtonElement[];
    expect(buttons.every((b) => b.disabled)).toBe(true);
    fireEvent.change(input, { target: { value: "20" } });
    expect(buttons[0]!.disabled).toBe(false);
    expect(buttons[1]!.disabled).toBe(true);
  });
  it("saving writes that one service and refreshes the page; a refusal is shown in plain Turkish", async () => {
    view();
    fireEvent.change(screen.getByLabelText("Kaş Alımı takvim süresi (dakika)"), { target: { value: "20" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Kaydet" })[0]!);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]!.payload).toEqual({ duration_minutes: 20, booking_mode: "direct" });
    cleanup();
    returned = { data: [], error: null };
    view();
    fireEvent.change(screen.getByLabelText("Klasik Bakım takvim süresi (dakika)"), { target: { value: "60" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Kaydet" })[1]!);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/yetkiniz yok/));
  });
  it("a member who may not manage services sees why, and cannot type", () => {
    view(false);
    expect(screen.getByText("Bu süreleri salon sahibi girebilir.")).toBeTruthy();
    expect((screen.getByLabelText("Kaş Alımı takvim süresi (dakika)") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("Turkish copy", () => {
  it("the almost-ready message and the remaining items are plain Turkish", () => {
    expect(trMessages.Setup.almost.title).toBe("Salonunuz neredeyse hazır");
    expect(trMessages.Setup.almost.taskHours).toBe("Çalışma günleri ve saatleri");
    expect(trMessages.Setup.almost.taskDurations).toContain("Takvim süresi");
    expect(Object.values(trMessages.Setup.almost).join(" ")).not.toMatch(/placeholder|inquiry|booking_mode/i);
  });
});
