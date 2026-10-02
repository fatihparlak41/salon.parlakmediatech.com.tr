// @vitest-environment jsdom
/**
 * Faz FIN.1A remote review (Blockers 1 & 2, then the atomic-pricing fix)
 * — component-lifecycle regression coverage for AppointmentFinancePanel.
 * This is the ONE jsdom/React-Testing-Library file in the suite
 * (per-file environment directive above); every other test file stays
 * on the global environment: "node" DB-integration setup — see
 * vitest.config.ts's own comment on why the include glob now also
 * admits .test.tsx.
 *
 * Fully isolated from Supabase/network: every finance boundary
 * (fetchAppointmentFinanceSummary + the finance actions) is mocked
 * below, AND both Supabase client factories are replaced with
 * constructors that THROW — so if any code path under test ever tried
 * to build a real Supabase client (browser or server), the test would
 * fail loudly instead of silently reaching a real project. If any test
 * in this file reaches a real network call, that is a bug in this
 * file's isolation, not a passing test.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { AppointmentFinancePanel } from "@/components/appointments/appointment-finance-panel";
import { fetchAppointmentFinanceSummary, type AppointmentFinanceSummary } from "@/lib/modules/finance/client-queries";
import {
  getOrCreateAppointmentSaleAction,
  recordAppointmentPaymentAction,
  updateAppointmentSalePricingAction,
  type RecordAppointmentPaymentInput,
  type UpdateAppointmentSalePricingInput,
} from "@/lib/modules/finance/actions";
import { requireUser } from "@/lib/auth/session";
import { createClient as createServerSupabaseClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/errors";

vi.mock("@/lib/modules/finance/client-queries", () => ({
  fetchAppointmentFinanceSummary: vi.fn(),
}));

vi.mock("@/lib/modules/finance/actions", () => ({
  getOrCreateAppointmentSaleAction: vi.fn(),
  recordAppointmentPaymentAction: vi.fn(),
  voidAppointmentPaymentAction: vi.fn(),
  updateAppointmentSalePricingAction: vi.fn(),
}));

// Isolation guards: these two exist ONLY so that nothing in this file can
// ever build a real Supabase client. (The real server-action module is
// loaded in one test below via vi.importActual to pin its RPC mapping —
// it gets requireUser and a hand-rolled fake client from these mocks.)
vi.mock("@/lib/auth/session", () => ({
  requireUser: vi.fn(),
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

const mockedFetch = vi.mocked(fetchAppointmentFinanceSummary);
const mockedGetOrCreate = vi.mocked(getOrCreateAppointmentSaleAction);
const mockedRecordPayment = vi.mocked(recordAppointmentPaymentAction);
const mockedUpdatePricing = vi.mocked(updateAppointmentSalePricingAction);
const mockedRequireUser = vi.mocked(requireUser);
const mockedServerClient = vi.mocked(createServerSupabaseClient);

// --- jsdom polyfills Base UI's Dialog/Select actually reach for; none
// of these are production code, and each is a documented, standard gap
// in jsdom itself (not something this project's components misuse). ---
beforeEach(() => {
  if (!("ResizeObserver" in globalThis)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverStub;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!globalThis.matchMedia) {
    // @ts-expect-error -- test-only stub
    globalThis.matchMedia = () => ({
      matches: false,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  }
});

afterEach(() => {
  cleanup();
  // resetAllMocks (not just clear): a leftover mockResolvedValue/Once
  // queue from one test must never leak into the next. vi.fn(impl)
  // mocks — the two throwing Supabase-client guards above — are reset
  // back to their original impl, so the isolation guards survive.
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeSummary(overrides: Partial<AppointmentFinanceSummary> = {}): AppointmentFinanceSummary {
  return {
    id: "sale-1",
    appointmentId: "appt-1",
    currency: "TRY",
    subtotal: 500,
    discountAmount: 0,
    totalAmount: 500,
    collected: 0,
    outstanding: 500,
    status: "open",
    items: [{ id: "item-1", appointmentItemId: "ai-1", serviceName: "Saç Kesimi", unitPrice: 500 }],
    payments: [],
    ...overrides,
  };
}

/** Deterministic, sequential — key-1, key-2, ... — so tests can assert
 * "same key across a retry" vs. "different key across a fresh mount"
 * without depending on real crypto.randomUUID's actual output shape. */
