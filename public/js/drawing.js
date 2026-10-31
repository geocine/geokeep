// Drawing editor, modeled on Keep's: select, eraser, pen, marker, highlighter,
// grid backgrounds, undo/redo, an endless page. A drawing is saved as a PNG
// attachment (what Takeout exports) with its strokes embedded in a tEXt chunk,
// so it stays an ordinary image everywhere and stays editable here.

import { h } from './util.js';
import { icon } from './icons.js';
import { openPopover, closePopover, openMenu, pushLayer, snackbar } from './ui.js';

// Keep's drawing palette: the first row shows, "More colors" reveals the rest.
export const INK_COLORS = [
  ['Black', '#000000'], ['Red', '#ff5252'], ['Yellow', '#ffbc00'], ['Green', '#00c853'], ['Cyan', '#00b0ff'], ['Purple', '#d500f9'], ['Brown', '#8d6e63'],
  ['White', '#fafafa'], ['Crimson', '#a52714'], ['Amber', '#ee8100'], ['Avocado Green', '#558b2f'], ['Cobalt Blue', '#01579b'], ['Deep Purple', '#8e24aa'], ['Dark Brown', '#4e342e'],
  ['Dark Gray', '#90a4ae'], ['Hot Pink', '#ff4081'], ['Orange', '#ff6e40'], ['Lime', '#aeea00'], ['Blue', '#304ffe'], ['Violet', '#7c4dff'], ['Teal', '#1de9b6'],
  ['Light Gray', '#cfd8dc'], ['Light Pink', '#f8bbd0'], ['Light Orange', '#ffccbc'], ['Light Green', '#f0f4c3'], ['Light Blue', '#9fa8da'], ['Lavender', '#d1c4e9'], ['Light Teal', '#b2dfdb'],
];
const SIZES = [1, 2, 3, 4, 8, 12, 16, 20];
const DOT = { 1: 2, 2: 4, 3: 8, 4: 12, 8: 16, 12: 20, 16: 24, 20: 28 };
const TOOLS = {
  pen: { label: 'Pen', icon: 'pen', color: '#000000', size: 2 },
  marker: { label: 'Marker', icon: 'marker', color: '#ff5252', size: 2 },
  highlighter: { label: 'Highlighter', icon: 'highlighter', color: '#ffbc00', size: 4 },
};
const GRID_STEP = 32;
const INK_KEY = 'GeoKeepInk';

// ---- PNG tEXt chunk (strokes travel inside the image) ------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function withInk(blob, ink) {
  const png = new Uint8Array(await blob.arrayBuffer());
  const text = new TextEncoder().encode(`${INK_KEY}\0${btoa(JSON.stringify(ink))}`);
  const chunk = new Uint8Array(12 + text.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, text.length);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4); // tEXt
  chunk.set(text, 8);
  view.setUint32(8 + text.length, crc32(chunk.subarray(4, 8 + text.length)));
  const at = 8 + 25; // after the signature and IHDR
  return new Blob([png.subarray(0, at), chunk, png.subarray(at)], { type: 'image/png' });
}

/** Strokes stored in a drawing PNG, or null for an ordinary image. */
export async function readInk(url) {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const view = new DataView(buf.buffer);
  for (let p = 8; p + 8 <= buf.length;) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'tEXt') {
      const data = new TextDecoder('latin1').decode(buf.subarray(p + 8, p + 8 + len));
      const [key, value] = [data.slice(0, data.indexOf('\0')), data.slice(data.indexOf('\0') + 1)];
      if (key === INK_KEY) {
        try { return JSON.parse(atob(value)); } catch { return null; }
      }
    }
    p += 12 + len;
  }
  return null;
}

// ---- Stroke rendering ------------------------------------------------------------

function strokeWidth(s) {
  const base = DOT[s.size] || s.size * 2;
  return s.tool === 'highlighter' ? base * 2 : s.tool === 'marker' ? base * 1.25 : base;
}

