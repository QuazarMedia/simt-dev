// Plan 0004 W40: hook normalization for structured tool calls.
//
// What the suite pins: a call is named by effect and resource, not by the harness that reported
// it; an equivalent action normalises identically across harnesses; an unparsed command is
// `unknown` and a mediated boundary denies it while an observing one says so; the existing policy
// table still decides, unchanged, for the facts it already understood; and a recorded call carries
// no token.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { decide } from '../src/agenthooks/decide.mjs';
import {
  ASSURANCE,
  EFFECT_CLASSES,
  mediate,
  normaliseFacts,
  parity,
  recordedCall,
} from '../src/agenthooks/normalize.mjs';

const write = (path) => ({ command: null, writes: [{ path, generated: null, touches: false }], shell: null });
const shell = (facts, command) => ({ command, writes: [], shell: { facts } });
const push = shell([{ kind: 'git', sub: 'push', globals: { c: [] }, refspecs: ['origin', 'main'] }], 'git push origin main');

test('the effect classes and assurance labels are named', () => {
  assert.deepEqual(EFFECT_CLASSES, ['read', 'local-write', 'history', 'push', 'remote-write', 'unknown']);
  assert.deepEqual(ASSURANCE, ['mediated', 'observe-only']);
});

test('an edit is a local write with the path as its resource', () => {
  const operation = normaliseFacts({ facts: write('src/rates.mjs'), harness: 'claude' });
  assert.equal(operation.effect, 'local-write');
  assert.deepEqual(operation.resource, ['src/rates.mjs']);
  assert.equal(operation.classified, true);
  assert.match(operation.operation, /^sha256-/);
});

test('a push and a commit are both history-changing but not the same class', () => {
  assert.equal(normaliseFacts({ facts: push }).effect, 'push');
  const commit = shell([{ kind: 'git', sub: 'commit', globals: { c: [] } }], 'git commit -m x');
  assert.equal(normaliseFacts({ facts: commit }).effect, 'history');
});

test('a command nobody parsed is unknown, not read', () => {
  const operation = normaliseFacts({ facts: shell([], './deploy.sh --force') });
  assert.equal(operation.effect, 'unknown');
  assert.equal(operation.classified, false);
});

test('a mediated boundary denies what it cannot name; an observing one says so', () => {
  const facts = shell([], './deploy.sh --force');
  const mediated = mediate({ facts, mediated: true });
  assert.equal(mediated.verdict, 'deny');
  assert.match(mediated.reason, /does not allow what it cannot name/);

  const observed = mediate({ facts, mediated: false });
  assert.equal(observed.verdict, 'allow');
  assert.equal(observed.assurance, 'observe-only');
  assert.match(observed.reason, /observes and does not mediate/);
});

test('the same action normalises identically across harnesses', () => {
  const a = normaliseFacts({ facts: write('src/rates.mjs'), harness: 'claude' });
  const b = normaliseFacts({ facts: write('src/rates.mjs'), harness: 'codex' });
  assert.deepEqual(parity([a, b]), { same: true, effects: ['local-write'], harnesses: ['claude', 'codex'] });

  const c = normaliseFacts({ facts: push, harness: 'claude' });
  assert.equal(parity([a, c]).same, false);
});

test('the existing policy table still decides, unchanged', () => {
  const direct = decide({ event: 'pre-tool-use', facts: push, env: {} });
  const through = mediate({ facts: push, mediated: true });
  assert.equal(through.verdict, direct.decision);
  assert.deepEqual(through.blocked, direct.blocked);

  const edit = mediate({ facts: write('src/rates.mjs'), mediated: true });
  assert.equal(edit.verdict, 'allow');
  assert.equal(edit.assurance, 'mediated');
});

test('a recorded call is redacted before it is written', () => {
  const operation = normaliseFacts({ facts: write('src/rates.mjs') });
  const record = recordedCall({ operation, output: 'failed with ghp_abcdefghijklmnopqrstuvwxyz0123' });
  assert.doesNotMatch(record.output, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
  assert.equal(record.redacted, true);
  assert.deepEqual(record.operation.resource, ['src/rates.mjs']);
  assert.equal(recordedCall({ operation, output: 'ok' }).redacted, false);
});

test('the normaliser is deterministic and reads nothing', async () => {
  assert.deepEqual(normaliseFacts({ facts: push }), normaliseFacts({ facts: push }));
  const source = await readFile(new URL('../src/agenthooks/normalize.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});

// Nothing was compared, so nothing is the same: an empty list used to report agreement.
import { parity as parityOfNothing } from '../src/agenthooks/normalize.mjs';

test('an empty comparison is not agreement', () => {
  const result = parityOfNothing([]);
  assert.equal(result.same, false);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.harnesses, []);
});
