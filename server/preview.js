// The human-readable .html twin of a note, shaped like Takeout's own previews
// (same class names), so an export can be browsed without this app.

const COLOR_HEX = {
  DEFAULT: '#FFFFFF', RED: '#FF6D3F', ORANGE: '#FF9B00', YELLOW: '#FFDA00', GREEN: '#95D641', TEAL: '#1CE8B5',
  BLUE: '#3FC3FF', CERULEAN: '#82B1FF', PURPLE: '#B388FF', PINK: '#F8BBD0', BROWN: '#D7CCC8', GRAY: '#B8C4C9',
};

const STYLE = `body{background:#e8e8e8;font-family:'Google Sans',Roboto,system-ui,sans-serif;margin:0}
.note{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.25);margin:24px auto;max-width:600px;padding:16px 20px;color:#202124;overflow-wrap:anywhere}
.heading{color:#5f6368;font-size:12px;margin-bottom:8px}.meta-icons span{margin-right:6px}
.title{font-size:20px;font-weight:500;margin-bottom:12px}.content{font-size:14px;line-height:1.5;white-space:pre-wrap}
.content p{margin:0}.content h1{font-size:20px;margin:0}.content h2{font-size:16px;margin:0}
.list{list-style:none;padding:0;margin:0}.listitem{display:flex;gap:6px;font-size:14px;line-height:1.5}.listitem .text{white-space:pre-wrap}
.listitem.checked .text{text-decoration:line-through;color:#5f6368}
.attachments ul{list-style:none;padding:0;margin:0 0 12px}.attachments img{max-width:100%;border-radius:4px}
.chips{margin-top:12px}.chip{display:inline-block;border-radius:12px;background:rgba(0,0,0,.08);font-size:12px;padding:2px 10px;margin:2px}
.chip a{color:inherit;text-decoration:none}
${Object.entries(COLOR_HEX).map(([k, v]) => `.note.${k}{background:${v}}`).join('')}`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeUrl = (u) => (/^(https?:|mailto:)/i.test(String(u ?? '').trim()) ? u : '#');

const ALLOWED_TAGS = new Set(['p', 'br', 'h1', 'h2', 'span', 'b', 'i', 'u', 'strong', 'em']);
const ALLOWED_STYLE = /^(font-weight|font-style|text-decoration)$/;

/** Keep only formatting tags from stored note HTML. */
export function sanitizeKeepHtml(html) {
  return String(html).split(/(<[^>]*>)/).map((part) => {
    if (!part.startsWith('<')) return part.replace(/</g, '&lt;');
    const m = /^<(\/?)([a-zA-Z0-9]+)([^>]*)>$/.exec(part);
    if (!m || !ALLOWED_TAGS.has(m[2].toLowerCase())) return '';
    const tag = m[2].toLowerCase();
    if (m[1]) return `</${tag}>`;
    if (tag === 'br') return '<br />';
    const style = /style="([^"]*)"/.exec(m[3]);
    const kept = style ? style[1].split(';').map((d) => d.trim()).filter((d) => ALLOWED_STYLE.test(d.split(':')[0].trim())) : [];
    return `<${tag}${kept.length ? ` style="${esc(kept.join(';'))}"` : ''}>`;
  }).join('');
}

function formatEdited(usec) {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(Number(usec) / 1000));
}

export function renderNoteHtml(note) {
  const edited = esc(formatEdited(note.userEditedTimestampUsec));
  const icons = [
    note.isPinned && '<span class="pinned" title="Note pinned">📌</span>',
    note.isArchived && '<span class="archived" title="Note archived">🗄</span>',
    note.isTrashed && '<span class="trashed" title="Note trashed">🗑</span>',
  ].filter(Boolean).join('');
  const color = COLOR_HEX[note.color] ? note.color : 'DEFAULT';

  let body = '';
  if (note.attachments?.length) {
    body += `<div class="attachments"><ul>${note.attachments.map((a) => (String(a.mimetype).startsWith('audio/')
      ? `<li><audio controls="controls" src="${esc(a.filePath)}"></audio></li>`
      : `<li><img alt="" src="${esc(a.filePath)}" /></li>`)).join('')}</ul></div>`;
  }
  if (note.title) body += `<div class="title">${esc(note.title)}</div>`;
  if (Array.isArray(note.listContent)) {
    body += `<div class="content"><ul class="list">${note.listContent.map((i) => `<li class="listitem${i.isChecked ? ' checked' : ''}"><span class="bullet">${i.isChecked ? '&#9745;' : '&#9744;'}</span><span class="text">${esc(i.text)}</span></li>`).join('')}</ul></div>`;
  } else if (note.textContentHtml) {
    body += `<div class="content">${sanitizeKeepHtml(note.textContentHtml)}</div>`;
  } else if (note.textContent) {
    body += `<div class="content">${esc(note.textContent)}</div>`;
  }
  const chips = [
    ...(note.annotations || []).map((a) => `<span class="chip annotation ${esc(a.source || 'WEBLINK')}"><a title="${esc(a.description)}" href="${esc(safeUrl(a.url))}"><span class="annotation-text">${esc(a.title || a.url)}</span></a></span>`),
    ...(note.labels || []).map((l) => `<span class="chip label"><span class="label-name">${esc(l.name)}</span></span>`),
  ];
  if (chips.length) body += `<div class="chips">${chips.join('')}</div>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<title>${esc(note.title || formatEdited(note.userEditedTimestampUsec))}</title><style type="text/css">${STYLE}</style></head>
<body><div class="note ${color}"><div class="heading"><div class="meta-icons">${icons}</div>${edited}</div>${body}</div></body></html>
`;
}
