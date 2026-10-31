#!/usr/bin/env node
// Write a small Takeout Keep folder of made-up notes, for screenshots and demos.
//   node bench/demo.js <outDir> [imagesDir]
// imagesDir may hold pasta, trail, plants and desk (.jpg or .png); missing ones are skipped.

import { mkdir, writeFile, copyFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const [outDir, imagesDir] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: node bench/demo.js <outDir> [imagesDir]');
  process.exit(1);
}

const keep = join(outDir, 'Takeout', 'Keep');
await mkdir(keep, { recursive: true });

const now = Date.now();
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const usec = (msAgo) => Math.round((now - msAgo) * 1000);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = (text) => text.split('\n').map((l) => `<p dir="ltr">${esc(l)}</p>`).join('');

const images = {};
if (imagesDir) {
  for (const f of await readdir(imagesDir).catch(() => [])) {
    const stem = f.replace(/\.[^.]+$/, '');
    const ext = extname(f).slice(1).toLowerCase();
    if (!['jpg', 'jpeg', 'png'].includes(ext)) continue;
    const name = `${(now - Object.keys(images).length * 9e6).toString(16)}.${(0x1234abcd + stem.length * 7919).toString(16).padStart(16, '0')}.${ext === 'jpeg' ? 'jpg' : ext}`;
    await copyFile(join(imagesDir, f), join(keep, name));
    images[stem] = { filePath: name, mimetype: ext === 'png' ? 'image/png' : 'image/jpeg' };
  }
}

const labels = ['Home', 'Work', 'Travel', 'Recipes', 'Reading', 'Ideas'];
const list = (items) => items.map(([text, isChecked = false]) => ({ textHtml: html(text), text, isChecked }));
const text = (t) => ({ textContent: t, textContentHtml: html(t) });

const notes = [
  { title: 'Weekend hike', color: 'GREEN', isPinned: true, ago: 2 * HOUR, image: 'trail', labels: ['Travel'],
    ...text('Pine Ridge loop, 11 km\nStart at 7:30 to catch the light at the lake.\nBring: water, trail mix, rain jacket') },
  { title: 'Groceries', color: 'YELLOW', isPinned: true, ago: 5 * HOUR, labels: ['Home'],
    listContent: list([['Sourdough'], ['Cherry tomatoes'], ['Fresh basil'], ['Parmesan'], ['Oat milk'], ['Coffee beans', true], ['Olive oil', true]]) },
  { title: 'Tomato basil pasta', color: 'RED', isPinned: true, ago: 1 * DAY, image: 'pasta', labels: ['Recipes'],
    ...text('Serves 2, 20 minutes\n1. Blister cherry tomatoes in olive oil with garlic\n2. Toss with spaghetti and pasta water\n3. Finish with basil and parmesan') },
  { title: 'Reading list', color: 'BLUE', ago: 3 * HOUR, labels: ['Reading'],
    listContent: list([['The Pragmatic Programmer'], ['A Pattern Language'], ['Project Hail Mary'], ['The Design of Everyday Things', true]]) },
  { title: 'Windowsill garden', color: 'TEAL', ago: 2 * DAY, image: 'plants', labels: ['Home', 'Ideas'],
    ...text('Basil and mint like the east window.\nRepot the pothos in spring.') },
  { title: 'Q4 planning', ago: 6 * HOUR, labels: ['Work'],
    textContent: 'Goals\nShip offline mode\nCut page load to under 1 s\nHire one more designer',
    textContentHtml: '<h2 dir="ltr">Goals</h2><p dir="ltr">Ship offline mode</p><p dir="ltr">Cut page load to <span style="font-weight:700;">under 1 s</span></p><p dir="ltr">Hire one more designer</p>' },
  { title: '', ago: 30 * 60e3, ...text('Call the plumber on Monday') },
  { title: 'Gift ideas', color: 'PINK', ago: 4 * DAY, labels: ['Ideas'],
    listContent: list([['Film camera for Sam'], ['Pottery class voucher'], ['Board game night kit'], ['Plant subscription', true]]) },
  { title: 'Desk setup', color: 'GRAY', ago: 5 * DAY, image: 'desk', labels: ['Work'],
    ...text('Monitor arm, warm desk lamp, cable tray.\nKeep the left side clear for notebooks.') },
  { title: 'Japan trip', color: 'CERULEAN', ago: 7 * DAY, labels: ['Travel'],
    ...text('Kyoto 3 nights, Tokyo 4 nights\nRail pass: decide by March\nhttps://www.japan.travel/en/'),
    annotations: [{ description: 'Official travel guide: destinations, itineraries and travel tips.', source: 'WEBLINK', title: 'Japan National Tourism Organization', url: 'https://www.japan.travel/en/' }] },
  { title: '', color: 'PURPLE', ago: 9 * DAY, ...text('Simplicity is the ultimate sophistication.') },
  { title: 'Packing list', color: 'BROWN', ago: 8 * DAY, labels: ['Travel'],
    listContent: list([['Passport'], ['Universal adapter'], ['Light jacket'], ['Walking shoes'], ['Chargers', true], ['Toiletries', true]]) },
  { title: 'Design review notes', ago: 10 * DAY, labels: ['Work'],
    ...text('Cards feel cramped on phones; try one column.\nDark mode contrast on chips is too low.\nNext review: Thursday') },
  { title: 'Bread', color: 'ORANGE', ago: 12 * DAY, labels: ['Recipes'],
    ...text('500 g flour, 350 g water, 100 g starter, 10 g salt.\nBulk 5 h, cold proof overnight, bake 45 min at 240 °C.') },
  { title: 'Podcast ideas', ago: 15 * DAY, labels: ['Ideas'],
    listContent: list([['Interview a local baker'], ['How maps are made'], ['Episode on note-taking tools']]) },
  { title: 'Old apartment', ago: 120 * DAY, isArchived: true, ...text('Keys returned, deposit received.') },
  { title: 'Draft', ago: 40 * DAY, isTrashed: true, ...text('Scratch text') },
];

await writeFile(join(keep, 'Labels.txt'), labels.map((l) => `${l}\n`).join(''));
let n = 0;
for (const spec of notes) {
  const { ago, image, labels: noteLabels, ...rest } = spec;
  const note = {
    color: 'DEFAULT', isTrashed: false, isPinned: false, isArchived: false, title: '',
    userEditedTimestampUsec: usec(ago), createdTimestampUsec: usec(ago + 3 * DAY),
    ...rest,
  };
  if (noteLabels) note.labels = noteLabels.map((name) => ({ name }));
  if (image && images[image]) note.attachments = [images[image]];
  await writeFile(join(keep, `${(note.title || `note-${n}`).replace(/[\\/:*?"<>|']/g, '_')}.json`), JSON.stringify(note));
  n++;
}
console.log(`Wrote ${n} demo notes (${Object.keys(images).length} images) to ${keep}`);
