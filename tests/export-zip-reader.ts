import { crc32, inflateRawSync } from "node:zlib";

/** Minimal, independent zip reader for tests: walks the central directory, inflates each entry and VERIFIES its crc32 and sizes. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize !== eocd) throw new Error("central directory does not end at EOCD");
  const out = new Map<string, Buffer>();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central header");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    if ((flags & 0x0800) === 0) throw new Error("entry name is not flagged UTF-8");
    if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error("bad local header");
    if ((buf.readUInt16LE(off + 6) & 0x0800) === 0) throw new Error("local header is not flagged UTF-8");
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const start = off + 30 + lnlen + lelen;
    const data = buf.subarray(start, start + csize);
    if (method !== 8) throw new Error("expected deflate");
    const raw = inflateRawSync(data);
    if (raw.length !== usize) throw new Error(`size mismatch for ${name}`);
    if (crc32(raw) >>> 0 !== crc) throw new Error(`crc mismatch for ${name}`);
    // data descriptor right after the data
    if (buf.readUInt32LE(start + csize) !== 0x08074b50 || buf.readUInt32LE(start + csize + 4) !== crc) throw new Error(`bad descriptor for ${name}`);
    out.set(name, raw);
    p += 46 + nlen + elen + clen;
  }
  return out;
}
