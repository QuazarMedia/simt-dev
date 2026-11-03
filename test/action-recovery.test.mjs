// Plan 0004 W36: recovery and protocol fallback equivalence.
//
// What the suite pins: a verified step is not replayed unless its evidence expired; a partial
// batch reports its exact remaining and unknown steps; a compensation is only the declared one and
// can fail; a UI fallback that cannot set a required flag is refused rather than clicked through;
// an unbound or changed form is rediscovered within a bounded limit and then refused; a fallback
// that changes the effect is a new intent; and `simt undo` claims local files only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  RECOVERY_CHOICES,
  UNDO_SCOPE,
  bindUiTarget,
  checkUiStructure,
  chooseRecovery,
  compensationContract,
  fallbackIntent,
  partialBatch,
  resumePlan,
  selectProtocol,
} from '../src/actions/recovery.mjs';

test('the recovery choices and the undo scope are named', () => {
  assert.deepEqual(RECOVERY_CHOICES, ['none', 'retry-after-reconciliation', 'forward-repair', 'compensation', 'manual']);
  assert.equal(UNDO_SCOPE.scope, 'local-files');
  assert.equal(UNDO_SCOPE.remote, false);
});

test('a verified run needs no recovery, and a failed one gets no invented compensation', () => {
  assert.equal(chooseRecovery({ state: 'verified' }).choice, 'none');
  const failed = chooseRecovery({ state: 'failed' });
  assert.equal(failed.choice, 'manual');
  assert.match(failed.reasons[0], /none is inferred/);
});

test('an unknown outcome reconciles when the target can, and asks a person when it cannot', () => {
  assert.equal(chooseRecovery({ state: 'outcome-unknown', reconcilable: true }).choice, 'retry-after-reconciliation');
  const manual = chooseRecovery({ state: 'outcome-unknown', reconcilable: false });
  assert.equal(manual.choice, 'manual');
  assert.match(manual.reasons[0], /a person must look/);
});

test('a compensation is declared, contracted and able to fail', () => {
  assert.throws(() => compensationContract({ effects: [{ operation: 'delete' }], verifier: { obligations: ['absent'] } }), /actor/);
  assert.throws(() => compensationContract({ actor: { id: 'sam' }, effects: [], verifier: { obligations: ['absent'] } }), /effect set/);
  assert.throws(() => compensationContract({ actor: { id: 'sam' }, effects: [{ operation: 'delete' }] }), /verifier/);

  const contract = compensationContract({ actor: { id: 'sam' }, effects: [{ scope: 'remote', operation: 'delete' }], verifier: { obligations: ['absent'] } });
  assert.equal(contract.canFail, true);
  assert.match(contract.digest, /^sha256-/);
  assert.equal(chooseRecovery({ state: 'failed', compensation: contract }).choice, 'compensation');
});

test('a partial batch states what is done, what is left and what is unknown', () => {
  const batch = partialBatch({ steps: 3, journal: [{ step: 1, state: 'verified' }, { step: 2, state: 'outcome-unknown' }] });
  assert.deepEqual(batch.done, [1]);
  assert.deepEqual(batch.unknown, [2]);
  assert.deepEqual(batch.remaining, [3]);
  assert.equal(batch.complete, false);
  assert.equal(partialBatch({ steps: 1, journal: [{ step: 1, state: 'verified' }] }).complete, true);
});

test('a resume skips verified steps unless their evidence expired', () => {
  const journal = [{ step: 1, state: 'verified' }, { step: 2, state: 'verified' }, { step: 3, state: 'outcome-unknown' }];
  const plan = resumePlan({ journal, evidence: { 1: { current: true }, 2: { current: false } } });
  assert.deepEqual(plan.skip, [1]);
  assert.deepEqual(plan.replay, [2]);
  assert.deepEqual(plan.unknown, [3]);
  assert.match(plan.reasons[0], /evidence expired/);
});

test('a UI fallback that cannot set the required flag is refused', () => {
  const result = selectProtocol({
    required: ['set-private-flag'],
    candidates: [{ name: 'ui', capabilities: ['set-name'], reliability: 0.99 }, { name: 'rest', capabilities: ['set-private-flag', 'set-name'], reliability: 0.8 }],
  });
  assert.equal(result.chosen, 'rest');
  const refused = selectProtocol({ required: ['set-private-flag'], candidates: [{ name: 'ui', capabilities: ['set-name'], reliability: 0.99 }] });
  assert.equal(refused.chosen, null);
  assert.match(refused.refused[0].reason, /does not declare set-private-flag/);
});

test('a page is bound before it is submitted, and rediscovered within a limit', () => {
  const unbound = checkUiStructure(bindUiTarget({ form: 'f1' }), { signature: 'x' });
  assert.equal(unbound.action, 'refuse');
  assert.match(unbound.reason, /blind click/);

  const bound = bindUiTarget({ form: 'f1', fields: { name: '#name' }, signature: 'sig-1' });
  assert.equal(bound.bound, true);
  assert.equal(checkUiStructure(bound, { signature: 'sig-1' }).action, 'submit');
  assert.equal(checkUiStructure(bound, { signature: 'sig-2', attempts: 0 }).action, 'rediscover');
  assert.equal(checkUiStructure(bound, { signature: 'sig-2', attempts: 2, limit: 2 }).action, 'refuse');
});

test('a fallback that changes the effect is a new intent', () => {
  const same = fallbackIntent({ effects: [{ scope: 'remote', operation: 'write' }], fallbackEffects: [{ scope: 'remote', operation: 'write' }] });
  assert.equal(same.sameIntent, true);

  const changed = fallbackIntent({ effects: [{ scope: 'remote', operation: 'write' }], fallbackEffects: [{ scope: 'remote', operation: 'write' }, { scope: 'remote', operation: 'delete' }] });
  assert.equal(changed.sameIntent, false);
  assert.deepEqual(changed.added, ['remote:delete']);
  assert.match(changed.reason, /new intent/);
});

test('the module is deterministic and reads nothing', async () => {
  assert.deepEqual(partialBatch({ steps: 2, journal: [] }), partialBatch({ steps: 2, journal: [] }));
  const source = await readFile(new URL('../src/actions/recovery.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