/** Draw one stroke. Points are a flat array: x, y, pressure, x, y, pressure… */
function drawStroke(ctx, s) {
  const p = s.points;
  const n = p.length / 3;
  if (!n) return;
  const w = strokeWidth(s);
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineJoin = 'round';
  if (s.tool === 'highlighter') ctx.globalAlpha = 0.4;
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], w / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (s.tool === 'pen') {
    // A calligraphy nib: width follows pressure and stroke direction.
    ctx.lineCap = 'round';
    for (let i = 1; i < n; i++) {
      const x0 = p[i * 3 - 3]; const y0 = p[i * 3 - 2]; const x1 = p[i * 3]; const y1 = p[i * 3 + 1];
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const nib = 0.55 + 0.45 * Math.abs(Math.sin(angle - Math.PI / 4));
      ctx.lineWidth = Math.max(1, w * nib * (0.5 + (p[i * 3 + 2] || 0.5)));
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  } else {
    ctx.lineCap = s.tool === 'highlighter' ? 'butt' : 'round';
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (p[i * 3] + p[i * 3 + 3]) / 2;
      const my = (p[i * 3 + 1] + p[i * 3 + 4]) / 2;
      ctx.quadraticCurveTo(p[i * 3], p[i * 3 + 1], mx, my);
    }
    ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    ctx.stroke();
  }
  ctx.restore();
}

function drawGrid(ctx, grid, w, h) {
  if (!grid || grid === 'none') return;
  ctx.save();
  ctx.strokeStyle = '#dadce0';
  ctx.fillStyle = '#bdc1c6';
  ctx.lineWidth = 1;
  if (grid === 'dots') {
    for (let y = GRID_STEP; y < h; y += GRID_STEP) for (let x = GRID_STEP; x < w; x += GRID_STEP) ctx.fillRect(x - 1, y - 1, 2, 2);
  } else {
    ctx.beginPath();
    for (let y = GRID_STEP; y < h; y += GRID_STEP) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
    if (grid === 'square') for (let x = GRID_STEP; x < w; x += GRID_STEP) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
    ctx.stroke();
  }
  ctx.restore();
}