function mockSequentialUuids() {
  let n = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    n += 1;
    return `key-${n}` as `${string}-${string}-${string}-${string}-${string}`;
  });
}

describe("A — no write on read (Blocker 1)", () => {
  it("completed + finance.manage + no sale: shows the empty state and NEVER calls getOrCreateAppointmentSaleAction", async () => {
    mockedFetch.mockResolvedValue(null);
    render(<AppointmentFinancePanel appointmentId="appt-1" canManage={true} isCompleted={true} />);

    await screen.findByText("Henüz bir tahsilat işlemi başlatılmadı.");
    expect(mockedGetOrCreate).not.toHaveBeenCalled();
  });

  it('clicking "Tahsilatı Başlat" calls getOrCreateAppointmentSaleAction exactly once, then reloads the summary', async () => {
    mockedFetch.mockResolvedValueOnce(null);
    mockedGetOrCreate.mockResolvedValue(ok({ id: "sale-1" }));
    mockedFetch.mockResolvedValueOnce(makeSummary());

    render(<AppointmentFinancePanel appointmentId="appt-1" canManage={true} isCompleted={true} />);

    const startButton = await screen.findByRole("button", { name: "Tahsilatı Başlat" });
    expect(mockedGetOrCreate).not.toHaveBeenCalled();

    fireEvent.click(startButton);

    await waitFor(() => expect(mockedGetOrCreate).toHaveBeenCalledTimes(1));
    expect(mockedGetOrCreate).toHaveBeenCalledWith(null, { appointmentId: "appt-1" });

    // Summary reload/render occurs: the real financial figures now show,
    // and the empty state / start button are gone.
    await screen.findByText("İşlem Tutarı");
    expect(screen.queryByRole("button", { name: "Tahsilatı Başlat" })).toBeNull();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("a non-completed appointment shows its own empty state and never mutates, even with finance.manage", async () => {
    mockedFetch.mockResolvedValue(null);
    render(<AppointmentFinancePanel appointmentId="appt-1" canManage={true} isCompleted={false} />);

    await screen.findByText("Randevu tamamlandıktan sonra tahsilat başlatılabilir.");
    expect(screen.queryByRole("button", { name: "Tahsilatı Başlat" })).toBeNull();
    expect(mockedGetOrCreate).not.toHaveBeenCalled();
  });

  it("finance.view-only (canManage=false) on a completed appointment never sees the start action and never mutates", async () => {
    mockedFetch.mockResolvedValue(null);
    render(<AppointmentFinancePanel appointmentId="appt-1" canManage={false} isCompleted={true} />);

    await screen.findByText("Henüz bir tahsilat işlemi başlatılmadı.");
    expect(screen.queryByRole("button", { name: "Tahsilatı Başlat" })).toBeNull();
    expect(mockedGetOrCreate).not.toHaveBeenCalled();
  });

  it("an appointment that already has a sale is a pure read — mount never calls getOrCreate", async () => {
    mockedFetch.mockResolvedValue(makeSummary());
    render(<AppointmentFinancePanel appointmentId="appt-1" canManage={true} isCompleted={true} />);

    await screen.findByText("İşlem Tutarı");
    expect(mockedGetOrCreate).not.toHaveBeenCalled();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

describe("B — payment attempt lifecycle (Blocker 2)", () => {
  async function renderWithOpenSale() {
    mockedFetch.mockResolvedValue(makeSummary());
    render(<AppointmentFinancePanel appointmentId="appt-1" canManage={true} isCompleted={true} />);
    const payButton = await screen.findByRole("button", { name: "Ödeme Al" });
    return payButton;
  }

  function getDialog() {
    return screen.getByRole("dialog", { name: "Ödeme Al" });
  }

  function submitPaymentForm(dialog: HTMLElement) {
    const submitButton = within(dialog).getByRole("button", { name: /Ödemeyi Kaydet/ });
    fireEvent.click(submitButton);
  }

  it("retrying the SAME open attempt reuses the exact same idempotencyKey and paidAt", async () => {
    mockSequentialUuids();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));

    const payButton = await renderWithOpenSale();
    fireEvent.click(payButton);
    const dialog = getDialog();

    // First submit fails (e.g. a transient/uncertain network response) —
    // the dialog must stay open and mounted for a same-attempt retry.
    mockedRecordPayment.mockResolvedValueOnce(fail("UNEXPECTED", "geçici hata"));
    submitPaymentForm(dialog);
    await waitFor(() => expect(mockedRecordPayment).toHaveBeenCalledTimes(1));
    // Wait for the failure to actually RENDER, not just for the mock to
    // have been called: while the action is pending the submit button is
    // disabled and relabelled "Kaydediliyor…", so a retry click fired
    // before React settles would hit a disabled button (a race, not a
    // behavior this test is about).
    await within(dialog).findByText("geçici hata");

    // Still mounted: same instance, same generated key/timestamp.
    expect(getDialog()).toBe(dialog);

    // Advance real wall-clock time before the retry — if paidAt were
    // recomputed per-submit (the original bug), this would now differ.
    vi.setSystemTime(new Date("2026-09-30T10:05:00.000Z"));

    mockedRecordPayment.mockResolvedValueOnce(ok({ id: "payment-1" }));
    submitPaymentForm(dialog);
    await waitFor(() => expect(mockedRecordPayment).toHaveBeenCalledTimes(2));

    const firstCallInput = mockedRecordPayment.mock.calls[0]![1];
    const secondCallInput = mockedRecordPayment.mock.calls[1]![1];
    const first = firstCallInput as unknown as RecordAppointmentPaymentInput;
    const second = secondCallInput as unknown as RecordAppointmentPaymentInput;

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.paidAt).toBe(first.paidAt);
    expect(second.amount).toBe(first.amount);
    expect(second.method).toBe(first.method);
  });

  it("closing and reopening for a NEW payment gets a fresh idempotencyKey and a fresh paidAt, independent amount/method/note", async () => {
    mockSequentialUuids();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));

    const payButton = await renderWithOpenSale();

    // --- Attempt 1: succeeds outright. ---
    fireEvent.click(payButton);
    let dialog = getDialog();
    mockedRecordPayment.mockResolvedValueOnce(ok({ id: "payment-1" }));
    // Second summary read after the successful reload — a partial
    // payment, so "Ödeme Al" remains available for a second attempt.
    mockedFetch.mockResolvedValueOnce(makeSummary({ collected: 200, outstanding: 300, status: "partially_paid" }));
    submitPaymentForm(dialog);
    await waitFor(() => expect(mockedRecordPayment).toHaveBeenCalledTimes(1));
    // A successful submit closes the dialog (onRecorded -> setShowPaymentDialog(false)) — unmounted, not merely hidden.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ödeme Al" })).toBeNull());

    const firstCallInput = mockedRecordPayment.mock.calls[0]![1];
    const first = firstCallInput as unknown as RecordAppointmentPaymentInput;

    // Time moves on before the second, unrelated payment attempt.
    vi.setSystemTime(new Date("2026-09-30T11:30:00.000Z"));

    // --- Attempt 2: a fresh "Ödeme Al" click -> fresh PaymentDialog mount. ---
    const payButtonAgain = await screen.findByRole("button", { name: "Ödeme Al" });
    fireEvent.click(payButtonAgain);
    dialog = getDialog();

    // Change amount and note before submitting, proving this attempt's
    // payload is genuinely independent of the first, not just a fresh
    // key/timestamp on an otherwise-identical payload.
    const amountInput = within(dialog).getByLabelText(/Tutar/) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "150" } });
    const noteInput = within(dialog).getByLabelText(/Not/) as HTMLInputElement;
    fireEvent.change(noteInput, { target: { value: "ikinci taksit" } });

    mockedRecordPayment.mockResolvedValueOnce(ok({ id: "payment-2" }));
    submitPaymentForm(dialog);
    await waitFor(() => expect(mockedRecordPayment).toHaveBeenCalledTimes(2));

    const secondCallInput = mockedRecordPayment.mock.calls[1]![1];
    const second = secondCallInput as unknown as RecordAppointmentPaymentInput;

    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(second.paidAt).not.toBe(first.paidAt);
    expect(second.amount).not.toBe(first.amount);
    expect(second.amount).toBe(150);
    expect(second.note).toBe("ikinci taksit");
    expect(first.note).toBeUndefined();
  });

  it("the very first dialog open for a sale generates exactly one idempotencyKey (not one per render)", async () => {
    mockSequentialUuids();
    const payButton = await renderWithOpenSale();
    fireEvent.click(payButton);
    getDialog();

    // The Select trigger re-render (method field) or any other internal
    // re-render must not mint a second key while still mounted.
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });
});

