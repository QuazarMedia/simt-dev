// Plan 0004 W14: bitemporal validity and a declared authority order.
//
// The failure pinned here is the one that is invisible in review: a correction published
// today silently changing what a document said about 2021. Effective time and recording time
// are separate, so the same question asked at two `knownAt` values gives two answers that
// are both right. The second failure is recency as authority - two claims in force with
// nothing ranking them are a conflict, and a claim that cannot be placed makes the answer
// unknown rather than absent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { APPLICABILITY_RESULTS, SCOPE_FIELDS, applicableClaims, readApplicability } from '../src/knowledge/validity.mjs';

const validity = (input) => {
  const read = readApplicability(input);
  assert.deepEqual(read.problems, undefined, `fixture applicability is invalid: ${JSON.stringify(read.problems)}`);
  return read.applicability;
};

const makeClaim = (id, value, input) => ({
  id,
  subject: 'de.vat',
  predicate: 'standard-rate',
  type: 'number',
  value,
  unit: '%',
  applicability: validity({ scope: { jurisdiction: 'DE' }, ...input }),
});

const TIMELINE = [
  makeClaim('a-2010', 16, { validFrom: '2010-01-01', validTo: '2020-07-01', recordedFrom: '2010-01-01' }),
  makeClaim('b-2020', 19, { validFrom: '2020-07-01', validTo: '2024-01-01', recordedFrom: '2020-07-01' }),
  makeClaim('c-2024', 19, { validFrom: '2024-01-01', recordedFrom: '2024-01-01' }),
];

const ask = (asOf, knownAt = '2026-01-01', extra = {}) =>
  applicableClaims(TIMELINE, { subject: 'de.vat', predicate: 'standard-rate', asOf, knownAt, scope: { jurisdiction: 'DE' }, ...extra });

const only = (report) => {
  assert.equal(report.claims.length, 1, JSON.stringify(report));
  return report.claims[0];
};

test('the effective interval is half-open, and every boundary answers deterministically', () => {
  assert.equal(only(ask('2019-12-31')).value, 16);
  assert.equal(only(ask('2020-06-30')).value, 16, 'the day before the next rate took effect');
  assert.equal(only(ask('2020-07-01')).value, 19, 'validFrom is inclusive');
  assert.equal(only(ask('2023-12-31')).value, 19);
  assert.equal(only(ask('2024-01-01')).value, 19, 'validTo is exclusive and the next claim opens that day');
  assert.equal(only(ask('2030-01-01')).value, 19, 'an open-ended claim still applies ten years later');

  const before = ask('2009-12-31');
  assert.equal(before.result, 'none');
  assert.deepEqual(before.claims, []);
  assert.ok(before.excluded.every((entry) => entry.reason === 'not-yet'));
  assert.equal(before.reasons.length, 1);
});

test('a retroactive correction changes the past only once it is known', () => {
  const past = [
    makeClaim('old', 16, { validFrom: '2020-01-01', validTo: '2024-01-01', recordedFrom: '2020-01-01' }),
    makeClaim('fix', 20, { validFrom: '2022-01-01', validTo: '2024-01-01', recordedFrom: '2024-06-01', supersedes: ['old'] }),
  ];
  const query = (knownAt) => applicableClaims(past, { subject: 'de.vat', predicate: 'standard-rate', asOf: '2023-06-01', knownAt, scope: { jurisdiction: 'DE' } });

  assert.equal(only(query('2024-05-31')).value, 16, 'the correction was not known yet, so it cannot answer');
  assert.equal(only(query('2024-06-30')).value, 20, 'the correction applies retroactively once it is recorded');
  assert.deepEqual(query('2024-05-31').excluded, [{ id: 'fix', reason: 'not-known' }]);
});

test('two claims in force with nothing ranking them are a conflict, never the newest', () => {
  const overlapping = [
    makeClaim('l', 19, { validFrom: '2020-01-01', recordedFrom: '2020-01-01' }),
    makeClaim('m', 21, { validFrom: '2023-01-01', recordedFrom: '2023-01-01' }),
  ];
  const report = applicableClaims(overlapping, { subject: 'de.vat', predicate: 'standard-rate', asOf: '2024-01-01', knownAt: '2026-01-01', scope: { jurisdiction: 'DE' } });
  assert.equal(report.result, 'conflict');
  assert.deepEqual(report.claims.map((record) => record.id), ['l', 'm']);
  assert.match(report.reasons.join(' '), /conflict set, not the newest/);

  const ranked = applicableClaims(overlapping, {
    subject: 'de.vat',
    predicate: 'standard-rate',
    asOf: '2024-01-01',
    knownAt: '2026-01-01',
    scope: { jurisdiction: 'DE' },
    authority: [{ id: 'm', outranks: ['l'] }],
  });
  assert.equal(ranked.result, 'applicable');
  assert.deepEqual(ranked.claims.map((record) => record.id), ['m']);
  assert.match(ranked.reasons.join(' '), /declared order leaves one of them unranked/);

  const third = makeClaim('n', 21, { validFrom: '2023-06-01', recordedFrom: '2023-06-01' });
  const partial = applicableClaims([...overlapping, third], {
    subject: 'de.vat',
    predicate: 'standard-rate',
    asOf: '2024-01-01',
    knownAt: '2026-01-01',
    scope: { jurisdiction: 'DE' },
    authority: [{ id: 'm', outranks: ['l'] }],
  });
  assert.equal(partial.result, 'conflict', 'a partial order that ranks only one pair must not pick between the rest');
  assert.deepEqual(partial.claims.map((record) => record.id), ['m', 'n']);

  const cyclic = applicableClaims(overlapping, {
    subject: 'de.vat',
    predicate: 'standard-rate',
    asOf: '2024-01-01',
    knownAt: '2026-01-01',
    scope: { jurisdiction: 'DE' },
    authority: [
      { id: 'm', outranks: ['l'] },
      { id: 'l', outranks: ['m'] },
    ],
  });
  assert.equal(cyclic.result, 'conflict');
  assert.match(cyclic.reasons.join(' '), /cycle is not a winner/);
});

