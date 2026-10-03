import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EXPENSE_DEFAULT_ERROR_MESSAGE,
  EXPENSE_ERROR_MESSAGES,
  expenseAppErrorCode,
  expenseFailure,
  mapExpenseErrorCode,
} from "@/lib/modules/expenses/error-codes";

/**
 * Faz FIN.1B.1 — the expense module's own error messages (matrix F1, F2, F3). No database: pure mapping and import-graph
 * checks. The messages are the architecture v2 section 6 wording, verbatim.
 */

const EXPECTED: Record<string, string> = {
  FN001: "Oturumunuz sona ermiş, lütfen tekrar giriş yapın.",
  FN002: "Giderler için bu işlemi yapma yetkiniz yok.",
  FN003: "Gider kaydı bulunamadı.",
  FN004:
    "Girdiğiniz bilgiler geçersiz. Tutar, tarih ve zorunlu alanları kontrol edin.",
  FN005: "Ödeme tutarı giderin kalan tutarını aşamaz.",
  FN006: "Geçersiz ödeme yöntemi.",
  FN007:
    "Bu işlem az önce farklı bilgilerle zaten kaydedildi. Sayfayı yenileyip tekrar deneyin.",
  FN008: "İptal edilmiş gider değiştirilemez.",
  FN009: "Ödeme kaydı bulunamadı.",
  FN011: "Ödemesi bulunan gider iptal edilemez. Önce ödemeleri iptal edin.",
  FN012:
    "Ödeme yapılmış giderin tarihi, şubesi ve kategorisi değiştirilemez; tutar da ödenen toplamın altına düşürülemez. Gerekirse önce ödemeleri iptal edin.",
  FN013: "Gider başka bir işlemle değişti. Sayfayı yenileyip tekrar deneyin.",
};
const DEFAULT = "İşlem gerçekleştirilemedi, lütfen tekrar deneyin.";

describe("F1 the expense error map", () => {
  it.each(Object.entries(EXPECTED))(
    "%s maps to the architecture v2 message",
    (code, message) => {
      expect(mapExpenseErrorCode(code)).toBe(message);
      expect(EXPENSE_ERROR_MESSAGES[code]).toBe(message);
    },
  );

  it("has exactly the twelve documented entries and no FN010", () => {
    expect(Object.keys(EXPENSE_ERROR_MESSAGES).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
    expect(EXPENSE_ERROR_MESSAGES).not.toHaveProperty("FN010");
  });

  it.each([
    ["FN010"],
    ["FN014"],
    ["FN000"],
    ["PGRST116"],
    ["PGRST202"],
    ["42501"],
    ["23505"],
    ["40P01"],
    ["22P02"],
    [""],
    ["toString"],
    ["__proto__"],
    ["constructor"],
  ])("%s falls through to the default message", (code) => {
    expect(mapExpenseErrorCode(code)).toBe(DEFAULT);
  });

  it("null and undefined fall through to the default message", () => {
    expect(mapExpenseErrorCode(null)).toBe(DEFAULT);
    expect(mapExpenseErrorCode(undefined)).toBe(DEFAULT);
    expect(EXPENSE_DEFAULT_ERROR_MESSAGE).toBe(DEFAULT);
  });

  it("maps each code to the AppErrorCode the UI reacts to (CONFLICT offers a refresh)", () => {
    const expected: Record<string, string> = {
      FN001: "UNAUTHENTICATED",
      FN002: "UNAUTHORIZED",
      FN003: "NOT_FOUND",
      FN009: "NOT_FOUND",
      FN004: "VALIDATION",
      FN005: "VALIDATION",
      FN006: "VALIDATION",
      FN007: "CONFLICT",
      FN008: "CONFLICT",
      FN011: "CONFLICT",
      FN012: "CONFLICT",
      FN013: "CONFLICT",
    };
    for (const [code, appCode] of Object.entries(expected))
      expect(expenseAppErrorCode(code), code).toBe(appCode);
    for (const code of [
      "FN010",
      "PGRST116",
      "42501",
      "nope",
      "",
      null,
      undefined,
      "toString",
    ]) {
      expect(
        expenseAppErrorCode(code as string | null | undefined),
        String(code),
      ).toBe("UNEXPECTED");
    }
  });

  it("expenseFailure builds the failed ActionResult from the code alone", () => {
    expect(expenseFailure({ code: "FN013" })).toEqual({
      success: false,
      error: { code: "CONFLICT", message: EXPECTED.FN013 },
    });
    expect(expenseFailure({ code: "FN010" })).toEqual({
      success: false,
      error: { code: "UNEXPECTED", message: DEFAULT },
    });
    expect(expenseFailure(null)).toEqual({
      success: false,
      error: { code: "UNEXPECTED", message: DEFAULT },
    });
  });
});

describe("F2 independence from the FIN.1A finance modules", () => {
  it("the expense modules import nothing from lib/modules/finance (static)", () => {
    const root = process.cwd();
    const files = [
      "error-codes.ts",
      "money.ts",
      "schemas.ts",
      "filters.ts",
      "format.ts",
      "types.ts",
      "attempt.ts",
      "labels.ts",
      "actions.ts",
      "queries.ts",
      "client-queries.ts",
    ];
    for (const file of files) {
      const text = readFileSync(
        path.join(root, "lib/modules/expenses", file),
        "utf8",
      );
      const imports = text.match(/from\s+["'][^"']+["']/g) ?? [];
      for (const imp of imports) {
        expect(imp, `${file} imports ${imp}`).not.toMatch(/modules\/finance/);
      }
    }
  });

  it("maps every code while the finance modules throw on ANY access (behavioral)", async () => {
    vi.resetModules();
    const trap = (name: string) =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            throw new Error(
              `the expense error module touched ${name}.${String(prop)}`,
            );
          },
        },
      );
    vi.doMock("@/lib/modules/finance/error-codes", () =>
      trap("finance/error-codes"),
    );
    vi.doMock("@/lib/modules/finance/actions", () => trap("finance/actions"));
    vi.doMock("@/lib/modules/finance/client-queries", () =>
      trap("finance/client-queries"),
    );
    try {
      const fresh = await import("@/lib/modules/expenses/error-codes");
      for (const [code, message] of Object.entries(EXPECTED))
        expect(fresh.mapExpenseErrorCode(code)).toBe(message);
      expect(fresh.mapExpenseErrorCode("FN010")).toBe(DEFAULT);
      expect(fresh.expenseFailure({ code: "FN002" }).success).toBe(false);
    } finally {
      vi.doUnmock("@/lib/modules/finance/error-codes");
      vi.doUnmock("@/lib/modules/finance/actions");
      vi.doUnmock("@/lib/modules/finance/client-queries");
      vi.resetModules();
    }
  });
});

