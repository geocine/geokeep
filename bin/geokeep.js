#!/usr/bin/env node
// GeoKeep command line: serve, import, export, snapshot.

import { createWriteStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Store } from '../server/store.js';
import { createServer } from '../server/app.js';
import { findSources, importSources, writeTakeoutZip, createSnapshot, listSnapshots } from '../server/takeout.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `GeoKeep - a self-hosted Google Keep that stores notes in Takeout format

Usage:
  geokeep serve   [--port 8737] [--host 127.0.0.1]   Run the web app
  geokeep import  <zip|folder>...                     Import Google Takeout zips or folders
  geokeep export  <out.zip> [--no-html]               Write a Takeout-shaped zip
  geokeep snapshot                                    Zip the data folder into data/snapshots

Options:
  --data <dir>   Data folder (default: ./data next to the app, or $GEOKEEP_DATA)

Environment:
  GEOKEEP_PASSWORD   Require this password (HTTP Basic auth). Set it before using --host 0.0.0.0.
  GEOKEEP_SNAPSHOTS  How many snapshots to keep (default 30)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    'no-html': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command = 'serve', ...args] = positionals;
if (values.help || command === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}

const dataDir = resolve(values.data || process.env.GEOKEEP_DATA || join(ROOT, 'data'));
const store = new Store(dataDir);
await store.init();
if (store.loadErrors.length) {
  console.warn(`Warning: ${store.loadErrors.length} note file(s) could not be read and were left untouched:`);
  for (const e of store.loadErrors) console.warn(`  ${e.file}: ${e.error}`);
}

switch (command) {
  case 'serve': {
    const port = Number(values.port || process.env.PORT || 8737);
    const host = values.host || process.env.HOST || '127.0.0.1';
    const password = process.env.GEOKEEP_PASSWORD || '';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !password) {
      console.warn('Warning: listening beyond this machine without GEOKEEP_PASSWORD. Anyone on the network can read your notes.');
    }
    const server = createServer(store, { password, host });
    server.listen(port, host, () => {
      console.log(`GeoKeep: ${store.notes.size} notes in ${dataDir}`);
      console.log(`Open http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${port}`);
    });
    startDailySnapshots();
    break;
  }
  case 'import': {
    if (!args.length) fail('Give at least one Takeout zip or folder to import.');
    const sources = await findSources(args.map((a) => resolve(a)));
    for (const s of sources) console.log(`Source: ${s.kind} ${s.path}`);
    const report = await importSources(store, sources, { log: (m) => console.log(m) });
    printReport(report);
    break;
  }
  case 'export': {
    const out = resolve(args[0] || `takeout-geokeep-${Date.now()}.zip`);
    await writeTakeoutZip(store, createWriteStream(out), { html: !values['no-html'] });
    console.log(`Wrote ${store.notes.size} notes to ${out}`);
    break;
  }
  case 'snapshot': {
    const name = await createSnapshot(store, 'manual');
    console.log(`Snapshot: ${join(store.snapshotDir, name)}`);
    break;
  }
  default:
    fail(`Unknown command "${command}".\n\n${HELP}`);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function printReport(r) {
  if (r.snapshot) console.log(`Snapshot before import: ${r.snapshot}`);
  console.log(`Added: ${r.added.length}  Updated: ${r.updated.length}  Unchanged: ${r.unchanged}  Kept newer local copy: ${r.keptLocal.length}`);
  console.log(`Attachments copied: ${r.attachmentsCopied}  Labels added: ${r.labelsAdded.length ? r.labelsAdded.join(', ') : 'none'}`);
  for (const d of r.dangling) console.log(`Missing attachment: ${d.note} -> ${d.filePath} (${d.reason})`);
  for (const w of r.warnings) console.log(`Warning: ${w}`);
  for (const e of r.errors) console.log(`Error: ${e}`);
}

function startDailySnapshots() {
  const DAY = 24 * 60 * 60 * 1000;
  const check = async () => {
    try {
      if (!store.notes.size) return;
      const [latest] = await listSnapshots(store);
      if (!latest || Date.now() - latest.time > DAY) {
        const name = await createSnapshot(store, 'daily');
        console.log(`Daily snapshot: ${name}`);
      }
    } catch (err) {
      console.error('Snapshot failed:', err.message);
    }
  };
  check();
  setInterval(check, 60 * 60 * 1000).unref();
}
