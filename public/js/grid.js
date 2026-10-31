// Virtual masonry. Every note has a position (shortest column first, like Keep),
// but only cards near the viewport exist in the DOM. Heights start as estimates,
// become exact when a card is rendered or measured in the background, and are
// cached per note object (an edit replaces the object, so it is measured again).

const CARD_W = 240;
const GAP = 16;
const LIST_W = 600;
const BUFFER = 1200; // px rendered above and below the viewport

const heights = new WeakMap(); // note -> Map(colW -> height)
const getHeight = (note, w) => heights.get(note)?.get(w);
function setHeight(note, w, h) {
  let m = heights.get(note);
  if (!m) heights.set(note, (m = new Map()));
  m.set(w, h);
}

/** Column count and width for the available space. */
export function geometry(avail, list) {
  if (list) return { cols: 1, colW: Math.min(LIST_W, avail), gap: GAP };
  if (avail < 2 * CARD_W + GAP) return { cols: 1, colW: avail, gap: GAP }; // phones: one full-width column
  return { cols: Math.max(1, Math.floor((avail + GAP) / (CARD_W + GAP))), colW: CARD_W, gap: GAP };
}

/** A rough height from the content, used until the card is measured. Cached like heights. */
const estimates = new WeakMap(); // note -> Map(colW -> estimate)
function estimate(note, w, media) {
  let m = estimates.get(note);
  if (!m) estimates.set(note, (m = new Map()));
  let h = m.get(w);
  if (h === undefined) m.set(w, (h = computeEstimate(note, w, media)));
  return h;
}

function computeEstimate(note, w, media) {
  const charsPerLine = Math.max(10, (w - 32) / 7.4);
  const lines = (s) => String(s || '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / charsPerLine)), 0);
  let h = 12 + 4 + 34; // padding, toolbar
  if (note.title) h += 28 * Math.ceil(note.title.length / (charsPerLine * 0.85)) + 8;
  if (Array.isArray(note.listContent)) {
    const open = note.listContent.filter((i) => !i.isChecked);
    h += open.slice(0, 10).reduce((n, i) => n + 4 + 20 * lines(i.text), 0);
    if (open.length > 10) h += 22;
    if (open.length < note.listContent.length) h += 22;
  } else if (note.textContent) {
    h += 20 * Math.min(18, lines(note.textContent.slice(0, 700)));
  }
  const atts = note.attachments || [];
  if (atts.length) {
    const m = media[atts[0].filePath];
    h += m?.width && m?.height ? (w * m.height) / m.width : (w * 3) / 4;
    if (atts.length > 1) h += Math.ceil((Math.min(atts.length, 6) - 1) / 3) * (w / 3);
  }
  if (note.labels?.length) h += 34;
  if (note.annotations?.length) h += 9 + Math.min(2, note.annotations.length) * 48 + (note.annotations.length > 2 ? 24 : 0);
  return Math.round(h);
}

const grids = new Set();

export class VirtualGrid {
  /** el: the .grid element. render(item) -> card element. */
  constructor(el, { render, media }) {
    this.el = el;
    this.render = render;
    this.media = media;
    this.items = [];
    this.pos = [];
    this.live = new Map(); // id -> { el, note, sel }
    this.index = new Map(); // id -> position in items
    grids.add(this);
  }

  destroy() {
    grids.delete(this);
    this.live.clear();
  }

  /** items: [{ id, note, sel }]; a card is rebuilt when its note object or selection changes. */
  setItems(items, geom, { animate = false } = {}) {
    this.items = items;
    this.geom = geom;
    this.el.classList.toggle('animate', animate);
    this.layout();
    this.sync({ animate });
    scheduleMeasure();
  }

  setGeometry(geom) {
    this.geom = geom;
    for (const rec of this.live.values()) rec.el.style.width = `${geom.colW}px`;
    this.layout();
    this.sync();
    scheduleMeasure();
  }

  layout() {
    const { cols, colW, gap } = this.geom;
    const colH = new Array(cols).fill(0);
    this.pos = this.items.map((it) => {
      let k = 0;
      for (let j = 1; j < cols; j++) if (colH[j] < colH[k] - 1) k = j;
      const exact = getHeight(it.note, colW);
      const h = exact ?? estimate(it.note, colW, this.media());
      const p = { x: k * (colW + gap), y: colH[k], h };
      colH[k] += h + gap;
      return p;
    });
    this.index = new Map(this.items.map((it, i) => [it.id, i]));
    const width = cols * colW + (cols - 1) * gap;
    this.el.style.width = `${width}px`;
    this.el.style.height = `${Math.max(0, Math.max(...colH) - gap)}px`;
    const title = this.el.previousElementSibling;
    if (title?.classList.contains('section-title')) title.style.width = `${width}px`;
  }

  /** Make the DOM hold exactly the cards near the viewport. */
  sync({ animate = false } = {}) {
    const top = this.el.getBoundingClientRect().top;
    const viewTop = -top - BUFFER;
    const viewBottom = window.innerHeight - top + BUFFER;
    const want = new Map();
    this.items.forEach((it, i) => {
      const p = this.pos[i];
      if (p.y < viewBottom && p.y + p.h > viewTop) want.set(it.id, i);
    });
    for (const [id, rec] of this.live) {
      if (!want.has(id)) { rec.el.remove(); this.live.delete(id); }
    }
    const fresh = [];
    for (const [id, i] of want) {
      const it = this.items[i];
      const rec = this.live.get(id);
      if (rec && rec.note === it.note && rec.sel === it.sel) continue;
      const el = this.render(it);
      el.style.width = `${this.geom.colW}px`;
      if (rec) {
        // Rebuilt in place: start where the old card was, so only real moves animate.
        el.style.transform = rec.el.style.transform;
        rec.el.replaceWith(el);
      } else {
        el.dataset.fresh = '';
        this.el.append(el);
      }
      this.live.set(id, { el, note: it.note, sel: it.sel });
      fresh.push(id);
    }
    // Measure what was just rendered; a corrected height moves later cards.
    let changed = false;
    for (const id of fresh) {
      const rec = this.live.get(id);
      const h = rec.el.offsetHeight;
      if (getHeight(rec.note, this.geom.colW) !== h) {
        setHeight(rec.note, this.geom.colW, h);
        changed = true;
      }
    }
    if (changed) this.layout();
    this.place(animate && !changed);
    if (changed) this.sync(); // the window may now cover different cards
  }

  place(animate) {
    if (!animate) this.el.classList.remove('animate');
    for (const [id, rec] of this.live) {
      const p = this.pos[this.index.get(id)];
      rec.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
  }

  /** Re-read heights of rendered cards (after an image without known size loads). */
  remeasure() {
    let changed = false;
    for (const rec of this.live.values()) {
      const h = rec.el.offsetHeight;
      if (getHeight(rec.note, this.geom.colW) !== h) { setHeight(rec.note, this.geom.colW, h); changed = true; }
    }
    if (changed) withAnchor(() => { this.layout(); this.place(false); this.sync(); });
  }

  /** Cards in order, rendered or not. */
  ids() {
    return this.items.map((it) => it.id);
  }
}

// ---- Scrolling and resizing ---------------------------------------------------

let ticking = false;
let lastScroll = 0;
window.addEventListener('scroll', () => {
  lastScroll = performance.now();
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    for (const g of grids) g.sync();
  });
}, { passive: true });

