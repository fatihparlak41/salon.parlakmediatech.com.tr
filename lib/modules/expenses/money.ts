/**
 * Faz FIN.1B.1 — Turkish decimal input and display for the expense module.
 *
 * parseMoneyInput is the ONE parser: the dialogs use it for instant feedback and the Zod schemas use it as the authority at
 * the Server Action boundary. It is deliberately strict: a thousands separator is rejected rather than guessed ("1.250" is
 * 1,25 in some hands and 1250 in others), and the result is a canonical string with exactly two decimals so what the user
 * typed is exactly what the RPC receives. FIN.1A's own amount handling is untouched.
 */

export type MoneyParseReason =
  | "empty"
  | "not_a_number"
  | "negative"
  | "zero"
  | "plus_sign"
  | "exponent"
  | "thousands_separator"
  | "multiple_separators"
  | "too_many_decimals"
  | "too_many_digits";

export type MoneyParseResult =
  | {
      ok: true;
      /** canonical text with `.` and exactly two decimals, e.g. "250.50" */ value: string;
      /** the same value as a JS number */ number: number;
    }
  | { ok: false; reason: MoneyParseReason };

export const MONEY_PARSE_MESSAGES: Record<MoneyParseReason, string> = {
  empty: "Tutar girin.",
  not_a_number: "Geçerli bir tutar girin (örn. 250,50).",
  negative: "Tutar negatif olamaz.",
  zero: "Tutar sıfırdan büyük olmalı.",
  plus_sign: "Tutarın başına + işareti koymayın.",
  exponent: "Tutarı üstel gösterimle yazmayın (örn. 1e3).",
  thousands_separator: "Binlik ayırıcı kullanmayın; örn. 1250,50 yazın.",
  multiple_separators:
    "Tutarda yalnızca bir ondalık ayırıcı olabilir (örn. 250,50).",
  too_many_decimals: "Tutarda en fazla 2 ondalık basamak olabilir.",
  too_many_digits: "Tutar en fazla 10 basamaklı bir tam kısım içerebilir.",
};

const MAX_INTEGER_DIGITS = 10;

/**
 * Accepts: 250, 250.5, 250,5, 250,50, " 250,50 ", 0,5, 0.05, 1234567890,12 (up to 10 integer digits, an optional single "." or
 * "," and one or two decimals). Rejects: blank, non-numeric, negative, zero, a leading plus, an exponent, any thousands
 * separator (1.250,50  1,250.50  "1 250,50"), more than one separator, more than 2 decimals and more than 10 integer digits.
 */
export function parseMoneyInput(
  raw: string | null | undefined,
): MoneyParseResult {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: false, reason: "empty" };

  // any whitespace inside the number (space, NBSP, narrow NBSP...) is a grouping attempt
  if (/\s/.test(text)) return { ok: false, reason: "thousands_separator" };

  if (text.startsWith("+")) return { ok: false, reason: "plus_sign" };
  if (text.startsWith("-") || text.startsWith("−"))
    return { ok: false, reason: "negative" };

  if (/^[0-9.,]+[eE][+-]?[0-9]+$/.test(text))
    return { ok: false, reason: "exponent" };
  if (!/^[0-9.,]+$/.test(text)) return { ok: false, reason: "not_a_number" };

  const separators = text.match(/[.,]/g) ?? [];
  if (separators.length > 1) {
    return {
      ok: false,
      reason:
        new Set(separators).size > 1
          ? "thousands_separator"
          : "multiple_separators",
    };
  }

  let integerPart = text;
  let fractionPart = "";
  if (separators.length === 1) {
    const at = text.search(/[.,]/);
    integerPart = text.slice(0, at);
    fractionPart = text.slice(at + 1);
    // ".5", ",5" and "250," are typos, not amounts
    if (integerPart === "" || fractionPart === "")
      return { ok: false, reason: "not_a_number" };
    if (fractionPart.length > 2)
      return { ok: false, reason: "too_many_decimals" };
  }

  if (integerPart.length > MAX_INTEGER_DIGITS)
    return { ok: false, reason: "too_many_digits" };

  if (/^0*$/.test(integerPart) && /^0*$/.test(fractionPart))
    return { ok: false, reason: "zero" };

  const canonicalInteger = integerPart.replace(/^0+(?=\d)/, "");
  const value = `${canonicalInteger}.${fractionPart.padEnd(2, "0")}`;
  return { ok: true, value, number: Number(value) };
}

/** tr-TR with exactly 2 decimals and the currency code: "1.250,50 TRY". */
export function formatMoney(amount: number, currency: string): string {
  return `${amount.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

/** "2026-10-03" → "03.10.2026" (a calendar date, never passed through a Date so no timezone can shift it). */
export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : isoDate;
}

/** An instant for display in the viewer's own timezone (payments are timestamptz). */
export function formatDateTime(isoInstant: string | null | undefined): string {
  if (!isoInstant) return "";
  const date = new Date(isoInstant);
  if (Number.isNaN(date.getTime())) return isoInstant;
  return date.toLocaleString("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}
