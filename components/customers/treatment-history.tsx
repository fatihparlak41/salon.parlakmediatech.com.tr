"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Repeat, Trash2 } from "lucide-react";
import { useRouter } from "@/lib/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteTreatmentPhoto,
  fetchPhotoUrl,
  fetchRebookDefaults,
  fetchTreatmentHistory,
  saveTreatmentNote,
  uploadTreatmentPhoto,
} from "@/lib/modules/treatment-history/client-queries";
import { prepareTreatmentImage } from "@/lib/modules/treatment-history/prepare-image";
import {
  NOTE_MAX_LENGTH,
  PHOTO_KINDS,
  PHOTO_KIND_LABEL,
  rebookHref,
  rebookText,
  type PhotoKind,
  type TreatmentHistory,
  type TreatmentItem,
  type TreatmentMedia,
} from "@/lib/modules/treatment-history/model";

/**
 * Faz BEAUTY.1B - the customer's treatment history: one card per completed treatment (date, service, the person who performed it,
 * the value where the viewer may see it), a short operational note, before/after photos, and the recommended re-booking window
 * with a quick "Tekrar Randevu" action. Photos are internal documentation shown through short-lived signed links, never public.
 */

const dateTr = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const money = (v: string) => `${Number(v).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;

function Photo({ tenantId, media, canWrite, onDeleted }: { tenantId: string; media: TreatmentMedia; canWrite: boolean; onDeleted: () => void }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchPhotoUrl(tenantId, media.id).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [tenantId, media.id]);
  return (
    <figure className="flex w-24 flex-col gap-1" data-testid="treatment-photo">
      <div className="bg-muted flex h-24 w-24 items-center justify-center overflow-hidden rounded-lg border">
        {url === undefined ? <Skeleton className="h-full w-full" /> : url ? (
          // eslint-disable-next-line @next/next/no-img-element -- a 60-second signed URL of a private object; next/image would proxy and cache it
          <img src={url} alt={`Tedavi fotoğrafı (${PHOTO_KIND_LABEL[media.kind].toLowerCase()})`} referrerPolicy="no-referrer" className="h-full w-full object-cover" />
        ) : (
          <span className="text-muted-foreground px-1 text-center text-[10px]">Gösterilemedi</span>
        )}
      </div>
      <figcaption className="flex items-center justify-between text-xs">
        <Badge variant="secondary">{PHOTO_KIND_LABEL[media.kind]}</Badge>
        {canWrite && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Fotoğrafı sil"
            onClick={async () => {
              if (!window.confirm("Bu fotoğraf kalıcı olarak silinsin mi?")) return;
              const err = await deleteTreatmentPhoto(tenantId, media.id);
              if (err) setError(err);
              else onDeleted();
            }}
          >
            <Trash2 />
          </Button>
        )}
      </figcaption>
      {error && <p className="text-destructive text-xs" role="alert">{error}</p>}
    </figure>
  );
}

function PhotoUploader({ tenantId, itemId, onUploaded }: { tenantId: string; itemId: string; onUploaded: () => void }) {
  const [kind, setKind] = useState<PhotoKind>("before");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const prepared = await prepareTreatmentImage(file);
    if (!prepared.ok) {
      setBusy(false);
      setError(prepared.message);
      return;
    }
    const result = await uploadTreatmentPhoto({ tenantId, itemId, kind, file: prepared.blob });
    setBusy(false);
    if (input.current) input.current.value = "";
    if (!result.ok) setError(result.message);
    else onUploaded();
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Fotoğraf türü"
          className="border-input bg-background h-8 rounded-lg border px-2 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as PhotoKind)}
          disabled={busy}
        >
          {PHOTO_KINDS.map((k) => (
            <option key={k} value={k}>{PHOTO_KIND_LABEL[k]}</option>
          ))}
        </select>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
          <ImagePlus /> {busy ? "Yükleniyor…" : "Fotoğraf ekle"}
        </Button>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/*" className="hidden" data-testid="photo-input" onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>
      {error && <p className="text-destructive text-xs" role="alert">{error}</p>}
    </div>
  );
}

function NoteEditor({ tenantId, item, onSaved }: { tenantId: string; item: TreatmentItem; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm">{item.note ?? <span className="text-muted-foreground">Not yok</span>}</p>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>{item.note ? "Düzenle" : "Not ekle"}</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea aria-label="Uygulama notu" value={text} onChange={(e) => setText(e.target.value)} maxLength={NOTE_MAX_LENGTH} rows={2} />
      <p className="text-muted-foreground text-xs">Kısa ve operasyonel tutun (ör. ton kodu, uygulanan teknik). Teşhis veya sağlık bilgisi yazmayın.</p>
      {error && <p className="text-destructive text-xs" role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const err = await saveTreatmentNote(tenantId, item.itemId, text);
            setBusy(false);
            if (err) setError(err);
            else {
              setEditing(false);
              onSaved();
            }
          }}
        >
          Kaydet
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Vazgeç</Button>
      </div>
    </div>
  );
}

function TreatmentCard({ tenantId, tenantSlug, item, today, canWrite, canRebook, onChanged }: { tenantId: string; tenantSlug: string; item: TreatmentItem; today: string; canWrite: boolean; canRebook: boolean; onChanged: () => void }) {
  const router = useRouter();
  const [rebookError, setRebookError] = useState<string | null>(null);
  const hint = item.rebook ? rebookText(item.rebook, today) : null;
  return (
    <li className="flex flex-col gap-3 rounded-xl border p-3" data-testid="treatment-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">{item.serviceName}</p>
          <p className="text-muted-foreground text-xs">
            {dateTr(item.date)}
            {item.staffName ? ` · ${item.staffName}` : ""}
          </p>
        </div>
        {item.value !== null && <span className="text-sm font-medium tabular-nums">{money(item.value)}</span>}
      </div>

      {canWrite ? <NoteEditor key={item.note ?? ""} tenantId={tenantId} item={item} onSaved={onChanged} /> : item.note ? <p className="text-sm">{item.note}</p> : null}

      {(item.media.length > 0 || canWrite) && (
        <div className="flex flex-col gap-2">
          {item.media.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {item.media.map((m) => (
                <Photo key={m.id} tenantId={tenantId} media={m} canWrite={canWrite} onDeleted={onChanged} />
              ))}
            </div>
          )}
          {canWrite && <PhotoUploader tenantId={tenantId} itemId={item.itemId} onUploaded={onChanged} />}
        </div>
      )}

      {(hint || canRebook) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <div className="text-xs" data-testid="rebook-hint">
            {hint && (
              <>
                <p className={hint.tone === "due" ? "font-medium text-emerald-700 dark:text-emerald-400" : hint.tone === "late" ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>{hint.headline}</p>
                {hint.detail && <p className="text-muted-foreground">{hint.detail}</p>}
              </>
            )}
          </div>
          {canRebook && (
            <div className="flex flex-col items-end gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  setRebookError(null);
                  const r = await fetchRebookDefaults(tenantId, item.itemId);
                  if (!r.ok) setRebookError(r.message);
                  else router.push(rebookHref(tenantSlug, r.defaults));
                }}
              >
                <Repeat /> Tekrar Randevu
              </Button>
              {rebookError && <p className="text-destructive text-xs" role="alert">{rebookError}</p>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function TreatmentHistoryPanel({ tenantId, tenantSlug, customerId, canWrite, canRebook }: { tenantId: string; tenantSlug: string; customerId: string; canWrite: boolean; canRebook: boolean }) {
  const [history, setHistory] = useState<TreatmentHistory | null | undefined>(undefined);
  const load = useCallback(async () => setHistory(await fetchTreatmentHistory(tenantId, customerId)), [tenantId, customerId]);
  useEffect(() => {
    let live = true;
    fetchTreatmentHistory(tenantId, customerId).then((h) => live && setHistory(h));
    return () => {
      live = false;
    };
  }, [tenantId, customerId]);

  if (history === undefined) return <Skeleton className="h-32 w-full" />;
  if (history === null) return <p className="text-destructive text-sm" role="alert">Geçmiş şu an okunamadı. Sayfayı yenileyip tekrar deneyin.</p>;
  if (history.items.length === 0) {
    return <p className="text-muted-foreground rounded-xl border border-dashed px-6 py-10 text-center text-sm">Henüz tamamlanmış bir işlem yok.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {history.items.map((item) => (
          <TreatmentCard key={item.itemId} tenantId={tenantId} tenantSlug={tenantSlug} item={item} today={history.today} canWrite={canWrite} canRebook={canRebook} onChanged={load} />
        ))}
      </ul>
      {history.hasMore && <p className="text-muted-foreground text-center text-xs">Daha eski işlemler gösterilmiyor.</p>}
      <p className="text-muted-foreground text-xs">Fotoğraflar yalnızca salon içi kayıt içindir; paylaşım veya pazarlama izni anlamına gelmez.</p>
    </div>
  );
}
