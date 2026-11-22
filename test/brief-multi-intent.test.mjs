import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindSubtaskAnchors } from '../src/brief/anchors.mjs';
import { decomposePrompt } from '../src/brief/decompose.mjs';
import { classifySubtaskIntents, classifyTask, subtaskCommands } from '../src/brief/kind.mjs';
import { orderSubtasks } from '../src/brief/plan-graph.mjs';

const paths = ['src/index/map.mjs', 'src/brief/assemble.mjs', 'src/impact.mjs', 'README.md'];
const graph = {
  files: paths.map((path) => ({ path })),
  symbols: [],
  edges: [{ src: 'src/brief/assemble.mjs', dst: 'src/index/map.mjs', kind: 'import' }],
};

function tasksFor(prompt, index = graph) {
  return bindSubtaskAnchors(decomposePrompt(prompt), index);
}

test('classifies each clause, preserves the widest kind and selects declared commands once', () => {
  const prompt = 'Fix ranking in map.mjs, implement segmentation in assemble.mjs, refactor impact.mjs, and document README.md';
  const plan = classifySubtaskIntents(tasksFor(prompt));
  assert.equal(plan.kind, 'feature');
  assert.deepEqual(plan.tasks.map(({ intent }) => intent.kind), ['bugfix', 'feature', 'refactor', 'docs']);
  assert.ok(plan.obligations.includes('code:test'));
  assert.ok(plan.obligations.includes('artifact:validate'));
  const card = {
    lines: ['build', 'test', 'focused', 'lint', 'format', 'typecheck', 'deploy'].map((verb) => ({ verb, command: 'runner ' + verb })),
  };
  card.lines.push(card.lines[0]);
  const commands = subtaskCommands(plan.tasks, card);
  assert.deepEqual(commands.verbs, ['test', 'focused', 'lint', 'format', 'typecheck', 'build']);
  assert.deepEqual(commands.commands.find(({ verb }) => verb === 'build').subtasks, [2]);
  assert.equal(commands.commands.some(({ verb }) => verb === 'deploy'), false);
  assert.equal(commands.commands.filter(({ verb }) => verb === 'build').length, 1);
  assert.equal(classifyTask('Fix wording in README.md', { paths: ['README.md'] }).kind, 'bugfix');
});

test('orders producers before consumers with import and typed witnesses', () => {
  const taskGraph = {
    ...graph,
    symbolGraph: {
      edges: [
        { kind: 'contains', src: 'file:src/index/map.mjs', dst: 'sym:src/index/map.mjs#rank@1' },
        { kind: 'contains', src: 'file:src/brief/assemble.mjs', dst: 'sym:src/brief/assemble.mjs#assemble@1' },
        { kind: 'calls_symbol', src: 'sym:src/brief/assemble.mjs#assemble@1', dst: 'sym:src/index/map.mjs#rank@1' },
      ],
    },
  };
  const tasks = tasksFor('Implement segmentation in assemble.mjs, fix ranking in map.mjs, and document README.md');
  const schedule = orderSubtasks(tasks, taskGraph);
  assert.deepEqual(schedule.order, [2, 1, 3]);
  assert.deepEqual(schedule.dependencies.map(({ before, after }) => [before, after]), [[2, 1]]);
  assert.deepEqual(schedule.dependencies[0].witnesses.map(({ kind }) => kind).sort(), ['calls_symbol', 'import']);
});

test('binds explicit sequencing and exposes mutual dependencies without inventing an order', () => {
  const tasks = tasksFor('First, fix map.mjs. Then verify assemble.mjs before task 3. Finally document README.md.');
  assert.equal(tasks.length, 3);
  const schedule = orderSubtasks(tasks, {
    ...graph,
    edges: [...graph.edges, { kind: 'import', src: 'src/index/map.mjs', dst: 'src/brief/assemble.mjs' }],
  });
  assert.deepEqual(schedule.groups, [[1, 2], [3]]);
  assert.deepEqual(schedule.cycles, [[1, 2]]);
  assert.ok(schedule.dependencies.some(({ before, after, witnesses }) =>
    before === 2 && after === 3 && witnesses.some(({ marker }) => marker === 'before')));
  const named = tasksFor('Update map.mjs.\n\nAfter editing map.mjs, verify README.md.');
  assert.ok(orderSubtasks(named, { ...graph, edges: [] }).dependencies.some(({ before, after, witnesses }) =>
    before === 1 && after === 2 && witnesses.some(({ marker }) => marker === 'after')));
});
