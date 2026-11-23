// Forensic regression suite for the six v2 retrieval defects found in the live audit at
// 95466b3 (plan 0006, §1). Each test pins the CURRENT behaviour so the suite is green
// before Wave 1 touches ranking or packing; the surgical fixes (V03–V08) flip these
// assertions, and any silent re-introduction of a defect turns the suite red.
//
// Every fixture is built from `buildFieldedFtsBodies` and an in-memory graph, or a
// throwaway `tempDir` repository — nothing reads a sibling checkout (ADR-031).

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { assembleBrief } from '../src/brief/assemble.mjs';
import { scoreFtsBm25F } from '../src/index/bm25f.mjs';
import { directionalGraph, expandDirectional } from '../src/index/directional.mjs';
import { searchEntityCandidates } from '../src/index/entities.mjs';
import { rankMapV2 } from '../src/index/map-v2.mjs';
import { buildFieldedFtsBodies, readGraph, reindex } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

// 1. A common lowercase prompt word matching a private helper must not hijack Tier-2
//    and outrank the intended path-stem code match. Fixed in V03.
test('a common prompt word does not anchor a private helper at Tier-2 above the intended path stem', async () => {
  const files = [
    { path: 'src/kernel/checks.mjs' },
    { path: 'src/mcp/schema.mjs' },
  ];
  const symbols = [{ path: 'src/mcp/schema.mjs', name: 'check', line: 25 }];
  const graph = {
    files, symbols, edges: [],
    fieldedRows: [
      ...buildFieldedFtsBodies('src/kernel/checks.mjs', [], 'repository import direction checks'),
      ...buildFieldedFtsBodies('src/mcp/schema.mjs', symbols, 'validate schema check'),
    ],
  };
  const task = 'feat(check): enforce repository import direction';
  const { candidates } = await searchEntityCandidates('.', task, { ...graph, fts: graph.fieldedRows });
  const hijack = candidates.find(({ path }) => path === 'src/mcp/schema.mjs');
  const intended = candidates.find(({ path }) => path === 'src/kernel/checks.mjs');
  assert.ok(hijack.tier > 2, 'the private check helper does not anchor Tier-2');
  assert.ok(intended.tier > 2, 'the intended path stem carries no Tier-1/2 anchor');
  const ranked = (await rankMapV2('.', graph, task)).ranked;
  assert.ok(
    ranked.findIndex(({ path }) => path === 'src/kernel/checks.mjs')
      < ranked.findIndex(({ path }) => path === 'src/mcp/schema.mjs'),
    'the intended path stem outranks the private helper',
  );
});

// 2. `directional.mjs` must not award `enclosed_by` weight back to the owning file of
//    a symbol seed. Fixed in V03.
test('enclosed_by does not award weight back to the owning file of a symbol seed', () => {
  const seed = 'sym:feature.mjs#check@1';
  const owner = 'file:feature.mjs';
  const edges = [{ src: owner, kind: 'contains', dst: seed }];
  const hits = expandDirectional(directionalGraph(edges), [{ node: seed, score: 1, exact: true }]);
  const self = hits.find(({ node }) => node === owner);
  assert.equal(self, undefined, 'the owning file is not scored from its own symbol seed');
});

// 3. The default `rankMapV2` excludes test paths (matching v1 `!isTestPath`). Fixed in V04.
test('the default rankMapV2 excludes test paths', async () => {
  const files = [
    { path: 'src/rank.mjs' },
    { path: 'test/rank.test.mjs' },
  ];
  const graph = {
    files, symbols: [], edges: [],
    fieldedRows: [
      ...buildFieldedFtsBodies('src/rank.mjs', [], 'rank records scoring'),
      ...buildFieldedFtsBodies('test/rank.test.mjs', [], 'rank records scoring test'),
    ],
  };
  const ranked = (await rankMapV2('.', graph, 'fix the rank records scoring')).ranked;
  assert.ok(
    !ranked.some(({ path }) => path === 'test/rank.test.mjs'),
    'test paths are excluded from the default ranking',
  );
});

