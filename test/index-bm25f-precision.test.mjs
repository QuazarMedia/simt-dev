import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { BM25F_B, fieldQueryTokenRoles, scoreFtsBm25F } from '../src/index/bm25f.mjs';
import { buildFieldedFtsBodies, readFieldedFts, reindex, searchFtsBm25F } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

test('BM25F_B calibrates per-field saturation parameters', () => {
  assert.equal(BM25F_B.path_tokens, 0.35);
  assert.equal(BM25F_B.symbol_names, 0.35);
  assert.equal(BM25F_B.qual_names, 0.40);
  assert.equal(BM25F_B.signatures, 0.50);
  assert.equal(BM25F_B.headings, 0.50);
  assert.equal(BM25F_B.body, 0.75);
});

test('fieldQueryTokenRoles preserves exact vs part roles from tokenizeIdentifiers', () => {
  const roles = fieldQueryTokenRoles('rotateCredentials');
  assert.deepEqual(roles, [
    { token: 'rotatecredentials', role: 'exact' },
    { token: 'rotate', role: 'part' },
    { token: 'credentials', role: 'part' },
    { token: 'credential', role: 'part' },
  ]);
});

test('long source file with exact symbol/path hit outranks short file with incidental subtoken match', async () => {
  const root = await tempDir('bm25f-precision-');
  await mkdir(join(root, 'src'), { recursive: true });
  const longBody = 'const filler = "unrelated";\n'.repeat(200);
  await writeFile(
    join(root, 'src', 'rotate-credentials.mjs'),
    `export function rotateCredentials() {\n${longBody}  return true;\n}\n`,
  );
  await writeFile(
    join(root, 'src', 'short-helper.mjs'),
    '// rotate the view\nexport const view = 1;\n',
  );
  await ensureGit(root);
  await reindex(root, { fielded: true });

  const native = await searchFtsBm25F(root, 'rotateCredentials');
  const rows = await readFieldedFts(root);
  const local = scoreFtsBm25F(rows, 'rotateCredentials');

  assert.equal(native[0].path, 'src/rotate-credentials.mjs');
  assert.equal(local[0].path, 'src/rotate-credentials.mjs');
  assert.ok(Math.abs(native[0].score - local[0].score) < 1e-6);
});

test('per-field B_f prevents a long body from penalizing a concise path/symbol match in memory', () => {
  const rows = [
    ...buildFieldedFtsBodies('src/rate-limit.mjs', [{ name: 'rateLimit', line: 1 }], 'rate limit ' + 'implementation detail '.repeat(120)),
    ...buildFieldedFtsBodies('docs/notes.md', [], 'rate limit'),
  ];
  const ranked = scoreFtsBm25F(rows, 'rateLimit');
  assert.equal(ranked[0].path, 'src/rate-limit.mjs');
});