test('a claim that cannot be placed makes the answer unknown and its candidate tentative', () => {
  const incomplete = {
    id: 'no-start',
    subject: 'de.vat',
    predicate: 'standard-rate',
    type: 'number',
    value: 19,
    unit: '%',
    applicability: { recordedFrom: '2020-01-01', scope: { jurisdiction: 'DE' } },
  };
  const resolved = makeClaim('l', 19, { validFrom: '2020-01-01', recordedFrom: '2020-01-01' });

  const alone = applicableClaims([incomplete], { subject: 'de.vat', predicate: 'standard-rate', asOf: '2024-01-01', knownAt: '2026-01-01', scope: { jurisdiction: 'DE' } });
  assert.equal(alone.result, 'unknown');
  assert.deepEqual(alone.unknown, [{ id: 'no-start', reason: 'no-effective-start' }]);
  assert.deepEqual(alone.claims, []);

  const mixed = applicableClaims([incomplete, resolved], { subject: 'de.vat', predicate: 'standard-rate', asOf: '2024-01-01', knownAt: '2026-01-01', scope: { jurisdiction: 'DE' } });
  assert.equal(mixed.result, 'unknown', 'a settled-looking answer beside an unplaceable claim is not settled');
  assert.deepEqual(mixed.claims, []);
  assert.deepEqual(mixed.tentative.map((record) => record.id), ['l']);
  assert.match(mixed.reasons.join(' '), /incomplete rather than settled/);

  const absent = applicableClaims([{ id: 'bare', subject: 'de.vat', predicate: 'standard-rate' }], { subject: 'de.vat', predicate: 'standard-rate', asOf: '2024-01-01', knownAt: '2026-01-01' });
  assert.deepEqual(absent.unknown, [{ id: 'bare', reason: 'no-applicability' }]);
});

test('a required scope the claim does not state is unknown; a different value is merely inapplicable', () => {
  const unscoped = makeClaim('unscoped', 19, { validFrom: '2020-01-01', recordedFrom: '2020-01-01', scope: {} });
  const french = makeClaim('french', 20, { validFrom: '2020-01-01', recordedFrom: '2020-01-01', scope: { jurisdiction: 'FR' } });

  const missing = applicableClaims([unscoped], { subject: 'de.vat', predicate: 'standard-rate', asOf: '2024-01-01', knownAt: '2026-01-01', scope: { jurisdiction: 'DE' } });
  assert.equal(missing.result, 'unknown');
  assert.deepEqual(missing.unknown, [{ id: 'unscoped', reason: 'scope-missing:jurisdiction' }]);

  const mismatch = applicableClaims([french], { subject: 'de.vat', predicate: 'standard-rate', asOf: '2024-01-01', knownAt: '2026-01-01', scope: { jurisdiction: 'DE' } });
  assert.equal(mismatch.result, 'none');
  assert.deepEqual(mismatch.excluded, [{ id: 'french', reason: 'scope-mismatch:jurisdiction' }]);

  const unscopedQuery = applicableClaims([unscoped], { subject: 'de.vat', predicate: 'standard-rate', asOf: '2024-01-01', knownAt: '2026-01-01' });
  assert.equal(unscopedQuery.result, 'applicable', 'a scope nobody asked about is not a gap');
  assert.deepEqual(unscopedQuery.scope, {});
});

test('replaying the same snapshot gives the same answer, and the query states its own times', () => {
  const first = ask('2023-06-01', '2026-01-01', { revision: 'snapshot-7' });
  const second = ask('2023-06-01', '2026-01-01', { revision: 'snapshot-7' });
  assert.deepEqual(second, first);
  assert.equal(first.revision, 'snapshot-7');

  assert.throws(() => applicableClaims(TIMELINE, { subject: 'de.vat', predicate: 'standard-rate', knownAt: '2026-01-01' }), /asOf must be an ISO date/);
  assert.throws(() => applicableClaims(TIMELINE, { subject: 'de.vat', predicate: 'standard-rate', asOf: '2024-01-01' }), /knownAt must be an ISO date/);
  assert.throws(() => applicableClaims(TIMELINE, { asOf: '2024-01-01', knownAt: '2026-01-01' }), /needs a subject and a predicate/);
});

test('a validity record is validated where it is written', () => {
  assert.match(readApplicability({ validFrom: '2024-01-01', recordedFrom: '2024-01-01', validTo: '2023-01-01' }).problems.join('\n'), /must be after validFrom/);
  assert.match(readApplicability({ validFrom: '2024-1-1', recordedFrom: '2024-01-01' }).problems.join('\n'), /must be an ISO date/);
  assert.match(readApplicability({ validFrom: '2024-01-01', recordedFrom: '2024-01-01', scope: { country: 'DE' } }).problems.join('\n'), /scope\.country is not one of/);
  assert.match(readApplicability({ validFrom: '2024-01-01' }).problems.join('\n'), /recordedFrom must be an ISO date/);
  assert.deepEqual(SCOPE_FIELDS, ['jurisdiction', 'product', 'version', 'population']);
  assert.deepEqual(APPLICABILITY_RESULTS, ['applicable', 'conflict', 'unknown', 'none', 'empty']);
});

test('the module reads no clock of its own', async () => {
  const source = await readFile(new URL('../src/knowledge/validity.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new Date|Date\.now|process\.env|Math\.random|node:fs|fetch\(/);
});
