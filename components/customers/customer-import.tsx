"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { commitCustomerImportAction, previewCustomerImportAction } from "@/lib/modules/customers/import-actions";
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  buildImportRows,
  detectColumns,
  parseCsv,
  type ColumnMapping,
  type ImportRow,
} from "@/lib/modules/customers/import-csv";
import { IMPORT_REASON_TR, type ImportCommit, type ImportPreview } from "@/lib/modules/customers/import-model";

const BUILD_ERRORS: Record<string, string> = {
  empty: "Dosyada aktarılacak satır yok.",
  too_many_rows: `Dosyada ${MAX_IMPORT_ROWS} satırdan fazla var. Lütfen dosyayı bölün.`,
  no_name_column: "Ad soyad sütununu seçin.",
  no_contact_column: "Telefon veya e-posta sütunu seçin.",
};

const STATUS_TR: Record<string, string> = {
  NEW: "Yeni",
  MATCH_EXISTING: "Kayıtlı müşteri",
  INVALID: "Hatalı",
  AMBIGUOUS: "Belirsiz",
};

/**
 * Faz CUST.1A — the Owner's customer import: choose a CSV, check the column mapping, PREVIEW (nothing is written), review
 * the problems with their row numbers, then import. The file is read in the browser and never uploaded as a file; the
 * parsed rows are sent for classification and discarded.
 */
