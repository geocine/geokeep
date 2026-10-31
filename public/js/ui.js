// Popovers, menus, dialogs, snackbar, tooltips, lightbox.

import { h, iconBtn, COLORS, colorVar } from './util.js';
import { icon } from './icons.js';

const layer = () => document.getElementById('layer');

// Esc, and the browser/phone Back button, close the most recently opened layer.
// Each layer gets a history entry; closing it from the UI steps back over that entry.
const stack = [];
let layerSeq = 0;
let skipPops = 0;
export function pushLayer(close, { history: useHistory = true } = {}) {
  const item = { close, id: ++layerSeq, popped: false, useHistory };
  stack.push(item);
  if (useHistory) history.pushState({ ...(history.state || {}), gkLayer: item.id }, '');
  return () => {
    const i = stack.indexOf(item);
    if (i < 0) return;
    stack.splice(i, 1);
    // Only step back if our entry is still the current one (not after a navigation).
    if (useHistory && !item.popped && history.state?.gkLayer === item.id) {
      skipPops++;
      history.back();
    }
  };
}
window.addEventListener('popstate', () => {
  if (skipPops > 0) { skipPops--; return; }
  // Menus on top have no history entry: dismiss them, then close the layer that owns the entry.
  while (stack.length && !stack[stack.length - 1].useHistory) stack[stack.length - 1].close();
  const top = stack[stack.length - 1];
  if (!top) return;
  top.popped = true;
  top.close();
});
export function hasLayers() {
  return stack.length > 0;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) {
    e.preventDefault();
    e.stopPropagation();
    stack[stack.length - 1].close();
  }
}, true);

// ---- Popover -----------------------------------------------------------------

let current = null;

export function closePopover() {
  if (!current) return;
  const c = current;
  current = null;
  c.el.remove();
  c.unstack();
  document.removeEventListener('pointerdown', c.outside, true);
  window.removeEventListener('resize', c.closeOnResize);
  c.onClose?.();
}

/** Show content in a floating panel next to anchor. */
export function openPopover(anchor, content, { onClose } = {}) {
  closePopover();
  const el = h('div', { class: 'popover', role: 'dialog' }, content);
  layer().append(el);
  const r = anchor.getBoundingClientRect();
  const pw = el.offsetWidth;
  const ph = el.offsetHeight;
  // clientWidth/Height exclude the scrollbar, so the panel never tucks under it.
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let left = Math.min(r.left, vw - pw - 8);
  let top = r.bottom + 4;
  if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 4);
  left = Math.max(8, left);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const closeOnResize = () => closePopover();
  current = { el, onClose, outside, closeOnResize, unstack: pushLayer(closePopover, { history: false }) };
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  window.addEventListener('resize', closeOnResize);
  return el;
}

/** items: [{ label, onClick, icon?, checked?, disabled? } | 'sep' | { head }] */
export function openMenu(anchor, items, opts) {
  const content = items.map((it) => {
    if (it === 'sep') return h('div', { class: 'menu-sep' });
    if (it.head) return h('div', { class: 'menu-head' }, it.head);
    return h('button', {
      type: 'button', class: `menu-item${it.disabled ? ' disabled' : ''}`,
      onclick: () => { closePopover(); it.onClick(); },
    }, it.checked !== undefined ? h('span', { class: 'check' }, it.checked ? icon('check', 'sm') : null) : null, it.label);
  });
  return openPopover(anchor, content, opts);
}

export function openColorPicker(anchor, currentColor, onPick, opts) {
  const swatches = COLORS.map(([key, name]) => h('button', {
    type: 'button', class: `swatch${key === 'DEFAULT' ? ' default' : ''}${key === currentColor ? ' current' : ''}`,
    style: { '--sw': colorVar(key) }, 'data-tip': name, 'aria-label': name,
    onclick: () => { onPick(key); closePopover(); },
  }, key === 'DEFAULT' ? icon('noColor', 'sm') : null, key === currentColor ? h('span', { class: 'badge' }, icon('check')) : null));
  const el = openPopover(anchor, h('div', { class: 'palette' }, swatches), opts);
  el.style.setProperty('min-width', '0');
  return el;
}

/** Checkbox list of labels with filter and create. */
export function openLabelPicker(anchor, { labels, has, onToggle, onCreate }, opts) {
  const input = h('input', { type: 'text', placeholder: 'Enter label name', maxlength: 50 });
  const list = h('div');
  const render = () => {
    const q = input.value.trim();
    const ql = q.toLowerCase();
    list.replaceChildren();
    for (const name of labels().filter((l) => l.toLowerCase().includes(ql))) {
      const on = has(name);
      list.append(h('button', {
        type: 'button', class: 'menu-item',
        onclick: async () => { await onToggle(name, !on); render(); },
      }, icon(on ? 'boxChecked' : 'boxBlank', 'sm'), h('span', null, name)));
    }
    if (q && !labels().some((l) => l.toLowerCase() === ql)) {
      list.append(h('button', {
        type: 'button', class: 'menu-item create',
        onclick: async () => { await onCreate(q); input.value = ''; render(); },
      }, icon('add', 'sm'), h('span', null, `Create "${q}"`)));
    }
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); list.querySelector('.menu-item')?.click(); }
  });
  render();
  const el = openPopover(anchor, h('div', { class: 'label-picker' }, h('div', { class: 'lp-head' }, 'Label note'), input, list), opts);
  input.focus();
  return el;
}

