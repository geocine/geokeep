// App shell: routing, sidebar, views, composer, selection, settings.

import { h, iconBtn, COLORS, colorVar, debounce, isList, searchText, formatBytes } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { state, subscribe, load, reloadFromDisk, onError, labelCount, renameLabel, deleteLabel, addLabel, createNote, attachImage } from './state.js';
import { openDrawing } from './drawing.js';
import { renderCard } from './card.js';
import { VirtualGrid, geometry, remeasureAll, withAnchor } from './grid.js';
import { NoteEditor, openNote, currentEditor } from './editor.js';
import { openDialog, openMenu, openColorPicker, snackbar, initTooltips, confirmDialog, pushLayer, hasLayers } from './ui.js';
import * as A from './actions.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const ui = {
  view: { kind: 'home' },
  filter: null, // { type: 'list'|'image'|'link'|'label'|'color', value, name }
  selected: new Set(),
  sort: store.get('gk-sort', 'edited'),
  layout: store.get('gk-layout', 'grid'),
  theme: store.get('gk-theme', 'system'),
  composer: null,
  order: [], // note ids in display order, for shift-click ranges
};

onError((err) => snackbar(`Error: ${err.message}`));

// ---- Routing -----------------------------------------------------------------

function parseHash() {
  const raw = location.hash.slice(1);
  const [kind, ...rest] = raw.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  if (kind === 'label' && arg) return { kind: 'label', label: arg };
  if (kind === 'archive') return { kind: 'archive' };
  if (kind === 'trash') return { kind: 'trash' };
  if (kind === 'search') return { kind: 'search', q: arg };
  return { kind: 'home' };
}

function go(hash, { replace = false } = {}) {
  if (location.hash === hash) { route(); return; }
  if (replace) { history.replaceState(null, '', hash); route(); } else location.hash = hash;
}

function route() {
  const prev = ui.view;
  ui.view = parseHash();
  if (ui.view.kind !== 'search') ui.filter = null;
  if (prev.kind !== ui.view.kind || prev.label !== ui.view.label) {
    ui.selected.clear();
    ui.composer?.close();
    window.scrollTo(0, 0);
  }
  const search = $('search');
  if (ui.view.kind === 'search' && document.activeElement !== search) search.value = ui.view.q || '';
  if (ui.view.kind !== 'search') { search.value = ''; document.body.classList.remove('search-open'); }
  closeNav();
  renderAll(false);
}

// ---- Phone drawer: slides over a dimmed page; tap outside or Back closes it.

let unstackNav = null;
function openNav() {
  document.body.classList.add('nav-open');
  $('scrim').hidden = false;
  unstackNav = pushLayer(closeNav);
}
function closeNav() {
  document.body.classList.remove('nav-open');
  $('scrim').hidden = true;
  const u = unstackNav;
  unstackNav = null;
  u?.();
}

// ---- Data for views -------------------------------------------------------

const SORTS = {
  edited: (a, b) => Number(b.note.userEditedTimestampUsec) - Number(a.note.userEditedTimestampUsec),
  created: (a, b) => Number(b.note.createdTimestampUsec) - Number(a.note.createdTimestampUsec),
  title: (a, b) => (a.note.title || '￿').localeCompare(b.note.title || '￿', undefined, { sensitivity: 'base', numeric: true }),
};

function matchesFilter(n, f) {
  if (!f) return true;
  if (f.type === 'list') return isList(n);
  if (f.type === 'image') return !!n.attachments?.length;
  if (f.type === 'link') return !!n.annotations?.length || /https?:\/\//.test(searchText(n));
  if (f.type === 'label') return !!n.labels?.some((l) => l.name === f.value);
  if (f.type === 'color') return (COLORS.some((c) => c[0] === n.color) ? n.color : 'DEFAULT') === f.value;
  return true;
}

