import { createHash } from "node:crypto";
import { CSV_BOM, canonicalStringify, csvHeader, csvRecord } from "./csv";
import { EXCLUDED_DATA, EXPORT_VERSION, SECTIONS, type ExportSection } from "./sections";
import { zipStream, type ZipEntry } from "./zip";

/**
 * Faz SAAS.1C.2b - assembles the export archive as a STREAM. The only thing held in memory is one page of rows (<= PAGE_SIZE) plus the running
 * counters. Layout (every entry under one folder):
 *   csv/<section>.csv ...           one CSV per section (";" delimiter, UTF-8 BOM, formula-safe text)
 *   salonos-export.json             the canonical JSON export (sorted keys) - the source of truth
 *   metadata.json                   written LAST: version, snapshot time, counts, and the two-pass consistency check
 * The data is read twice from the same snapshot fence (once for the CSVs, once for the JSON). A per-section digest of both passes is compared and
 * recorded; a difference means a row was edited during the export and the metadata says so instead of hiding it.
 */

export const PAGE_SIZE = 500;
const MAX_PAGES_PER_SECTION = 100000;

export type Row = Record<string, unknown>;
export type Page = { rows: Row[]; next: string | null };
export type PageFetcher = (section: string, after: string | null) => Promise<Page>;

export class ExportReadError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export type ExportReport = {
  counts: Record<string, number>;
  bytes: number;
  passesIdentical: boolean;
  mismatchedSections: string[];
};

export function exportFolder(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `salonos-export-${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
}

async function* pages(fetchPage: PageFetcher, key: string): AsyncGenerator<Row[]> {
  let after: string | null = null;
  for (let i = 0; i < MAX_PAGES_PER_SECTION; i++) {
    const page = await fetchPage(key, after);
    if (page.rows.length > 0) yield page.rows;
    if (!page.next) return;
    if (page.next === after) throw new ExportReadError("cursor_stalled");
    after = page.next;
  }
  throw new ExportReadError("too_many_pages");
}

const enc = (s: string) => Buffer.from(s, "utf8");

export type ArchiveOptions = {
  fetchPage: PageFetcher;
  now: Date;
  snapshotAt: string;
  tenantTimezone: string | null;
  tenantCurrency: string | null;
};

/** Returns the byte stream and a `report()` that is valid once the stream has been fully consumed. */
export function buildExportArchive(opts: ArchiveOptions): { stream: AsyncGenerator<Uint8Array>; report: () => ExportReport } {
  const folder = exportFolder(opts.now);
  const counts: Record<string, number> = {};
  const digestA: Record<string, string> = {};
  const digestB: Record<string, string> = {};
  let bytes = 0;
  let finished = false;
  let identical = true;
  let mismatched: string[] = [];

  async function* csvData(section: ExportSection): AsyncGenerator<Uint8Array> {
    const hash = createHash("sha256");
    let n = 0;
    yield enc(CSV_BOM + csvHeader(section.columns));
    for await (const rows of pages(opts.fetchPage, section.key)) {
      let chunk = "";
      for (const r of rows) {
        chunk += csvRecord(section.columns, r);
        hash.update(canonicalStringify(project(section, r)) + "\n");
        n++;
      }
      yield enc(chunk);
    }
    counts[section.key] = n;
    digestA[section.key] = hash.digest("hex");
  }

  async function* jsonData(): AsyncGenerator<Uint8Array> {
    yield enc(`{"export_version":${EXPORT_VERSION},"generated_at":${JSON.stringify(opts.now.toISOString())},"snapshot_at":${JSON.stringify(opts.snapshotAt)},"sections":{`);
    let firstSection = true;
    for (const section of SECTIONS) {
      const hash = createHash("sha256");
      yield enc((firstSection ? "" : ",") + JSON.stringify(section.key) + ":[");
      firstSection = false;
      let first = true;
      for await (const rows of pages(opts.fetchPage, section.key)) {
        let chunk = "";
        for (const r of rows) {
          const line = canonicalStringify(project(section, r));
          chunk += (first ? "" : ",") + line;
          first = false;
          hash.update(line + "\n");
        }
        yield enc(chunk);
      }
      digestB[section.key] = hash.digest("hex");
      yield enc("]");
    }
    yield enc("}}\n");
  }

  function metadata(): string {
    mismatched = SECTIONS.filter((s) => digestA[s.key] !== digestB[s.key]).map((s) => s.key);
    identical = mismatched.length === 0;
    return (
      canonicalStringify({
        export_version: EXPORT_VERSION,
        generated_at: opts.now.toISOString(),
        snapshot_at: opts.snapshotAt,
        tenant_timezone: opts.tenantTimezone,
        tenant_currency: opts.tenantCurrency,
        entity_counts: counts,
        files: [...SECTIONS.map((s) => `csv/${s.key}.csv`), "salonos-export.json", "metadata.json"],
        format: {
          csv: { delimiter: ";", encoding: "UTF-8 with BOM", line_ending: "CRLF", formula_guard: "text cells starting with = + - @ TAB CR LF are prefixed with a single quote" },
          json: { key_order: "sorted", null_handling: "null" },
          timestamps: "ISO 8601 as stored (UTC)",
          money: "decimal numbers with a dot; currency is in the tenant_currency field and the currency columns",
        },
        consistency: {
          model: "rows created after snapshot_at are excluded; CSV pass and JSON pass compared by per-section digest",
          passes_identical: identical,
          mismatched_sections: mismatched,
          section_digests_csv_pass: digestA,
          section_digests_json_pass: digestB,
        },
        excluded_data: EXCLUDED_DATA,
      }) + "\n"
    );
  }

  async function* entries(): AsyncGenerator<ZipEntry> {
    for (const section of SECTIONS) yield { name: `${folder}/csv/${section.key}.csv`, data: csvData(section) };
    yield { name: `${folder}/salonos-export.json`, data: jsonData() };
    yield { name: `${folder}/metadata.json`, data: [enc(metadata())] };
  }

  async function* stream(): AsyncGenerator<Uint8Array> {
    for await (const chunk of zipStream(entries(), opts.now)) {
      bytes += chunk.length;
      yield chunk;
    }
    finished = true;
  }

  return {
    stream: stream(),
    report: () => {
      if (!finished) throw new ExportReadError("export_incomplete");
      return { counts, bytes, passesIdentical: identical, mismatchedSections: mismatched };
    },
  };
}

function project(section: ExportSection, row: Row): Row {
  const o: Row = {};
  for (const c of section.columns) o[c] = row[c] ?? null;
  return o;
}
