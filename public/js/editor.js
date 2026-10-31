// The note editor: a modal for existing notes, inline for the "Take a note…" composer.

import { h, iconBtn, colorVar, debounce, isList, noteIsEmpty, editedLabel, fullDate, safeUrl, hostOf, mediaUrl, linksIn, linkAt } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { state, patchNote, createNote, emit } from './state.js';
import { noteBlocks, renderBlocks, parseNode, blocksToText, blocksToKeepHtml } from './richtext.js';
import { openColorPicker, openMenu, openLabelPicker, openLightbox, pushLayer, snackbar } from './ui.js';
import { aspectOf, linkThumb } from './card.js';
import * as A from './actions.js';
import { openDrawing, readInk } from './drawing.js';

document.execCommand('defaultParagraphSeparator', false, 'p');
document.execCommand('styleWithCSS', false, false);

let openEditorInstance = null;
export const currentEditor = () => openEditorInstance;

// Link previews the user removed, per note, so they are not fetched again.
const DISMISSED_KEY = 'gk-dismissed-previews';
function dismissedPreviews() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')); } catch { return new Set(); }
}
function rememberDismissed(key) {
  try {
    const all = [...dismissedPreviews(), key].slice(-5000);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(all));
  } catch { /* private mode: previews may come back */ }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

/**
 * opts: { id } to edit a stored note, or { list, labels } for a new one.
 * inline: mount into `slot` instead of a modal.
 */
export class NoteEditor {
  constructor(opts) {
    this.opts = opts;
    this.id = opts.id || null;
    const src = this.id && state.notes.get(this.id)?.note;
    this.original = src ? JSON.stringify(src) : null;
    this.work = src ? structuredClone(src) : {
      title: '', color: 'DEFAULT', isPinned: false, isArchived: false, isTrashed: false,
      ...(opts.list ? { listContent: [{ text: '', isChecked: false }] } : { textContent: '' }),
      ...(opts.labels?.length ? { labels: opts.labels.map((name) => ({ name })) } : {}),
    };
    this.readOnly = !!this.work.isTrashed;
    // Each visitable link gets a preview, like Keep; each is tried once per session,
    // and a preview the user removed is remembered and not added again.
    this.knownLinks = new Set();
    this.dirty = new Set();
    this.pending = Promise.resolve();
    this.checkedCollapsed = false;
    this.save = debounce(() => this.flush(), 500);
    this.build();
  }

  // ---- Persistence ---------------------------------------------------------

  markDirty(part) {
    this.dirty.add(part);
    this.save();
  }

  /** Pull text from the DOM into this.work and send what changed. */
  flush() {
    this.save.cancel();
    if (!this.dirty.size) return this.pending;
    const patch = {};
    if (this.dirty.has('title')) patch.title = this.work.title;
    if (this.dirty.has('body') && this.bodyEl) {
      const blocks = parseNode(this.bodyEl);
      const text = blocksToText(blocks);
      this.work.textContent = text;
      this.work.textContentHtml = blocksToKeepHtml(blocks);
      patch.textContent = text;
      if (text) patch.textContentHtml = this.work.textContentHtml;
    }
    if (this.dirty.has('list')) patch.listContent = this.listPayload();
    this.dirty.clear();
    this.pending = this.pending.then(() => this.persist(patch)).catch((err) => snackbar(`Could not save: ${err.message}`));
    return this.pending;
  }

  listPayload() {
    return this.work.listContent.map((i) => (typeof i.textHtml === 'string'
      ? { textHtml: i.textHtml, text: i.text, isChecked: i.isChecked }
      : { text: i.text, isChecked: !!i.isChecked }));
  }

  fullFields() {
    const w = this.work;
    const out = { title: w.title, color: w.color, isPinned: w.isPinned, isArchived: w.isArchived };
    if (isList(w)) out.listContent = this.listPayload();
    else {
      out.textContent = w.textContent || '';
      if (w.textContent && w.textContentHtml) out.textContentHtml = w.textContentHtml;
    }
    if (w.labels?.length) out.labels = w.labels;
    return out;
  }

