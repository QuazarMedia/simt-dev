// A21: `sqliteBackend.read` caught every failure and returned `{nodes: [], edges: []}`,
// so a truncated database read as an overlay with no edits - the one answer a reader
// cannot tell apart from a working tree that matches the index.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sqliteBackend } from '../src/index/overlay.mjs';

test('a missing overlay is empty, and a corrupt one is an error (A21)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simt-overlay-db-'));
  try {
    const missing = await sqliteBackend(join(dir, 'missing.sqlite')).read();
    assert.deepEqual(missing, { nodes: [], edges: [] }, 'a missing file is an empty overlay');

    const file = join(dir, 'overlay.sqlite');
    const backend = sqliteBackend(file);
    await backend.write({ nodes: [], edges: [] });
    await writeFile(file, 'not a database');

    const corrupt = await backend.read();
    assert.equal(corrupt.error?.code, 'INDEX_CORRUPT', 'a truncated overlay read as empty');
    assert.match(corrupt.error.message, /overlay/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
