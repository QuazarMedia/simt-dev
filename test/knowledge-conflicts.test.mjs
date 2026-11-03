// Plan 0004 W16: contradictions among declared claims, without claiming fact checking.
//
// The corpus below is labelled by hand, one expected verdict per pair, and every pair is
// asserted. The interesting cases are the ones that must *not* be called contradictions: a
// different scope, a different period, a different unit, and a pair one of whose scope or
// dates is unstated. The last group is the anti-certification test: a clean run reports
// `certifies: false` and `not-installed` for the prose detector, so "no findings" cannot be
// read as "the documents agree".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CONFLICT_VERDICTS, findConflicts } from '../src/knowledge/conflicts.mjs';

const rate = (id, value, input = {}) => ({
  id,
  subject: 'de.vat',
  predicate: 'standard-rate',
  type: 'number',
  value,
  unit: '%',
  applicability: {
    validFrom: '2024-01-01',
    validTo: null,
    recordedFrom: '2024-01-01',
    scope: { jurisdiction: 'DE' },
    ...input,
  },
});

const verdictFor = (left, right, options = {}) => {
  const report = findConflicts([left, right], options);
  assert.equal(report.pairs, 1, JSON.stringify(report.findings));
  return report.findings[0].verdict;
};

const CORPUS = [
  { name: 'identical value in force for one scope', left: rate('a', 19), right: rate('b', 19), expect: 'same' },
  { name: 'different value, same scope and period', left: rate('a', 19), right: rate('b', 21), expect: 'contradiction' },
  {
    name: 'different value, successive periods',
    left: rate('a', 19),
    right: rate('b', 21, { validFrom: '2023-01-01', validTo: '2024-01-01' }),
    expect: 'different-period',
  },
  {
    name: 'different value, different jurisdictions',
    left: rate('a', 19),
    right: rate('b', 21, { scope: { jurisdiction: 'FR' } }),
    expect: 'different-scope',
  },
  { name: 'a ratio and a percentage', left: rate('a', 19), right: { ...rate('b', 0.19), unit: null }, expect: 'different-unit' },
  { name: 'a number and the string that spells it', left: rate('a', 19), right: { ...rate('b', 19), type: 'string', value: '19' }, expect: 'incomparable' },
  {
    name: 'different value, one scope dimension unstated',
    left: rate('a', 19),
    right: rate('b', 21, { scope: {} }),
    expect: 'indeterminate',
  },
  {
    name: 'different value, no effective start',
    left: rate('a', 19),
    right: { ...rate('b', 21), applicability: { recordedFrom: '2024-01-01', scope: { jurisdiction: 'DE' } } },
    expect: 'indeterminate',
  },
];

test('the labelled corpus gets exactly its expected verdict, pair by pair', () => {
  for (const entry of CORPUS) {
    assert.equal(verdictFor(entry.left, entry.right), entry.expect, entry.name);
  }
  assert.deepEqual(CONFLICT_VERDICTS, [
    'same',
    'contradiction',
    'different-scope',
    'different-period',
    'different-unit',
    'incomparable',
    'indeterminate',
  ]);
});

test('a declared tolerance turns a near value into agreement, and the default is zero', () => {
  const tolerances = [{ subject: 'de.vat', predicate: 'standard-rate', absolute: 0.5 }];
  assert.equal(verdictFor(rate('a', 19), rate('b', 19.4), { tolerances }), 'same');
  assert.equal(verdictFor(rate('a', 19), rate('b', 19.4)), 'contradiction');
  assert.equal(verdictFor(rate('a', 19), rate('b', 20), { tolerances }), 'contradiction', 'the declared tolerance is finite');
});

test('a contradiction leaves an owner, its affected outputs and a stated obligation', () => {
  const bare = findConflicts([rate('a', 19), rate('b', 21)]).findings[0];
  assert.equal(bare.verdict, 'contradiction');
  assert.deepEqual(bare.claims, ['a', 'b']);
  assert.deepEqual(bare.obligations, ['resolve:value', 'owner:assign', 'outputs:identify']);
  assert.equal(bare.owner, null);
  assert.deepEqual(bare.outputs, []);

  const declared = findConflicts([rate('a', 19), rate('b', 21)], {
    policies: [{ subject: 'de.vat', predicate: 'standard-rate', owner: 'knowledge-lead', outputs: ['Germany/rates.md'], decisionBy: '2024-06-01' }],
  }).findings[0];
  assert.equal(declared.owner, 'knowledge-lead');
  assert.deepEqual(declared.outputs, ['Germany/rates.md']);
  assert.equal(declared.decisionBy, '2024-06-01');
  assert.deepEqual(declared.obligations, ['resolve:value'], 'a declared owner and outputs leave only the decision');

  const scope = findConflicts([rate('a', 19), rate('b', 21, { scope: {} })]).findings[0];
  assert.equal(scope.verdict, 'indeterminate');
  assert.ok(scope.obligations.includes('scope:establish'));

  const dates = findConflicts([rate('a', 19), { ...rate('b', 21), applicability: { recordedFrom: '2024-01-01', scope: { jurisdiction: 'DE' } } }]).findings[0];
  assert.ok(dates.obligations.includes('date:establish'));
});

test('three claims about one question are three pairs, and separate questions never meet', () => {
  const report = findConflicts([
    rate('a', 19),
    rate('b', 21),
    rate('c', 19),
    { ...rate('d', 7), predicate: 'reduced-rate' },
  ]);
  assert.deepEqual(report.groups, ['de.vat|standard-rate', 'de.vat|reduced-rate']);
  assert.equal(report.pairs, 3, 'a group of three is three pairs, and the other question is its own group');
  assert.equal(report.verdicts.contradiction, 2);
  assert.equal(report.verdicts.same, 1);
  assert.equal(report.conflicts, 2);
});

test('a higher style or confidence score cannot convert a contradiction into agreement', () => {
  const confident = findConflicts([
    { ...rate('a', 19), style: 0.99, confidence: 1 },
    { ...rate('b', 21), style: 0.1, confidence: 0.2 },
  ]).findings[0];
  assert.equal(confident.verdict, 'contradiction', 'a style score is not evidence about a value');
  assert.equal(confident.obligations.includes('resolve:value'), true);
});

test('a clean run certifies nothing, and the prose detector is reported as absent', () => {
  const report = findConflicts([rate('a', 19), rate('b', 19)]);
  assert.equal(report.conflicts, 0);
  assert.equal(report.certifies, false, 'a machine finding set was promoted into a statement about the documents');
  assert.deepEqual(report.prose, { detector: 'natural-language', status: 'not-installed', assessed: 0 });
  assert.deepEqual(report.skipped, []);
});

test('a claim without an identity is reported as skipped, never compared', () => {
  const report = findConflicts([{ id: 'broken', subject: 'de.vat', value: 19 }, rate('a', 19)]);
  assert.deepEqual(report.skipped, [{ id: 'broken', reason: 'a claim needs a subject, a predicate, a type and a value to be compared' }]);
  assert.equal(report.pairs, 0);
});

test('the same claims give the same findings twice, and the module reads nothing', async () => {
  const claims = [rate('a', 19), rate('b', 21), rate('c', 19)];
  assert.deepEqual(findConflicts(claims), findConflicts(structuredClone(claims)));
  const source = await readFile(new URL('../src/knowledge/conflicts.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
