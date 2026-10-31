import { writeFile, rename, unlink, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Write via temp file + rename so a crash never leaves a half-written note. */
export async function atomicWrite(file, data) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      // Windows: antivirus or an indexer can briefly hold the target open.
      if (attempt < 5 && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {
        await sleep(50 * (attempt + 1));
        continue;
      }
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
}

/** Map with at most `limit` calls in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function unlinkIfExists(file) {
  try {
    await unlink(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export async function readIfExists(file, encoding) {
  try {
    return await readFile(file, encoding);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