export function CustomerImport({ tenantId, tenantSlug }: { tenantId: string; tenantSlug: string }) {
  const [table, setTable] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({ name: null, phone: null, email: null });
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportCommit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const headers = table?.[0] ?? [];

  function reset() {
    setTable(null);
    setRows(null);
    setPreview(null);
    setResult(null);
    setError(null);
  }

  async function onFile(file: File | undefined) {
    reset();
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setError("Dosya çok büyük (en fazla 2 MB). Lütfen dosyayı bölün.");
      return;
    }
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      setError("Dosya boş ya da okunamadı. CSV (virgül veya noktalı virgülle ayrılmış) olmalı.");
      return;
    }
    setTable(parsed);
    setMapping(detectColumns(parsed[0] ?? []));
  }

  function runPreview() {
    setError(null);
    setPreview(null);
    setResult(null);
    const built = buildImportRows(table ?? [], mapping);
    if (!built.ok) {
      setError(BUILD_ERRORS[built.error] ?? "Dosya okunamadı.");
      return;
    }
    setRows(built.rows);
    startTransition(async () => {
      const res = await previewCustomerImportAction(null, { tenantId, tenantSlug, rows: built.rows });
      if (!res.success) setError(res.error.message);
      else setPreview(res.data);
    });
  }

  function runCommit() {
    if (!rows) return;
    setError(null);
    startTransition(async () => {
      const res = await commitCustomerImportAction(null, { tenantId, tenantSlug, rows });
      if (!res.success) setError(res.error.message);
      else {
        setResult(res.data);
        setPreview(null);
        setTable(null);
        setRows(null); // the uploaded rows are dropped as soon as the import is done
      }
    });
  }

  const select = (key: keyof ColumnMapping, label: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`map-${key}`}>{label}</Label>
      <select
        id={`map-${key}`}
        className="border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm"
        value={mapping[key] ?? ""}
        onChange={(e) => {
          setPreview(null);
          setMapping((m) => ({ ...m, [key]: e.target.value === "" ? null : Number(e.target.value) }));
        }}
      >
        <option value="">— yok —</option>
        {headers.map((h, i) => (
          <option key={i} value={i}>
            {h || `Sütun ${i + 1}`}
          </option>
        ))}
      </select>
    </div>
  );

  const problems = preview?.rows.filter((r) => r.status === "INVALID" || r.status === "AMBIGUOUS") ?? [];
  const importable = preview ? preview.summary.new + preview.summary.willFillPhone + preview.summary.willFillEmail : 0;

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">1. Dosyayı seçin</h2>
        <p className="text-muted-foreground text-sm">
          CSV dosyası (Excel&apos;den &quot;CSV olarak kaydet&quot;). Sütunlar: ad soyad, telefon, e-posta. En fazla {MAX_IMPORT_ROWS} satır. Parolalar, randevu veya ödeme geçmişi aktarılmaz.
          Dosya sunucuya yüklenmez; tarayıcıda okunur ve içe aktarımdan sonra atılır.
        </p>
        <input type="file" accept=".csv,.txt,text/csv" aria-label="CSV dosyası" onChange={(e) => void onFile(e.target.files?.[0])} />
      </section>

      {table ? (
        <section className="flex flex-col gap-3 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">2. Sütunları eşleştirin</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {select("name", "Ad soyad")}
            {select("phone", "Telefon")}
            {select("email", "E-posta")}
          </div>
          <p className="text-muted-foreground text-xs">İlk satır başlık sayılır. {table.length - 1} satır okundu.</p>
          <div>
            <Button type="button" disabled={pending} onClick={runPreview}>
              {pending && !preview ? "Kontrol ediliyor…" : "Önizle (henüz kayıt yapılmaz)"}
            </Button>
          </div>
        </section>
      ) : null}

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {preview ? (
        <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label="Önizleme">
          <h2 className="text-sm font-semibold">3. Önizleme</h2>
          <ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <li><span className="font-semibold tabular-nums">{preview.summary.new}</span> yeni müşteri</li>
            <li><span className="font-semibold tabular-nums">{preview.summary.matchExisting}</span> kayıtlı müşteriyle eşleşti</li>
            <li><span className="font-semibold tabular-nums">{preview.summary.invalid}</span> hatalı satır</li>
            <li><span className="font-semibold tabular-nums">{preview.summary.ambiguous}</span> belirsiz satır</li>
          </ul>
          {preview.summary.willFillPhone + preview.summary.willFillEmail > 0 ? (
            <p className="text-muted-foreground text-xs">
              Eşleşen müşterilerin boş alanları doldurulacak: {preview.summary.willFillPhone} telefon, {preview.summary.willFillEmail} e-posta. Dolu bilgiler değiştirilmez.
            </p>
          ) : null}
          {problems.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-left text-xs">
                    <th scope="col" className="pr-3 font-normal">Satır</th>
                    <th scope="col" className="pr-3 font-normal">Durum</th>
                    <th scope="col" className="font-normal">Neden</th>
                  </tr>
                </thead>
                <tbody>
                  {problems.slice(0, 200).map((p) => (
                    <tr key={p.row} className="border-t">
                      <td className="py-1 pr-3 tabular-nums">{p.row}</td>
                      <td className="pr-3">{STATUS_TR[p.status]}</td>
                      <td>
                        {IMPORT_REASON_TR[p.reason ?? ""] ?? "Kabul edilmedi"}
                        {p.existingName ? ` (${p.existingName})` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {problems.length > 200 ? <p className="text-muted-foreground mt-1 text-xs">İlk 200 satır gösteriliyor.</p> : null}
            </div>
          ) : (
            <p className="text-sm">Hatalı ya da belirsiz satır yok.</p>
          )}
          <p className="text-muted-foreground text-xs">Hatalı ve belirsiz satırlar aktarılmaz; dosyayı düzeltip yeniden deneyebilirsiniz. Aynı dosyayı tekrar aktarmak mükerrer kayıt oluşturmaz.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={pending || importable === 0} onClick={runCommit}>
              {pending ? "Aktarılıyor…" : `İçe aktar (${preview.summary.new} yeni müşteri)`}
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={reset}>
              Vazgeç
            </Button>
          </div>
        </section>
      ) : null}

      {result ? (
        <section className="flex flex-col gap-2 rounded-lg border border-emerald-300/60 p-4" aria-label="Sonuç">
          <h2 className="text-sm font-semibold">Aktarım tamamlandı</h2>
          <ul className="text-sm">
            <li>{result.summary.created} yeni müşteri eklendi</li>
            <li>{result.summary.matchExisting} satır kayıtlı müşteriyle eşleşti (yeni kayıt açılmadı)</li>
            {result.summary.filledPhone + result.summary.filledEmail > 0 ? (
              <li>{result.summary.filledPhone} telefon ve {result.summary.filledEmail} e-posta boş alana eklendi</li>
            ) : null}
            <li>{result.summary.skippedInvalid + result.summary.skippedAmbiguous} satır aktarılmadı</li>
          </ul>
          <div>
            <Button type="button" variant="outline" onClick={reset}>Başka dosya</Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
