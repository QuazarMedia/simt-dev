import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildProofPacket } from '../src/brief/proof.mjs';
import { rank, scoreFrom } from '../src/knowledge/rank.mjs';

const DE = { jurisdiction: 'DE' };

test('v3 knowledge rank uses SDM + QPP fusion to prefer contiguous multi-clause phrases and exact citations with zero scope leakage', () => {
  const units = [
    {
      id: 'scattered',
      path: 'docs/scattered.md',
      scope: DE,
      authority: 5,
      evidence: 2,
      headings: ['Overview'],
      text: `statutory ${'filler '.repeat(14)}recovery ${'padding '.repeat(12)}clawback`,
    },
    {
      id: 'exact-phrase',
      path: 'docs/exact.md',
      scope: DE,
      authority: 5,
      evidence: 2,
      headings: ['Statutory clawback recovery'],
      text: 'Statutory clawback recovery applies within 30 days of notice.',
    },
    {
      id: 'claim-match',
      path: 'docs/claim.md',
      scope: DE,
      authority: 5,
      evidence: 2,
      claims: [{ id: 'CLM-204', subject: 'clawback', predicate: 'window', value: '30d' }],
      text: 'Notice window rules for statutory obligations.',
    },
    {
      id: 'leaked-fr',
      path: 'docs/fr.md',
      scope: { jurisdiction: 'FR' },
      authority: 10,
      evidence: 3,
      headings: ['Statutory clawback recovery'],
      text: 'Statutory clawback recovery applies immediately.',
    },
  ];

  const phraseRes = rank(units, { query: 'statutory clawback recovery', scope: DE, sdm: true, qppFusion: true });
  assert.equal(phraseRes.ranked[0].id, 'exact-phrase');
  assert.equal(phraseRes.ranked.some((hit) => hit.id === 'leaked-fr'), false);
  assert.ok(phraseRes.qpp?.bm25f && phraseRes.qpp?.sdm);
  for (const hit of phraseRes.ranked) {
    assert.equal(hit.score, scoreFrom(hit.components));
  }

  // Exact citation/claim ID lookup via QPP-weighted exact channel
  const citationRes = rank(units, { query: 'CLM-204', scope: DE, sdm: true, qppFusion: true });
  assert.equal(citationRes.ranked[0].id, 'claim-match');
  assert.deepEqual(
    rank([...units].reverse(), { query: 'statutory clawback recovery', scope: DE, sdm: true, qppFusion: true }),
    phraseRes,
  );
});

test('v3 knowledge rank preserves 100% Unicode recall across CJK, Arabic with diacritics, Hangul, and folded Latin', () => {
  const units = [
    { id: 'ja-doc', path: 'ja/rate.md', language: 'ja', text: '標準税率の適用基準について説明します。' },
    { id: 'ar-doc', path: 'ar/tax.md', language: 'ar', text: 'مُعَدَّلُ الضَّرِيبَةِ القياسي المعتمد للفترة الحالية' },
    { id: 'ko-doc', path: 'ko/apply.md', language: 'ko', text: '신청기간 마감 안내입니다.' },
    { id: 'de-doc', path: 'de/munich.md', language: 'de', label: 'München', text: 'Frist für die Bevölkerung in München.' },
  ];

  assert.equal(rank(units, { query: '標準税率', sdm: true, qppFusion: true }).ranked[0].id, 'ja-doc');
  assert.equal(rank(units, { query: 'معدل الضريبة القياسي', sdm: true, qppFusion: true }).ranked[0].id, 'ar-doc');
  assert.equal(rank(units, { query: '신청기간', sdm: true, qppFusion: true }).ranked[0].id, 'ko-doc');
  assert.equal(rank(units, { query: 'munchen bevolkerung', sdm: true, qppFusion: true }).ranked[0].id, 'de-doc');
});

test('buildProofPacket with nash covers multiple obligations fairly within a tight budget', () => {
  const mk = (id, text, obligations, over = {}) => ({
    id,
    text,
    obligations,
    authority: 2,
    revision: { ref: `staged:${id}`, digest: `sha256-${id}` },
    anchor: { path: `docs/${id}.md`, startLine: 1, endLine: 4 },
    ...over,
  });

  // Two high-authority redundant candidates for obligation q1, plus one candidate for q2 and one for q3.
  // Under a budget that fits 3 units (~320B), Nash fairly covers q1, q2, and q3 rather than stacking q1.
  const units = [
    mk('q1-a', 'Primary policy for rate calculation', ['q1'], { authority: 9 }),
    mk('q1-b', 'Secondary policy for rate calculation', ['q1'], { authority: 8 }),
    mk('q2-a', 'Verification command for rate table', ['q2'], { authority: 3 }),
    mk('q3-a', 'Migration guide for rate rollout', ['q3'], { authority: 3 }),
  ];

  const report = buildProofPacket(units, {
    budget: 360,
    required: ['q1', 'q2', 'q3'],
    diverse: true,
    nash: true,
  });
  assert.equal(report.complete, true, JSON.stringify(report.reasons));
  assert.deepEqual(report.omittedObligations, []);
  assert.equal(report.coverage.fraction, 1);
});
