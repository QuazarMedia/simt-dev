// Plan 0004 W20: proof-bearing task packets.
//
// A packet is not a summary and its byte count is not its quality. What this suite pins is
// that the bytes are spent on obligations: mandatory text is never traded away, a unit with no
// citation is not evidence, a redundant unit is not selected however authoritative it is, and
// an infeasible ceiling produces `complete: false` rather than a packet that looks finished.
// The last test is the one a diff depends on: a time-varying observation must not move the
// stable bytes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { PROMPT_CAP_BYTES } from '../src/brief/packet.mjs';
import { PROOF_SCHEMA_VERSION, buildProofPacket } from '../src/brief/proof.mjs';

const unit = (id, text, obligations, over = {}) => ({
  id,
  text,
  obligations,
  authority: 5,
  revision: { ref: `staged:${id}`, digest: `sha256-${id}` },
  anchor: { path: `docs/${id}.md`, startLine: 1, endLine: 8 },
  ...over,
});

function corpus() {
  return [
    unit('safety', 'never force-push; the branch is shared', ['safety'], { mandatory: true }),
    unit('task', 'task: publish the German standard rate for Q4', ['task']),
    unit('evidence', 'the bulletin states 19% for the period', ['rate']),
    unit('command', 'node --test test/rates.test.mjs', ['verify']),
    unit('procedure', 'recipe: read the bulletin, then write the rate', ['rate', 'procedure']),
    unit('next', 'verify by re-reading the published page', ['verify']),
  ];
}

const required = ['safety', 'task', 'rate', 'verify'];

test('under a feasible ceiling the packet keeps every mandatory field and cites each source', () => {
  assert.equal(PROOF_SCHEMA_VERSION, 1);
  const report = buildProofPacket(corpus(), { budget: 2048, required });
  assert.equal(report.complete, true, JSON.stringify(report.reasons));
  assert.equal(report.overBudget, false);
  assert.ok(report.selected.includes('safety'));
  assert.ok(report.selected.includes('task'));
  assert.deepEqual(report.omittedObligations, []);
  assert.equal(report.coverage.fraction, 1);

  assert.equal(report.citations.length, report.selected.length);
  for (const citation of report.citations) {
    assert.match(citation.ref, /^staged:/);
    assert.match(citation.digest, /^sha256-/);
    assert.ok(citation.anchor.path.length > 0);
  }
  for (const id of report.selected) {
    assert.ok(report.stable.text.includes(`@ sha256-${id}`), `${id} was selected without its revision in the text`);
  }
});

test('the mandatory floor is never traded, and a ceiling it cannot fit says so', () => {
  const units = [unit('safety', 'x'.repeat(3000), ['safety'], { mandatory: true }), unit('evidence', 'the rate is 19%', ['rate'])];
  const report = buildProofPacket(units, { budget: 2048, required: ['safety', 'rate'] });
  assert.equal(report.overBudget, true);
  assert.equal(report.complete, false, 'an over-budget packet claimed completeness');
  assert.ok(report.stable.text.includes('x'.repeat(3000)), 'the mandatory unit was cut');
  assert.match(report.reasons.join(' '), /mandatory units alone/);
  assert.deepEqual(report.omittedObligations, ['rate']);
});

test('a unit with no revision or anchor is rejected as evidence', () => {
  const uncited = { id: 'hearsay', text: 'the rate is probably 19%', obligations: ['rate'] };
  const report = buildProofPacket([uncited, unit('evidence', 'the bulletin states 19%', ['rate'])], { budget: 2048, required: ['rate'] });
  assert.deepEqual(report.rejected, [{ id: 'hearsay', reason: 'no-citation', detail: 'name the revision and the anchor a reader can check' }]);
  assert.equal(report.selected.includes('hearsay'), false);
  assert.deepEqual(report.selected, ['evidence']);

  const onlyHearsay = buildProofPacket([uncited], { budget: 2048, required: ['rate'] });
  assert.equal(onlyHearsay.complete, false);
  assert.deepEqual(onlyHearsay.omittedObligations, ['rate']);
});

test('a redundant unit is not selected, however authoritative it is', () => {
  const cheap = unit('cheap', 'the bulletin states 19%', ['rate'], { authority: 1 });
  const hub = unit('hub', `${'the bulletin states 19% '.repeat(6)}`, ['rate'], { authority: 100 });
  const report = buildProofPacket([hub, cheap], { budget: 2048, required: ['rate'] });
  assert.deepEqual(report.selected, ['cheap']);
  assert.deepEqual(report.cut, [{ id: 'hub', reason: 'redundant', detail: 'every obligation it covers is already covered' }]);
  assert.equal(report.complete, true);
});

test('selection is marginal coverage per byte, and the order is reported', () => {
  const twoFor = unit('two-for', 'y'.repeat(200), ['a', 'b']);
  const oneFor = unit('one-for', 'z'.repeat(20), ['a']);
  const report = buildProofPacket([twoFor, oneFor], { budget: 2048, required: ['a', 'b'] });
  // 'one-for' closes one obligation for 20 bytes; 'two-for' closes two for 200. Greedy takes
  // the cheaper marginal rate first, then the unit that closes what is left.
  assert.deepEqual(report.order, ['one-for', 'two-for']);
  assert.equal(report.complete, true);
  assert.equal(report.coverage.fraction, 1);
});

test('a time-varying observation lives in the suffix and leaves the stable bytes identical', () => {
  const base = corpus();
  const without = buildProofPacket(base, { budget: 2048, required });
  const withDynamic = buildProofPacket(
    [...base, unit('observed-now', 'the target answered at 12:04:11', ['rate'], { dynamic: true })],
    { budget: 2048, required },
  );
  assert.equal(withDynamic.stable.text, without.stable.text, 'a dynamic observation moved the stable bytes');
  assert.equal(withDynamic.stable.bytes, without.stable.bytes);
  assert.ok(withDynamic.dynamic.text.includes('12:04:11'));
  assert.deepEqual(withDynamic.dynamic.units, ['observed-now']);
  assert.ok(withDynamic.text.indexOf('DYNAMIC') > withDynamic.text.indexOf('verify by re-reading'));
});

test('an obligation the budget cannot reach is reported, not silently dropped', () => {
  const report = buildProofPacket(corpus(), { budget: 90, required: ['safety', 'rate'] });
  assert.equal(report.complete, false);
  assert.ok(report.overBudget || report.omittedObligations.length > 0);
  assert.ok(report.cut.length > 0);
  assert.ok(report.reasons.length > 0);
});

test('the budget is bounded by the measured cap, and the builder is deterministic', async () => {
  assert.throws(() => buildProofPacket(corpus(), { budget: PROMPT_CAP_BYTES + 1 }), /measured cap/);
  assert.throws(() => buildProofPacket(corpus(), { budget: -1 }), /non-negative/);

  const first = buildProofPacket(corpus(), { budget: 2048, required });
  const second = buildProofPacket(corpus(), { budget: 2048, required });
  assert.deepEqual(second, first);

  const source = await readFile(new URL('../src/brief/proof.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
