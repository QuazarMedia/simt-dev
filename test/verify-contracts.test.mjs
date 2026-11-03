// Plan 0004 W24: outcome contracts and evidence states.
//
// Each test here is one way a runner's success has been read as a satisfied obligation. The
// contract names the predicate, the verifier, the assurance and the revisions; the observation
// is only a claim about what happened. What the suite pins: transport success is not a result,
// a formatter cannot settle an entailment, a mocked double cannot settle a live predicate, a
// waiver is reported and not counted, an inapplicable obligation needs its evidence, and a
// malformed contract blocks with a remedy rather than passing by omission.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CONTRACT_SCHEMA_VERSION,
  PREDICATE_KINDS,
  RESULT_STATES,
  SEVERITIES,
  VERIFICATION_ASSURANCE,
  evaluateObligation,
  evaluateObligations,
  readContract,
} from '../src/verify/contracts.mjs';

const obligation = (over = {}) => ({
  id: 'vat-published',
  subject: 'docs/de/rates.md',
  predicate: { kind: 'behaviour', statement: 'the published rate equals the bulletin for the period' },
  severity: 'mandatory',
  verifier: { kind: 'integration-test', ref: 'test/rates.test.mjs::publishes' },
  assurance: 'executed',
  ...over,
});

const observation = (over = {}) => ({
  id: 'vat-published',
  state: 'pass',
  assurance: 'executed',
  verifier: { kind: 'integration-test', ref: 'test/rates.test.mjs::publishes' },
  postcondition: 'passed',
  applies: true,
  ...over,
});

const evaluateOne = (overObligation = {}, overObservation = {}, options) =>
  evaluateObligation(obligation(overObligation), observation(overObservation), options);

test('the schema names the states and never borrows a review verdict', () => {
  assert.equal(CONTRACT_SCHEMA_VERSION, 1);
  assert.deepEqual(RESULT_STATES, ['pass', 'fail', 'unknown', 'unavailable', 'not-run', 'not-applicable', 'waived']);
  assert.deepEqual(SEVERITIES, ['mandatory', 'advisory']);
  assert.deepEqual(VERIFICATION_ASSURANCE, ['simulated', 'executed', 'live']);
  assert.deepEqual(PREDICATE_KINDS, ['behaviour', 'entailment', 'format', 'availability']);

  const report = evaluateObligations({ obligations: [obligation()] }, [observation()]);
  assert.equal(report.review, 'not-a-review-verdict');
  assert.doesNotMatch(JSON.stringify(report), /APPROVE|BLOCK/);
  assert.equal(report.rows[0].countsAsPass, true);
});

test('a successful command is not a satisfied obligation', () => {
  const unevaluated = evaluateOne({}, { postcondition: undefined });
  assert.equal(unevaluated.state, 'unknown');
  assert.equal(unevaluated.countsAsPass, false);
  assert.match(unevaluated.reasons.join(' '), /postcondition was not evaluated/);

  const httpOkButFailed = evaluateOne({}, { state: 'fail', postcondition: 'failed', transport: 'ok' });
  assert.equal(httpOkButFailed.state, 'fail');
  assert.notEqual(httpOkButFailed.state, 'pass');
  assert.match(httpOkButFailed.reasons.join(' '), /transport succeeded/);

  const satisfied = evaluateOne();
  assert.equal(satisfied.state, 'pass');
  assert.equal(satisfied.countsAsPass, true);
});

test('formatting evidence cannot settle an entailment predicate', () => {
  const result = evaluateOne(
    { predicate: { kind: 'entailment', statement: 'the requirement follows from the source' }, verifier: { kind: 'formatter', ref: 'prettier' } },
    { verifier: { kind: 'formatter', ref: 'prettier' } },
  );
  assert.equal(result.state, 'unknown');
  assert.match(result.reasons.join(' '), /cannot settle a entailment predicate/);
  assert.match(result.remedy, /entailment-check/);
});

