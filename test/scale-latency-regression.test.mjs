import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

import { prepareMapStructure, rankMapV2 } from '../src/index/map-v2.mjs';
import { readFieldedFts, readGraph, reindex } from '../src/index/store.mjs';
import { explainGovernance, walkReverseImports } from '../src/index/why-graph.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

test('why-graph reverse 2-hop walk handles 10,000 edges in <= 15 ms without SQLite DB allocation', async () => {
  const root = await tempDir('scale-why-10k-');
  await mkdir(join(root, 'src/commands'), { recursive: true });
  await writeFile(join(root, 'src/target.mjs'), 'export const target = 1;\n');
  await writeFile(join(root, 'src/commands/status.mjs'), "import '../target.mjs';\n");
  await ensureGit(root);
  await reindex(root);

  const files = new Set(['src/target.mjs', 'src/commands/status.mjs']);
  const edges = [{ src: 'src/commands/status.mjs', dst: 'src/target.mjs', kind: 'import' }];
  for (let i = 0; i < 10000; i += 1) {
    const a = `src/mod-${i}.mjs`;
    const b = `src/mod-${(i + 1) % 10000}.mjs`;
    files.add(a);
    edges.push({ src: a, dst: b, kind: 'import' });
  }
  const ctx = { files, commands: new Set(['status']), roots: ['src'] };

  walkReverseImports(edges, ['src/target.mjs']);
  const times = [];
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    const walked = walkReverseImports(edges, ['src/target.mjs']);
    times.push(performance.now() - start);
    assert.ok(walked.some(({ path }) => path === 'src/commands/status.mjs'));
  }
  times.sort((a, b) => a - b);
  const median = times[2];
  assert.ok(median <= 15, `10k-edge walkReverseImports median ${median.toFixed(2)} ms exceeded 15 ms`);

  const explained = await explainGovernance(root, ['src/target.mjs'], ctx, { graph: { edges } });
  assert.ok(explained.witnesses);
});

test('SQLite-native rankMapV2 matches in-memory ranking parity including conceptual coupling', async () => {
  const root = await tempDir('scale-map-parity-');
  const files = {
    'src/auth.mjs': 'export function rotateJwt() { return 1; }\n// session token expiry renewal\n',
    'src/session.mjs': '// session token expiry renewal\nexport function renew() { return 2; }\n',
    'src/caller.mjs': "import { rotateJwt } from './auth.mjs';\nexport function run() { return rotateJwt(); }\n",
    'src/unrelated.mjs': 'export const unrelated = true;\n',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await ensureGit(root);
  await reindex(root, { fielded: true });

  const base = await readGraph(root);
  const fts = await readFieldedFts(root);

  const nativeResult = await rankMapV2(root, { ...base, nativeLexical: true, fieldedRows: [] }, 'rotateJwt', { explain: true });
  const memoryResult = await rankMapV2(root, { ...base, nativeLexical: false, fieldedRows: fts }, 'rotateJwt', {
    explain: true,
    structure: prepareMapStructure(base),
  });

  assert.deepEqual(
    nativeResult.ranked.map(({ path }) => path),
    memoryResult.ranked.map(({ path }) => path),
  );
  const nativeSession = nativeResult.evidence.find(({ path }) => path === 'src/session.mjs');
  const memSession = memoryResult.evidence.find(({ path }) => path === 'src/session.mjs');
  assert.ok(nativeSession?.channels?.coupling?.conceptual > 0);
  assert.ok(Math.abs(nativeSession.channels.coupling.conceptual - memSession.channels.coupling.conceptual) < 1e-6);
});

test('seeded structure rankMapV2 stays fast on 10,000-node in-memory graph', async () => {
  const files = [];
  const edges = [];
  const symbolEdges = [];
  const symbols = [];
  const fieldedRows = [];
  for (let i = 0; i < 10000; i += 1) {
    const path = `src/pkg-${i % 50}/mod-${i}.mjs`;
    files.push({ path });
    symbols.push({ path, name: `fn${i}`, exported: 1, line: 1 });
    if (i > 0) {
      const prev = `src/pkg-${(i - 1) % 50}/mod-${i - 1}.mjs`;
      edges.push({ src: path, dst: prev, kind: 'import' });
      symbolEdges.push({ src: `file:${path}`, dst: `file:${prev}`, kind: 'imports_symbol' });
    }
  }
  fieldedRows.push({
    kind: 'code',
    ref: 'src/pkg-0/mod-0.mjs',
    path_tokens: 'src pkg mod',
    symbol_names: 'fn0',
    qual_names: '',
    signatures: 'export function fn0',
    headings: '',
    body: 'target token rotation',
  });
  const graph = {
    files,
    symbols,
    edges,
    symbolGraph: { edges: symbolEdges },
    fieldedRows,
    nativeLexical: false,
  };
  await rankMapV2('.', graph, 'target token rotation');
  const times = [];
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    const res = await rankMapV2('.', graph, 'target token rotation');
    times.push(performance.now() - start);
    assert.equal(res.ranked[0].path, 'src/pkg-0/mod-0.mjs');
  }
  times.sort((a, b) => a - b);
  assert.ok(times[2] <= 80, `10k-node rankMapV2 median ${times[2].toFixed(2)} ms exceeded 80 ms`);
});