// 4. A shorter `docs/guides/<name>.md` that repeats a symptom must not outrank
//    `src/<name>.mjs` on a default/bugfix query. Fixed in V04.
test('the source file outranks a shorter docs guide on a default query', async () => {
  const files = [
    { path: 'docs/guides/rate-limit.md' },
    { path: 'src/rate-limit.mjs' },
  ];
  const graph = {
    files, symbols: [], edges: [],
    fieldedRows: [
      ...buildFieldedFtsBodies('docs/guides/rate-limit.md', [], 'rate limit the api requests'),
      ...buildFieldedFtsBodies('src/rate-limit.mjs', [], 'rate limit the api requests ' + 'implementation detail '.repeat(24)),
    ],
  };
  const ranked = (await rankMapV2('.', graph, 'fix the rate limit on api requests')).ranked;
  assert.ok(
    ranked.findIndex(({ path }) => path === 'src/rate-limit.mjs')
      < ranked.findIndex(({ path }) => path === 'docs/guides/rate-limit.md'),
    'the source file outranks the shorter docs guide on a default query',
  );
});

// 5. A 4-subtask composite at the 2,048-byte budget must surface both
//    `test/<name>.test.mjs` and `src/config/<name>.json`.
//    Current: the config artifact is never retrieved for its subtask, so the
//    packet carries the test line and no config line.
test('the 2,048-byte composite does not surface both the test and config artifacts', async () => {
  const root = await tempDir('retrieval-v2-forensics-composite-');
  const contents = {
    'simt.json': '{"brief":{"retrieval":"v2"}}',
    'src/auth.mjs': 'export function authenticate() { return true; } // authentication middleware\n',
    'test/auth.test.mjs': "import { authenticate } from '../src/auth.mjs';\n// test the authentication session\n",
    'src/config/auth.json': '{ "enabled": true }\n',
    'docs/guides/auth.md': '# Auth guide\nrate limits for the api\n',
  };
  for (const [path, value] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  }
  await ensureGit(root);
  const task = 'Refactor the authentication middleware, add unit tests for auth sessions, enable auth in the config, and document the new rate limits in the guide';
  const result = await assembleBrief({ root, task, retrieval: 'v2' });
  assert.ok(result.composite, 'a composite packet was assembled');
  assert.ok(result.packed.after <= 2048, `the packet fits the budget (got ${result.packed.after})`);
  const coverage = result.composite.subtaskCoverage;
  assert.equal(coverage.length, 4, 'four subtasks were decomposed');
  const hasTest = result.packed.text.includes('test/auth.test.mjs');
  const hasConfig = result.packed.text.includes('src/config/auth.json');
  assert.ok(hasTest, 'the test artifact is surfaced in the composite');
  assert.ok(
    !hasConfig,
    `the config artifact is never retrieved, so it is absent from the packet (test=${hasTest}, config=${hasConfig})`,
  );
});

// 6. A dirty-file overlay is normalized against the global maximum across primary
//    and overlay results, so a weak overlay hit does not tie the top primary result. Fixed in V04.
test('a one-file dirty overlay is normalized against the global maximum', async () => {
  const root = await tempDir('retrieval-v2-forensics-overlay-');
  // A tracked, high-scoring file becomes the native (SQLite) primary result.
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'primary.mjs'), 'export function primary() { return probe; }\n// ' + 'probe '.repeat(24) + '\n');
  await ensureGit(root);
  await reindex(root, { fielded: true });
  const base = await readGraph(root);
  // A single dirty overlay file with one probe occurrence scores far lower in raw BM25F.
  const overlay = buildFieldedFtsBodies('src/dirty.mjs', [], 'probe');
  const dirtyRaw = scoreFtsBm25F(overlay, 'probe')[0]?.score ?? 0;
  const graph = {
    ...base,
    files: [...base.files, { path: 'src/dirty.mjs' }],
    fieldedRows: overlay,
    nativeLexical: true,
  };
  const result = await rankMapV2(root, graph, 'probe', { explain: true });
  const entry = result.evidence.find(({ path }) => path === 'src/dirty.mjs');
  assert.ok(entry?.channels?.bm25f, 'the overlay file is scored by the bm25f channel');
  assert.ok(dirtyRaw > 0, 'the overlay file has a positive raw BM25F score');
  assert.ok(
    entry.channels.bm25f.score < 1,
    `the one-file overlay is normalized against the global maximum (< 1.0, got ${entry.channels.bm25f.score})`,
  );
});
