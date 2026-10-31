// HTTP server: JSON API, media, static UI. No framework, no dependencies.

import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, mkdir, rm } from 'node:fs/promises';
import { join, normalize, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { isSafeBasename, mimeForName } from './format.js';
import { findSources, importSources, writeTakeoutZip, createSnapshot, listSnapshots } from './takeout.js';
import { LinkPreviews, previewable, offline } from './unfurl.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const MAX_JSON = 20 * 1024 * 1024;
const MAX_IMAGE = 50 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const gzip = promisify(zlib.gzip);

async function send(res, status, body, headers = {}) {
  let data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const head = {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  };
  // Big JSON (the full note list) compresses about 8x; gzip off the main thread.
  if (data.length > 8192 && /\bgzip\b/.test(String(res.req?.headers['accept-encoding'] || ''))) {
    data = await gzip(data, { level: 4 });
    head['Content-Encoding'] = 'gzip';
    head.Vary = 'Accept-Encoding';
  }
  res.writeHead(status, head);
  res.end(data);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  // Requiring the JSON content type forces a CORS preflight, which blocks
  // other web pages from posting to this local server.
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  const buf = await readBody(req, MAX_JSON);
  try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function requireAppHeader(req) {
  if (req.headers['x-geokeep'] !== '1') throw new HttpError(403, 'Missing X-GeoKeep header');
}

async function serveFile(req, res, file, type, cache = 'no-cache') {
  let st;
  try { st = await stat(file); } catch { throw new HttpError(404, 'Not found'); }
  if (!st.isFile()) throw new HttpError(404, 'Not found');
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, ETag: etag, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') { res.end(); return; }
  await pipeline(createReadStream(file), res);
}

export function createServer(store, { password, host } = {}) {
  const loopback = !host || host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const imports = new Map(); // session id -> { dir, files }
  const previews = new LinkPreviews(store.dataDir);

  const routes = [
    ['GET', /^\/api\/state$/, async () => store.state()],
    ['POST', /^\/api\/reload$/, async () => { await store.reload(); return store.state(); }],

    ['POST', /^\/api\/notes$/, async ({ req }) => store.createNote(await readJson(req))],
    ['PATCH', /^\/api\/notes\/([\w-]+)$/, async ({ req, m }) => store.updateNote(m[1], await readJson(req))],
    ['DELETE', /^\/api\/notes\/([\w-]+)$/, async ({ req, m }) => {
      requireAppHeader(req);
      if (!store.get(m[1]).note.isTrashed) throw new HttpError(409, 'Move the note to Trash before deleting it forever');
      await store.deleteNote(m[1]);
      return { ok: true };
    }],
    ['POST', /^\/api\/notes\/([\w-]+)\/copy$/, async ({ req, m }) => { requireAppHeader(req); return store.copyNote(m[1]); }],
    ['POST', /^\/api\/notes\/([\w-]+)\/attachments$/, async ({ req, m }) => {
      requireAppHeader(req);
      const buf = await readBody(req, MAX_IMAGE);
      if (!buf.length) throw new HttpError(400, 'Empty upload');
      return store.addAttachment(m[1], buf, req.headers['content-type']);
    }],
    ['POST', /^\/api\/trash\/empty$/, async ({ req }) => { requireAppHeader(req); return { deleted: await store.emptyTrash() }; }],

    ['POST', /^\/api\/labels$/, async ({ req }) => ({ labels: await store.addLabel((await readJson(req)).name) })],
    ['POST', /^\/api\/labels\/rename$/, async ({ req }) => {
      const { from, to } = await readJson(req);
      await store.renameLabel(from, to);
      return store.state();
    }],
    ['POST', /^\/api\/labels\/delete$/, async ({ req }) => {
      await store.deleteLabel((await readJson(req)).name);
      return store.state();
    }],

    // Import: upload files into a session one by one, then commit.
    ['POST', /^\/api\/import$/, async ({ req }) => {
      requireAppHeader(req);
      const id = randomUUID();
      const dir = join(store.tmpDir, `import-${id}`);
      await mkdir(dir, { recursive: true });
      imports.set(id, { dir, files: 0 });
      return { id };
    }],
    ['PUT', /^\/api\/import\/([\w-]+)\/file$/, async ({ req, m, url }) => {
      requireAppHeader(req);
      const session = imports.get(m[1]);
      if (!session) throw new HttpError(404, 'Unknown import session');
      const rel = String(url.searchParams.get('path') || '').replace(/\\/g, '/');
      const parts = rel.split('/').filter(Boolean);
      if (!parts.length || parts.some((p) => !isSafeBasename(p))) throw new HttpError(400, 'Bad file path');
      const target = join(session.dir, ...parts);
      await mkdir(dirname(target), { recursive: true });
      await pipeline(req, createWriteStream(target));
      session.files++;
      return { ok: true };
    }],
    ['POST', /^\/api\/import\/([\w-]+)\/commit$/, async ({ req, m }) => {
      requireAppHeader(req);
      const session = imports.get(m[1]);
      if (!session) throw new HttpError(404, 'Unknown import session');
      imports.delete(m[1]);
      try {
        const sources = await findSources([session.dir]);
        return await importSources(store, sources);
      } finally {
        await rm(session.dir, { recursive: true, force: true });
      }
    }],

    // Link previews. POST with JSON forces a CORS preflight, so other sites cannot make
    // this server fetch URLs; images are served only for links already on notes.
    ['GET', /^\/api\/config$/, async () => ({ linkPreviews: !offline() })],
    ['POST', /^\/api\/unfurl$/, async ({ req }) => {
      const { url } = await readJson(req);
      if (!previewable(url)) throw new HttpError(400, 'Not a web link');
      const meta = await previews.get(url);
      if (!meta.ok) throw new HttpError(422, `No preview: ${meta.error || 'unreachable'}`);
      return { url, title: meta.title, description: meta.description, hasImage: Boolean(meta.image) };
    }],
    ['GET', /^\/api\/linkimage$/, async ({ req, res, url }) => {
      const target = url.searchParams.get('url') || '';
      if (!previewable(target) || !store.annotationUrls().has(target)) throw new HttpError(404, 'Unknown link');
      const img = await previews.image(target);
      if (!img) throw new HttpError(404, 'No image');
      res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.data.length, 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : img.data);
      return undefined;
    }],

    ['GET', /^\/api\/export$/, async ({ req, res }) => {
      const name = `takeout-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-geokeep.zip`;
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
      await store.exclusive(() => writeTakeoutZip(store, res, { html: true }));
      return undefined;
    }],
    ['GET', /^\/api\/snapshots$/, async () => ({ snapshots: await listSnapshots(store), dir: store.snapshotDir })],
    ['POST', /^\/api\/snapshots$/, async ({ req }) => { requireAppHeader(req); return { name: await createSnapshot(store, 'manual') }; }],
    ['GET', /^\/api\/snapshots\/([^/]+)$/, async ({ req, res, m }) => {
      const name = decodeURIComponent(m[1]);
      if (!/^geokeep-[\w.-]+\.zip$/.test(name)) throw new HttpError(400, 'Bad name');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      await serveFile(req, res, join(store.snapshotDir, name), 'application/zip');
      return undefined;
    }],
  ];

  const expectedAuth = password ? createHash('sha256').update(password).digest() : null;

  return http.createServer(async (req, res) => {
    try {
      // Refuse requests addressed to another host name (DNS rebinding) when bound locally.
      if (loopback) {
        const h = String(req.headers.host || '').replace(/:\d+$/, '');
        if (!['localhost', '127.0.0.1', '[::1]'].includes(h)) throw new HttpError(403, 'Forbidden host');
      }
      if (expectedAuth) {
        const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
        const given = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':') : '';
        if (!timingSafeEqual(createHash('sha256').update(given).digest(), expectedAuth)) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GeoKeep", charset="UTF-8"' });
          res.end('Password required');
          return;
        }
      }

      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      if (path.startsWith('/api/')) {
        for (const [method, re, handler] of routes) {
          const m = re.exec(path);
          if (!m || method !== req.method) continue;
          // A handler returns a value to send as JSON, or undefined after streaming its own response.
          const result = await handler({ req, res, m, url });
          if (result !== undefined) await send(res, 200, result);
          return;
        }
        throw new HttpError(404, 'No such API route');
      }

      if (path.startsWith('/media/')) {
        const name = decodeURIComponent(path.slice(7));
        if (!isSafeBasename(name)) throw new HttpError(400, 'Bad name');
        await serveFile(req, res, join(store.keepDir, name), mimeForName(name), 'private, max-age=31536000, immutable');
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      const rel = normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^([/\\])+/, '');
      const file = join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(400, 'Bad path');
      await serveFile(req, res, file, STATIC_TYPES[extname(file)] || 'application/octet-stream');
    } catch (err) {
      const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
      if (status === 500) console.error(err);
      if (res.headersSent) { res.destroy(err); return; }
      await send(res, status, { error: err.message });
    }
  });
}
