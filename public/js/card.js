// A note card in the grid.

import { h, iconBtn, colorVar, isList, safeUrl, hostOf, mediaUrl, isWebLink, linkImageUrl } from './util.js';
import { icon } from './icons.js';
import { state } from './state.js';
import { noteBlocks, renderBlocks, truncateBlocks, appendLinkified } from './richtext.js';
import { openColorPicker, openMenu, openLabelPicker } from './ui.js';
import * as A from './actions.js';

const MAX_ITEMS = 10;
const MAX_IMAGES = 6;
const MAX_LINKS = 2;

// After a long-press selects, the release tap must not also open a (re-rendered) card.
let suppressClickUntil = 0;

/** Aspect ratio for an attachment, from server-side header parsing. */
export function aspectOf(filePath) {
  const m = state.media[filePath];
  return m?.width && m?.height ? `${m.width} / ${m.height}` : '4 / 3';
}

function imageEl(a, onBroken) {
  const m = state.media[a.filePath];
  if (m?.missing) return h('div', { class: 'broken' }, icon('brokenImage', 'sm'), 'Missing image');
  if (!String(a.mimetype || '').startsWith('image/') && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filePath)) {
    return h('div', { class: 'broken' }, icon('link', 'sm'), a.filePath);
  }
  const img = h('img', { src: mediaUrl(a.filePath), alt: '', loading: 'lazy', decoding: 'async', draggable: false });
  img.style.aspectRatio = aspectOf(a.filePath);
  img.onerror = () => img.replaceWith(h('div', { class: 'broken' }, icon('brokenImage', 'sm'), 'Image unavailable'));
  if (!m?.width) img.onload = onBroken;
  return img;
}

function cardImages(atts, relayout) {
  const first = atts[0];
  const rest = atts.slice(1, MAX_IMAGES);
  const hidden = atts.length - MAX_IMAGES;
  return h('div', { class: 'card-images' },
    imageEl(first, relayout),
    rest.map((a, i) => h('div', { class: 'thumb' }, imageEl(a, relayout),
      i === rest.length - 1 && hidden > 0 ? h('div', { class: 'more' }, `+${hidden}`) : null)));
}

function cardText(note) {
  const { blocks, truncated } = truncateBlocks(noteBlocks(note));
  const el = h('div', { class: 'card-text rt' }, renderBlocks(blocks));
  if (truncated) el.append(h('span', { class: 'ellipsis' }, '…'));
  return el;
}

function cardList(id, note, readOnly) {
  const items = note.listContent;
  const unchecked = [];
  let checked = 0;
  items.forEach((item, index) => (item.isChecked ? checked++ : unchecked.push({ item, index })));
  const shown = unchecked.slice(0, MAX_ITEMS);
  const el = h('div', { class: 'card-list' }, shown.map(({ item, index }) => {
    const txt = h('div', { class: 'txt' });
    appendLinkified(txt, item.text);
    return h('div', { class: 'card-item' },
      h('button', {
        type: 'button', class: 'box', 'aria-label': 'Check item', disabled: readOnly,
        onclick: (e) => { e.stopPropagation(); if (!readOnly) A.toggleItem(id, index); },
      }, icon('boxBlank')),
      txt);
  }));
  if (unchecked.length > shown.length) el.append(h('div', { class: 'card-more' }, '…'));
  if (checked) el.append(h('div', { class: 'card-more' }, `+ ${checked} checked ${checked === 1 ? 'item' : 'items'}`));
  return el;
}

function linkList(annotations) {
  const shown = annotations.slice(0, MAX_LINKS);
  return h('div', { class: 'links' },
    shown.map((a) => {
      const href = safeUrl(a.url);
      return h(href ? 'a' : 'div', { class: 'link', href, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation(), 'data-tip': a.url },
        linkThumb(a.url),
        h('div', { class: 'link-text' },
          h('div', { class: 'link-title' }, a.title || a.url),
          h('div', { class: 'link-host' }, hostOf(a.url))));
    }),
    annotations.length > MAX_LINKS ? h('div', { class: 'links-more' }, `+ ${annotations.length - MAX_LINKS} more ${annotations.length - MAX_LINKS === 1 ? 'link' : 'links'}`) : null);
}

/** Link icon, replaced by the page's preview image (og:image) once it loads. */
export function linkThumb(url) {
  const box = h('div', { class: 'link-icon' }, icon('link', 'sm'));
  if (state.config?.linkPreviews && isWebLink(url)) {
    const img = h('img', { src: linkImageUrl(url), alt: '', loading: 'lazy', decoding: 'async', draggable: false });
    img.onload = () => box.classList.add('has-image');
    img.onerror = () => img.remove();
    box.append(img);
  }
  return box;
}

/**
 * ctx: { selected: Set, onOpen(id), onSelect(id, shiftKey), onLabelClick(name), relayout() }
 */
