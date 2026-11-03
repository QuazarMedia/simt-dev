// Plan 0004 W17: generation lineage and a minimal, conservative regeneration proposal.
//
// The chain is the one from the claims slice - source, requirements, TDD, rendering - with
// an unrelated country beside it. A source change must select the German outputs and leave
// France alone; a template change must select every consumer of the template; an edit to a
// generated file must be a conflict rather than a replacement; and an output with no receipt
// must make `minimalSafe` false, because a minimal safe set is a claim about completeness
// and nobody recorded what this output was built from.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { digestOf } from '../src/knowledge/observations.mjs';
import {
  DERIVATION_SCHEMA_VERSION,
  TOOL_KINDS,
  derivationDigest,
  readReceipt,
  regenerationCandidates,
  toolRef,
} from '../src/knowledge/derivations.mjs';

const d = (text) => digestOf(text);

const template = (digest) => ({ kind: 'template', id: 'country-page', version: 3, digest });

const CHAIN = [
  {
    id: 'r-de-requirements',
    output: { path: 'Germany/requirements.md', digest: d('de requirements v1') },
    inputs: [{ ref: 'Germany/sources/rate-2024.md', digest: d('rate source v1') }, { ref: 'claim:de-vat', digest: d('claim v1') }],
    tools: [template(d('template v1'))],
    generator: { id: 'country-page', version: 3 },
    complete: true,
  },
  {
    id: 'r-de-tdd',
    output: { path: 'Germany/tdd/rates.md', digest: d('de tdd v1') },
    inputs: [{ ref: 'Germany/requirements.md', digest: d('de requirements v1') }],
    tools: [],
    generator: { id: 'country-page', version: 3 },
    complete: true,
  },
  {
    id: 'r-de-render',
    output: { path: 'Germany/rates.html', digest: d('de render v1') },
    inputs: [{ ref: 'Germany/tdd/rates.md', digest: d('de tdd v1') }],
    generator: { id: 'country-page', version: 3 },
    complete: true,
  },
  {
    id: 'r-fr-requirements',
    output: { path: 'France/requirements.md', digest: d('fr requirements v1') },
    inputs: [{ ref: 'France/sources/rate-2024.md', digest: d('fr source v1') }],
    tools: [template(d('template v1'))],
    generator: { id: 'country-page-localised', version: 1 },
    complete: true,
  },
];

const run = (input) => regenerationCandidates({ receipts: CHAIN, outputs: CHAIN.map((receipt) => receipt.output.path), ...input });
const candidates = (report) => report.candidates.map((entry) => entry.output);

test('a receipt is validated where it is written, and its Merkle key ignores the order', () => {
  assert.equal(DERIVATION_SCHEMA_VERSION, 1);
  assert.deepEqual(TOOL_KINDS, ['template', 'skill', 'rubric', 'generator']);
  const receipt = readReceipt(CHAIN[0]).receipt;
  assert.equal(receipt.complete, true);
  assert.equal(toolRef(receipt.tools[0]), 'template:country-page@3');

  const reordered = { ...CHAIN[0], inputs: [...CHAIN[0].inputs].reverse() };
  assert.equal(derivationDigest(readReceipt(reordered).receipt), derivationDigest(receipt), 'the same dependency set in a different order');

  assert.match(readReceipt({ id: 'x', output: { path: 'a.md', digest: 'md5' } }).problems.join('\n'), /output must be \{path, digest\}/);
  assert.match(readReceipt({ id: 'x', output: { path: 'a.md', digest: d('a') }, inputs: [{ ref: 'r' }] }).problems.join('\n'), /inputs must be a list/);
  assert.match(readReceipt({ id: 'x', output: { path: 'a.md', digest: d('a') }, tools: [{ kind: 'model', id: 'm', version: 1, digest: d('m') }] }).problems.join('\n'), /kind one of template, skill, rubric, generator/);
  assert.equal(readReceipt({ id: 'x', output: { path: 'a.md', digest: d('a') } }).receipt.complete, false, 'an unstated dependency set is incomplete');
});

test('a source change selects its dependents and leaves the unrelated country alone', () => {
  const report = run({ changes: [{ ref: 'Germany/sources/rate-2024.md', digest: d('rate source v2') }] });
  assert.deepEqual(candidates(report), ['Germany/rates.html', 'Germany/requirements.md', 'Germany/tdd/rates.md'], 'the change propagates down the chain');
  assert.deepEqual(report.reusable.map((entry) => entry.output), ['France/requirements.md']);
  assert.equal(report.minimalSafe, true);
  assert.equal(report.proposal, 'regenerate');
  assert.equal(report.applies, false, 'a proposal is not an overwrite');

  const reasons = report.candidates.find((entry) => entry.output === 'Germany/tdd/rates.md').reasons;
  assert.match(reasons.join(' '), /input Germany\/requirements\.md changed/);
});

