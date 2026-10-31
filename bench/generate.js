#!/usr/bin/env node
// Write a synthetic Google Takeout Keep folder for load testing.
//   node bench/generate.js <outDir> <noteCount> [imageCount]
// Deterministic: the same arguments always produce the same files.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { crc32 } from '../server/zip.js';

const [outDir, countArg = '10000', imagesArg] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: node bench/generate.js <outDir> <noteCount> [imageCount]');
  process.exit(1);
}
const COUNT = Number(countArg);
const IMAGES = Number(imagesArg ?? Math.round(COUNT * 0.05));

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const WORDS = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ' +
  'grocery milk eggs bread coffee project meeting idea refactor deploy server keyboard recipe garden travel book movie music game ' +
  'remember call email buy fix check review write plan budget weekend trip photo backup password account invoice').split(' ');
const COLORS = ['DEFAULT', 'DEFAULT', 'DEFAULT', 'DEFAULT', 'RED', 'ORANGE', 'YELLOW', 'GREEN', 'TEAL', 'BLUE', 'CERULEAN', 'PURPLE', 'PINK', 'BROWN', 'GRAY'];
const LABELS = Array.from({ length: 40 }, (_, i) => `Label ${String(i + 1).padStart(2, '0')}`);
const sentence = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = (text) => text.split('\n').map((l) => `<p dir="ltr">${esc(l)}</p>`).join('');

function png(w, h, r, g, b) {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const keep = join(outDir, 'Takeout', 'Keep');
await mkdir(keep, { recursive: true });
await writeFile(join(keep, 'Labels.txt'), LABELS.map((l) => `${l}\n`).join(''));

const imageNames = [];
for (let i = 0; i < IMAGES; i++) {
  const name = `${(1500000000000 + i * 997).toString(16)}.${(i * 7919).toString(16).padStart(16, '0')}.png`;
  await writeFile(join(keep, name), png(int(40, 160), int(30, 160), int(0, 255), int(0, 255), int(0, 255)));
  imageNames.push(name);
}

const start = 1380000000000000; // 2013
const span = 1790000000000000 - start;
const used = new Set();
let imageCursor = 0;
for (let i = 0; i < COUNT; i++) {
  const created = start + Math.floor(rand() * span);
  const edited = created + Math.floor(rand() * 1e13);
  const note = {
    color: pick(COLORS),
    isTrashed: rand() < 0.03,
    isPinned: rand() < 0.05,
    isArchived: false,
    title: rand() < 0.85 ? sentence(int(1, 6)) : '',
    userEditedTimestampUsec: edited,
    createdTimestampUsec: created,
  };
  if (!note.isPinned && !note.isTrashed && rand() < 0.1) note.isArchived = true;
  if (rand() < 0.55) {
    const lines = Array.from({ length: int(1, 25) }, () => sentence(int(2, 18)));
    note.textContent = lines.join('\n');
    note.textContentHtml = html(note.textContent);
  } else {
    note.listContent = Array.from({ length: int(2, 40) }, () => {
      const text = sentence(int(1, 10));
      return { textHtml: html(text), text, isChecked: rand() < 0.2 };
    }).sort((a, b) => a.isChecked - b.isChecked);
  }
  if (rand() < 0.25) note.labels = [...new Set(Array.from({ length: int(1, 3) }, () => pick(LABELS)))].map((name) => ({ name }));
  if (rand() < 0.3) {
    note.annotations = Array.from({ length: int(1, 4) }, () => ({
      description: rand() < 0.8 ? sentence(int(5, 30)) : '', source: 'WEBLINK', title: sentence(int(2, 8)), url: `https://example.com/${pick(WORDS)}/${int(1, 99999)}`,
    }));
  }
  if (imageCursor < imageNames.length && rand() < 0.08) {
    const n = Math.min(int(1, 4), imageNames.length - imageCursor);
    note.attachments = imageNames.slice(imageCursor, imageCursor + n).map((filePath) => ({ filePath, mimetype: 'image/png' }));
    imageCursor += n;
  }
  let stem = (note.title || `untitled-${i}`).slice(0, 50);
  for (let k = 1; used.has(stem.toLowerCase()); k++) stem = `${(note.title || `untitled-${i}`).slice(0, 50)}(${k})`;
  used.add(stem.toLowerCase());
  await writeFile(join(keep, `${stem}.json`), JSON.stringify(note));
}
console.log(`Wrote ${COUNT} notes and ${IMAGES} images (${imageCursor} attached) to ${keep}`);
