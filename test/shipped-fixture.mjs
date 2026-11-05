// Shared fixtures for the shipped-bytes suites: the package root, the text extensions a
// leak scan reads, and the recursive collector both halves walk. Extracted when the suite
// crossed the line ceiling; two collectors would be two answers to what shipped bytes are.

import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Extensions a pattern over source can run against. Deliberately not everything: a
 * binary that happens to contain the bytes is not this tool naming anything, and
 * reading it as text fails on encoding instead of on a leak.
 */
const TEXT_EXTENSIONS = ['.md', '.mjs', '.json', '.yml', '.yaml', '.toml', '.sh'];

/** Every file under a published root. */
async function collect(dir, exts = TEXT_EXTENSIONS) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full, exts)));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out.sort();
}

export { ROOT, TEXT_EXTENSIONS, collect };
