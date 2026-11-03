// Plan 0004 W38: dependency-aware work graph and budgets.
//
// What the suite pins: readiness needs current evidence, not a predecessor's prose; an expired
// proof reopens its dependents; unknown predecessors and declared blockers are named; tasks that
// write the same resource serialize while independent ones run in parallel; a cycle is reported as
// a cycle; an exhausted budget stops with its state preserved; and the graph proposes a dispatch
// rather than starting work itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  GRAPH_SCHEMA,
  READINESS,
  checkBudget,
  explainBlocked,
  predecessorCurrent,
  readyTasks,
  schedule,
  stronglyConnected,
} from '../src/coordination/workgraph.mjs';

const tasks = [
  { id: 'a', writes: ['doc#1'] },
  { id: 'b', dependsOn: ['a'], writes: ['doc#1'] },
  { id: 'c', writes: ['doc#2'] },
];

test('the schema and readiness states are named', () => {
  assert.equal(GRAPH_SCHEMA, 'simt.workgraph/1');
  assert.deepEqual(READINESS, ['ready', 'waiting', 'blocked', 'cycle']);
});

test('readiness requires current evidence, not a prose done', () => {
  assert.equal(predecessorCurrent({}, 'a'), false);
  assert.equal(predecessorCurrent({ a: true }, 'a'), true);
  assert.equal(predecessorCurrent({ a: { current: false } }, 'a'), false);

  const none = readyTasks({ tasks, evidence: {} });
  assert.deepEqual(none.ready, ['a', 'c']);
  assert.deepEqual(none.waiting, [{ id: 'b', state: 'waiting', missing: ['a (evidence not current)'] }]);

  const current = readyTasks({ tasks, evidence: { a: { current: true } } });
  assert.deepEqual(current.ready, ['a', 'b', 'c']);
});

test('an unknown predecessor and a declared blocker are named', () => {
  const waiting = readyTasks({ tasks: [{ id: 'a', dependsOn: ['ghost'] }, { id: 'b', blockedBy: ['needs approval'] }], evidence: {} });
  assert.deepEqual(waiting.waiting, [
    { id: 'a', state: 'waiting', missing: ['ghost (unknown predecessor)'] },
    { id: 'b', state: 'blocked', missing: ['needs approval (declared blocker)'] },
  ]);
});

test('an expired proof reopens its dependents', () => {
  const before = readyTasks({ tasks, evidence: { a: { current: true } } });
  assert.equal(before.ready.includes('b'), true);
  const after = readyTasks({ tasks, evidence: { a: { current: false } } });
  assert.equal(after.ready.includes('b'), false);
  assert.match(after.waiting.find((entry) => entry.id === 'b').missing[0], /evidence not current/);
});

test('a cycle is reported as a cycle, not as waiting', () => {
  const cyclic = [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }];
  assert.deepEqual(stronglyConnected(cyclic), [['a', 'b']]);
  const plan = schedule({ tasks: cyclic, evidence: { a: { current: true }, b: { current: true } } });
  assert.deepEqual(plan.dispatch, []);
  assert.equal(plan.cycle[0].ids.length, 2);
  assert.match(plan.cycle[0].reason, /depend on each other/);
});

test('independent tasks run in parallel; conflicting writes serialize', () => {
  const plan = schedule({ tasks, evidence: { a: { current: true } }, capacity: 2 });
  assert.deepEqual(plan.dispatch, ['a', 'c']);
  assert.deepEqual(plan.serialized, [{ id: 'b', after: ['a'], resource: 'doc#1' }]);
  assert.deepEqual(plan.waiting, []);
});

test('capacity limits a dispatch proposal without dropping work', () => {
  const plan = schedule({ tasks: [{ id: 'a', writes: ['x'] }, { id: 'b', writes: ['y'] }], evidence: {}, capacity: 1 });
  assert.deepEqual(plan.dispatch, ['a']);
  assert.deepEqual(plan.serialized, [{ id: 'b', after: ['a'], resource: null }]);
});

test('an exhausted budget stops with its state preserved', () => {
  const limited = schedule({
    tasks: [{ id: 'a', limits: { actions: 2 } }],
    evidence: {},
    spent: { a: { actions: 2 } },
  });
  assert.deepEqual(limited.dispatch, []);
  assert.match(limited.limited[0].reason, /state preserved/);

  assert.equal(checkBudget({ task: { limits: { seconds: 10 } }, spent: { seconds: 10 } }).ok, false);
  assert.equal(checkBudget({ task: { limits: { actions: 2 } }, spent: { actions: 1 } }).ok, true);
  assert.equal(checkBudget({ task: {}, spent: { actions: 999 } }).ok, true);
});

test('a blocked explanation names the contract', () => {
  assert.equal(explainBlocked({ id: 'b', blockedBy: ['approval'] }, {}), 'b is blocked by approval');
  assert.equal(explainBlocked({ id: 'b', dependsOn: ['a'] }, {}), 'b waits on current evidence for a');
  assert.equal(explainBlocked({ id: 'b', dependsOn: ['a'] }, { a: { current: true } }), 'b is ready');
});

test('the graph is deterministic and reads nothing', async () => {
  assert.deepEqual(schedule({ tasks, evidence: { a: { current: true } } }), schedule({ tasks, evidence: { a: { current: true } } }));
  const source = await readFile(new URL('../src/coordination/workgraph.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
