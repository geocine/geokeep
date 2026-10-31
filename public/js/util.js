import { icon } from './icons.js';

/** Small hyperscript: h('div', { class, onclick, dataset, style }, ...children). */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') {
        // Custom properties (--x) only work through setProperty.
        for (const [p, val] of Object.entries(v)) {
          if (p.startsWith('--')) el.style.setProperty(p, val);
          else el.style[p] = val;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

/** Round icon button with a tooltip. */
export function iconBtn(name, tip, onclick, cls = '') {
  return h('button', { type: 'button', class: `icon-btn ${cls}`, 'data-tip': tip, 'aria-label': tip, onclick }, icon(name));
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// ---- Colors ----------------------------------------------------------------

export const COLORS = [
  ['DEFAULT', 'Default'], ['RED', 'Coral'], ['ORANGE', 'Peach'], ['YELLOW', 'Sand'], ['GREEN', 'Mint'], ['TEAL', 'Sage'],
  ['BLUE', 'Fog'], ['CERULEAN', 'Storm'], ['PURPLE', 'Dusk'], ['PINK', 'Blossom'], ['BROWN', 'Clay'], ['GRAY', 'Chalk'],
];
const KNOWN = new Set(COLORS.map((c) => c[0]));

/** CSS background for a stored color name; unknown names render as DEFAULT. */
export function colorVar(name) {
  return `var(--c-${KNOWN.has(name) ? name : 'DEFAULT'})`;
}

// ---- Time --------------------------------------------------------------------

const usecToDate = (usec) => new Date(Number(usec) / 1000);
const sameDay = (a, b) => a.toDateString() === b.toDateString();

/** Keep-style "Edited 10:45 AM" / "Edited yesterday" / "Edited Oct 20" / "Edited Aug 3, 2024". */
export function editedLabel(usec) {
  const d = usecToDate(usec);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(d, now)) return `Edited ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `Edited yesterday, ${time}`;
  const opts = d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
  return `Edited ${d.toLocaleDateString(undefined, opts)}`;
}

export function fullDate(usec) {
  return usecToDate(usec).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---- Notes -------------------------------------------------------------------

export const isList = (note) => Array.isArray(note.listContent);

export function noteIsEmpty(note) {
  if (note.title?.trim()) return false;
  if (note.attachments?.length) return false;
  if (isList(note)) return !note.listContent.some((i) => i.text.trim());
  return !note.textContent?.trim();
}

export function safeUrl(url) {
  const u = String(url ?? '').trim();
  return /^(https?:|mailto:)/i.test(u) ? u : null;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url || ''); }
}

/** Text that search runs over. Cached per note object; edits replace the object. */
const searchCache = new WeakMap();
export function searchText(note) {
  let text = searchCache.get(note);
  if (text === undefined) {
    text = buildSearchText(note);
    searchCache.set(note, text);
  }
  return text;
}

function buildSearchText(note) {
  const parts = [note.title, note.textContent];
  for (const i of note.listContent || []) parts.push(i.text);
  for (const l of note.labels || []) parts.push(l.name);
  for (const a of note.annotations || []) parts.push(a.title, a.url, a.description);
  return parts.filter(Boolean).join('\n').toLowerCase();
}

export function mediaUrl(filePath) {
  return `/media/${encodeURIComponent(filePath)}`;
}
