import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openZip, ZipWriter } from '../server/zip.js';
import { stemForNote, uniqueStem, imageSize, normalizeImported, mediaInfo } from '../server/format.js';
import { crc32 } from '../server/zip.js';
import { Store, applyPatch } from '../server/store.js';
import { findSources, importSources, writeTakeoutZip } from '../server/takeout.js';
import { parseMeta, previewable } from '../server/unfurl.js';

const PNG_1x2 = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000002080600000099b9e7a50000000d4944415478da63f8ffff3f0300050001ff5d1c8a0000000049454e44ae426082', 'hex');

async function tmp() {
  return mkdtemp(join(tmpdir(), 'geokeep-test-'));
}

function note(fields) {
  return {
    color: 'DEFAULT', isTrashed: false, isPinned: false, isArchived: false, title: '',
    userEditedTimestampUsec: 1700000000000000, createdTimestampUsec: 1700000000000000, textContent: '', ...fields,
  };
}

async function takeout(dir, notes, { labels, media = {} } = {}) {
  const keep = join(dir, 'Takeout', 'Keep');
  await mkdir(keep, { recursive: true });
  if (labels) await writeFile(join(keep, 'Labels.txt'), labels.map((l) => `${l}\n`).join(''));
  for (const [name, n] of Object.entries(notes)) await writeFile(join(keep, `${name}.json`), JSON.stringify(n));
  for (const [name, buf] of Object.entries(media)) await writeFile(join(keep, name), buf);
  return dir;
}

test('filename stems follow Takeout rules', () => {
  assert.equal(stemForNote("Rubik's Scene"), 'Rubik_s Scene');
  assert.equal(stemForNote('AIGC / Dreambooth / Stable Diffusion'), 'AIGC _ Dreambooth _ Stable Diffusion');
  assert.equal(stemForNote('Bose Issue '), 'Bose Issue_');
  assert.equal(stemForNote('x'.repeat(63)).length, 50);
  assert.equal(stemForNote('CON'), 'CON_');
  assert.match(stemForNote('', 1697559413138000), /^\d{4}-\d\d-\d\dT\d\d_\d\d_\d\d\.\d{3}[+-]\d\d_\d\d$/);
  assert.equal(uniqueStem('Prompt', new Set(['prompt'])), 'Prompt(1)');
  assert.equal(uniqueStem('Prompt', new Set(['prompt', 'prompt(1)'])), 'Prompt(2)');
});

test('image size is read from headers', () => {
  assert.deepEqual(imageSize(PNG_1x2), { width: 1, height: 2 });
});

test('drawings are PNGs whose strokes ride in a GeoKeepInk tEXt chunk', () => {
  const text = Buffer.from('GeoKeepInk\u0000e30=', 'latin1');
  const chunk = Buffer.alloc(12 + text.length);
  chunk.writeUInt32BE(text.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  text.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + text.length)), 8 + text.length);
  const drawing = Buffer.concat([PNG_1x2.subarray(0, 33), chunk, PNG_1x2.subarray(33)]);
  assert.deepEqual(mediaInfo(drawing), { width: 1, height: 2, ink: true });
  assert.deepEqual(mediaInfo(PNG_1x2), { width: 1, height: 2 });
});

test('older notes without createdTimestampUsec get the edited time', () => {
  const { note: n } = normalizeImported({ title: 't', color: 'RED', isPinned: false, isArchived: false, isTrashed: false, userEditedTimestampUsec: 5, textContent: 'a' }, 0);
  assert.equal(n.createdTimestampUsec, 5);
});

test('zip round trip, with UTF-8 names', async () => {
  const dir = await tmp();
  const file = join(dir, 'a.zip');
  const zw = new ZipWriter(createWriteStream(file));
  await zw.add('Takeout/Keep/Ünïcode note.json', Buffer.from('{"a":1}'.repeat(50)));
  await zw.add('Takeout/Keep/img.png', PNG_1x2, { compress: false });
  await zw.finish();
  const zip = await openZip(file);
  assert.deepEqual(zip.entries.map((e) => e.name), ['Takeout/Keep/Ünïcode note.json', 'Takeout/Keep/img.png']);
  assert.equal((await zip.read(zip.entries[0])).toString(), '{"a":1}'.repeat(50));
  assert.ok((await zip.read(zip.entries[1])).equals(PNG_1x2));
  await zip.close();
  await rm(dir, { recursive: true });
});

