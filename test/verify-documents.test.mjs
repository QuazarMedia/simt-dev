// Plan 0004 W25: document validators and generation contracts.
//
// The fixtures are shaped like a knowledge repository: an ADR directory with its own rubric, a
// marketing directory that is explicitly unmapped, and a generated requirements document. What
// the suite pins is separation — a rubric selection that is exactly the most specific mapping,
// a model that is not a human reviewer, two models from one provider that are not independent,
// semantic evidence that goes stale with its rubric or prompt, a reachable government link that
// proves nothing, and a generated document checked against all four pins of its contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CHECK_KINDS,
  DOCUMENTS_SCHEMA_VERSION,
  GENERATION_SCHEMA_VERSION,
  assessClaimSupport,
  checkGeneration,
  evaluateJudges,
  invalidateSemantic,
  selectRubrics,
} from '../src/verify/documents.mjs';

const RUBRICS = ['adr', 'marketing', 'requirements', 'source-quality'];

const matrix = () => [
  { id: 'everything', match: { pattern: 'docs/**' }, rubrics: ['requirements'] },
  { id: 'adr-only', match: { pattern: 'docs/adr/*.md' }, rubrics: ['adr'], excludeRubrics: ['marketing'] },
  { id: 'marketing-unmapped', match: { pattern: 'docs/marketing/**' }, rubrics: [] },
];

const judge = (id, over = {}) => ({ id, kind: 'model-judgement', provider: 'openai', model: 'model-a', attestation: { by: 'runner', at: '2026-11-03', digest: `sha256-${id}` }, ...over });

test('the schema names three bases and the generator version', () => {
  assert.equal(DOCUMENTS_SCHEMA_VERSION, 1);
  assert.equal(GENERATION_SCHEMA_VERSION, 1);
  assert.deepEqual(CHECK_KINDS, ['deterministic', 'human-review', 'model-judgement']);
});

test('the matrix selects exactly the most specific mapping, and says what it excluded', () => {
  const adr = selectRubrics({ document: 'docs/adr/0001-decision.md', matrix: matrix(), rubrics: RUBRICS });
  assert.equal(adr.mapping, 'adr-only');
  assert.deepEqual(adr.rubrics, ['adr']);
  assert.equal(adr.unmapped, false);
  assert.deepEqual(adr.problems, []);

  const requirement = selectRubrics({ document: 'docs/requirements.md', matrix: matrix(), rubrics: RUBRICS });
  assert.equal(requirement.mapping, 'everything');
  assert.deepEqual(requirement.rubrics, ['requirements']);
});

test('an explicitly unmapped document is excluded with a reason, and no mapping is a different reason', () => {
  const unmapped = selectRubrics({ document: 'docs/marketing/launch.md', matrix: matrix(), rubrics: RUBRICS });
  assert.equal(unmapped.unmapped, true);
  assert.equal(unmapped.reason, 'explicitly-unmapped');
  assert.deepEqual(unmapped.rubrics, []);

  const unrouteable = selectRubrics({ document: 'site/index.html', matrix: matrix(), rubrics: RUBRICS });
  assert.equal(unrouteable.reason, 'no-mapping');
  assert.equal(unrouteable.mapping, null);
});