/** Keep the first visible card still while layout above it changes. */
export function withAnchor(fn) {
  let anchor = null;
  let before = 0;
  for (const g of grids) {
    for (const rec of g.live.values()) {
      const r = rec.el.getBoundingClientRect();
      if (r.bottom > 64 && (!anchor || r.top < before)) { anchor = rec.el; before = r.top; }
    }
  }
  fn();
  if (anchor?.isConnected) {
    const delta = anchor.getBoundingClientRect().top - before;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  }
}

export function remeasureAll() {
  for (const g of grids) g.remeasure();
}

// ---- Background measuring -----------------------------------------------------
// While the browser is idle, render unmeasured cards off-screen to learn their real
// heights, so columns settle before you scroll to them.

let measuring = false;
let probe = null;
const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 30));

function scheduleMeasure() {
  if (measuring) return;
  measuring = true;
  idle(measureSome);
}

function measureSome(deadline) {
  // Scrolling has priority: try again once it has been still for a moment.
  if (performance.now() - lastScroll < 250) {
    setTimeout(() => idle(measureSome), 250);
    return;
  }
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;contain:layout style;';
    document.body.append(probe);
  }
  let any = false;
  const touched = new Set();
  for (const g of grids) {
    const w = g.geom?.colW;
    if (!w) continue;
    const batch = [];
    for (const it of g.items) {
      if (getHeight(it.note, w) === undefined && !g.live.has(it.id)) batch.push(it);
      if (batch.length >= 40) break;
    }
    if (!batch.length) continue;
    any = true;
    const els = batch.map((it) => {
      const el = g.render(it);
      el.style.width = `${w}px`;
      el.style.position = 'static';
      probe.append(el);
      return el;
    });
    els.forEach((el, i) => setHeight(batch[i].note, w, el.offsetHeight));
    probe.replaceChildren();
    touched.add(g);
    if (deadline.timeRemaining() < 4) break;
  }
  if (touched.size) withAnchor(() => { for (const g of touched) { g.layout(); g.place(false); g.sync(); } });
  measuring = false;
  if (any) scheduleMeasure();
}
