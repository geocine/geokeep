// The note store. Its on-disk form is a Google Takeout Keep folder:
//
//   data/Keep/Labels.txt, data/Keep/<stem>.json, data/Keep/<attachment>
//
// so the live data is readable without this app, and any Takeout importer
// (including this one) accepts a plain copy of it. App-only state, the stable
// note ids, lives beside it in data/geokeep.json.

import { mkdir, readdir, readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CONTENT_KEYS, stemForNote, baseStem, uniqueStem, nowUsec, isSafeBasename, newMediaName,
  extForMime, sniffMime, mediaInfo, plainTextToKeepHtml, validatePatch, attachmentKey,
} from './format.js';
import { atomicWrite, unlinkIfExists, readIfExists } from './fsutil.js';

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.keepDir = join(dataDir, 'Keep');
    this.metaFile = join(dataDir, 'geokeep.json');
    this.snapshotDir = join(dataDir, 'snapshots');
    this.tmpDir = join(dataDir, 'tmp');
    this.notes = new Map(); // id -> { id, stem, note }
    // Indexes that keep imports and edits O(1) per note at tens of thousands of notes.
    this.stems = new Set(); // lowercased file stems in use
    this.byCreated = new Map(); // createdTimestampUsec -> Set of entries
    this.labels = [];
    this.media = new Map(); // filePath -> { width, height } | { missing: true } | {}
    this.loadErrors = [];
    this.queue = Promise.resolve();
  }

  /** Run fn with exclusive access; all writes go through here. */
  exclusive(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async init() {
    await mkdir(this.keepDir, { recursive: true });
    await mkdir(this.snapshotDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    await this.exclusive(() => this.#load());
  }

  reload() {
    return this.exclusive(() => this.#load());
  }

  async #load() {
    const metaText = await readIfExists(this.metaFile, 'utf8');
    let ids = {};
    if (metaText) {
      try { ids = JSON.parse(metaText).ids || {}; } catch { /* rebuilt below */ }
    }
    this.notes.clear();
    this.stems.clear();
    this.byCreated.clear();
    this.media.clear();
    this.loadErrors = [];
    const files = (await readdir(this.keepDir)).filter((f) => f.toLowerCase().endsWith('.json'));
    const loaded = new Array(files.length);
    // Read in parallel; insert in directory order afterwards so ids stay stable.
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < files.length; i = next++) {
        try {
          const note = JSON.parse((await readFile(join(this.keepDir, files[i]), 'utf8')).replace(/^\uFEFF/, ''));
          if (!note || typeof note !== 'object' || Array.isArray(note)) throw new Error('not an object');
          loaded[i] = { note };
        } catch (err) {
          loaded[i] = { error: err.message };
        }
      }
    };
    await Promise.all(Array.from({ length: 32 }, worker));
    files.forEach((file, i) => {
      const stem = file.slice(0, -5);
      // A file that does not parse is left alone; it is still in the folder and in every export.
      if (loaded[i].error) { this.loadErrors.push({ file, error: loaded[i].error }); return; }
      const id = ids[stem] || randomUUID();
      const entry = { id, stem, note: loaded[i].note };
      this.notes.set(id, entry);
      this.#index(entry);
    });

    const labelsText = await readIfExists(join(this.keepDir, 'Labels.txt'), 'utf8');
    this.labels = labelsText == null ? [] : parseLabels(labelsText);
    const missing = this.#labelsMissingFromCatalog();
    if (missing.length || labelsText == null) {
      this.labels.push(...missing);
      if (this.labels.length || labelsText != null) await this.#writeLabels();
    }

    await this.#scanMedia([...this.notes.values()].flatMap((e) => (e.note.attachments || []).map((a) => a.filePath)));
    await this.#saveMeta();
  }

  #labelsMissingFromCatalog() {
    const have = new Set(this.labels);
    const out = [];
    for (const { note } of this.notes.values()) {
      for (const l of note.labels || []) {
        if (l && typeof l.name === 'string' && !have.has(l.name)) { have.add(l.name); out.push(l.name); }
      }
    }
    return out;
  }

  async #scanMedia(names) {
    const todo = [...new Set(names)].filter((n) => !this.media.has(n));
    const worker = async () => {
      for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
        if (!isSafeBasename(n)) { this.media.set(n, { missing: true }); continue; }
        try {
          const buf = await readFile(join(this.keepDir, n));
          this.media.set(n, mediaInfo(buf));
        } catch {
          this.media.set(n, { missing: true });
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  #index(entry) {
    if (entry.stem) this.stems.add(entry.stem.toLowerCase());
    const key = Number(entry.note.createdTimestampUsec);
    if (!this.byCreated.has(key)) this.byCreated.set(key, new Set());
    this.byCreated.get(key).add(entry);
  }

  #unindex(entry) {
    if (entry.stem) this.stems.delete(entry.stem.toLowerCase());
    const key = Number(entry.note.createdTimestampUsec);
    const set = this.byCreated.get(key);
    set?.delete(entry);
    if (set && !set.size) this.byCreated.delete(key);
  }

  /** The id map only matters across restarts, so coalesce bursts of writes into one. */
  #saveMetaSoon() {
    clearTimeout(this.metaTimer);
    this.metaTimer = setTimeout(() => this.exclusive(() => this.#saveMeta()).catch((err) => console.error('Saving geokeep.json failed:', err.message)), 300);
  }

  async #saveMeta() {
    clearTimeout(this.metaTimer);
    const ids = {};
    for (const e of this.notes.values()) ids[e.stem] = e.id;
    await atomicWrite(this.metaFile, JSON.stringify({ app: 'geokeep', version: 1, ids }, null, 1));
  }

  async #writeLabels() {
    await atomicWrite(join(this.keepDir, 'Labels.txt'), this.labels.map((l) => `${l}\n`).join(''));
  }

  async #writeNote(entry) {
    await atomicWrite(join(this.keepDir, `${entry.stem}.json`), JSON.stringify(entry.note));
  }

  /** Rename the file when the title changes, so the folder stays browsable. */
  async #placeFile(entry, preferredStem) {
    const desired = preferredStem || stemForNote(entry.note.title, entry.note.createdTimestampUsec);
    const old = entry.stem;
    const untitledKept = !entry.note.title && /^\d{4}-\d\d-\d\dT\d\d_\d\d_\d\d/.test(old || '');
    if (old && (old === desired || baseStem(old) === desired || untitledKept)) {
      await this.#writeNote(entry);
      return;
    }
    if (old) this.stems.delete(old.toLowerCase());
    entry.stem = uniqueStem(desired, this.stems);
    this.stems.add(entry.stem.toLowerCase());
    await this.#writeNote(entry);
    if (old && old.toLowerCase() !== entry.stem.toLowerCase()) {
      await unlinkIfExists(join(this.keepDir, `${old}.json`));
      await unlinkIfExists(join(this.keepDir, `${old}.html`));
    }
  }

  #ensureLabels(note) {
    const have = new Set(this.labels);
    let added = false;
    for (const l of note.labels || []) {
      if (!have.has(l.name)) { this.labels.push(l.name); have.add(l.name); added = true; }
    }
    return added;
  }

  /** Delete attachment files no note points at any more. */
  async #collectGarbage(names) {
    const used = new Set();
    for (const e of this.notes.values()) for (const a of e.note.attachments || []) used.add(a.filePath);
    for (const n of names) {
      if (used.has(n) || !isSafeBasename(n)) continue;
      await unlinkIfExists(join(this.keepDir, n));
      this.media.delete(n);
    }
  }

  // ---- Queries ------------------------------------------------------------

  /**
   * What the browser gets. HTML twins that only restate the plain text are left
   * out (the client rebuilds them, and edits regenerate them), which roughly halves
   * the payload. Files on disk are untouched.
   */
  view(entry) {
    const n = entry.note;
    let note = n;
    if (typeof n.textContentHtml === 'string' && n.textContentHtml === plainTextToKeepHtml(n.textContent ?? '')) {
      note = { ...n };
      delete note.textContentHtml;
    }
    if (Array.isArray(n.listContent) && n.listContent.some((i) => i.textHtml === plainTextToKeepHtml(i.text))) {
      if (note === n) note = { ...n };
      note.listContent = n.listContent.map((i) => {
        if (i.textHtml !== plainTextToKeepHtml(i.text)) return i;
        const { textHtml, ...rest } = i;
        return rest;
      });
    }
    return { id: entry.id, stem: entry.stem, note };
  }

  state() {
    return {
      labels: this.labels,
      notes: [...this.notes.values()].map((e) => this.view(e)),
      media: Object.fromEntries(this.media),
      loadErrors: this.loadErrors,
      dataDir: this.dataDir,
    };
  }

  get(id) {
    const entry = this.notes.get(id);
    if (!entry) throw Object.assign(new Error('Note not found'), { status: 404 });
    return entry;
  }

  // ---- Note edits ---------------------------------------------------------

  createNote(fields = {}) {
    return this.exclusive(async () => {
      validatePatch(fields);
      const now = nowUsec();
      const note = {
        color: 'DEFAULT', isTrashed: false, isPinned: false, isArchived: false,
        title: '', userEditedTimestampUsec: now, createdTimestampUsec: now,
      };
      const entry = { id: randomUUID(), stem: '', note: applyPatch(note, fields, { touch: false }) };
      if (!('listContent' in entry.note) && !('textContent' in entry.note)) entry.note.textContent = '';
      if (this.#ensureLabels(entry.note)) await this.#writeLabels();
      this.notes.set(entry.id, entry);
      await this.#placeFile(entry);
      this.#index(entry);
      this.#saveMetaSoon();
      return this.view(entry);
    });
  }

  updateNote(id, patch) {
    return this.exclusive(async () => {
      validatePatch(patch);
      const entry = this.get(id);
      const before = (entry.note.attachments || []).map((a) => a.filePath);
      entry.note = applyPatch(entry.note, patch, { touch: true });
      if (this.#ensureLabels(entry.note)) await this.#writeLabels();
      const oldStem = entry.stem;
      await this.#placeFile(entry);
      if (oldStem !== entry.stem) this.#saveMetaSoon();
      if ('attachments' in patch) {
        await this.#collectGarbage(before);
        await this.#scanMedia(entry.note.attachments?.map((a) => a.filePath) || []);
      }
      return this.view(entry);
    });
  }

  deleteNote(id) {
    return this.exclusive(() => this.#deleteNote(id));
  }

  async #deleteNote(id) {
    const entry = this.get(id);
    this.#unindex(entry);
    this.notes.delete(id);
    await unlinkIfExists(join(this.keepDir, `${entry.stem}.json`));
    await unlinkIfExists(join(this.keepDir, `${entry.stem}.html`));
    await this.#collectGarbage((entry.note.attachments || []).map((a) => a.filePath));
    this.#saveMetaSoon();
  }

  emptyTrash() {
    return this.exclusive(async () => {
      const ids = [...this.notes.values()].filter((e) => e.note.isTrashed).map((e) => e.id);
      for (const id of ids) await this.#deleteNote(id);
      return ids.length;
    });
  }

  copyNote(id) {
    return this.exclusive(async () => {
      const src = this.get(id).note;
      const now = nowUsec();
      const note = structuredClone(src);
      note.createdTimestampUsec = note.userEditedTimestampUsec = now;
      note.isTrashed = false;
      note.isPinned = false;
      if (note.attachments) {
        for (const a of note.attachments) {
          const ext = a.filePath.split('.').pop();
          const name = newMediaName(ext);
          try {
            await copyFile(join(this.keepDir, a.filePath), join(this.keepDir, name));
            a.filePath = name;
          } catch { /* dangling source: keep the reference as it was */ }
        }
        await this.#scanMedia(note.attachments.map((a) => a.filePath));
      }
      const entry = { id: randomUUID(), stem: '', note };
      this.notes.set(entry.id, entry);
      await this.#placeFile(entry);
      this.#index(entry);
      this.#saveMetaSoon();
      return this.view(entry);
    });
  }

  addAttachment(id, buf, mimeHint) {
    return this.exclusive(async () => {
      const entry = this.get(id);
      const mimetype = sniffMime(buf) || String(mimeHint || '').split(';')[0].trim().toLowerCase();
      if (!mimetype.startsWith('image/')) throw Object.assign(new Error('Only images can be attached'), { status: 415 });
      const name = newMediaName(extForMime(mimetype));
      await atomicWrite(join(this.keepDir, name), buf);
      this.media.set(name, mediaInfo(buf));
      entry.note = applyPatch(entry.note, { attachments: [...(entry.note.attachments || []), { filePath: name, mimetype }] }, { touch: true });
      await this.#placeFile(entry);
      return this.view(entry);
    });
  }

  // ---- Labels -------------------------------------------------------------

  addLabel(name) {
    return this.exclusive(async () => {
      name = cleanLabel(name);
      if (this.labels.some((l) => l.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error('Label already exists'), { status: 409 });
      this.labels.push(name);
      await this.#writeLabels();
      return this.labels;
    });
  }

  renameLabel(from, to) {
    return this.exclusive(async () => {
      to = cleanLabel(to);
      if (!this.labels.includes(from)) throw Object.assign(new Error('Label not found'), { status: 404 });
      const merging = this.labels.some((l) => l === to && l !== from);
      this.labels = merging ? this.labels.filter((l) => l !== from) : this.labels.map((l) => (l === from ? to : l));
      await this.#writeLabels();
      await this.#rewriteLabelsOnNotes((names) => [...new Set(names.map((n) => (n === from ? to : n)))]);
      return this.labels;
    });
  }

  deleteLabel(name) {
    return this.exclusive(async () => {
      this.labels = this.labels.filter((l) => l !== name);
      await this.#writeLabels();
      await this.#rewriteLabelsOnNotes((names) => names.filter((n) => n !== name));
      return this.labels;
    });
  }

  async #rewriteLabelsOnNotes(map) {
    for (const entry of this.notes.values()) {
      const names = (entry.note.labels || []).map((l) => l.name);
      const next = map(names);
      if (next.join('\n') === names.join('\n')) continue;
      // A label rename is not an edit of the note, so the edited time stays.
      entry.note = applyPatch(entry.note, { labels: next.map((name) => ({ name })) }, { touch: false });
      await this.#writeNote(entry);
    }
  }

  // ---- Import support -----------------------------------------------------

  /** Find the stored note an incoming Takeout note corresponds to. */
  findMatch(incoming, claimed) {
    const created = Number(incoming.createdTimestampUsec);
    const cands = [...(this.byCreated.get(created) || [])].filter((e) => !claimed.has(e.id));
    if (!cands.length) return null;
    const key = attachmentKey(incoming);
    let best = null;
    let bestScore = 0;
    for (const e of cands) {
      const score = (Number(e.note.userEditedTimestampUsec) === Number(incoming.userEditedTimestampUsec) ? 4 : 0) +
        (e.note.title === incoming.title ? 2 : 0) + (attachmentKey(e.note) === key ? 1 : 0);
      if (score > bestScore) { best = e; bestScore = score; }
    }
    return best;
  }

  /** Used by the importer inside exclusive(); does not take the lock. */
  async putImported(entry, note, preferredStem) {
    if (entry) {
      this.#unindex(entry);
      entry.note = note;
    } else {
      entry = { id: randomUUID(), stem: '', note };
      this.notes.set(entry.id, entry);
    }
    this.#ensureLabels(note);
    await this.#placeFile(entry, entry.stem ? undefined : preferredStem);
    this.#index(entry);
    return entry;
  }

  /** Append catalog names in their Labels.txt order, before notes add their own. */
  mergeLabels(names) {
    const have = new Set(this.labels);
    for (const l of names) if (!have.has(l)) { this.labels.push(l); have.add(l); }
  }

  /** Register a new imported note under a free file name; the file is written by writeEntry. */
  stageImported(note, preferredStem) {
    const entry = { id: randomUUID(), stem: uniqueStem(preferredStem || stemForNote(note.title, note.createdTimestampUsec), this.stems), note };
    this.notes.set(entry.id, entry);
    this.#ensureLabels(note);
    this.#index(entry);
    return entry;
  }

  writeEntry(entry) {
    return this.#writeNote(entry);
  }

  async finishImport() {
    await this.#writeLabels();
    await this.#saveMeta();
    await this.#scanMedia([...this.notes.values()].flatMap((e) => (e.note.attachments || []).map((a) => a.filePath)));
  }
}

export function parseLabels(text) {
  const seen = new Set();
  const out = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const name = line.trim();
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

function cleanLabel(name) {
  name = String(name ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!name) throw Object.assign(new Error('Label name is empty'), { status: 400 });
  if (name.length > 50) throw Object.assign(new Error('Label names are limited to 50 characters'), { status: 400 });
  return name;
}

/**
 * Merge an edit into a Takeout-shaped note, keeping key order and unknown keys,
 * and keeping text/list exclusive and empty collections omitted like Takeout does.
 */
export function applyPatch(note, patch, { touch }) {
  const next = { ...note };
  for (const [k, v] of Object.entries(patch)) next[k] = v;

  if ('listContent' in patch) {
    delete next.textContent;
    delete next.textContentHtml;
    next.listContent = patch.listContent.map((item) => ({
      textHtml: typeof item.textHtml === 'string' ? item.textHtml : plainTextToKeepHtml(item.text),
      text: item.text,
      isChecked: Boolean(item.isChecked),
    }));
  } else if ('textContent' in patch) {
    delete next.listContent;
    if (!('textContentHtml' in patch)) next.textContentHtml = plainTextToKeepHtml(patch.textContent);
  }
  if (typeof next.textContent === 'string' && next.textContent === '') delete next.textContentHtml;

  for (const key of ['labels', 'attachments', 'annotations']) {
    if (Array.isArray(next[key]) && next[key].length === 0) delete next[key];
  }
  if (next.labels) {
    const seen = new Set();
    next.labels = next.labels.filter((l) => !seen.has(l.name) && seen.add(l.name)).map((l) => ({ name: l.name }));
  }

  if (touch && CONTENT_KEYS.some((k) => JSON.stringify(note[k]) !== JSON.stringify(next[k]))) {
    next.userEditedTimestampUsec = Math.max(nowUsec(), Number(note.userEditedTimestampUsec || 0) + 1);
  }
  return next;
}
