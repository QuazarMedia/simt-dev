import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindSubtaskAnchors } from '../src/brief/anchors.mjs';
import { decomposePrompt } from '../src/brief/decompose.mjs';
import { clusterSubtasks, subtaskLanes } from '../src/brief/plan-graph.mjs';

function plan(prompts, paths, symbols = []) {
  const tasks = decomposePrompt(prompts.map((text) => '- ' + text).join('\n'));
  return bindSubtaskAnchors(tasks, { files: paths.map((path) => ({ path })), symbols });
}

test('clusters near-duplicates with identical anchors and preserves all original clauses', () => {
  const tasks = plan([
    'Update src/session.mjs and validate expiry behavior',
    'Please update src/session.mjs and validate expiry behavior',
    'Update src/storage.mjs and validate expiry behavior',
    'Update src/session.mjs without touching src/storage.mjs',
  ], ['src/session.mjs', 'src/storage.mjs']);
  const merged = clusterSubtasks(tasks);
  assert.ok(merged.length < tasks.length);
  assert.deepEqual(merged.flatMap(({ clauseIds }) => clauseIds).sort((a, b) => a - b), tasks.map(({ id }) => id));
  const same = merged.find(({ anchors, mergedTaskIds }) =>
    mergedTaskIds?.length === 2 && anchors.some(({ path }) => path === 'src/session.mjs'));
  assert.ok(same);
  assert.equal(same.clauses.length, 2);
  assert.equal(merged.filter(({ excludedPaths }) => excludedPaths.length).length, 1);
});

test('reports disjoint lanes and exact file and symbol overlaps for six tasks', () => {
  const paths = ['src/login.mjs', 'test/login.test.mjs', 'src/store.mjs', 'test/store.test.mjs', 'src/time.mjs'];
  const prompts = [
    'Update src/login.mjs', 'Verify test/login.test.mjs', 'Update src/store.mjs',
    'Verify test/store.test.mjs', 'Fix nowUtc in src/time.mjs', 'Document nowUtc in src/time.mjs',
  ];
  const symbols = [{ path: 'src/time.mjs', name: 'nowUtc' }];
  const tasks = plan(prompts, paths, symbols);
  const result = subtaskLanes(tasks);
  assert.equal(result.lanes.length, 5);
  assert.deepEqual(result.overlaps, [{ tasks: [5, 6], files: ['src/time.mjs'], symbols: [{ path: 'src/time.mjs', name: 'nowUtc' }] }]);
  assert.deepEqual(result.lanes.find(({ state }) => state === 'coupled').taskIds, [5, 6]);
  assert.equal(result.lines.length, 2);
  assert.match(result.lines[1], /src\/time\.mjs/u);

  const shuffled = subtaskLanes(plan(prompts.toReversed(), paths.toReversed(), symbols));
  const shape = ({ lanes }) => lanes.map(({ id, state, files, sharedFiles }) => ({ id, state, files, sharedFiles }));
  assert.deepEqual(shape(shuffled), shape(result));
});

test('connects overlap components transitively and labels unknown paths as unresolved', () => {
  const tasks = plan(['Fix a.mjs', 'Update a.mjs and b.mjs', 'Test b.mjs', 'Inspect unknown behavior'], ['a.mjs', 'b.mjs']);
  const result = subtaskLanes(tasks);
  assert.deepEqual(result.lanes.find(({ state }) => state === 'coupled').taskIds, [1, 2, 3]);
  assert.deepEqual(result.lanes.find(({ state }) => state === 'unresolved').taskIds, [4]);
});
