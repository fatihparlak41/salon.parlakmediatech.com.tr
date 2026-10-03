import { describe, expect, it, vi } from "vitest";
import {
  MONEY_PARSE_MESSAGES,
  formatDate,
  formatMoney,
  parseMoneyInput,
  type MoneyParseReason,
} from "@/lib/modules/expenses/money";
import {
  cancelExpenseSchema,
  createExpenseSchema,
  moneyAmountSchema,
  recordExpensePaymentSchema,
  updateExpenseSchema,
  voidExpensePaymentSchema,
} from "@/lib/modules/expenses/schemas";
import {
  DEFAULT_EXPENSES_FILTERS,
  buildExpensesFilterUrl,
  listParamsFor,
  listRpcArgs,
  monthBounds,
  parseExpensesFilters,
  shiftMonth,
} from "@/lib/modules/expenses/filters";
import {
  newAttemptInstant,
  newAttemptKey,
} from "@/lib/modules/expenses/attempt";
import {
  fillTemplate,
  monthTitle,
  toEditableAmount,
} from "@/lib/modules/expenses/format";

/**
 * Faz FIN.1B.1 — money parsing and formatting (F5), the Zod schemas (F6), the URL filter helpers and the attempt helpers.
 * No database, no network.
 */

const KEY = "11111111-1111-4111-8111-111111111111";
const KEY2 = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

describe("F5 parseMoneyInput", () => {
  it.each([
    ["250", "250.00", 250],
    ["250.5", "250.50", 250.5],
    ["250,5", "250.50", 250.5],
    ["250,50", "250.50", 250.5],
    ["250.50", "250.50", 250.5],
    [" 250,50 ", "250.50", 250.5],
    ["\t250,50\n", "250.50", 250.5],
    ["0,5", "0.50", 0.5],
    ["0.05", "0.05", 0.05],
    ["0,05", "0.05", 0.05],
    ["1234567890,12", "1234567890.12", 1234567890.12],
    ["9999999999,99", "9999999999.99", 9999999999.99],
    ["007,5", "7.50", 7.5],
    ["10", "10.00", 10],
    ["1", "1.00", 1],
  ])("accepts %j as %s", (raw, value, number) => {
    const out = parseMoneyInput(raw);
    expect(out).toEqual({ ok: true, value, number });
  });

  const rejects: [string | null | undefined, MoneyParseReason][] = [
    ["", "empty"],
    ["   ", "empty"],
    [null, "empty"],
    [undefined, "empty"],
    ["abc", "not_a_number"],
    ["12abc", "not_a_number"],
    ["NaN", "not_a_number"],
    ["Infinity", "not_a_number"],
    ["1_000", "not_a_number"],
    ["0x10", "not_a_number"],
    ["١٢٣", "not_a_number"],
    [".5", "not_a_number"],
    [",5", "not_a_number"],
    ["250,", "not_a_number"],
    ["250.", "not_a_number"],
    ["12-3", "not_a_number"],
    ["-5", "negative"],
    ["-0,5", "negative"],
    ["−5", "negative"],
    ["0", "zero"],
    ["0,00", "zero"],
    ["0.0", "zero"],
    ["000", "zero"],
    ["250,505", "too_many_decimals"],
    ["0,001", "too_many_decimals"],
    ["1.250", "too_many_decimals"],
    ["1,250", "too_many_decimals"],
    ["1.250,50", "thousands_separator"],
    ["1,250.50", "thousands_separator"],
    ["1 250,50", "thousands_separator"],
    ["1 250,50", "thousands_separator"],
    ["1 250,50", "thousands_separator"],
    ["1.2.3", "multiple_separators"],
    ["1,2,3", "multiple_separators"],
    ["1,000,000", "multiple_separators"],
    ["1e3", "exponent"],
    ["1E3", "exponent"],
    ["1,5e3", "exponent"],
    ["1e-3", "exponent"],
    ["+5", "plus_sign"],
    ["+0,5", "plus_sign"],
    ["12345678901", "too_many_digits"],
    ["12345678901,5", "too_many_digits"],
  ];
  it.each(rejects)("rejects %j with the %s reason", (raw, reason) => {
    expect(parseMoneyInput(raw)).toEqual({ ok: false, reason });
  });

  it("has a Turkish message for every reason", () => {
    const reasons = new Set(rejects.map(([, r]) => r));
    for (const reason of reasons) {
      expect(MONEY_PARSE_MESSAGES[reason], reason).toMatch(/\S/);
    }
    expect(Object.keys(MONEY_PARSE_MESSAGES).sort()).toEqual(
      [...reasons].sort(),
    );
  });

  it("the number of an accepted value is exact and prints without an exponent", () => {
    for (const text of [
      "0,01",
      "0,05",
      "250,50",
      "1234567890,12",
      "9999999999,99",
      "0.10",
      "33,37",
    ]) {
      const out = parseMoneyInput(text);
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(String(out.number)).not.toMatch(/e/i);
        expect(out.number.toFixed(2)).toBe(out.value);
      }
    }
  });

  it("formats money tr-TR with two decimals and the currency code", () => {
    expect(formatMoney(1250.5, "TRY")).toBe("1.250,50 TRY");
    expect(formatMoney(0.05, "EUR")).toBe("0,05 EUR");
    expect(formatMoney(0, "TRY")).toBe("0,00 TRY");
    expect(formatMoney(9999999999.99, "TRY")).toBe("9.999.999.999,99 TRY");
    expect(formatMoney(250, "TRY")).toBe("250,00 TRY");
  });

  it("formats a calendar date without any timezone shift", () => {
    expect(formatDate("2026-10-03")).toBe("03.10.2026");
    expect(formatDate("2026-01-01")).toBe("01.01.2026");
    expect(formatDate(null)).toBe("");
    expect(formatDate("")).toBe("");
    expect(formatDate("not a date")).toBe("not a date");
  });

  it("formats month titles and editable amounts", () => {
    expect(monthTitle("2026-09-01")).toBe("Eylül 2026");
    expect(monthTitle("2026-12")).toBe("Aralık 2026");
    expect(toEditableAmount(250.5)).toBe("250,50");
    expect(toEditableAmount(1000)).toBe("1000,00");
    expect(fillTemplate("{a} ve {b} {a}", { a: 1, b: "x" })).toBe("1 ve x 1");
    expect(fillTemplate("{missing} kalır", {})).toBe("{missing} kalır");
  });
});