function sections() {
  const all = [...state.notes.values()].sort(SORTS[ui.sort] || SORTS.edited);
  const v = ui.view;
  const split = (list, archivedToo) => {
    const out = [
      { title: 'Pinned', items: list.filter((e) => e.note.isPinned && !e.note.isArchived) },
      { title: 'Others', items: list.filter((e) => !e.note.isPinned && !e.note.isArchived) },
    ];
    if (archivedToo) out.push({ title: 'Archived', items: list.filter((e) => e.note.isArchived) });
    const nonEmpty = out.filter((s) => s.items.length);
    if (nonEmpty.length === 1 && nonEmpty[0].title === 'Others') nonEmpty[0].title = '';
    return nonEmpty;
  };
  if (v.kind === 'home') return split(all.filter((e) => !e.note.isTrashed && !e.note.isArchived), false);
  if (v.kind === 'label') return split(all.filter((e) => !e.note.isTrashed && e.note.labels?.some((l) => l.name === v.label)), true);
  if (v.kind === 'archive') return [{ title: '', items: all.filter((e) => e.note.isArchived && !e.note.isTrashed) }].filter((s) => s.items.length);
  if (v.kind === 'trash') return [{ title: '', items: all.filter((e) => e.note.isTrashed) }].filter((s) => s.items.length);
  // search
  const words = (v.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = all.filter((e) => !e.note.isTrashed && matchesFilter(e.note, ui.filter) && (!words.length || words.every((w) => searchText(e.note).includes(w))));
  return [{ title: '', items: hits }].filter((s) => s.items.length);
}

// ---- Rendering -----------------------------------------------------------------

function renderAll(animate = true) {
  if (!state.loaded) return;
  if (ui.view.kind === 'label' && !state.labels.includes(ui.view.label)) { go('#home', { replace: true }); return; }
  renderSidebar();
  renderTopbar();
  renderSelectionBar();
  renderBanner();
  renderComposer();
  renderContent(animate);
  const titles = { home: 'GeoKeep', archive: 'Archive', trash: 'Trash', search: 'Search' };
  document.title = ui.view.kind === 'label' ? `${ui.view.label} - GeoKeep` : ui.view.kind === 'home' ? 'GeoKeep' : `${titles[ui.view.kind]} - GeoKeep`;
}

function renderSidebar() {
  const v = ui.view;
  const item = (hash, ic, label, active) => h('a', { class: `nav-item${active ? ' active' : ''}`, href: hash, 'data-tip': document.body.classList.contains('nav-collapsed') ? label : null }, icon(ic), h('span', null, label));
  $('sidebar').replaceChildren(
    item('#home', 'bulb', 'Notes', v.kind === 'home'),
    ...state.labels.map((l) => item(`#label/${encodeURIComponent(l)}`, 'label', l, v.kind === 'label' && v.label === l)),
    h('button', { type: 'button', class: 'nav-item', onclick: openLabelsDialog }, icon('edit'), h('span', null, 'Edit labels')),
    item('#archive', 'archive', 'Archive', v.kind === 'archive'),
    item('#trash', 'trash', 'Trash', v.kind === 'trash'),
  );
}

function renderTopbar() {
  const v = ui.view;
  $('brand-name').textContent = v.kind === 'label' ? v.label : v.kind === 'archive' ? 'Archive' : v.kind === 'trash' ? 'Trash' : v.kind === 'search' ? 'Search' : 'GeoKeep';
  $('layout-btn').replaceChildren(icon(ui.layout === 'list' ? 'gridView' : 'listView'));
  $('layout-btn').dataset.tip = ui.layout === 'list' ? 'Grid view' : 'List view';
  const chip = $('search-chip');
  if (ui.filter) {
    chip.hidden = false;
    chip.replaceChildren(h('span', null, ui.filter.name), iconBtn('close', 'Remove filter', () => { ui.filter = null; renderAll(false); }, 'xs'));
  } else chip.hidden = true;
  $('search-clear').style.visibility = v.kind === 'search' ? 'visible' : 'hidden';
}

function renderBanner() {
  const b = $('banner');
  const parts = [];
  if (ui.view.kind === 'trash') {
    const n = [...state.notes.values()].filter((e) => e.note.isTrashed).length;
    parts.push(h('div', { class: 'banner' }, 'Notes in Trash stay until you delete them forever.',
      n ? h('button', { type: 'button', class: 'text-btn', onclick: A.emptyTrashConfirm }, 'Empty Trash') : null));
  }
  if (state.loadErrors.length) {
    parts.push(h('div', { class: 'banner' }, `${state.loadErrors.length} note file(s) in the data folder could not be read. They are left untouched.`,
      h('button', { type: 'button', class: 'text-btn', onclick: openSettings }, 'Details')));
  }
  b.replaceChildren(...parts);
}

function renderComposer() {
  const slot = $('composer-slot');
  const show = ui.view.kind === 'home' || ui.view.kind === 'label';
  if (ui.composer) return;
  if (!show) { slot.replaceChildren(); return; }
  const start = (opts) => {
    const ed = new NoteEditor({
      ...opts,
      labels: ui.view.kind === 'label' ? [ui.view.label] : [],
      onClose: () => { ui.composer = null; renderComposer(); },
    });
    ui.composer = ed;
    ed.mountInline(slot);
    return ed;
  };
  slot.replaceChildren(h('div', { class: 'composer-bar', onclick: (e) => { if (!e.target.closest('button')) start({}); } },
    h('span', { class: 'ph' }, 'Take a note…'),
    iconBtn('checkbox', 'New list', () => start({ list: true })),
    iconBtn('brush', 'New note with drawing', () => newDrawingNote()),
    iconBtn('image', 'New note with image', () => A.pickFiles((files) => start({}).addImages(files)))));
}

/** Keep's flow: draw first; a non-empty drawing becomes a note, which then opens. */
function newDrawingNote() {
  const labels = ui.view.kind === 'label' ? [{ name: ui.view.label }] : undefined;
  openDrawing({
    onNew: () => newDrawingNote(),
    onDone: async ({ blob }) => {
      if (!blob) return;
      try {
        const entry = await createNote({ textContent: '', ...(labels ? { labels } : {}) });
        await attachImage(entry.id, blob);
        openNote(entry.id);
      } catch (err) {
        snackbar(`Could not save drawing: ${err.message}`);
      }
    },
  });
}

function emptyState() {
  const v = ui.view;
  if (v.kind === 'search') {
    if (!v.q && !ui.filter) return renderFilters();
    return h('div', { class: 'empty' }, icon('search'), 'No matching results.');
  }
  if (v.kind === 'archive') return h('div', { class: 'empty' }, icon('archive'), 'Your archived notes appear here');
  if (v.kind === 'trash') return h('div', { class: 'empty' }, icon('trash'), 'No notes in Trash');
  if (v.kind === 'label') return h('div', { class: 'empty' }, icon('label'), 'No notes with this label yet');
  if (!state.notes.size) {
    return h('div', { class: 'empty' }, icon('bulb'), 'Notes you add appear here',
      h('div', { style: { fontSize: '14px' } }, 'Have a Google Keep export?'),
      h('button', { type: 'button', class: 'filled-btn', onclick: openSettings }, 'Import Google Takeout'));
  }
  return h('div', { class: 'empty' }, icon('bulb'), 'Notes you add appear here');
}

function renderFilters() {
  const setFilter = (f) => { ui.filter = f; renderAll(false); };
  const tile = (ic, name, f, cls = '') => h('button', { type: 'button', class: `tile ${cls}`, onclick: () => setFilter({ ...f, name }) }, icon(ic), h('span', null, name));
  const notes = [...state.notes.values()].filter((e) => !e.note.isTrashed).map((e) => e.note);
  const types = [
    notes.some(isList) && tile('checkbox', 'Lists', { type: 'list' }),
    notes.some((n) => n.attachments?.length) && tile('image', 'Images', { type: 'image' }),
    notes.some((n) => matchesFilter(n, { type: 'link' })) && tile('link', 'URLs', { type: 'link' }),
  ].filter(Boolean);
  const usedColors = new Set(notes.map((n) => n.color));
  return h('div', { class: 'filters' },
    types.length ? h('div', { class: 'filter-group' }, h('h3', null, 'Types'), h('div', { class: 'tiles' }, types)) : null,
    state.labels.length ? h('div', { class: 'filter-group' }, h('h3', null, 'Labels'), h('div', { class: 'tiles' },
      state.labels.map((l) => tile('label', l, { type: 'label', value: l }, 'lbl')))) : null,
    h('div', { class: 'filter-group' }, h('h3', null, 'Colors'), h('div', { class: 'color-tiles' },
      COLORS.filter(([k]) => usedColors.has(k)).map(([k, name]) => h('button', {
        type: 'button', class: 'swatch', style: { '--sw': colorVar(k) }, 'data-tip': name, 'aria-label': name,
        onclick: () => setFilter({ type: 'color', value: k, name }),
      })))));
}

const cardCtx = {
  selected: ui.selected,
  onOpen: (id) => openNote(id),
  onSelect: (id, shift) => toggleSelect(id, shift),
  onLabelClick: (name) => go(`#label/${encodeURIComponent(name)}`),
  relayout: debounce(() => remeasureAll(), 50),
};

let lastSelected = null;
function toggleSelect(id, shift) {
  if (shift && lastSelected) {
    const ids = ui.order;
    const [a, b] = [ids.indexOf(lastSelected), ids.indexOf(id)].sort((x, y) => x - y);
    if (a >= 0) for (const i of ids.slice(a, b + 1)) ui.selected.add(i);
  } else if (ui.selected.has(id)) ui.selected.delete(id);
  else ui.selected.add(id);
  lastSelected = id;
  renderAll(false);
}

// Each section is a virtual masonry grid (grid.js): every note has a position, but
// only cards near the viewport are in the DOM, so 50,000 notes scroll like 50.
// Sections persist while the view stays the same, so an edit rebuilds one card.
const sectionViews = new Map(); // section key -> { wrap, title, vg }
let sectionsFor = '';

function clearSections() {
  for (const sv of sectionViews.values()) sv.vg.destroy();
  sectionViews.clear();
}

function renderContent(animate) {
  const content = $('content');
  const all = ui.view.kind === 'search' && !ui.view.q && !ui.filter ? [] : sections();
  ui.order = all.flatMap((s) => s.items.map((e) => e.id));
  if (!all.length) {
    clearSections();
    content.replaceChildren(emptyState());
    return;
  }
  const key = `${ui.view.kind}|${ui.view.label || ''}|${ui.view.q || ''}|${ui.filter?.name || ''}|${ui.layout}`;
  const sameView = key === sectionsFor;
  if (!sameView) {
    clearSections();
    sectionsFor = key;
    animate = false;
  }
  const wanted = all.map((s, si) => ({ s, key: s.title || `#${si}` }));
  for (const [k, sv] of sectionViews) {
    if (!wanted.some((w) => w.key === k)) { sv.vg.destroy(); sectionViews.delete(k); }
  }
  const nodes = wanted.map(({ s, key: k }) => {
    let sv = sectionViews.get(k);
    if (!sv) {
      const title = h('div', { class: 'section-title' });
      const grid = h('div', { class: 'grid' });
      sv = {
        title,
        wrap: h('div', { class: 'section' }, title, grid),
        vg: new VirtualGrid(grid, { render: (it) => renderCard({ id: it.id, note: it.note }, cardCtx), media: () => state.media }),
      };
      sectionViews.set(k, sv);
    }
    sv.title.textContent = s.title;
    sv.title.hidden = !s.title;
    return sv.wrap;
  });
  if ([...content.children].some((c) => !nodes.includes(c))) content.replaceChildren(...nodes);
  else nodes.forEach((n, i) => { if (content.children[i] !== n) content.insertBefore(n, content.children[i] || null); });
  const geom = geometry(content.clientWidth, ui.layout === 'list');
  // In order, since each grid's position on the page depends on the ones above it.
  // Within the same view, the card at the top of the screen stays put.
  const apply = () => {
    for (const { s, key: k } of wanted) {
      sectionViews.get(k).vg.setItems(s.items.map((e) => ({ id: e.id, note: e.note, sel: ui.selected.has(e.id) })), geom, { animate });
    }
  };
  if (sameView) withAnchor(apply);
  else apply();
}

// ---- Selection bar -------------------------------------------------------------

let unstackSelection = null;
function renderSelectionBar() {
  for (const id of ui.selected) if (!state.notes.has(id)) ui.selected.delete(id);
  const n = ui.selected.size;
  const bar = $('selection-bar');
  bar.hidden = !n;
  document.body.classList.toggle('selecting', n > 0);
  if (n && !unstackSelection) unstackSelection = pushLayer(() => { ui.selected.clear(); renderAll(false); });
  if (!n && unstackSelection) { unstackSelection(); unstackSelection = null; }
  if (!n) return;
  const ids = [...ui.selected];
  const notes = ids.map((id) => state.notes.get(id).note);
  $('sel-count').textContent = `${n} selected`;
  const done = () => { ui.selected.clear(); renderAll(false); };
  let actions;
  if (ui.view.kind === 'trash') {
    actions = [
      iconBtn('deleteForever', 'Delete forever', async () => { if (await A.deleteNotesForever(ids)) done(); }),
      iconBtn('restore', 'Restore', () => { A.setTrashed(ids, false); done(); }),
    ];
  } else {
    const allPinned = notes.every((x) => x.isPinned);
    const allArchived = notes.every((x) => x.isArchived);
    actions = [
      iconBtn(allPinned ? 'pinFilled' : 'pin', allPinned ? 'Unpin' : 'Pin', () => { A.setPinned(ids, !allPinned); done(); }),
      iconBtn('palette', 'Background options', (e) => openColorPicker(e.currentTarget, notes.length === 1 ? notes[0].color : null, (c) => { A.setColor(ids, c); done(); })),
      iconBtn(allArchived ? 'unarchive' : 'archive', allArchived ? 'Unarchive' : 'Archive', () => { A.setArchived(ids, !allArchived); done(); }),
      iconBtn('more', 'More', (e) => openMenu(e.currentTarget, [
        { label: 'Delete note', onClick: () => { A.setTrashed(ids, true); done(); } },
        ...(n === 1 ? [{ label: 'Make a copy', onClick: () => { A.makeCopy(ids[0]); done(); } }] : []),
        { head: 'Add label to all' },
        ...state.labels.map((l) => ({ label: l, onClick: () => { for (const id of ids) A.toggleLabel(id, l, true); done(); } })),
      ])),
    ];
  }
  $('sel-actions').replaceChildren(...actions);
}

// ---- Edit labels -----------------------------------------------------------------

function openLabelsDialog() {
  const list = h('div');
  const newInput = h('input', { type: 'text', placeholder: 'Create new label', maxlength: 50 });
  const create = async () => {
    const name = newInput.value.trim();
    if (!name) return;
    try { await addLabel(name); newInput.value = ''; render(); } catch (err) { snackbar(err.message); }
  };
  newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  const render = () => {
    list.replaceChildren(...state.labels.map((name) => {
      const input = h('input', { type: 'text', value: name, maxlength: 50, 'aria-label': `Rename label ${name}` });
      const commit = async () => {
        const to = input.value.trim();
        if (!to || to === name) { input.value = name; return; }
        if (state.labels.includes(to) && !(await confirmDialog(`A label named "${to}" already exists. Merge "${name}" into it?`, 'Merge'))) { input.value = name; return; }
        try { await renameLabel(name, to); if (ui.view.label === name) go(`#label/${encodeURIComponent(to)}`, { replace: true }); render(); } catch (err) { snackbar(err.message); }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = name; input.blur(); e.stopPropagation(); } });
      input.addEventListener('change', commit);
      return h('div', { class: 'label-edit-row' },
        h('div', { class: 'swap' },
          h('span', { class: 'lbl-icon' }, icon('label', 'sm')),
          iconBtn('trash', 'Delete label', async () => {
            if (!(await confirmDialog(`We'll delete the label "${name}" and remove it from all of your notes. Your notes won't be deleted.`))) return;
            await deleteLabel(name);
            render();
          }, 'del-btn')),
        input,
        h('span', { class: 'count', 'data-tip': 'Notes with this label' }, String(labelCount(name))));
    }));
  };
  render();
  openDialog({
    title: 'Edit labels', cls: 'small',
    body: [h('div', { class: 'label-edit-row' }, h('span', { class: 'icon-btn' }, icon('add', 'sm')), newInput, iconBtn('check', 'Create label', create)), list],
    actions: [{ label: 'Done' }],
  });
  newInput.focus();
}

