// Plan 0004 W33: bounded external executor and event state machine.
//
// What the suite pins: no dispatch without a write-ahead record; only declared transitions are
// legal; a cancellation during dispatch is outcome-unknown, not cancelled; a replayed journal
// tells a resumed process what may be in flight; a duplicate event id dedupes local recording and
// nothing else; a shell string is refused; a side-effecting adapter is off unless configured; and
// no exactly-once promise is made without target support.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MACHINE_SCHEMA,
  SIDE_STATES,
  STATES,
  TERMINAL_STATES,
  adapterEnabled,
  beginOperation,
  cancel,
  checkCommand,
  dispatch,
  executionGuarantee,
  recordEvent,
  replay,
  transition,
} from '../src/actions/machine.mjs';

const begin = (over = {}) => beginOperation({ operationId: 'op-1', intentDigest: 'sha256-intent', now: '2026-11-03T10:00:00Z', ...over });

test('the schema names the path, the side states and the terminal states', () => {
  assert.equal(MACHINE_SCHEMA, 'simt.machine/1');
  assert.deepEqual(STATES, ['planned', 'ready', 'executing', 'observing', 'verified']);
  assert.deepEqual(SIDE_STATES, ['blocked', 'failed', 'outcome-unknown', 'compensating', 'compensated']);
  assert.deepEqual(TERMINAL_STATES, ['verified', 'failed', 'compensated']);
});

test('a write-ahead record carries the operation and the intent before anything is dispatched', () => {
  const record = begin();
  assert.equal(record.state, 'planned');
  assert.equal(record.operationId, 'op-1');
  assert.equal(record.intentDigest, 'sha256-intent');
  assert.equal(record.adapter, null);
  assert.throws(() => beginOperation({ intentDigest: 'sha256-intent' }), /operation id/);
  assert.throws(() => beginOperation({ operationId: 'op-1' }), /intent digest/);
});

test('the declared path is the only path', () => {
  const ready = dispatch(begin());
  assert.equal(ready.state, 'ready');
  const executing = transition(ready, 'executing');
  const observing = transition(executing, 'observing');
  const verified = transition(observing, 'verified');
  assert.deepEqual(verified.history.map((event) => event.to ?? event.state), ['planned', 'ready', 'executing', 'observing', 'verified']);
  assert.throws(() => transition(begin(), 'verified'), /cannot go from planned to verified/);
  assert.throws(() => transition(verified, 'ready'), /cannot go from verified to ready/);
});

test('a cancellation during dispatch is outcome-unknown until reconciled', () => {
  const executing = transition(dispatch(begin()), 'executing');
  const cancelled = cancel(executing);
  assert.equal(cancelled.state, 'outcome-unknown');
  assert.match(cancelled.history.at(-1).reason, /may already have taken effect/);

  const reconciled = transition(cancelled, 'verified', { reason: 'read back by operation id' });
  assert.equal(reconciled.state, 'verified');

  const early = cancel(begin());
  assert.equal(early.state, 'failed');
  assert.match(early.history.at(-1).reason, /nothing left the process/);
});

test('a journal replays to a resumable state at every boundary', () => {
  const executing = transition(dispatch(begin()), 'executing');
  for (const record of [begin(), dispatch(begin()), executing]) {
    const resumed = replay(record.history);
    assert.equal(resumed.state, record.state);
    assert.equal(resumed.resumable, true);
    if (record.state === 'executing') assert.equal(resumed.inFlight, true);
  }
  assert.equal(replay([]).resumable, false);
  assert.match(replay([]).reason, /journal is empty/);

  const inFlight = replay(executing.history);
  assert.match(inFlight.reason, /cannot be assumed stopped/);

  const done = replay(transition(transition(executing, 'observing'), 'verified').history);
  assert.equal(done.resumable, false);
});

test('a duplicate event is recorded once, and local dedupe claims nothing remote', () => {
  const first = recordEvent([], { id: 'e1', kind: 'dispatched' });
  assert.equal(first.recorded, true);
  const second = recordEvent(first.events, { id: 'e1', kind: 'dispatched' });
  assert.equal(second.recorded, false);
  assert.equal(second.events.length, 1);
  assert.equal(second.remoteEffectsChanged, false);
  assert.equal(recordEvent([], { kind: 'x' }).recorded, false);
});

test('a shell string is refused; a registered runner with argv is allowed', () => {
  assert.equal(checkCommand({ command: 'npm test', argv: [], registered: ['npm'] }).allowed, false);
  assert.equal(checkCommand({ command: 'npm', argv: ['run', 'test;rm'], registered: ['npm'] }).allowed, true);
  assert.equal(checkCommand({ command: 'rm', argv: ['-rf', '/'], registered: ['npm'] }).allowed, false);
  assert.match(checkCommand({ command: 'rm', argv: [], registered: ['npm'] }).reason, /not a registered runner/);
  assert.equal(checkCommand({ command: 'npm', argv: ['run', 'a\nb'], registered: ['npm'] }).allowed, false);
  const ok = checkCommand({ command: 'npm', argv: ['run', 'test'], registered: ['npm'] });
  assert.equal(ok.allowed, true);
  assert.equal(ok.env, 'restricted');
});

test('a side-effecting adapter is off unless explicitly enabled', () => {
  assert.equal(adapterEnabled({}, 'ssh'), false);
  assert.equal(adapterEnabled({ adapters: { ssh: false } }, 'ssh'), false);
  assert.equal(adapterEnabled({ adapters: { ssh: true } }, 'ssh'), true);
});

test('no exactly-once promise without target support', () => {
  assert.equal(executionGuarantee().promise, 'at-least-once');
  assert.match(executionGuarantee().reason, /no exactly-once claim/);
  assert.equal(executionGuarantee({ serverDeduplication: true }).promise, 'at-most-once-per-effect');
  assert.equal(executionGuarantee({ atomicPrecondition: true }).promise, 'at-most-once-per-effect');
});

test('the machine is deterministic and reads nothing', async () => {
  assert.deepEqual(begin(), begin());
  const source = await readFile(new URL('../src/actions/machine.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
