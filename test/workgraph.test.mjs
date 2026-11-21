// Plan 0004 W38: dependency-aware work graph and budgets.
//
// What the suite pins: readiness needs current evidence, not a predecessor's prose; an expired
// proof reopens its dependents; unknown predecessors and declared blockers are named; tasks that
// write the same resource serialize while independent ones run in parallel; a cycle is reported as
// a cycle; an exhausted budget stops with its state preserved; and the graph proposes a dispatch
// rather than starting work itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, simt, tempDir } from './fixture.mjs';


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

test('configured trackers preserve authoritative state, receipt prerequisites, priority and privacy', async () => {
  const root = await tempDir('simt-local-tracker-');
  await git(['init', '-q'], { cwd: root });
  const put = async (path, text) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  await put('.gitignore', 'local-only/\n.simt/local/\n');
  await put('handbook/policy.md', '# Policy\n');
  await put('procedures/process.md', '# Procedure\n');
  await put('external/process.md', '# Other\n');
  await put('check.cjs', 'console.log("simt checked: 1")\n');
  await put('simt.json', JSON.stringify({ work: { version: 3, scopes: [
    { id: 'handbook', paths: ['handbook'], kind: 'document',
      validators: ['node check.cjs'], tracker: { kind: 'markdown-items', path: 'local-only/cards', visibility: 'private' } },
    { id: 'procedures', paths: ['procedures'], kind: 'recipe',
      tracker: { kind: 'markdown-table', path: 'local-only/workboard.md', visibility: 'private' } },
    { id: 'external', paths: ['external'], kind: 'document',
      tracker: { kind: 'json', path: 'external/board.json', visibility: 'shared' } },
    { id: 'shared', paths: ['docs'], kind: 'document',
      tracker: { kind: 'plan', path: 'docs/plans/0001-tracker.md', visibility: 'shared' } },
  ] } }));
  await put('external/board.json', JSON.stringify({ version: 1, tasks: [
    { id: 'EXT-1', state: 'ready', writes: ['imports'], priority: 10 },
    { id: 'EXT-2', state: 'ready', dependsOn: 'not a list' },
  ] }));
  await git(['add', '.'], { cwd: root });
  await git(['commit', '-qm', 'fixture inputs'], { cwd: root });
  const { stdout: sha } = await git(['rev-parse', 'HEAD'], { cwd: root });
  await put('docs/plans/0001-tracker.md', [
    '# Existing plan', '',
    '| ID | Slice | Lane | Depends on | State | SHA / evidence |',
    '| --- | --- | --- | --- | --- | --- |',
    `| AB01 | Proven task | docs | — | Complete | ${sha.trim()} |`,
    '| AB02 | Follow-up | docs | AB01 | Queued | — |',
  ].join('\n') + '\n');
  await git(['add', 'docs'], { cwd: root });
  await git(['commit', '-qm', 'fixture tracker'], { cwd: root });

  const item = (name, fields) => put(`local-only/cards/${name}.md`,
    `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\nPRIVATE CARD BODY\n`);
  await item('completed-private', { id: 'PRIVATE-1', state: 'complete', receipts: ['structure:handbook/policy.md'] });
  await item('awaiting-proof', { id: 'PRIVATE-2', state: 'queued', dependsOn: ['PRIVATE-1'], artifacts: ['handbook/policy.md'] });
  await item('low', { id: 'LOW', state: 'queued', priority: 1, writes: ['handbook'] });
  await item('high', { id: 'HIGH', state: 'queued', priority: 7, writes: ['handbook'] });
  await item('one', { id: 'DUP', state: 'queued' });
  await item('two', { id: 'DUP', state: 'queued' });
  await item('missing', { state: 'queued' });
  await item('cycle-one', { id: 'CYCLE-1', state: 'queued', dependsOn: ['CYCLE-2'] });
  await item('cycle-two', { id: 'CYCLE-2', state: 'queued', dependsOn: ['CYCLE-1'] });
  const table = [
    '| ID | State | Priority | Depends on | Artifacts | Writes |',
    '| --- | --- | --- | --- | --- | --- |',
    '| TB01 | Open | 2 | — | procedures/process.md | checklist |',
    '| TB02 | Open | 1 | NOT-FOUND | procedures/process.md | checklist |',
  ].join('\n') + '\n';
  await put('local-only/workboard.md', table);

  const call = async (args) => {
    const run = await simt([...args, '--json'], { cwd: root });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.doesNotMatch(run.stdout, /PRIVATE CARD BODY/);
    return JSON.parse(run.stdout);
  };
  const scheduleScope = (scope, ...extra) => call(['work', 'schedule', '--scope', scope, ...extra]);
  assert.deepEqual((await scheduleScope('shared')).dispatch, ['AB02']);
  assert.deepEqual((await scheduleScope('procedures')).dispatch, ['TB01']);
  assert.ok((await scheduleScope('procedures')).waiting.some(({ id, missing }) => id === 'TB02' && missing[0].includes('unknown predecessor')));
  const external = await scheduleScope('external');
  assert.deepEqual(external.dispatch, ['EXT-1']);
  assert.ok(external.problems.some(({ code }) => code === 'invalid-task'));
  for (const id of ['handbook', 'procedures']) {
    const snapshot = await scheduleScope(id, '--public');
    assert.equal(snapshot.withheld, true);
    assert.deepEqual(snapshot.tasks, []);
    assert.doesNotMatch(JSON.stringify(snapshot), /local-only|PRIVATE|TB0/);
  }

  await put('handbook/policy.md', '# First change\n');
  await call(['verify', 'run', '--changed', '--scope', 'handbook', '--yes']);
  const current = await scheduleScope('handbook');
  assert.deepEqual(current.dispatch, ['HIGH', 'PRIVATE-2']);
  assert.ok(current.serialized.some(({ id, resource }) => id === 'LOW' && resource === 'handbook'));
  assert.ok(current.problems.some(({ code }) => code === 'duplicate-task-id'));
  assert.ok(current.problems.some(({ code }) => code === 'missing-task-id'));
  assert.deepEqual(current.cycle[0].ids, ['CYCLE-1', 'CYCLE-2']);
  await put('handbook/policy.md', '# Changed since receipt\n');
  const stale = await scheduleScope('handbook');
  assert.equal(stale.evidence['PRIVATE-1'].current, false);
  assert.ok(stale.waiting.some(({ id, missing }) => id === 'PRIVATE-2' && missing[0].includes('evidence not current')));
  assert.equal(await readFile(join(root, 'local-only/workboard.md'), 'utf8'), table);
});