test('zips with more than 65,535 entries use ZIP64 and read back', async () => {
  const dir = await tmp();
  const file = join(dir, 'big.zip');
  const zw = new ZipWriter(createWriteStream(file));
  for (let i = 0; i < 70000; i++) await zw.add(`Takeout/Keep/n${i}.json`, Buffer.from(String(i)), { compress: false });
  await zw.finish();
  const zip = await openZip(file);
  assert.equal(zip.entries.length, 70000);
  assert.equal((await zip.read(zip.entries[69999])).toString(), '69999');
  await zip.close();
  await rm(dir, { recursive: true });
});

test('patches keep text and list exclusive and bump edited time only for content', () => {
  const n = note({ title: 'a', textContent: 'x', textContentHtml: '<p dir="ltr">x</p>', futureKey: 1 });
  const flagged = applyPatch(n, { isPinned: true }, { touch: true });
  assert.equal(flagged.userEditedTimestampUsec, n.userEditedTimestampUsec);
  const listed = applyPatch(n, { listContent: [{ text: 'a', isChecked: false }] }, { touch: true });
  assert.equal(listed.textContent, undefined);
  assert.equal(listed.textContentHtml, undefined);
  assert.deepEqual(listed.listContent, [{ textHtml: '<p dir="ltr">a</p>', text: 'a', isChecked: false }]);
  assert.ok(listed.userEditedTimestampUsec > n.userEditedTimestampUsec);
  assert.equal(listed.futureKey, 1, 'unknown keys survive');
  assert.equal(applyPatch(n, { labels: [] }, { touch: false }).labels, undefined);
});

test('import, export and re-import are lossless', async () => {
  const src = await takeout(await tmp(), {
    'Groceries': note({ title: 'Groceries', listContent: [{ textHtml: '<p dir="ltr">milk</p>', text: 'milk', isChecked: false }], textContent: undefined, labels: [{ name: 'House' }] }),
    'Photo': note({ title: 'Photo', attachments: [{ filePath: '1500000000000.123456789.png', mimetype: 'image/png' }], createdTimestampUsec: 1600000000000000 }),
  }, { labels: ['Work', 'House', 'Unused'], media: { '1500000000000.123456789.png': PNG_1x2 } });

  const a = new Store(join(await tmp(), 'data'));
  await a.init();
  const r1 = await importSources(a, await findSources([src]));
  assert.equal(r1.added.length, 2);
  assert.equal(r1.attachmentsCopied, 1);
  assert.deepEqual(a.labels, ['Work', 'House', 'Unused']);

  const zipFile = join(await tmp(), 'export.zip');
  await writeTakeoutZip(a, createWriteStream(zipFile));
  const b = new Store(join(await tmp(), 'data'));
  await b.init();
  await importSources(b, await findSources([zipFile]));
  for (const name of await readdir(a.keepDir)) {
    assert.deepEqual(await readFile(join(b.keepDir, name)), await readFile(join(a.keepDir, name)), name);
  }
  assert.deepEqual((await readdir(b.keepDir)).sort(), (await readdir(a.keepDir)).sort());
});

