// Plan 0004 W19: authority-aware hybrid ranking.
//
// The corpus here is labelled by hand: one gold unit per query, a hub that repeats the terms
// and is linked ninety times, and a copy that is derived from the gold. A lexical ranker
// cannot separate them, so the test asserts what this slice adds - that the hub is labelled
// and penalised, that a scope the question did not ask about never leaks into the answer,
// that an unplaceable unit is a separate class, and that every score recomputes from the
// parts printed beside it. Recall is reported per language and per kind, with the failing
// query named rather than averaged away.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  PENALTIES,
  RANK_SCHEMA_VERSION,
  RANK_WEIGHTS,
  evaluateRank,
  queryTerms,
  rank,
  scoreFrom,
} from '../src/knowledge/rank.mjs';

const TOPICS = [
  { kind: 'document', en: 'standard rate', de: 'regelsatz', ja: '標準税率' },
  { kind: 'source', en: 'bulletin source', de: 'amtsblatt quelle', ja: '官報 出典' },
  { kind: 'recipe', en: 'create calculation', de: 'berechnung anlegen', ja: '計算 作成' },
  { kind: 'dataset', en: 'population table', de: 'bevölkerung tabelle', ja: '人口 表' },
];
const LANGUAGES = ['en', 'de', 'ja'];
const DE = { jurisdiction: 'DE' };

function corpusUnits() {
  const units = [];
  TOPICS.forEach((topic, index) => {
    for (const language of LANGUAGES) {
      const terms = topic[language];
      const base = { kind: topic.kind, language, scope: DE, authority: 5, evidence: 3, links: 2, text: `${terms} guidance for the current period` };
      units.push({ ...base, id: `gold-${index}-${language}`, path: `${language}/${topic.kind}/gold.md` });
      units.push({ ...base, id: `hub-${index}-${language}`, path: `${language}/${topic.kind}/hub.md`, text: `${terms} ${terms} ${terms} rate rate`, links: 90, stale: true });
      units.push({ ...base, id: `copy-${index}-${language}`, path: `${language}/${topic.kind}/copy.md`, derived: true });
    }
  });
  // The same words under a scope the German questions did not ask about.
  units.push({ id: 'fr-standard', path: 'fr/document/fr.md', kind: 'document', language: 'en', scope: { jurisdiction: 'FR' }, authority: 5, evidence: 3, text: 'standard rate guidance for the current period' });
  return units;
}

const corpus = () =>
  TOPICS.flatMap((topic, index) =>
    LANGUAGES.map((language) => ({ query: topic[language], gold: [`gold-${index}-${language}`], scope: DE })),
  );

const hitFor = (report, id) => report.ranked.find((hit) => hit.id === id);

test('query terms fold once, and a CJK run becomes the characters a shorter term can match', () => {
  assert.equal(RANK_SCHEMA_VERSION, 1);
  assert.deepEqual(queryTerms('Standard Rate'), ['standard', 'rate']);
  assert.deepEqual(queryTerms('標準税率'), ['標', '準', '税', '率']);
  assert.deepEqual(queryTerms('  '), []);
});

test('the answer is filtered by permission and by scope before anything is scored', () => {
  const units = corpusUnits();
  const report = rank(units, { query: 'standard rate', scope: DE });
  assert.equal(report.ranked.some((hit) => hit.id === 'fr-standard'), false, 'a French source answered a German question');
  assert.equal(report.unknownScope.some((hit) => hit.id === 'fr-standard'), false);
  assert.deepEqual(report.excluded.find((entry) => entry.id === 'fr-standard'), { id: 'fr-standard', reason: 'scope-mismatch' });

  const restricted = [...units, { ...units[0], id: 'internal-rate', permission: 'internal' }];
  const permitted = rank(restricted, { query: 'standard rate', scope: DE, permissions: ['public'] });
  assert.equal(permitted.ranked.some((hit) => hit.id === 'internal-rate'), false);
  assert.deepEqual(permitted.excluded.find((entry) => entry.id === 'internal-rate'), { id: 'internal-rate', reason: 'permission' });
  const allowed = rank(restricted, { query: 'standard rate', scope: DE, permissions: ['internal', 'public'] });
  assert.ok(allowed.ranked.some((hit) => hit.id === 'internal-rate'), 'a held permission was still filtered');
});