// ---- Settings: import, export, snapshots, appearance ------------------------------

function seg(options, value, onPick) {
  const el = h('div', { class: 'seg' });
  const render = (v) => el.replaceChildren(...options.map(([k, label]) => h('button', { type: 'button', class: k === v ? 'on' : '', onclick: () => { onPick(k); render(k); } }, label)));
  render(value);
  return el;
}

function applyTheme() {
  const dark = ui.theme === 'dark' || (ui.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** Collect files from a drop, walking dropped folders. */
async function filesFromDrop(dt) {
  const out = [];
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: `${prefix}${entry.name}` });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

/** Keep only what the importer needs, laid out as Keep/<file> and zips/<file>. */
function planUpload(items) {
  const zips = items.filter((i) => i.path.toLowerCase().endsWith('.zip'));
  const inKeep = items.filter((i) => /(^|\/)keep\/[^/]+$/i.test(i.path));
  const loose = inKeep.length ? inKeep : items.filter((i) => /\.(json|txt|png|jpe?g|gif|webp|bmp|heic|3gpp?|m4a|aac|mp3|ogg)$/i.test(i.path));
  return [
    ...zips.map((i) => ({ file: i.file, path: `zips/${i.path.split('/').pop()}` })),
    ...loose.filter((i) => !i.path.toLowerCase().endsWith('.html')).map((i) => ({ file: i.file, path: `Keep/${i.path.split('/').pop()}` })),
  ];
}

function importPanel() {
  const status = h('div');
  const bar = h('div');
  const progress = h('div', { class: 'progress', hidden: true }, bar);
  const report = h('div', { class: 'report' });
  const zipInput = h('input', { type: 'file', accept: '.zip,application/zip', multiple: true, hidden: true });
  const dirInput = h('input', { type: 'file', webkitdirectory: true, hidden: true });
  let busy = false;

  const run = async (items) => {
    if (busy) return;
    const plan = planUpload(items);
    if (!plan.length) { status.textContent = 'No Takeout zips or Keep notes found in that selection.'; return; }
    busy = true;
    report.replaceChildren();
    progress.hidden = false;
    const total = plan.reduce((s, p) => s + p.file.size, 0) || 1;
    let done = 0;
    try {
      const { id } = await api.importStart();
      for (const p of plan) {
        status.textContent = `Uploading ${p.path.split('/').pop()}…`;
        await api.importFile(id, p.path, p.file, (n) => { bar.style.width = `${Math.round(((done + n) / total) * 100)}%`; });
        done += p.file.size;
      }
      bar.style.width = '100%';
      status.textContent = 'Importing…';
      const r = await api.importCommit(id);
      await load();
      status.textContent = 'Import finished.';
      report.replaceChildren(renderReport(r));
    } catch (err) {
      status.textContent = `Import failed: ${err.message}`;
    } finally {
      busy = false;
      progress.hidden = true;
    }
  };

  zipInput.onchange = () => run([...zipInput.files].map((f) => ({ file: f, path: f.name })));
  dirInput.onchange = () => run([...dirInput.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
  const zone = h('div', { class: 'dropzone' },
    h('div', null, 'Drop Takeout zip files (all parts) or an extracted Takeout folder here'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'filled-btn', onclick: () => zipInput.click() }, 'Choose zip files'),
      h('button', { type: 'button', class: 'text-btn primary', onclick: () => dirInput.click() }, 'Choose folder')),
    zipInput, dirInput);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    run(await filesFromDrop(e.dataTransfer));
  });
  return [
    h('p', null, 'Notes you already have are matched by creation time and title. A note is replaced only when the Takeout copy was edited more recently. Nothing is deleted, and a snapshot is taken first.'),
    zone, progress, status, report,
  ];
}