test('an excluded rubric is reported, an unknown one is an error, and an ambiguity is not resolved by guessing', () => {
  const excluded = selectRubrics({
    document: 'docs/adr/0001.md',
    matrix: [{ id: 'adr', match: { pattern: 'docs/adr/*.md' }, rubrics: ['adr', 'marketing'], excludeRubrics: ['marketing'] }],
    rubrics: RUBRICS,
  });
  assert.deepEqual(excluded.rubrics, ['adr']);
  assert.deepEqual(excluded.excluded, [{ rubric: 'marketing', reason: 'excluded-by-mapping' }]);

  const unknown = selectRubrics({ document: 'docs/a.md', matrix: [{ id: 'm', match: { pattern: 'docs/*.md' }, rubrics: ['invented'] }], rubrics: RUBRICS });
  assert.equal(unknown.problems[0].code, 'unknown-rubric');
  assert.match(unknown.problems[0].remedy, /declare invented/);

  const ambiguous = selectRubrics({
    document: 'docs/a.md',
    matrix: [
      { id: 'one', match: { pattern: 'docs/*.md' }, rubrics: ['adr'] },
      { id: 'two', match: { pattern: 'docs/*.md' }, rubrics: ['requirements'] },
    ],
    rubrics: RUBRICS,
  });
  assert.deepEqual(ambiguous.rubrics, []);
  assert.equal(ambiguous.problems[0].code, 'ambiguous-mapping');
});

test('a human requirement is not satisfied by a model, whatever the model is called', () => {
  const report = evaluateJudges({
    required: [{ id: 'human-signoff', kind: 'human-review' }],
    judges: [judge('model-a'), judge('model-b', { model: 'model-b' })],
  });
  assert.deepEqual(report.satisfied, []);
  assert.deepEqual(report.unavailable, [{ requirement: 'human-signoff', reason: 'model-judgement-is-not-human-review' }]);

  const human = evaluateJudges({
    required: [{ id: 'human-signoff', kind: 'human-review' }],
    judges: [{ id: 'reviewer-1', kind: 'human-review', reviewer: 'sam', attestation: { by: 'sam', at: '2026-11-03', digest: 'sha256-h1' } }],
  });
  assert.deepEqual(human.satisfied.map((entry) => entry.requirement), ['human-signoff']);
});

test('two models from one provider are not independent, and an absent judge is unavailable', () => {
  const sameProvider = evaluateJudges({
    required: [{ id: 'second-opinion', kind: 'model-judgement', needsIndependence: true }],
    judges: [judge('a', { model: 'gpt-x' }), judge('b', { model: 'gpt-y' })],
  });
  assert.deepEqual(sameProvider.unavailable, [{ requirement: 'second-opinion', reason: 'insufficient-independent-judges' }]);
  assert.equal(sameProvider.satisfied.length, 0);

  const crossProvider = evaluateJudges({
    required: [{ id: 'second-opinion', kind: 'model-judgement', needsIndependence: true }],
    judges: [judge('a', { provider: 'openai' }), judge('b', { provider: 'anthropic', model: 'claude' })],
  });
  assert.equal(crossProvider.satisfied.length, 1);
  assert.ok(crossProvider.satisfied[0].pairs.some((pair) => pair.independent));

  const absent = evaluateJudges({ required: [{ id: 'unrun', kind: 'human-review' }], judges: [] });
  assert.deepEqual(absent.unavailable, [{ requirement: 'unrun', reason: 'no-judge' }]);

  const unattested = evaluateJudges({ required: [{ id: 'unrun', kind: 'human-review' }], judges: [{ id: 'h', kind: 'human-review', reviewer: 'sam' }] });
  assert.deepEqual(unattested.unavailable, [{ requirement: 'unrun', reason: 'unattested-judge' }]);
});