test('a later Takeout updates edited notes, keeps newer local edits, and never deletes', async () => {
  const t = 1700000000000000;
  const first = await takeout(await tmp(), {
    A: note({ title: 'A', textContent: 'v1', createdTimestampUsec: t }),
    B: note({ title: 'B', textContent: 'v1', createdTimestampUsec: t + 1 }),
    C: note({ title: 'C', textContent: 'only in first', createdTimestampUsec: t + 2 }),
    // Same created time, told apart by title.
    Room1: note({ title: 'Room 1', createdTimestampUsec: t + 9 }),
    Room2: note({ title: 'Room 2', createdTimestampUsec: t + 9 }),
  });
  const store = new Store(join(await tmp(), 'data'));
  await store.init();
  await importSources(store, await findSources([first]));
  const byTitle = (title) => [...store.notes.values()].find((e) => e.note.title === title);
  await store.updateNote(byTitle('B').id, { textContent: 'edited locally' });

  const second = await takeout(await tmp(), {
    A: note({ title: 'A', textContent: 'v2', createdTimestampUsec: t, userEditedTimestampUsec: t + 500 }),
    B: note({ title: 'B', textContent: 'v2 from google', createdTimestampUsec: t + 1, userEditedTimestampUsec: t + 500 }),
    Room2: note({ title: 'Room 2', textContent: 'edited', createdTimestampUsec: t + 9, userEditedTimestampUsec: t + 500 }),
    Room1: note({ title: 'Room 1', createdTimestampUsec: t + 9 }),
    D: note({ title: 'D', createdTimestampUsec: t + 3 }),
  });
  const r = await importSources(store, await findSources([second]));
  assert.deepEqual(r.updated.sort(), ['A', 'Room 2']);
  assert.deepEqual(r.keptLocal, ['B']);
  assert.deepEqual(r.added, ['D']);
  assert.equal(r.unchanged, 1);
  assert.ok(r.snapshot);
  assert.equal(byTitle('A').note.textContent, 'v2');
  assert.equal(byTitle('B').note.textContent, 'edited locally');
  assert.equal(byTitle('Room 2').note.textContent, 'edited');
  assert.ok(byTitle('C'), 'notes missing from a newer Takeout are kept');
  assert.equal(store.notes.size, 6);
});

test('missing attachments are recorded, sibling extensions are found, and the note is kept', async () => {
  const src = await takeout(await tmp(), {
    N: note({ title: 'N', attachments: [{ filePath: 'a.jpeg', mimetype: 'image/jpeg' }, { filePath: 'gone.png', mimetype: 'image/png' }, { filePath: '../evil.png' }] }),
  }, { media: { 'a.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } });
  const store = new Store(join(await tmp(), 'data'));
  await store.init();
  const r = await importSources(store, await findSources([src]));
  const [entry] = store.notes.values();
  assert.deepEqual(entry.note.attachments.map((a) => a.filePath), ['a.jpg', 'gone.png']);
  assert.equal(r.dangling.length, 2);
});

test('renaming a title renames the file; labels rename across notes without touching edited time', async () => {
  const store = new Store(join(await tmp(), 'data'));
  await store.init();
  const e = await store.createNote({ title: 'First', textContent: 'x', labels: [{ name: 'Old' }] });
  assert.equal(e.stem, 'First');
  const edited = store.get(e.id).note.userEditedTimestampUsec;
  await store.renameLabel('Old', 'New');
  assert.deepEqual(store.get(e.id).note.labels, [{ name: 'New' }]);
  assert.equal(store.get(e.id).note.userEditedTimestampUsec, edited);
  const renamed = await store.updateNote(e.id, { title: 'Second' });
  assert.equal(renamed.stem, 'Second');
  assert.deepEqual((await readdir(store.keepDir)).filter((f) => f.endsWith('.json')), ['Second.json']);
  assert.equal(await readFile(join(store.keepDir, 'Labels.txt'), 'utf8'), 'New\n');
});

test('link previews read Open Graph tags, with fallbacks', () => {
  const html = `<html><head><title>Fallback &amp; title</title>
    <meta property="og:title" content="Real &quot;Title&quot;">
    <meta name="description" content="Plain description">
    <meta content="/img/card.png" property="og:image">
  </head><body>…</body></html>`;
  assert.deepEqual(parseMeta(html, 'https://example.com/a/b'), { title: 'Real "Title"', description: 'Plain description', image: 'https://example.com/img/card.png' });
  assert.equal(parseMeta('<title> Only   title </title>', 'https://x.org/').title, 'Only title');
  assert.equal(previewable('https://example.com/x'), true);
  assert.equal(previewable('hxxps://example[.]com/x'), false);
  assert.equal(previewable('javascript:alert(1)'), false);
});
