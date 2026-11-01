// The dependency direction between production code and the bench.
//
// `simt gate`, `simt map`, `simt tests` and the index asked the bench whether a path was a
// test and which runner a repository uses, so every one of them required the bench to be
// present (review 0003 Q79). Those questions now live under `src/testing/`, and this test
// holds the direction: nothing outside the bench may import it.
//
// `src/commands/bench.mjs` is the bench's own command surface, and is the one file
// allowed to reach it. When the bench becomes an optional package, this is the file whose
// static imports become a loader.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ALLOWED = new Set(['src/commands/bench.mjs', 'bin/simt.mjs', 'src/compare/learn.mjs']);

async function sourceFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('no production module imports the bench', async () => {
  const offenders = [];
  for (const file of await sourceFiles(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    if (rel.startsWith('src/bench/') || ALLOWED.has(rel)) continue;
    const text = await readFile(file, 'utf8');
    // A comment may name a bench path; only a static or dynamic import can depend on one.
    for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]*\bbench\/[^'"]*)['"]/g)) {
      offenders.push(`${rel} imports ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [], 'production modules must import src/testing/* instead');
});

test('the testing modules do not import the bench either', async () => {
  const offenders = [];
  for (const file of await sourceFiles(join(ROOT, 'src', 'testing'))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]*\bbench\/[^'"]*)['"]/g)) {
      offenders.push(`${rel} imports ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