  async persist(patch, { force = false } = {}) {
    if (this.id) {
      if (Object.keys(patch).length) await patchNote(this.id, patch, { silent: true });
    } else {
      const fields = this.fullFields();
      if (!force && noteIsEmpty(fields)) return;
      const entry = await createNote(fields);
      this.id = entry.id;
    }
    this.syncFromState();
    this.addLinkPreviews();
  }

  /** Fetch previews for links that have none; unreachable links get none, like Keep. */
  async addLinkPreviews() {
    if (!state.config?.linkPreviews || !this.id || this.readOnly) return;
    const have = new Set((this.work.annotations || []).map((a) => a.url));
    const dismissed = dismissedPreviews();
    const fresh = linksIn(this.work).filter((u) => !this.knownLinks.has(u) && !have.has(u) && !dismissed.has(`${this.id}|${u}`));
    for (const u of fresh) this.knownLinks.add(u);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < fresh.length; i = next++) {
        const url = fresh[i];
        let preview;
        try { preview = await api.unfurl(url); } catch { continue; }
        const annotations = [...(this.work.annotations || []), { description: preview.description || '', source: 'WEBLINK', title: preview.title || hostOf(url), url }];
        this.work.annotations = annotations;
        this.renderLinks();
        await patchNote(this.id, { annotations }, { silent: !this.closing }).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, fresh.length) }, worker));
  }

  /** Make sure the note exists on the server (for image uploads on a new note). */
  async ensureCreated() {
    await this.flush();
    if (!this.id) {
      this.pending = this.pending.then(() => this.persist({}, { force: true }));
      await this.pending;
    }
    return this.id;
  }

  syncFromState() {
    const n = this.id && state.notes.get(this.id)?.note;
    if (!n) return;
    this.work.userEditedTimestampUsec = n.userEditedTimestampUsec;
    this.work.createdTimestampUsec = n.createdTimestampUsec;
    this.work.attachments = n.attachments;
    this.work.annotations = n.annotations;
    this.renderMeta();
  }

  /** Apply a flag change locally and, for stored notes, on the server. */
  setFlags(patch, action) {
    Object.assign(this.work, patch);
    if (this.id && action) action();
    this.refresh();
  }

  // ---- DOM -----------------------------------------------------------------

  build() {
    this.el = h('div', { class: 'editor', style: { '--note-bg': colorVar(this.work.color) } });
    this.imagesEl = h('div');
    this.titleEl = h('textarea', {
      class: 'editor-title', placeholder: 'Title', rows: 1, readOnly: this.readOnly, maxLength: 999, spellcheck: true,
      oninput: () => { this.work.title = this.titleEl.value.replace(/\n/g, ' '); autosize(this.titleEl); this.markDirty('title'); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.focusContent(); } },
      onclick: (e) => { if (e.ctrlKey || e.metaKey) this.openLinkAtCaret(); },
    });
    this.titleEl.value = this.work.title || '';
    this.pinBtn = h('button', { type: 'button', class: 'icon-btn', onclick: () => this.togglePin() });
    this.contentEl = h('div');
    this.chipsEl = h('div');
    this.linksEl = h('div');
    this.metaEl = h('div', { class: 'editor-meta' });
    this.scrollEl = h('div', { class: 'editor-scroll' },
      this.imagesEl,
      this.readOnly ? h('div', { class: 'trash-note' }, "Can't edit in Trash") : null,
      h('div', { class: 'editor-head' }, this.titleEl, this.readOnly ? null : this.pinBtn),
      this.contentEl, this.chipsEl, this.linksEl, this.metaEl);
    this.formatBar = h('div', { class: 'format-bar', hidden: true, onmousedown: (e) => e.preventDefault() });
    this.toolbarEl = h('div', { class: 'editor-toolbar' });
    this.el.append(this.scrollEl, this.formatBar, this.toolbarEl);

    this.el.addEventListener('dragover', (e) => { if (!this.readOnly && e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    this.el.addEventListener('drop', (e) => {
      if (this.readOnly || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      this.addImages([...e.dataTransfer.files]);
    });
    this.scrollEl.addEventListener('scroll', () => {
      this.el.classList.toggle('scrolled', this.scrollEl.scrollTop > 0);
      this.hideLinkBubble();
    });

    // "Open link" bubble for the link under the caret, in the title, body or a list item.
    this.linkBubble = h('a', { class: 'link-bubble', target: '_blank', rel: 'noopener noreferrer', hidden: true, onmousedown: (e) => e.preventDefault() });
    this.el.append(this.linkBubble);
    const check = () => requestAnimationFrame(() => this.updateLinkBubble());
    for (const ev of ['keyup', 'click', 'input', 'focusin']) this.el.addEventListener(ev, check);
    this.el.addEventListener('focusout', () => setTimeout(() => {
      if (!this.el.contains(document.activeElement)) this.hideLinkBubble();
    }, 150));

    this.renderContent();
    this.refresh();
  }

  /** The link at the caret and the box to show the bubble under, or null. */
  linkAtCaret() {
    const active = document.activeElement;
    if (active?.tagName === 'TEXTAREA' && this.el.contains(active)) {
      const url = linkAt(active.value, active.selectionStart);
      return url ? { url, rect: active.getBoundingClientRect() } : null;
    }
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (this.bodyEl && node?.nodeType === 3 && this.bodyEl.contains(node)) {
      const url = linkAt(node.data, sel.anchorOffset);
      if (!url) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...sel.getRangeAt(0).getClientRects()];
      return { url, rect: rects[0] || range.getBoundingClientRect() };
    }
    return null;
  }

  updateLinkBubble() {
    const hit = this.linkAtCaret();
    if (!hit) { this.hideLinkBubble(); return; }
    const box = this.el.getBoundingClientRect();
    this.linkBubble.href = hit.url;
    this.linkBubble.replaceChildren(icon('openNew', 'sm'), h('span', null, `Open ${hostOf(hit.url)}`));
    this.linkBubble.hidden = false;
    const left = Math.min(Math.max(8, hit.rect.left - box.left), box.width - this.linkBubble.offsetWidth - 8);
    this.linkBubble.style.left = `${left}px`;
    this.linkBubble.style.top = `${hit.rect.bottom - box.top + 4}px`;
  }

  hideLinkBubble() {
    if (this.linkBubble) this.linkBubble.hidden = true;
  }

  openLinkAtCaret() {
    const hit = this.linkAtCaret();
    if (hit) window.open(hit.url, '_blank', 'noopener,noreferrer');
  }

  refresh() {
    this.el.style.setProperty('--note-bg', colorVar(this.work.color));
    this.pinBtn.replaceChildren(icon(this.work.isPinned ? 'pinFilled' : 'pin'));
    this.pinBtn.dataset.tip = this.work.isPinned ? 'Unpin note' : 'Pin note';
    this.pinBtn.setAttribute('aria-label', this.pinBtn.dataset.tip);
    this.renderImages();
    this.renderChips();
    this.renderLinks();
    this.renderMeta();
    this.renderToolbar();
  }

  renderContent() {
    this.formatBar.hidden = true;
    if (isList(this.work)) {
      this.bodyEl = null;
      this.listEl = h('div', { class: 'list-editor' });
      this.contentEl.replaceChildren(this.listEl);
      this.renderList();
    } else {
      this.listEl = null;
      this.bodyEl = h('div', {
        class: 'editor-body rt', contentEditable: this.readOnly ? 'false' : 'true', 'data-placeholder': 'Take a note…',
        role: 'textbox', 'aria-multiline': 'true', spellcheck: true,
      });
      if (this.work.textContent) this.bodyEl.append(renderBlocks(noteBlocks(this.work), { linkify: false }));
      this.bodyEl.addEventListener('input', () => {
        if (!this.bodyEl.textContent && !this.bodyEl.querySelector('h1,h2')) this.bodyEl.replaceChildren();
        this.markDirty('body');
      });
      this.bodyEl.addEventListener('paste', (e) => this.onPaste(e));
      this.bodyEl.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) this.openLinkAtCaret();
      });
      this.contentEl.replaceChildren(this.bodyEl);
    }
  }

  onPaste(e) {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      this.addImages(files);
      return;
    }
    const text = e.clipboardData?.getData('text/plain');
    if (text != null) {
      e.preventDefault();
      document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n'));
    }
  }

  focusContent() {
    if (this.bodyEl) {
      this.bodyEl.focus();
      const sel = window.getSelection();
      sel.selectAllChildren(this.bodyEl);
      sel.collapseToEnd();
    } else {
      const first = this.listEl?.querySelector('textarea');
      first?.focus();
    }
  }

  renderImages() {
    const atts = this.work.attachments || [];
    if (!atts.length) { this.imagesEl.replaceChildren(); return; }
    const urls = atts.map((a) => mediaUrl(a.filePath));
    this.imagesEl.replaceChildren(h('div', { class: `editor-images${atts.length === 1 ? ' single' : ''}` }, atts.map((a, i) => {
      const missing = state.media[a.filePath]?.missing;
      const img = missing ? h('div', { class: 'broken' }, icon('brokenImage', 'sm'), `Missing: ${a.filePath}`) : h('img', { src: urls[i], alt: '', draggable: false });
      if (!missing && atts.length === 1) img.style.aspectRatio = aspectOf(a.filePath);
      // Drawings reopen in the drawing editor, as in Keep; other images open full size.
      const open = () => {
        if (missing) return;
        if (state.media[a.filePath]?.ink && !this.readOnly) this.editDrawing(a.filePath);
        else openLightbox(urls, i);
      };
      return h('div', { class: 'img-wrap', onclick: open }, img,
        this.readOnly ? null : iconBtn('trash', 'Remove image', (e) => { e.stopPropagation(); this.removeImage(a.filePath); }, 'sm img-del'));
    })));
  }

  async addImages(files) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) { snackbar('Only images can be added to a note'); return; }
    try {
      const id = await this.ensureCreated();
      await A.uploadImages(id, images);
      this.syncFromState();
      this.renderImages();
    } catch (err) {
      snackbar(`Upload failed: ${err.message}`);
    }
  }

  /** Open the drawing editor for a new drawing on this note. */
  addDrawing() {
    openDrawing({
      onDone: async ({ blob }) => { if (blob) await this.addImages([blob]); },
      onNew: () => this.addDrawing(),
    });
  }

  /** Re-edit a drawing; the new PNG takes the old one's place in the attachment list. */
  async editDrawing(filePath) {
    let ink = null;
    try { ink = await readInk(mediaUrl(filePath)); } catch { /* fall through to the viewer */ }
    if (!ink) { openLightbox([mediaUrl(filePath)]); return; }
    openDrawing({
      ink,
      onNew: () => this.addDrawing(),
      onDone: async ({ blob, deleted, empty }) => {
        if (deleted || empty) {
          this.removeImage(filePath);
          snackbar('Drawing deleted');
          return;
        }
        try {
          const before = new Set((this.work.attachments || []).map((a) => a.filePath));
          await A.uploadImages(this.id, [blob]);
          const added = state.notes.get(this.id).note.attachments.find((a) => !before.has(a.filePath));
          const attachments = (this.work.attachments || []).map((a) => (a.filePath === filePath ? added : a));
          await patchNote(this.id, { attachments });
          this.syncFromState();
          this.renderImages();
        } catch (err) {
          snackbar(`Could not save drawing: ${err.message}`);
        }
      },
    });
  }

  removeImage(filePath) {
    const attachments = (this.work.attachments || []).filter((a) => a.filePath !== filePath);
    this.work.attachments = attachments;
    this.renderImages();
    if (this.id) patchNote(this.id, { attachments }).then(() => this.syncFromState()).catch(() => {});
  }

  renderChips() {
    const labels = this.work.labels || [];
    this.chipsEl.replaceChildren(labels.length ? h('div', { class: 'chips' }, labels.map((l) => h('span', { class: `chip${this.readOnly ? '' : ' removable'}` },
      h('span', null, l.name),
      this.readOnly ? null : h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove label ${l.name}`, onclick: () => this.toggleLabel(l.name, false) }, icon('close'))))) : '');
  }

  renderLinks() {
    const anns = this.work.annotations || [];
    this.linksEl.replaceChildren(anns.length ? h('div', { class: 'links' }, anns.map((a, i) => {
      const href = safeUrl(a.url);
      // The whole preview opens the page when the link is real.
      return h('div', { class: 'link' },
        h(href ? 'a' : 'div', { class: 'link-main', href, target: '_blank', rel: 'noopener noreferrer', 'data-tip': href ? `Open ${a.url}` : null },
          linkThumb(a.url),
          h('div', { class: 'link-text' },
            h('div', { class: 'link-title' }, a.title || a.url),
            h('div', { class: 'link-host' }, hostOf(a.url)),
            a.description ? h('div', { class: 'link-desc' }, a.description) : null)),
        this.readOnly ? null : iconBtn('close', 'Remove link preview', () => this.removeLink(i), 'sm'));
    })) : '');
  }

  removeLink(index) {
    const removed = this.work.annotations?.[index];
    if (removed?.url && this.id) rememberDismissed(`${this.id}|${removed.url}`);
    const annotations = (this.work.annotations || []).filter((_, i) => i !== index);
    this.work.annotations = annotations;
    this.renderLinks();
    if (this.id) patchNote(this.id, { annotations }, { silent: true }).catch(() => {});
  }

  renderMeta() {
    const w = this.work;
    if (!this.id) { this.metaEl.replaceChildren(); return; }
    const parts = [];
    if (w.isArchived) parts.push('Archived');
    this.metaEl.replaceChildren(h('span', { 'data-tip': `Created ${fullDate(w.createdTimestampUsec)}` },
      [...parts, editedLabel(w.userEditedTimestampUsec)].join(' · ')));
  }

  renderToolbar() {
    const w = this.work;
    let tools;
    if (this.readOnly) {
      tools = [
        iconBtn('deleteForever', 'Delete forever', async () => { if (await A.deleteNotesForever([this.id])) this.close({ discard: true }); }),
        iconBtn('restore', 'Restore', () => { A.setTrashed([this.id], false); this.close(); }),
      ];
    } else {
      tools = [
        !isList(w) ? iconBtn('textFormat', 'Formatting options', () => this.toggleFormatBar(), 'sm') : null,
        iconBtn('palette', 'Background options', (e) => openColorPicker(e.currentTarget, w.color, (color) => this.setFlags({ color }, () => A.setColor([this.id], color))), 'sm'),
        iconBtn('image', 'Add image', () => A.pickFiles((files) => this.addImages(files)), 'sm'),
        iconBtn(w.isArchived ? 'unarchive' : 'archive', w.isArchived ? 'Unarchive' : 'Archive', () => this.toggleArchive(), 'sm'),
        iconBtn('more', 'More', (e) => openMenu(e.currentTarget, [
          { label: this.id ? 'Delete note' : 'Discard', onClick: () => this.trash() },
          { label: w.labels?.length ? 'Change labels' : 'Add label', onClick: () => this.openLabels() },
          { label: 'Add drawing', onClick: () => this.addDrawing() },
          ...(this.id ? [{ label: 'Make a copy', onClick: async () => { await this.flush(); await this.pending; A.makeCopy(this.id); } }] : []),
          { label: isList(w) ? 'Hide checkboxes' : 'Show checkboxes', onClick: () => this.toggleCheckboxes() },
          ...(isList(w) && w.listContent.some((i) => i.isChecked) ? [
            { label: 'Uncheck all items', onClick: () => this.setAllChecked(false) },
            { label: 'Delete checked items', onClick: () => this.deleteChecked() },
          ] : []),
          { label: 'Copy text to clipboard', onClick: () => { this.flush(); navigator.clipboard?.writeText([w.title, A.plainTextOf(this.work)].filter(Boolean).join('\n\n')); } },
        ]), 'sm'),
        // Undo/redo act on the focused field; mousedown is cancelled so focus stays there.
        h('button', { type: 'button', class: 'icon-btn sm', 'data-tip': 'Undo', 'aria-label': 'Undo', onmousedown: (e) => e.preventDefault(), onclick: () => document.execCommand('undo') }, icon('undo')),
        h('button', { type: 'button', class: 'icon-btn sm', 'data-tip': 'Redo', 'aria-label': 'Redo', onmousedown: (e) => e.preventDefault(), onclick: () => document.execCommand('redo') }, icon('redo')),
      ];
    }
    // Phones: Keep puts the toolbar on top with a close (×) first; CSS shows this button there.
    const mobileClose = iconBtn('close', 'Close', () => this.close(), 'sm mobile-close');
    this.toolbarEl.replaceChildren(mobileClose, ...tools.filter(Boolean), h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'text-btn', onclick: () => this.close() }, 'Close'));
  }

  toggleFormatBar() {
    if (!this.formatBar.hidden) { this.formatBar.hidden = true; return; }
    const cmd = (name, value) => () => {
      this.bodyEl.focus();
      document.execCommand(name, false, value);
      this.markDirty('body');
    };
    const txt = (label, tip, fn) => h('button', { type: 'button', class: 'icon-btn sm fmt-text', 'data-tip': tip, onclick: fn }, label);
    this.formatBar.replaceChildren(
      txt('H1', 'Heading 1', cmd('formatBlock', 'h1')),
      txt('H2', 'Heading 2', cmd('formatBlock', 'h2')),
      txt('Normal', 'Normal text', cmd('formatBlock', 'p')),
      h('span', { class: 'sep' }),
      iconBtn('bold', 'Bold (Ctrl+B)', cmd('bold'), 'sm'),
      iconBtn('italic', 'Italic (Ctrl+I)', cmd('italic'), 'sm'),
      iconBtn('underline', 'Underline (Ctrl+U)', cmd('underline'), 'sm'),
      iconBtn('clearFormat', 'Clear formatting', () => { cmd('removeFormat')(); cmd('formatBlock', 'p')(); }, 'sm'),
    );
    this.formatBar.hidden = false;
  }

  // ---- Flags & menus ---------------------------------------------------------

  togglePin() {
    const on = !this.work.isPinned;
    this.setFlags(on && this.work.isArchived ? { isPinned: true, isArchived: false } : { isPinned: on }, () => A.setPinned([this.id], on));
  }

  async toggleArchive() {
    const on = !this.work.isArchived;
    if (this.id) {
      await this.flush();
      await this.pending;
      A.setArchived([this.id], on);
      Object.assign(this.work, on ? { isArchived: true, isPinned: false } : { isArchived: false });
      this.close();
    } else {
      Object.assign(this.work, { isArchived: on, isPinned: false });
      this.close();
    }
  }

  async trash() {
    if (!this.id) { this.close({ discard: true }); return; }
    await this.flush();
    await this.pending;
    A.setTrashed([this.id], true);
    this.close({ discard: true });
  }

  async toggleLabel(name, on) {
    const labels = (this.work.labels || []).filter((l) => l.name !== name);
    if (on) labels.push({ name });
    this.work.labels = labels;
    this.renderChips();
    if (this.id) await patchNote(this.id, { labels }, { silent: true }).then(() => this.syncFromState()).catch(() => {});
  }

  openLabels() {
    openLabelPicker(this.toolbarEl, {
      labels: () => state.labels,
      has: (name) => !!this.work.labels?.some((l) => l.name === name),
      onToggle: (name, on) => this.toggleLabel(name, on),
      onCreate: async (name) => { await A.createLabel(name); await this.toggleLabel(name, true); },
    });
  }

  toggleCheckboxes() {
    if (isList(this.work)) {
      this.dirty.delete('list');
      const { textContent, textContentHtml } = A.listToText(this.work);
      delete this.work.listContent;
      Object.assign(this.work, { textContent, textContentHtml });
      this.renderContent();
      this.markDirty('body');
    } else {
      this.flush();
      const listContent = A.textToList(this.work);
      delete this.work.textContent;
      delete this.work.textContentHtml;
      this.work.listContent = listContent;
      this.dirty.delete('body');
      this.renderContent();
      this.markDirty('list');
    }
    this.renderToolbar();
  }

  setAllChecked(on) {
    for (const i of this.work.listContent) i.isChecked = on;
    this.renderList();
    this.markDirty('list');
    this.renderToolbar();
  }

  deleteChecked() {
    this.work.listContent = this.work.listContent.filter((i) => !i.isChecked);
    this.renderList();
    this.markDirty('list');
    this.renderToolbar();
  }

  // ---- Checklist -------------------------------------------------------------

  renderList(focus) {
    const items = this.work.listContent;
    const unchecked = items.filter((i) => !i.isChecked);
    const checked = items.filter((i) => i.isChecked);
    const rows = unchecked.map((item) => this.listRow(item));
    const parts = [...rows];
    if (!this.readOnly) {
      const add = h('textarea', { rows: 1, placeholder: 'List item', 'aria-label': 'New list item' });
      add.addEventListener('input', () => {
        const item = { text: add.value, isChecked: false };
        const at = items.findIndex((i) => i.isChecked);
        items.splice(at < 0 ? items.length : at, 0, item);
        this.markDirty('list');
        this.renderList({ item, pos: item.text.length });
      });
      parts.push(h('div', { class: 'list-add' }, h('span', { class: 'plus' }, icon('add', 'sm')), add));
    }
    if (checked.length) {
      parts.push(h('button', {
        type: 'button', class: `checked-toggle${this.checkedCollapsed ? ' collapsed' : ''}`,
        onclick: () => { this.checkedCollapsed = !this.checkedCollapsed; this.renderList(); },
      }, icon('expand', 'sm'), `${checked.length} checked ${checked.length === 1 ? 'item' : 'items'}`));
      if (!this.checkedCollapsed) parts.push(...checked.map((item) => this.listRow(item)));
    }
    this.listEl.replaceChildren(...parts);
    for (const ta of this.listEl.querySelectorAll('textarea')) autosize(ta);
    if (focus) {
      const row = [...this.listEl.querySelectorAll('.list-row')].find((r) => r.item === focus.item);
      const ta = row?.querySelector('textarea');
      if (ta) {
        ta.focus();
        const pos = Math.min(focus.pos ?? ta.value.length, ta.value.length);
        ta.setSelectionRange(pos, pos);
      }
    }
  }

  listRow(item) {
    const items = this.work.listContent;
    const ta = h('textarea', { rows: 1, readOnly: this.readOnly, spellcheck: true, 'aria-label': 'List item' });
    ta.value = item.text;
    ta.addEventListener('input', () => {
      item.text = ta.value;
      delete item.textHtml;
      autosize(ta);
      this.markDirty('list');
    });
    ta.addEventListener('keydown', (e) => this.onItemKey(e, item, ta));
    ta.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey) this.openLinkAtCaret(); });
    const row = h('div', { class: `list-row${item.isChecked ? ' checked' : ''}` },
      h('span', { class: 'handle', 'aria-hidden': 'true' }, icon('drag', 'sm')),
      h('button', {
        type: 'button', class: 'icon-btn box', 'aria-label': item.isChecked ? 'Uncheck item' : 'Check item', disabled: this.readOnly,
        onclick: () => {
          const index = items.indexOf(item);
          items.splice(index, 1);
          item.isChecked = !item.isChecked;
          const firstChecked = items.findIndex((i) => i.isChecked);
          items.splice(firstChecked < 0 ? items.length : firstChecked, 0, item);
          this.markDirty('list');
          this.renderList();
          this.renderToolbar();
        },
      }, icon(item.isChecked ? 'boxChecked' : 'boxBlank')),
      ta,
      this.readOnly ? null : iconBtn('close', 'Delete', () => {
        items.splice(items.indexOf(item), 1);
        this.markDirty('list');
        this.renderList();
      }, 'sm del'));
    row.item = item;
    if (!item.isChecked && !this.readOnly) this.enableDrag(row);
    return row;
  }

  onItemKey(e, item, ta) {
    if (this.readOnly) return;
    const items = this.work.listContent;
    const group = items.filter((i) => i.isChecked === item.isChecked);
    const gi = group.indexOf(item);
    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const atEnd = ta.selectionStart === ta.value.length;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const before = ta.value.slice(0, ta.selectionStart);
      const after = ta.value.slice(ta.selectionEnd);
      item.text = before;
      delete item.textHtml;
      const next = { text: after, isChecked: item.isChecked };
      items.splice(items.indexOf(item) + 1, 0, next);
      this.markDirty('list');
      this.renderList({ item: next, pos: 0 });
    } else if (e.key === 'Backspace' && atStart && gi > 0) {
      e.preventDefault();
      const prev = group[gi - 1];
      const pos = prev.text.length;
      prev.text += item.text;
      delete prev.textHtml;
      items.splice(items.indexOf(item), 1);
      this.markDirty('list');
      this.renderList({ item: prev, pos });
    } else if (e.key === 'ArrowUp' && atStart && gi > 0) {
      e.preventDefault();
      this.renderFocus(group[gi - 1]);
    } else if (e.key === 'ArrowDown' && atEnd && gi < group.length - 1) {
      e.preventDefault();
      this.renderFocus(group[gi + 1], 0);
    }
  }

  renderFocus(item, pos) {
    const row = [...this.listEl.querySelectorAll('.list-row')].find((r) => r.item === item);
    const ta = row?.querySelector('textarea');
    if (!ta) return;
    ta.focus();
    const p = pos ?? ta.value.length;
    ta.setSelectionRange(p, p);
  }

  /** Drag unchecked rows by the handle to reorder. */
  enableDrag(row) {
    const handle = row.querySelector('.handle');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const rows = [...this.listEl.querySelectorAll('.list-row:not(.checked)')];
      const from = rows.indexOf(row);
      const rects = rows.map((r) => r.getBoundingClientRect());
      const hgt = rects[from].height;
      const startY = e.clientY;
      let target = from;
      row.classList.add('drag');
      const move = (ev) => {
        const dy = ev.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
        const center = rects[from].top + hgt / 2 + dy;
        target = from;
        rows.forEach((r, j) => {
          if (j === from) return;
          const mid = rects[j].top + rects[j].height / 2;
          let shift = 0;
          if (j > from && mid < center) { shift = -hgt; target++; }
          if (j < from && mid > center) { shift = hgt; target--; }
          r.style.transform = shift ? `translateY(${shift}px)` : '';
          r.style.transition = 'transform .12s';
        });
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        for (const r of rows) { r.style.transform = ''; r.style.transition = ''; }
        row.classList.remove('drag');
        if (target === from) return;
        const unchecked = rows.map((r) => r.item);
        const [moved] = unchecked.splice(from, 1);
        unchecked.splice(target, 0, moved);
        this.work.listContent = [...unchecked, ...this.work.listContent.filter((i) => i.isChecked)];
        this.markDirty('list');
        this.renderList();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // ---- Mounting --------------------------------------------------------------

  /** Show as a centered modal. */
  mountModal() {
    openEditorInstance = this;
    this.backdrop = h('div', { class: 'backdrop', onpointerdown: (e) => { if (e.target === this.backdrop) this.close(); } }, this.el);
    document.getElementById('layer').append(this.backdrop);
    this.unstack = pushLayer(() => this.close());
    for (const ta of [this.titleEl]) autosize(ta);
    if (this.listEl) for (const ta of this.listEl.querySelectorAll('textarea')) autosize(ta);
    if (this.opts.focus) this.focusContent();
    this.addLinkPreviews();
  }

  /** Show inline in the composer slot; clicking elsewhere closes it. */
  mountInline(slot) {
    openEditorInstance = this;
    this.slot = slot;
    slot.replaceChildren(h('div', { class: 'composer-slot-inner' }, this.el));
    this.unstack = pushLayer(() => this.close());
    this.outside = (e) => {
      if (this.el.contains(e.target) || e.target.closest('#layer, .snackbar, .topbar')) return;
      this.close();
    };
    setTimeout(() => document.addEventListener('pointerdown', this.outside, true));
    autosize(this.titleEl);
    this.focusContent();
  }

  async close({ discard = false } = {}) {
    if (this.closing) return;
    this.closing = true;
    if (!discard) await this.flush();
    try { await this.pending; } catch { /* reported already */ }
    this.unstack?.();
    if (this.outside) document.removeEventListener('pointerdown', this.outside, true);
    this.backdrop?.remove();
    if (openEditorInstance === this) openEditorInstance = null;
    // Typing saves silently; refresh the grid once on close, and only if something changed.
    const now = this.id && state.notes.get(this.id)?.note;
    if (now && JSON.stringify(now) !== this.original) emit();
    this.opts.onClose?.(this);
  }
}

export function openNote(id, opts = {}) {
  if (!state.notes.has(id)) return null;
  const ed = new NoteEditor({ id, ...opts });
  ed.mountModal();
  return ed;
}
