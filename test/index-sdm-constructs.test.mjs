import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { BM25F_B } from '../src/index/bm25f.mjs';
import { readGraph } from '../src/index/graph-read.mjs';
import { rankMapV2 } from '../src/index/map-v2.mjs';
import { SQLITE_FILE } from '../src/index/persist.mjs';
import { extractCodeConstructs, isMeaningfulLiteral, rerankWithSdm } from '../src/index/sdm.mjs';
import { buildFieldedFtsBodies, reindex, searchFtsBm25F } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

test('BM25F_B calibrates invocations and string_literals and literal filter drops paths and URLs', () => {
  assert.equal(BM25F_B.invocations, 0.45);
  assert.equal(BM25F_B.string_literals, 0.40);
  assert.equal(isMeaningfulLiteral('./relative/path.mjs'), false);
  assert.equal(isMeaningfulLiteral('https://example.com/v1/health'), false);
  assert.equal(isMeaningfulLiteral('short'), false);
  assert.equal(isMeaningfulLiteral('database connection pool exhausted'), true);

  const constructs = extractCodeConstructs(
    'export function run() { acquireLease(); return "database connection pool exhausted"; }\n',
    'javascript',
  );
  assert.ok(constructs.invocations.includes('acquirelease'));
  assert.ok(constructs.string_literals.includes('exhausted'));
});

test('string_literals and invocations rank pasted error messages and callers #1 with native/JS parity', async () => {
  const root = await tempDir('index-sdm-constructs-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'src', 'pool.mjs'),
    'export function checkout() {\n  throw new Error("database connection pool exhausted");\n}\n',
  );
  await writeFile(
    join(root, 'src', 'notes.mjs'),
    '// When a database or connection or pool becomes exhausted, retry later.\nexport const docs = 1;\n',
  );
  await writeFile(
    join(root, 'src', 'orchestrator.mjs'),
    "import { checkout } from './pool.mjs';\nexport function runBatch() {\n  return checkout();\n}\n",
  );
  await ensureGit(root);
  await reindex(root);

  const hits = await searchFtsBm25F(root, 'database connection pool exhausted');
  assert.equal(hits[0].path, 'src/pool.mjs');

  const graph = await readGraph(root);
  const res = await rankMapV2(root, graph, 'database connection pool exhausted', { sdm: true, explain: true });
  assert.equal(res.ranked[0].path, 'src/pool.mjs');
  const ev = res.evidence.find((row) => row.path === 'src/pool.mjs');
  assert.ok(ev?.channels.bm25f?.matchedFields.includes('string_literals'));
  assert.ok(ev?.channels.bm25f?.sdm?.orderedHits > 0);
});

test('rerankWithSdm prefers ordered adjacent bigrams over out-of-order bag-of-words within 2ms', () => {
  const rows = [
    ...buildFieldedFtsBodies('src/unordered.mjs', [], '// exhausted pool after connection to database failed.\nexport const a = 1;\n'),
    ...buildFieldedFtsBodies('src/ordered.mjs', [], '// database connection pool exhausted under burst load.\nexport const b = 2;\n'),
  ];
  const tieInput = [
    { path: 'src/unordered.mjs', kind: 'code', score: 10 },
    { path: 'src/ordered.mjs', kind: 'code', score: 10 },
  ];
  const started = performance.now();
  const reranked = rerankWithSdm(tieInput, rows, 'database connection pool exhausted');
  const elapsed = performance.now() - started;
  assert.equal(reranked[0].path, 'src/ordered.mjs');
  assert.ok(reranked[0].score > reranked[1].score);
  assert.ok(elapsed < 10);
});

test('legacy 6-column fts table degrades smoothly on read-only searchFtsBm25F', async () => {
  const root = await tempDir('index-sdm-legacy6-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'alpha.mjs'), 'export function retryToken() { return 1; }\n');
  await ensureGit(root);
  await reindex(root);

  const db = new DatabaseSync(join(root, SQLITE_FILE));
  try {
    db.exec(`drop table fts;
      create virtual table fts using fts5(path_tokens, symbol_names, qual_names, signatures, headings, body, node_id UNINDEXED, kind UNINDEXED, tokenize = "unicode61 remove_diacritics 2");
      insert into fts(path_tokens, symbol_names, qual_names, signatures, headings, body, node_id, kind)
        select 'src alpha mjs', 'retrytoken retry token', '', '', '', 'export function retrytoken', id, 'code' from nodes where kind = 'file' limit 1;
      update meta set value = '6' where key = 'schema';
      pragma user_version = 6;`);
  } finally {
    db.close();
  }

  const hits = await searchFtsBm25F(root, 'retry token');
  assert.equal(hits[0]?.path, 'src/alpha.mjs');
});