test('a template change invalidates every consumer of the template', () => {
  const report = run({ changes: [{ ref: 'template:country-page@3', digest: d('template v2') }] });
  assert.deepEqual(candidates(report), ['France/requirements.md', 'Germany/rates.html', 'Germany/requirements.md', 'Germany/tdd/rates.md']);
  assert.deepEqual(report.reusable, [], 'the children do not use the template, but they derive from an output it makes stale');
});

test('an unchanged digest is not a change, and a matching set stays reusable', () => {
  const report = run({ changes: [{ ref: 'Germany/sources/rate-2024.md', digest: d('rate source v1') }] });
  assert.deepEqual(report.candidates, []);
  assert.equal(report.reusable.length, CHAIN.length);
  assert.equal(report.proposal, 'none');
  assert.equal(report.minimalSafe, true);
});

test('an edit to a generated output is a conflict, not a replacement', () => {
  const report = run({ observed: [{ path: 'Germany/requirements.md', digest: d('hand edit') }] });
  const conflict = report.conflicts.find((entry) => entry.output === 'Germany/requirements.md');
  assert.ok(conflict, JSON.stringify(report.conflicts));
  assert.match(conflict.reasons.join(' '), /edited after it was generated/);
  assert.equal(candidates(report).includes('Germany/requirements.md'), false, 'a conflict was proposed for regeneration');
  assert.equal(report.applies, false);
});

test('two receipts for one output are a conflict when they describe different derivations', () => {
  const rival = {
    ...CHAIN[0],
    id: 'r-de-requirements-other',
    inputs: [{ ref: 'Germany/sources/other.md', digest: d('other source') }],
    output: { path: 'Germany/requirements.md', digest: d('a different rendering') },
  };
  const report = regenerationCandidates({ receipts: [...CHAIN, rival], outputs: ['Germany/requirements.md'] });
  const conflict = report.conflicts.find((entry) => entry.output === 'Germany/requirements.md');
  assert.ok(conflict, JSON.stringify(report.conflicts));
  assert.deepEqual(conflict.receipts, ['r-de-requirements', 'r-de-requirements-other']);
  assert.match(conflict.reasons.join(' '), /different derivations/);
});

test('missing lineage is unknown and the safe set is not minimal', () => {
  const report = regenerationCandidates({ receipts: CHAIN, outputs: [...CHAIN.map((receipt) => receipt.output.path), 'Italy/requirements.md'] });
  assert.deepEqual(report.unknown, [{ output: 'Italy/requirements.md', reason: 'no generation receipt, so its lineage is unknown' }]);
  assert.equal(report.minimalSafe, false, 'a minimal safe set was claimed with an output nobody recorded');
});

test('an incomplete dependency set expands to every output of its generator', () => {
  const receipts = CHAIN.map((receipt) => ({ ...receipt, complete: receipt.id === 'r-de-requirements' ? false : receipt.complete }));
  const report = regenerationCandidates({ receipts, outputs: receipts.map((receipt) => receipt.output.path) });
  assert.deepEqual(candidates(report), [
    'Germany/rates.html',
    'Germany/requirements.md',
    'Germany/tdd/rates.md',
  ], 'the incomplete generator pulls in its other outputs');
  assert.deepEqual(report.reusable.map((entry) => entry.output), ['France/requirements.md'], 'another generator is unaffected');
  assert.equal(report.minimalSafe, false);
  assert.match(report.candidates[0].reasons.join(' '), /dependency set is incomplete/);
});

test('a malformed receipt is reported and takes no part in the answer', () => {
  const report = regenerationCandidates({ receipts: [{ id: 'broken' }], outputs: [] });
  assert.equal(report.problems.length, 1);
  assert.deepEqual(report.candidates, []);
  assert.equal(report.minimalSafe, true);
});

test('the same receipts give the same proposal twice, and nothing is written', async () => {
  const input = { receipts: CHAIN, outputs: CHAIN.map((receipt) => receipt.output.path), changes: [{ ref: 'Germany/sources/rate-2024.md', digest: d('rate source v2') }] };
  assert.deepEqual(regenerationCandidates(input), regenerationCandidates(structuredClone(input)));
  const source = await readFile(new URL('../src/knowledge/derivations.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|writeFile|node:net|fetch\(|process\.env|Date\./);
});
