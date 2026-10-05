import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compose, diff, inject, parse, BEGIN, END } from '../src/projection/markers.mjs';

const HAND = ['# My Project', '', 'Hand-written guidance that must survive.', ''].join('\n');

test('markers: an absent region parses as absent, not as malformed', () => {
  const state = parse(HAND);
  assert.equal(state.status, 'absent');
});

test('markers: parse round-trips and recovers the provenance sha', () => {
  const region = compose('body line', { sha: 'abc1234', sources: ['rules/core.md'] });
  const state = parse(`${HAND}\n${region}\n`);
  assert.equal(state.status, 'ok');
  assert.equal(state.sha, 'abc1234');
  assert.match(state.body, /simt-dev:sources=rules\/core\.md/);
  assert.match(state.before, /Hand-written guidance/);
});

test('markers: injecting preserves every byte outside the region', () => {
  const before = `${HAND}\n${compose('v1', { sha: 'aaaaaaa' })}\n\n## Local section\n\nlocal only.\n`;
  const after = inject(before, 'v2', { sha: 'bbbbbbb' });
  assert.equal(after.action, 'updated');
  assert.match(after.text, /Hand-written guidance that must survive\./);
  assert.match(after.text, /## Local section/);
  assert.match(after.text, /local only\./);
  assert.match(after.text, /^v2$/m);
  assert.doesNotMatch(after.text, /^v1$/m);
});

test('markers: inject is idempotent', () => {
  // The property that keeps CI from flaking: running sync twice must be a no-op.
  const once = inject(HAND, 'the body', { sha: 'abc1234' });
  const twice = inject(once.text, 'the body', { sha: 'abc1234' });
  assert.equal(twice.action, 'unchanged');
  assert.equal(twice.text, once.text);

  const third = inject(twice.text, 'the body', { sha: 'abc1234' });
  assert.equal(third.text, once.text);
});

test('markers: a missing region is added without destroying the document', () => {
  const result = inject(HAND, 'new body', { sha: 'abc1234' });
  assert.equal(result.action, 'added');
  assert.match(result.text, /Hand-written guidance/);
  assert.match(result.text, /new body/);
  assert.ok(result.text.startsWith('# My Project'));
});

test('markers: a doc without a trailing newline is handled', () => {
  const noNewline = '# Title\n\ntext';
  const result = inject(noNewline, 'body', { sha: 'abc1234' });
  assert.equal(result.action, 'added');
  assert.ok(result.text.startsWith('# Title\n\ntext\n'));
  assert.equal(inject(result.text, 'body', { sha: 'abc1234' }).action, 'unchanged');
});

test('markers: an unbalanced begin is malformed, never silently appended to', () => {
  // Appending a second region here would duplicate every rule in the document
  // while reporting success. This is the failure the engine exists to prevent.
  const broken = `${HAND}\n${BEGIN}\nbody with no end\n`;
  const state = parse(broken);
  assert.equal(state.status, 'malformed');
  assert.match(state.reason, /no matching end marker/);

  const result = inject(broken, 'new', { sha: 'abc1234' });
  assert.equal(result.action, 'malformed');
  assert.equal(result.text, broken, 'a malformed document must not be rewritten');
});

test('markers: an end before any begin is malformed', () => {
  const broken = `${HAND}\n${END}\n${BEGIN}\nbody\n${END}\n`;
  const state = parse(broken);
  assert.equal(state.status, 'malformed');
  assert.match(state.reason, /end marker before any begin/);
});

test('markers: two regions are reported rather than merged', () => {
  const broken = `${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`;
  assert.equal(parse(broken).status, 'malformed');
});

test('markers: nested markers are malformed', () => {
  assert.equal(parse(`${BEGIN}\na\n${BEGIN}\nb\n${END}\n`).status, 'malformed');
  assert.equal(parse(`${BEGIN}\na\n${END}\n${END}\n`).status, 'malformed');
});

test('markers: markers inside a fenced code block are documentation, not control', () => {
  // A repo whose AGENTS.md explains this mechanism must not confuse the engine.
  const doc = [
    '# Rules',
    '',
    '## How the projection works',
    '',
    '```markdown',
    `${BEGIN}`,
    'example body',
    `${END}`,
    '```',
    '',
  ].join('\n');
  const state = parse(doc);
  assert.equal(state.status, 'absent');

  const result = inject(doc, 'real body', { sha: 'abc1234' });
  assert.equal(result.action, 'added');
  // The documented example survives; the real region is added after it.
  assert.match(result.text, /```markdown/);
  assert.match(result.text, /example body/);
  assert.match(result.text, /real body/);
  assert.equal(inject(result.text, 'real body', { sha: 'abc1234' }).action, 'unchanged');
});

test('markers: diff reports without writing', () => {
  const meta = { sha: 'abc1234' };
  const current = inject(HAND, 'v1', meta).text;
  assert.deepEqual(diff(current, 'v1', meta), { action: 'unchanged' });
  assert.deepEqual(diff(current, 'v2', meta), { action: 'updated' });
  assert.deepEqual(diff(HAND, 'v1', meta), { action: 'added' });
  assert.equal(diff(`${BEGIN}\nunclosed\n`, 'v1', meta).action, 'malformed');
});

test('markers: a changed sha alone counts as drift', () => {
  // The body is byte-identical but was produced by an older simt-dev. That is
  // exactly the drift the provenance header exists to surface, so `simt-dev check`
  // must not treat it as unchanged.
  const old = inject(HAND, 'body', { sha: 'aaaaaaa' }).text;
  const same = { sha: 'aaaaaaa' };
  const newer = { sha: 'bbbbbbb' };
  assert.equal(diff(old, 'body', same).action, 'unchanged');
  assert.equal(diff(old, 'body', newer).action, 'updated');
  assert.equal(parse(old).sha, 'aaaaaaa');
});

test('markers: compose emits begin before end and carries the header inside', () => {
  const region = compose('x', { sha: 'abc1234', sources: ['a', 'b'] });
  assert.ok(region.startsWith(BEGIN));
  assert.ok(region.endsWith(END));
  assert.ok(region.indexOf(BEGIN) < region.indexOf('simt-dev:sha'));
  assert.ok(region.indexOf('simt-dev:sha') < region.indexOf(END));
});