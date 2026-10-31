// Takeout import (zips, folders, multi-part), Takeout-shaped export, and snapshots.

import { readdir, readFile, stat, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { openZip, ZipWriter } from './zip.js';
import { normalizeImported, isSafeBasename, SIBLING_EXTS, mimeForName } from './format.js';
import { parseLabels } from './store.js';
import { mapLimit } from './fsutil.js';
import { renderNoteHtml } from './preview.js';

// ---- Finding sources ---------------------------------------------------------

/**
 * Turn user-given paths into import sources. Accepts Takeout zips (any number
 * of parts), an extracted Takeout folder, a Keep folder, or a folder of zips.
 */
export async function findSources(paths) {
  const sources = [];
  for (const p of paths) {
    const st = await stat(p);
    if (st.isFile()) {
      if (p.toLowerCase().endsWith('.zip')) sources.push({ kind: 'zip', path: p });
      else throw new Error(`Not a zip file or folder: ${p}`);
    } else {
      const found = [];
      await scanDir(p, 0, found);
      if (!found.length && (await hasNoteFiles(p))) found.push({ kind: 'dir', path: p });
      if (!found.length) throw new Error(`No Keep notes or Takeout zips found in ${p}`);
      sources.push(...found);
    }
  }
  return sources;
}

async function hasNoteFiles(dir) {
  const names = await readdir(dir);
  return names.some((n) => n === 'Labels.txt' || n.toLowerCase().endsWith('.json'));
}

async function scanDir(dir, depth, out) {
  if (depth > 4) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.toLowerCase() === 'keep' && (await hasNoteFiles(full))) out.push({ kind: 'dir', path: full });
      else if (!e.name.startsWith('.') && e.name !== 'node_modules') await scanDir(full, depth + 1, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.zip') && depth <= 2) {
      out.push({ kind: 'zip', path: full });
    }
  }
}

// ---- Reading sources -----------------------------------------------------

