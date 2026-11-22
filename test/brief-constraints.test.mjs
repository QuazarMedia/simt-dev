import assert from 'node:assert/strict';
import { test } from 'node:test';

import { excludedPaths, extractConstraints } from '../src/brief/constraints.mjs';
import { decomposePrompt } from '../src/brief/decompose.mjs';

test('negative path and term mentions are kept as cautions and omitted from positive search', () => {
  const original = 'Fix brief packing without changing src/kernel/budget.mjs';
  const { query, constraints, cautions } = extractConstraints(original);
  assert.equal(query, 'Fix brief packing');
  assert.deepEqual(cautions, ['Do not edit src/kernel/budget.mjs.']);
  assert.equal(original.slice(constraints[0].start, constraints[0].end), 'without changing src/kernel/budget.mjs');
  assert.deepEqual(excludedPaths(constraints, ['src/brief/packet.mjs', 'src/kernel/budget.mjs']), new Set(['src/kernel/budget.mjs']));

  const multiple = extractConstraints('Do not touch src/a.mjs, src/b.mjs and src/c.mjs; update src/d.mjs');
  assert.equal(multiple.query, 'update src/d.mjs');
  assert.deepEqual(multiple.constraints[0].targets, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
  assert.equal(extractConstraints('Refactor auth and leave billing alone.').query, 'Refactor auth');
  assert.equal(extractConstraints('Update code, except src/keep.mjs, then verify').query, 'Update code then verify');
  assert.equal(extractConstraints('Refactor query without using eval').cautions[0], 'Do not use eval.');
});

test('conditions keep their exact guard and action even if there is also an exclusion', () => {
  const guarded = extractConstraints('If the parser sees "a,b", update docs without modifying src/api.mjs.');
  assert.equal(guarded.query, 'update docs');
  assert.deepEqual(guarded.constraints.map(({ kind }) => kind), ['condition', 'exclude']);
  assert.equal(guarded.constraints[0].condition, 'the parser sees "a,b"');
  assert.equal(guarded.constraints[0].action, 'update docs');
  assert.equal(guarded.constraints[0].guard, 'if');
  const unless = extractConstraints('Unless tests are green, check the logs');
  assert.equal(unless.constraints[0].guard, 'unless');
  assert.equal(unless.query, 'check the logs');
  const only = extractConstraints('Update the guide only when package metadata has changed');
  assert.equal(only.constraints[0].condition, 'package metadata has changed');
  assert.equal(only.query, 'Update the guide');
  assert.equal(decomposePrompt('Update the guide; then if tests pass, verify the output.').length, 2);
});

test('quoted negations are data and explicit preservation is different from exclusion', () => {
  const quoted = 'Add a test for the message "Do not touch src/other.mjs".';
  assert.deepEqual(extractConstraints(quoted), { query: quoted, constraints: [], cautions: [] });
  const preserved = extractConstraints('Keep "public API" compatible while updating defaults');
  assert.equal(preserved.query, 'while updating defaults');
  assert.equal(preserved.constraints[0].kind, 'preserve');
  assert.deepEqual(preserved.constraints[0].targets, ['public API']);
  assert.equal(excludedPaths(preserved.constraints, ['public API']).size, 0);
});

test('exclusions handle exact paths and directory bounds, and avoid ambiguous basenames', () => {
  const { constraints } = extractConstraints('Update auth without touching src/billing/, index.mjs and keep.mjs');
  const paths = [
    'src/billing/invoice.mjs', 'src/billing-old/invoice.mjs', 'src/index.mjs', 'src/sub/index.mjs', 'src/keep.mjs',
  ];
  assert.deepEqual([...excludedPaths(constraints, paths)], ['src/billing/invoice.mjs', 'src/keep.mjs']);
});
