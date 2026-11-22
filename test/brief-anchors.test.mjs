import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindSubtaskAnchors } from '../src/brief/anchors.mjs';
import { decomposePrompt } from '../src/brief/decompose.mjs';
import { rankMapV2 } from '../src/index/map-v2.mjs';
import { buildFieldedFtsBodies } from '../src/index/store.mjs';

const files = [
  'README.md', 'src/index/map.mjs', 'src/brief/assemble.mjs', 'src/brief/packet.mjs', 'src/commands/impact.mjs', 'src/index/impact.mjs',
  'src/plan/index.mjs', 'src/graph/index.mjs', 'src/kernel/budget.mjs',
].map((path) => ({ path }));
const symbols = [
  { path: 'src/index/map.mjs', name: 'rankFiles', line: 3 },
  { path: 'src/brief/assemble.mjs', name: 'assembleBrief', line: 5 },
];

test('each action in the mixed probe retains its own anchors or positive retrieval query', async () => {
  const graph = {
    files, symbols, edges: [],
    fieldedRows: [
      ['README.md', '# Guide and typo fixes'],
      ['src/index/map.mjs', '// BM25 ranking'],
      ['src/brief/assemble.mjs', '// multi-task decomposition for task brief assembly'],
      ['src/brief/packet.mjs', '// compact task brief packet for multiple tasks'],
      ['src/commands/impact.mjs', '// impact command includes symbol call sites'],
      ['src/index/impact.mjs', '// calculate impact of symbol call sites'],
    ].flatMap(([path, text]) => buildFieldedFtsBodies(path, symbols.filter((row) => row.path === path), text)),
  };
  const prompt = 'Fix the BM25 ranking in map.mjs, add multi-task decomposition to brief, update impact to handle symbol call sites, and fix a typo in README.md';
  const tasks = bindSubtaskAnchors(decomposePrompt(prompt), graph);
  assert.deepEqual(tasks.map(({ anchors }) => [...new Set(anchors.map(({ path }) => path))]), [
    ['src/index/map.mjs'], [], [], ['README.md'],
  ]);
  const [brief, impact] = await Promise.all(tasks.slice(1, 3).map(({ query }) => rankMapV2('.', graph, query)));
  assert.deepEqual(new Set(brief.ranked.slice(0, 2).map(({ path }) => path)), new Set(['src/brief/assemble.mjs', 'src/brief/packet.mjs']));
  assert.deepEqual(new Set(impact.ranked.slice(0, 2).map(({ path }) => path)), new Set(['src/commands/impact.mjs', 'src/index/impact.mjs']));
});

test('resolves qualified basenames, symbols, ADRs and only declared scopes', () => {
  const prompt = [
    '## Plan',
    '- Fix index.mjs under ADR-091 in scope: runner.',
    '- Remove the \x60assembleBrief\x60 call in scope missing.',
    '## Graph',
    '- Verify index.mjs.',
  ].join('\n');
  const tasks = bindSubtaskAnchors(decomposePrompt(prompt), { files, symbols }, { scopes: [{ id: 'runner' }] });
  assert.deepEqual(tasks[0].anchors.map(({ path }) => path), ['src/plan/index.mjs']);
  assert.deepEqual(tasks[0].decisions, ['ADR-091']);
  assert.deepEqual(tasks[0].scopes, ['runner']);
  assert.deepEqual(tasks[1].anchors.map(({ matched }) => matched), ['assembleBrief']);
  assert.deepEqual(tasks[1].scopes, []);
  assert.deepEqual(tasks[2].anchors.map(({ path }) => path), ['src/graph/index.mjs']);
});

test('exclusions win over spelling, and an explicit global scope limits eligible anchors', () => {
  const prompt = 'Update map.mjs without touching src/kernel/budget.mjs, and verify README.md';
  const tasks = decomposePrompt(prompt);
  const bound = bindSubtaskAnchors(tasks, { files, symbols }, { paths: ['src/index/map.mjs'] });
  assert.deepEqual(bound[0].anchors.map(({ path }) => path), ['src/index/map.mjs']);
  assert.deepEqual(bound[0].excludedPaths, ['src/kernel/budget.mjs']);
  assert.equal(bound[0].query, 'Update map.mjs');
  assert.deepEqual(bound[1].anchors, []);
  const ambiguous = bindSubtaskAnchors(decomposePrompt('Fix index.mjs'), { files, symbols });
  assert.deepEqual(ambiguous[0].anchors, []);
});
