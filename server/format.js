// Google Keep Takeout format rules: file naming, note validation, HTML twins of
// plain text, mime sniffing. See keep-takeout.md for the observations behind them.

import { randomBytes } from 'node:crypto';

export const COLORS = ['DEFAULT', 'RED', 'ORANGE', 'YELLOW', 'GREEN', 'TEAL', 'BLUE', 'CERULEAN', 'PURPLE', 'PINK', 'BROWN', 'GRAY'];

/** Keys whose change counts as a user edit and bumps userEditedTimestampUsec. */
export const CONTENT_KEYS = ['title', 'textContent', 'textContentHtml', 'listContent', 'labels', 'attachments', 'annotations'];
export const FLAG_KEYS = ['color', 'isPinned', 'isArchived', 'isTrashed'];
export const EDITABLE_KEYS = [...CONTENT_KEYS, ...FLAG_KEYS];

const STEM_MAX = 50;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function nowUsec() {
  return Date.now() * 1000;
}

/** A filename stem for a note, following Takeout's sanitizing rules. */
export function stemForNote(title, createdUsec) {
  let stem = String(title ?? '')
    .replace(/[\\/:*?"<>|']/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .slice(0, STEM_MAX)
    .replace(/[ .]$/, '_');
  if (!stem.trim() || stem === '_') stem = timestampStem(createdUsec);
  if (WINDOWS_RESERVED.test(stem)) stem += '_';
  return stem;
}

/** Takeout names untitled notes like 2021-06-14T09_30_15.250+00_00 (local time). */
export function timestampStem(usec) {
  const d = new Date(Math.floor((Number(usec) || nowUsec()) / 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}_${pad(Math.abs(off) % 60)}`;
}

/** Strip a trailing "(n)" duplicate marker. */
export function baseStem(stem) {
  return stem.replace(/\(\d+\)$/, '');
}

/** Pick base, base(1), base(2)… that is not taken. `taken` holds lowercased stems. */
export function uniqueStem(base, taken) {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 1; ; i++) {
    const s = `${base}(${i})`;
    if (!taken.has(s.toLowerCase())) return s;
  }
}

/** A basename is safe when it has no directory parts and no traversal. */
export function isSafeBasename(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 256 &&
    !/[\\/\u0000]/.test(name) && name !== '.' && name !== '..' && !/^[a-zA-Z]:/.test(name);
}

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/heic': 'heic', 'audio/3gpp': '3gp', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
};
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', heic: 'image/heic', '3gp': 'audio/3gpp', '3gpp': 'audio/3gpp', m4a: 'audio/mp4',
  aac: 'audio/aac', mp3: 'audio/mpeg', ogg: 'audio/ogg', webm: 'audio/webm',
  json: 'application/json', html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8',
};

export function extForMime(mime) {
  return MIME_EXT[String(mime).toLowerCase()] || 'bin';
}

export function mimeForName(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

/** Sibling extensions tried when a Takeout attachment path misses. */
export const SIBLING_EXTS = {
  jpg: ['jpeg', 'JPG', 'JPEG'], jpeg: ['jpg', 'JPG', 'JPEG'], png: ['PNG'], gif: ['GIF'],
  '3gp': ['3gpp', 'm4a', 'aac'], '3gpp': ['3gp', 'm4a', 'aac'], m4a: ['3gp', '3gpp', 'aac'], aac: ['3gp', '3gpp', 'm4a'],
};

/** New attachment name in Keep's newer scheme: {hex_unix_millis}.{hex_random}.{ext} */
export function newMediaName(ext) {
  return `${Date.now().toString(16)}.${randomBytes(8).toString('hex')}.${ext}`;
}

/** Mime type from the first bytes, or null. */
export function sniffMime(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
  return null;
}

/** Pixel size of PNG, GIF, JPEG or WebP data, or null. Used to lay out cards before images load. */
export function imageSize(buf) {
  try {
    const mime = sniffMime(buf);
    if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/bmp') return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    if (mime === 'image/webp') {
      const kind = buf.toString('latin1', 12, 16);
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    if (mime === 'image/jpeg') {
      let p = 2;
      let orientation = 1;
      while (p + 9 < buf.length) {
        if (buf[p] !== 0xff) { p++; continue; }
        const marker = buf[p + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
        const len = buf.readUInt16BE(p + 2);
        if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 8) === 'Exif') orientation = exifOrientation(buf, p + 10) || 1;
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = buf.readUInt16BE(p + 5);
          const width = buf.readUInt16BE(p + 7);
          // Browsers apply EXIF rotation, so report the displayed size.
          return orientation >= 5 ? { width: height, height: width } : { width, height };
        }
        p += 2 + len;
      }
    }
  } catch { /* truncated or odd file */ }
  return null;
}

/** True for a PNG drawn in GeoKeep: its strokes ride in a "GeoKeepInk" tEXt chunk. */
export function hasInk(buf) {
  if (sniffMime(buf) !== 'image/png') return false;
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IDAT' || type === 'IEND') return false;
    if (type === 'tEXt' && buf.toString('latin1', p + 8, p + 8 + 11) === 'GeoKeepInk\0') return true;
    p += 12 + len;
  }
  return false;
}

/** What the UI needs to know about an attachment before loading it. */
export function mediaInfo(buf) {
  const info = imageSize(buf) || {};
  if (hasInk(buf)) info.ink = true;
  return info;
}

function exifOrientation(buf, tiff) {
  const le = buf.toString('latin1', tiff, tiff + 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = tiff + u32(tiff + 4);
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return null;
}

// ---- HTML twins -----------------------------------------------------------

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Keep-style HTML for plain text: one <p dir="ltr"> per line, as in this export. */
export function plainTextToKeepHtml(text) {
  return String(text).split('\n').map((line) => `<p dir="ltr">${escapeHtml(line)}</p>`).join('');
}

// ---- Validation -----------------------------------------------------------

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const isBool = (v) => typeof v === 'boolean';
const isStr = (v) => typeof v === 'string';

function checkItem(item, i) {
  if (!item || typeof item !== 'object') throw bad(`listContent[${i}] must be an object`);
  if (!isStr(item.text)) throw bad(`listContent[${i}].text must be a string`);
  if (item.isChecked !== undefined && !isBool(item.isChecked)) throw bad(`listContent[${i}].isChecked must be a boolean`);
  if (item.textHtml !== undefined && !isStr(item.textHtml)) throw bad(`listContent[${i}].textHtml must be a string`);
}

/** Validate an edit coming from the UI. Throws with a readable message. */
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Body must be an object');
  for (const key of Object.keys(patch)) {
    if (!EDITABLE_KEYS.includes(key)) throw bad(`Field "${key}" cannot be edited`);
  }
  for (const key of ['title', 'textContent', 'textContentHtml', 'color']) {
    if (key in patch && !isStr(patch[key])) throw bad(`${key} must be a string`);
  }
  for (const key of ['isPinned', 'isArchived', 'isTrashed']) {
    if (key in patch && !isBool(patch[key])) throw bad(`${key} must be a boolean`);
  }
  if ('listContent' in patch) {
    if (!Array.isArray(patch.listContent)) throw bad('listContent must be an array');
    patch.listContent.forEach(checkItem);
  }
  if ('labels' in patch) {
    if (!Array.isArray(patch.labels) || !patch.labels.every((l) => l && isStr(l.name) && l.name.trim())) {
      throw bad('labels must be [{ name }]');
    }
  }
  if ('attachments' in patch) {
    if (!Array.isArray(patch.attachments) || !patch.attachments.every((a) => a && isSafeBasename(a.filePath))) {
      throw bad('attachments must be [{ filePath, mimetype }] with plain file names');
    }
  }
  if ('annotations' in patch) {
    if (!Array.isArray(patch.annotations) || !patch.annotations.every((a) => a && typeof a === 'object')) {
      throw bad('annotations must be an array of objects');
    }
  }
}

/**
 * Normalize a note read from a Takeout file. Never drops a note: missing fields
 * get defaults and are reported as warnings. Unknown keys are kept as they are.
 */
export function normalizeImported(raw, fallbackUsec) {
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a JSON object');
  const note = { ...raw };
  if (!isStr(note.title)) { note.title = note.title == null ? '' : String(note.title); warnings.push('missing title'); }
  if (!isStr(note.color)) { note.color = 'DEFAULT'; warnings.push('missing color'); }
  for (const key of ['isPinned', 'isArchived', 'isTrashed']) {
    if (!isBool(note[key])) { note[key] = Boolean(note[key]); warnings.push(`missing ${key}`); }
  }
  const edited = Number(note.userEditedTimestampUsec);
  const created = Number(note.createdTimestampUsec);
  if (!Number.isFinite(edited) && !Number.isFinite(created)) {
    note.userEditedTimestampUsec = note.createdTimestampUsec = fallbackUsec;
    warnings.push('no timestamps, used file time');
  } else {
    if (!Number.isFinite(edited)) note.userEditedTimestampUsec = created;
    if (!Number.isFinite(created)) note.createdTimestampUsec = note.userEditedTimestampUsec;
  }
  if (!isStr(note.textContent) && !Array.isArray(note.listContent)) note.textContent = '';
  if (Array.isArray(note.listContent)) {
    note.listContent = note.listContent.map((item) => {
      if (item && isStr(item.text) && isBool(item.isChecked)) return item;
      warnings.push('repaired a checklist item');
      return { ...(item && typeof item === 'object' ? item : {}), text: isStr(item?.text) ? item.text : '', isChecked: Boolean(item?.isChecked) };
    });
  }
  return { note, warnings };
}

/** Plain string used to match a note across imports. */
export function attachmentKey(note) {
  return (note.attachments || []).map((a) => a.filePath).sort().join('|');
}
