// Minimal ZIP reader and writer on top of node:zlib, so the app has no dependencies.
// Reader: random access through a file handle, ZIP64 aware (multi-GB Takeouts).
// Writer: streaming, one entry at a time, store or deflate.

import { open } from 'node:fs/promises';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead === 0) throw new Error('Unexpected end of zip file');
    off += bytesRead;
  }
  return buf;
}

/** Open a zip for reading. Returns { entries, read(entry), close() }. */
export async function openZip(file) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65535 + 22);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`Not a zip file: ${file}`);

    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === SIG_EOCD64_LOC) {
        const eocd64Off = Number(tail.readBigUInt64LE(loc + 8));
        const rec = await readAt(fh, eocd64Off, 56);
        if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new Error('Bad ZIP64 end record');
        count = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOffset = Number(rec.readBigUInt64LE(48));
      }
    }

    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('Bad central directory');
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      // Takeout sets the UTF-8 flag; names without it are decoded as UTF-8 too,
      // which is right for every archiver in common use today.
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let e = 0; e + 4 <= extra.length;) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset, isDir: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }

    return {
      entries,
      async read(entry) {
        const head = await readAt(fh, entry.localOffset, 30);
        if (head.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`Bad local header for ${entry.name}`);
        const start = entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
        const raw = await readAt(fh, start, entry.compressedSize);
        let data;
        if (entry.method === 0) data = raw;
        else if (entry.method === 8) data = zlib.inflateRawSync(raw);
        else throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
        if (crc32(data) !== entry.crc) throw new Error(`CRC mismatch for ${entry.name}`);
        return data;
      },
      close: () => fh.close(),
    };
  } catch (err) {
    await fh.close();
    throw err;
  }
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Streaming zip writer. Call add() for each file, then finish(). */
export class ZipWriter {
  constructor(stream) {
    this.stream = stream;
    this.offset = 0;
    this.central = [];
  }

  async #write(buf) {
    this.offset += buf.length;
    if (!this.stream.write(buf)) {
      await new Promise((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (e) => { cleanup(); reject(e); };
        const onClose = () => { cleanup(); reject(new Error('Stream closed')); };
        const cleanup = () => {
          this.stream.off('drain', onDrain);
          this.stream.off('error', onError);
          this.stream.off('close', onClose);
        };
        this.stream.on('drain', onDrain);
        this.stream.on('error', onError);
        this.stream.on('close', onClose);
      });
    }
  }

  async add(name, data, { mtime = new Date(), compress = true } = {}) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    let method = 0;
    let body = data;
    if (compress && data.length > 64) {
      const deflated = zlib.deflateRawSync(data, { level: 6 });
      if (deflated.length < data.length) { method = 8; body = deflated; }
    }
    if (body.length >= 0xffffffff || data.length >= 0xffffffff) throw new Error(`${name} is larger than 4 GB`);
    const { time, date } = dosDateTime(mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    this.central.push({ nameBuf, crc, method, time, date, csize: body.length, usize: data.length, offset: this.offset });
    await this.#write(local);
    await this.#write(nameBuf);
    await this.#write(body);
  }

  /** Central directory and end records; switches to ZIP64 past 65,535 entries or 4 GB. */
  async finish() {
    const cdStart = this.offset;
    for (const e of this.central) {
      const far = e.offset >= 0xffffffff;
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(far ? 45 : 20, 4);
      h.writeUInt16LE(far ? 45 : 20, 6);
      h.writeUInt16LE(0x800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      // An entry past 4 GB keeps its offset in a ZIP64 extra field.
      const extra = far ? Buffer.alloc(12) : null;
      if (extra) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(e.offset), 4);
        h.writeUInt16LE(extra.length, 30);
      }
      h.writeUInt32LE(far ? 0xffffffff : e.offset, 42);
      await this.#write(h);
      await this.#write(e.nameBuf);
      if (extra) await this.#write(extra);
    }
    const count = this.central.length;
    const cdSize = this.offset - cdStart;
    const zip64 = count >= 0xffff || cdStart >= 0xffffffff || cdSize >= 0xffffffff;
    if (zip64) {
      const eocd64At = this.offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(SIG_EOCD64, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE(45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeBigUInt64LE(BigInt(count), 24);
      rec.writeBigUInt64LE(BigInt(count), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40);
      rec.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(SIG_EOCD64_LOC, 0);
      loc.writeBigUInt64LE(BigInt(eocd64At), 8);
      loc.writeUInt32LE(1, 16);
      await this.#write(rec);
      await this.#write(loc);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_EOCD, 0);
    end.writeUInt16LE(zip64 ? 0xffff : count, 8);
    end.writeUInt16LE(zip64 ? 0xffff : count, 10);
    end.writeUInt32LE(zip64 ? 0xffffffff : cdSize, 12);
    end.writeUInt32LE(zip64 ? 0xffffffff : cdStart, 16);
    await this.#write(end);
    await new Promise((resolve, reject) => {
      this.stream.end((err) => (err ? reject(err) : resolve()));
    });
  }
}