test('a mocked double cannot settle a live predicate, however it labels itself', () => {
  const result = evaluateOne(
    { verifier: { kind: 'unit-test', ref: 'test/rates.test.mjs' }, assurance: 'live' },
    { verifier: { kind: 'unit-test', ref: 'test/rates.test.mjs' }, assurance: 'live' },
  );
  assert.equal(result.state, 'unknown', 'a mocked run was accepted as a live predicate');
  assert.match(result.reasons.join(' '), /reaches simulated; the obligation requires live/);
  assert.equal(result.assurance, undefined);
});

test('an observation from a different verifier is not evidence for this obligation', () => {
  const result = evaluateOne({}, { verifier: { kind: 'integration-test', ref: 'test/other.test.mjs' } });
  assert.equal(result.state, 'unknown');
  assert.match(result.reasons.join(' '), /the obligation names integration-test/);
});

test('completion needs every applicable mandatory obligation to pass at its assurance', () => {
  const second = obligation({ id: 'vat-source-pinned', verifier: { kind: 'integration-test', ref: 'test/source.test.mjs' } });
  const secondPass = observation({ id: 'vat-source-pinned', verifier: { kind: 'integration-test', ref: 'test/source.test.mjs' } });

  const complete = evaluateObligations({ obligations: [obligation(), second] }, [observation(), secondPass]);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.remedies, []);

  const partial = evaluateObligations({ obligations: [obligation(), second] }, [observation(), { ...secondPass, postcondition: undefined }]);
  assert.equal(partial.complete, false);
  assert.equal(partial.counts.pass, 1);
  assert.equal(partial.counts.unknown, 1);
  assert.equal(partial.remedies.length, 1);
});

test('a waiver is reported, and never counted as a pass', () => {
  const waived = evaluateObligations(
    { obligations: [obligation()] },
    [observation({ waiver: { reviewer: 'simt-dev', reviewedAt: '2026-11-03', reason: 'the bulletin is unavailable until Monday' } })],
  );
  assert.equal(waived.rows[0].state, 'waived');
  assert.equal(waived.rows[0].countsAsPass, false);
  assert.equal(waived.counts.pass, 0);
  assert.equal(waived.complete, false, 'a waiver completed the obligation');

  const unreviewed = evaluateOne({}, { waiver: { reason: 'because' } });
  assert.equal(unreviewed.state, 'unknown');
  assert.match(unreviewed.reasons.join(' '), /not a reviewed decision/);
});

test('inapplicable needs its evidence; asserting it is not evidence', () => {
  const scoped = obligation({ applicability: { jurisdiction: 'DE' } });
  const applies = evaluateObligation({ ...scoped }, observation({ scope: { jurisdiction: 'DE' } }));
  assert.equal(applies.state, 'pass');

  const asserted = evaluateObligation({ ...scoped }, observation({ applies: false, scope: { jurisdiction: 'DE' } }));
  assert.equal(asserted.state, 'unknown');
  assert.match(asserted.reasons.join(' '), /carries no predicate evidence/);

  const evidenced = evaluateObligation(
    { ...scoped },
    observation({ applies: false, scope: { jurisdiction: 'DE' }, applicabilityEvidence: { kind: 'predicate', digest: 'sha256-example' } }),
  );
  assert.equal(evidenced.state, 'not-applicable');
  assert.equal(evidenced.countsAsPass, false);

  const report = evaluateObligations({ obligations: [{ ...scoped }] }, [observation({ applies: false, scope: { jurisdiction: 'DE' }, applicabilityEvidence: { kind: 'predicate', digest: 'sha256-example' } })]);
  assert.equal(report.complete, true, 'an obligation shown not to apply blocked completion');
});