describe("F3 distinctness from the appointment finance wording", () => {
  // FN001 (session expired) and FN006 (invalid payment method) are domain-neutral sentences that architecture v2 section 6
  // approved word for word, and FIN.1A happens to use the same text for them. They are the ONLY allowed overlaps; the list
  // is pinned so a third one fails this test.
  const NEUTRAL_OVERLAPS = ["FN001", "FN006"];

  it("no expense message equals a FIN.1A message, except the two pinned domain-neutral sentences", async () => {
    const actual = await vi.importActual<{
      FINANCE_ERROR_MESSAGES: Record<string, string>;
    }>("@/lib/modules/finance/error-codes");
    const financeValues = new Set(Object.values(actual.FINANCE_ERROR_MESSAGES));
    const overlaps = Object.entries(EXPENSE_ERROR_MESSAGES)
      .filter(([, message]) => financeValues.has(message))
      .map(([code]) => code)
      .sort();
    expect(overlaps).toEqual(NEUTRAL_OVERLAPS);
    // and the two overlapping codes really are the neutral ones
    expect(EXPENSE_ERROR_MESSAGES.FN001).toBe(
      actual.FINANCE_ERROR_MESSAGES.FN001,
    );
    expect(EXPENSE_ERROR_MESSAGES.FN006).toBe(
      actual.FINANCE_ERROR_MESSAGES.FN006,
    );
  });

  it("no expense message contains appointment, collection, sale or customer wording", () => {
    const forbidden = ["randevu", "tahsil", "satış", "müşteri"];
    for (const [code, message] of [
      ...Object.entries(EXPENSE_ERROR_MESSAGES),
      ["default", EXPENSE_DEFAULT_ERROR_MESSAGE],
    ] as [string, string][]) {
      const folded = message.toLocaleLowerCase("tr-TR");
      for (const word of forbidden)
        expect(folded, `${code} contains "${word}"`).not.toContain(word);
    }
  });
});
