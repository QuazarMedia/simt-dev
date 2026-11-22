import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compactFileLine, compactTestLine, buildCompactPacket, symbolEntrypoints, taggedLine } from '../src/brief/render.mjs';
import { SECTIONS } from '../src/brief/packet.mjs';

test('a barrel row keeps the query symbol and at most two entry points within 95 bytes', () => {
  const path = 'src/api.mjs';
  const names = ['rankFiles', 'assembleBrief', 'indexRepository',
    ...Array.from({ length: 22 }, (_, index) => 'VeryLongExportedInterface' + index)];
  const symbols = names.map((name, index) => ({ name, line: index + 1, exported: 1 }));
  const structural = symbolEntrypoints([
    { kind: 'calls_symbol', src: 'sym:agent.mjs#run@1', dst: 'sym:src/api.mjs#assembleBrief@2' },
    { kind: 'calls_symbol', src: 'sym:probe.mjs#run@1', dst: 'sym:src/api.mjs#indexRepository@3' },
  ]);
  const text = compactFileLine(path, symbols, 'Improve rankFiles', { entrypoints: structural, subtasks: [3, 1, 3] });
  assert.match(text, /^\[T1,T3\] src\/api\.mjs rankFiles assembleBrief indexRepository \+22$/u);
  assert.ok(Buffer.byteLength(text) <= 95);
  const wide = compactFileLine('lib/auth.mjs', [{ name: '認証方式の移行手順'.repeat(7), exported: 1 }], '', { limit: 60 });
  assert.equal(wide, 'lib/auth.mjs +1');
});

test('test and facet lines keep localized subtask tags and compact witnesses', () => {
  assert.equal(compactTestLine('src/source.mjs', ['test/c.mjs', 'test/a.mjs', 'test/b.mjs', 'test/d.mjs'], { subtasks: [2] }),
    '[T2] src/source.mjs -> test/a.mjs test/b.mjs test/c.mjs (+1)');
  assert.equal(taggedLine('ADR-091 ranking', [2, 1]), '[T1,T2] ADR-091 ranking');
  assert.equal(taggedLine('test/a.mjs'), 'test/a.mjs');
});

test('compact packets count heading, indentation and footer bytes and keep facet floors', () => {
  const items = SECTIONS.filter((section) => ['TASK', 'SUBTASKS', 'FILES', 'TESTS', 'DECISIONS', 'CAUTIONS'].includes(section))
    .map((section, index) => ({
      id: section, section, text: (section === 'SUBTASKS' ? 'T1 Update。\nT2 Verify。' : '[T1] ' + section.toLowerCase()),
      priority: index < 2 ? 'hard' : 'soft', relevance: [{ subtask: 1, score: 1 }],
    }));
  for (let index = 0; index < 25; index += 1) items.push({
    id: 'file:' + index, section: 'FILES', text: 'long unrelated evidence ' + 'a'.repeat(80),
    relevance: [{ subtask: 1, score: 0.01 }],
  });
  const result = buildCompactPacket(items, { budget: 240 });
  assert.equal(result.after, Buffer.byteLength(result.text));
  assert.ok(result.after <= 240);
  assert.equal(result.floorHeld, false);
  assert.deepEqual(result.text.split('\n').filter((line) => SECTIONS.includes(line)),
    ['TASK', 'SUBTASKS', 'FILES', 'TESTS', 'DECISIONS', 'CAUTIONS']);
  assert.match(result.text, /cut \d+ of \d+ items to fit 240/u);
  const single = buildCompactPacket(items.filter(({ section }) => section === 'FILES'), { budget: 0 });
  assert.equal(single.text.includes('SUBTASKS'), false);
});
