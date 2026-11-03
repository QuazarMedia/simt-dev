// Plan 0004 W49: generic knowledge-repository pilot.
//
// A synthetic knowledge repository, run through the retrieval, conflict and document modules this
// plan built. Nothing here reaches the network or a live document store: the fixture is the whole
// world, which is what makes the pilot repeatable and what keeps its live half unclaimed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { findConflicts } from '../src/knowledge/conflicts.mjs';
import { rank } from '../src/knowledge/rank.mjs';
import { selectRubrics } from '../src/verify/documents.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/pilot-knowledge.json', import.meta.url), 'utf8'));

test('lookup keeps the unit that applies and excludes the one that does not', () => {
  const result = rank(fixture.units, { query: fixture.question.query, scope: fixture.question.scope, limit: 5 });
  const ids = result.ranked.map((hit) => hit.id);
  assert.ok(ids.includes('rates-de'), 'the unit that applies is missing from the answer');
  assert.equal(ids.includes('rates-fr'), false, 'a unit scoped to another jurisdiction was ranked');
  assert.equal(result.excluded.some((entry) => entry.id === 'rates-fr'), true);
});

test('a unit with no declared scope is reported beside the answer, not dropped', () => {
  const result = rank(fixture.units, { query: fixture.question.query, scope: fixture.question.scope, limit: 5 });
  assert.equal(result.unknownScope.some((entry) => entry.id === 'rates-unscoped'), true);
  assert.equal(result.ranked.some((hit) => hit.id === 'rates-unscoped'), false);
});

test('two sources that disagree are reported as a finding, not averaged', () => {
  const report = findConflicts(fixture.claims);
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.subject, 'de.vat');
  assert.equal(finding.predicate, 'standard-rate');
  assert.deepEqual(finding.claims, ['de-19', 'de-21']);
  assert.notEqual(finding.verdict, 'consistent', 'two different rates were reported as consistent');
});

test('the document matrix routes a page to its rubrics and honours an exclusion', () => {
  const selected = selectRubrics({ document: 'docs/rates/de.md', matrix: fixture.matrix, rubrics: fixture.rubrics });
  assert.equal(selected.unmapped, false);
  const mappingName = typeof selected.mapping === 'string' ? selected.mapping : selected.mapping?.id ?? null;
  assert.equal(mappingName, 'published-rates');
  assert.deepEqual(selected.rubrics, ['rates']);
  assert.equal(selected.excluded.some((entry) => entry.rubric === 'legacy'), true);
});

test('a page with no mapping is reported as unmapped, not silently unreviewed', () => {
  const result = selectRubrics({ document: 'docs/other/notes.md', matrix: fixture.matrix, rubrics: fixture.rubrics });
  assert.equal(result.unmapped, true);
  assert.equal(result.reason, 'no-mapping');
  assert.deepEqual(result.rubrics, []);
});

test('the pilot is deterministic and reads no network', async () => {
  const once = rank(fixture.units, { query: fixture.question.query, scope: fixture.question.scope, limit: 5 });
  const twice = rank(fixture.units, { query: fixture.question.query, scope: fixture.question.scope, limit: 5 });
  assert.deepEqual(once.ranked, twice.ranked);
  for (const file of ['src/knowledge/rank.mjs', 'src/knowledge/conflicts.mjs', 'src/verify/documents.mjs']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:net|node:http|fetch\(/, `${file} opens a socket`);
  }
});