/** Gather Labels.txt lines, note files and media from every source into one view. */
async function collect(sources) {
  const labelLists = [];
  const notes = new Map(); // basename -> { name, load, mtime }
  const media = new Map(); // basename -> { load }
  const closers = [];

  const add = (name, load, mtime) => {
    if (!isSafeBasename(name)) return;
    const lower = name.toLowerCase();
    if (name === 'Labels.txt') labelLists.push(load);
    else if (lower.endsWith('.json')) notes.set(name, { name, load, mtime });
    else if (!lower.endsWith('.html') && !lower.endsWith('.tmp')) media.set(name, { load });
  };

  for (const src of sources) {
    if (src.kind === 'dir') {
      for (const e of await readdir(src.path, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        const full = join(src.path, e.name);
        // File time is only a fallback for notes without timestamps, so stat lazily.
        add(e.name, () => readFile(full), async () => (await stat(full)).mtimeMs);
      }
    } else {
      const zip = await openZip(src.path);
      closers.push(zip.close);
      const files = zip.entries.filter((e) => !e.isDir);
      let keep = files.filter((e) => /(^|\/)Keep\/[^/]+$/i.test(e.name));
      if (!keep.length) keep = files.filter((e) => !e.name.includes('/')); // a zip of a bare Keep folder
      for (const e of keep) add(e.name.split('/').pop(), () => zip.read(e), async () => Date.now());
    }
  }

  const labels = [];
  for (const load of labelLists) for (const l of parseLabels((await load()).toString('utf8'))) if (!labels.includes(l)) labels.push(l);
  return { labels, hasLabelsFile: labelLists.length > 0, notes: [...notes.values()], media, close: () => Promise.all(closers.map((c) => c())) };
}

/** Resolve an attachment name in the incoming set, trying sibling extensions. */
function resolveMedia(name, media) {
  if (media.has(name)) return name;
  const ext = extname(name).slice(1);
  const stem = name.slice(0, name.length - ext.length - 1);
  for (const alt of SIBLING_EXTS[ext.toLowerCase()] || []) {
    if (media.has(`${stem}.${alt}`)) return `${stem}.${alt}`;
  }
  return null;
}

// ---- Import ----------------------------------------------------------------

/**
 * Merge Takeout sources into the store. A note seen before (same created time,
 * then title and attachments) is replaced only when the incoming copy was edited
 * later. Notes that exist only locally are never removed.
 */
export async function importSources(store, sources, { log = () => {} } = {}) {
  const report = {
    sources: sources.map((s) => basename(s.path)),
    added: [], updated: [], unchanged: 0, keptLocal: [],
    labelsAdded: [], attachmentsCopied: 0, dangling: [], warnings: [], errors: [], snapshot: null,
  };
  if (store.notes.size) report.snapshot = await createSnapshot(store, 'pre-import');

  const data = await collect(sources);
  try {
    log(`Found ${data.notes.length} notes, ${data.media.size} attachments, ${data.labels.length} labels`);
    await store.exclusive(async () => {
      const labelsBefore = new Set(store.labels);
      store.mergeLabels(data.labels);
      const parsed = [];
      const results = await mapLimit(data.notes, 32, async (file) => {
        try {
          const raw = JSON.parse((await file.load()).toString('utf8').replace(/^\uFEFF/, ''));
          const untimed = raw && raw.userEditedTimestampUsec == null && raw.createdTimestampUsec == null;
          return { file, ...normalizeImported(raw, untimed ? Math.floor(await file.mtime()) * 1000 : 0) };
        } catch (err) {
          return { file, error: err.message };
        }
      });
      for (const r of results) {
        if (r.error) { report.errors.push(`${r.file.name}: ${r.error}`); continue; }
        for (const w of r.warnings) report.warnings.push(`${r.file.name}: ${w}`);
        parsed.push({ file: r.file, note: r.note });
      }
      const onDisk = new Set(await readdir(store.keepDir));
      const toCopy = new Set();
      const newEntries = [];

      // Exact matches first, so near-duplicates sharing a created time pair up correctly.
      const claimed = new Set();
      const matches = new Map();
      const exact = (e, n) => e && Number(e.note.userEditedTimestampUsec) === Number(n.userEditedTimestampUsec) && e.note.title === n.title;
      for (const pass of [true, false]) {
        for (const p of parsed) {
          if (matches.has(p)) continue;
          const m = store.findMatch(p.note, claimed);
          if (m && (!pass || exact(m, p.note))) { matches.set(p, m); claimed.add(m.id); }
        }
      }

      for (const p of parsed) {
        const { file, note } = p;
        const label = note.title || file.name;
        const existing = matches.get(p) || null;
        if (existing) {
          const a = Number(note.userEditedTimestampUsec);
          const b = Number(existing.note.userEditedTimestampUsec);
          if (a === b) { report.unchanged++; continue; }
          if (a < b) { report.keptLocal.push(label); continue; }
        }

        if (Array.isArray(note.attachments)) {
          const kept = [];
          for (const att of note.attachments) {
            if (!att || !isSafeBasename(att.filePath)) {
              report.dangling.push({ note: label, filePath: String(att?.filePath), reason: 'unsafe path, reference dropped' });
              continue;
            }
            const found = resolveMedia(att.filePath, data.media);
            if (found) {
              if (found !== att.filePath) report.warnings.push(`${file.name}: ${att.filePath} found as ${found}`);
              att.filePath = found;
              if (!onDisk.has(found)) toCopy.add(found);
            } else if (!onDisk.has(att.filePath)) {
              report.dangling.push({ note: label, filePath: att.filePath, reason: 'file not in the export' });
            }
            if (!att.mimetype) att.mimetype = mimeForName(att.filePath);
            kept.push(att);
          }
          if (kept.length) note.attachments = kept;
          else delete note.attachments;
        }

        // New notes get their file name now and are written in parallel below;
        // updates go one by one since a title change can rename the file.
        if (existing) await store.putImported(existing, note);
        else newEntries.push(store.stageImported(note, file.name.slice(0, -5)));
        (existing ? report.updated : report.added).push(label);
      }

      await mapLimit([...toCopy], 16, async (name) => writeFile(join(store.keepDir, name), await data.media.get(name).load()));
      report.attachmentsCopied = toCopy.size;
      await mapLimit(newEntries, 16, (entry) => store.writeEntry(entry));
      await store.finishImport();
      report.labelsAdded = store.labels.filter((l) => !labelsBefore.has(l));
    });
  } finally {
    await data.close();
  }
  log(`Added ${report.added.length}, updated ${report.updated.length}, unchanged ${report.unchanged}, kept newer local ${report.keptLocal.length}`);
  return report;
}

// ---- Export ----------------------------------------------------------------

/**
 * Write the Keep folder as a Takeout-shaped zip: Takeout/Keep/... with the exact
 * bytes on disk, plus an .html twin per note when html is true.
 */
export async function writeTakeoutZip(store, stream, { html = true } = {}) {
  const zip = new ZipWriter(stream);
  const names = (await readdir(store.keepDir)).filter((n) => !n.endsWith('.tmp')).sort();
  const byStem = new Map([...store.notes.values()].map((e) => [e.stem, e]));
  // Read ahead in parallel batches (per-file latency dominates on Windows), write in order.
  const wanted = names.filter((n) => !n.toLowerCase().endsWith('.html')); // twins are regenerated
  for (let i = 0; i < wanted.length; i += 64) {
    const batch = await mapLimit(wanted.slice(i, i + 64), 16, async (name) => {
      const full = join(store.keepDir, name);
      const st = await stat(full);
      return st.isFile() ? { name, st, data: await readFile(full) } : null;
    });
    for (const f of batch) {
      if (!f) continue;
      const lower = f.name.toLowerCase();
      const compress = lower.endsWith('.json') || lower.endsWith('.txt');
      await zip.add(`Takeout/Keep/${f.name}`, f.data, { mtime: f.st.mtime, compress });
      if (html && lower.endsWith('.json')) {
        const entry = byStem.get(f.name.slice(0, -5));
        if (entry) await zip.add(`Takeout/Keep/${entry.stem}.html`, Buffer.from(renderNoteHtml(entry.note), 'utf8'), { mtime: f.st.mtime });
      }
    }
  }
  await zip.add('Takeout/archive_browser.html', Buffer.from(renderIndexHtml(store), 'utf8'));
  await zip.finish();
}

function renderIndexHtml(store) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rows = [...store.notes.values()]
    .sort((a, b) => Number(b.note.userEditedTimestampUsec) - Number(a.note.userEditedTimestampUsec))
    .map((e) => `<li><a href="Keep/${encodeURIComponent(e.stem)}.html">${esc(e.note.title || '(untitled)')}</a>${e.note.isTrashed ? ' <small>trashed</small>' : e.note.isArchived ? ' <small>archived</small>' : ''}</li>`)
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>GeoKeep export</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2em auto;padding:0 1em;color:#202124}small{color:#5f6368}li{margin:.25em 0}</style></head>
<body><h1>GeoKeep export</h1><p>${store.notes.size} notes, exported ${esc(new Date().toString())}. The <code>.json</code> files in <code>Keep/</code> are the data, in Google Takeout format.</p><ul>
${rows}
</ul></body></html>`;
}

// ---- Snapshots -------------------------------------------------------------

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Zip the Keep folder into data/snapshots. Returns the file name. */
export async function createSnapshot(store, reason = 'manual', keep = Number(process.env.GEOKEEP_SNAPSHOTS || 30)) {
  await mkdir(store.snapshotDir, { recursive: true });
  const name = `geokeep-${stamp()}-${reason.replace(/[^a-z0-9-]/gi, '')}.zip`;
  const tmp = join(store.snapshotDir, `${name}.partial`);
  await store.exclusive(() => writeTakeoutZip(store, createWriteStream(tmp), { html: false }));
  await rename(tmp, join(store.snapshotDir, name));
  const all = (await listSnapshots(store)).map((s) => s.name);
  for (const old of all.slice(keep)) await unlink(join(store.snapshotDir, old)).catch(() => {});
  return name;
}

export async function listSnapshots(store) {
  const out = [];
  for (const name of await readdir(store.snapshotDir).catch(() => [])) {
    if (!/^geokeep-.*\.zip$/.test(name)) continue;
    const st = await stat(join(store.snapshotDir, name));
    out.push({ name, size: st.size, time: st.mtimeMs });
  }
  return out.sort((a, b) => b.time - a.time);
}