// ---- Dialog ------------------------------------------------------------------

/** actions: [{ label, primary?, danger?, onClick? }] — onClick returning false keeps it open. */
export function openDialog({ title, body, actions = [{ label: 'Close' }], cls = '', onClose }) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unstack();
    backdrop.remove();
    onClose?.();
  };
  const buttons = actions.map((a) => h('button', {
    type: 'button', class: `text-btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`,
    onclick: async () => { if ((await a.onClick?.()) !== false) close(); },
  }, a.label));
  const dialog = h('div', { class: `dialog ${cls}`, role: 'dialog', 'aria-modal': 'true' },
    title ? h('h2', null, title) : null,
    h('div', { class: 'dialog-body' }, body),
    buttons.length ? h('div', { class: 'dialog-actions' }, buttons) : null);
  const backdrop = h('div', { class: 'backdrop', onpointerdown: (e) => { if (e.target === backdrop) close(); } }, dialog);
  layer().append(backdrop);
  const unstack = pushLayer(close);
  return { close, el: dialog };
}

export function confirmDialog(text, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let result = false;
    openDialog({
      cls: 'small',
      body: h('p', { style: { color: 'var(--fg)' } }, text),
      actions: [{ label: 'Cancel' }, { label: okLabel, primary: true, onClick: () => { result = true; } }],
      onClose: () => resolve(result),
    });
  });
}

// ---- Snackbar ----------------------------------------------------------------

let snackTimer;
export function snackbar(message, action) {
  const el = document.getElementById('snackbar');
  clearTimeout(snackTimer);
  const hide = () => { el.hidden = true; };
  el.replaceChildren(
    h('span', { class: 'msg' }, message),
    action ? h('button', { type: 'button', onclick: () => { hide(); action.onClick(); } }, action.label) : null,
    iconBtn('close', 'Dismiss', hide, 'xs'),
  );
  el.hidden = false;
  snackTimer = setTimeout(hide, action ? 7000 : 4000);
}

// ---- Tooltips ----------------------------------------------------------------

export function initTooltips() {
  const tip = document.getElementById('tooltip');
  let target = null;
  let timer;
  const hide = () => { clearTimeout(timer); tip.hidden = true; target = null; };
  // Cards re-render under a still pointer; drop the tip when its element goes away.
  setInterval(() => { if (target && !document.contains(target)) hide(); }, 400);
  document.addEventListener('pointerout', (e) => { if (target && !target.contains(e.relatedTarget)) hide(); });
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const t = e.target.closest?.('[data-tip]');
    if (t === target) return;
    hide();
    if (!t) return;
    target = t;
    timer = setTimeout(() => {
      if (!document.contains(t)) return;
      tip.textContent = t.dataset.tip;
      tip.hidden = false;
      const r = t.getBoundingClientRect();
      const w = tip.offsetWidth;
      tip.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2))}px`;
      tip.style.top = `${r.bottom + 6 + tip.offsetHeight > window.innerHeight ? r.top - tip.offsetHeight - 6 : r.bottom + 6}px`;
    }, 500);
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('scroll', hide, true);
}

// ---- Lightbox ----------------------------------------------------------------

export function openLightbox(urls, index = 0) {
  let i = index;
  const img = h('img', { alt: '' });
  const count = h('div', { class: 'lb-count' });
  const open = h('a', { class: 'icon-btn lb-open', target: '_blank', rel: 'noopener', 'data-tip': 'Open original', 'aria-label': 'Open original' }, icon('openNew'));
  const show = () => {
    img.src = urls[i];
    open.href = urls[i];
    count.textContent = urls.length > 1 ? `${i + 1} / ${urls.length}` : '';
  };
  const step = (d) => { i = (i + d + urls.length) % urls.length; show(); };
  const close = () => { unstack(); document.removeEventListener('keydown', keys); box.remove(); };
  const keys = (e) => {
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  };
  const box = h('div', { class: 'lightbox', onclick: (e) => { if (e.target === box) close(); } },
    iconBtn('back', 'Close', close, 'lb-close'), count, open, img,
    urls.length > 1 ? iconBtn('left', 'Previous', () => step(-1), 'lb-prev') : null,
    urls.length > 1 ? iconBtn('right', 'Next', () => step(1), 'lb-next') : null);
  layer().append(box);
  const unstack = pushLayer(close);
  document.addEventListener('keydown', keys);
  show();
}
