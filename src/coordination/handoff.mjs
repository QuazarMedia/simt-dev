// Evidence-bearing handoffs and resume capsules (W39).
//
// A resumed session is the most trusting reader in the system: it has the goal, a summary of what
// happened, and no memory. The failures this module exists to prevent:
//
//   * a resumed session replaying a step that had already taken effect, because the capsule
//     described progress in prose rather than receipts;
//   * a target that was reset between sessions, with the capsule never rechecking its incarnation;
//   * an approval recreated from a summary, which is a new decision nobody made;
//   * a stale or expired lease handed over as if it still excluded anyone;
//   * a capsule carrying a token or a page of source text into another session's context.
//
// So a capsule is rebuilt from ids and provenance, every dimension is revalidated before reuse,
// and content that should not travel does not enter the capsule at all.

import { digestOf } from '../knowledge/observations.mjs';
import { canonicalJson } from '../util/canonical.mjs';

const CAPSULE_SCHEMA = 'simt.capsule/1';

/** What a resume revalidates, in this order. */
export const RESUME_CHECKS = Object.freeze(['permission', 'target', 'dependencies', 'authorization', 'lease']);

/** What a capsule deliberately does not carry. */
export const EXCLUDED = Object.freeze(['secrets', 'credentials', 'source-text', 'transcript']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const SECRET = /gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const MAX_TEXT = 2000;

/**
 * Build a capsule from ids and provenance.
 *
 * A capsule is refused, not redacted, when it carries something that must not travel: silent
 * redaction leaves the caller believing the capsule holds the original.
 *
 * @param {object} input
 */
export function buildCapsule({
  goal = null,
  intent = null,
  target = null,
  snapshot = null,
  completed = [],
  uncertainty = [],
  next = null,
  budget = {},
  approval = null,
} = {}) {
  if (!isText(goal)) throw new Error('a capsule needs a goal');
  if (!isObject(intent) || !isText(intent.digest)) throw new Error('a capsule needs the intent digest it belongs to');
  if (!isObject(target) || !isText(target.incarnation)) throw new Error('a capsule needs the target incarnation it was built against');

  const capsule = {
    schema: CAPSULE_SCHEMA,
    goal,
    intent: { digest: intent.digest },
    target: { identity: target.identity ?? null, incarnation: target.incarnation },
    snapshot: isObject(snapshot) ? { digest: snapshot.digest ?? null, revision: snapshot.revision ?? null } : null,
    completed: (Array.isArray(completed) ? completed : []).filter(isObject).map((entry) => ({
      obligation: entry.obligation ?? null,
      receipt: entry.receipt ?? null,
      revision: entry.revision ?? null,
    })).sort((a, b) => String(a.obligation).localeCompare(String(b.obligation))),
    uncertainty: (Array.isArray(uncertainty) ? uncertainty : []).filter(isObject).map((entry) => ({ id: entry.id ?? null, reason: entry.reason ?? null })),
    next: isObject(next) ? { action: next.action ?? null, admissible: next.admissible === true } : null,
    budget: { actions: budget.actions ?? null, seconds: budget.seconds ?? null },
    approval: isObject(approval) ? { digest: approval.digest ?? null, scope: approval.scope ?? null } : null,
    excluded: [...EXCLUDED],
    rebuiltFrom: 'ids-and-provenance',
  };

  const serialised = canonicalJson(capsule);
  if (SECRET.test(serialised)) throw new Error('a capsule excludes secrets and credentials; it is refused rather than silently redacted');
  if (serialised.length > MAX_TEXT) throw new Error(`a capsule excludes source text and transcripts; this one is ${serialised.length} characters, over the ${MAX_TEXT} bound`);

  capsule.digest = digestOf(serialised);
  return capsule;
}

/**
 * Revalidate every dimension a resumed session depends on.
 *
 * An approval is referenced and checked against the authorization that exists now; it is never
 * reconstructed from the capsule, which would make the capsule an approver.
 *
 * @param {object} capsule
 * @param {{permission?: object, target?: object, dependencies?: object[], authorization?: object, lease?: object, now?: number}} context
 */
export function checkResume(capsule, { permission = null, target = null, dependencies = [], authorization = null, lease = null, now = 0 } = {}) {
  const failures = [];
  if (permission?.denied === true) failures.push({ check: 'permission', reason: permission.reason ?? 'the actor is not permitted to resume this work' });

  if (target !== null && capsule?.target?.incarnation !== target.incarnation) {
    failures.push({
      check: 'target',
      reason: `the capsule was built against ${capsule?.target?.incarnation ?? 'an unrecorded incarnation'} and the target is now ${target.incarnation ?? 'unrecorded'}`,
      reopened: (capsule?.completed ?? []).map((entry) => entry.obligation).filter(Boolean),
    });
  }

  const stale = (Array.isArray(dependencies) ? dependencies : []).filter((dependency) => dependency?.current !== true);
  if (stale.length > 0) failures.push({ check: 'dependencies', reason: `${stale.map((dependency) => dependency.id ?? 'a dependency').join(', ')} no longer hold current evidence` });

  // A capsule that recorded no approval is not a capsule whose approval disagrees. `undefined`
  // is not `null`, so `!== null` made every hand-built or older capsule fail this check.
  if (isObject(capsule?.approval) && capsule.approval.digest !== (authorization?.digest ?? null)) {
    failures.push({ check: 'authorization', reason: 'the recorded approval is referenced and revalidated, never recreated from the capsule' });
  }

  if (isObject(lease) && (lease.expiresAt ?? 0) <= now) failures.push({ check: 'lease', reason: `the lease expired at ${lease.expiresAt}` });

  return { resumable: failures.length === 0, checks: [...RESUME_CHECKS], failures };
}

/**
 * The obligations a changed target or revision reopens.
 *
 * @param {{capsule?: object, target?: object, revisions?: object}} input
 */
export function reopenFor({ capsule = null, target = null, revisions = {} } = {}) {
  const reopened = [];
  const targetMoved = target !== null && capsule?.target?.incarnation !== target.incarnation;
  for (const entry of capsule?.completed ?? []) {
    if (targetMoved) reopened.push({ obligation: entry.obligation, reason: 'the target incarnation changed' });
    else if (entry.revision !== null && revisions?.[entry.obligation] !== undefined && revisions[entry.obligation] !== entry.revision) {
      reopened.push({ obligation: entry.obligation, reason: `the source revision moved from ${entry.revision} to ${revisions[entry.obligation]}` });
    }
  }
  return { reopened: reopened.sort((a, b) => String(a.obligation).localeCompare(String(b.obligation))) };
}

/**
 * Whether a resumed session would repeat an effect.
 *
 * @param {{capsule?: object, executed?: string[]}} input
 */
export function duplicateEffects({ capsule = null, executed = [] } = {}) {
  const done = new Set((capsule?.completed ?? []).map((entry) => entry.receipt).filter(isText));
  const duplicates = (Array.isArray(executed) ? executed : []).filter((receipt) => done.has(receipt)).sort();
  return { duplicates, safe: duplicates.length === 0, reason: duplicates.length === 0 ? null : 'these receipts are already complete; replaying them would repeat an effect' };
}
