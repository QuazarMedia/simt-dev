// Plan 0004 W50: generic remote-work pilot.
//
// A synthetic fixture, run through the modules this plan built, with no target contacted. The
// golden tasks are the ones that decide whether a remote executor is safe: a lost response, a
// reset target, an ambiguous identity, a disabled feature, a UI-only operation and a required
// field the fallback cannot set. The live half of this pilot stays unrun until someone authorises
// it, which is why every check here is offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildTargetSnapshot, inspectTarget, resolveTargetAlias } from '../src/actions/targets.mjs';
import { idempotencyKey, planRetry } from '../src/actions/retry.mjs';
import { checkCommand } from '../src/actions/machine.mjs';
import { selectProtocol, fallbackIntent } from '../src/actions/recovery.mjs';
import { duplicateEffects } from '../src/coordination/handoff.mjs';
import { offline } from '../src/bench/replay.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/pilot-remote.json', import.meta.url), 'utf8'));

test('the fixture names every golden scenario', () => {
  assert.deepEqual(fixture.scenarios, [
    'response-loss',
    'target-reset',
    'ambiguous-identity',
    'feature-disabled',
    'ui-only-operation',
    'required-field-unavailable',
  ]);
});

test('a lost response reconciles instead of creating a second object', () => {
  const target = buildTargetSnapshot(fixture.target);
  const key = idempotencyKey({ intentDigest: fixture.intentDigest, step: 1, target: target.identity });
  assert.equal(key, idempotencyKey({ intentDigest: fixture.intentDigest, step: 1, target: target.identity }));
  assert.equal(planRetry({ operation: 'reconcilable-create', error: 'lost-response' }).decision, 'reconcile');
  assert.match(planRetry({ operation: 'reconcilable-create', error: 'lost-response' }).reason, /before any retry/);
});

test('a reset target is a different identity under the same hostname', () => {
  const before = buildTargetSnapshot(fixture.target);
  const after = buildTargetSnapshot({ ...fixture.target, incarnation: 'inc-2' });
  assert.equal(before.hostname, after.hostname);
  assert.notEqual(before.identity, after.identity);
});

test('an ambiguous alias resolves to nothing, and an ambiguous match halts', () => {
  const resolved = resolveTargetAlias(fixture.targets, 'pilot');
  assert.equal(resolved.error, 'ambiguous-alias');
  assert.deepEqual(resolved.candidates, ['rates-legacy', 'rates-staging']);
  assert.equal(planRetry({ operation: 'read', error: 'ambiguous-match' }).decision, 'halt');
});

test('a feature the target does not declare cannot be used', () => {
  const target = buildTargetSnapshot(fixture.target);
  assert.equal(inspectTarget(target, { operation: 'write-object' }).state, 'unsupported-operation');
  assert.equal(inspectTarget(target, { operation: 'read-object' }).mayMutate, true);
});

test('a UI-only operation that cannot set the required field is refused', () => {
  const result = selectProtocol({ required: ['set-private-flag'], candidates: fixture.protocols });
  assert.equal(result.chosen, null);
  assert.match(result.refused.map((entry) => entry.reason).join(' '), /does not declare set-private-flag/);
});

test('a fallback that adds an effect is a new intent', () => {
  const result = fallbackIntent({ effects: fixture.effects, fallbackEffects: fixture.fallbackEffects });
  assert.equal(result.sameIntent, false);
  assert.deepEqual(result.added, ['remote:delete-object']);
});

test('no duplicate effect is possible under the simulator', () => {
  const capsule = { completed: [{ obligation: 'write', receipt: 'receipt-1' }] };
  assert.equal(duplicateEffects({ capsule, executed: ['receipt-2'] }).safe, true);
  const repeated = duplicateEffects({ capsule, executed: ['receipt-1'] });
  assert.equal(repeated.safe, false);
  assert.deepEqual(repeated.duplicates, ['receipt-1']);
});

test('the local executor refuses a shell string and an unregistered runner', () => {
  assert.equal(checkCommand({ command: 'python deploy.py', argv: [], registered: ['python'] }).allowed, false);
  assert.equal(checkCommand({ command: 'curl', argv: ['-X', 'DELETE', 'https://x'], registered: ['python'] }).allowed, false);
  assert.equal(checkCommand({ command: 'python', argv: ['deploy.py'], registered: ['python'] }).allowed, true);
});

test('the pilot is offline, and says so', () => {
  const report = offline();
  assert.equal(report.liveAcceptance, false);
  assert.equal(report.measures, 'logic-robustness');
});
