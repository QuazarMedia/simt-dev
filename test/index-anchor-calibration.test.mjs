import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { directionalGraph, expandDirectional } from '../src/index/directional.mjs';
import { resolveEntityAnchors, searchEntityCandidates } from '../src/index/entities.mjs';
import { rankMapV2 } from '../src/index/map-v2.mjs';
import { searchWithFeedback } from '../src/index/prf.mjs';
import { buildFieldedFtsBodies, readGraph, reindex } from '../src/index/store.mjs';
import { ensureGit, tempDir } from './fixture.mjs';

test('Tier-2 excludes common lowercase words and high-DF symbols, while keeping exported/compound symbols and quoted Tier-1', () => {
  const files = ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs', 'src/e.mjs'];
  const symbols = [
    { path: 'src/a.mjs', name: 'check', exported: 1 },
    { path: 'src/a.mjs', name: 'open', exported: 0 },
    { path: 'src/a.mjs', name: 'helper', exported: 0 },
    { path: 'src/a.mjs', name: 'buildAuditPlan', exported: 0 },
    { path: 'src/b.mjs', name: 'runAudit', exported: 1 },
    { path: 'src/a.mjs', name: 'ubiquitousHelper', exported: 1 },
    { path: 'src/b.mjs', name: 'ubiquitousHelper', exported: 1 },
    { path: 'src/c.mjs', name: 'ubiquitousHelper', exported: 1 },
    { path: 'src/d.mjs', name: 'ubiquitousHelper', exported: 1 },
  ];
  assert.equal(resolveEntityAnchors('check open helper ubiquitousHelper', { files, symbols }).size, 0);
  assert.deepEqual([...resolveEntityAnchors('buildAuditPlan', { files, symbols }).keys()], ['src/a.mjs']);
  assert.deepEqual([...resolveEntityAnchors('runAudit', { files, symbols }).keys()], ['src/b.mjs']);
  const quoted = resolveEntityAnchors('fix `check` now', { files, symbols });
  assert.deepEqual([...quoted.keys()], ['src/a.mjs']);
});

test('quoted symbol literal is Tier-1 while unquoted compound symbol is Tier-2 soft-boosted', async () => {
  const files = [{ path: 'src/alpha.mjs' }, { path: 'src/beta.mjs' }];
  const symbols = [{ path: 'src/alpha.mjs', name: 'buildAuditPlan', exported: 1 }];
  const graph = {
    files,
    symbols,
    edges: [],
    fieldedRows: [
      ...buildFieldedFtsBodies('src/alpha.mjs', symbols, 'audit'),
      ...buildFieldedFtsBodies('src/beta.mjs', [], 'audit'),
    ],
  };
  const unquoted = await searchEntityCandidates('.', 'buildAuditPlan', { ...graph, fts: graph.fieldedRows });
  assert.equal(unquoted.candidates.find(({ path }) => path === 'src/alpha.mjs').tier, 2);
  const quoted = await searchEntityCandidates('.', '`buildAuditPlan`', { ...graph, fts: graph.fieldedRows });
  assert.equal(quoted.candidates.find(({ path }) => path === 'src/alpha.mjs').tier, 1);
});

test('Tier-2 does not hard-override strong BM25F + directional consensus', async () => {
  const files = [
    { path: 'src/weak.mjs' },
    { path: 'src/session.mjs' },
    { path: 'src/caller.mjs' },
  ];
  const symbols = [{ path: 'src/weak.mjs', name: 'refreshCache', exported: 1 }];
  const edges = [{ src: 'src/caller.mjs', dst: 'src/session.mjs', kind: 'import' }];
  const graph = {
    files,
    symbols,
    edges,
    symbolGraph: {
      edges: [{ src: 'file:src/caller.mjs', dst: 'file:src/session.mjs', kind: 'imports_symbol' }],
    },
    fieldedRows: [
      ...buildFieldedFtsBodies('src/weak.mjs', symbols, 'unrelated'),
      ...buildFieldedFtsBodies('src/session.mjs', [], 'session token rotation expiry renewal'),
      ...buildFieldedFtsBodies('src/caller.mjs', [], 'session token rotation expiry renewal'),
    ],
  };
  const { ranked } = await rankMapV2('.', graph, 'session token rotation expiry renewal refreshCache');
  assert.ok(
    ranked.findIndex(({ path }) => path === 'src/session.mjs')
      < ranked.findIndex(({ path }) => path === 'src/weak.mjs'),
  );
});

test('directional excludes enclosed_by self-loop while preserving sibling 2-hop traversal', () => {
  const seed = 'sym:feature.mjs#render@1';
  const sibling = 'sym:feature.mjs#refresh@24';
  const owner = 'file:feature.mjs';
  const edges = [
    { src: owner, kind: 'contains', dst: seed },
    { src: owner, kind: 'contains', dst: sibling },
  ];
  const hits = expandDirectional(directionalGraph(edges), [{ node: seed, score: 1, exact: true }]);
  assert.equal(hits.find(({ node }) => node === owner), undefined);
  assert.ok(hits.find(({ node }) => node === sibling));
});

test('PRF is unblocked on natural-language prompts with Tier-2 symbols and blocked on Tier-1 anchors', async () => {
  const root = await tempDir('anchor-prf-');
  const files = {
    'src/first.mjs': '// login timeout login timeout ttl jwt\n',
    'src/second.mjs': '// login timeout login timeout ttl jwt\n',
    'src/renew.mjs': 'export function rotateTtlJwt() { return true; }\n',
  };
  for (let i = 0; i < 30; i += 1) files[`src/neutral-${i}.mjs`] = '// isolated notes\n';
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  }
  await ensureGit(root);
  await reindex(root, { fielded: true });
  const graph = await readGraph(root);

  const tied = [{ path: 'src/first.mjs', score: 1 }, { path: 'src/second.mjs', score: 0.95 }];
  const nlPrompt = 'login timeout happens when rotateTtlJwt runs';
  const nlResult = await searchWithFeedback(root, nlPrompt, { graph, ranking: tied });
  assert.notEqual(nlResult.reason, 'exact-anchor');

  const tier1Result = await searchWithFeedback(root, 'login timeout in `rotateTtlJwt`', { graph, ranking: tied });
  assert.equal(tier1Result.reason, 'exact-anchor');
});