describe("F6 schemas", () => {
  const validCreate = {
    tenantSlug: "bella-hair",
    categoryKey: "rent",
    description: "  Ekim ayı kirası  ",
    expenseDate: "2026-10-01",
    amount: "10.000,00".replace(".", ""), // "10000,00"
    idempotencyKey: KEY,
  };

  it("parses a minimal create, trimming text and reading 250,50 as 250.5", () => {
    const out = createExpenseSchema.parse({ ...validCreate, amount: "250,50" });
    expect(out.description).toBe("Ekim ayı kirası");
    expect(out.amount).toBe(250.5);
    expect(out.dueDate).toBeUndefined();
    expect(out.vendorName).toBeUndefined();
    expect(out.note).toBeUndefined();
    expect(out.branchId).toBeUndefined();
    expect(out.initialPayment).toBeUndefined();
  });

  it("turns empty optional strings into undefined and keeps filled ones trimmed", () => {
    const out = createExpenseSchema.parse({
      ...validCreate,
      dueDate: "",
      vendorName: "   ",
      note: "",
      branchId: null,
    });
    expect(out.dueDate).toBeUndefined();
    expect(out.vendorName).toBeUndefined();
    expect(out.note).toBeUndefined();
    expect(out.branchId).toBeNull();
    const filled = createExpenseSchema.parse({
      ...validCreate,
      dueDate: "2026-10-05",
      vendorName: " Mülk Sahibi ",
      note: " not ",
      branchId: ID,
    });
    expect(filled.dueDate).toBe("2026-10-05");
    expect(filled.vendorName).toBe("Mülk Sahibi");
    expect(filled.note).toBe("not");
    expect(filled.branchId).toBe(ID);
  });

  it("requires a uuid idempotency key", () => {
    for (const bad of [undefined, "", "not-a-uuid", "123"]) {
      const out = createExpenseSchema.safeParse({
        ...validCreate,
        idempotencyKey: bad,
      });
      expect(out.success, String(bad)).toBe(false);
    }
  });

  it("enforces the length limits (description 200, vendor 200, note 500) and a required description", () => {
    expect(
      createExpenseSchema.safeParse({
        ...validCreate,
        description: "x".repeat(200),
      }).success,
    ).toBe(true);
    expect(
      createExpenseSchema.safeParse({
        ...validCreate,
        description: "x".repeat(201),
      }).success,
    ).toBe(false);
    expect(
      createExpenseSchema.safeParse({ ...validCreate, description: "   " })
        .success,
    ).toBe(false);
    expect(
      createExpenseSchema.safeParse({
        ...validCreate,
        vendorName: "x".repeat(200),
      }).success,
    ).toBe(true);
    expect(
      createExpenseSchema.safeParse({
        ...validCreate,
        vendorName: "x".repeat(201),
      }).success,
    ).toBe(false);
    expect(
      createExpenseSchema.safeParse({ ...validCreate, note: "x".repeat(500) })
        .success,
    ).toBe(true);
    expect(
      createExpenseSchema.safeParse({ ...validCreate, note: "x".repeat(501) })
        .success,
    ).toBe(false);
  });

  it("enforces the date format and the 2000..2100 range, and a due date not before the expense date", () => {
    for (const bad of [
      "2026-13-01",
      "2026-02-30",
      "01.10.2026",
      "2026/10/01",
      "",
      "1999-12-31",
      "2101-01-01",
    ]) {
      expect(
        createExpenseSchema.safeParse({ ...validCreate, expenseDate: bad })
          .success,
        bad,
      ).toBe(false);
    }
    expect(
      createExpenseSchema.safeParse({
        ...validCreate,
        expenseDate: "2000-01-01",
      }).success,
    ).toBe(true);
    expect(
      createExpenseSchema.safeParse({
        ...validCreate,
        expenseDate: "2100-12-31",
      }).success,
    ).toBe(true);
    const before = createExpenseSchema.safeParse({
      ...validCreate,
      dueDate: "2026-09-30",
    });
    expect(before.success).toBe(false);
    if (!before.success)
      expect(before.error.issues[0]?.path).toEqual(["dueDate"]);
    expect(
      createExpenseSchema.safeParse({ ...validCreate, dueDate: "2026-10-01" })
        .success,
    ).toBe(true);
  });

  it("validates the category key and the tenant slug shapes", () => {
    for (const bad of ["", "Rent", "1rent", "re nt", "x".repeat(41)]) {
      expect(
        createExpenseSchema.safeParse({ ...validCreate, categoryKey: bad })
          .success,
        bad,
      ).toBe(false);
    }
    for (const bad of [
      "",
      "Bella",
      "bella hair",
      "-bella",
      "../x",
      "x".repeat(101),
    ]) {
      expect(
        createExpenseSchema.safeParse({ ...validCreate, tenantSlug: bad })
          .success,
        bad,
      ).toBe(false);
    }
  });

  it("makes the initial payment optional and restricts its method, instant and amount", () => {
    const withPayment = createExpenseSchema.parse({
      ...validCreate,
      initialPayment: {
        amount: "100,5",
        method: "card",
        paidAt: "2026-10-03T09:15:30.123Z",
        note: " ilk ",
      },
    });
    expect(withPayment.initialPayment).toEqual({
      amount: 100.5,
      method: "card",
      paidAt: "2026-10-03T09:15:30.123Z",
      note: "ilk",
    });
    for (const method of ["cash", "card", "bank_transfer", "other"]) {
      expect(
        createExpenseSchema.safeParse({
          ...validCreate,
          initialPayment: { amount: 1, method, paidAt: "2026-10-03T09:15:30Z" },
        }).success,
        method,
      ).toBe(true);
    }
    for (const method of ["", "cheque", "CASH", "crypto"]) {
      expect(
        createExpenseSchema.safeParse({
          ...validCreate,
          initialPayment: { amount: 1, method, paidAt: "2026-10-03T09:15:30Z" },
        }).success,
        method,
      ).toBe(false);
    }
    for (const paidAt of [
      "2026-10-03 09:15",
      "2026-10-03",
      "yesterday",
      "",
      "2026-10-03T09:15:30",
    ]) {
      expect(
        createExpenseSchema.safeParse({
          ...validCreate,
          initialPayment: { amount: 1, method: "cash", paidAt },
        }).success,
        paidAt,
      ).toBe(false);
    }
    expect(
      createExpenseSchema.safeParse({
        ...validCreate,
        initialPayment: {
          amount: "1.250,50",
          method: "cash",
          paidAt: "2026-10-03T09:15:30Z",
        },
      }).success,
    ).toBe(false);
  });

  it("moneyAmountSchema takes strings and numbers through the one parser", () => {
    expect(moneyAmountSchema.parse("250,50")).toBe(250.5);
    expect(moneyAmountSchema.parse("250.50")).toBe(250.5);
    expect(moneyAmountSchema.parse(250.5)).toBe(250.5);
    expect(moneyAmountSchema.parse(0.05)).toBe(0.05);
    for (const bad of [
      "",
      "0",
      "-1",
      "1.250,50",
      "250,505",
      "abc",
      0,
      -1,
      250.505,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1e21,
      1e-7,
      12345678901,
    ]) {
      expect(moneyAmountSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
    const failed = moneyAmountSchema.safeParse("250,505");
    expect(failed.success).toBe(false);
    if (!failed.success)
      expect(failed.error.issues[0]?.message).toBe(
        MONEY_PARSE_MESSAGES.too_many_decimals,
      );
  });

  it("update requires the expected version as an integer of at least 1", () => {
    const base = {
      tenantSlug: "bella-hair",
      expenseId: ID,
      categoryKey: "rent",
      description: "Kira",
      expenseDate: "2026-10-01",
      amount: 100,
    };
    expect(
      updateExpenseSchema.safeParse({ ...base, expectedVersion: 1 }).success,
    ).toBe(true);
    expect(
      updateExpenseSchema.safeParse({ ...base, expectedVersion: 12 }).success,
    ).toBe(true);
    for (const bad of [undefined, null, 0, -1, 1.5, "1", Number.NaN]) {
      expect(
        updateExpenseSchema.safeParse({ ...base, expectedVersion: bad })
          .success,
        String(bad),
      ).toBe(false);
    }
    expect(
      updateExpenseSchema.safeParse({
        ...base,
        expectedVersion: 1,
        expenseId: "nope",
      }).success,
    ).toBe(false);
  });

  it("cancel and void need a trimmed reason of 1..500 characters and a uuid", () => {
    const cancel = cancelExpenseSchema.parse({
      tenantSlug: "bella-hair",
      expenseId: ID,
      reason: "  yanlış giriş ",
    });
    expect(cancel.reason).toBe("yanlış giriş");
    expect(
      cancelExpenseSchema.safeParse({
        tenantSlug: "bella-hair",
        expenseId: ID,
        reason: "   ",
      }).success,
    ).toBe(false);
    expect(
      cancelExpenseSchema.safeParse({
        tenantSlug: "bella-hair",
        expenseId: ID,
        reason: "x".repeat(500),
      }).success,
    ).toBe(true);
    expect(
      cancelExpenseSchema.safeParse({
        tenantSlug: "bella-hair",
        expenseId: ID,
        reason: "x".repeat(501),
      }).success,
    ).toBe(false);
    expect(
      cancelExpenseSchema.safeParse({
        tenantSlug: "bella-hair",
        expenseId: "x",
        reason: "r",
      }).success,
    ).toBe(false);
    const voided = voidExpensePaymentSchema.parse({
      tenantSlug: "bella-hair",
      paymentId: ID,
      reason: " hatalı ",
    });
    expect(voided.reason).toBe("hatalı");
    expect(
      voidExpensePaymentSchema.safeParse({
        tenantSlug: "bella-hair",
        paymentId: ID,
        reason: "",
      }).success,
    ).toBe(false);
  });

  it("record payment needs a uuid key, a method and an offset instant, and parses 250,50", () => {
    const base = {
      tenantSlug: "bella-hair",
      expenseId: ID,
      amount: "250,50",
      method: "cash",
      paidAt: "2026-10-03T09:15:30.123Z",
      idempotencyKey: KEY2,
    };
    expect(recordExpensePaymentSchema.parse(base).amount).toBe(250.5);
    expect(
      recordExpensePaymentSchema.safeParse({
        ...base,
        idempotencyKey: undefined,
      }).success,
    ).toBe(false);
    expect(
      recordExpensePaymentSchema.safeParse({ ...base, idempotencyKey: "x" })
        .success,
    ).toBe(false);
    expect(
      recordExpensePaymentSchema.safeParse({ ...base, method: "cheque" })
        .success,
    ).toBe(false);
    expect(
      recordExpensePaymentSchema.safeParse({ ...base, paidAt: "2026-10-03" })
        .success,
    ).toBe(false);
    expect(
      recordExpensePaymentSchema.safeParse({ ...base, amount: "0" }).success,
    ).toBe(false);
    expect(
      recordExpensePaymentSchema.parse({ ...base, note: "  " }).note,
    ).toBeUndefined();
  });

  it("every message for a value a person can type is Turkish text (no raw zod default English)", () => {
    // every field present, every user-editable one left empty or wrong: exactly what a form can produce
    const samples = [
      createExpenseSchema.safeParse({
        tenantSlug: "bella-hair",
        categoryKey: "",
        description: "",
        expenseDate: "",
        amount: "",
        dueDate: "garbage",
        idempotencyKey: KEY,
        initialPayment: { amount: "", method: "cash", paidAt: "x" },
      }),
      updateExpenseSchema.safeParse({
        tenantSlug: "bella-hair",
        expenseId: ID,
        expectedVersion: 1,
        categoryKey: "",
        description: "",
        expenseDate: "",
        amount: "",
      }),
      cancelExpenseSchema.safeParse({
        tenantSlug: "bella-hair",
        expenseId: ID,
        reason: "",
      }),
      recordExpensePaymentSchema.safeParse({
        tenantSlug: "bella-hair",
        expenseId: ID,
        amount: "",
        method: "cheque",
        paidAt: "x",
        idempotencyKey: KEY,
      }),
      voidExpensePaymentSchema.safeParse({
        tenantSlug: "bella-hair",
        paymentId: ID,
        reason: "",
      }),
    ];
    for (const s of samples) {
      expect(s.success).toBe(false);
      if (!s.success) {
        expect(s.error.issues.length).toBeGreaterThan(0);
        for (const issue of s.error.issues) {
          expect(issue.message, issue.path.join(".")).not.toMatch(
            /^Invalid input|^Required$|expected .* received/i,
          );
        }
      }
    }
  });
});

describe("expense filters in the URL", () => {
  it("defaults when the URL is empty", () => {
    expect(parseExpensesFilters({})).toEqual(DEFAULT_EXPENSES_FILTERS);
  });

  it("reads every documented parameter", () => {
    const f = parseExpensesFilters({
      month: "2026-09",
      branch: ID.toUpperCase(),
      category: "rent",
      status: "partially_paid",
      cancelled: "1",
      overdue: "1",
      q: "  kira  ",
    });
    expect(f).toEqual({
      month: "2026-09",
      allMonths: false,
      branch: ID,
      category: "rent",
      status: "partially_paid",
      includeCancelled: true,
      overdueOnly: true,
      search: "kira",
    });
    expect(parseExpensesFilters({ month: "all" })).toMatchObject({
      month: null,
      allMonths: true,
    });
    expect(parseExpensesFilters({ branch: "general" }).branch).toBe("general");
  });

  it("falls back to defaults on garbage and never throws", () => {
    const f = parseExpensesFilters({
      month: "2026-13",
      branch: "not-a-uuid",
      category: "Bad Key!",
      status: "overdue",
      cancelled: "yes",
      overdue: "true",
      q: "x".repeat(150),
    });
    expect(f.month).toBeNull();
    expect(f.allMonths).toBe(false);
    expect(f.branch).toBe("all");
    expect(f.category).toBeNull();
    expect(f.status).toBeNull();
    expect(f.includeCancelled).toBe(false);
    expect(f.overdueOnly).toBe(false);
    expect(f.search).toHaveLength(100);
    for (const month of [
      "1999-12",
      "2101-01",
      "2026-00",
      "26-09",
      "2026-9",
      "2026-09-01",
      "",
      "all ",
    ]) {
      expect(parseExpensesFilters({ month }).month, month).toBeNull();
    }
    expect(parseExpensesFilters({ month: "2000-01" }).month).toBe("2000-01");
    expect(parseExpensesFilters({ month: "2100-12" }).month).toBe("2100-12");
  });

  it("takes the first value of a repeated parameter and ignores unknown ones", () => {
    expect(
      parseExpensesFilters({ category: ["rent", "water"], zzz: "1" }).category,
    ).toBe("rent");
    expect(parseExpensesFilters({ status: ["paid", "open"] }).status).toBe(
      "paid",
    );
  });

  it("shifts months across years and gives inclusive month bounds (leap years included)", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-09", 0)).toBe("2026-09");
    expect(shiftMonth("2026-03", -15)).toBe("2024-12");
    expect(shiftMonth("garbage", 1)).toBe("garbage");
    expect(monthBounds("2026-09")).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(monthBounds("2028-02")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(monthBounds("2026-02")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(monthBounds("2026-12")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(monthBounds("2100-02").to).toBe("2100-02-28"); // 2100 is not a leap year
    expect(() => monthBounds("nope")).toThrow();
  });

  it("derives the list parameters: month window, all months, overdue-only, branch scopes and search", () => {
    const base = { ...DEFAULT_EXPENSES_FILTERS };
    expect(listParamsFor(base, "2026-09")).toEqual({
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
      branchId: null,
      generalOnly: false,
      categoryKey: null,
      status: null,
      includeCancelled: false,
      overdueOnly: false,
      search: null,
    });
    expect(
      listParamsFor({ ...base, allMonths: true }, "2026-09"),
    ).toMatchObject({ fromDate: null, toDate: null });
    // overdue is inherently all-time: it ignores the month
    expect(
      listParamsFor({ ...base, overdueOnly: true }, "2026-09"),
    ).toMatchObject({ fromDate: null, toDate: null, overdueOnly: true });
    expect(
      listParamsFor({ ...base, branch: "general" }, "2026-09"),
    ).toMatchObject({ branchId: null, generalOnly: true });
    expect(listParamsFor({ ...base, branch: ID }, "2026-09")).toMatchObject({
      branchId: ID,
      generalOnly: false,
    });
    expect(
      listParamsFor(
        {
          ...base,
          search: "kira",
          category: "rent",
          status: "paid",
          includeCancelled: true,
        },
        "2026-09",
      ),
    ).toMatchObject({
      search: "kira",
      categoryKey: "rent",
      status: "paid",
      includeCancelled: true,
    });
  });

  it("builds the typed list RPC arguments: nulls become undefined, booleans stay booleans, the limit is 50", () => {
    const params = listParamsFor(DEFAULT_EXPENSES_FILTERS, "2026-09");
    expect(listRpcArgs(ID, params, null, "2026-09-15")).toEqual({
      p_tenant_id: ID,
      p_from_date: "2026-09-01",
      p_to_date: "2026-09-30",
      p_branch_id: undefined,
      p_general_only: false,
      p_category_key: undefined,
      p_status: undefined,
      p_include_cancelled: false,
      p_overdue_only: false,
      p_search: undefined,
      p_limit: 50,
      p_cursor_date: undefined,
      p_cursor_id: undefined,
      p_reference_date: "2026-09-15",
    });
    const next = listRpcArgs(
      ID,
      params,
      { expenseDate: "2026-09-02", id: KEY },
      null,
    );
    expect(next.p_cursor_date).toBe("2026-09-02");
    expect(next.p_cursor_id).toBe(KEY);
    expect(next.p_reference_date).toBeUndefined();
  });

  it("builds filter URLs: set, delete, keep the rest, and no trailing question mark", () => {
    expect(
      buildExpensesFilterUrl("/app/x/finance/expenses", "", {
        month: "2026-09",
      }),
    ).toBe("/app/x/finance/expenses?month=2026-09");
    expect(
      buildExpensesFilterUrl("/p", "?month=2026-09&q=kira", { q: null }),
    ).toBe("/p?month=2026-09");
    expect(buildExpensesFilterUrl("/p", "month=2026-09", { month: null })).toBe(
      "/p",
    );
    expect(buildExpensesFilterUrl("/p", "?a=1", { b: "2", a: "3" })).toBe(
      "/p?a=3&b=2",
    );
    expect(buildExpensesFilterUrl("/p", "?a=1", { a: "" })).toBe("/p");
    expect(buildExpensesFilterUrl("/p", "?q=a%20b", { overdue: "1" })).toBe(
      "/p?q=a+b&overdue=1",
    );
  });
});

describe("attempt helpers", () => {
  it("newAttemptKey returns a v4 uuid each time", () => {
    const re =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const a = newAttemptKey();
    const b = newAttemptKey();
    expect(a).toMatch(re);
    expect(b).toMatch(re);
    expect(a).not.toBe(b);
  });

  it("newAttemptKey falls back to getRandomValues where randomUUID is unavailable (non-secure contexts)", () => {
    const original = Object.getOwnPropertyDescriptor(
      globalThis.crypto,
      "randomUUID",
    );
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    try {
      const key = newAttemptKey();
      expect(key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(newAttemptKey()).not.toBe(key);
    } finally {
      if (original)
        Object.defineProperty(globalThis.crypto, "randomUUID", original);
      else delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
    }
  });

  it("newAttemptInstant is an ISO-8601 UTC instant with milliseconds", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-03T09:15:30.123Z"));
      expect(newAttemptInstant()).toBe("2026-10-03T09:15:30.123Z");
    } finally {
      vi.useRealTimers();
    }
  });
});
