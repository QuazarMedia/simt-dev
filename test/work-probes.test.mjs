// Plan 0004 W05: evidence laundering and unsafe repetition, tested before any feature.
//
// The bar is not "the happy path works". It is that every forbidden effect this suite
// names is refused on a mediated fixture, that a bypass is labelled unprotected instead of
// quietly passing, and that a capability claim cannot buy itself a stronger assurance
// level. Each probe's verdict and effect count is its own oracle; the aggregate is only a
// count of those rows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ASSURANCE_LEVELS,
  PROBES,
  assuranceLevel,
  mediate,
  runProbe,
  runProbes,
  world,
} from '../packages/bench/src/work-probes.mjs';

const OBJECT = { namespace: 'tenant-a', type: 'calculation', id: 'calc-1' };

test('every probe has an expected verdict and an effect oracle, and passes it', () => {
  const summary = runProbes();
  assert.equal(summary.total, PROBES.length);
  for (const probe of PROBES) {
    assert.equal(typeof probe.expect?.verdict, 'string', `${probe.id} states no expected verdict`);
    assert.equal(typeof probe.expect?.effects, 'number', `${probe.id} states no expected effect count`);
  }
  assert.deepEqual(summary.forbiddenEffects, [], `forbidden effects slipped through: ${summary.forbiddenEffects.join(', ')}`);
  for (const row of summary.rows) assert.ok(row.pass, `${row.id}: expected ${row.expected}, got ${row.verdict} with ${row.effects} effect(s)`);
  assert.equal(summary.ok, true);
});

test('the ten named attacks are all in the catalogue, by name', () => {
  const ids = new Set(PROBES.map((probe) => probe.id));
  for (const id of [
    'a01-source-instructs-widening',
    'a02-forged-verifier-receipt',
    'a03-wrong-tenant',
    'a04-unlisted-actor',
    'a05-expired-approval',
    'a06-mixed-scope-retrieval',
    'a07-stale-revision',
    'a08-private-field-lost-in-fallback',
    'a09-crash-after-commit',
    'a10-expired-lease',
    'a11-live-verification-unavailable',
  ]) {
    assert.ok(ids.has(id), `${id} is not probed`);
  }
});

test('a bypassing caller is reported unprotected, never as a pass', () => {
  const probe = PROBES.find((entry) => entry.id === 'a01-source-instructs-widening');
  const row = runProbe({ ...probe, context: world({ mediated: false }) });
  assert.equal(row.verdict, 'unprotected');
  assert.equal(row.pass, false, 'an unprotected route cannot satisfy a rejection oracle');
  assert.equal(row.effects, 0, 'the model does not invent effects it did not observe');
  assert.match(row.reason, /no mediation boundary/);
});

test('a rejection that still lands an effect is the failure this slice exists for', () => {
  const probe = {
    id: 'counterexample',
    intent: { op: 'create', actor: 'agent', target: OBJECT, batch: 2 },
    context: world({ actors: ['agent'] }),
    expect: { verdict: 'rejected', effects: 0 },
  };
  // The boundary allows this one; the point is that the oracle reads effects, so a tidy
  // verdict cannot launder the two effects that landed.
  const row = runProbe(probe);
  assert.equal(row.verdict, 'allowed');
  assert.equal(row.effects, 2);
  assert.equal(row.pass, false);
});

test('assurance: a claim cannot upgrade itself, and evidence without a subject is not evidence', () => {
  assert.equal(assuranceLevel([]), null, 'no evidence supports no level');
  assert.equal(assuranceLevel([{ kind: 'declared', subject: 'tool says it can write' }]), 'declared');
  // Evidence that names no subject, or that failed, is not evidence of anything: it does
  // not even establish that somebody claimed the capability.
  assert.equal(assuranceLevel([{ kind: 'mediated', subject: '' }]), null);
  assert.equal(assuranceLevel([{ kind: 'mediated', subject: 'boundary', passed: false }]), null);
  assert.equal(
    assuranceLevel([{ kind: 'declared', subject: 'claim' }, { kind: 'observed', subject: 'read-back' }]),
    'observed',
    'a read-back outranks a claim',
  );
  assert.equal(
    assuranceLevel([
      { kind: 'observed', subject: 'read-back' },
      { kind: 'externally-enforced', subject: 'unique constraint' },
    ]),
    'externally-enforced',
    'a backend invariant outranks an observation',
  );
  assert.deepEqual(ASSURANCE_LEVELS, ['declared', 'observed', 'mediated', 'externally-enforced']);
});

test('the model opens no socket and reads no credential', async () => {
  const source = await readFile(new URL('../packages/bench/src/work-probes.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:net|node:http|node:https|fetch\(|process\.env/);
  assert.equal(mediate({ op: 'update', actor: 'agent', target: OBJECT, revision: 3 }, world()).verdict, 'allowed');
});