function bounds(strokes) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const s of strokes) {
    const pad = strokeWidth(s) / 2 + 1;
    for (let i = 0; i < s.points.length; i += 3) {
      x0 = Math.min(x0, s.points[i] - pad); x1 = Math.max(x1, s.points[i] + pad);
      y0 = Math.min(y0, s.points[i + 1] - pad); y1 = Math.max(y1, s.points[i + 1] + pad);
    }
  }
  return { x0, y0, x1, y1 };
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hitStroke(s, x, y, r) {
  const p = s.points;
  const rr = r + strokeWidth(s) / 2;
  if (p.length === 3) return Math.hypot(p[0] - x, p[1] - y) <= rr;
  for (let i = 3; i < p.length; i += 3) if (distToSegment(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= rr) return true;
  return false;
}

// ---- Editor --------------------------------------------------------------------

/**
 * Open the drawing editor. ink: saved data to edit, or null for a new drawing.
 * onDone({ blob }) when there is something to save, onDone({ empty: true }) when
 * the page is blank, onDone({ deleted: true }) for "Delete current drawing".
 * onNew starts another drawing after this one is saved (Keep's "New drawing").
 */
export function openDrawing({ ink = null, onDone, onNew }) {
  const tools = structuredClone(TOOLS);
  let tool = 'pen';
  let strokes = ink?.strokes ? structuredClone(ink.strokes) : [];
  let grid = ink?.grid || 'none';
  let pageH = ink?.height || 0;
  const pageWMin = ink?.width || 0;
  const undoStack = [];
  const redoStack = [];
  let selection = new Set();
  let closed = false;

  const bg = h('canvas', { class: 'ink-layer' });
  const main = h('canvas', { class: 'ink-layer' });
  const live = h('canvas', { class: 'ink-layer ink-live' });
  const page = h('div', { class: 'ink-page' }, bg, main, live);
  const scroller = h('div', { class: 'ink-scroll' }, page);
  const toolbar = h('div', { class: 'ink-toolbar' });
  const root = h('div', { class: 'ink-editor fullscreen', role: 'dialog', 'aria-label': 'Drawing' }, toolbar, scroller);
  document.getElementById('layer').append(root);

  // ---- canvas sizing ----
  let W = 0; let H = 0; const dpr = Math.max(1, window.devicePixelRatio || 1);
  const contentBottom = () => (strokes.length ? bounds(strokes).y1 : 0);
  function resize() {
    const vw = scroller.clientWidth;
    const vh = scroller.clientHeight;
    W = Math.max(vw, pageWMin);
    H = Math.max(vh, pageH, contentBottom() + vh / 2);
    page.style.width = `${W}px`;
    page.style.height = `${H}px`;
    for (const c of [bg, main, live]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    redraw();
  }
  function redraw() {
    const b = bg.getContext('2d');
    b.clearRect(0, 0, W, H);
    drawGrid(b, grid, W, H);
    const m = main.getContext('2d');
    m.clearRect(0, 0, W, H);
    for (const s of strokes) drawStroke(m, s);
    drawLive();
  }
  let current = null;
  let rect = null;
  function drawLive() {
    const l = live.getContext('2d');
    l.clearRect(0, 0, W, H);
    if (current) drawStroke(l, current);
    if (rect) {
      l.save();
      l.setLineDash([4, 4]);
      l.strokeStyle = '#1a73e8';
      l.strokeRect(Math.min(rect.x0, rect.x1), Math.min(rect.y0, rect.y1), Math.abs(rect.x1 - rect.x0), Math.abs(rect.y1 - rect.y0));
      l.restore();
    }
    if (selection.size) {
      const b = bounds([...selection]);
      l.save();
      l.setLineDash([6, 4]);
      l.strokeStyle = '#1a73e8';
      l.lineWidth = 1.5;
      l.strokeRect(b.x0 - 4, b.y0 - 4, b.x1 - b.x0 + 8, b.y1 - b.y0 + 8);
      l.restore();
    }
  }
  // "We'll automatically add more space as you get to the bottom."
  function growIfNeeded(y) {
    if (y > H - 200) {
      pageH = H + scroller.clientHeight / 2;
      const keep = scroller.scrollTop;
      resize();
      scroller.scrollTop = keep;
    }
  }

  // ---- history ----
  function commit(next) {
    undoStack.push(strokes);
    redoStack.length = 0;
    strokes = next;
    selection = new Set([...selection].filter((s) => strokes.includes(s)));
    redraw();
    renderToolbar();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(strokes);
    strokes = undoStack.pop();
    selection.clear();
    redraw();
    renderToolbar();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(strokes);
    strokes = redoStack.pop();
    selection.clear();
    redraw();
    renderToolbar();
  }

  // ---- pointer input ----
  const pos = (e) => {
    const r = page.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top, e.pressure && e.pointerType !== 'mouse' ? e.pressure : 0.5];
  };
  let drag = null;
  live.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    closePopover();
    try { live.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ }
    const [x, y, pr] = pos(e);
    if (tool === 'eraser') {
      drag = { kind: 'erase', removed: new Set() };
      eraseAt(x, y);
    } else if (tool === 'select') {
      const b = selection.size ? bounds([...selection]) : null;
      if (b && x >= b.x0 - 6 && x <= b.x1 + 6 && y >= b.y0 - 6 && y <= b.y1 + 6) {
        drag = { kind: 'move', x, y, dx: 0, dy: 0 };
      } else {
        selection.clear();
        rect = { x0: x, y0: y, x1: x, y1: y };
        drag = { kind: 'rect' };
        drawLive();
      }
    } else {
      const t = tools[tool];
      current = { tool, color: t.color, size: t.size, points: [x, y, pr] };
      drag = { kind: 'ink' };
      drawLive();
    }
  });
  live.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const coalesced = e.getCoalescedEvents?.();
    const events = coalesced?.length ? coalesced : [e];
    for (const ev of events) {
      const [x, y, pr] = pos(ev);
      if (drag.kind === 'ink') {
        const p = current.points;
        if (Math.hypot(x - p[p.length - 3], y - p[p.length - 2]) >= 1) p.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(pr * 100) / 100);
      } else if (drag.kind === 'erase') {
        eraseAt(x, y);
      } else if (drag.kind === 'rect') {
        rect.x1 = x;
        rect.y1 = y;
      } else if (drag.kind === 'move') {
        drag.dx = x - drag.x;
        drag.dy = y - drag.y;
      }
    }
    if (drag.kind === 'move') {
      const m = main.getContext('2d');
      m.clearRect(0, 0, W, H);
      for (const s of strokes) {
        if (!selection.has(s)) { drawStroke(m, s); continue; }
        m.save();
        m.translate(drag.dx, drag.dy);
        drawStroke(m, s);
        m.restore();
      }
    }
    drawLive();
    if (drag.kind === 'ink') growIfNeeded(pos(e)[1]);
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === 'ink') {
      const s = current;
      current = null;
      commit([...strokes, s]);
    } else if (d.kind === 'erase') {
      if (d.removed.size) {
        undoStack.push(d.before);
        redoStack.length = 0;
        renderToolbar();
      }
    } else if (d.kind === 'rect') {
      const x0 = Math.min(rect.x0, rect.x1); const x1 = Math.max(rect.x0, rect.x1);
      const y0 = Math.min(rect.y0, rect.y1); const y1 = Math.max(rect.y0, rect.y1);
      rect = null;
      selection = new Set(strokes.filter((s) => {
        for (let i = 0; i < s.points.length; i += 3) {
          if (s.points[i] >= x0 && s.points[i] <= x1 && s.points[i + 1] >= y0 && s.points[i + 1] <= y1) return true;
        }
        return false;
      }));
      drawLive();
      renderToolbar();
    } else if (d.kind === 'move') {
      if (d.dx || d.dy) {
        const moved = new Map();
        const next = strokes.map((s) => {
          if (!selection.has(s)) return s;
          const points = s.points.map((v, i) => (i % 3 === 0 ? v + d.dx : i % 3 === 1 ? v + d.dy : v));
          const m = { ...s, points };
          moved.set(s, m);
          return m;
        });
        selection = new Set(moved.values());
        commit(next);
      } else redraw();
    }
  };
  live.addEventListener('pointerup', end);
  live.addEventListener('pointercancel', end);

  function eraseAt(x, y) {
    const hit = strokes.filter((s) => hitStroke(s, x, y, 6));
    if (!hit.length) return;
    if (!drag.before) drag.before = strokes;
    for (const s of hit) drag.removed.add(s);
    strokes = strokes.filter((s) => !drag.removed.has(s));
    redraw();
  }

  function deleteSelection() {
    if (!selection.size) return;
    const sel = selection;
    selection = new Set();
    commit(strokes.filter((s) => !sel.has(s)));
  }

  // ---- toolbar ----
  const btn = (name, label, onclick, { active = false, disabled = false, cls = '' } = {}) => h('button', {
    type: 'button', class: `icon-btn ink-btn ${cls}${active ? ' on' : ''}`, 'data-tip': label, 'aria-label': label, 'aria-pressed': String(active), disabled, onclick,
  }, icon(name));
  const caret = (label, onclick) => h('button', { type: 'button', class: 'ink-caret', 'aria-label': label, onclick }, icon('dropDown'));

  function penPanel(anchor, key) {
    let more = false;
    const body = h('div', { class: 'ink-panel' });
    const render = () => {
      const t = tools[key];
      const rows = [];
      for (let i = 0; i < (more ? INK_COLORS.length : 7); i += 7) rows.push(INK_COLORS.slice(i, i + 7));
      body.replaceChildren(
        h('div', { class: 'ink-colors' }, rows.map((row, r) => h('div', { class: 'ink-row' },
          row.map(([name, hex]) => h('button', {
            type: 'button', class: `ink-color${t.color === hex ? ' on' : ''}`, style: { background: hex }, 'data-tip': name, 'aria-label': name,
            onclick: () => { t.color = hex; tool = key; render(); renderToolbar(); },
          })),
          r === 0 ? h('button', {
            type: 'button', class: 'ink-more', 'data-tip': more ? 'Fewer colors' : 'More colors', 'aria-label': 'More colors',
            onclick: () => { more = !more; render(); },
          }, icon('expand', more ? 'flip' : '')) : null))),
        h('div', { class: 'ink-sizes' }, SIZES.map((size) => h('button', {
          type: 'button', class: `ink-size${t.size === size ? ' on' : ''}`, 'data-tip': `Size ${size}`, 'aria-label': `Size ${size}`,
          onclick: () => { t.size = size; tool = key; render(); renderToolbar(); },
        }, h('span', { style: { width: `${DOT[size]}px`, height: `${DOT[size]}px`, background: t.color === '#fafafa' ? '#9aa0a6' : t.color } })))),
      );
    };
    render();
    openPopover(anchor, body);
  }

  function renderToolbar() {
    const groups = [
      btn('back', 'Back', () => close()),
      btn('select', 'Selection tool', () => { tool = 'select'; renderToolbar(); }, { active: tool === 'select' }),
      h('span', { class: 'ink-group' },
        btn('eraser', 'Eraser tool', (e) => {
          if (tool === 'eraser') { eraserMenu(e.currentTarget); return; }
          tool = 'eraser'; selection.clear(); drawLive(); renderToolbar();
        }, { active: tool === 'eraser' }),
        caret('Eraser options', (e) => eraserMenu(e.currentTarget))),
      ...Object.entries(tools).map(([key, t]) => h('span', { class: 'ink-group', dataset: { tool: key } },
        h('button', {
          type: 'button', class: `icon-btn ink-btn ink-tool${tool === key ? ' on' : ''}`, 'data-tip': t.label, 'aria-label': t.label, 'aria-pressed': String(tool === key),
          onclick: (e) => { if (tool === key) penPanel(e.currentTarget, key); else { tool = key; selection.clear(); drawLive(); renderToolbar(); } },
        }, icon(t.icon), h('span', { class: 'ink-swatch', style: { background: t.color } })),
        caret(`${t.label} color and size`, () => { tool = key; renderToolbar(); penPanel(toolbar.querySelector(`[data-tool="${key}"]`), key); }))),
      h('span', { class: 'ink-group' },
        btn('grid', 'Grid options', (e) => gridMenu(e.currentTarget)),
        caret('Grid options', (e) => gridMenu(e.currentTarget))),
      h('span', { class: 'ink-spacer' }),
      selection.size ? btn('trash', 'Delete selection', deleteSelection) : null,
      btn('undo', 'Undo', undo, { disabled: !undoStack.length }),
      btn('redo', 'Redo', redo, { disabled: !redoStack.length }),
      btn(root.classList.contains('fullscreen') ? 'fullscreenExit' : 'fullscreen', root.classList.contains('fullscreen') ? 'Exit full screen' : 'Full screen', () => {
        root.classList.toggle('fullscreen');
        resize();
        renderToolbar();
      }),
      btn('more', 'More options', (e) => openMenu(e.currentTarget, [
        { label: 'New drawing', onClick: () => close({ thenNew: true }) },
        { label: 'Export as image', onClick: exportImage },
        { label: 'Delete current drawing', onClick: () => close({ deleted: true }) },
      ])),
    ];
    toolbar.replaceChildren(...groups.filter(Boolean));
    live.dataset.tool = tool;
  }

  function eraserMenu(anchor) {
    openMenu(anchor, [{ label: 'Clear page', onClick: () => strokes.length && commit([]) }]);
  }

  function gridMenu(anchor) {
    openMenu(anchor, [['square', 'Square'], ['dots', 'Dots'], ['rules', 'Rules'], ['none', 'None']].map(([k, label]) => ({
      label, checked: grid === k, onClick: () => { grid = k; redraw(); },
    })));
  }

  // ---- output ----
  async function render() {
    if (!strokes.length) return null;
    const b = bounds(strokes);
    const pad = 16;
    const x0 = Math.max(0, Math.floor(b.x0 - pad));
    const y0 = Math.max(0, Math.floor(b.y0 - pad));
    const w = Math.ceil(b.x1 + pad) - x0;
    const hgt = Math.ceil(b.y1 + pad) - y0;
    const scale = Math.min(2, Math.max(1, dpr));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(hgt * scale);
    const ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    ctx.translate(-x0, -y0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, w, hgt);
    drawGrid(ctx, grid, x0 + w, y0 + hgt);
    for (const s of strokes) drawStroke(ctx, s);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    return withInk(blob, { v: 1, width: W, height: Math.max(H, pageH), grid, strokes });
  }

  async function exportImage() {
    const blob = await render();
    if (!blob) { snackbar('Nothing to export yet'); return; }
    const a = h('a', { href: URL.createObjectURL(blob), download: `drawing-${Date.now()}.png` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function close({ deleted = false, thenNew = false } = {}) {
    if (closed) return;
    closed = true;
    closePopover();
    unstack();
    window.removeEventListener('resize', resize);
    document.removeEventListener('keydown', keys, true);
    const blob = deleted ? null : await render();
    root.remove();
    await onDone(deleted ? { deleted: true } : blob ? { blob } : { empty: true });
    if (thenNew && onNew) onNew();
  }

  const keys = (e) => {
    if (closed) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) { e.preventDefault(); deleteSelection(); }
  };
  document.addEventListener('keydown', keys, true);
  window.addEventListener('resize', resize);
  const unstack = pushLayer(() => close());

  renderToolbar();
  resize();
}
