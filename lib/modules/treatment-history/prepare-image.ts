/**
 * Faz BEAUTY.1B - what the browser does to a photo BEFORE it is uploaded: decode it and re-encode a JPEG no larger than 1600 px on
 * the long edge. This (1) keeps a phone photo under the 2 MiB limit, (2) drops all metadata (EXIF, GPS position, device), and
 * (3) means only camera/photo-library formats the browser can already decode are accepted - nothing is "uploaded as is".
 * The environment (decode / encode) is injectable so the rules are tested without a canvas; the real canvas path is covered by
 * hosted acceptance on a phone.
 */
import { MAX_PHOTO_BYTES } from "./model";

export const MAX_LONG_EDGE = 1600;
export const JPEG_QUALITY = 0.82;

export type ImageEnv = {
  decode: (file: Blob) => Promise<{ width: number; height: number; draw: (w: number, h: number) => Promise<Blob | null> }>;
};

export function scaledSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= MAX_LONG_EDGE) return { width, height };
  const f = MAX_LONG_EDGE / long;
  return { width: Math.max(1, Math.round(width * f)), height: Math.max(1, Math.round(height * f)) };
}

export const browserImageEnv: ImageEnv = {
  async decode(file) {
    const bmp = await createImageBitmap(file);
    return {
      width: bmp.width,
      height: bmp.height,
      draw: (w, h) =>
        new Promise((resolve) => {
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve(null);
          ctx.drawImage(bmp, 0, 0, w, h);
          canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY);
        }),
    };
  },
};

export async function prepareTreatmentImage(file: Blob, env: ImageEnv = browserImageEnv): Promise<{ ok: true; blob: Blob } | { ok: false; message: string }> {
  let decoded;
  try {
    decoded = await env.decode(file);
  } catch {
    return { ok: false, message: "Bu fotoğraf okunamadı. JPEG, PNG veya WEBP deneyin" };
  }
  const { width, height } = scaledSize(decoded.width, decoded.height);
  const blob = await decoded.draw(width, height);
  if (!blob || blob.size === 0) return { ok: false, message: "Fotoğraf hazırlanamadı" };
  if (blob.size > MAX_PHOTO_BYTES) return { ok: false, message: "Fotoğraf en fazla 2 MB olabilir" };
  return { ok: true, blob: new Blob([blob], { type: "image/jpeg" }) };
}
