/**
 * Faz SAAS.1C.2b - CSV / canonical-JSON writers for the tenant export. Pure functions (no I/O), unit tested.
 *
 *  - Delimiter ";" and a UTF-8 BOM so Turkish Excel opens the file correctly (names with ç ğ ı ö ş ü stay intact).
 *  - Spreadsheet formula injection: any TEXT cell starting with = + - @ TAB CR or LF is prefixed with a single quote (OWASP guidance). Typed
 *    numbers are NOT text and are written as-is, so a negative amount stays a number. The JSON file keeps the raw values.
 *  - Rows end with CRLF; a cell containing ";" a quote CR or LF is quoted with doubled quotes.
 */

export const CSV_DELIMITER = ";";
export const CSV_BOM = "\uFEFF";

const FORMULA_START = /^[=+\-@\t\r\n]/;

export type CsvValue = string | number | boolean | null | undefined | Record<string, unknown> | unknown[];

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (/[;"\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(values: CsvValue[]): string {
  return values.map(csvCell).join(CSV_DELIMITER) + "\r\n";
}

/** Header row, then one line per row object with the columns in the declared order (missing key -> empty cell). */
export function csvHeader(columns: readonly string[]): string {
  return csvRow([...columns]);
}

export function csvRecord(columns: readonly string[], row: Record<string, unknown>): string {
  return csvRow(columns.map((c) => row[c] as CsvValue));
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalStringify(v)).join(",") + "]";
  const o = value as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalStringify(o[k])).join(",") + "}";
}
