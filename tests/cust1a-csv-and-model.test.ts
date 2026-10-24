import { describe, expect, it } from "vitest";
import { MAX_IMPORT_ROWS, buildImportRows, detectColumns, parseCsv } from "@/lib/modules/customers/import-csv";
import { parseCustomerHistory, parseImportCommit, parseImportPreview } from "@/lib/modules/customers/import-model";

/** Faz CUST.1A — pure parts: the CSV reader and the strict reading of the database answers. All names and numbers are synthetic. */

describe("parseCsv", () => {
  it("reads comma, semicolon (the Turkish Excel default) and tab files, with a byte order mark and CRLF", () => {
    expect(parseCsv("Ad Soyad;Telefon;E-posta\r\nAyşe Demir;0533 111 22 33;ayse@example.test\r\n")).toEqual([
      ["Ad Soyad", "Telefon", "E-posta"],
      ["Ayşe Demir", "0533 111 22 33", "ayse@example.test"],
    ]);
    expect(parseCsv("﻿name,phone\nA,1\n")[0]).toEqual(["name", "phone"]);
    expect(parseCsv("name\tphone\nA\t1")).toEqual([["name", "phone"], ["A", "1"]]);
  });

  it("handles quoted fields with the delimiter, quotes and line breaks inside", () => {
    expect(parseCsv('name,phone\n"Demir, Ayşe","0533 ""x"" 111"\n"Satır\nsonu",5')).toEqual([
      ["name", "phone"],
      ["Demir, Ayşe", '0533 "x" 111'],
      ["Satır\nsonu", "5"],
    ]);
  });

  it("an empty file gives no rows", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("detectColumns", () => {
  it("recognises Turkish and English headers", () => {
    expect(detectColumns(["Ad Soyad", "Cep Telefonu", "E-Posta"])).toEqual({ name: 0, phone: 1, email: 2 });
    expect(detectColumns(["Müşteri Adı", "GSM", "Mail"])).toEqual({ name: 0, phone: 1, email: 2 });
    expect(detectColumns(["Name", "Phone"])).toEqual({ name: 0, phone: 1, email: null });
    expect(detectColumns(["Adı Soyadı", "Telefon", "Eposta"])).toEqual({ name: 0, phone: 1, email: 2 });
  });
  it("leaves unknown headers unmapped so the Owner chooses", () => {
    expect(detectColumns(["Kod", "Bilgi"])).toEqual({ name: null, phone: null, email: null });
  });
});

describe("buildImportRows", () => {
  const table = [["ad", "tel", "mail"], ["Ayşe", "0533 111 22 33", ""], ["", "", ""], ["Mehmet", "", "m@example.test"]];

  it("row numbers are the file's own line numbers (header = 1); blank lines are skipped, not numbered away", () => {
    const r = buildImportRows(table, { name: 0, phone: 1, email: 2 });
    expect(r).toEqual({
      ok: true,
      skippedEmpty: 1,
      rows: [
        { row: 2, name: "Ayşe", phone: "0533 111 22 33", email: "" },
        { row: 4, name: "Mehmet", phone: "", email: "m@example.test" },
      ],
    });
  });

  it("refuses a missing name column, a missing contact column, an empty body and too many rows", () => {
    expect(buildImportRows(table, { name: null, phone: 1, email: 2 })).toEqual({ ok: false, error: "no_name_column" });
    expect(buildImportRows(table, { name: 0, phone: null, email: null })).toEqual({ ok: false, error: "no_contact_column" });
    expect(buildImportRows([["ad", "tel"]], { name: 0, phone: 1, email: null })).toEqual({ ok: false, error: "empty" });
    const many = [["ad", "tel"], ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => [`K${i}`, "0533"])];
    expect(buildImportRows(many, { name: 0, phone: 1, email: null })).toEqual({ ok: false, error: "too_many_rows" });
    const exactly = [["ad", "tel"], ...Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => [`K${i}`, "0533"])];
    expect(buildImportRows(exactly, { name: 0, phone: 1, email: null }).ok).toBe(true);
  });
});

describe("parseImportPreview / parseImportCommit", () => {
  const preview = () => ({
    maxRows: 5000,
    summary: { total: 2, new: 1, matchExisting: 0, invalid: 1, ambiguous: 0, willFillPhone: 0, willFillEmail: 0 },
    rows: [
      { row: 2, status: "NEW", reason: null, existingName: null, fillPhone: false, fillEmail: false },
      { row: 3, status: "INVALID", reason: "phone_invalid", existingName: null, fillPhone: false, fillEmail: false },
    ],
  });

  it("accepts a consistent preview", () => {
    expect(parseImportPreview(preview())!.summary.new).toBe(1);
  });

  it("refuses a summary that disagrees with its rows, an unknown status, and malformed input", () => {
    const wrongTotal = preview();
    wrongTotal.summary.new = 2;
    expect(parseImportPreview(wrongTotal)).toBeNull();
    const badStatus = preview();
    badStatus.rows[0]!.status = "MAYBE";
    expect(parseImportPreview(badStatus)).toBeNull();
    for (const bad of [null, "x", [], { rows: [] }]) expect(parseImportPreview(bad)).toBeNull();
  });

  it("commit: well-formed accepted, malformed refused", () => {
    const ok = { summary: { total: 1, created: 1, matchExisting: 0, filledPhone: 0, filledEmail: 0, skippedInvalid: 0, skippedAmbiguous: 0 }, rows: [] };
    expect(parseImportCommit(ok)!.summary.created).toBe(1);
    expect(parseImportCommit({ ...ok, summary: { ...ok.summary, created: -1 } })).toBeNull();
    expect(parseImportCommit({ summary: ok.summary, rows: [{ row: 1, status: "??" }] })).toBeNull();
  });
});

describe("parseCustomerHistory", () => {
  const base = () => ({
    timezone: "Europe/Nicosia",
    summary: { completedVisits: 2, lastVisitAt: "2026-09-20T08:00:00+00:00", upcoming: 1, cancelled: 1, noShow: 1, total: 5 },
    upcoming: [{ startAt: "2026-12-01T08:00:00+00:00", status: "confirmed", items: [{ service: "Kirpik Laminasyonu", staff: "Emel Kaynakkan" }] }],
    past: [{ startAt: "2026-09-20T08:00:00+00:00", status: "completed", items: [{ service: "Kaş Alımı", staff: "Emel Kaynakkan" }] }],
    hasMorePast: false,
    servicesReceived: [{ service: "Kaş Alımı", count: 1 }],
    staff: [{ displayName: "Emel Kaynakkan", count: 2 }],
    finance: null,
  });

  it("accepts the answer; money is null for a caller without finance and present only when the model carries it", () => {
    const h = parseCustomerHistory(base())!;
    expect(h.finance).toBeNull();
    expect(h.past[0]!.money).toBeNull();
    const withMoney = base() as Record<string, unknown>;
    (withMoney.past as Record<string, unknown>[])[0] = { ...(withMoney.past as Record<string, unknown>[])[0], amount: 600, hasCheckout: true, paid: 300, outstanding: 300 };
    withMoney.finance = { completedAmount: 600, outstanding: 300, completedWithoutCheckout: 0, currency: "TRY" };
    const m = parseCustomerHistory(withMoney)!;
    expect(m.past[0]!.money).toEqual({ amount: 600, hasCheckout: true, paid: 300, outstanding: 300 });
    expect(m.finance!.outstanding).toBe(300);
  });

  it("refuses malformed answers", () => {
    for (const bad of [null, [], { ...base(), summary: null }, { ...base(), upcoming: [{ startAt: 5 }] }, { ...base(), finance: { completedAmount: "x" } }, { ...base(), staff: [{ displayName: 1, count: 1 }] }]) {
      expect(parseCustomerHistory(bad)).toBeNull();
    }
  });
});
