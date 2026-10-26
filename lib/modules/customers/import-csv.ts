/**
 * Faz CUST.1A — reading a customer list from CSV, in the browser or on the server. Pure functions: nothing is stored, nothing
 * is logged. The uploaded text is parsed, shown, imported and dropped.
 *
 * Supported: comma, semicolon or tab separated text (the Turkish Excel default is the semicolon), double-quoted fields with
 * "" as an escaped quote, a UTF-8 byte order mark, CRLF or LF. Not supported: .xlsx (export to CSV first).
 */

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export type ImportRow = { row: number; name: string; phone: string; email: string };
export type ColumnMapping = { name: number | null; phone: number | null; email: number | null };

export function parseCsv(input: string): string[][] {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  text = text.replace(/\r\n?/g, "\n");
  const firstLine = text.split("\n", 1)[0] ?? "";
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delimiter = count(";") >= count(",") && count(";") >= count("\t") && count(";") > 0 ? ";" : count("\t") > count(",") ? "\t" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const HEADER_WORDS = {
  name: ["ad soyad", "adi soyadi", "ad soyadi", "isim", "isim soyisim", "ad", "musteri", "musteri adi", "name", "full name", "fullname", "customer"],
  phone: ["telefon", "telefon numarasi", "tel", "gsm", "cep", "cep telefonu", "cep no", "phone", "mobile", "phone number"],
  email: ["e-posta", "eposta", "e posta", "e-mail", "email", "mail", "e-posta adresi", "eposta adresi"],
} as const;

function foldHeader(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/\s+/g, " ");
}

/** Guess which column is which from the header row; null where nothing matched. */
export function detectColumns(headers: string[]): ColumnMapping {
  const folded = headers.map(foldHeader);
  const find = (words: readonly string[]) => {
    const index = folded.findIndex((h) => words.includes(h));
    return index >= 0 ? index : null;
  };
  return { name: find(HEADER_WORDS.name), phone: find(HEADER_WORDS.phone), email: find(HEADER_WORDS.email) };
}

export type BuildResult =
  | { ok: true; rows: ImportRow[]; skippedEmpty: number }
  | { ok: false; error: "empty" | "too_many_rows" | "no_name_column" | "no_contact_column" };

/** Turns the parsed table into import rows. Row numbers are the file's own line numbers (the header is line 1). */
export function buildImportRows(table: string[][], mapping: ColumnMapping): BuildResult {
  const body = table.slice(1);
  if (body.length === 0) return { ok: false, error: "empty" };
  if (mapping.name === null) return { ok: false, error: "no_name_column" };
  if (mapping.phone === null && mapping.email === null) return { ok: false, error: "no_contact_column" };
  const cell = (r: string[], index: number | null) => (index === null ? "" : (r[index] ?? "").trim());
  const rows: ImportRow[] = [];
  let skippedEmpty = 0;
  body.forEach((r, i) => {
    const name = cell(r, mapping.name);
    const phone = cell(r, mapping.phone);
    const email = cell(r, mapping.email);
    if (!name && !phone && !email) {
      skippedEmpty += 1; // a blank line in the file
      return;
    }
    rows.push({ row: i + 2, name, phone, email });
  });
  if (rows.length === 0) return { ok: false, error: "empty" };
  if (rows.length > MAX_IMPORT_ROWS) return { ok: false, error: "too_many_rows" };
  return { ok: true, rows, skippedEmpty };
}