function renderReport(r) {
  const list = (title, items) => (items.length ? [h('div', null, title), h('ul', null, items.slice(0, 200).map((x) => h('li', null, x)))] : []);
  return h('div', null,
    h('div', { class: 'stat' },
      h('span', null, 'New notes'), h('b', null, r.added.length),
      h('span', null, 'Updated (newer in Takeout)'), h('b', null, r.updated.length),
      h('span', null, 'Unchanged'), h('b', null, r.unchanged),
      h('span', null, 'Kept (newer here)'), h('b', null, r.keptLocal.length),
      h('span', null, 'Attachments copied'), h('b', null, r.attachmentsCopied),
      h('span', null, 'Labels added'), h('b', null, r.labelsAdded.length)),
    r.snapshot ? h('div', null, 'Snapshot taken first: ', h('code', null, r.snapshot)) : null,
    ...list('Missing attachments:', r.dangling.map((d) => `${d.note}: ${d.filePath} (${d.reason})`)),
    ...list('Warnings:', r.warnings),
    ...list('Errors:', r.errors));
}

function snapshotsPanel() {
  const listEl = h('ul', { class: 'snap-list' });
  const dirEl = h('code');
  const refresh = async () => {
    const { snapshots, dir } = await api.snapshots();
    dirEl.textContent = dir;
    listEl.replaceChildren(...(snapshots.length ? snapshots.slice(0, 50).map((s) => h('li', null,
      h('span', null, new Date(s.time).toLocaleString()), h('span', { style: { flex: 'none', color: 'var(--fg-2)' } }, formatBytes(s.size)),
      h('a', { href: `/api/snapshots/${encodeURIComponent(s.name)}`, download: s.name }, 'Download'))) : [h('li', null, 'No snapshots yet.')]));
  };
  refresh().catch(() => {});
  return [
    h('p', null, 'A snapshot is a Takeout-shaped zip of all notes. One is made daily while the server runs, and before every import. The newest 30 are kept in ', dirEl, '.'),
    h('div', { class: 'settings-row' },
      h('button', { type: 'button', class: 'text-btn primary', style: { paddingLeft: 0 }, onclick: async () => { await api.snapshot(); await refresh(); snackbar('Snapshot saved'); } }, 'Take a snapshot now')),
    listEl,
  ];
}

