// Plan 0004 W39: evidence-bearing handoffs and resume capsules.
//
// What the suite pins: a capsule is built from ids and provenance and carries no secret or source
// text; a resume revalidates permission, target incarnation, dependencies, authorization and lease;
// a changed target reopens the obligations it completed; an approval is referenced, never
// recreated; and a resumed session that reuses a completed receipt is stopped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  EXCLUDED,
  RESUME_CHECKS,
  buildCapsule,
  checkResume,
  duplicateEffects,
  reopenFor,
} from '../src/coordination/handoff.mjs';

const capsule = (over = {}) =>
  buildCapsule({
    goal: 'publish the discount rule',
    intent: { digest: 'sha256-intent' },
    target: { identity: 'rates/staging#inc-1', incarnation: 'inc-1' },
    snapshot: { digest: 'sha256-snapshot', revision: 'rev-3' },
    completed: [{ obligation: 'read-back', receipt: 'receipt-1', revision: 'rev-3' }],
    uncertainty: [{ id: 'ui-only-field', reason: 'the field is not readable through the API' }],
    next: { action: 'write-object', admissible: true },
    budget: { actions: 3, seconds: 600 },
    approval: { digest: 'sha256-approval', scope: 'remote:write-object' },
    ...over,
  });

test('the resume checks and the exclusions are named', () => {
  assert.deepEqual(RESUME_CHECKS, ['permission', 'target', 'dependencies', 'authorization', 'lease']);
  assert.deepEqual(EXCLUDED, ['secrets', 'credentials', 'source-text', 'transcript']);
});

test('a capsule carries provenance, completed receipts, uncertainty, next action and budget', () => {
  const built = capsule();
  assert.equal(built.schema, 'simt.capsule/1');
  assert.deepEqual(built.intent, { digest: 'sha256-intent' });
  assert.deepEqual(built.target, { identity: 'rates/staging#inc-1', incarnation: 'inc-1' });
  assert.deepEqual(built.completed, [{ obligation: 'read-back', receipt: 'receipt-1', revision: 'rev-3' }]);
  assert.equal(built.next.action, 'write-object');
  assert.deepEqual(built.budget, { actions: 3, seconds: 600 });
  assert.equal(built.rebuiltFrom, 'ids-and-provenance');
  assert.match(built.digest, /^sha256-/);
});

test('a capsule carrying a secret or a transcript is refused, not redacted', () => {
  assert.throws(() => capsule({ goal: 'use ghp_abcdefghijklmnopqrstuvwxyz0123' }), /excludes secrets/);
  assert.throws(() => capsule({ goal: 'x'.repeat(2500) }), /excludes source text/);
  assert.throws(() => buildCapsule({ intent: { digest: 'd' }, target: { incarnation: 'i' } }), /needs a goal/);
  assert.throws(() => buildCapsule({ goal: 'g', target: { incarnation: 'i' } }), /intent digest/);
});

test('a resume over current state is allowed', () => {
  const result = checkResume(capsule(), {
    permission: { denied: false },
    target: { incarnation: 'inc-1' },
    dependencies: [{ id: 'source', current: true }],
    authorization: { digest: 'sha256-approval' },
    lease: { expiresAt: 1000 },
    now: 10,
  });
  assert.equal(result.resumable, true);
  assert.deepEqual(result.failures, []);
});

test('a reset target blocks the resume and reopens what was completed', () => {
  const result = checkResume(capsule(), { target: { incarnation: 'inc-2' }, authorization: { digest: 'sha256-approval' } });
  assert.equal(result.resumable, false);
  const failure = result.failures.find((entry) => entry.check === 'target');
  assert.deepEqual(failure.reopened, ['read-back']);
  assert.match(failure.reason, /inc-1.*inc-2/);
});

test('stale dependencies, a changed approval and an expired lease each block', () => {
  const base = { target: { incarnation: 'inc-1' }, authorization: { digest: 'sha256-approval' }, now: 5000 };
  const stale = checkResume(capsule(), { ...base, dependencies: [{ id: 'source', current: false }] });
  assert.equal(stale.failures[0].check, 'dependencies');
  assert.match(stale.failures[0].reason, /source no longer hold current evidence/);

  const relocated = checkResume(capsule(), { ...base, authorization: { digest: 'sha256-other' } });
  assert.match(relocated.failures[0].reason, /never recreated from the capsule/);

  const expired = checkResume(capsule(), { ...base, lease: { expiresAt: 4000 } });
  assert.equal(expired.failures.at(-1).check, 'lease');

  const denied = checkResume(capsule(), { ...base, permission: { denied: true } });
  assert.equal(denied.failures[0].check, 'permission');
});

test('a changed source revision reopens the obligation that cited it', () => {
  const reopened = reopenFor({ capsule: capsule(), target: { incarnation: 'inc-1' }, revisions: { 'read-back': 'rev-4' } }).reopened;
  assert.deepEqual(reopened, [{ obligation: 'read-back', reason: 'the source revision moved from rev-3 to rev-4' }]);
  assert.deepEqual(reopenFor({ capsule: capsule(), target: { incarnation: 'inc-1' }, revisions: { 'read-back': 'rev-3' } }).reopened, []);
});

test('a resumed session repeating a completed receipt is stopped', () => {
  const safe = duplicateEffects({ capsule: capsule(), executed: ['receipt-2'] });
  assert.equal(safe.safe, true);
  const repeated = duplicateEffects({ capsule: capsule(), executed: ['receipt-1', 'receipt-2'] });
  assert.equal(repeated.safe, false);
  assert.deepEqual(repeated.duplicates, ['receipt-1']);
  assert.match(repeated.reason, /would repeat an effect/);
});

test('the capsule is deterministic and the module reads nothing', async () => {
  assert.deepEqual(capsule(), capsule());
  const source = await readFile(new URL('../src/coordination/handoff.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});

// A capsule that recorded no approval is not a capsule whose approval disagrees. The check read
// `approval !== null`, which is true for `undefined`, so every hand-built capsule failed resume.
import { buildCapsule as buildCapsuleForApproval, checkResume as checkResumeForApproval } from '../src/coordination/handoff.mjs';

test('a capsule with no recorded approval does not fail the authorization check', () => {
  const capsule = buildCapsuleForApproval({
    goal: 'apply the discount',
    intent: { digest: 'sha256-intent' },
    target: { incarnation: 'inc-1' },
  });
  assert.equal(capsule.approval, null);
  const result = checkResumeForApproval(capsule, { target: { incarnation: 'inc-1' } });
  assert.deepEqual(result.failures, []);
  assert.equal(result.resumable, true);
});
