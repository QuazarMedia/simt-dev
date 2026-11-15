// A02: the trigram table is keyed by path, not by node id, so rebuilding a
// changed file's rows never deleted the bodies it used to have. A CJK term the
// file no longer contains stayed searchable.
//
// Separate from test/index.test.mjs, which is at the 400-line review trigger.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { git } from './fixture.mjs';
import { reindex } from '../src/index/store.mjs';
import { SQLITE_FILE } from '../src/index/persist.mjs';

test('reindexing a changed file drops its old CJK trigram rows (A02)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-tri-'));
  try {
    await git(['init', '-q', root]);
    await writeFile(join(root, 'note.md'), '# 設計\n\n東京の設計メモ\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root);

    const trigramBodies = () => {
      const db = new DatabaseSync(join(root, SQLITE_FILE));
      try {
        return db.prepare(`select body from fts_tri where ref = 'note.md'`).all().map((row) => row.body);
      } finally {
        db.close();
      }
    };

    const before = trigramBodies();
    assert.ok(before.length > 0, 'the CJK body reached the trigram table');
    assert.ok(before.some((body) => body.includes('東京')), 'the term is indexed before the change');

    await writeFile(join(root, 'note.md'), '# design\n\nthe design note, in latin\n');
    await git(['-C', root, 'add', 'note.md']);
    await git(['-C', root, 'commit', '-qm', 'rewrite']);
    await reindex(root);

    const after = trigramBodies();
    assert.ok(after.every((body) => !body.includes('東京')), 'the removed term is no longer searchable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
