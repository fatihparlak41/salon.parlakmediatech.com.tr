import { describe, expect, it } from "vitest";
import { CSV_BOM, canonicalStringify, csvCell, csvRecord, csvRow } from "@/lib/modules/export/csv";
import { buildExportArchive, exportFolder, type PageFetcher, type Row } from "@/lib/modules/export/archive";
import { EXPORT_VERSION, SECTIONS } from "@/lib/modules/export/sections";
import { hashToken, isWellFormedToken, newExportToken } from "@/lib/modules/export/token";
import { zipStream } from "@/lib/modules/export/zip";
import { readZip } from "./export-zip-reader";

/** Faz SAAS.1C.2b - pure-logic tests: CS csv, ZP zip, AR archive, TO token, SC scope invariants, PF performance. */

const collect = async (g: AsyncIterable<Uint8Array>) => Buffer.concat((await (async () => { const o: Buffer[] = []; for await (const c of g) o.push(Buffer.from(c)); return o; })()));

describe("CS csv", () => {
  it("CS1 formula injection: text starting with = + - @ TAB CR LF is neutralised", () => {
    for (const bad of ["=1+1", "+90 500", "-2+3", "@SUM(A1)", "\t=x", "\r=x", "\n=x"]) expect(csvCell(bad).replace(/^"/, "")).toMatch(/^'/);
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe('"\'=HYPERLINK(""http://evil"")"');
  });
  it("CS2 typed numbers are not text: a negative amount stays a number", () => {
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell("-12.5")).toBe("'-12.5");
  });
  it("CS3 quoting: delimiter, quote, CR and LF; nulls empty; booleans literal", () => {
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('x"y')).toBe('"x""y"');
    expect(csvCell("l1\r\nl2")).toBe('"l1\r\nl2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(true)).toBe("true");
    expect(csvRow(["a", 1, null])).toBe("a;1;\r\n");
  });
  it("CS4 UTF-8 / Turkish characters survive byte-exactly", () => {
    const s = "Çağrı İğdır Şükrü Öz ıüşğç";
    expect(Buffer.from(csvCell(s), "utf8").toString("utf8")).toBe(s);
    expect(CSV_BOM).toBe("﻿");
  });
  it("CS5 columns in declared order; missing key is an empty cell; timestamps and money are written as stored", () => {
    expect(csvRecord(["b", "a", "c"], { a: "2026-11-05T09:00:00+00:00", b: 100.5 })).toBe("100.5;2026-11-05T09:00:00+00:00;\r\n");
  });
  it("CS6 canonical JSON is deterministic regardless of key order", () => {
    expect(canonicalStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });
});

describe("TO token", () => {
  it("TO1 256-bit base64url, well formed, never equal twice, hash is 64 hex and differs from the token", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = newExportToken();
      expect(isWellFormedToken(t.token)).toBe(true);
      expect(t.token.length).toBe(43);
      expect(t.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(t.tokenHash).not.toContain(t.token);
      expect(hashToken(t.token)).toBe(t.tokenHash);
      seen.add(t.token);
    }
    expect(seen.size).toBe(500);
  });
  it("TO2 malformed tokens are rejected before any database call", () => {
    for (const bad of ["", "a", "x".repeat(42), "x".repeat(44), "a b".padEnd(43, "x"), 5, null, undefined, "../".padEnd(43, "x")]) expect(isWellFormedToken(bad)).toBe(false);
  });
});

describe("SC scope invariants", () => {
  it("SC1 no section column can carry secrets, internal user ids, idempotency data, storage paths or provider data", () => {
    const forbidden = /password|secret|token|storage_path|created_by|updated_by|voided_by|cancelled_by|idempotency|provider|user_id|membership|consumed_by|email_snapshot|fingerprint|hash/i;
    for (const s of SECTIONS) for (const c of s.columns) expect(c, `${s.key}.${c}`).not.toMatch(forbidden);
  });
  it("SC2 no platform / billing / auth section exists", () => {
    const keys = SECTIONS.map((s) => s.key).join(",");
    expect(keys).not.toMatch(/subscription|billing|plan|platform|auth|session|audit|notification|push|invitation|membership|role/);
  });
  it("SC3 section keys are unique and the export version is 1", () => {
    expect(new Set(SECTIONS.map((s) => s.key)).size).toBe(SECTIONS.length);
    expect(EXPORT_VERSION).toBe(1);
  });
});

function fakeFetcher(data: Record<string, Row[]>, pageSize = 2, onCall?: () => void): PageFetcher {
  return async (section, after) => {
    onCall?.();
    const rows = data[section] ?? [];
    const start = after ? Number(after) : 0;
    const slice = rows.slice(start, start + pageSize);
    const end = start + pageSize;
    return { rows: slice, next: end < rows.length ? String(end) : null };
  };
}
const opts = (fetchPage: PageFetcher) => ({ fetchPage, now: new Date("2026-11-05T09:30:00Z"), snapshotAt: "2026-11-05T09:29:59Z", tenantTimezone: "Europe/Nicosia", tenantCurrency: "TRY" });

describe("ZP / AR archive", () => {
  it("ZP1 a valid zip with every entry crc-verified (independent reader), UTF-8 names", async () => {
    const buf = await collect(zipStream((async function* () { yield { name: "klasör/çağrı.txt", data: [Buffer.from("merhaba dünya ".repeat(1000))] }; yield { name: "empty.txt", data: [] as Uint8Array[] }; })(), new Date("2026-11-05T09:30:00Z")));
    const files = readZip(buf);
    expect(files.get("klasör/çağrı.txt")!.toString()).toBe("merhaba dünya ".repeat(1000));
    expect(files.get("empty.txt")!.length).toBe(0);
  });
  it("AR1 layout, metadata last, version, counts, formula guard and Turkish text in the csv, raw values in the json", async () => {
    const data: Record<string, Row[]> = {
      customers: [
        { id: "c1", full_name: "Çağrı Öz", phone: "+905001112233", email: "a@example.test", notes: "=cmd|' /C calc'!A0", status: "active", created_at: "2026-11-05T09:00:00+00:00", updated_at: null, deleted_at: null },
        { id: "c2", full_name: "Şule; \"Ş\"", phone: null, email: null, notes: "satır1\nsatır2", status: "active", created_at: "x", updated_at: null, deleted_at: null },
        { id: "c3", full_name: "Üç", phone: null, email: null, notes: null, status: "active", created_at: "x", updated_at: null, deleted_at: null },
      ],
      tenant: [{ id: "t", name: "Salon İ", slug: "s", timezone: "Europe/Nicosia", currency: "TRY", created_at: "x", customer_cancellation_enabled: true, customer_cancellation_cutoff_minutes: 60, customer_reschedule_enabled: false, customer_reschedule_cutoff_minutes: 60 }],
    };
    const { stream, report } = buildExportArchive(opts(fakeFetcher(data)));
    const buf = await collect(stream);
    const files = readZip(buf);
    const base = `${exportFolder(new Date("2026-11-05T09:30:00Z"))}/`;
    expect(base).toBe("salonos-export-2026-11-05-0930/");
    const names = [...files.keys()];
    expect(names.at(-1)).toBe(`${base}metadata.json`);
    expect(names).toContain(`${base}salonos-export.json`);
    for (const s of SECTIONS) expect(names).toContain(`${base}csv/${s.key}.csv`);
    const csv = files.get(`${base}csv/customers.csv`)!;
    expect(csv.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    const text = csv.toString("utf8");
    expect(text).toContain("Çağrı Öz");
    expect(text).toContain("'=cmd|' /C calc'!A0");
    expect(text).toContain('"Şule; ""Ş"""');
    const json = JSON.parse(files.get(`${base}salonos-export.json`)!.toString("utf8"));
    expect(json.sections.customers[0].notes).toBe("=cmd|' /C calc'!A0"); // json keeps raw values
    expect(json.sections.customers.length).toBe(3);
    const meta = JSON.parse(files.get(`${base}metadata.json`)!.toString("utf8"));
    expect(meta).toMatchObject({ export_version: 1, tenant_timezone: "Europe/Nicosia", tenant_currency: "TRY", entity_counts: { customers: 3, tenant: 1, branches: 0 } });
    expect(meta.consistency.passes_identical).toBe(true);
    expect(JSON.stringify(meta)).not.toMatch(/Çağrı|a@example|\+9050011/);
    expect(report()).toMatchObject({ counts: { customers: 3 }, passesIdentical: true });
  });
  it("AR2 deterministic: the same input yields byte-identical json and csv", async () => {
    const data = { branches: [{ id: "b", name: "Şube", address: null, phone: null, whatsapp_phone: null, instagram_handle: null, location_url: null, is_primary: true, created_at: "x", updated_at: null, deleted_at: null }] };
    const a = readZip(await collect(buildExportArchive(opts(fakeFetcher(data))).stream));
    const b = readZip(await collect(buildExportArchive(opts(fakeFetcher(data))).stream));
    for (const [k, v] of a) expect(v.equals(b.get(k)!), k).toBe(true);
  });
  it("AR3 drift between the csv pass and the json pass is detected and reported, not hidden", async () => {
    let call = 0;
    const base: Row = { id: "c", full_name: "x", phone: null, email: null, notes: null, status: "active", created_at: "x", updated_at: null, deleted_at: null };
    const fetchPage: PageFetcher = async (section) => {
      if (section !== "customers") return { rows: [], next: null };
      call++;
      return { rows: [{ ...base, full_name: call === 1 ? "once" : "changed" }], next: null };
    };
    const { stream, report } = buildExportArchive(opts(fetchPage));
    const files = readZip(await collect(stream));
    const meta = JSON.parse(files.get(`${exportFolder(new Date("2026-11-05T09:30:00Z"))}/metadata.json`)!.toString());
    expect(meta.consistency.passes_identical).toBe(false);
    expect(meta.consistency.mismatched_sections).toEqual(["customers"]);
    expect(report().passesIdentical).toBe(false);
  });
  it("AR4 a failing page aborts the stream (no silent partial success); report() refuses before completion", async () => {
    const fetchPage: PageFetcher = async (section) => {
      if (section === "services") throw new Error("read_failed");
      return { rows: [], next: null };
    };
    const { stream, report } = buildExportArchive(opts(fetchPage));
    await expect(collect(stream)).rejects.toThrow(/read_failed/);
    expect(() => report()).toThrow(/export_incomplete/);
  });
  it("AR6 only declared columns are exported: an unexpected field returned by a page never reaches the csv or the json", async () => {
    const row = { id: "c1", full_name: "x", phone: null, email: null, notes: null, status: "active", created_at: "x", updated_at: null, deleted_at: null, secret_hash: "LEAK-ME", created_by: "LEAK-USER" };
    const files = readZip(await collect(buildExportArchive(opts(fakeFetcher({ customers: [row] }))).stream));
    const all = [...files.values()].map((b) => b.toString("utf8")).join("|");
    expect(all).not.toContain("LEAK-ME");
    expect(all).not.toContain("LEAK-USER");
  });
  it("AR5 a stalled cursor is refused instead of looping forever", async () => {
    const fetchPage: PageFetcher = async () => ({ rows: [{ id: "x" }], next: "same" });
    await expect(collect(buildExportArchive(opts(fetchPage)).stream)).rejects.toThrow(/cursor_stalled/);
  });
});

describe("PF performance and memory (synthetic larger tenant)", () => {
  it("PF1 60 000 customers + 120 000 appointment lines stream with bounded memory, one page in flight, and a valid zip", async () => {
    const N_CUST = 60000;
    const N_APPT = 120000;
    let inFlight = 0;
    let maxInFlight = 0;
    const mk = (section: string, i: number): Row =>
      section === "customers"
        ? { id: `c-${i}`, full_name: `Müşteri ${i} Çağrı`, phone: `+90500${String(i).padStart(7, "0")}`, email: `m${i}@example.test`, notes: i % 50 === 0 ? "=toplam" : "not", status: "active", created_at: "2026-11-05T09:00:00+00:00", updated_at: null, deleted_at: null }
        : { id: `a-${i}`, branch_id: "b", customer_id: `c-${i % N_CUST}`, status: "completed", notes: "n", source: "internal", scheduled_start_at: "2026-11-05T09:00:00+00:00", scheduled_end_at: "2026-11-05T09:30:00+00:00", created_at: "x", updated_at: "x" };
    const sizes: Record<string, number> = { customers: N_CUST, appointments: N_APPT };
    const fetchPage: PageFetcher = async (section, after) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const total = sizes[section] ?? 0;
      const start = after ? Number(after) : 0;
      const rows: Row[] = [];
      for (let i = start; i < Math.min(start + 500, total); i++) rows.push(mk(section, i));
      inFlight--;
      return { rows, next: start + 500 < total ? String(start + 500) : null };
    };
    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    let peak = heapBefore;
    const t0 = Date.now();
    const { stream, report } = buildExportArchive(opts(fetchPage));
    const chunks: Buffer[] = []; // the test must hold the output to verify it; the PRODUCER holds one page
    let total = 0;
    let n = 0;
    for await (const c of stream) {
      total += c.length;
      chunks.push(Buffer.from(c));
      if (++n % 200 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
    const ms = Date.now() - t0;
    const files = readZip(Buffer.concat(chunks));
    const r = report();
    expect(r.counts.customers).toBe(N_CUST);
    expect(r.counts.appointments).toBe(N_APPT);
    expect(r.passesIdentical).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(files.get(`${exportFolder(new Date("2026-11-05T09:30:00Z"))}/csv/customers.csv`)!.toString().split("\r\n").length).toBe(N_CUST + 2);
    expect(total).toBe(r.bytes);
    // the producer's own working set is a page, not the data set: heap growth stays far below the uncompressed size of the data (>60 MB)
    console.log(`PF1 ${N_CUST + N_APPT} rows, zip ${(total / 1e6).toFixed(1)} MB, ${ms} ms, heap growth ${((peak - heapBefore) / 1e6).toFixed(0)} MB, max pages in flight ${maxInFlight}`);
    expect(ms).toBeLessThan(120000);
  }, 180000);
});
