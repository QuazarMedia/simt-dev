// Plan 0004 W28: evidence ledger v2 with dependency validity.
//
// The fixture is a run that read a target, recorded what it inspected and then had the world
// move underneath it. What the suite pins: a reset target invalidates a record even on the same
// tree, an explicitly scoped proof survives an unrelated target revision while an unscoped one
// does not, a v1 line keeps its local meaning and cannot prove a remote obligation, a verifier
// that wrote to its subject invalidates its own run, a raw log with a token never reaches the
// record, and the chain detects damage without pretending to attest execution.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  EVIDENCE_SCHEMA,
  EVIDENCE_STATES,
  EVIDENCE_VERSION,
  buildEvidence,
  chainEvidence,
  checkChain,
  readEvidenceRecord,
  sanitizeOutput,
  validateEvidence,
} from '../src/ledger/evidence.mjs';

const TREE = 'tree-aaa';
const TARGET = { namespace: 'billing/de', incarnation: 'inc-1', revision: 'rev-9' };

const envelope = (over = {}) =>
  buildEvidence({
    observedAt: '2026-11-03T10:00:00Z',
    subject: { tree: TREE, before: TREE, after: TREE, overlay: 'overlay-1' },
    verifier: { id: 'rates-probe', digest: 'sha256-verifier' },
    contract: { digest: 'sha256-contract' },
    sources: [{ ref: 'src:de-2024', digest: 'sha256-source' }],
    target: TARGET,
    actor: { id: 'sam', context: 'local-cli' },
    revisions: { before: 'staged:1', after: 'staged:2' },
    obligations: [{ id: 'published-rate', state: 'pass', basis: 'remote', scope: [{ ref: 'docs/rates.md', revision: 'd1' }] }],
    output: 'ok: published 19%',
    ...over,
  });

test('the envelope names its own schema and the four states', () => {
  assert.equal(EVIDENCE_VERSION, 2);
  assert.equal(EVIDENCE_SCHEMA, 'simt.evidence/2');
  assert.deepEqual(EVIDENCE_STATES, ['current', 'stale', 'raced', 'inapplicable']);
});

test('a v2 envelope binds the subject, the verifier, the target, the actor and the revisions', () => {
  const record = envelope();
  assert.equal(record.schema, EVIDENCE_SCHEMA);
  assert.equal(record.subject.tree, TREE);
  assert.equal(record.subject.overlay, 'overlay-1');
  assert.equal(record.verifier.digest, 'sha256-verifier');
  assert.equal(record.contract.digest, 'sha256-contract');
  assert.deepEqual(record.sources, [{ ref: 'src:de-2024', digest: 'sha256-source' }]);
  assert.deepEqual(record.target, TARGET);
  assert.deepEqual(record.actor, { id: 'sam', context: 'local-cli' });
  assert.deepEqual(record.revisions, { before: 'staged:1', after: 'staged:2' });
  assert.equal(record.observedAt, '2026-11-03T10:00:00Z');
  assert.match(record.canon, /^sha256-/);
  assert.match(record.outputDigest, /^sha256-/);

  const current = validateEvidence(record, { tree: TREE, target: TARGET, revisions: { 'docs/rates.md': 'd1' }, needed: [{ id: 'published-rate', basis: 'remote' }] });
  assert.equal(current.state, 'current');
  assert.equal(current.current, true);
});

test('the same tree against a reset target is not current evidence', () => {
  const reset = validateEvidence(envelope(), {
    tree: TREE,
    target: { ...TARGET, incarnation: 'inc-2' },
    needed: [{ id: 'published-rate', basis: 'remote' }],
  });
  assert.equal(reset.state, 'raced');
  assert.equal(reset.current, false);
  assert.match(reset.reasons[0], /reset target/);
});

test('an explicitly scoped proof survives an unrelated revision; an unscoped one does not', () => {
  const scoped = validateEvidence(envelope(), {
    tree: TREE,
    target: { ...TARGET, revision: 'rev-10' },
    revisions: { 'docs/rates.md': 'd1' },
    needed: [{ id: 'published-rate', basis: 'remote' }],
  });
  assert.equal(scoped.state, 'current', JSON.stringify(scoped.reasons));

  const movedScope = validateEvidence(envelope(), {
    tree: TREE,
    target: { ...TARGET, revision: 'rev-10' },
    revisions: { 'docs/rates.md': 'd2' },
    needed: [{ id: 'published-rate', basis: 'remote' }],
  });
  assert.equal(movedScope.state, 'inapplicable');
  assert.match(movedScope.reasons.join(' '), /docs\/rates\.md d1, which is now d2/);

  const unscoped = validateEvidence(
    envelope({ obligations: [{ id: 'published-rate', state: 'pass', basis: 'remote', scope: [] }] }),
    { tree: TREE, target: { ...TARGET, revision: 'rev-10' }, needed: [{ id: 'published-rate', basis: 'remote' }] },
  );
  assert.equal(unscoped.state, 'stale');
  assert.match(unscoped.reasons.join(' '), /has no scope, and the target revision moved/);
});

