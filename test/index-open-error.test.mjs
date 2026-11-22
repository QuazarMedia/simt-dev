// A20: `openIndex().search` passed the error object straight to `fail`, so the message a
// caller saw was `[object Object]` - the code was right and the reason was gone.
//
// The handle opens with `build: false` because a corrupt file cannot be reindexed; the
// point of the test is what `search` reports about the file it was given, not whether the
// index can be rebuilt.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, holdIndexLock } from './fixture.mjs';
import { reindex } from '../src/index/store.mjs';
import { SQLITE_FILE, readSqliteRows } from '../src/index/persist.mjs';
import { openIndex } from '../src/index/open.mjs';

test('a corrupt index surfaces the underlying message, not [object Object] (A20)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-open-'));
  try {
    await git(['init', '-q', root]);
    await writeFile(join(root, 'a.md'), '# a\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);
    await writeFile(join(root, SQLITE_FILE), 'not an index');

    const ix = await openIndex(root, { build: false });
    assert.equal(ix.ok, true, 'the handle opens; the file is what is broken');

    // A one-letter term is dropped before the query is built, so it never reaches the
    // file that is broken; the test needs a term that survives tokenisation.
    const result = await ix.search('anything');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INDEX_CORRUPT', 'the underlying code was replaced by E_READ');
    assert.equal(typeof result.error.message, 'string');
    assert.notEqual(result.error.message, '[object Object]', 'the error object was stringified');
    assert.ok(result.error.message.length > 0, 'the message is empty');

    // Status used to check "no rows" before "the read failed", so a corrupt
    // database answered E_NO_INDEX "the index is empty" (PR23).
    const status = await ix.status();
    assert.equal(status.ok, false);
    assert.equal(status.error.code, 'INDEX_CORRUPT', 'a corrupt index was reported as empty');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a transient busy index is waited for, not reported as INDEX_BUSY (A20)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-open-busy-'));
  try {
    await git(['init', '-q', root]);
    await writeFile(join(root, 'a.md'), '# a\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);

    const lock = await holdIndexLock(join(root, SQLITE_FILE));
    try {
      const ix = await openIndex(root, { build: false });
      assert.equal(ix.ok, true, 'the handle opens; the database is locked');
      const result = await ix.search('anything');
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally {
      await lock.done;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a busy index that does not clear keeps INDEX_BUSY (A20)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-open-timeout-'));
  try {
    await git(['init', '-q', root]);
    await writeFile(join(root, 'a.md'), '# a\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);

    const lock = await holdIndexLock(join(root, SQLITE_FILE));
    try {
      // The wait is tested above; disabling it here proves the timeout still maps
      // SQLITE_BUSY to INDEX_BUSY rather than collapsing it to E_READ.
      const result = await readSqliteRows(root, 'select 1', [], { busyTimeout: 0 });
      assert.equal(result.error?.code, 'INDEX_BUSY', 'the busy code was replaced by E_READ');
    } finally {
      await lock.done;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
