// Link previews, like Keep's: fetch a page's Open Graph title, description and
// image. Results are cached in data/linkcache/ (outside Keep/, so the note data
// stays plain Takeout). Set GEOKEEP_OFFLINE=1 to never fetch anything.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const PAGE_LIMIT = 768 * 1024;
const IMAGE_LIMIT = 3 * 1024 * 1024;
const TIMEOUT = 8000;
const RETRY_FAILED_AFTER = 24 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; GeoKeep link preview; +https://github.com/)';

export const offline = () => process.env.GEOKEEP_OFFLINE === '1';

/** A URL worth previewing: absolute http(s) with a real-looking host. */
export function previewable(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && /[a-z0-9]/i.test(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const clean = (s, max) => decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, max);

/** Pull title, description and image out of a page's <head>. */
export function parseMeta(html, baseUrl) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attr = (name) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
      return m ? (m[2] ?? m[3] ?? m[4]) : null;
    };
    const key = (attr('property') || attr('name') || attr('itemprop') || '').toLowerCase();
    const content = attr('content');
    if (key && content != null && !(key in meta)) meta[key] = content;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = clean(meta['og:title'] || meta['twitter:title'] || titleTag, 300);
  const description = clean(meta['og:description'] || meta['twitter:description'] || meta.description, 500);
  let image = meta['og:image'] || meta['og:image:url'] || meta['og:image:secure_url'] || meta['twitter:image'] || meta['twitter:image:src'] || '';
  try { image = image ? new URL(decodeEntities(image.trim()), baseUrl).href : ''; } catch { image = ''; }
  if (image && !previewable(image)) image = '';
  return { title, description, image };
}

async function readLimited(res, limit, stopAtHeadEnd) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= limit) break;
    if (stopAtHeadEnd && Buffer.from(value).toString('latin1').toLowerCase().includes('</head>')) break;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function decodeHtml(buf, contentType) {
  let charset = /charset=([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.toString('latin1', 0, 4096))?.[1];
  try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

export class LinkPreviews {
  constructor(dataDir) {
    this.dir = join(dataDir, 'linkcache');
    this.inflight = new Map();
  }

  #key(url) {
    return createHash('sha256').update(url).digest('hex').slice(0, 32);
  }

  async #readMeta(url) {
    try { return JSON.parse(await readFile(join(this.dir, `${this.#key(url)}.json`), 'utf8')); } catch { return null; }
  }

  async #writeMeta(url, meta) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${this.#key(url)}.json`), JSON.stringify(meta));
  }

  /** { ok, url, title, description, image } for a page; cached. */
  get(url) {
    if (!this.inflight.has(url)) {
      const p = this.#get(url).finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    return this.inflight.get(url);
  }

  async #get(url) {
    const cached = await this.#readMeta(url);
    if (cached && (cached.ok || Date.now() - cached.fetchedAt < RETRY_FAILED_AFTER)) return cached;
    if (offline()) return { ok: false, error: 'offline' };
    let meta;
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT),
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      if (/^image\//i.test(type)) {
        meta = { ok: true, url, finalUrl: res.url, title: new URL(res.url).pathname.split('/').pop() || new URL(res.url).hostname, description: '', image: res.url };
        res.body?.cancel().catch(() => {});
      } else if (/html|xml/i.test(type) || !type) {
        const html = decodeHtml(await readLimited(res, PAGE_LIMIT, true), type);
        const m = parseMeta(html, res.url);
        meta = { ok: true, url, finalUrl: res.url, ...m, title: m.title || new URL(res.url).hostname };
      } else {
        res.body?.cancel().catch(() => {});
        meta = { ok: true, url, finalUrl: res.url, title: new URL(res.url).hostname, description: '', image: '' };
      }
    } catch (err) {
      meta = { ok: false, url, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
    }
    meta.fetchedAt = Date.now();
    await this.#writeMeta(url, meta).catch(() => {});
    return meta;
  }

  /** The preview image for a page: { type, data } or null. Cached on disk. */
  async image(url) {
    const key = this.#key(url);
    const meta = await this.get(url);
    if (!meta.ok || !meta.image) return null;
    if (meta.imageType) {
      try { return { type: meta.imageType, data: await readFile(join(this.dir, `${key}.img`)) }; } catch { /* refetch */ }
    }
    if (meta.imageFailedAt && Date.now() - meta.imageFailedAt < RETRY_FAILED_AFTER) return null;
    if (offline()) return null;
    try {
      const res = await fetch(meta.image, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT), headers: { 'User-Agent': UA, Accept: 'image/*' } });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!res.ok || !/^image\/(png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon)$/i.test(type)) throw new Error('not an image');
      const data = await readLimited(res, IMAGE_LIMIT, false);
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, `${key}.img`), data);
      await this.#writeMeta(url, { ...meta, imageType: type });
      return { type, data };
    } catch {
      await this.#writeMeta(url, { ...meta, imageFailedAt: Date.now() }).catch(() => {});
      return null;
    }
  }
}
