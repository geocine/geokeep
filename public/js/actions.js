// Note operations shared by cards, the editor and the selection bar.

import { state, patchNote, deleteForever, copyNote, attachImage, addLabel, emptyTrash } from './state.js';
import { snackbar, confirmDialog } from './ui.js';
import { blocksFromText, blocksToKeepHtml, noteBlocks, blocksToText } from './richtext.js';

const note = (id) => state.notes.get(id)?.note;
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

/** Patch several notes, then offer Undo that restores their previous values. */
async function patchMany(ids, makePatch, message) {
  const before = [];
  for (const id of ids) {
    const n = note(id);
    if (!n) continue;
    const patch = makePatch(n);
    before.push([id, Object.fromEntries(Object.keys(patch).map((k) => [k, n[k]]))]);
    patchNote(id, patch).catch(() => {});
  }
  if (message) {
    snackbar(message, {
      label: 'Undo',
      onClick: () => { for (const [id, prev] of before) patchNote(id, prev).catch(() => {}); },
    });
  }
}

export function setPinned(ids, on) {
  // Pinning an archived note brings it back, as in Keep.
  return patchMany(ids, (n) => (on && n.isArchived ? { isPinned: true, isArchived: false } : { isPinned: on }),
    ids.length > 1 ? `${ids.length} notes ${on ? 'pinned' : 'unpinned'}` : null);
}

export function setArchived(ids, on) {
  return patchMany(ids, () => (on ? { isArchived: true, isPinned: false } : { isArchived: false }),
    `${ids.length > 1 ? `${ids.length} notes` : 'Note'} ${on ? 'archived' : 'unarchived'}`);
}

export function setTrashed(ids, on) {
  return patchMany(ids, () => ({ isTrashed: on }),
    `${ids.length > 1 ? `${ids.length} notes` : 'Note'} ${on ? 'moved to Trash' : 'restored'}`);
}

export function setColor(ids, color) {
  return patchMany(ids, () => ({ color }), null);
}

export async function deleteNotesForever(ids) {
  const ok = await confirmDialog(`Delete ${ids.length > 1 ? `${ids.length} notes` : 'note'} forever? The ${plural(ids.length, 'file')} will be removed from your data folder. Snapshots made earlier still contain ${ids.length > 1 ? 'them' : 'it'}.`);
  if (!ok) return false;
  await deleteForever(ids);
  snackbar(`${ids.length > 1 ? `${ids.length} notes` : 'Note'} deleted`);
  return true;
}

export async function emptyTrashConfirm() {
  const count = [...state.notes.values()].filter((e) => e.note.isTrashed).length;
  if (!count) return;
  if (!(await confirmDialog(`Empty Trash? All ${count} ${plural(count, 'note')} in Trash will be permanently deleted.`, 'Empty Trash'))) return;
  await emptyTrash();
  snackbar('Trash emptied');
}

export async function makeCopy(id) {
  await copyNote(id);
  snackbar('Note copied');
}

export async function toggleLabel(id, name, on) {
  const n = note(id);
  const labels = (n.labels || []).filter((l) => l.name !== name);
  if (on) labels.push({ name });
  await patchNote(id, { labels });
}

export async function createLabel(name) {
  if (!state.labels.includes(name)) await addLabel(name);
}

/** Check or uncheck a list item; checked items move to the end, like Keep. */
export function toggledList(list, index) {
  const items = list.map((i) => ({ ...i }));
  const [item] = items.splice(index, 1);
  item.isChecked = !item.isChecked;
  const firstChecked = items.findIndex((i) => i.isChecked);
  const at = firstChecked < 0 ? items.length : firstChecked;
  items.splice(at, 0, item);
  return items;
}

export function toggleItem(id, index) {
  const n = note(id);
  return patchNote(id, { listContent: toggledList(n.listContent, index) });
}

/** Keep's "Show checkboxes": each line becomes an item. */
export function textToList(n) {
  const text = n.textContent || '';
  return text ? text.split('\n').map((line) => ({ text: line, isChecked: false })) : [{ text: '', isChecked: false }];
}

/** Keep's "Hide checkboxes": items become lines. */
export function listToText(n) {
  const text = (n.listContent || []).map((i) => i.text).join('\n');
  return { textContent: text, textContentHtml: blocksToKeepHtml(blocksFromText(text)) };
}

export function plainTextOf(n) {
  if (Array.isArray(n.listContent)) return n.listContent.map((i) => `${i.isChecked ? '☑' : '☐'} ${i.text}`).join('\n');
  return blocksToText(noteBlocks(n));
}

export function pickFiles(onFiles) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = () => onFiles([...input.files]);
  input.click();
}

export async function uploadImages(id, files) {
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  for (const f of images) await attachImage(id, f);
}