describe("C — pricing save is ONE atomic Server Action call (AdjustPanel)", () => {
  function twoItemSummary(overrides: Partial<AppointmentFinanceSummary> = {}): AppointmentFinanceSummary {
    return makeSummary({
      subtotal: 500,
      totalAmount: 500,
      outstanding: 500,
      items: [
        { id: "item-1", appointmentItemId: "ai-1", serviceName: "Saç Kesimi", unitPrice: 300 },
        { id: "item-2", appointmentItemId: "ai-2", serviceName: "Fön", unitPrice: 200 },
      ],
      ...overrides,
    });
  }

  async function openAdjustPanel(summary: AppointmentFinanceSummary = twoItemSummary()) {
    mockedFetch.mockResolvedValueOnce(summary);
    render(<AppointmentFinancePanel appointmentId="appt-1" canManage={true} isCompleted={true} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fiyat / İndirim Düzenle" }));
    return screen.findByRole("button", { name: "Kaydet" });
  }

  function typeInto(label: string | RegExp, value: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }

  it("editing several prices + the discount and clicking Kaydet calls the pricing action EXACTLY ONCE", async () => {
    mockedUpdatePricing.mockResolvedValue(ok(null));
    const saveButton = await openAdjustPanel();
    mockedFetch.mockResolvedValueOnce(twoItemSummary({ totalAmount: 450, outstanding: 450 }));

    typeInto("Saç Kesimi", "350");
    typeInto("Fön", "150");
    typeInto(/İndirim \(TRY\)/, "50");
    typeInto(/İndirim nedeni/, "toplu düzenleme");
    fireEvent.click(saveButton);

    await waitFor(() => expect(mockedUpdatePricing).toHaveBeenCalledTimes(1));
    // No other finance mutation of any kind ran as part of this one save.
    expect(mockedGetOrCreate).not.toHaveBeenCalled();
    expect(mockedRecordPayment).not.toHaveBeenCalled();
  });

  it("the payload is the COMPLETE desired item set — including items the user did not touch", async () => {
    mockedUpdatePricing.mockResolvedValue(ok(null));
    const saveButton = await openAdjustPanel();
    mockedFetch.mockResolvedValueOnce(twoItemSummary());

    // Only the first item and the discount are edited; the second
    // item's price must STILL be sent (the DB RPC rejects any request
    // that is not exactly the sale's current item set).
    typeInto("Saç Kesimi", "350");
    typeInto(/İndirim \(TRY\)/, "50");
    typeInto(/İndirim nedeni/, "  toplu düzenleme  ");
    fireEvent.click(saveButton);

    await waitFor(() => expect(mockedUpdatePricing).toHaveBeenCalledTimes(1));
    const input = mockedUpdatePricing.mock.calls[0]![1] as UpdateAppointmentSalePricingInput;
    expect(input).toEqual({
      saleId: "sale-1",
      items: [
        { saleItemId: "item-1", unitPrice: 350 },
        { saleItemId: "item-2", unitPrice: 200 },
      ],
      discountAmount: 50,
      discountReason: "toplu düzenleme",
    });
  });

  it("a failed save leaves the panel open with the error shown, and never reloads the summary", async () => {
    mockedUpdatePricing.mockResolvedValueOnce(fail("UNEXPECTED", "Yeni toplam, tahsil edilen tutarın altında olamaz"));
    const saveButton = await openAdjustPanel();

    typeInto("Saç Kesimi", "10");
    fireEvent.click(saveButton);

    await screen.findByText("Yeni toplam, tahsil edilen tutarın altında olamaz");
    expect(mockedUpdatePricing).toHaveBeenCalledTimes(1);
    // Panel still open, with the user's edits intact and the button usable again.
    expect(screen.getByRole("button", { name: "Kaydet" })).not.toBeNull();
    expect((screen.getByLabelText("Saç Kesimi") as HTMLInputElement).value).toBe("10");
    // Only the initial read ever ran — a failure triggers no reload.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("a successful save reloads the summary and closes the panel", async () => {
    mockedUpdatePricing.mockResolvedValueOnce(ok(null));
    const saveButton = await openAdjustPanel(twoItemSummary({ status: "open" }));
    expect(screen.getByText("Ödenmedi")).not.toBeNull();
    // Reload result: partially paid now, so the status badge visibly changes.
    mockedFetch.mockResolvedValueOnce(
      twoItemSummary({ totalAmount: 450, collected: 100, outstanding: 350, discountAmount: 50, status: "partially_paid" }),
    );

    typeInto(/İndirim \(TRY\)/, "50");
    fireEvent.click(saveButton);

    await screen.findByText("Kısmi Ödendi");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    // The edit panel closed itself.
    expect(screen.queryByRole("button", { name: "Kaydet" })).toBeNull();
    expect(screen.queryByLabelText("Saç Kesimi")).toBeNull();
  });
});

describe("D — the old per-line adjustment APIs are gone, and the real action maps to ONE rpc", () => {
  it("the real finance actions module exports exactly the four intended mutations — no per-item price or per-sale discount action", async () => {
    const real = await vi.importActual<Record<string, unknown>>("@/lib/modules/finance/actions");
    // Exact list on purpose: a redundant public mutation path for the
    // V1 pricing operation must be a deliberate, test-visible change.
    expect(Object.keys(real).sort()).toEqual([
      "getOrCreateAppointmentSaleAction",
      "recordAppointmentPaymentAction",
      "updateAppointmentSalePricingAction",
      "voidAppointmentPaymentAction",
    ]);
    expect(real).not.toHaveProperty("adjustAppointmentSaleItemPriceAction");
    expect(real).not.toHaveProperty("adjustAppointmentSaleDiscountAction");
  });

  it("the finance schemas module no longer exports the per-item / per-discount schemas", async () => {
    const schemas = await vi.importActual<Record<string, unknown>>("@/lib/modules/finance/schemas");
    expect(schemas).not.toHaveProperty("adjustSaleItemPriceSchema");
    expect(schemas).not.toHaveProperty("adjustSaleDiscountSchema");
    expect(schemas).toHaveProperty("updateAppointmentSalePricingSchema");
  });

  it("the finance panel source no longer references (imports or calls) any per-line adjustment action", () => {
    const source = readFileSync(path.join(process.cwd(), "components/appointments/appointment-finance-panel.tsx"), "utf8");
    expect(source).not.toMatch(/adjustAppointmentSale(ItemPrice|Discount)Action/);
    expect(source).toMatch(/updateAppointmentSalePricingAction/);
  });

  it("the real updateAppointmentSalePricingAction sends exactly ONE update_appointment_sale_pricing rpc with the complete snake_case item set", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "sale-1" }, error: null });
    mockedRequireUser.mockResolvedValue({} as never);
    mockedServerClient.mockResolvedValue({ rpc } as never);
    const real = await vi.importActual<typeof import("@/lib/modules/finance/actions")>("@/lib/modules/finance/actions");

    const saleId = "11111111-1111-4111-8111-111111111111";
    const itemA = "22222222-2222-4222-8222-222222222222";
    const itemB = "33333333-3333-4333-8333-333333333333";
    const result = await real.updateAppointmentSalePricingAction(null, {
      saleId,
      items: [
        { saleItemId: itemA, unitPrice: 350 },
        { saleItemId: itemB, unitPrice: 150 },
      ],
      discountAmount: 50,
      discountReason: "toplu düzenleme",
    });

    expect(result.success).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("update_appointment_sale_pricing", {
      p_sale_id: saleId,
      p_items: [
        { sale_item_id: itemA, unit_price: 350 },
        { sale_item_id: itemB, unit_price: 150 },
      ],
      p_discount_amount: 50,
      p_discount_reason: "toplu düzenleme",
    });
  });

  it("the real action rejects a malformed request client-side without calling the rpc at all (the DB stays the authority for everything else)", async () => {
    const rpc = vi.fn();
    mockedRequireUser.mockResolvedValue({} as never);
    mockedServerClient.mockResolvedValue({ rpc } as never);
    const real = await vi.importActual<typeof import("@/lib/modules/finance/actions")>("@/lib/modules/finance/actions");

    const result = await real.updateAppointmentSalePricingAction(null, {
      saleId: "not-a-uuid",
      items: [],
      discountAmount: -1,
    });

    expect(result.success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});
