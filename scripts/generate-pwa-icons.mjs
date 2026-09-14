// Faz NOTIF.2C.2 — generate the final branded PWA/favicon icon set from
// the genuine SalonOS logo.
//
// Source:  public/brand/SalonOs_Logo.png  (1254x1254, 8-bit RGBA,
//          transparent, non-interlaced). It contains the gold emblem in
//          the upper area, then the "SalonOS" wordmark, then the "Salon
//          Yönetim Sistemi" tagline.
//
// This script uses the EMBLEM ONLY. The wordmark and tagline are never
// included in a square app icon. The emblem pixels are taken verbatim
// from the source (crop + bilinear resize + alpha-composite only) — no
// redraw, no recolour, no typography recreation. The emblem's own gold
// is never altered; only backgrounds (for the opaque apple-touch icon
// and the maskable icon) are added, using real design-system colours.
//
// Emblem crop box, derived by scanning the source alpha channel (see the
// Faz NOTIF.2C.2 report): x 299..960, y 57..898. Row 898 is the pinch
// point immediately above the first wordmark glyph — nothing below it is
// part of the emblem, and no gold above it is cut.
//
// Re-run with `node scripts/generate-pwa-icons.mjs` if the brand asset
// is updated.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, crop, resize, fitMark, encodePng, encodeIco } from "./_png-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const R = (p) => join(root, p);

// Design-system colours (app/globals.css, OKLCH -> sRGB):
//   --background (light) oklch(0.99 0.004 75) -> #fdfbf9
//   --primary   (light) oklch(0.42 0.07 195) -> #055959
const BG_LIGHT = [0xfd, 0xfb, 0xf9];
const PRIMARY = [0x05, 0x59, 0x59];

// --- 1. decode source, crop the emblem ------------------------------
const source = decodePng(readFileSync(R("public/brand/SalonOs_Logo.png")));
if (source.width !== 1254 || source.height !== 1254) {
  console.warn(`note: source is ${source.width}x${source.height}, expected 1254x1254`);
}
const EMBLEM = { x: 299, y: 57, w: 662, h: 842 };
const emblem = crop(source, EMBLEM.x, EMBLEM.y, EMBLEM.w, EMBLEM.h);

mkdirSync(R("public/icons"), { recursive: true });

// --- 2. standard icons: transparent, emblem ~88% of the canvas ------
// A high-res transparent master, then bilinear down to each size, so
// every standard icon is the identical mark at different resolutions.
const master = fitMark(emblem, 1024, 0.88, null);

const write = (rel, img) => {
  const buf = encodePng(img);
  writeFileSync(R(rel), buf);
  return buf;
};

write("public/icons/icon-512.png", resize(master, 512, 512));
write("public/icons/icon-192.png", resize(master, 192, 192));

// --- 3. apple-touch-icon: 180x180, OPAQUE (iOS composites a
//        transparent Home Screen icon on black otherwise). Emblem on the
//        app's own light surface, ~78% so a squircle mask never clips it.
write("public/icons/apple-icon-180.png", fitMark(emblem, 180, 0.78, BG_LIGHT));

// --- 4. maskable: 512x512, solid --primary field. coverage 0.58 was
//        chosen (not the phase's own suggested 0.64) after measuring the
//        actual furthest emblem pixel from centre against the W3C 80%
//        safe-zone radius (204.8px @ 512): 0.64 left only a 4.2px margin
//        (the emblem's bottom-right flame tip is the tightest point,
//        since it's a non-rectangular mark and the naive bounding-box
//        math undercounts how close a real corner gets) — too thin
//        given real launchers vary slightly in mask geometry. 0.58
//        verified to leave a ~17px margin; see the Faz NOTIF.2C.2 report.
write("public/icons/icon-maskable-512.png", fitMark(emblem, 512, 0.58, PRIMARY));

// --- 5. favicon.ico: 16/32/48 transparent PNG frames of the emblem ---
const icoFrames = [16, 32, 48].map((size) => ({
  size,
  png: encodePng(fitMark(emblem, size, 0.92, null)),
}));
writeFileSync(R("app/favicon.ico"), encodeIco(icoFrames));

console.log("generated:");
for (const f of [
  "public/icons/icon-192.png",
  "public/icons/icon-512.png",
  "public/icons/icon-maskable-512.png",
  "public/icons/apple-icon-180.png",
  "app/favicon.ico",
]) {
  console.log("  " + f + "  (" + readFileSync(R(f)).length + " bytes)");
}
