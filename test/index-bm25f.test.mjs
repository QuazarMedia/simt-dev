import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { ensureGit, git, tempDir } from './fixture.mjs';
import { BM25F_FIELDS } from '../src/index/bm25f.mjs';
import { SQLITE_FILE } from '../src/index/persist.mjs';
import {
  BM25F_WEIGHTS, buildFieldedFtsBodies, readFieldedFts, readFts, readGraph,
  reindex, scoreFtsBm25F, searchFtsBm25, searchFtsBm25F,
} from '../src/index/store.mjs';

async function fixture() {
  const root = await tempDir('index-fielded-');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'auth.mjs'), 'export function refreshTokenRotation(value) { return value; }\n');
  await writeFile(join(root, 'src', 'note.mjs'), '// This discussion mentions refresh and token repeatedly.\n');
  await writeFile(join(root, 'manual.md'), '# Token\n\nA note about refresh.\n\n検索言語を切り替える。\n');
  await writeFile(join(root, 'README.md'), '# Read me\n');
  await ensureGit(root);
  return root;
}

test('native weighted FTS5 and in-memory BM25F agree on ordered section scores', async () => {
  const root = await fixture();
  await reindex(root, { fielded: true });
  const rows = await readFieldedFts(root);
  assert.equal(rows.error, undefined);
  assert.deepEqual(BM25F_WEIGHTS, [3, 10, 6, 3.5, 2.5, 1, 1.8, 2.2]);
  for (const query of ['refresh token rotation', 'refresh token', 'refreshTokenRotation', '検索言語', 'dos-not-exist']) {
    const native = await searchFtsBm25F(root, query);
    const local = scoreFtsBm25F(rows, query);
    assert.equal(native.error, undefined);
    assert.deepEqual(native.map(({ path }) => path), local.map(({ path }) => path), query);
    for (const [index, row] of native.entries()) assert.ok(Math.abs(row.score - local[index].score) < 1e-12, query);
  }
  assert.equal((await searchFtsBm25F(root, 'refresh token'))[0].path, 'src/auth.mjs');
  assert.equal((await searchFtsBm25F(root, '検索言語'))[0].path, 'manual.md');
  const database = new DatabaseSync(join(root, SQLITE_FILE), { readOnly: true });
  try {
    const columns = database.prepare('pragma table_info(fts)').all().map(({ name }) => name);
    assert.deepEqual(columns, [...BM25F_FIELDS, 'node_id', 'kind']);
    const indexes = database.prepare('pragma index_list(nodes)').all().map(({ name }) => name);
    assert.ok(indexes.includes('idx_nodes_kind_name'));
    assert.ok(indexes.includes('idx_symbols_folded_name'));
  } finally {
    database.close();
  }
});

test('migrates a v5 database without changing baseline ranking, then updates fielded rows incrementally', async () => {
  const root = await fixture();
  await reindex(root, { fielded: false });
  const database = new DatabaseSync(join(root, SQLITE_FILE));
  try {
    database.exec(`drop table fts;
      create virtual table fts using fts5(body, node_id unindexed, kind unindexed, tokenize = 'unicode61 remove_diacritics 2');
      insert into fts(body, node_id, kind) select body, node_id, kind from fts_legacy order by rowid;
      drop table fts_legacy;
      drop index idx_symbols_folded_name;
      update meta set value = '5' where key = 'schema';
      pragma user_version = 5`);
  } finally {
    database.close();
  }
  const legacy = await readFts(root);
  const ranking = await searchFtsBm25(root, 'refresh token');
  const files = (await readGraph(root)).files;
  assert.ok(legacy.length > 0);
  assert.deepEqual(await searchFtsBm25F(root, 'refresh token'), []);

  await reindex(root, { fielded: false });
  assert.deepEqual(await readFts(root), legacy);
  assert.deepEqual(await searchFtsBm25(root, 'refresh token'), ranking);
  assert.deepEqual((await readGraph(root)).files, files);
  assert.deepEqual(await readFieldedFts(root), []);
  const version = new DatabaseSync(join(root, SQLITE_FILE), { readOnly: true });
  try {
    assert.equal(version.prepare('pragma user_version').get().user_version, 7);
  } finally {
    version.close();
  }

  await reindex(root);
  assert.equal((await searchFtsBm25F(root, 'refreshTokenRotation'))[0].path, 'src/auth.mjs');
  await writeFile(join(root, 'src', 'auth.mjs'), 'export const validateReceipt = true;\n');
  await git(['add', 'src/auth.mjs'], { cwd: root });
  await git(['rm', 'src/note.mjs'], { cwd: root });
  const update = await reindex(root);
  assert.equal(update.updated, 1);
  assert.equal(update.removed, 1);
  assert.equal((await readFieldedFts(root)).some(({ ref }) => ref === 'src/note.mjs'), false);
  assert.deepEqual(await searchFtsBm25F(root, 'refreshtokenrotation'), []);
  assert.equal((await searchFtsBm25F(root, 'validate receipt'))[0].path, 'src/auth.mjs');
  assert.equal((await reindex(root)).updated, 0);
});

test('field metadata appears once and content deep in a long file still matches', () => {
  const text = `# Main Heading\n${'noise repeated here\n'.repeat(500)}\n# Deep Heading\nThe rare keyword lies here.\n`;
  const rows = buildFieldedFtsBodies('docs/manual.md', [], text);
  assert.ok(rows.length > 1);
  assert.equal(rows.filter(({ path_tokens: tokens }) => tokens.length > 0).length, 1);
  assert.equal(rows.filter(({ headings }) => headings.includes('deep')).length, 1);
  assert.equal(scoreFtsBm25F(rows, 'rare keyword')[0].path, 'docs/manual.md');
});
