import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import trMessages from "@/messages/tr.json";
import {
  EXPENSE_CATEGORY_KEY_LIST,
  EXPENSE_PAYMENT_METHODS,
  EXPENSE_STATUSES,
} from "@/lib/modules/expenses/types";

/**
 * Faz FIN.1B.1 — the Turkish message catalog for expenses (matrix F13 wording and F15 completeness). No database, no DOM:
 * the catalog is a JSON file and the components are scanned as text.
 */

const expenses = trMessages.Expenses as Record<string, unknown>;

function leaves(value: unknown, prefix: string[] = []): [string, string][] {
  if (typeof value === "string") return [[prefix.join("."), value]];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => leaves(child, [...prefix, key]),
  );
}

function resolve(path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      expenses,
    );
}

const ALL = leaves(expenses);

describe("F13 wording", () => {
  it("contains none of the whole words kâr, kar, net or profit (so İnternet and Kart pass)", () => {
    const word = /(^|[^\p{L}])(kâr|kar|net|profit)([^\p{L}]|$)/iu;
    const offenders = ALL.filter(([, text]) => word.test(text));
    expect(offenders).toEqual([]);
    // the guard itself works, and does not trip on the legitimate words
    expect(word.test("Net gelir")).toBe(true);
    expect(word.test("Toplam kâr")).toBe(true);
    expect(word.test("Profit")).toBe(true);
    expect(word.test("İnternet")).toBe(false);
    expect(word.test("Kart")).toBe(false);
    expect(word.test("Sarf malzeme")).toBe(false);
  });

  it("contains no appointment, collection, sale or customer wording", () => {
    const forbidden = ["randevu", "tahsil", "satış", "müşteri"];
    for (const [key, text] of ALL) {
      const folded = text.toLocaleLowerCase("tr-TR");
      for (const word of forbidden)
        expect(folded, `${key} contains "${word}"`).not.toContain(word);
    }
  });

  it("the four overview card labels and the pinned strings are exact", () => {
    const pinned: Record<string, string> = {
      "cards.incurred": "Bu ay gider",
      "cards.paid": "Bu ay ödenen",
      "cards.outstanding": "Toplam ödenmemiş gider bakiyesi",
      "cards.outstandingHint": "Seçili aydan bağımsız, güncel toplam",
      "cards.upcoming": "Yaklaşan vadeler",
      "cards.upcomingHint": "Önümüzdeki {days} gün",
      "cards.overdueLine": "Vadesi geçmiş: {count} gider, {amount}",
      "status.open": "Ödenmedi",
      "status.partially_paid": "Kısmen ödendi",
      "status.paid": "Ödendi",
      "status.cancelled": "İptal edildi",
      "status.overdue": "Vadesi geçti",
      "kind.fixed": "Sabit gider",
      "kind.variable": "Değişken gider",
      "methods.cash": "Nakit",
      "methods.card": "Kart",
      "methods.bank_transfer": "Havale/EFT",
      "methods.other": "Diğer",
      "create.payNowToggle": "Hemen ödendi olarak kaydet",
      "payment.title": "Ödeme Yap",
      "void.title": "Ödemeyi iptal et",
      "cancel.title": "Gideri iptal et",
      "edit.title": "Gideri düzenle",
      "create.title": "Yeni gider",
      "edit.lockedHint": "Ödeme yapıldığı için kilitli",
      branchGeneral: "Genel (şubesiz)",
    };
    for (const [key, text] of Object.entries(pinned))
      expect(resolve(key), key).toBe(text);
    const categories: Record<string, string> = {
      rent: "Kira",
      electricity: "Elektrik",
      water: "Su",
      internet: "İnternet",
      phone: "Telefon",
      accountant: "Muhasebe",
      software: "Yazılım ve abonelikler",
      pos_fees: "POS komisyonları",
      supplies: "Sarf malzeme",
      beauty_products: "Güzellik ürünleri",
      cleaning: "Temizlik",
      advertising: "Reklam",
      food: "Yiyecek ve içecek",
      transport: "Ulaşım",
      repairs: "Bakım ve onarım",
      other: "Diğer",
    };
    expect(expenses.categories).toEqual(categories);
    expect(trMessages.TenantApp.nav.expenses).toBe("Giderler");
  });

  it("the navigation entry sits between Hizmetler and Raporlar", () => {
    expect(Object.keys(trMessages.TenantApp.nav)).toEqual([
      "dashboard",
      "calendar",
      "customers",
      "appointments",
      "staff",
      "team",
      "services",
      "expenses",
      "reports",
      "settings",
    ]);
  });
});

describe("F15 i18n completeness", () => {
  it("labels every category, kind, status (plus overdue) and payment method", () => {
    expect(Object.keys(expenses.categories as object)).toEqual([
      ...EXPENSE_CATEGORY_KEY_LIST,
    ]);
    expect(Object.keys(expenses.kind as object).sort()).toEqual([
      "fixed",
      "variable",
    ]);
    expect(Object.keys(expenses.status as object).sort()).toEqual(
      [...EXPENSE_STATUSES, "overdue"].sort(),
    );
    expect(Object.keys(expenses.methods as object).sort()).toEqual(
      [...EXPENSE_PAYMENT_METHODS].sort(),
    );
    for (const [key, text] of ALL) expect(text.trim(), key).not.toBe("");
  });

  const sources = [
    ...readdirSync(path.join(process.cwd(), "components/expenses"))
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => path.join("components/expenses", f)),
    "lib/modules/expenses/format.ts",
    "app/[locale]/app/[tenantSlug]/finance/expenses/page.tsx",
  ];

  function referencedPaths(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const file of sources) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      for (const match of text.matchAll(
        /\blabels\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g,
      )) {
        const list = found.get(match[1]!) ?? [];
        list.push(file);
        found.set(match[1]!, list);
      }
    }
    return found;
  }

  it("every labels.* path the components read resolves in messages/tr.json", () => {
    const refs = referencedPaths();
    expect(refs.size).toBeGreaterThan(40);
    const unresolved = [...refs.keys()].filter((p) => resolve(p) === undefined);
    expect(unresolved).toEqual([]);
  });

  it("every label in the catalog is read by some component (no dead keys)", () => {
    const refs = [...referencedPaths().keys()];
    // a path read as an object (labels.categories[key], labels.status[s]) uses all of its children
    const unused = ALL.map(([key]) => key).filter(
      (key) => !refs.some((p) => key === p || key.startsWith(`${p}.`)),
    );
    expect(unused).toEqual([]);
  });

  it("template placeholders in the catalog are only the ones the code fills", () => {
    const allowed = new Set([
      "days",
      "count",
      "amount",
      "currency",
      "incurred",
      "paid",
      "outstanding",
      "date",
      "name",
      "reason",
    ]);
    for (const [key, text] of ALL) {
      for (const match of text.matchAll(/\{(\w+)\}/g)) {
        expect(allowed.has(match[1]!), `${key} uses {${match[1]}}`).toBe(true);
      }
    }
  });
});
