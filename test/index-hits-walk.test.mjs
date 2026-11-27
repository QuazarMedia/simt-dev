import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { directionalGraph, expandDirectional } from '../src/index/directional.mjs';
import { readFileHits, readGraph } from '../src/index/graph-read.mjs';
import { computeHitsScores } from '../src/index/hits.mjs';
import { rankMapV2 } from '../src/index/map-v2.mjs';
import { SQLITE_FILE } from '../src/index/persist.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

test('computeHitsScores separates authorities, hubs, and pure re-export barrels', () => {
  const files = [
    { path: 'src/hub-a.mjs', bindings: { reexports: [], chunk: { scopes: [{ name: 'runA' }] } } },
    { path: 'src/hub-b.mjs', bindings: { reexports: [], chunk: { scopes: [{ name: 'runB' }] } } },
    { path: 'src/barrel.mjs', bindings: { reexports: [{ spec: './core.mjs' }], chunk: { scopes: [] } } },
    { path: 'src/core.mjs', bindings: { reexports: [], chunk: { scopes: [{ name: 'core' }] } } },
    { path: 'test/core.test.mjs', bindings: { reexports: [], chunk: { scopes: [] } } },
  ];
  const edges = [
    { src: 'file:src/hub-a.mjs', dst: 'file:src/core.mjs', kind: 'import' },
    { src: 'file:src/hub-b.mjs', dst: 'file:src/core.mjs', kind: 'import' },
    { src: 'file:src/hub-a.mjs', dst: 'file:src/barrel.mjs', kind: 'import' },
    { src: 'file:src/barrel.mjs', dst: 'file:src/core.mjs', kind: 'import' },
    { src: 'file:test/core.test.mjs', dst: 'file:src/hub-a.mjs', kind: 'import' },
  ];
  const hits = computeHitsScores(files, edges);
  assert.equal(hits.has('test/core.test.mjs'), false);
  assert.equal(hits.get('src/barrel.mjs').barrel, true);
  assert.equal(hits.get('src/core.mjs').barrel, false);
  assert.ok(hits.get('src/core.mjs').authority > hits.get('src/hub-a.mjs').authority);
  assert.ok(hits.get('src/hub-a.mjs').hub > hits.get('src/core.mjs').hub);
});

test('expandDirectional applies intent-aware authority/hub, barrel dampening, and directory cohesion', () => {
  const graph = directionalGraph([
    { src: 'file:src/sub/seed.mjs', dst: 'file:src/sub/barrel.mjs', kind: 'cochange', weight: 1 },
    { src: 'file:src/sub/seed.mjs', dst: 'file:src/sub/impl.mjs', kind: 'cochange', weight: 1 },
    { src: 'file:src/sub/seed.mjs', dst: 'file:src/other/hub.mjs', kind: 'cochange', weight: 1 },
  ]);
  const hits = new Map([
    ['src/sub/barrel.mjs', { authority: 0.9, hub: 0.1, barrel: true }],
    ['src/sub/impl.mjs', { authority: 0.9, hub: 0.1, barrel: false }],
    ['src/other/hub.mjs', { authority: 0.1, hub: 0.95, barrel: false }],
  ]);

  const bugfix = expandDirectional(graph, [{ node: 'file:src/sub/seed.mjs', score: 1, exact: true }], {
    hits,
    intent: 'bugfix',
    cohesionDirs: new Set(['src/sub']),
  });
  assert.equal(bugfix[0].node, 'file:src/sub/impl.mjs');
  const barrelBugfix = bugfix.find((row) => row.node === 'file:src/sub/barrel.mjs');
  assert.ok(bugfix[0].score > barrelBugfix.score);

  const wiring = expandDirectional(graph, [{ node: 'file:src/sub/seed.mjs', score: 1, exact: true }], {
    hits,
    intent: 'wiring',
    cohesionDirs: null,
  });
  assert.equal(wiring[0].node, 'file:src/other/hub.mjs');
});

test('reindex persists HITS scores on file nodes and dampens barrels on bugfix rankMapV2', async () => {
  const root = await tempDir('index-hits-');
  await mkdir(join(root, 'src', 'auth'), { recursive: true });
  await writeFile(
    join(root, 'src', 'auth', 'token.mjs'),
    'export function validateSessionToken(raw) { return Boolean(raw); }\n',
  );
  await writeFile(
    join(root, 'src', 'auth', 'index.mjs'),
    "export { validateSessionToken } from './token.mjs';\n",
  );
  await writeFile(
    join(root, 'src', 'caller-a.mjs'),
    "import { validateSessionToken } from './auth/token.mjs';\nexport const a = () => validateSessionToken('a');\n",
  );
  await writeFile(
    join(root, 'src', 'caller-b.mjs'),
    "import { validateSessionToken } from './auth/token.mjs';\nexport const b = () => validateSessionToken('b');\n",
  );
  await ensureGit(root);
  await reindex(root);

  const db = new DatabaseSync(join(root, SQLITE_FILE), { readOnly: true });
  try {
    assert.equal(db.prepare("select value from meta where key = 'hits_scores'").get().value, '1');
  } finally {
    db.close();
  }
  const hits = await readFileHits(root);
  assert.equal(hits.get('src/auth/index.mjs')?.barrel, true);
  assert.ok(hits.get('src/auth/token.mjs')?.authority > hits.get('src/auth/index.mjs')?.authority);

  const graph = await readGraph(root);
  const res = await rankMapV2(root, graph, 'fix validateSessionToken bug', { hitsWalk: true });
  const tokenRank = res.ranked.findIndex((row) => row.path === 'src/auth/token.mjs');
  const barrelRank = res.ranked.findIndex((row) => row.path === 'src/auth/index.mjs');
  assert.equal(tokenRank, 0);
  assert.ok(barrelRank === -1 || tokenRank < barrelRank);
});

test('computeHitsScores scales linearly over 2000 files within 15ms', () => {
  const files = Array.from({ length: 2000 }, (_, i) => ({
    path: `src/mod-${i}.mjs`,
    bindings: { reexports: [], chunk: { scopes: [{ name: `fn${i}` }] } },
  }));
  const edges = [];
  for (let i = 1; i < 2000; i += 1) {
    edges.push({ src: `file:src/mod-${i}.mjs`, dst: `file:src/mod-${i % 20}.mjs`, kind: 'import' });
  }
  const started = performance.now();
  const hits = computeHitsScores(files, edges);
  const elapsed = performance.now() - started;
  assert.equal(hits.size, 2000);
  assert.ok(elapsed < 50);
});
