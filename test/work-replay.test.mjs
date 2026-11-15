// Plan 0004 W45: counterfactual replay and metamorphic checks.
//
// What the suite pins: a trace with no observation is not replayable; a rename or reorder that
// touches nothing semantic holds while a semantic change violates; a unit conversion is checked
// against the value it expresses; two channels must agree; repetition is only a relation where the
// contract promises it; a date-governed difference is allowed only in the fields the date governs;
// an undeclared relation is reported rather than applied; and an offline replay is never a live
// acceptance run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  RELATIONS,
  channelEquivalent,
  dateDivergence,
  idempotent,
  metamorphic,
  offline,
  renameInvariant,
  replayable,
  unitPreserving,
} from '../src/bench/replay.mjs';

const observation = (over = {}) => ({ fields: { rate: 0.19, name: 'discount', ...over } });

test('the declared relations and the offline scope are named', () => {
  assert.deepEqual(RELATIONS, ['rename-invariance', 'unit-preserving', 'read-channel-equivalence', 'idempotent-repetition', 'effective-date-divergence']);
  const report = offline();
  assert.equal(report.measures, 'logic-robustness');
  assert.equal(report.liveAcceptance, false);
  assert.match(report.reason, /says nothing about a live target/);
});

test('a trace with no observation or no events is not replayable', () => {
  const result = replayable({ intent: { digest: 'sha256-intent' }, observations: [], events: [] });
  assert.equal(result.replayable, false);
  assert.deepEqual(result.missing, ['at least one observation', 'the event sequence']);
  assert.match(result.reason, /not replayable/);

  const ok = replayable({ intent: { digest: 'sha256-intent' }, observations: [observation()], events: [{ id: 'e1' }] });
  assert.equal(ok.replayable, true);
  assert.equal(ok.reason, null);
});

test('a rename or reorder holds, a semantic change does not', () => {
  assert.equal(renameInvariant({ before: observation(), after: observation() }).holds, true);
  const changed = renameInvariant({ before: observation(), after: observation({ rate: 0.2 }) });
  assert.equal(changed.holds, false);
  assert.match(changed.reason, /not a rename or a reorder/);
  assert.equal(renameInvariant({ before: observation() }).holds, false);
});

test('a unit conversion is checked against the value it expresses', () => {
  const converted = unitPreserving({
    before: { fields: { rate: 0.19 } },
    after: { fields: { rate: 19 } },
    field: 'rate',
    convert: (value) => value / 100,
  });
  assert.equal(converted.holds, true);

  const wrong = unitPreserving({ before: { fields: { rate: 0.19 } }, after: { fields: { rate: 20 } }, field: 'rate', convert: (value) => value / 100 });
  assert.equal(wrong.holds, false);
  assert.equal(unitPreserving({ before: {}, after: {} }).holds, false);
});

test('two channels that disagree are not an answer', () => {
  assert.equal(channelEquivalent({ answers: [{ rate: 0.19 }, { rate: 0.19 }] }).holds, true);
  const disagree = channelEquivalent({ answers: [{ rate: 0.19 }, { rate: 0.2 }] });
  assert.equal(disagree.holds, false);
  assert.match(disagree.reason, /neither can be treated as the answer/);
  assert.equal(channelEquivalent({ answers: [{ rate: 0.19 }] }).holds, false);
});

test('the before and after observations are the two channel answers (A28)', () => {
  assert.equal(metamorphic({ before: observation(), after: observation(), relations: ['read-channel-equivalence'] }).holds, true);

  const different = metamorphic({ before: observation(), after: observation({ rate: 0.2 }), relations: ['read-channel-equivalence'] });
  assert.equal(different.holds, false);

  const one = metamorphic({ before: observation(), relations: ['read-channel-equivalence'] });
  assert.equal(one.holds, false);

  const explicit = metamorphic({
    before: observation(),
    after: observation({ rate: 0.3 }),
    relations: ['read-channel-equivalence'],
    options: { 'read-channel-equivalence': { answers: [{ rate: 0.19 }, { rate: 0.19 }] } },
  });
  assert.equal(explicit.holds, true);
});

test('repetition is only a relation where the contract promises it', () => {
  assert.equal(idempotent({ once: ['a'], repeated: ['a'] }).holds, true);
  const changed = idempotent({ once: ['a'], repeated: ['a', 'a'] });
  assert.equal(changed.holds, false);
  assert.match(changed.reason, /does not promise idempotence/);
});

test('a date-governed difference is allowed only where the date governs', () => {
  const allowed = dateDivergence({
    before: { effectiveDate: '2024-01-01', fields: { rate: 0.19 } },
    after: { effectiveDate: '2025-01-01', fields: { rate: 0.2 } },
    allowedFields: ['rate'],
  });
  assert.equal(allowed.holds, true);

  const unexpected = dateDivergence({
    before: { effectiveDate: '2024-01-01', fields: { rate: 0.19, audience: 'staff' } },
    after: { effectiveDate: '2025-01-01', fields: { rate: 0.2, audience: 'everyone' } },
    allowedFields: ['rate'],
  });
  assert.equal(unexpected.holds, false);
  assert.match(unexpected.reason, /audience changed but is not governed/);

  assert.equal(dateDivergence({ before: { effectiveDate: '2024-01-01', fields: {} }, after: { effectiveDate: '2024-01-01', fields: {} } }).holds, false);
});

test('an undeclared relation is reported, not applied', () => {
  const result = metamorphic({ before: observation(), after: observation(), relations: ['rename-invariance', 'model-agreement'] });
  assert.equal(result.holds, false);
  assert.deepEqual(result.violations, [{ relation: 'model-agreement', reason: 'model-agreement is not a declared relation' }]);
  assert.equal(result.results.length, 2);

  const clean = metamorphic({ before: observation(), after: observation(), relations: ['rename-invariance'] });
  assert.equal(clean.holds, true);
  assert.deepEqual(clean.violations, []);
});

test('the replay is deterministic and reads nothing', async () => {
  assert.deepEqual(metamorphic({ before: observation(), after: observation(), relations: ['rename-invariance'] }), metamorphic({ before: observation(), after: observation(), relations: ['rename-invariance'] }));
  const source = await readFile(new URL('../src/bench/replay.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
