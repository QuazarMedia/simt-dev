// Plan 0004 W29: closure reports and versioned completion semantics.
//
// The fixture is an eight-check closure, because the accept names 6/8 as the canonical partial
// result. What the suite pins: 6/8 is BLOCK and never "mostly complete"; an unavailable live
// verifier cannot be relabelled passed by a local record that passed; a remote-only closure
// carries its reviewed contract and receipts and no invented diff; a documented external block
// completes a local closure without claiming the remote one; an opted-in contract needs an
// outcome digest or receipt set; and v1 consumers keep the contract they parse.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CLOSURE_SCHEMAS,
  CLOSURE_SCHEMA_VERSION,
  CLOSURE_SCOPES,
  closureReport,
  resolveObligationState,
} from '../src/verify/closure.mjs';

const obligation = (id, over = {}) => ({ id, state: 'pass', severity: 'mandatory', basis: 'local', ...over });

const eight = (over = {}) => Array.from({ length: 8 }, (_, index) => obligation(`check-${index + 1}`, over));

test('the schema is versioned, and the scopes are named', () => {
  assert.equal(CLOSURE_SCHEMA_VERSION, 2);
  assert.deepEqual(CLOSURE_SCHEMAS, { 1: 'simt.closure/1', 2: 'simt.closure/2' });
  assert.deepEqual(CLOSURE_SCOPES, ['source', 'remote', 'both']);
  assert.throws(() => closureReport({ version: 3 }), /not one of 1, 2/);
  assert.throws(() => closureReport({ scope: 'everything' }), /not one of source, remote, both/);
});

test('6 of 8 required checks is BLOCK, and the two are named', () => {
  const obligations = eight();
  obligations[6].state = 'unknown';
  obligations[7].state = 'not-run';
  const report = closureReport({ obligations });
  assert.equal(report.verdict, 'BLOCK');
  assert.equal(report.complete, false);
  assert.deepEqual(report.coverage, { required: 8, passed: 6, total: 8 });
  assert.deepEqual(report.unresolved.map((entry) => entry.id), ['check-7', 'check-8']);
  assert.match(report.reasons.join(' '), /2 of 8 required obligation\(s\) are unresolved/);
});

test('8 of 8 is COMPLETE, and an empty requirement is not', () => {
  assert.equal(closureReport({ obligations: eight() }).verdict, 'COMPLETE');
  const empty = closureReport({ obligations: [] });
  assert.equal(empty.verdict, 'BLOCK');
  assert.match(empty.reasons.join(' '), /nothing has been shown complete/);
});

test('an unavailable live verifier is not relabelled passed by a local record', () => {
  const evidence = [{ obligation: 'check-1', state: 'unavailable', basis: 'remote' }];
  assert.equal(resolveObligationState(obligation('check-1'), evidence), 'unavailable');

  const report = closureReport({
    obligations: [obligation('check-1')],
    evidence,
    scope: 'both',
  });
  assert.equal(report.verdict, 'BLOCK');
  assert.equal(report.checks[0].state, 'unavailable');
  assert.match(report.checks[0].reason, /cannot be reached|not a pass/);
});

test('a remote-only closure needs a reviewed contract and carries no fabricated diff', () => {
  const remote = [obligation('remote-write', { basis: 'remote' })];
  const report = closureReport({
    scope: 'remote',
    obligations: remote,
    changes: [],
    contract: { commit: 'abc1234', digest: 'sha256-contract', reviewed: true },
    receipts: ['receipt-1'],
    outcomeDigest: 'sha256-outcome',
  });
  assert.equal(report.verdict, 'COMPLETE');
  assert.deepEqual(report.completion.kind, 'remote');
  assert.equal(report.completion.codeDiff, null);
  assert.deepEqual(report.completion.receipts, ['receipt-1']);
  assert.match(report.reasons.join(' '), /no code diff is claimed/);

  const unreviewed = closureReport({ scope: 'remote', obligations: remote, changes: [], contract: { commit: 'abc1234', reviewed: false }, receipts: ['r'] });
  assert.equal(unreviewed.verdict, 'BLOCK');
  assert.match(unreviewed.reasons.join(' '), /reviewed contract commit/);
});

test('an opted-in contract records completion with an outcome digest or receipts', () => {
  const base = {
    obligations: [obligation('check-1')],
    changes: ['src/x.mjs'],
    contract: { optedIn: true, commit: 'abc', digest: 'sha256-c', reviewed: true },
  };
  const missing = closureReport(base);
  assert.equal(missing.verdict, 'BLOCK');
  assert.match(missing.reasons.join(' '), /outcome digest or a receipt set/);

  assert.equal(closureReport({ ...base, outcomeDigest: 'sha256-o' }).verdict, 'COMPLETE');
  assert.equal(closureReport({ ...base, receipts: ['receipt-1'] }).verdict, 'COMPLETE');

  const sourceOnly = closureReport({ obligations: [obligation('check-1')], changes: ['src/x.mjs'] });
  assert.equal(sourceOnly.verdict, 'COMPLETE', 'a source-only SHA closure needed a receipt it never needed');
});

test('a local commit may document a blocked external task without claiming remote completion', () => {
  const obligations = [obligation('local-check'), obligation('remote-write', { basis: 'remote', state: 'unavailable', external: true })];
  const report = closureReport({ scope: 'source', obligations, changes: ['src/x.mjs'], documentedBlock: { ref: 'docs/blocks/remote-write.md' } });
  assert.equal(report.verdict, 'COMPLETE');
  assert.equal(report.completion.kind, 'source');
  assert.deepEqual(report.blocked.external, ['remote-write']);
  assert.equal(report.blocked.documentedAt, 'docs/blocks/remote-write.md');

  const both = closureReport({ scope: 'both', obligations, changes: ['src/x.mjs'], documentedBlock: { ref: 'docs/blocks/remote-write.md' } });
  assert.equal(both.verdict, 'BLOCK');
  assert.match(both.reasons.join(' '), /claims the remote scope/);
});

test('an advisory obligation does not block, and a required one still does', () => {
  const obligations = [obligation('check-1'), obligation('style', { severity: 'advisory', state: 'fail' })];
  const report = closureReport({ obligations });
  assert.equal(report.verdict, 'COMPLETE');
  assert.deepEqual(report.unresolved, []);

  const requiredExplicitly = closureReport({ obligations, required: ['check-1', 'style'] });
  assert.equal(requiredExplicitly.verdict, 'BLOCK');
  assert.deepEqual(requiredExplicitly.unresolved.map((entry) => entry.id), ['style']);
});

test('v1 consumers keep the contract they parse', () => {
  const obligations = eight();
  obligations[0].state = 'fail';
  const v1 = closureReport({ version: 1, obligations });
  assert.equal(v1.schema, 'simt.closure/1');
  assert.equal(v1.complete, false);
  assert.deepEqual(v1.checks, { passed: 7, total: 8 });
  assert.equal('verdict' in v1, false, 'v1 grew a field its consumers do not parse');
  assert.equal('completion' in v1, false);

  const v2 = closureReport({ obligations });
  assert.equal(v2.schema, 'simt.closure/2');
  assert.equal(v2.complete, v1.complete);
  assert.equal(v2.verdict, 'BLOCK');
});

test('the report is deterministic and reads nothing', async () => {
  const input = { obligations: eight(), changes: ['src/x.mjs'] };
  assert.deepEqual(closureReport(input), closureReport(structuredClone(input)));
  const source = await readFile(new URL('../src/verify/closure.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
