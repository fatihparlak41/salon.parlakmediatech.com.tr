// @vitest-environment jsdom
/**
 * Faz FIN.1A remote review (Blockers 1 & 2) — component-lifecycle
 * regression coverage for AppointmentFinancePanel. This is the ONE
 * jsdom/React-Testing-Library file in the suite (per-file environment
 * directive above); every other test file stays on the global
 * environment: "node" DB-integration setup — see vitest.config.ts's own
 * comment on why the include glob now also admits .test.tsx.
 *
 * Fully isolated from Supabase/network: every finance boundary
 * (fetchAppointmentFinanceSummary + the five finance actions) is
 * mocked below. If any test in this file reaches a real network call,
 * that is a bug in this file's isolation, not a passing test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { AppointmentFinancePanel } from "@/components/appointments/appointment-finance-panel";
import { fetchAppointmentFinanceSummary, type AppointmentFinanceSummary } from "@/lib/modules/finance/client-queries";
import {
  getOrCreateAppointmentSaleAction,
  recordAppointmentPaymentAction,
  type RecordAppointmentPaymentInput,
} from "@/lib/modules/finance/actions";
import { ok, fail } from "@/lib/errors";

vi.mock("@/lib/modules/finance/client-queries", () => ({
  fetchAppointmentFinanceSummary: vi.fn(),
}));

vi.mock("@/lib/modules/finance/actions", () => ({
  getOrCreateAppointmentSaleAction: vi.fn(),
  recordAppointmentPaymentAction: vi.fn(),
  voidAppointmentPaymentAction: vi.fn(),
  adjustAppointmentSaleItemPriceAction: vi.fn(),
  adjustAppointmentSaleDiscountAction: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchAppointmentFinanceSummary);
const mockedGetOrCreate = vi.mocked(getOrCreateAppointmentSaleAction);
const mockedRecordPayment = vi.mocked(recordAppointmentPaymentAction);

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
  vi.clearAllMocks();
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