test('a v1 line keeps its local meaning and cannot prove a remote obligation', () => {
  const v1 = { v: 2, tree: TREE, cmd: 'npm test', exit: 0 };
  const read = readEvidenceRecord(v1);
  assert.equal(read.version, 1);
  assert.equal(read.localOnly, true);
  assert.equal(read.tree, TREE);

  assert.equal(validateEvidence(v1, { tree: TREE, needed: [{ id: 'tests' }] }).state, 'current');
  assert.equal(validateEvidence(v1, { tree: 'tree-bbb', needed: [{ id: 'tests' }] }).state, 'stale');

  const remote = validateEvidence(v1, { tree: TREE, target: TARGET, needed: [{ id: 'published-rate', basis: 'remote' }] });
  assert.equal(remote.state, 'inapplicable');
  assert.match(remote.reasons.join(' '), /v1 record cannot prove a remote obligation/);
});

test('a verifier that changed its subject invalidates its own run', () => {
  const modified = validateEvidence(envelope({ subject: { tree: TREE, before: TREE, after: 'tree-moved-by-verifier' } }), {
    tree: TREE,
    target: TARGET,
    needed: [{ id: 'published-rate', basis: 'remote' }],
  });
  assert.equal(modified.state, 'inapplicable');
  assert.match(modified.reasons[0], /changed its own subject/);
});

test('a raw log with a token never reaches the record', () => {
  const output = 'token=ghp_abcdefghijklmnopqrstuvwxyz0123\nAuthorization: Bearer sk-live-abcdefghijklmnop';
  const record = envelope({ output });
  const json = JSON.stringify(record);
  assert.doesNotMatch(json, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
  assert.doesNotMatch(json, /sk-live-abcdefghijklmnop/);
  assert.ok(record.redactions >= 2);
  assert.match(record.summary, /redacted/);

  const sanitized = sanitizeOutput('npm test\nFAIL 2 tests\nsecret: hunter2');
  assert.equal(sanitized.summary, 'npm test');
  assert.ok(sanitized.redactions >= 1);
  assert.match(sanitized.digest, /^sha256-/);
  assert.equal(sanitizeOutput(output).digest, sanitizeOutput(output).digest);
  assert.notEqual(sanitizeOutput(output).digest, sanitizeOutput(`${output} `).digest);
});

test('the chain detects damage and says it is not an attestation', () => {
  const first = chainEvidence(envelope());
  const second = chainEvidence(envelope({ observedAt: '2026-11-03T10:05:00Z' }), first);
  const intact = checkChain([first, second]);
  assert.equal(intact.intact, true);
  assert.equal(intact.brokenAt, null);
  assert.equal(intact.attestsExecution, false);

  const tampered = { ...second, summary: 'everything passed, honestly' };
  const damaged = checkChain([first, tampered]);
  assert.equal(damaged.intact, false);
  assert.equal(damaged.brokenAt, 1);
  assert.equal(damaged.attestsExecution, false);

  const unlinked = checkChain([first, { ...second, previous: null }]);
  assert.equal(unlinked.intact, false);
  assert.equal(unlinked.brokenAt, 1);
});

test('an obligation absent from the record, or not passing, is not current', () => {
  const missing = validateEvidence(envelope(), { tree: TREE, target: TARGET, needed: [{ id: 'other', basis: 'remote' }] });
  assert.equal(missing.state, 'inapplicable');
  assert.match(missing.reasons.join(' '), /other is not in the record/);

  const failed = validateEvidence(envelope({ obligations: [{ id: 'published-rate', state: 'fail', basis: 'remote', scope: [] }] }), {
    tree: TREE,
    target: TARGET,
    needed: [{ id: 'published-rate', basis: 'remote' }],
  });
  assert.equal(failed.state, 'inapplicable');
  assert.match(failed.reasons.join(' '), /recorded as fail/);

  const localOnly = validateEvidence(envelope({ obligations: [{ id: 'published-rate', state: 'pass', basis: 'local', scope: [] }] }), {
    tree: TREE,
    target: TARGET,
    needed: [{ id: 'published-rate', basis: 'remote' }],
  });
  assert.equal(localOnly.current, false);
  assert.match(localOnly.reasons.join(' '), /local evidence, not a remote reading/);
});

test('building is deterministic and the module reads nothing', async () => {
  assert.deepEqual(envelope(), envelope());
  const source = await readFile(new URL('../src/ledger/evidence.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
