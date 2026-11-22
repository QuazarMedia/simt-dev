import assert from 'node:assert/strict';
import { test } from 'node:test';

import { packSubmodular } from '../src/brief/submodular.mjs';

function item(id, section, subtask, score, bytes, extra = {}) {
  return { id, section, bytes, relevance: [{ subtask, score }], ...extra };
}

test('balances four subtasks and every active facet within the 2048-byte budget', () => {
  const sections = ['FILES', 'TESTS', 'DECISIONS', 'SKILLS', 'CAUTIONS'];
  const items = [{ id: 'task', section: 'TASK', text: 'Review four atomic tasks', priority: 'hard' }];
  for (let subtask = 1; subtask <= 4; subtask += 1) {
    for (const section of sections) items.push(item(section + ':' + subtask, section, subtask, 1, 60));
  }
  for (let index = 21; index < 200; index += 1) {
    items.push(item('alternative:' + index, 'FILES', 1, 0.25, 100, { duplicateKey: 'same-library' }));
  }
  const selected = packSubmodular(items, { budget: 2048 });
  assert.equal(selected.feasible, true);
  assert.ok(selected.kept.includes('task'));
  assert.ok(selected.bytes <= 2048);
  assert.deepEqual(selected.kept.filter((id) => id.startsWith('FILES:')), ['FILES:1', 'FILES:2', 'FILES:3', 'FILES:4']);
  assert.ok(sections.every((section) => selected.kept.some((id) => id.startsWith(section + ':'))));
  assert.ok(selected.trace.filter(({ priority }) => priority === 'soft').every(({ gain, gainPerByte }) => gain > 0 && gainPerByte > 0));
  assert.deepEqual(selected, packSubmodular(items.toReversed(), { budget: 2048 }));
});

test('repeated evidence saturates without canceling contribution to other tasks', () => {
  const items = [
    item('original', 'FILES', 1, 1, 2, { priority: 'hard', duplicateKey: 'shared' }),
    item('redundant', 'FILES', 1, 1, 2, { duplicateKey: 'shared' }),
    item('other-task', 'FILES', 2, 1, 2, { duplicateKey: 'shared' }),
    item('additional', 'FILES', 1, 1, 2),
  ];
  const result = packSubmodular(items, { budget: 8 });
  assert.deepEqual(result.cut, ['redundant']);
  assert.ok(result.trace.find(({ id }) => id === 'other-task').gain > result.trace.find(({ id }) => id === 'additional').gain);
});

test('the best feasible singleton can beat the density prefix', () => {
  const items = [
    item('denser', 'FILES', 1, Math.expm1(0.8), 6),
    item('high-value', 'FILES', 1, Math.expm1(1.3), 10),
  ];
  const found = packSubmodular(items, { budget: 10, facetWeights: { FILES: 1 } });
  assert.deepEqual(found.kept, ['high-value']);
  assert.equal(found.method, 'regularized');
  assert.equal(found.bytes, 10);
});

test('keeps every hard item when the floor cannot fit and renders unlimited selections', () => {
  const items = [
    { id: 'mandatory', section: 'TASK', text: 'あいうえお', priority: 'hard' },
    item('soft', 'FILES', 2, 1, 3),
  ];
  const over = packSubmodular(items, { budget: 10 });
  assert.equal(over.feasible, false);
  assert.deepEqual(over.kept, ['mandatory']);
  assert.equal(over.bytes, 15);
  const unlimited = packSubmodular(items, { budget: 0 });
  assert.deepEqual(unlimited.kept, ['mandatory', 'soft']);
  assert.equal(unlimited.bytes, 18);
  assert.equal(unlimited.feasible, true);
});