export function renderCard(entry, ctx) {
  const { id, note } = entry;
  const trashed = note.isTrashed;
  const card = h('div', {
    class: `card${ctx.selected.has(id) ? ' selected' : ''}`,
    tabindex: 0, role: 'article', 'aria-label': note.title || 'Untitled note',
    dataset: { id, color: note.color },
    style: { '--note-bg': colorVar(note.color) },
  });

  const clip = h('div', { class: 'clip' });
  if (note.attachments?.length) clip.append(cardImages(note.attachments, ctx.relayout));

  const body = h('div', { class: 'card-body' });
  if (note.title) body.append(h('div', { class: 'card-title' }, note.title));
  if (isList(note)) body.append(cardList(id, note, trashed));
  else if (note.textContent) {
    const t = cardText(note);
    // Keep shows very short title-less notes in large type.
    if (!note.title && !note.attachments && note.textContent.length < 80 && !note.textContent.includes('\n')) card.classList.add('big-text');
    body.append(t);
  }
  const labels = note.labels || [];
  if (labels.length) {
    body.append(h('div', { class: 'chips' }, labels.map((l) => h('span', {
      class: `chip${trashed ? '' : ' removable'}`, role: 'link',
      onclick: (e) => { e.stopPropagation(); ctx.onLabelClick(l.name); },
    }, h('span', null, l.name), trashed ? null : h('button', {
      type: 'button', class: 'chip-x', 'aria-label': `Remove label ${l.name}`,
      onclick: (e) => { e.stopPropagation(); A.toggleLabel(id, l.name, false); },
    }, icon('close'))))));
  }
  if (note.annotations?.length) body.append(linkList(note.annotations));
  clip.append(body);

  const tools = trashed
    ? [iconBtn('deleteForever', 'Delete forever', () => A.deleteNotesForever([id])), iconBtn('restore', 'Restore', () => A.setTrashed([id], false))]
    : [
      iconBtn('palette', 'Background options', (e) => withMenu(card, () => openColorPicker(e.currentTarget, note.color, (c) => A.setColor([id], c), menuOpts(card))), 'sm'),
      iconBtn('image', 'Add image', () => A.pickFiles((files) => A.uploadImages(id, files)), 'sm hide-narrow'),
      note.isArchived
        ? iconBtn('unarchive', 'Unarchive', () => A.setArchived([id], false), 'sm')
        : iconBtn('archive', 'Archive', () => A.setArchived([id], true), 'sm'),
      iconBtn('more', 'More', (e) => withMenu(card, () => openMenu(e.currentTarget, [
        { label: 'Delete note', onClick: () => A.setTrashed([id], true) },
        { label: labels.length ? 'Change labels' : 'Add label', onClick: () => withMenu(card, () => openLabelPicker(card.querySelector('.card-toolbar'), labelPickerFor(id), menuOpts(card))) },
        { label: 'Make a copy', onClick: () => A.makeCopy(id) },
        { label: 'Copy text to clipboard', onClick: () => navigator.clipboard?.writeText([note.title, A.plainTextOf(note)].filter(Boolean).join('\n\n')) },
      ], menuOpts(card))), 'sm'),
    ];
  clip.append(h('div', { class: 'card-toolbar', onclick: (e) => e.stopPropagation() }, h('div', { class: 'tools' }, tools)));
  card.append(clip);

  if (!trashed) {
    card.append(h('button', {
      type: 'button', class: `icon-btn sm card-pin${note.isPinned ? ' on' : ''}`, 'data-tip': note.isPinned ? 'Unpin note' : 'Pin note',
      'aria-label': note.isPinned ? 'Unpin note' : 'Pin note',
      onclick: (e) => { e.stopPropagation(); A.setPinned([id], !note.isPinned); },
    }, icon(note.isPinned ? 'pinFilled' : 'pin')));
  }
  card.append(h('button', {
    type: 'button', class: 'card-select', 'data-tip': 'Select note', 'aria-label': 'Select note',
    onclick: (e) => { e.stopPropagation(); ctx.onSelect(id, e.shiftKey); },
  }, icon('check')));

  // Touch: long-press selects (there is no hover to reveal the select circle).
  let pressTimer = null;
  let pressed = false;
  let start = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('button, a')) return;
    pressed = false;
    start = [e.clientX, e.clientY];
    pressTimer = setTimeout(() => {
      pressed = true;
      suppressClickUntil = Date.now() + 800;
      navigator.vibrate?.(20);
      ctx.onSelect(id, false);
    }, 500);
  });
  card.addEventListener('pointermove', (e) => {
    if (pressTimer && start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) cancelPress();
  });
  card.addEventListener('pointerup', cancelPress);
  card.addEventListener('pointercancel', cancelPress);
  card.addEventListener('contextmenu', (e) => { if (pressed || pressTimer) e.preventDefault(); });

  card.addEventListener('click', (e) => {
    if (pressed || Date.now() < suppressClickUntil) { pressed = false; return; }
    if (e.target.closest('a')) return;
    if (ctx.selected.size) { ctx.onSelect(id, e.shiftKey); return; }
    ctx.onOpen(id);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === card) ctx.onOpen(id);
  });
  return card;
}

export function labelPickerFor(id) {
  return {
    labels: () => state.labels,
    has: (name) => !!state.notes.get(id)?.note.labels?.some((l) => l.name === name),
    onToggle: (name, on) => A.toggleLabel(id, name, on),
    onCreate: async (name) => { await A.createLabel(name); await A.toggleLabel(id, name, true); },
  };
}

// Keep the card toolbar visible while its menu is open.
function withMenu(card, open) {
  card.classList.add('menu-open');
  open();
}
function menuOpts(card) {
  return { onClose: () => card.classList.remove('menu-open') };
}
