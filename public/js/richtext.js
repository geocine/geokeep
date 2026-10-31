// Keep note bodies: stored as textContent (plain) plus textContentHtml (Docs-style
// HTML). Both are reduced to one block model:
//   [{ type: 'p' | 'h1' | 'h2', runs: [{ text, b, i, u, br }] }]
// which renders for display, loads into the editor, and serializes back.

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre']);
const SKIP_TAGS = new Set(['script', 'style', 'template', 'head', 'title', 'meta', 'link', 'img', 'iframe', 'object']);

function formatOf(el, fmt) {
  const f = { ...fmt };
  const tag = el.tagName.toLowerCase();
  if (tag === 'b' || tag === 'strong') f.b = true;
  if (tag === 'i' || tag === 'em') f.i = true;
  if (tag === 'u') f.u = true;
  const st = el.style;
  if (st) {
    const w = st.fontWeight;
    if (w === 'bold' || w === 'bolder' || Number(w) >= 600) f.b = true;
    else if (w === 'normal' || (Number(w) > 0 && Number(w) < 600)) f.b = false;
    if (st.fontStyle === 'italic') f.i = true;
    else if (st.fontStyle === 'normal') f.i = false;
    const deco = `${st.textDecoration} ${st.textDecorationLine}`;
    if (deco.includes('underline')) f.u = true;
  }
  return f;
}

function addRun(block, text, fmt, br = false) {
  const last = block.runs[block.runs.length - 1];
  const same = last && !last.br && !br && !!last.b === !!fmt.b && !!last.i === !!fmt.i && !!last.u === !!fmt.u;
  if (same) last.text += text;
  else block.runs.push({ text, b: !!fmt.b, i: !!fmt.i, u: !!fmt.u, br });
}

/** Parse a DOM subtree (stored HTML or the live editor) into blocks. */
export function parseNode(root) {
  const blocks = [];
  let cur = null;
  let pendingType = 'p';
  const ensure = () => {
    if (!cur) { cur = { type: pendingType, runs: [] }; blocks.push(cur); }
    return cur;
  };
  const endBlock = () => {
    // A trailing <br> in a block does not render as a line of its own.
    if (cur) {
      const last = cur.runs[cur.runs.length - 1];
      if (last?.br) cur.runs.pop();
    }
    cur = null;
  };
  const visit = (node, fmt) => {
    if (node.nodeType === 3) {
      const text = node.data.replace(/ /g, ' ').replace(/\r/g, '');
      if (text) addRun(ensure(), text, fmt);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'br') { addRun(ensure(), '\n', fmt, true); return; }
    const f = formatOf(node, fmt);
    if (BLOCK_TAGS.has(tag)) {
      endBlock();
      const before = blocks.length;
      pendingType = tag === 'h1' ? 'h1' : tag === 'h2' || tag === 'h3' ? 'h2' : 'p';
      for (const c of node.childNodes) visit(c, f);
      if (blocks.length === before) blocks.push({ type: pendingType, runs: [] }); // an empty line
      endBlock();
      pendingType = 'p';
      return;
    }
    for (const c of node.childNodes) visit(c, f);
  };
  for (const c of root.childNodes) visit(c, {});
  endBlock();
  return blocks;
}

export function parseKeepHtml(html) {
  // DOMParser documents are inert: nothing loads or runs.
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}</body>`, 'text/html');
  return parseNode(doc.body);
}

export function blocksFromText(text) {
  return String(text ?? '').split('\n').map((line) => ({ type: 'p', runs: line ? [{ text: line, b: false, i: false, u: false, br: false }] : [] }));
}

export function blocksToText(blocks) {
  return blocks.map((b) => b.runs.map((r) => r.text).join('')).join('\n');
}

export function hasFormatting(blocks) {
  return blocks.some((b) => b.type !== 'p' || b.runs.some((r) => r.b || r.i || r.u));
}

/** Blocks for a stored note body. textContent is the source of truth. */
export function noteBlocks(note) {
  const text = note.textContent || '';
  if (!note.textContentHtml) return blocksFromText(text);
  const parsed = parseKeepHtml(note.textContentHtml);
  if (blocksToText(parsed) === text || hasFormatting(parsed)) return parsed;
  return blocksFromText(text);
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Keep-compatible HTML: <p dir="ltr"> per line, styled spans for formatting. */
export function blocksToKeepHtml(blocks) {
  return blocks.map((block) => {
    const inner = block.runs.map((r) => {
      if (r.br) return '<br />';
      // Spaces a browser would collapse become no-break spaces, as in Takeout.
      const text = escapeHtml(r.text).replace(/(^| ) /g, '$1 ').replace(/\n/g, '<br />');
      const style = [r.b && 'font-weight:700;', r.i && 'font-style:italic;', r.u && 'text-decoration:underline;'].filter(Boolean).join('');
      return style ? `<span style="${style}">${text}</span>` : text;
    }).join('');
    return `<${block.type} dir="ltr">${inner}</${block.type}>`;
  }).join('');
}

// ---- Rendering -------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;

/** Append text to parent, turning URLs into links. */
export function appendLinkified(parent, text) {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = m[0];
    parent.append(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** Blocks to DOM. Editor mode skips links so the markup stays plain. */
export function renderBlocks(blocks, { linkify = true } = {}) {
  const frag = document.createDocumentFragment();
  for (const block of blocks) {
    const el = document.createElement(block.type);
    for (const r of block.runs) {
      if (r.br) { el.append(document.createElement('br')); continue; }
      let target = el;
      let wrap = null;
      for (const [on, tag] of [[r.b, 'b'], [r.i, 'i'], [r.u, 'u']]) {
        if (!on) continue;
        const w = document.createElement(tag);
        (wrap || el).append(w);
        wrap = w;
      }
      if (wrap) target = wrap;
      if (linkify) appendLinkified(target, r.text);
      else target.append(r.text);
    }
    if (!block.runs.length || block.runs[block.runs.length - 1].br) el.append(document.createElement('br'));
    frag.append(el);
  }
  return frag;
}

/** Cut blocks for a card preview. Returns { blocks, truncated }. */
export function truncateBlocks(blocks, maxChars = 700, maxLines = 18) {
  const out = [];
  let chars = 0;
  let lines = 0;
  for (const b of blocks) {
    if (chars >= maxChars || lines >= maxLines) return { blocks: out, truncated: true };
    const runs = [];
    for (const r of b.runs) {
      if (chars >= maxChars) break;
      const room = maxChars - chars;
      runs.push(r.text.length > room ? { ...r, text: `${r.text.slice(0, room)}…` } : r);
      chars += r.text.length;
      lines += (r.text.match(/\n/g) || []).length;
    }
    out.push({ ...b, runs });
    lines++;
  }
  return { blocks: out, truncated: chars > maxChars };
}