function openSettings() {
  const body = [
    h('h3', null, 'Import from Google Takeout'),
    ...importPanel(),
    h('h3', null, 'Export'),
    h('p', null, 'Download every note as a Google Takeout zip (Takeout/Keep/*.json with images and an .html preview of each note). This app, and any other Keep Takeout importer, can read it.'),
    h('a', { class: 'filled-btn', href: '/api/export', download: '', style: { display: 'inline-block', textDecoration: 'none' } }, 'Download Takeout zip'),
    h('h3', null, 'Snapshots'),
    ...snapshotsPanel(),
    h('h3', null, 'Appearance'),
    h('div', { class: 'settings-row' }, 'Theme', seg([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], ui.theme, (t) => { ui.theme = t; store.set('gk-theme', t); applyTheme(); })),
    h('div', { class: 'settings-row' }, 'Sort notes by', seg([['edited', 'Last edited'], ['created', 'Created'], ['title', 'Title']], ui.sort, (s) => { ui.sort = s; store.set('gk-sort', s); renderAll(false); })),
    h('h3', null, 'Storage'),
    h('p', null, 'Notes live as Takeout-format files in ', h('code', null, `${state.dataDir}${state.dataDir.includes('\\') ? '\\' : '/'}Keep`), '. You can back up or sync that folder with any tool. If you change files there by hand, reload them here.'),
    h('button', { type: 'button', class: 'text-btn primary', style: { paddingLeft: 0 }, onclick: async () => { await reloadFromDisk(); snackbar(`Reloaded ${state.notes.size} notes from disk`); } }, 'Reload from disk'),
    state.loadErrors.length ? h('div', { class: 'report' }, h('div', null, 'Files that could not be read:'), h('ul', null, state.loadErrors.map((e) => h('li', null, `${e.file}: ${e.error}`)))) : null,
  ];
  openDialog({ title: 'Settings', body, actions: [{ label: 'Close' }] });
}

