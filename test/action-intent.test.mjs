// Plan 0004 W32: intent manifests and authorization binding.
//
// What the suite pins: the digest covers what an authorization is about and nothing cosmetic;
// changing target, actor, effects, contract or delta invalidates the binding while a re-render
// does not; a scope expansion asks again; a local `--yes` writer plan is not a remote permission;
// retrieved text cannot mint an authorization; and a dry run has no effects at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  AUTHORIZATION_SOURCES,
  AUTHORIZATION_STATES,
  EFFECT_SCOPES,
  INTENT_SCHEMA,
  bindAuthorization,
  buildIntent,
  checkAuthorization,
  intentDigest,
  scopeOf,
} from '../src/actions/intent.mjs';

const intent = (over = {}) =>
  buildIntent({
    goal: 'publish the discount rule',
    target: { identity: 'rates/staging#inc-1', namespace: 'rates/staging', incarnation: 'inc-1' },
    actor: { id: 'sam' },
    selectors: ['rule:42'],
    beforeRevisions: { 'rule:42': 'rev-3' },
    delta: { digest: 'sha256-delta', changes: [{ field: 'name' }] },
    effects: [
      { scope: 'remote', operation: 'write-object' },
      { scope: 'local', operation: 'write-journal' },
    ],
    verifier: { obligations: ['read-back'] },
    contract: { digest: 'sha256-contract' },
    limits: { actions: 4, cost: 0, seconds: 600 },
    recovery: 'retry',
    label: 'Publish discount',
    ...over,
  });

const authorization = (over = {}) => ({ source: 'user', kind: 'approval', digest: intentDigest(intent()), ...over });

test('the schema and its vocabularies are named', () => {
  assert.equal(INTENT_SCHEMA, 'simt.intent/1');
  assert.deepEqual(AUTHORIZATION_SOURCES, ['user', 'policy']);
  assert.deepEqual(AUTHORIZATION_STATES, ['authorized', 'reauthorization-required', 'unauthorized']);
  assert.deepEqual(EFFECT_SCOPES, ['local', 'remote']);
});

test('the intent digest covers the effect set and ignores cosmetic fields', () => {
  const base = intent();
  const relabelled = intent({ label: 'Something else', description: 're-rendered' });
  assert.equal(intentDigest(base), intentDigest(relabelled));

  assert.notDeepEqual(scopeOf(base).effects, scopeOf(intent({ effects: [{ scope: 'remote', operation: 'write-object' }] })).effects);
  assert.notEqual(intentDigest(base), intentDigest(intent({ target: { identity: 'rates/prod#inc-9', namespace: 'rates/prod', incarnation: 'inc-9' } })));
  assert.notEqual(intentDigest(base), intentDigest(intent({ actor: { id: 'other' } })));
  assert.notEqual(intentDigest(base), intentDigest(intent({ delta: { digest: 'sha256-other', changes: [{ field: 'tags' }] } })));
  assert.notEqual(intentDigest(base), intentDigest(intent({ contract: { digest: 'sha256-other' } })));
});

test('an approval binds to the intent it was recorded against', () => {
  const bound = bindAuthorization(intent(), authorization());
  assert.equal(bound.bound, true);
  assert.equal(bound.reasons.length, 0);

  const changed = bindAuthorization(intent({ actor: { id: 'other' } }), authorization());
  assert.equal(changed.bound, false);
  assert.match(changed.reasons[0], /changed after this authorization was recorded/);
});

test('a matching approval proceeds without a redundant prompt', () => {
  const result = checkAuthorization(intent(), authorization());
  assert.equal(result.state, 'authorized');
  assert.equal(result.mayProceed, true);
  assert.equal(result.prompt, false);
});

test('changing target, actor, effects, contract or delta asks again; cosmetics do not', () => {
  const reapproved = (over) => checkAuthorization(intent(over), authorization());
  for (const over of [{ target: { identity: 'rates/prod#inc-9', namespace: 'rates/prod', incarnation: 'inc-9' } }, { actor: { id: 'other' } }, { contract: { digest: 'sha256-other' } }, { delta: { digest: 'sha256-other', changes: [] } }]) {
    assert.equal(reapproved(over).state, 'reauthorization-required');
  }
  assert.equal(checkAuthorization(intent({ label: 'Re-rendered' }), authorization()).state, 'authorized');
});

test('a widened effect set is a new decision, with the expansion named', () => {
  const narrow = authorization({ effects: ['remote:write-object'] });
  const widened = checkAuthorization(intent(), narrow);
  assert.equal(widened.state, 'reauthorization-required');
  assert.deepEqual(widened.expanded, ['local:write-journal']);
});

test('a local writer plan is not a remote permission token', () => {
  const yes = checkAuthorization(intent(), { source: 'user', kind: 'writer-plan' });
  assert.equal(yes.state, 'unauthorized');
  assert.match(yes.reasons[0], /not a remote permission token/);

  const localOnly = intent({ effects: [{ scope: 'local', operation: 'write-file' }] });
  const plan = checkAuthorization(localOnly, { source: 'user', kind: 'yes' });
  assert.equal(plan.state, 'authorized');
  assert.match(plan.reasons[0], /local effects only/);
});

test('retrieved text or a resumed summary cannot mint an authorization', () => {
  for (const source of ['document', 'model', 'resumed-agent', 'retrieved']) {
    const result = checkAuthorization(intent(), { source, digest: intentDigest(intent()) });
    assert.equal(result.state, 'unauthorized', `${source} authorized an intent`);
    assert.match(result.reasons[0], /only a user decision or a repository policy/);
    assert.equal(bindAuthorization(intent(), { source }).bound, false);
  }
  assert.equal(checkAuthorization(intent(), null).state, 'unauthorized');
});

test('a dry run has no effects, so nothing can be authorized by accident', () => {
  const dry = intent({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.effects, []);
  // The dry run is a different intent, so it carries its own approval; what matters is that an
  // approval bound to the effect set cannot cover it by accident.
  assert.equal(checkAuthorization(dry, authorization({ digest: intentDigest(dry) })).state, 'authorized');
  assert.equal(checkAuthorization(dry, authorization()).state, 'reauthorization-required');
  const yes = checkAuthorization(dry, { source: 'user', kind: 'writer-plan' });
  assert.equal(yes.state, 'authorized');
});

test('the manifest is deterministic and the module reads nothing', async () => {
  assert.deepEqual(intent(), intent());
  const source = await readFile(new URL('../src/actions/intent.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
