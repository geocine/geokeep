#!/usr/bin/env node
// Server-side load test: import, cold load, state payload, edits, re-import, export.
//   node bench/server-bench.js <takeoutDir> <scratchDataDir>
// The data dir is deleted and rebuilt; never point it at real data.

import { rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { findSources, importSources, writeTakeoutZip } from '../server/takeout.js';

const [src, dataDir] = process.argv.slice(2);
if (!src || !dataDir) {
  console.error('usage: node bench/server-bench.js <takeoutDir> <scratchDataDir>');
  process.exit(1);
}

const results = [];
async function time(label, fn) {
  const t = performance.now();
  const out = await fn();
  const ms = performance.now() - t;
  results.push([label, `${ms.toFixed(0)} ms`]);
  return out;
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

await rm(dataDir, { recursive: true, force: true });
let store = new Store(dataDir);
await store.init();
const report = await time('Import (first time)', async () => importSources(store, await findSources([src])));
results.push(['  notes added', report.added.length]);

store = new Store(dataDir);
await time('Cold start (read every note)', () => store.init());
results.push(['  heap after load', mb(process.memoryUsage().heapUsed)]);

const payload = await time('Build /api/state JSON', () => JSON.stringify(store.state()));
results.push(['  /api/state size', mb(Buffer.byteLength(payload))]);
const { gzipSync } = await import('node:zlib');
const gz = await time('  gzip it (level 4)', () => gzipSync(payload, { level: 4 }));
results.push(['  /api/state gzipped', mb(gz.length)]);

const ids = [...store.notes.keys()];
const edits = 200;
await time(`${edits} edits (text + rename)`, async () => {
  for (let i = 0; i < edits; i++) {
    const id = ids[(i * 7919) % ids.length];
    await store.updateNote(id, { title: `Edited ${i}`, textContent: `body ${i}` });
  }
});
results.push(['  per edit', `${(Number(results.at(-1)[1].split(' ')[0]) / edits).toFixed(2)} ms`]);

await time('100 creates', async () => {
  for (let i = 0; i < 100; i++) await store.createNote({ title: `New ${i}`, textContent: 'x' });
});

await time('Rename a label on every note', () => store.renameLabel('Label 01', 'Label One'));

const again = await time('Re-import same Takeout (all matched)', async () => importSources(store, await findSources([src])));
results.push(['  unchanged / updated / kept local', `${again.unchanged} / ${again.updated.length} / ${again.keptLocal.length}`]);

const zip = join(dataDir, 'export.zip');
await time('Export Takeout zip (with .html)', () => writeTakeoutZip(store, createWriteStream(zip)));
results.push(['  export size', mb((await stat(zip)).size)]);

results.push(['Peak RSS', mb(process.resourceUsage().maxRSS * 1024)]);
const w = Math.max(...results.map((r) => r[0].length));
for (const [k, v] of results) console.log(`${k.padEnd(w)}  ${v}`);
