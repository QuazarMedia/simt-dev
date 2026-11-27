import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { readGraph } from '../src/index/graph-read.mjs';
import { rankMapV2 } from '../src/index/map-v2.mjs';
import { computeQppMetrics, fuseQppChannels } from '../src/index/qpp.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

test('QPP attenuates flat noisy channels and boosts sharp channels (zero Fusion Tax)', () => {
  const sharp = [
    { path: 'src/target.mjs', score: 12.0 },
    { path: 'src/other-1.mjs', score: 2.0 },
    { path: 'src/other-2.mjs', score: 1.0 },
    { path: 'src/other-3.mjs', score: 0.5 },
    { path: 'src/other-4.mjs', score: 0.4 },
    { path: 'src/other-5.mjs', score: 0.3 },
  ];
  const noisyA = Array.from({ length: 15 }, (_, i) => ({
    path: i === 0 ? 'src/distractor.mjs' : `src/noise-a-${i}.mjs`,
    score: 1.0 - i * 0.002,
  }));
  const noisyB = Array.from({ length: 15 }, (_, i) => ({
    path: i === 0 ? 'src/distractor.mjs' : `src/noise-b-${i}.mjs`,
    score: 1.0 - i * 0.003,
  }));

  const sharpMetrics = computeQppMetrics(sharp, 1.0);
  const noisyMetrics = computeQppMetrics(noisyA, 1.0);
  assert.ok(sharpMetrics.phi > 1.2);
  assert.equal(noisyMetrics.phi, 0.25);

  const fused = fuseQppChannels([
    { id: 'bm25f', weight: 1.0, items: sharp },
    { id: 'noisy_a', weight: 1.0, items: noisyA },
    { id: 'noisy_b', weight: 1.0, items: noisyB },
  ]);
  assert.equal(fused.ranked[0].path, 'src/target.mjs');
  assert.equal(fused.qpp.noisy_a.effectiveWeight, 0.25);
  assert.ok(fused.qpp.bm25f.effectiveWeight > 1.2);
});

test('QPP CombMNZ rewards agreement across confident channels and stays permutation-invariant', () => {
  const chan1 = [
    { path: 'src/only-one.mjs', score: 10.0 },
    { path: 'src/shared.mjs', score: 9.8 },
    { path: 'src/tail-1.mjs', score: 0.5 },
    { path: 'src/tail-2.mjs', score: 0.4 },
    { path: 'src/tail-3.mjs', score: 0.3 },
  ];
  const chan2 = [
    { path: 'src/shared.mjs', score: 10.0 },
    { path: 'src/second.mjs', score: 1.5 },
    { path: 'src/tail-4.mjs', score: 0.5 },
    { path: 'src/tail-5.mjs', score: 0.4 },
    { path: 'src/tail-6.mjs', score: 0.3 },
  ];
  const a = fuseQppChannels([
    { id: 'c1', weight: 1.0, items: chan1 },
    { id: 'c2', weight: 1.0, items: chan2 },
  ]);
  const b = fuseQppChannels([
    { id: 'c2', weight: 1.0, items: chan2 },
    { id: 'c1', weight: 1.0, items: chan1 },
  ]);
  assert.equal(a.ranked[0].path, 'src/shared.mjs');
  assert.deepEqual(a.ranked, b.ranked);
});

test('rankMapV2 emits QPP channel diagnostics in --explain when qppFusion is enabled', async () => {
  const root = await tempDir('index-qpp-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'retry.mjs'), 'export function retryBackoff(attempt) { return attempt * 100; }\n');
  await writeFile(join(root, 'src', 'metrics.mjs'), 'export function recordMetric(name) { return name; }\n');
  await ensureGit(root);
  await reindex(root);
  const graph = await readGraph(root);

  const res = await rankMapV2(root, graph, 'retry backoff', { qppFusion: true, explain: true });
  assert.equal(res.ranked[0].path, 'src/retry.mjs');
  assert.ok(res.qpp?.bm25f);
  for (const meta of Object.values(res.qpp)) {
    assert.ok(typeof meta.baseWeight === 'number');
    assert.ok(typeof meta.nqc === 'number');
    assert.ok(typeof meta.topGap === 'number');
    assert.ok(typeof meta.effectiveWeight === 'number');
  }
  const ev = res.evidence.find((row) => row.path === 'src/retry.mjs');
  assert.ok(ev?.channels.bm25f?.qpp);
});
