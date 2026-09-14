// Faz NOTIF.2C.2 — minimal pure-Node PNG toolkit (built-in zlib only).
// This project has no sharp/jimp/canvas and adding one to crop/resize a
// handful of icons is not warranted. Supports exactly what the icon
// pipeline needs: decode 8-bit RGBA non-interlaced PNG, crop, bilinear
// resize, alpha-composite onto a solid background, encode PNG, pack ICO.
//
// It never redraws or recolours pixels — every output pixel is either a
// verbatim source pixel, a bilinear blend of source pixels, or a source
// pixel alpha-blended onto a chosen solid background. No filters, no
// tone changes.

import zlib from "node:zlib";

export function decodePng(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let p = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString("ascii", p + 4, p + 8);
    const body = png.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace})`);
      }
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const pa = Math.abs(b - c);
    const pb = Math.abs(a - c);
    const pc = Math.abs(a + b - 2 * c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[src + x];
      const a = x >= 4 ? out[dst + x - 4] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[dst - stride + x - 4] : 0;
      let v;
      if (filter === 0) v = rawByte;
      else if (filter === 1) v = rawByte + a;
      else if (filter === 2) v = rawByte + b;
      else if (filter === 3) v = rawByte + ((a + b) >> 1);
      else if (filter === 4) v = rawByte + paeth(a, b, c);
      else throw new Error("bad PNG filter " + filter);
      out[dst + x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

export function crop(img, x0, y0, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * img.width + (x0 + x)) * 4;
      const di = (y * w + x) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = img.data[si + 3];
    }
  }
  return { width: w, height: h, data: out };
}

export function resize(img, targetW, targetH) {
  const { width: sw, height: sh, data: sd } = img;
  const out = Buffer.alloc(targetW * targetH * 4);
  for (let y = 0; y < targetH; y++) {
    const fy = ((y + 0.5) * sh) / targetH - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < targetW; x++) {
      const fx = ((x + 0.5) * sw) / targetW - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const di = (y * targetW + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const p00 = sd[(y0 * sw + x0) * 4 + ch];
        const p10 = sd[(y0 * sw + x1) * 4 + ch];
        const p01 = sd[(y1 * sw + x0) * 4 + ch];
        const p11 = sd[(y1 * sw + x1) * 4 + ch];
        const top = p00 + (p10 - p00) * wx;
        const bot = p01 + (p11 - p01) * wx;
        out[di + ch] = Math.round(top + (bot - top) * wy);
      }
    }
  }
  return { width: targetW, height: targetH, data: out };
}

/** Blank RGBA canvas: transparent (default) or a solid opaque colour. */
export function canvas(size, bg /* [r,g,b] | null */) {
  const out = Buffer.alloc(size * size * 4);
  if (bg) {
    for (let i = 0; i < size * size; i++) {
      out[i * 4] = bg[0];
      out[i * 4 + 1] = bg[1];
      out[i * 4 + 2] = bg[2];
      out[i * 4 + 3] = 255;
    }
  }
  return { width: size, height: size, data: out };
}

/** Alpha-composite `top` centred onto `base` at the given pixel offset. */
export function compositeCentered(base, top) {
  const ox = Math.round((base.width - top.width) / 2);
  const oy = Math.round((base.height - top.height) / 2);
  for (let y = 0; y < top.height; y++) {
    for (let x = 0; x < top.width; x++) {
      const bx = ox + x;
      const by = oy + y;
      if (bx < 0 || by < 0 || bx >= base.width || by >= base.height) continue;
      const si = (y * top.width + x) * 4;
      const di = (by * base.width + bx) * 4;
      const sa = top.data[si + 3] / 255;
      if (sa === 0) continue;
      const da = base.data[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      for (let ch = 0; ch < 3; ch++) {
        const s = top.data[si + ch];
        const d = base.data[di + ch];
        base.data[di + ch] = Math.round((s * sa + d * da * (1 - sa)) / (outA || 1));
      }
      base.data[di + 3] = Math.round(outA * 255);
    }
  }
  return base;
}

/**
 * Place a transparent mark on a square canvas so its LONGER dimension is
 * `coverage` of the canvas side, preserving aspect ratio and centring.
 */
export function fitMark(mark, size, coverage, bg = null) {
  const scale = (size * coverage) / Math.max(mark.width, mark.height);
  const w = Math.round(mark.width * scale);
  const h = Math.round(mark.height * scale);
  return compositeCentered(canvas(size, bg), resize(mark, w, h));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const rawWithFilters = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    rawWithFilters[y * (stride + 1)] = 0;
    data.copy(rawWithFilters, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(rawWithFilters, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Pack PNG-payload frames into a Windows .ico (valid for modern browsers). */
export function encodeIco(frames /* [{ size, png:Buffer }] */) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const entries = Buffer.alloc(16 * frames.length);
  let offset = 6 + entries.length;
  const blobs = [];
  frames.forEach((f, i) => {
    const e = i * 16;
    entries[e] = f.size >= 256 ? 0 : f.size;
    entries[e + 1] = f.size >= 256 ? 0 : f.size;
    entries[e + 2] = 0;
    entries[e + 3] = 0;
    entries.writeUInt16LE(1, e + 4);
    entries.writeUInt16LE(32, e + 6);
    entries.writeUInt32LE(f.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += f.png.length;
    blobs.push(f.png);
  });
  return Buffer.concat([header, entries, ...blobs]);
}
