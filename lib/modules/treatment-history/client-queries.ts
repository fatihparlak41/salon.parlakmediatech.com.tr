import { createClient } from "@/lib/supabase/client";
import {
  parsePhotoAccess,
  parseRebookDefaults,
  parseTreatmentHistory,
  validatePhotoFile,
  type PhotoKind,
  type RebookDefaults,
  type TreatmentHistory,
} from "./model";

/**
 * Faz BEAUTY.1B - browser-side calls to the treatment-history RPCs and the private bucket. Every call goes through the signed-in
 * user's own session; the database functions and the bucket policies are the authority, this file only orders the steps
 * (register -> upload -> confirm, cleaning up after itself) and words the refusals. There is no public URL anywhere: a photo is
 * shown through a 60-second signed URL created after the database authorised that exact media row.
 */

export const TREATMENT_BUCKET = "treatment-media";
export const SIGNED_URL_SECONDS = 60;

const ERROR_MESSAGES: Record<string, string> = {
  BH001: "Oturum süresi doldu, lütfen tekrar giriş yapın",
  BH002: "Bu işlem için yetkiniz yok",
  BH003: "Kayıt bulunamadı",
  BH004: "Geçersiz dosya veya bilgi",
  BH005: "Bir işleme en fazla 8 fotoğraf eklenebilir",
  BH006: "Fotoğraf yüklenemedi, lütfen tekrar deneyin",
};
const DEFAULT_ERROR = "İşlem gerçekleştirilemedi, lütfen tekrar deneyin";
export function treatmentErrorMessage(code: string | undefined | null): string {
  return (code && ERROR_MESSAGES[code]) || DEFAULT_ERROR;
}

export async function fetchTreatmentHistory(tenantId: string, customerId: string, limit = 50): Promise<TreatmentHistory | null> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_customer_treatment_history", { p_tenant_id: tenantId, p_customer_id: customerId, p_limit: limit });
  if (error) return null;
  return parseTreatmentHistory(data);
}

export async function fetchRebookDefaults(tenantId: string, itemId: string): Promise<{ ok: true; defaults: RebookDefaults } | { ok: false; message: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_treatment_rebook_defaults", { p_tenant_id: tenantId, p_item_id: itemId });
  if (error) return { ok: false, message: error.code === "BH003" ? "Bu hizmet artık sunulmuyor" : treatmentErrorMessage(error.code) };
  const parsed = parseRebookDefaults(data);
  return parsed ? { ok: true, defaults: parsed } : { ok: false, message: DEFAULT_ERROR };
}

export async function saveTreatmentNote(tenantId: string, itemId: string, note: string): Promise<string | null> {
  const supabase = createClient();
  const { error } = await supabase.rpc("set_treatment_note", { p_tenant_id: tenantId, p_item_id: itemId, p_note: note });
  return error ? treatmentErrorMessage(error.code) : null;
}

/** A 60-second signed URL for one photo, or null. The database authorises the exact row first; the bucket policy checks again. */
export async function fetchPhotoUrl(tenantId: string, mediaId: string): Promise<string | null> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_treatment_photo_access", { p_tenant_id: tenantId, p_media_id: mediaId });
  if (error) return null;
  const access = parsePhotoAccess(data);
  if (!access) return null;
  const signed = await supabase.storage.from(TREATMENT_BUCKET).createSignedUrl(access.path, SIGNED_URL_SECONDS);
  return signed.error ? null : signed.data.signedUrl;
}

/** register -> upload -> confirm. On any failure after registration the half-made photo is removed again. */
export async function uploadTreatmentPhoto(args: { tenantId: string; itemId: string; kind: PhotoKind; file: Blob }): Promise<{ ok: true } | { ok: false; message: string }> {
  const refusal = validatePhotoFile(args.file);
  if (refusal) return { ok: false, message: refusal };
  const supabase = createClient();
  const reg = await supabase.rpc("register_treatment_photo", { p_tenant_id: args.tenantId, p_item_id: args.itemId, p_kind: args.kind, p_mime: args.file.type, p_size: args.file.size });
  if (reg.error || !reg.data) return { ok: false, message: treatmentErrorMessage(reg.error?.code) };
  const { mediaId, path } = reg.data as unknown as { mediaId: string; path: string };

  const undo = async () => {
    await supabase.rpc("delete_treatment_photo", { p_tenant_id: args.tenantId, p_media_id: mediaId });
    await supabase.storage.from(TREATMENT_BUCKET).remove([path]);
  };

  const up = await supabase.storage.from(TREATMENT_BUCKET).upload(path, args.file, { contentType: args.file.type, upsert: false });
  if (up.error) {
    await undo();
    return { ok: false, message: treatmentErrorMessage("BH006") };
  }
  const done = await supabase.rpc("confirm_treatment_photo", { p_tenant_id: args.tenantId, p_media_id: mediaId });
  if (done.error) {
    await undo();
    return { ok: false, message: treatmentErrorMessage(done.error.code) };
  }
  return { ok: true };
}

/** The database row goes first (the photo is unavailable at once); the stored object is then removed on a best-effort basis. */
export async function deleteTreatmentPhoto(tenantId: string, mediaId: string): Promise<string | null> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("delete_treatment_photo", { p_tenant_id: tenantId, p_media_id: mediaId });
  if (error) return treatmentErrorMessage(error.code);
  const path = (data as unknown as { path?: string } | null)?.path;
  if (path) await supabase.storage.from(TREATMENT_BUCKET).remove([path]);
  return null;
}
