// Client-side copy of the store, with optimistic edits.

import { api } from './api.js';

export const state = {
  notes: new Map(), // id -> { id, stem, note }
  labels: [],
  media: {},
  dataDir: '',
  loadErrors: [],
  loaded: false,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit() {
  for (const fn of listeners) fn();
}

let errorHandler = (err) => console.error(err);
export function onError(fn) {
  errorHandler = fn;
}

function ingest(data) {
  state.notes = new Map(data.notes.map((e) => [e.id, e]));
  state.labels = data.labels;
  state.media = data.media || {};
  state.dataDir = data.dataDir || state.dataDir;
  state.loadErrors = data.loadErrors || [];
  state.loaded = true;
}

export async function load() {
  ingest(await api.state());
  emit();
}

export async function reloadFromDisk() {
  ingest(await api.reload());
  emit();
}

// Writes for one note run in order, so a fast sequence of edits lands in order.
const chains = new Map();
function chain(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(id, next);
  next.finally(() => { if (chains.get(id) === next) chains.delete(id); });
  return next;
}

/** Local mirror of the server's patch rules, for instant feedback. */
function applyLocal(note, patch) {
  const next = { ...note, ...patch };
  if ('listContent' in patch) { delete next.textContent; delete next.textContentHtml; }
  else if ('textContent' in patch) delete next.listContent;
  for (const k of ['labels', 'attachments', 'annotations']) if (Array.isArray(next[k]) && !next[k].length) delete next[k];
  return next;
}

function remember(entry) {
  state.notes.set(entry.id, entry);
  return entry;
}

/** Edit a note. Returns the server's version. */
export function patchNote(id, patch, { silent = false } = {}) {
  const entry = state.notes.get(id);
  if (!entry) return Promise.reject(new Error('Note not found'));
  entry.note = applyLocal(entry.note, patch);
  if (!silent) emit();
  return chain(id, async () => {
    try {
      const saved = remember(await api.patch(id, patch));
      if (!silent) emit();
      return saved;
    } catch (err) {
      errorHandler(err);
      await load().catch(() => {});
      throw err;
    }
  });
}

export async function createNote(fields) {
  const entry = remember(await api.create(fields));
  emit();
  return entry;
}

export async function deleteForever(ids) {
  for (const id of ids) {
    await chain(id, () => api.remove(id));
    state.notes.delete(id);
  }
  emit();
}

export async function emptyTrash() {
  await api.emptyTrash();
  for (const [id, e] of state.notes) if (e.note.isTrashed) state.notes.delete(id);
  emit();
}

export async function copyNote(id) {
  const entry = remember(await chain(id, () => api.copy(id)));
  await refreshMedia();
  emit();
  return entry;
}

export async function attachImage(id, file) {
  const entry = remember(await chain(id, () => api.attach(id, file)));
  await refreshMedia();
  emit();
  return entry;
}

async function refreshMedia() {
  const data = await api.state();
  state.media = data.media;
}

export async function addLabel(name) {
  state.labels = (await api.addLabel(name)).labels;
  emit();
}

export async function renameLabel(from, to) {
  ingest(await api.renameLabel(from, to));
  emit();
}

export async function deleteLabel(name) {
  ingest(await api.deleteLabel(name));
  emit();
}

/** Note ids in a label, for counts. */
export function labelCount(name) {
  let n = 0;
  for (const e of state.notes.values()) if (!e.note.isTrashed && e.note.labels?.some((l) => l.name === name)) n++;
  return n;
}
