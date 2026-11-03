// Plan 0004 W47: value-of-information and knowledge-debt reports.
//
// What the suite pins: a stale high-impact source outranks a cosmetic orphan; the score is a sum
// of named components divided by the effort to refresh, with no invented probability; moving a
// weight explains the rank change; a confidential item is excluded from the estate aggregate; and
// a cold-start item is labelled rather than ranked as if usage had been observed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DEFAULT_WEIGHTS,
  aggregate,
  coldStart,
  debtItem,
  rank,
  score,
  weightSensitivity,
} from '../src/knowledge/debt.mjs';

const stale = () => debtItem({ id: 'stale-rates', kind: 'stale', affectedObligations: 6, criticality: 'high', queries: 4 });
const orphan = () => debtItem({ id: 'orphan', kind: 'stale', affectedObligations: 0, criticality: 'low', queries: 0 });

test('the declared weights are named and default', () => {
  assert.deepEqual(DEFAULT_WEIGHTS, { obligations: 3, criticality: 2, queries: 1, effort: 1 });
});

test('the score is a sum of named components over the effort', () => {
  const item = stale();
  const computed = score(item, DEFAULT_WEIGHTS);
  assert.deepEqual(computed.components, { obligations: 18, criticality: 8, queries: 4 });
  assert.equal(computed.total, 30);
  assert.equal(computed.effort, 1);
});

test('a stale high-impact source outranks a cosmetic orphan', () => {
  const ranked = rank([orphan(), stale()]);
  assert.deepEqual(ranked.map((entry) => entry.id), ['stale-rates', 'orphan']);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.match(ranked[0].reasons.join(' '), /6 obligation\(s\) affected/);
});

test('refresh effort reduces the rank of the same debt', () => {
  const cheap = debtItem({ id: 'cheap', affectedObligations: 4, criticality: 'high' });
  const dear = debtItem({ id: 'dear', affectedObligations: 4, criticality: 'high', effort: 8 });
  assert.deepEqual(rank([dear, cheap]).map((entry) => entry.id), ['cheap', 'dear']);
});

test('moving a weight explains which items moved and why', () => {
  const items = [stale(), debtItem({ id: 'hot', affectedObligations: 1, criticality: 'normal', queries: 10 })];
  const report = weightSensitivity(items, { field: 'queries', to: 12 });
  assert.ok(Array.isArray(report.before));
  assert.deepEqual(report.before, report.after.length === report.before.length ? report.before : []);
  assert.match(report.explanation, /changing queries/);

  const quiet = weightSensitivity(items, { field: 'queries', to: 1 });
  assert.match(quiet.explanation, /moves nothing|moves /);
  assert.throws(() => weightSensitivity(items, { field: 'queries' }), /new value/);
});

test('a confidential item never enters the estate aggregate', () => {
  const secret = debtItem({ id: 'secret', affectedObligations: 9, criticality: 'critical', confidential: true });
  const summary = aggregate([stale(), orphan(), secret]);
  assert.equal(summary.items, 2);
  assert.equal(summary.confidentialExcluded, 1);
  assert.equal(summary.totalDebt, 32);
  assert.match(summary.reason, /never in an estate aggregate/);
});

test('a cold-start item is labelled rather than assumed idle', () => {
  const result = coldStart([stale(), orphan()]);
  assert.equal(result.cold, false);
  assert.deepEqual(result.labelled, ['orphan']);
  assert.match(result.reason, /no query frequency is recorded/);

  const all = coldStart([orphan(), debtItem({ id: 'other' })]);
  assert.equal(all.cold, true);
  assert.deepEqual(all.labelled, ['orphan', 'other']);
});

test('ties break by id, so two runs agree', () => {
  const a = debtItem({ id: 'a', affectedObligations: 1 });
  const b = debtItem({ id: 'b', affectedObligations: 1 });
  assert.deepEqual(rank([b, a]).map((entry) => entry.id), ['a', 'b']);
});

test('no score invents a probability', () => {
  const ranked = rank([stale()])[0];
  assert.equal('probability' in ranked, false);
  assert.equal('likelihood' in ranked, false);
  assert.deepEqual(Object.keys(ranked.components).sort(), ['criticality', 'obligations', 'queries']);
});

test('the module is deterministic and reads nothing', async () => {
  assert.deepEqual(rank([stale(), orphan()]), rank([stale(), orphan()]));
  const source = await readFile(new URL('../src/knowledge/debt.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});

// A raw row reached `rank` with no fields filled, and its reasons read "undefined obligation(s)
// affected" — a rank nobody can explain, from the module whose stated purpose is explainability.
import { rank as rankForRawRow } from '../src/knowledge/debt.mjs';

test('a raw row is normalised so its reasons are explainable', () => {
  const ranked = rankForRawRow([{ id: 'raw-row' }]);
  assert.equal(ranked[0].affectedObligations, 0);
  assert.equal(ranked[0].criticality, 'normal');
  assert.equal(ranked[0].effort, 1);
  assert.equal(ranked[0].coldStart, true);
  assert.doesNotMatch(ranked[0].reasons.join(' '), /undefined/);
});