// ---- Wiring ---------------------------------------------------------------------

function init() {
  initTooltips();
  if (store.get('gk-nav') === 'collapsed') document.body.classList.add('nav-collapsed');
  $('menu-btn').append(icon('menu'));
  $('search-btn').append(icon('search'));
  $('search-clear').append(icon('close'));
  $('search-open').append(icon('search'));
  $('refresh-btn').append(icon('refresh'));
  $('settings-btn').append(icon('settings'));
  $('sel-clear').append(icon('close'));

  $('menu-btn').onclick = () => {
    if (window.innerWidth <= 700) { if (document.body.classList.contains('nav-open')) closeNav(); else openNav(); return; }
    const collapsed = document.body.classList.toggle('nav-collapsed');
    store.set('gk-nav', collapsed ? 'collapsed' : 'open');
    renderSidebar();
    setTimeout(() => renderContent(true), 160);
  };
  $('refresh-btn').onclick = async () => {
    await reloadFromDisk();
    snackbar(`${state.notes.size} notes loaded`);
  };
  $('layout-btn').onclick = () => {
    ui.layout = ui.layout === 'list' ? 'grid' : 'list';
    store.set('gk-layout', ui.layout);
    document.documentElement.dataset.layout = ui.layout;
    renderAll(true);
  };
  $('settings-btn').onclick = (e) => openMenu(e.currentTarget, [
    { label: 'Settings, import & export', onClick: openSettings },
    { label: 'Edit labels', onClick: openLabelsDialog },
    'sep',
    { label: document.documentElement.dataset.theme === 'dark' ? 'Disable dark theme' : 'Enable dark theme', onClick:() => { ui.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('gk-theme', ui.theme); applyTheme(); } },
    { label: 'Download Takeout zip', onClick: () => { location.href = '/api/export'; } },
  ]);
  $('scrim').onclick = closeNav;
  $('sel-clear').onclick = () => { ui.selected.clear(); renderAll(false); };
  $('search-open').onclick = () => { document.body.classList.add('search-open'); $('search').focus(); };

  const search = $('search');
  search.addEventListener('focus', () => { if (ui.view.kind !== 'search') go(`#search/${encodeURIComponent(search.value)}`); });
  const runSearch = debounce(() => go(`#search/${encodeURIComponent(search.value)}`, { replace: true }), 120);
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); search.blur(); go('#home'); }
    if (e.key === 'Enter') { e.preventDefault(); search.blur(); }
  });
  $('search-form').addEventListener('submit', (e) => e.preventDefault());
  $('search-clear').onclick = () => { ui.filter = null; search.value = ''; go('#home'); };
  $('search-btn').onclick = () => search.focus();

  window.addEventListener('hashchange', route);
  window.addEventListener('resize', debounce(() => renderContent(true), 80));
  window.addEventListener('scroll', () => $('topbar').classList.toggle('scrolled', window.scrollY > 0), { passive: true });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t.closest?.('input, textarea, [contenteditable="true"]');
    if (typing || e.ctrlKey || e.metaKey || e.altKey || hasLayers() || currentEditor()) return;
    if (e.key === '/') { e.preventDefault(); search.focus(); }
    if ((e.key === 'c' || e.key === 'l') && (ui.view.kind === 'home' || ui.view.kind === 'label')) {
      e.preventDefault();
      renderComposer();
      const bar = document.querySelector('.composer-bar');
      if (e.key === 'c') bar?.click(); else bar?.querySelector('[data-tip="New list"]')?.click();
    }
  });

  // Images dropped on the page start a new note with them.
  document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.files.length || hasLayers() || currentEditor()) return;
    e.preventDefault();
    if (ui.view.kind !== 'home' && ui.view.kind !== 'label') go('#home');
    const files = [...e.dataTransfer.files];
    setTimeout(() => {
      document.querySelector('.composer-bar')?.click();
      currentEditor()?.addImages(files);
    });
  });

  subscribe(() => renderAll(true));
  ui.view = parseHash();
  load().then(() => renderAll(false)).catch((err) => {
    $('content').replaceChildren(h('div', { class: 'empty' }, icon('brokenImage'), `Could not reach the GeoKeep server: ${err.message}`));
  });
}

init();
