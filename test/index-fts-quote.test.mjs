// A22: `ftsBranch` wrapped each term as `"term"` and joined them with OR. A term that
// already carried a quote closed the phrase early, so SQLite answered with a syntax error
// that `search` reported as a read failure instead of returning rows.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from './fixture.mjs';
import { reindex } from '../src/index/store.mjs';
import { openIndex } from '../src/index/open.mjs';

test('a quote in a search term is escaped, not a MATCH failure (A22)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-quote-'));
  try {
    await git(['init', '-q', root]);
    await writeFile(join(root, 'rates.md'), '# rates\n\nthe standard rate is 19 percent\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);

    const ix = await openIndex(root);
    assert.equal(ix.ok, true);
    const result = await ix.search('standard rate "19"');
    assert.equal(result.ok, true, result.error?.message);
    assert.ok(Array.isArray(result.data));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
