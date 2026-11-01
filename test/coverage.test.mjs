// One coverage() and one governs() (review 0003 Q77).
//
// The defect was disagreement: `simt tests` named one test where `simt gate` named dozens
// for the same file. These pin the two walks against each other and pin governs() to the
// composition it replaced.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coverage } from '../src/index/coverage.mjs';
import { governs } from '../src/index/govern.mjs';

// a.mjs <- b.mjs <- c.test.mjs: the change is two imports away from its test.
const imports = [
  { src: 'b.mjs', dst: 'a.mjs', kind: 'import' },
  { src: 'test/c.test.mjs', dst: 'b.mjs', kind: 'import' },
];
const files = ['a.mjs', 'b.mjs', 'test/c.test.mjs'];

test('the transitive walk reaches a test through the import graph', () => {
  assert.deepEqual(coverage({ imports }, ['a.mjs']), ['test/c.test.mjs']);
  assert.deepEqual(coverage({ imports }, ['a.mjs'], { transitive: false }), []);
});

test('the direct walk is the test edges the index stores, and the two agree where they overlap', () => {
  const direct = [
    { src: 'test/d.test.mjs', dst: 'a.mjs', kind: 'import' },
  ];
  assert.deepEqual(coverage({ files, imports: direct }, ['a.mjs'], { transitive: false }), ['test/d.test.mjs']);
  // Both walks see the direct importer; the transitive one also sees the two-hop test.
  assert.deepEqual(coverage({ files, imports: [...direct, ...imports] }, ['a.mjs']), ['test/c.test.mjs', 'test/d.test.mjs']);
});

test('co-change is added only when a caller asks, and never to the transitive default', () => {
  const commits = [['a.mjs', 'test/e.test.mjs'], ['a.mjs', 'test/e.test.mjs']];
  assert.deepEqual(coverage({ files, imports, commits }, ['a.mjs']), ['test/c.test.mjs']);
  assert.deepEqual(
    coverage({ files, imports, commits }, ['a.mjs'], { transitive: false, cochange: true }),
    ['test/e.test.mjs'],
  );
});

test('governs is the decision hit and the scope hit, in the one stable order', () => {
  const records = [
    { id: 'ADR-001', title: 'named by the path', text: '## ADR-001\n\n**Affects:** `a.mjs`\n' },
  ];
  const rules = [{ id: 'core', detail: 'stack-agnostic', paths: ['*.mjs'] }];
  const ctx = { files: new Set(files), commands: new Set(), roots: [] };
  const hit = governs('a.mjs', { records, rules, ctx });
  assert.deepEqual(hit.map((item) => `${item.kind}:${item.id}`), ['decision:ADR-001', 'rule:core']);
  assert.deepEqual(governs('other.md', { records, rules, ctx }), []);
});
