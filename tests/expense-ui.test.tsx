// @vitest-environment jsdom
/**
 * Faz FIN.1B.1 — component and lifecycle coverage for the expense UI (matrix F4, F7-F11), in the same isolation as the
 * FIN.1A checkout UI test: every expense boundary (the five Server Actions and the two browser reads) is mocked, the router is
 * a spy, and BOTH Supabase client factories are replaced with constructors that THROW, so a code path that ever tried to build a
 * real client fails loudly instead of silently reaching a real project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import trMessages from "@/messages/tr.json";
import { CreateExpenseDialog } from "@/components/expenses/create-expense-dialog";
import { EditExpenseDialog } from "@/components/expenses/edit-expense-dialog";
import { ExpensesPageClient } from "@/components/expenses/expenses-page-client";
import { RecordExpensePaymentDialog } from "@/components/expenses/record-expense-payment-dialog";
import { VoidExpensePaymentDialog } from "@/components/expenses/void-expense-payment-dialog";
import { CancelExpenseDialog } from "@/components/expenses/cancel-expense-dialog";
import {
  cancelExpenseAction,
  createExpenseAction,
  recordExpensePaymentAction,
  updateExpenseAction,
  voidExpensePaymentAction,
} from "@/lib/modules/expenses/actions";
import {
  fetchExpenseDetail,
  fetchExpensesPage,
} from "@/lib/modules/expenses/client-queries";
import { EXPENSE_ERROR_MESSAGES } from "@/lib/modules/expenses/error-codes";
import {
  DEFAULT_EXPENSES_FILTERS,
  listParamsFor,
} from "@/lib/modules/expenses/filters";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import type {
  ExpenseCategory,
  ExpenseDetail,
  ExpenseListItem,
  ExpenseListPage,
  ExpenseOverview,
  ExpensePaymentView,
  ExpenseWriteResult,
} from "@/lib/modules/expenses/types";
import { fail, ok } from "@/lib/errors";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/lib/modules/expenses/actions", () => ({
  createExpenseAction: vi.fn(),
  updateExpenseAction: vi.fn(),
  cancelExpenseAction: vi.fn(),
  recordExpensePaymentAction: vi.fn(),
  voidExpensePaymentAction: vi.fn(),
}));
vi.mock("@/lib/modules/expenses/client-queries", () => ({
  fetchExpensesPage: vi.fn(),
  fetchExpenseDetail: vi.fn(),
}));
vi.mock("@/lib/i18n/navigation", () => ({
  useRouter: () => nav,
  usePathname: () => "/app/bella-hair/finance/expenses",
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error(
      "a real server Supabase client was requested: this file must never touch Supabase",
    );
  }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => {
    throw new Error(
      "a real browser Supabase client was requested: this file must never touch Supabase",
    );
  }),
}));

const mockedCreate = vi.mocked(createExpenseAction);
const mockedUpdate = vi.mocked(updateExpenseAction);
const mockedCancel = vi.mocked(cancelExpenseAction);
const mockedRecord = vi.mocked(recordExpensePaymentAction);
const mockedVoid = vi.mocked(voidExpensePaymentAction);
const mockedDetail = vi.mocked(fetchExpenseDetail);
const mockedPage = vi.mocked(fetchExpensesPage);

const labels = trMessages.Expenses as unknown as ExpenseLabels;
const SLUG = "bella-hair";
const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXPENSE_ID = "33333333-3333-4333-8333-333333333333";
const PAYMENT_ID = "44444444-4444-4444-8444-444444444444";
const BRANCH_ID = "55555555-5555-4555-8555-555555555555";
const REFERENCE_DATE = "2026-09-15";

// --- jsdom polyfills Base UI's Dialog/Sheet reach for (same documented gaps as the FIN.1A UI test) ---
beforeEach(() => {
  if (!("ResizeObserver" in globalThis)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverStub;
  }
  if (!Element.prototype.hasPointerCapture)
    Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture)
    Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture)
    Element.prototype.releasePointerCapture = () => {};
  if (!Element.prototype.scrollIntoView)
    Element.prototype.scrollIntoView = () => {};
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
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------
const CATEGORY_KINDS: [string, "fixed" | "variable"][] = [
  ["rent", "fixed"],
  ["electricity", "fixed"],
  ["water", "fixed"],
  ["internet", "fixed"],
  ["phone", "fixed"],
  ["accountant", "fixed"],
  ["software", "fixed"],
  ["pos_fees", "fixed"],
  ["supplies", "variable"],
  ["beauty_products", "variable"],
  ["cleaning", "variable"],
  ["advertising", "variable"],
  ["food", "variable"],
  ["transport", "variable"],
  ["repairs", "variable"],
  ["other", "variable"],
];
const categories: ExpenseCategory[] = CATEGORY_KINDS.map(([key, kind], i) => ({
  key,
  kind,
  displayOrder: kind === "fixed" ? (i + 1) * 10 : 100 + (i - 7) * 10,
}));
const branches = [{ id: BRANCH_ID, name: "Merkez Şube" }];

function makeOverview(over: Partial<ExpenseOverview> = {}): ExpenseOverview {
  return {
    month: "2026-09-01",
    referenceDate: REFERENCE_DATE,
    primaryCurrency: "TRY",
    byCurrency: [
      {
        currency: "TRY",
        incurred: 13100,
        paid: 11400,
        outstanding: { total: 2900, count: 3 },
        overdue: { total: 800, count: 1 },
        upcoming: { total: 1500, count: 1, withinDays: 14 },
      },
    ],
    ...over,
  };
}

function makeItem(over: Partial<ExpenseListItem> = {}): ExpenseListItem {
  return {
    id: EXPENSE_ID,
    branchId: null,
    branchName: null,
    categoryKey: "rent",
    categoryKind: "fixed",
    description: "Ekim ayı kirası",
    vendorName: "Mülk Sahibi",
    expenseDate: "2026-09-01",
    dueDate: "2026-09-10",
    amount: 1000,
    currency: "TRY",
    paid: 0,
    outstanding: 1000,
    status: "open",
    isOverdue: false,
    daysOverdue: null,
    version: 1,
    ...over,
  };
}

function makeDetail(over: Partial<ExpenseDetail> = {}): ExpenseDetail {
  return {
    ...makeItem(),
    note: null,
    amountFloor: 0,
    structureLocked: false,
    canCancel: true,
    cancelledAt: null,
    cancelReason: null,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    payments: [],
    ...over,
  };
}

function makePayment(
  over: Partial<ExpensePaymentView> = {},
): ExpensePaymentView {
  return {
    id: PAYMENT_ID,
    amount: 400,
    method: "cash",
    paidAt: "2026-09-05T10:00:00.000Z",
    note: null,
    status: "posted",
    voidReason: null,
    ...over,
  };
}

function writeResult(
  over: Partial<ExpenseWriteResult> = {},
): ExpenseWriteResult {
  return {
    expenseId: EXPENSE_ID,
    paymentId: null,
    status: "open",
    version: 1,
    noop: false,
    ...over,
  };
}

/** Deterministic, sequential uuids: key-1, key-2, ... so "same key across a retry" vs "new key on a fresh mount" is assertable. */
function mockSequentialUuids() {
  let n = 0;
  return vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    n += 1;
    return `key-${n}` as `${string}-${string}-${string}-${string}-${string}`;
  });
}

