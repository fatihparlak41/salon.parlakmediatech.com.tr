/**
 * Faz BEAUTY.1B - the pure rules (parsers, wording, image rules, quick-rebook links), the upload / delete orchestration with a
 * recording fake Supabase client, and the service re-booking-window action rules. No database. All identities and figures are
 * synthetic; the 4-8 week example is the business's supplied recommendation, configured per service, never built into logic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { op: string; args: unknown[] };
const calls: Call[] = [];
let rpcResults: Record<string, { data?: unknown; error?: { code?: string; message: string } | null }> = {};
let uploadResult: { error: { message: string } | null } = { error: null };
let signResult: { data: { signedUrl: string } | null; error: { message: string } | null } = { data: { signedUrl: "https://signed.example/x?token=t" }, error: null };

const fake = {
  rpc: async (name: string, args: unknown) => {
    calls.push({ op: `rpc:${name}`, args: [args] });
    return rpcResults[name] ?? { data: null, error: null };
  },
  storage: {
    from: (bucket: string) => ({
      upload: async (path: string, file: unknown, opts: unknown) => {
        calls.push({ op: "upload", args: [bucket, path, file, opts] });
        return uploadResult;
      },
      remove: async (paths: string[]) => {
        calls.push({ op: "remove", args: [bucket, paths] });
        return { error: null };
      },
      createSignedUrl: async (path: string, seconds: number) => {
        calls.push({ op: "sign", args: [bucket, path, seconds] });
        return signResult;
      },
    }),
  },
};
vi.mock("@/lib/supabase/client", () => ({ createClient: () => fake }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }) }), update: () => ({ eq: async () => ({ error: null }) }) }) })) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => ({ id: "u" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  ALLOWED_PHOTO_MIME, MAX_PHOTO_BYTES, intervalText, parsePhotoAccess, parseRebookDefaults, parseRebookParams, parseTreatmentHistory,
  rebookHref, rebookText, validatePhotoFile,
} from "@/lib/modules/treatment-history/model";
import { deleteTreatmentPhoto, fetchPhotoUrl, fetchRebookDefaults, treatmentErrorMessage, uploadTreatmentPhoto } from "@/lib/modules/treatment-history/client-queries";
import { MAX_LONG_EDGE, prepareTreatmentImage, scaledSize, type ImageEnv } from "@/lib/modules/treatment-history/prepare-image";
import { rebookColumns, rebookDaysFromText, validateRebook } from "@/lib/modules/services/rebook";
import { createServiceAction, updateServiceProfileAction } from "@/lib/modules/services/actions";

const T = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const M = "33333333-3333-4333-8333-333333333333";
const file = (type: string, size: number) => ({ type, size }) as Blob;

beforeEach(() => {
  calls.length = 0;
  rpcResults = {};
  uploadResult = { error: null };
  signResult = { data: { signedUrl: "https://signed.example/x?token=t" }, error: null };
});

describe("image rules", () => {
  it("image-only allow-list, a size ceiling of exactly 2 MiB, no empty files", () => {
    expect([...ALLOWED_PHOTO_MIME]).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(MAX_PHOTO_BYTES).toBe(2 * 1024 * 1024);
    for (const t of ALLOWED_PHOTO_MIME) expect(validatePhotoFile(file(t, 1)), t).toBeNull();
    expect(validatePhotoFile(file("image/jpeg", MAX_PHOTO_BYTES))).toBeNull();
    expect(validatePhotoFile(file("image/jpeg", MAX_PHOTO_BYTES + 1))).not.toBeNull();
    expect(validatePhotoFile(file("image/jpeg", 0))).not.toBeNull();
    for (const t of ["application/pdf", "image/gif", "image/heic", "image/svg+xml", "text/html", ""]) expect(validatePhotoFile(file(t, 100)), t).not.toBeNull();
  });

  it("scaling keeps the aspect ratio and never enlarges", () => {
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(scaledSize(MAX_LONG_EDGE, 900)).toEqual({ width: MAX_LONG_EDGE, height: 900 });
    expect(scaledSize(3200, 2400)).toEqual({ width: 1600, height: 1200 });
    expect(scaledSize(2400, 3200)).toEqual({ width: 1200, height: 1600 });
    expect(scaledSize(100000, 1)).toEqual({ width: 1600, height: 1 });
  });

  it("the prepared photo is a fresh JPEG at the scaled size; an undecodable or oversize result is refused", async () => {
    let drawn: [number, number] | null = null;
    const env = (blob: Blob | null, size = { width: 4000, height: 3000 }): ImageEnv => ({
      decode: async () => ({ ...size, draw: async (w, h) => { drawn = [w, h]; return blob; } }),
    });
    const ok = await prepareTreatmentImage(file("image/png", 9_000_000), env(new Blob(["x".repeat(500)], { type: "image/webp" })));
    expect(ok.ok && ok.blob.type).toBe("image/jpeg");
    expect(drawn).toEqual([1600, 1200]);
    expect((await prepareTreatmentImage(file("image/heic", 5), { decode: async () => { throw new Error("no decoder"); } })).ok).toBe(false);
    expect((await prepareTreatmentImage(file("image/jpeg", 5), env(null))).ok).toBe(false);
    expect((await prepareTreatmentImage(file("image/jpeg", 5), env(new Blob([]), { width: 10, height: 10 }))).ok).toBe(false);
    expect((await prepareTreatmentImage(file("image/jpeg", 5), env(new Blob([new Uint8Array(MAX_PHOTO_BYTES + 1)])))).ok).toBe(false);
  });
});

describe("answer parsers (strict)", () => {
  const item = (o: Record<string, unknown> = {}) => ({ itemId: I, appointmentId: M, date: "2026-10-10", serviceId: T, serviceName: "Kaş Laminasyonu", staffName: "Emel Kaynakkan", value: "2000.00", note: null, media: [], rebook: null, ...o });
  const hist = (o: Record<string, unknown> = {}, items = [item()]) => ({ today: "2026-10-26", timezone: "Europe/Nicosia", canSeeValue: true, hasMore: false, items, ...o });

  it("accepts a well-formed history and keeps only the fields it knows", () => {
    const h = parseTreatmentHistory(hist({}, [item({ extra: "x", media: [{ id: T, kind: "before", createdAt: "2026-10-10T10:00:00Z", path: "leak" }], rebook: { minDays: 28, maxDays: 56, windowStart: "2026-11-07", windowEnd: "2026-12-05", state: "not_due" } })]))!;
    expect(h.items[0]).not.toHaveProperty("extra");
    expect(h.items[0]!.media[0]).toEqual({ id: T, kind: "before", createdAt: "2026-10-10T10:00:00Z" });
    expect(h.items[0]!.rebook).toMatchObject({ minDays: 28, state: "not_due" });
  });

  it("refuses malformed answers, an unknown photo kind or rebook state, an inverted window, and a price shown to someone who may not see prices", () => {
    for (const bad of [null, "x", [], {}, hist({ items: "no" }), hist({ canSeeValue: "yes" }), hist({}, [item({ media: [{ id: T, kind: "selfie", createdAt: "x" }] })]),
      hist({}, [item({ rebook: { minDays: 28, maxDays: 56, windowStart: "a", windowEnd: "b", state: "soon" } })]),
      hist({}, [item({ rebook: { minDays: 56, maxDays: 28, windowStart: "a", windowEnd: "b", state: "due" } })]),
      hist({}, [item({ serviceName: null })]),
      hist({ canSeeValue: false }, [item({ value: "2000.00" })])]) {
      expect(parseTreatmentHistory(bad), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
    expect(parseTreatmentHistory(hist({ canSeeValue: false }, [item({ value: null })]))).not.toBeNull();
  });

  it("a history row without the staff-name field, and rebook defaults without the branch field, are refused (a missing field is not the same as null)", () => {
    const row = { itemId: I, appointmentId: M, date: "2026-10-10", serviceId: T, serviceName: "A", value: null, note: null, media: [], rebook: null };
    expect(parseTreatmentHistory({ today: "2026-10-26", timezone: "Europe/Nicosia", canSeeValue: false, hasMore: false, items: [row] })).toBeNull();
    expect(parseTreatmentHistory({ today: "2026-10-26", timezone: "Europe/Nicosia", canSeeValue: false, hasMore: false, items: [{ ...row, staffName: null }] })).not.toBeNull();
    expect(parseRebookDefaults({ serviceId: T, serviceName: "A", staffId: null })).toBeNull();
  });

  it("rebook defaults and photo access: required fields only; access refuses a non-image type", () => {
    expect(parseRebookDefaults({ serviceId: T, serviceName: "A", branchId: null, staffId: null, junk: 1 })).toEqual({ serviceId: T, serviceName: "A", branchId: null, staffId: null });
    expect(parseRebookDefaults({ serviceId: T })).toBeNull();
    expect(parsePhotoAccess({ path: "a/b.jpg", mime: "image/jpeg", kind: "before" })).toEqual({ path: "a/b.jpg", mime: "image/jpeg" });
    expect(parsePhotoAccess({ path: "a/b.html", mime: "text/html" })).toBeNull();
    expect(parsePhotoAccess({ path: "", mime: "image/png" })).toBeNull();
  });
});

describe("wording: no health claim, no guarantee; intervals from the data", () => {
  it("28–56 days reads as 4–8 weeks, other bounds in days, one bound as a single span", () => {
    expect(intervalText(28, 56)).toBe("4–8 hafta");
    expect(intervalText(21, 35)).toBe("3–5 hafta");
    expect(intervalText(30, 45)).toBe("30–45 gün");
    expect(intervalText(28, 45)).toBe("28–45 gün"); // only the minimum is a whole number of weeks
    expect(intervalText(30, 56)).toBe("30–56 gün");
    expect(intervalText(14, 14)).toBe("2 hafta");
    expect(intervalText(10, null)).toBe("10 gün");
  });

  it("each state has its own headline; 'approaching' only inside the last 7 days before the window", () => {
    const w = (state: "booked" | "not_due" | "due" | "overdue", windowStart = "2026-11-07") => rebookText({ minDays: 28, maxDays: 56, windowStart, windowEnd: "2026-12-05", state }, "2026-10-26");
    expect(w("due")).toMatchObject({ headline: "Tekrar randevu zamanı", detail: "Önerilen tekrar dönemi: 4–8 hafta", tone: "due" });
    expect(w("overdue")).toMatchObject({ headline: "Önerilen dönem geçti", tone: "late" });
    expect(w("booked")).toMatchObject({ headline: "Tekrar randevu planlandı", tone: "done" });
    expect(w("not_due", "2026-11-02")).toMatchObject({ headline: "Tekrar randevu zamanı yaklaşıyor", tone: "info" });
    expect(w("not_due", "2026-11-03").headline).toBe("Önerilen tekrar dönemi: 4–8 hafta"); // 8 days ahead: not yet "approaching"
    expect(w("not_due", "2026-10-27").headline).toBe("Tekrar randevu zamanı yaklaşıyor");
    expect(w("not_due", "2026-11-07")).toMatchObject({ headline: "Önerilen tekrar dönemi: 4–8 hafta", tone: "info" });
    const all = JSON.stringify([w("due"), w("overdue"), w("booked"), w("not_due")]).toLowerCase();
    for (const word of ["garanti", "tedavi", "teşhis", "sağlık", "etki"]) expect(all, word).not.toContain(word);
  });

  it("the quick-rebook link carries ids only, and the receiving side keeps only well-formed ones", () => {
    const href = rebookHref("ornek", { serviceId: T, serviceName: "Kaş Laminasyonu", branchId: I, staffId: M });
    expect(href).toBe(`/app/ornek/appointments?rebookService=${T}&rebookBranch=${I}&rebookStaff=${M}`);
    expect(href).not.toContain("Ka");
    expect(rebookHref("ornek", { serviceId: T, serviceName: "x", branchId: null, staffId: null })).toBe(`/app/ornek/appointments?rebookService=${T}`);
    expect(parseRebookParams({ rebookService: T, rebookBranch: I, rebookStaff: M })).toEqual({ serviceId: T, branchId: I, staffId: M });
    expect(parseRebookParams({ rebookService: T, rebookBranch: "x", rebookStaff: ["a"] })).toEqual({ serviceId: T, branchId: undefined, staffId: undefined });
    expect(parseRebookParams({ rebookService: "javascript:1" })).toBeNull();
    expect(parseRebookParams({})).toBeNull();
    expect(parseRebookParams({ rebookBranch: I })).toBeNull();
  });
});

describe("upload: register -> upload -> confirm, and it cleans up after itself", () => {
  it("the happy path, in order, with the exact content type and without overwrite", async () => {
    rpcResults.register_treatment_photo = { data: { mediaId: M, path: `${T}/${M}.jpg` } };
    const f = file("image/jpeg", 1234);
    expect(await uploadTreatmentPhoto({ tenantId: T, itemId: I, kind: "before", file: f })).toEqual({ ok: true });
    expect(calls.map((c) => c.op)).toEqual(["rpc:register_treatment_photo", "upload", "rpc:confirm_treatment_photo"]);
    expect(calls[0]!.args[0]).toEqual({ p_tenant_id: T, p_item_id: I, p_kind: "before", p_mime: "image/jpeg", p_size: 1234 });
    expect(calls[1]!.args).toEqual(["treatment-media", `${T}/${M}.jpg`, f, { contentType: "image/jpeg", upsert: false }]);
    expect(calls[2]!.args[0]).toEqual({ p_tenant_id: T, p_media_id: M });
  });

  it("a refused file never reaches the database or the bucket", async () => {
    for (const f of [file("application/pdf", 10), file("image/jpeg", MAX_PHOTO_BYTES + 1), file("image/jpeg", 0)]) {
      expect((await uploadTreatmentPhoto({ tenantId: T, itemId: I, kind: "after", file: f })).ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("a registration refusal is shown in plain words and nothing is uploaded", async () => {
    rpcResults.register_treatment_photo = { data: null, error: { code: "BH005", message: "photo limit reached - internal" } };
    const r = await uploadTreatmentPhoto({ tenantId: T, itemId: I, kind: "other", file: file("image/png", 10) });
    expect(r).toEqual({ ok: false, message: "Bir işleme en fazla 8 fotoğraf eklenebilir" });
    expect(calls.map((c) => c.op)).toEqual(["rpc:register_treatment_photo"]);
  });

  it("an upload failure removes the registration again; a confirm failure removes registration and object", async () => {
    rpcResults.register_treatment_photo = { data: { mediaId: M, path: `${T}/${M}.png` } };
    uploadResult = { error: { message: "storage down" } };
    const a = await uploadTreatmentPhoto({ tenantId: T, itemId: I, kind: "before", file: file("image/png", 10) });
    expect(a.ok).toBe(false);
    expect(JSON.stringify(a)).not.toContain("storage down");
    expect(calls.map((c) => c.op)).toEqual(["rpc:register_treatment_photo", "upload", "rpc:delete_treatment_photo", "remove"]);
    calls.length = 0;
    uploadResult = { error: null };
    rpcResults.confirm_treatment_photo = { data: null, error: { code: "BH006", message: "x" } };
    const b = await uploadTreatmentPhoto({ tenantId: T, itemId: I, kind: "before", file: file("image/png", 10) });
    expect(b).toEqual({ ok: false, message: "Fotoğraf yüklenemedi, lütfen tekrar deneyin" });
    expect(calls.map((c) => c.op)).toEqual(["rpc:register_treatment_photo", "upload", "rpc:confirm_treatment_photo", "rpc:delete_treatment_photo", "remove"]);
  });

  it("delete: the database row first (access ends at once), then the object", async () => {
    rpcResults.delete_treatment_photo = { data: { path: `${T}/${M}.jpg` } };
    expect(await deleteTreatmentPhoto(T, M)).toBeNull();
    expect(calls.map((c) => c.op)).toEqual(["rpc:delete_treatment_photo", "remove"]);
    expect(calls[1]!.args).toEqual(["treatment-media", [`${T}/${M}.jpg`]]);
    calls.length = 0;
    rpcResults.delete_treatment_photo = { data: null, error: { code: "BH002", message: "x" } };
    expect(await deleteTreatmentPhoto(T, M)).toBe("Bu işlem için yetkiniz yok");
    expect(calls.map((c) => c.op)).toEqual(["rpc:delete_treatment_photo"]);
  });

  it("a delete the database refused never touches the stored object, even if an answer carried a path", async () => {
    rpcResults.delete_treatment_photo = { data: { path: `${T}/${M}.jpg` }, error: { code: "BH002", message: "x" } };
    expect(await deleteTreatmentPhoto(T, M)).toBe("Bu işlem için yetkiniz yok");
    expect(calls.map((c) => c.op)).toEqual(["rpc:delete_treatment_photo"]);
  });

  it("a photo URL is a 60-second signed URL created only after the database authorised the row; a refusal gives none", async () => {
    rpcResults.get_treatment_photo_access = { data: { path: `${T}/${M}.jpg`, mime: "image/jpeg", kind: "after" } };
    expect(await fetchPhotoUrl(T, M)).toBe("https://signed.example/x?token=t");
    expect(calls.map((c) => c.op)).toEqual(["rpc:get_treatment_photo_access", "sign"]);
    expect(calls[1]!.args).toEqual(["treatment-media", `${T}/${M}.jpg`, 60]);
    calls.length = 0;
    rpcResults.get_treatment_photo_access = { data: null, error: { code: "BH003", message: "x" } };
    expect(await fetchPhotoUrl(T, M)).toBeNull();
    expect(calls.map((c) => c.op)).toEqual(["rpc:get_treatment_photo_access"]); // never signs without authorisation
    rpcResults.get_treatment_photo_access = { data: { path: "p.html", mime: "text/html" } };
    expect(await fetchPhotoUrl(T, M)).toBeNull();
  });

  it("quick-rebook defaults: parsed on success, a plain message when the service is gone", async () => {
    rpcResults.get_treatment_rebook_defaults = { data: { serviceId: T, serviceName: "A", branchId: I, staffId: null } };
    expect(await fetchRebookDefaults(T, I)).toEqual({ ok: true, defaults: { serviceId: T, serviceName: "A", branchId: I, staffId: null } });
    rpcResults.get_treatment_rebook_defaults = { data: null, error: { code: "BH003", message: "x" } };
    expect(await fetchRebookDefaults(T, I)).toEqual({ ok: false, message: "Bu hizmet artık sunulmuyor" });
  });

  it("every database code has a plain message and unknown codes never leak text", () => {
    for (const c of ["BH001", "BH002", "BH003", "BH004", "BH005", "BH006"]) expect(treatmentErrorMessage(c)).not.toBe(treatmentErrorMessage("XX000"));
    expect(treatmentErrorMessage("XX000")).toBe("İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
    expect(treatmentErrorMessage(undefined)).toBe("İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
  });
});

describe("service re-booking window rules", () => {
  it("a maximum needs a minimum; the maximum may not be below it; equal and one-sided are fine", () => {
    expect(validateRebook({})).toBeNull();
    expect(validateRebook({ rebookMinDays: 28, rebookMaxDays: 56 })).toBeNull();
    expect(validateRebook({ rebookMinDays: 28, rebookMaxDays: 28 })).toBeNull();
    expect(validateRebook({ rebookMinDays: 28 })).toBeNull();
    expect(validateRebook({ rebookMinDays: null, rebookMaxDays: 56 })).not.toBeNull();
    expect(validateRebook({ rebookMaxDays: 56 })).not.toBeNull();
    expect(validateRebook({ rebookMinDays: 56, rebookMaxDays: 28 })).not.toBeNull();
  });

  it("columns: absent leaves both alone, a cleared minimum clears both, otherwise both are written", () => {
    expect(rebookColumns({})).toEqual({});
    expect(rebookColumns({ rebookMinDays: null, rebookMaxDays: 9 })).toEqual({ rebook_min_days: null, rebook_max_days: null });
    expect(rebookColumns({ rebookMinDays: 28, rebookMaxDays: 56 })).toEqual({ rebook_min_days: 28, rebook_max_days: 56 });
    expect(rebookColumns({ rebookMinDays: 28 })).toEqual({ rebook_min_days: 28, rebook_max_days: null });
    expect(rebookDaysFromText("")).toBeNull();
    expect(rebookDaysFromText(" 28 ")).toBe(28);
  });

  it("the actions refuse an inverted window before touching the database", async () => {
    const c = await createServiceAction(null, { tenantId: T, tenantSlug: "x", name: "A", durationMinutes: 30, price: "1", branchIds: [], rebookMinDays: 56, rebookMaxDays: 28 });
    expect(c.success).toBe(false);
    const u = await updateServiceProfileAction(null, { tenantSlug: "x", serviceId: I, name: "A", durationMinutes: 30, price: "1", rebookMinDays: null, rebookMaxDays: 5 });
    expect(u.success).toBe(false);
    const ok = await updateServiceProfileAction(null, { tenantSlug: "x", serviceId: I, name: "A", durationMinutes: 30, price: "1", rebookMinDays: 28, rebookMaxDays: 56 });
    expect(ok.success).toBe(true);
  });
});