test('evidence produced against another revision is not evidence for this one', () => {
  const pinned = obligation({ dependencies: [{ ref: 'src:de-2024', revision: 'staged:aaa' }] });
  const stale = evaluateObligation(pinned, observation({ dependencies: [{ ref: 'src:de-2024', revision: 'staged:bbb' }] }));
  assert.equal(stale.state, 'unknown');
  assert.match(stale.reasons.join(' '), /tested at staged:bbb, the obligation pins staged:aaa/);

  const unreported = evaluateObligation(pinned, observation({ dependencies: [] }));
  assert.equal(unreported.state, 'unknown');
  assert.match(unreported.reasons.join(' '), /does not report src:de-2024/);

  const drifted = evaluateObligation(pinned, observation({ dependencies: [{ ref: 'src:de-2024', revision: 'staged:aaa' }] }), { revisions: { 'src:de-2024': 'staged:ccc' } });
  assert.equal(drifted.state, 'unknown');
  assert.match(drifted.reasons.join(' '), /has moved to staged:ccc/);
});

test('an advisory failure is reported and does not block completion', () => {
  const advisory = obligation({ id: 'readability', severity: 'advisory', predicate: { kind: 'format', statement: 'the document is formatted' }, verifier: { kind: 'formatter', ref: 'prettier' }, assurance: 'executed' });
  const report = evaluateObligations(
    { obligations: [obligation(), advisory] },
    [observation(), observation({ id: 'readability', verifier: { kind: 'formatter', ref: 'prettier' }, state: 'fail', postcondition: 'failed' })],
  );
  assert.equal(report.complete, true);
  assert.equal(report.counts.fail, 1);
  assert.deepEqual(report.rows.find((row) => row.id === 'readability').reasons.length, 1);
});

test('a malformed contract blocks with a remedy instead of passing by omission', () => {
  const contract = readContract({
    obligations: [
      { id: 'no-verifier', subject: 'a.md', predicate: { kind: 'behaviour', statement: 'x' }, severity: 'mandatory', assurance: 'executed' },
      { id: 'no-verifier', subject: 'b.md', predicate: { kind: 'behaviour', statement: 'y' }, severity: 'mandatory', verifier: { kind: 'unit-test', ref: 't' }, assurance: 'executed' },
      { id: 'bad-severity', subject: 'c.md', predicate: { kind: 'behaviour', statement: 'z' }, severity: 'critical', verifier: { kind: 'unit-test', ref: 't' }, assurance: 'executed' },
    ],
  });
  assert.equal(contract.obligations.length, 0);
  assert.equal(contract.errors.length, 3);
  for (const error of contract.errors) assert.ok(error.remedy.length > 10, `${error.problem} has no actionable remedy`);

  const report = evaluateObligations({ obligations: [] }, []);
  assert.equal(report.complete, true, 'an empty contract is complete only because it requires nothing');

  const blocked = evaluateObligations({ obligations: [{ id: 'x', subject: 'a.md', predicate: { kind: 'behaviour', statement: 'y' }, severity: 'mandatory', assurance: 'executed' }] }, []);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.complete, false);
  assert.ok(blocked.remedies.some((remedy) => /verifier/.test(remedy)));
});

test('an observation with no obligation cannot certify anything', () => {
  const report = evaluateObligations({ obligations: [obligation()] }, [observation(), observation({ id: 'invented' })]);
  assert.equal(report.blocked, true);
  assert.equal(report.complete, false);
  assert.match(report.errors[0].problem, /names an obligation the contract does not have/);
});

test('evaluation is deterministic and the module reads nothing', async () => {
  const contract = { obligations: [obligation({ dependencies: [{ ref: 'src:de-2024', revision: 'staged:aaa' }] })] };
  const observations = [observation({ dependencies: [{ ref: 'src:de-2024', revision: 'staged:aaa' }] })];
  assert.deepEqual(evaluateObligations(contract, observations), evaluateObligations(structuredClone(contract), structuredClone(observations)));
  const source = await readFile(new URL('../src/verify/contracts.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
