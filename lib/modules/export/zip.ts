import { crc32 as nodeCrc32, createDeflateRaw } from "node:zlib";
import { Readable } from "node:stream";

/**
 * Faz SAAS.1C.2b - a minimal STREAMING zip writer (deflate + data descriptors). Nothing is held in memory beyond the chunk in flight: each entry is
 * deflated as it is produced, sizes and crc follow the data in a descriptor, and the central directory is written once at the end. No ZIP64:
 * an entry or archive past 4 GiB (or 65 535 entries) is refused with a stable code instead of producing a corrupt file.
 */

export class ZipLimitError extends Error {
  readonly code = "zip_limit";
  constructor() {
    super("zip_limit");
  }
}

const MAX_U32 = 0xffffffff;

let table: Uint32Array | null = null;
function crcFallback(buf: Uint8Array, prev: number): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = ~prev >>> 0;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}
export const crc32 = (buf: Uint8Array, prev = 0): number => (typeof nodeCrc32 === "function" ? nodeCrc32(buf, prev) : crcFallback(buf, prev)) >>> 0;

function dosDateTime(d: Date): { time: number; date: number } {
  const y = Math.max(d.getUTCFullYear(), 1980);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export type ZipEntry = { name: string; data: AsyncIterable<Uint8Array> | Iterable<Uint8Array> };

type Done = { name: Buffer; crc: number; csize: number; usize: number; offset: number };

/** Produces the zip bytes lazily. `now` stamps every entry. */
export async function* zipStream(entries: AsyncIterable<ZipEntry>, now: Date): AsyncGenerator<Uint8Array> {
  const { time, date } = dosDateTime(now);
  const done: Done[] = [];
  let offset = 0;
  const emit = (b: Buffer) => {
    offset += b.length;
    if (offset > MAX_U32) throw new ZipLimitError();
    return b;
  };

  for await (const entry of entries) {
    if (done.length >= 0xfffe) throw new ZipLimitError();
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // bit 3: sizes follow in a data descriptor; bit 11: UTF-8 name
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    const entryOffset = offset;
    yield emit(local);
    yield emit(name);

    let crc = 0;
    let usize = 0;
    const tracked = (async function* () {
      for await (const chunk of entry.data as AsyncIterable<Uint8Array>) {
        const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
        crc = crc32(buf, crc);
        usize += buf.length;
        if (usize > MAX_U32) throw new ZipLimitError();
        yield buf;
      }
    })();
    const deflate = createDeflateRaw({ level: 6 });
    const src = Readable.from(tracked, { objectMode: false });
    src.on("error", (e) => deflate.destroy(e));
    src.pipe(deflate);
    let csize = 0;
    for await (const out of deflate) {
      const b = out as Buffer;
      csize += b.length;
      yield emit(b);
    }

    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc >>> 0, 4);
    dd.writeUInt32LE(csize, 8);
    dd.writeUInt32LE(usize, 12);
    yield emit(dd);
    done.push({ name, crc: crc >>> 0, csize, usize, offset: entryOffset });
  }

  const cdStart = offset;
  for (const e of done) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0808, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(e.crc, 16);
    c.writeUInt32LE(e.csize, 20);
    c.writeUInt32LE(e.usize, 24);
    c.writeUInt16LE(e.name.length, 28);
    c.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
    c.writeUInt32LE(e.offset, 42);
    yield emit(c);
    yield emit(e.name);
  }
  const cdSize = offset - cdStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(done.length, 8);
  end.writeUInt16LE(done.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  yield emit(end);
}