test('a hub cannot win by being linked, and it says which label cost it the place', () => {
  const report = rank(corpusUnits(), { query: 'standard rate', scope: DE });
  const order = report.ranked.map((hit) => hit.id);
  const gold = order.indexOf('gold-0-en');
  const hub = order.indexOf('hub-0-en');
  const copy = order.indexOf('copy-0-en');
  assert.ok(gold >= 0, 'the labelled source was not retrieved');
  assert.ok(gold < hub, `the stale hub outranked the source: ${order.join(', ')}`);
  assert.ok(gold < copy, `the derived copy outranked its source: ${order.join(', ')}`);

  const hubHit = hitFor(report, 'hub-0-en');
  assert.ok(hubHit.labels.includes('obsolete'));
  assert.ok(hubHit.labels.includes('boilerplate-hub'));
  assert.equal(hubHit.components.penalty, PENALTIES.stale + Math.min(PENALTIES.hub, 7), 'the penalty is not the sum of the labels it reports');
  assert.ok(hitFor(report, 'copy-0-en').labels.includes('derived-copy'));
  assert.deepEqual(hitFor(report, 'gold-0-en').labels, []);
});

test('every score recomputes from the parts printed beside it', () => {
  const report = rank(corpusUnits(), { query: 'standard rate', scope: DE });
  assert.ok(report.ranked.length > 0);
  for (const hit of report.ranked) {
    assert.equal(scoreFrom(hit.components), hit.score, `${hit.id} does not recompute`);
    assert.ok(hit.components.lexical > 0 && hit.components.lexical <= 1);
    assert.ok(hit.components.authority >= 0 && hit.components.authority <= 1);
  }
  assert.equal(report.weights, RANK_WEIGHTS);
  assert.equal(report.embeddings, 'off');
});

test('a unit that cannot be placed is a separate class, not a silent drop and not a hit', () => {
  const units = [
    { id: 'unscoped', path: 'docs/rates.md', kind: 'document', language: 'en', authority: 5, text: 'standard rate guidance' },
    { id: 'scoped', path: 'docs/de/rates.md', kind: 'document', language: 'en', scope: DE, authority: 5, text: 'standard rate guidance' },
  ];
  const report = rank(units, { query: 'standard rate', scope: DE });
  assert.deepEqual(report.ranked.map((hit) => hit.id), ['scoped']);
  assert.deepEqual(report.unknownScope, [{ id: 'unscoped', path: 'docs/rates.md', class: 'unknown-scope' }]);

  const unscopedQuery = rank(units, { query: 'standard rate' });
  assert.equal(unscopedQuery.ranked.length, 2, 'a scope nobody asked about is not a gap');
  assert.deepEqual(unscopedQuery.unknownScope, []);
});

test('equal scores break on a stated order, not on input order', () => {
  const units = [
    { id: 'b', path: 'docs/b.md', kind: 'document', language: 'en', authority: 5, text: 'rate' },
    { id: 'a', path: 'docs/a.md', kind: 'document', language: 'en', authority: 5, text: 'rate' },
  ];
  assert.deepEqual(rank(units, { query: 'rate' }).ranked.map((hit) => hit.id), ['a', 'b']);
  assert.deepEqual(rank([...units].reverse(), { query: 'rate' }).ranked.map((hit) => hit.id), ['a', 'b'], 'the order depends on the input order');
});

test('a held-out corpus reaches the recall bar, per language and per kind', () => {
  const report = evaluateRank(corpusUnits(), corpus());
  assert.equal(report.queries, 12);
  assert.equal(report.gold, 12);
  assert.ok(report.recallAt10 >= 0.9, `recall is ${report.recallAt10}`);
  assert.deepEqual(report.byLanguage.map((row) => row.key), ['de', 'en', 'ja']);
  for (const row of report.byLanguage) {
    assert.equal(row.gold, 4, `${row.key} lost its denominator`);
    assert.equal(row.recall, 1);
  }
  assert.deepEqual(report.byKind.map((row) => row.key), ['dataset', 'document', 'recipe', 'source']);
  assert.deepEqual(report.failures, []);
});

test('a failing language is reported in its own stratum and does not drag the others', () => {
  const units = corpusUnits();
  const failing = [
    ...corpus(),
    { query: 'unlisted phrase', gold: ['gold-0-ja'], scope: DE },
  ];
  const report = evaluateRank(units, failing);
  assert.ok(report.recallAt10 < 1);
  const ja = report.byLanguage.find((row) => row.key === 'ja');
  const en = report.byLanguage.find((row) => row.key === 'en');
  assert.deepEqual({ gold: ja.gold, hits: ja.hits, recall: ja.recall }, { gold: 5, hits: 4, recall: 4 / 5 });
  assert.equal(en.recall, 1, 'a Japanese miss changed the English row');
  assert.deepEqual(report.failures.map((failure) => failure.missed), [['gold-0-ja']]);
  assert.equal(report.failures[0].unplaceable.length, 0);
});

test('ranking is deterministic and reads nothing', async () => {
  const first = rank(corpusUnits(), { query: 'standard rate', scope: DE });
  const second = rank(corpusUnits(), { query: 'standard rate', scope: DE });
  assert.deepEqual(second, first);
  const source = await readFile(new URL('../src/knowledge/rank.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
