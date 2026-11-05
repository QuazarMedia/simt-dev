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

import { git } from './fixture.mjs';
import { reindex } from '../src/index/store.mjs';
import { SQLITE_FILE } from '../src/index/persist.mjs';
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