test('a rubric, prompt or input change makes semantic evidence stale, not merely older', () => {
  const evidence = [
    { id: 'model-1', basis: 'model', rubricDigest: 'r1', promptDigest: 'p1', inputDigest: 'i1' },
    { id: 'review-1', basis: 'human', rubricDigest: 'r1', promptDigest: 'p1', inputDigest: 'i1' },
    { id: 'format-1', basis: 'deterministic', rubricDigest: 'r1', promptDigest: null, inputDigest: 'i1' },
  ];
  const same = invalidateSemantic(evidence, { rubricDigest: 'r1', promptDigest: 'p1', inputDigest: 'i1' });
  assert.deepEqual(same.map((entry) => entry.stale), [false, false, false]);

  const rubricMoved = invalidateSemantic(evidence, { rubricDigest: 'r2', promptDigest: 'p1', inputDigest: 'i1' });
  assert.deepEqual(rubricMoved.models ?? rubricMoved.map((entry) => entry.reason), ['rubric-changed', 'rubric-changed', 'rubric-changed']);

  const promptMoved = invalidateSemantic(evidence, { rubricDigest: 'r1', promptDigest: 'p2', inputDigest: 'i1' });
  assert.deepEqual(
    promptMoved.map((entry) => [entry.id, entry.stale, entry.reason]),
    [
      ['format-1', false, null],
      ['model-1', true, 'prompt-changed'],
      ['review-1', true, 'prompt-changed'],
    ],
  );

  const inputMoved = invalidateSemantic(evidence, { rubricDigest: 'r1', promptDigest: 'p1', inputDigest: 'i2' });
  assert.equal(inputMoved.find((entry) => entry.id === 'model-1').reason, 'input-changed');
});

test('a reachable link on an authoritative domain still does not prove a claim', () => {
  const unsupported = assessClaimSupport({
    claim: { id: 'rate', statement: 'the standard rate is 19%', value: 19 },
    sources: [{ id: 'gov', url: 'https://example.gov/rates', reachable: true, authoritative: true }],
  });
  assert.equal(unsupported.supported, false);
  assert.deepEqual(unsupported.sources, [{ id: 'gov', used: false, reason: 'no-excerpt' }]);
  assert.ok(unsupported.reasons.includes('a reachable link is not evidence of the statement'));
  assert.ok(unsupported.reasons.includes('an authoritative domain names a publisher, not a statement'));

  const supported = assessClaimSupport({
    claim: { id: 'rate', statement: 'the standard rate is 19%', value: 19 },
    sources: [{ id: 'gov', url: 'https://example.gov/rates', reachable: true, authoritative: true, quote: 'From 1 January the standard rate is 19%.' }],
  });
  assert.equal(supported.supported, true);

  const wrongQuote = assessClaimSupport({
    claim: { id: 'rate', statement: 'the standard rate is 19%', value: 19 },
    sources: [{ id: 'gov', quote: 'The reduced rate is 7%.' }],
  });
  assert.equal(wrongQuote.supported, false);
  assert.deepEqual(wrongQuote.sources, [{ id: 'gov', used: false, reason: 'quote-does-not-state-claim' }]);
});

test('a generated document is checked against all four pins of its contract', () => {
  const contract = {
    template: { id: 'requirements-v3', digest: 'sha256-template' },
    sections: ['Summary', 'Decision'],
    sourceScope: ['docs/**'],
    representations: ['md'],
  };
  const output = {
    template: { id: 'requirements-v3', digest: 'sha256-template' },
    sections: [{ heading: 'Summary', body: 'x' }, { heading: 'Decision', body: 'y' }],
    sources: ['docs/adr/0001.md'],
    representation: 'md',
  };
  assert.deepEqual(checkGeneration(output, contract), { version: GENERATION_SCHEMA_VERSION, ok: true, problems: [] });

  const broken = checkGeneration(
    {
      template: { id: 'requirements-v3', digest: 'sha256-other' },
      sections: [{ heading: 'Summary' }],
      sources: ['src/index/overlay.mjs'],
      representation: 'html',
    },
    contract,
  );
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.problems.map((entry) => entry.code).sort(), ['missing-section', 'representation', 'source-out-of-scope', 'template-drift']);
  for (const entry of broken.problems) assert.ok(entry.remedy.length > 10, `${entry.code} has no actionable remedy`);
});

test('everything is deterministic and the module reads nothing', async () => {
  const once = selectRubrics({ document: 'docs/adr/0001.md', matrix: matrix(), rubrics: RUBRICS });
  const twice = selectRubrics({ document: 'docs/adr/0001.md', matrix: matrix(), rubrics: RUBRICS });
  assert.deepEqual(once, twice);

  const source = await readFile(new URL('../src/verify/documents.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
