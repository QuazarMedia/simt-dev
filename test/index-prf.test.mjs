import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

import { searchWithFeedback } from '../src/index/prf.mjs';
import { readFieldedFts, readGraph, reindex, searchFtsBm25F } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

const query = 'login timeout';
const gold = 'src/renew.mjs';

async function fixture() {
  const root = await tempDir('index-prf-');
  const files = {
    'src/first.mjs': '// login timeout login timeout ttl jwt\n',
    'src/second.mjs': '// login timeout login timeout ttl jwt\n',
    'src/hub.mjs': '// unrelated network bridge\n',
    'test/timeout.test.mjs': '// login timeout login timeout misdirect\n',
    [gold]: 'export function rotateTtlJwt() { return true; }\n',
  };
  for (let i = 0; i < 40; i += 1) files[`src/neutral-${i}.mjs`] = '// isolated notes\n';
  for (let i = 0; i < 26; i += 1) {
    files[`src/decoy-${i}.mjs`] = `// login timeout\n${'// filler verbose placeholder unrelated\n'.repeat(180)}`;
  }
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  }
  await ensureGit(root);
  await reindex(root, { fielded: true });
  return root;
}

const reciprocalRank = (hits) => {
  const rank = hits.findIndex(({ path }) => path === gold);
  return rank < 0 ? 0 : 1 / (rank + 1);
};
const recallAt10 = (hits) => Number(hits.slice(0, 10).some(({ path }) => path === gold));

test('both feedback methods recover a vocabulary gap while keeping term provenance', async (t) => {
  const root = await fixture();
  const graph = await readGraph(root);
  const ranking = await searchFtsBm25F(root, query);
  const fts = await readFieldedFts(root);
  assert.equal(recallAt10(ranking), 0);
  assert.equal(reciprocalRank(ranking), 0);
  const times = [];
  for (const method of ['bo1', 'rm3-lite']) {
    const options = { ranking, graph, method };
    const result = await searchWithFeedback(root, query, options);
    assert.equal(result.reason, null);
    assert.equal(result.error, null);
    assert.equal(recallAt10(result.ranking), 1);
    assert.ok(reciprocalRank(result.ranking) > reciprocalRank(ranking));
    assert.deepEqual(result.expansion.map(({ term }) => term), ['jwt', 'ttl']);
    assert.ok(result.expansion.every(({ sources }) =>
      sources.join(',') === 'src/first.mjs,src/second.mjs'));
    assert.ok(Math.abs(result.expansion.reduce((sum, { weight }) => sum + weight, 0) - 0.3) < 1e-12);
    for (const row of result.ranking) assert.equal(row.score, row.original + row.feedback);

    const overlay = await searchWithFeedback(root, query, { ...options, fts: [...fts].reverse() });
    assert.deepEqual(overlay, result);
    for (let run = 0; run < 5; run += 1) {
      const start = performance.now();
      const repeated = await searchWithFeedback(root, query, options);
      times.push(performance.now() - start);
      assert.equal(JSON.stringify(repeated), JSON.stringify(result));
    }
  }
  times.sort((a, b) => a - b);
  t.diagnostic(`${times[Math.floor(times.length / 2)].toFixed(2)} ms median feedback overhead`);
  assert.ok(times[Math.floor(times.length / 2)] <= 15);
});

test('a margin or exact anchor preserves the original ranking byte for byte', async () => {
  const root = await fixture();
  const graph = await readGraph(root);
  const confident = [{ path: gold, score: 1 }, { path: 'src/first.mjs', score: 0.65 }];
  const byMargin = await searchWithFeedback(root, query, { ranking: confident, graph });
  assert.equal(byMargin.reason, 'confident-top1');
  assert.equal(byMargin.ranking, confident);

  const tied = confident.map((row) => ({ ...row, score: 1 }));
  for (const exact of ['src/renew.mjs', 'rotateTtlJwt', 'renew.mjs']) {
    const guarded = await searchWithFeedback(root, exact, { ranking: tied, graph });
    assert.equal(guarded.reason, 'exact-anchor');
    assert.equal(JSON.stringify(guarded.ranking), JSON.stringify(tied));
    assert.deepEqual(guarded.expansion, []);
  }
});

test('test files and high-degree graph hubs cannot be feedback sources', async () => {
  const root = await fixture();
  const graph = await readGraph(root);
  graph.edges.push(...Array.from({ length: 12 }, (_, i) => ({ src: `src/decoy-${i}.mjs`, dst: 'src/first.mjs' })));
  const ranking = await searchFtsBm25F(root, query);
  const result = await searchWithFeedback(root, query, { graph, ranking });
  assert.equal(result.reason, null);
  assert.ok(result.expansion.length > 0);
  for (const { sources } of result.expansion) {
    assert.deepEqual(sources, ['src/second.mjs']);
  }
});