function PageUnderTest({
  canManage = true,
  items = [makeItem()],
  nextCursor = null,
}: {
  canManage?: boolean;
  items?: ExpenseListItem[];
  nextCursor?: ExpenseListPage["nextCursor"];
}) {
  return (
    <ExpensesPageClient
      tenantId={TENANT_ID}
      tenantSlug={SLUG}
      canManage={canManage}
      categories={categories}
      branches={branches}
      overview={makeOverview()}
      firstPage={{ items, nextCursor }}
      filters={DEFAULT_EXPENSES_FILTERS}
      listParams={listParamsFor(DEFAULT_EXPENSES_FILTERS, "2026-09")}
      labels={labels}
    />
  );
}

/** Lets queued microtasks and timers run: a duplicate action call (the in-flight guard failing) would show up here. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

function dialogNamed(name: string) {
  return screen.getByRole("dialog", { name });
}

// ---------------------------------------------------------------------------------------------------------------
// F7 the page is read-only
// ---------------------------------------------------------------------------------------------------------------
describe("F7 the page is read-only", () => {
  it("mount, a month change, a filter change and opening the detail sheet issue only reads and navigation", async () => {
    mockedDetail.mockResolvedValue({ ok: true, data: makeDetail() });
    render(<PageUnderTest />);

    // the first paint shows the cards and the row
    expect(screen.getByText("Toplam ödenmemiş gider bakiyesi")).not.toBeNull();
    expect(screen.getByText("Ekim ayı kirası")).not.toBeNull();

    // a month change is a navigation, never a write
    fireEvent.click(screen.getByRole("button", { name: "Sonraki ay" }));
    expect(nav.push).toHaveBeenLastCalledWith(
      "/app/bella-hair/finance/expenses?month=2026-10",
    );
    fireEvent.click(screen.getByRole("button", { name: "Önceki ay" }));
    expect(nav.push).toHaveBeenLastCalledWith(
      "/app/bella-hair/finance/expenses?month=2026-08",
    );

    // a filter change (the search box, debounced) is a navigation too
    fireEvent.change(
      screen.getByPlaceholderText("Açıklama veya tedarikçi ara"),
      { target: { value: "kira" } },
    );
    await waitFor(
      () =>
        expect(nav.push).toHaveBeenLastCalledWith(
          "/app/bella-hair/finance/expenses?q=kira",
        ),
      { timeout: 2000 },
    );

    // opening the detail sheet is one read
    fireEvent.click(screen.getByRole("button", { name: /Ekim ayı kirası/ }));
    await screen.findByText("Ödemeler");
    expect(mockedDetail).toHaveBeenCalledTimes(1);
    expect(mockedDetail).toHaveBeenCalledWith(EXPENSE_ID, REFERENCE_DATE);

    for (const action of [
      mockedCreate,
      mockedUpdate,
      mockedCancel,
      mockedRecord,
      mockedVoid,
    ]) {
      expect(action).not.toHaveBeenCalled();
    }
  });

  it("the overdue line navigates to the overdue filter and writes nothing", () => {
    render(<PageUnderTest />);
    expect(
      screen.getByText("Vadesi geçmiş: 1 gider, 800,00 TRY"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Göster" }));
    expect(nav.push).toHaveBeenCalledWith(
      "/app/bella-hair/finance/expenses?overdue=1",
    );
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("'Daha fazla' reads the next keyset page and appends it", async () => {
    const second = makeItem({
      id: "66666666-6666-4666-8666-666666666666",
      description: "Elektrik faturası",
    });
    mockedPage.mockResolvedValue({
      ok: true,
      data: { items: [second], nextCursor: null },
    });
    render(
      <PageUnderTest
        nextCursor={{ expenseDate: "2026-09-01", id: EXPENSE_ID }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Daha fazla" }));
    await screen.findByText("Elektrik faturası");
    expect(mockedPage).toHaveBeenCalledTimes(1);
    expect(mockedPage.mock.calls[0]![2]).toEqual({
      expenseDate: "2026-09-01",
      id: EXPENSE_ID,
    });
    expect(screen.getByText("Ekim ayı kirası")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Daha fazla" })).toBeNull();
  });

  it("a failed 'Daha fazla' shows the message and offers a retry", async () => {
    mockedPage.mockResolvedValueOnce({ ok: false, code: null });
    render(
      <PageUnderTest
        nextCursor={{ expenseDate: "2026-09-01", id: EXPENSE_ID }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Daha fazla" }));
    await screen.findByText("Daha fazla gider yüklenemedi.");
    expect(screen.getByRole("button", { name: "Tekrar dene" })).not.toBeNull();
  });

  it("an empty list without filters is the onboarding state with a create button for finance.manage", () => {
    render(<PageUnderTest items={[]} />);
    expect(screen.getByText("Henüz gider yok")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "İlk gideri ekle" }),
    ).not.toBeNull();
  });

  it("an empty list without finance.manage has no create button anywhere", () => {
    render(<PageUnderTest items={[]} canManage={false} />);
    expect(screen.getByText("Henüz gider yok")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "İlk gideri ekle" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Yeni gider" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F8 create dialog lifecycle
// ---------------------------------------------------------------------------------------------------------------
describe("F8 create dialog lifecycle", () => {
  function renderCreate(
    overrides: {
      onCreated?: (r: ExpenseWriteResult) => void;
      onClose?: () => void;
      onRefresh?: () => void;
    } = {},
  ) {
    return render(
      <CreateExpenseDialog
        tenantSlug={SLUG}
        categories={categories}
        branches={branches}
        defaultDate={REFERENCE_DATE}
        labels={labels}
        onClose={overrides.onClose ?? (() => {})}
        onCreated={overrides.onCreated ?? (() => {})}
        onRefresh={overrides.onRefresh ?? (() => {})}
      />,
    );
  }

  function fillRequired(dialog: HTMLElement, amount = "250,50") {
    fireEvent.change(within(dialog).getByLabelText("Kategori"), {
      target: { value: "rent" },
    });
    fireEvent.change(within(dialog).getByLabelText("Açıklama"), {
      target: { value: "Ekim ayı kirası" },
    });
    fireEvent.change(within(dialog).getByLabelText("Tutar"), {
      target: { value: amount },
    });
  }

  const submitButton = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: "Gideri Kaydet" });
  const submit = (dialog: HTMLElement) => fireEvent.click(submitButton(dialog));

  it("one submit makes one action call with the parsed amount and no initial payment by default", async () => {
    mockSequentialUuids();
    mockedCreate.mockResolvedValue(ok(writeResult()));
    renderCreate();
    const dialog = dialogNamed("Yeni gider");
    expect(within(dialog).queryByLabelText("Ödeme tutarı")).toBeNull();
    fillRequired(dialog);
    submit(dialog);
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    expect(mockedCreate).toHaveBeenCalledWith(null, {
      tenantSlug: SLUG,
      categoryKey: "rent",
      description: "Ekim ayı kirası",
      expenseDate: REFERENCE_DATE,
      amount: 250.5, // "250,50" arrives as 250.5
      dueDate: undefined,
      branchId: null,
      vendorName: undefined,
      note: undefined,
      idempotencyKey: "key-1",
      initialPayment: undefined, // the initial-payment section is off by default
    });
  });

  it("a double submit (two submit events before React re-renders) makes ONE action call", async () => {
    mockSequentialUuids();
    let resolve!: (
      value: Awaited<ReturnType<typeof createExpenseAction>>,
    ) => void;
    mockedCreate.mockReturnValue(new Promise((r) => (resolve = r)));
    renderCreate();
    const dialog = dialogNamed("Yeni gider");
    fillRequired(dialog);
    const form = dialog.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    resolve(ok(writeResult()));
    await settle();
    expect(mockedCreate).toHaveBeenCalledTimes(1); // useActionState would run a duplicate queued call right after the first resolves
  });

  it("a failed submit keeps the dialog and a retry sends the IDENTICAL key, paidAt and payload", async () => {
    mockSequentialUuids();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    renderCreate();
    const dialog = dialogNamed("Yeni gider");
    fillRequired(dialog);
    fireEvent.click(
      within(dialog).getByRole("switch", {
        name: "Hemen ödendi olarak kaydet",
      }),
    );

    mockedCreate.mockResolvedValueOnce(fail("UNEXPECTED", "geçici hata"));
    submit(dialog);
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    await within(dialog).findByText("geçici hata");
    expect(dialogNamed("Yeni gider")).toBe(dialog); // still the same mounted attempt

    vi.setSystemTime(new Date("2026-09-30T10:05:00.000Z")); // wall-clock moves on; paidAt must NOT
    mockedCreate.mockResolvedValueOnce(ok(writeResult()));
    submit(dialog);
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(2));

    const first = mockedCreate.mock.calls[0]![1];
    const second = mockedCreate.mock.calls[1]![1];
    expect(second).toEqual(first);
    expect(first.idempotencyKey).toBe("key-1");
    expect(first.initialPayment?.paidAt).toBe("2026-09-30T10:00:00.000Z");
  });

  it("closing and reopening is a NEW attempt: a new key and a new paidAt", async () => {
    mockSequentialUuids();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    mockedCreate.mockResolvedValue(fail("UNEXPECTED", "x"));

    const first = renderCreate();
    let dialog = dialogNamed("Yeni gider");
    fillRequired(dialog);
    fireEvent.click(
      within(dialog).getByRole("switch", {
        name: "Hemen ödendi olarak kaydet",
      }),
    );
    submit(dialog);
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    first.unmount();

    vi.setSystemTime(new Date("2026-09-30T11:00:00.000Z"));
    renderCreate();
    dialog = dialogNamed("Yeni gider");
    fillRequired(dialog);
    fireEvent.click(
      within(dialog).getByRole("switch", {
        name: "Hemen ödendi olarak kaydet",
      }),
    );
    submit(dialog);
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(2));

    const a = mockedCreate.mock.calls[0]![1];
    const b = mockedCreate.mock.calls[1]![1];
    expect(a.idempotencyKey).toBe("key-1");
    expect(b.idempotencyKey).toBe("key-2");
    expect(a.initialPayment?.paidAt).toBe("2026-09-30T10:00:00.000Z");
    expect(b.initialPayment?.paidAt).toBe("2026-09-30T11:00:00.000Z");
  });

  it("toggling the initial-payment section changes neither the key nor the instant", async () => {
    const uuid = mockSequentialUuids();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    mockedCreate.mockResolvedValue(ok(writeResult()));
    renderCreate();
    const dialog = dialogNamed("Yeni gider");
    expect(uuid).toHaveBeenCalledTimes(1);
    const toggle = within(dialog).getByRole("switch", {
      name: "Hemen ödendi olarak kaydet",
    });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(uuid).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    fillRequired(dialog);
    submit(dialog);
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    const input = mockedCreate.mock.calls[0]![1];
    expect(input.idempotencyKey).toBe("key-1");
    expect(input.initialPayment?.paidAt).toBe("2026-09-30T10:00:00.000Z");
    expect(uuid).toHaveBeenCalledTimes(1);
  });

  it("the initial amount defaults to the expense amount until the user edits it, and 250,50 arrives as 250.5", async () => {
    mockSequentialUuids();
    mockedCreate.mockResolvedValue(ok(writeResult()));
    renderCreate();
    const dialog = dialogNamed("Yeni gider");
    fillRequired(dialog, "400");
    fireEvent.click(
      within(dialog).getByRole("switch", {
        name: "Hemen ödendi olarak kaydet",
      }),
    );
    const paymentAmount = within(dialog).getByLabelText(
      "Ödeme tutarı",
    ) as HTMLInputElement;
    expect(paymentAmount.value).toBe("400"); // follows the expense amount

    fireEvent.change(within(dialog).getByLabelText("Tutar"), {
      target: { value: "450" },
    });
    expect(paymentAmount.value).toBe("450"); // still following

    fireEvent.change(paymentAmount, { target: { value: "250,50" } }); // the user edits: it stops following
    fireEvent.change(within(dialog).getByLabelText("Tutar"), {
      target: { value: "500" },
    });
    expect(paymentAmount.value).toBe("250,50");

    submit(dialog);
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    const input = mockedCreate.mock.calls[0]![1];
    expect(input.amount).toBe(500);
    expect(input.initialPayment).toMatchObject({
      amount: 250.5,
      method: "cash",
    });
  });

  it("validates before submitting: required fields, the money parser and the initial payment cap", async () => {
    renderCreate();
    const dialog = dialogNamed("Yeni gider");
    submit(dialog);
    expect(await within(dialog).findByText("Kategori seçin.")).not.toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Kategori"), {
      target: { value: "rent" },
    });
    submit(dialog);
    expect(await within(dialog).findByText("Açıklama girin.")).not.toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Açıklama"), {
      target: { value: "Kira" },
    });
    submit(dialog);
    expect(await within(dialog).findByText("Tutar girin.")).not.toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Tutar"), {
      target: { value: "1.250,50" },
    });
    submit(dialog);
    expect(
      await within(dialog).findByText(
        "Binlik ayırıcı kullanmayın; örn. 1250,50 yazın.",
      ),
    ).not.toBeNull();

    fireEvent.change(within(dialog).getByLabelText("Tutar"), {
      target: { value: "100" },
    });
    fireEvent.click(
      within(dialog).getByRole("switch", {
        name: "Hemen ödendi olarak kaydet",
      }),
    );
    fireEvent.change(within(dialog).getByLabelText("Ödeme tutarı"), {
      target: { value: "150" },
    });
    submit(dialog);
    expect(
      await within(dialog).findByText(EXPENSE_ERROR_MESSAGES.FN005),
    ).not.toBeNull();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("a conflict (FN007) shows the expense message and a 'Yenile' button that refreshes the page", async () => {
    mockSequentialUuids();
    const onRefresh = vi.fn();
    mockedCreate.mockResolvedValue(
      fail("CONFLICT", EXPENSE_ERROR_MESSAGES.FN007),
    );
    renderCreate({ onRefresh });
    const dialog = dialogNamed("Yeni gider");
    fillRequired(dialog);
    submit(dialog);
    await within(dialog).findByText(EXPENSE_ERROR_MESSAGES.FN007);
    fireEvent.click(within(dialog).getByRole("button", { name: "Yenile" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("FN002 and the default failure show the EXPENSE wording, never FIN.1A text", async () => {
    mockSequentialUuids();
    mockedCreate.mockResolvedValueOnce(
      fail("UNAUTHORIZED", EXPENSE_ERROR_MESSAGES.FN002),
    );
    renderCreate();
    const dialog = dialogNamed("Yeni gider");
    fillRequired(dialog);
    submit(dialog);
    await within(dialog).findByText(
      "Giderler için bu işlemi yapma yetkiniz yok.",
    );
    expect(
      within(dialog).queryByText("Bu işlem için yetkiniz yok."),
    ).toBeNull();
    mockedCreate.mockResolvedValueOnce(
      fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin."),
    );
    submit(dialog);
    await within(dialog).findByText(
      "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.",
    );
    expect(within(dialog).queryByText(/Randevu veya işlem/)).toBeNull();
  });

  it("success reports the result and the page unmounts the dialog (a fresh attempt next time)", async () => {
    mockSequentialUuids();
    mockedCreate.mockResolvedValue(ok(writeResult({ expenseId: "new-id" })));
    render(<PageUnderTest />);
    fireEvent.click(screen.getByRole("button", { name: "Yeni gider" }));
    const dialog = dialogNamed("Yeni gider");
    fillRequired(dialog);
    submit(dialog);
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Yeni gider" })).toBeNull(),
    );

    // reopening: a new mount, a new key
    fireEvent.click(screen.getByRole("button", { name: "Yeni gider" }));
    const again = dialogNamed("Yeni gider");
    fillRequired(again);
    submit(again);
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(2));
    expect(mockedCreate.mock.calls[0]![1].idempotencyKey).toBe("key-1");
    expect(mockedCreate.mock.calls[1]![1].idempotencyKey).toBe("key-2");
  });

  it("uses a native category picker grouped into Sabit gider and Değişken gider with every category labelled", () => {
    renderCreate();
    const dialog = dialogNamed("Yeni gider");
    const select = within(dialog).getByLabelText(
      "Kategori",
    ) as HTMLSelectElement;
    const groups = Array.from(select.querySelectorAll("optgroup")).map(
      (g) => g.label,
    );
    expect(groups).toEqual(["Sabit gider", "Değişken gider"]);
    const options = Array.from(select.querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    for (const label of [
      "Kira",
      "Elektrik",
      "Su",
      "İnternet",
      "Telefon",
      "Muhasebe",
      "Yazılım ve abonelikler",
      "POS komisyonları",
      "Sarf malzeme",
      "Güzellik ürünleri",
      "Temizlik",
      "Reklam",
      "Yiyecek ve içecek",
      "Ulaşım",
      "Bakım ve onarım",
      "Diğer",
    ]) {
      expect(options).toContain(label);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F9 edit dialog
// ---------------------------------------------------------------------------------------------------------------
describe("F9 edit dialog", () => {
  function renderEdit(
    detail: ExpenseDetail,
    handlers: {
      onUpdated?: (r: ExpenseWriteResult) => void;
      onRefresh?: () => void;
      onClose?: () => void;
    } = {},
  ) {
    return render(
      <EditExpenseDialog
        detail={detail}
        tenantSlug={SLUG}
        categories={categories}
        branches={branches}
        labels={labels}
        onClose={handlers.onClose ?? (() => {})}
        onUpdated={handlers.onUpdated ?? (() => {})}
        onRefresh={handlers.onRefresh ?? (() => {})}
      />,
    );
  }

  it("when structureLocked the date, branch and category are disabled with the reason, and the amount hint is the floor", () => {
    renderEdit(
      makeDetail({
        structureLocked: true,
        amountFloor: 400,
        paid: 400,
        outstanding: 600,
        status: "partially_paid",
        version: 5,
      }),
    );
    const dialog = dialogNamed("Gideri düzenle");
    expect(within(dialog).getByLabelText("Kategori")).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog).getByLabelText("Gider tarihi")).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog).getByLabelText("Şube")).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      within(dialog).getAllByText("Ödeme yapıldığı için kilitli"),
    ).toHaveLength(3);
    // the editable ones stay editable
    for (const label of [
      "Açıklama",
      "Tutar",
      "Vade tarihi (opsiyonel)",
      "Tedarikçi (opsiyonel)",
      "Not (opsiyonel)",
    ]) {
      expect(within(dialog).getByLabelText(label), label).toHaveProperty(
        "disabled",
        false,
      );
    }
    expect(
      within(dialog).getByText("En az 400,00 TRY (ödenen toplam)"),
    ).not.toBeNull();
  });

  it("an unpaid expense has nothing locked and no amount hint", () => {
    renderEdit(makeDetail());
    const dialog = dialogNamed("Gideri düzenle");
    expect(within(dialog).getByLabelText("Kategori")).toHaveProperty(
      "disabled",
      false,
    );
    expect(within(dialog).getByLabelText("Gider tarihi")).toHaveProperty(
      "disabled",
      false,
    );
    expect(
      within(dialog).queryByText("Ödeme yapıldığı için kilitli"),
    ).toBeNull();
    expect(within(dialog).queryByText(/En az/)).toBeNull();
  });

  it("prefills the form and submits the FULL state plus the version captured at mount", async () => {
    mockedUpdate.mockResolvedValue(ok(writeResult({ version: 6 })));
    renderEdit(
      makeDetail({
        version: 5,
        amount: 1250.5,
        branchId: BRANCH_ID,
        branchName: "Merkez Şube",
        note: "dikkat",
        vendorName: "Mülk Sahibi",
        dueDate: "2026-09-10",
        categoryKey: "electricity",
        description: "Elektrik",
      }),
    );
    const dialog = dialogNamed("Gideri düzenle");
    expect(
      (within(dialog).getByLabelText("Tutar") as HTMLInputElement).value,
    ).toBe("1250,50");
    expect(
      (within(dialog).getByLabelText("Şube") as HTMLSelectElement).value,
    ).toBe(BRANCH_ID);
    fireEvent.change(within(dialog).getByLabelText("Açıklama"), {
      target: { value: "Elektrik faturası" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Değişiklikleri Kaydet" }),
    );
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    expect(mockedUpdate).toHaveBeenCalledWith(null, {
      tenantSlug: SLUG,
      expenseId: EXPENSE_ID,
      expectedVersion: 5,
      categoryKey: "electricity",
      description: "Elektrik faturası",
      expenseDate: "2026-09-01",
      amount: 1250.5,
      dueDate: "2026-09-10",
      branchId: BRANCH_ID,
      vendorName: "Mülk Sahibi",
      note: "dikkat",
    });
  });

  it("Genel (no branch) is submitted as branchId null and a cleared optional field as undefined", async () => {
    mockedUpdate.mockResolvedValue(ok(writeResult()));
    renderEdit(makeDetail({ vendorName: "Eski", dueDate: "2026-09-10" }));
    const dialog = dialogNamed("Gideri düzenle");
    fireEvent.change(within(dialog).getByLabelText("Tedarikçi (opsiyonel)"), {
      target: { value: "" },
    });
    fireEvent.change(within(dialog).getByLabelText("Vade tarihi (opsiyonel)"), {
      target: { value: "" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Değişiklikleri Kaydet" }),
    );
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    const input = mockedUpdate.mock.calls[0]![1];
    expect(input.branchId).toBeNull();
    expect(input.vendorName).toBeUndefined();
    expect(input.dueDate).toBeUndefined();
  });

  it("a conflict shows the message and a 'Yenile' button", async () => {
    const onRefresh = vi.fn();
    mockedUpdate.mockResolvedValue(
      fail("CONFLICT", EXPENSE_ERROR_MESSAGES.FN013),
    );
    renderEdit(makeDetail({ version: 5 }), { onRefresh });
    const dialog = dialogNamed("Gideri düzenle");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Değişiklikleri Kaydet" }),
    );
    await within(dialog).findByText(EXPENSE_ERROR_MESSAGES.FN013);
    fireEvent.click(within(dialog).getByRole("button", { name: "Yenile" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("through the page: a conflict, 'Yenile' refetches and remounts the dialog with the NEW version", async () => {
    mockedDetail.mockResolvedValueOnce({
      ok: true,
      data: makeDetail({ version: 5 }),
    });
    mockedUpdate.mockResolvedValueOnce(
      fail("CONFLICT", EXPENSE_ERROR_MESSAGES.FN013),
    );
    render(<PageUnderTest />);
    fireEvent.click(screen.getByRole("button", { name: /Ekim ayı kirası/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Düzenle" }));
    let dialog = dialogNamed("Gideri düzenle");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Değişiklikleri Kaydet" }),
    );
    await within(dialog).findByText(EXPENSE_ERROR_MESSAGES.FN013);
    expect(mockedUpdate.mock.calls[0]![1].expectedVersion).toBe(5);

    mockedDetail.mockResolvedValue({
      ok: true,
      data: makeDetail({ version: 7, description: "Başkası değiştirdi" }),
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Yenile" }));
    await waitFor(() =>
      expect(
        (
          within(dialogNamed("Gideri düzenle")).getByLabelText(
            "Açıklama",
          ) as HTMLInputElement
        ).value,
      ).toBe("Başkası değiştirdi"),
    );
    expect(
      within(dialogNamed("Gideri düzenle")).queryByText(
        EXPENSE_ERROR_MESSAGES.FN013,
      ),
    ).toBeNull();

    mockedUpdate.mockResolvedValueOnce(ok(writeResult({ version: 8 })));
    dialog = dialogNamed("Gideri düzenle");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Değişiklikleri Kaydet" }),
    );
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    expect(mockedUpdate.mock.calls[1]![1].expectedVersion).toBe(7);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F10 payment dialog
// ---------------------------------------------------------------------------------------------------------------
describe("F10 payment dialog", () => {
  function renderPay(
    over: {
      outstanding?: number;
      onRecorded?: (r: ExpenseWriteResult) => void;
    } = {},
  ) {
    return render(
      <RecordExpensePaymentDialog
        expenseId={EXPENSE_ID}
        tenantSlug={SLUG}
        outstanding={over.outstanding ?? 600.5}
        currency="TRY"
        labels={labels}
        onClose={() => {}}
        onRecorded={over.onRecorded ?? (() => {})}
        onRefresh={() => {}}
      />,
    );
  }
  const submit = (dialog: HTMLElement) =>
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Ödemeyi Kaydet" }),
    );

  it("says 'Ödeme Yap', shows the remaining amount and defaults the amount to it", () => {
    renderPay();
    const dialog = dialogNamed("Ödeme Yap");
    expect(within(dialog).getByText("Kalan: 600,50 TRY")).not.toBeNull();
    expect(
      (within(dialog).getByLabelText("Tutar (TRY)") as HTMLInputElement).value,
    ).toBe("600,50");
    expect(within(dialog).queryByText(/Ödeme Al/)).toBeNull();
  });

  it("handles comma input and sends the stable key and instant of this mount", async () => {
    mockSequentialUuids();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    mockedRecord.mockResolvedValue(
      ok(
        writeResult({
          paymentId: PAYMENT_ID,
          status: "partially_paid",
          version: 2,
        }),
      ),
    );
    renderPay();
    const dialog = dialogNamed("Ödeme Yap");
    fireEvent.change(within(dialog).getByLabelText("Tutar (TRY)"), {
      target: { value: "250,50" },
    });
    submit(dialog);
    await waitFor(() => expect(mockedRecord).toHaveBeenCalledTimes(1));
    expect(mockedRecord).toHaveBeenCalledWith(null, {
      tenantSlug: SLUG,
      expenseId: EXPENSE_ID,
      amount: 250.5,
      method: "cash",
      paidAt: "2026-09-30T10:00:00.000Z",
      note: undefined,
      idempotencyKey: "key-1",
    });
  });

  it("a failed submit then a retry sends the identical payload (one mount, one attempt)", async () => {
    mockSequentialUuids();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    renderPay();
    const dialog = dialogNamed("Ödeme Yap");
    mockedRecord.mockResolvedValueOnce(fail("UNEXPECTED", "geçici hata"));
    submit(dialog);
    await waitFor(() => expect(mockedRecord).toHaveBeenCalledTimes(1));
    await within(dialog).findByText("geçici hata");
    vi.setSystemTime(new Date("2026-09-30T10:07:00.000Z"));
    mockedRecord.mockResolvedValueOnce(
      ok(writeResult({ paymentId: PAYMENT_ID })),
    );
    submit(dialog);
    await waitFor(() => expect(mockedRecord).toHaveBeenCalledTimes(2));
    expect(mockedRecord.mock.calls[1]![1]).toEqual(
      mockedRecord.mock.calls[0]![1],
    );
  });

  it("a fresh mount is a fresh attempt (new key, new instant)", async () => {
    mockSequentialUuids();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    mockedRecord.mockResolvedValue(fail("UNEXPECTED", "x"));
    const first = renderPay();
    submit(dialogNamed("Ödeme Yap"));
    await waitFor(() => expect(mockedRecord).toHaveBeenCalledTimes(1));
    first.unmount();
    vi.setSystemTime(new Date("2026-09-30T10:30:00.000Z"));
    renderPay();
    submit(dialogNamed("Ödeme Yap"));
    await waitFor(() => expect(mockedRecord).toHaveBeenCalledTimes(2));
    expect(mockedRecord.mock.calls[0]![1].idempotencyKey).toBe("key-1");
    expect(mockedRecord.mock.calls[1]![1].idempotencyKey).toBe("key-2");
    expect(mockedRecord.mock.calls[0]![1].paidAt).toBe(
      "2026-09-30T10:00:00.000Z",
    );
    expect(mockedRecord.mock.calls[1]![1].paidAt).toBe(
      "2026-09-30T10:30:00.000Z",
    );
  });

  it("refuses an amount above the remaining balance and an unparseable one before any action call", async () => {
    renderPay({ outstanding: 100 });
    const dialog = dialogNamed("Ödeme Yap");
    fireEvent.change(within(dialog).getByLabelText("Tutar (TRY)"), {
      target: { value: "100,01" },
    });
    submit(dialog);
    await within(dialog).findByText(EXPENSE_ERROR_MESSAGES.FN005);
    fireEvent.change(within(dialog).getByLabelText("Tutar (TRY)"), {
      target: { value: "1.000,00" },
    });
    submit(dialog);
    await within(dialog).findByText(
      "Binlik ayırıcı kullanmayın; örn. 1250,50 yazın.",
    );
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("a double submit makes one action call", async () => {
    mockSequentialUuids();
    let resolve!: (
      value: Awaited<ReturnType<typeof recordExpensePaymentAction>>,
    ) => void;
    mockedRecord.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPay();
    const form = dialogNamed("Ödeme Yap").querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(mockedRecord).toHaveBeenCalledTimes(1));
    resolve(ok(writeResult({ paymentId: PAYMENT_ID })));
    await settle();
    expect(mockedRecord).toHaveBeenCalledTimes(1);
  });

  it("a re-render between attempts (the user edits the note) keeps the key and the instant", async () => {
    mockSequentialUuids();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    renderPay();
    const dialog = dialogNamed("Ödeme Yap");
    mockedRecord.mockResolvedValueOnce(fail("UNEXPECTED", "geçici hata"));
    submit(dialog);
    await waitFor(() => expect(mockedRecord).toHaveBeenCalledTimes(1));
    await within(dialog).findByText("geçici hata");
    vi.setSystemTime(new Date("2026-09-30T10:20:00.000Z"));
    fireEvent.change(within(dialog).getByLabelText("Not (opsiyonel)"), {
      target: { value: "düzeltme" },
    });
    mockedRecord.mockResolvedValueOnce(
      ok(writeResult({ paymentId: PAYMENT_ID })),
    );
    submit(dialog);
    await waitFor(() => expect(mockedRecord).toHaveBeenCalledTimes(2));
    const [a, b] = [
      mockedRecord.mock.calls[0]![1],
      mockedRecord.mock.calls[1]![1],
    ];
    expect(b.idempotencyKey).toBe(a.idempotencyKey);
    expect(b.paidAt).toBe(a.paidAt);
    expect(b.paidAt).toBe("2026-09-30T10:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F11 void and cancel dialogs
// ---------------------------------------------------------------------------------------------------------------
describe("F11 void and cancel dialogs", () => {
  it("void: the reason is required, the button is disabled while blank, and success reports", async () => {
    const onVoided = vi.fn();
    mockedVoid.mockResolvedValue(ok(writeResult({ paymentId: PAYMENT_ID })));
    render(
      <VoidExpensePaymentDialog
        payment={makePayment()}
        currency="TRY"
        tenantSlug={SLUG}
        labels={labels}
        onClose={() => {}}
        onVoided={onVoided}
        onRefresh={() => {}}
      />,
    );
    const dialog = dialogNamed("Ödemeyi iptal et");
    expect(
      within(dialog).getByText(
        "400,00 TRY tutarındaki ödeme iptal edilecek. Kayıt silinmez, iptal edildi olarak saklanır.",
      ),
    ).not.toBeNull();
    const submit = within(dialog).getByRole("button", {
      name: "Ödemeyi İptal Et",
    });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.change(within(dialog).getByLabelText("İptal nedeni"), {
      target: { value: "   " },
    });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.change(within(dialog).getByLabelText("İptal nedeni"), {
      target: { value: " yanlış giriş " },
    });
    expect(submit).toHaveProperty("disabled", false);
    fireEvent.click(submit);
    await waitFor(() => expect(mockedVoid).toHaveBeenCalledTimes(1));
    expect(mockedVoid).toHaveBeenCalledWith(null, {
      tenantSlug: SLUG,
      paymentId: PAYMENT_ID,
      reason: "yanlış giriş",
    });
    await waitFor(() => expect(onVoided).toHaveBeenCalledTimes(1));
  });

  it("cancel: the reason is required, the button is disabled while blank, and success reports", async () => {
    const onCancelled = vi.fn();
    mockedCancel.mockResolvedValue(
      ok(writeResult({ status: "cancelled", version: 2 })),
    );
    render(
      <CancelExpenseDialog
        expenseId={EXPENSE_ID}
        tenantSlug={SLUG}
        labels={labels}
        onClose={() => {}}
        onCancelled={onCancelled}
        onRefresh={() => {}}
      />,
    );
    const dialog = dialogNamed("Gideri iptal et");
    const submit = within(dialog).getByRole("button", {
      name: "Gideri İptal Et",
    });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.change(within(dialog).getByLabelText("İptal nedeni"), {
      target: { value: "yanlış girildi" },
    });
    expect(submit).toHaveProperty("disabled", false);
    fireEvent.click(submit);
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledTimes(1));
    expect(mockedCancel).toHaveBeenCalledWith(null, {
      tenantSlug: SLUG,
      expenseId: EXPENSE_ID,
      reason: "yanlış girildi",
    });
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
  });

  it("void: a conflict shows the message and 'Yenile'; a double submit is one call", async () => {
    const onRefresh = vi.fn();
    let resolve!: (
      value: Awaited<ReturnType<typeof voidExpensePaymentAction>>,
    ) => void;
    mockedVoid.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(
      <VoidExpensePaymentDialog
        payment={makePayment()}
        currency="TRY"
        tenantSlug={SLUG}
        labels={labels}
        onClose={() => {}}
        onVoided={() => {}}
        onRefresh={onRefresh}
      />,
    );
    const dialog = dialogNamed("Ödemeyi iptal et");
    fireEvent.change(within(dialog).getByLabelText("İptal nedeni"), {
      target: { value: "x" },
    });
    const form = dialog.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(mockedVoid).toHaveBeenCalledTimes(1));
    resolve(fail("CONFLICT", EXPENSE_ERROR_MESSAGES.FN008));
    await within(dialog).findByText(EXPENSE_ERROR_MESSAGES.FN008);
    await settle();
    expect(mockedVoid).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Yenile" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("through the page: the void dialog unmounts on success and the sheet refetches (no lingering form)", async () => {
    mockedDetail.mockResolvedValue({
      ok: true,
      data: makeDetail({
        status: "partially_paid",
        paid: 400,
        outstanding: 600,
        amountFloor: 400,
        structureLocked: true,
        canCancel: false,
        version: 3,
        payments: [makePayment()],
      }),
    });
    mockedVoid.mockResolvedValue(ok(writeResult({ paymentId: PAYMENT_ID })));
    render(<PageUnderTest />);
    fireEvent.click(screen.getByRole("button", { name: /Ekim ayı kirası/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Ödemeyi iptal et" }),
    );
    const dialog = dialogNamed("Ödemeyi iptal et");
    fireEvent.change(within(dialog).getByLabelText("İptal nedeni"), {
      target: { value: "hatalı giriş" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Ödemeyi İptal Et" }),
    );
    await waitFor(() => expect(mockedVoid).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Ödemeyi iptal et" }),
      ).toBeNull(),
    );
    // the open detail is refetched: initial open + the post-mutation revision
    await waitFor(() => expect(mockedDetail).toHaveBeenCalledTimes(2));
  });

  it("through the page: the cancel dialog unmounts on success", async () => {
    mockedDetail.mockResolvedValue({ ok: true, data: makeDetail() });
    mockedCancel.mockResolvedValue(
      ok(writeResult({ status: "cancelled", version: 2 })),
    );
    render(<PageUnderTest />);
    fireEvent.click(screen.getByRole("button", { name: /Ekim ayı kirası/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Gideri iptal et" }),
    );
    const dialog = dialogNamed("Gideri iptal et");
    fireEvent.change(within(dialog).getByLabelText("İptal nedeni"), {
      target: { value: "tekrar girildi" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Gideri İptal Et" }),
    );
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Gideri iptal et" }),
      ).toBeNull(),
    );
  });

  it("the cancel button is DISABLED with the reason once a payment exists", async () => {
    mockedDetail.mockResolvedValue({
      ok: true,
      data: makeDetail({
        status: "partially_paid",
        paid: 400,
        outstanding: 600,
        amountFloor: 400,
        structureLocked: true,
        canCancel: false,
        payments: [makePayment()],
      }),
    });
    render(<PageUnderTest />);
    fireEvent.click(screen.getByRole("button", { name: /Ekim ayı kirası/ }));
    const cancel = await screen.findByRole("button", {
      name: "Gideri iptal et",
    });
    expect(cancel).toHaveProperty("disabled", true);
    expect(
      screen.getByText(
        "Ödemesi bulunan gider iptal edilemez. Önce ödemeleri iptal edin.",
      ),
    ).not.toBeNull();
    fireEvent.click(cancel);
    expect(
      screen.queryByRole("dialog", { name: "Gideri iptal et" }),
    ).toBeNull();
    expect(mockedCancel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F4 the UI shows expense wording
// ---------------------------------------------------------------------------------------------------------------
describe("F4 the UI uses the expense mapper", () => {
  it("shows the expense messages for the mapped codes and the default, and never any FIN.1A wording", async () => {
    mockedDetail.mockResolvedValue({
      ok: true,
      data: makeDetail({
        status: "partially_paid",
        paid: 400,
        outstanding: 600,
        payments: [makePayment()],
      }),
    });
    mockSequentialUuids();
    render(<PageUnderTest />);
    fireEvent.click(screen.getByRole("button", { name: /Ekim ayı kirası/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Ödeme Yap" }));
    const dialog = dialogNamed("Ödeme Yap");

    const cases: [Parameters<typeof fail>[0], string][] = [
      ["UNAUTHORIZED", EXPENSE_ERROR_MESSAGES.FN002],
      ["CONFLICT", EXPENSE_ERROR_MESSAGES.FN007],
      ["UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin."],
    ];
    for (const [code, message] of cases) {
      mockedRecord.mockResolvedValueOnce(fail(code, message));
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Ödemeyi Kaydet" }),
      );
      await within(dialog).findByText(message);
    }
    for (const forbidden of [
      "Randevu veya işlem bulunamadı.",
      "Bu işlem için yetkiniz yok.",
      "Randevu tamamlanmadan tahsilat oluşturulamaz.",
    ]) {
      expect(within(dialog).queryByText(forbidden)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F12 view-only users, and F15 no leftover template placeholders
// ---------------------------------------------------------------------------------------------------------------
describe("F12 without finance.manage every mutating control is absent", () => {
  it("shows no create button and the detail sheet offers no pay, edit, cancel or void control", async () => {
    mockedDetail.mockResolvedValue({
      ok: true,
      data: makeDetail({
        status: "partially_paid",
        paid: 400,
        outstanding: 600,
        amountFloor: 400,
        structureLocked: true,
        canCancel: false,
        payments: [makePayment()],
      }),
    });
    render(<PageUnderTest canManage={false} />);
    expect(screen.queryByRole("button", { name: "Yeni gider" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Ekim ayı kirası/ }));
    await screen.findByText("Ödemeler");
    for (const name of [
      "Ödeme Yap",
      "Düzenle",
      "Gideri iptal et",
      "Ödemeyi iptal et",
    ]) {
      expect(screen.queryByRole("button", { name }), name).toBeNull();
    }
    expect(
      screen.queryByText(
        "Ödemesi bulunan gider iptal edilemez. Önce ödemeleri iptal edin.",
      ),
    ).toBeNull();
    // the read-only content is still there
    expect(screen.getByText("400,00 TRY · Nakit")).not.toBeNull();
  });
});

describe("F15 rendered text has no leftover template placeholders", () => {
  it("the page, an overdue row, the detail sheet and every dialog render fully filled-in text", async () => {
    mockSequentialUuids();
    const overdue = makeItem({
      isOverdue: true,
      daysOverdue: 5,
      status: "partially_paid",
      paid: 400,
      outstanding: 600,
    });
    mockedDetail.mockResolvedValue({
      ok: true,
      data: makeDetail({
        status: "partially_paid",
        paid: 400,
        outstanding: 600,
        amountFloor: 400,
        structureLocked: true,
        canCancel: false,
        isOverdue: true,
        daysOverdue: 5,
        payments: [
          makePayment(),
          makePayment({ id: "p2", status: "voided", voidReason: "yanlış" }),
        ],
      }),
    });
    render(<PageUnderTest items={[overdue]} />);
    expect(document.body.textContent).not.toMatch(/\{\w+\}/);
    fireEvent.click(screen.getByRole("button", { name: /Ekim ayı kirası/ }));
    await screen.findByText("Ödemeler");
    expect(document.body.textContent).not.toMatch(/\{\w+\}/);
    expect(screen.getAllByText(/5 gün gecikmiş/).length).toBeGreaterThanOrEqual(
      2,
    ); // the list row and the sheet

    for (const [button, dialogName] of [
      ["Ödeme Yap", "Ödeme Yap"],
      ["Düzenle", "Gideri düzenle"],
      ["Ödemeyi iptal et", "Ödemeyi iptal et"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: button }));
      const dialog = dialogNamed(dialogName);
      expect(dialog.textContent, dialogName).not.toMatch(/\{\w+\}/);
      fireEvent.click(within(dialog).getByRole("button", { name: "Vazgeç" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: dialogName })).toBeNull(),
      );
    }
  });
});
