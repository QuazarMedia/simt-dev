// The brief packet (review 0003 Q92).
//
// `brief/packet.mjs` is the one module in the brief that is pure: no filesystem, no clock, no
// environment. Every test of it until now went through `simt brief` in a child process, so the
// properties the module exists to guarantee were only ever observed after a spawn, an index
// build and a render — and a regression in `cutOrder` would have shown up as a packet that
// merely looked different.
//
// What is asserted here is the contract a caller depends on: the section order is fixed, the
// hard floor holds whatever the ceiling, a packet says what it cut, and two builds of the same
// items are the same bytes.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_BRIEF_BYTES, PROMPT_CAP_BYTES, buildPacket, collect, explainPacket } from '../src/brief/packet.mjs';

test('a section the packet does not have is a programming error, not a dropped line', () => {
  const items = collect();
  assert.throws(() => items.add('NOTASECTION', 'x'), /unknown brief section NOTASECTION/);
});

test('an empty or non-string line is not added, because a blank item spends bytes saying nothing', () => {
  const items = collect();
  items.add('TASK', '');
  items.add('TASK', null);
  items.add('TASK', 'kept');
  assert.equal(items.items.length, 1);
  assert.equal(items.items[0].text, 'kept');
});

test('sections render in the packet order, not the order they were added', () => {
  const items = collect();
  items.add('CAUTIONS', 'a caution added first');
  items.add('TASK', 'the task added second', { hard: true });
  const { text } = buildPacket(items.items, { budget: 0 });
  assert.ok(text.indexOf('TASK') < text.indexOf('CAUTIONS'), text);
  // And a section with nothing left prints no heading at all.
  assert.ok(!text.includes('FILES'), text);
});

test('inside a section the insertion order is the order a reader meets', () => {
  const items = collect();
  items.add('FILES', 'src/first.mjs');
  items.add('FILES', 'src/second.mjs');
  const { text } = buildPacket(items.items, { budget: 0 });
  assert.ok(text.indexOf('src/first.mjs') < text.indexOf('src/second.mjs'), text);
});

test('a budget of zero is no ceiling: everything stays and nothing is reported cut', () => {
  const { packed, items } = simulate();
  assert.deepEqual(packed.cut, []);
  assert.equal(packed.floorHeld, false);
  assert.equal(packed.after, packed.before);
  for (const item of items) assert.ok(packed.text.includes(item.text), item.text);
});

test('the ceiling is a ceiling, and the packet says what it cut and from where', () => {
  const { items } = simulate();
  for (const budget of [1200, 600, 300, 1]) {
    const trimmed = buildPacket(items, { budget });
    // Either it fits, or it could not: a packet over the line says so through `floorHeld`
    // rather than pretending the ceiling was met.
    assert.ok(Buffer.byteLength(trimmed.text) <= budget || trimmed.floorHeld, `over ${budget} without saying so`);
    for (const item of items.filter((entry) => trimmed.cut.includes(entry.id))) {
      assert.ok(!trimmed.text.includes(item.text), `cut item still printed: ${item.text}`);
    }
    if (trimmed.cut.length > 0) {
      // The line is part of the document, not a footnote: the reader decides whether to ask
      // for more, and a packet that shrank without saying so is the failure this prevents.
      assert.match(trimmed.text, new RegExp(`cut ${trimmed.cut.length} of ${items.length} items to fit ${budget}: (.+)`));
    }
  }
});

test('a tighter ceiling only ever takes away, and the hard floor is never taken', () => {
  const { items } = simulate();
  let kept = items.map((item) => item.id);
  for (const budget of [4000, 1200, 600, 300, 1]) {
    const packed = buildPacket(items, { budget });
    const now = items.filter((item) => !packed.cut.includes(item.id)).map((item) => item.id);
    for (const id of now) assert.ok(kept.includes(id), `${id} came back at budget ${budget}`);
    kept = now;
    for (const hard of items.filter((item) => item.priority === 'hard')) {
      assert.ok(packed.text.includes(hard.text), `hard item cut at ${budget}: ${hard.text}`);
    }
  }
  // At a ceiling nothing can meet in full, the floor is reported rather than silently exceeded.
  assert.equal(buildPacket(items, { budget: 1 }).floorHeld, true);
});

test('the cheapest section goes first, and the task goes last', () => {
  // At a ceiling nothing soft can meet, the cut list is the whole value order: the caution a
  // reader can rediscover before the file list they cannot.
  const { items } = simulate();
  const packed = buildPacket(items, { budget: 1 });
  const order = packed.cut.map((id) => items.find((item) => item.id === id).section);
  assert.deepEqual(order, ['CAUTIONS', 'LESSONS', 'SKILLS', 'DECISIONS', 'FILES']);
});

test('the same items build the same bytes twice, cut list included', () => {
  const { items } = simulate();
  const first = buildPacket(items, { budget: 600 });
  const second = buildPacket(items, { budget: 600 });
  assert.equal(first.text, second.text);
  assert.deepEqual(first.cut, second.cut);
  assert.deepEqual(first.cut, [...first.cut]);
});

test('--explain marks each item and says why it is there', () => {
  const { items, packed } = simulate();
  const lines = explainPacket(items, { cut: new Set(packed.cut) });
  assert.equal(lines.length, items.length * 2);
  assert.match(lines[0], /^(keep|cut) TASK 1\/1 worth 8: task fix the keep helper$/);
  assert.match(lines[1], /^ {5}carried by its section$/);
  const withReason = collect();
  withReason.add('CAUTIONS', 'the index is stale', { why: ['a stale index quotes yesterday'] });
  assert.match(explainPacket(withReason.items)[1], /^ {5}a stale index quotes yesterday$/);
});

test('the defaults are numbers, and the cap is the default rather than a second invention', () => {
  assert.equal(DEFAULT_BRIEF_BYTES, 2048);
  assert.equal(PROMPT_CAP_BYTES, 2048);
});

/** The four items plus one per value class, so a cut has somewhere to start. */
function simulate() {
  const items = collect();
  items.add('TASK', 'task fix the keep helper', { hard: true });
  items.add('COMMANDS', 'npm run test  test', { hard: true });
  items.add('FILES', 'src/keep.mjs');
  items.add('DECISIONS', 'ADR-001 — commits are local until asked');
  items.add('SKILLS', 'release-process — 1200 B');
  items.add('LESSONS', 'L-003 — the lock is read until the next write');
  items.add('CAUTIONS', 'no task was given, so the packet describes the working tree');
  return { items: items.items, packed: buildPacket(items.items, { budget: 600 }) };
}
