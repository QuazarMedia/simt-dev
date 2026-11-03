// Remote review bundles and promotion (W42).
//
// A remote change should be reviewable with the discipline of a code diff. The failures this
// module exists to prevent:
//
//   * a reviewer unable to tell whether a bundle was planned, applied or verified;
//   * a bundle imported into the wrong target, or applied against a revision it never saw;
//   * promotion copying environment-local ids into another environment;
//   * promotion reusing the approval of the intent that ran elsewhere;
//   * a remote mutation hidden inside a push, a tracker update or a documentation change.
//
// A bundle is constructed before execution and results are appended after it, so the same artefact
// carries the plan and the evidence. It never mutates anything itself: `mutates` is false by
// construction, and a promotion produces a new intent rather than a replay.

import { digestOf } from '../knowledge/observations.mjs';
import { canonicalJson } from '../util/canonical.mjs';

export const BUNDLE_SCHEMA = 'simt.review-bundle/1';

/** What a bundle can be, and the only order it can reach those states in. */
export const BUNDLE_STATES = Object.freeze(['planned', 'applied', 'verified']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The prospective bundle: everything a reviewer needs before anything runs.
 *
 * @param {object} input
 */
export function buildReviewBundle({
  contract = null,
  delta = null,
  target = null,
  mappings = {},
  before = {},
  authorization = null,
  postconditions = [],
  risk = null,
} = {}) {
  if (!isObject(contract) || !isText(contract.commit)) throw new Error('a review bundle needs the contract commit it implements');
  if (!isObject(target) || !isText(target.incarnation)) throw new Error('a review bundle needs the target incarnation it was planned against');

  const bundle = {
    schema: BUNDLE_SCHEMA,
    state: 'planned',
    contract: { commit: contract.commit, digest: contract.digest ?? null },
    delta: {
      changes: (Array.isArray(delta?.changes) ? delta.changes : []).map((change) => ({
        field: change.field,
        kind: change.kind,
        class: change.class,
        ...(change.before !== undefined ? { before: change.before } : {}),
        ...(change.after !== undefined ? { after: change.after } : {}),
      })),
      unknown: (delta?.unknown ?? []).length,
      lossy: delta?.lossy === true,
    },
    target: { class: target.class ?? null, incarnation: target.incarnation },
    mappings: { ...mappings },
    before: { ...before },
    authorization: isObject(authorization) ? { digest: authorization.digest ?? null, scope: authorization.scope ?? null } : null,
    receipts: [],
    observed: null,
    postconditions: (Array.isArray(postconditions) ? postconditions : []).filter(isObject),
    risk: isText(risk) ? risk : null,
    // A bundle is an artefact, not an executor. No call path in this module performs anything.
    mutates: false,
  };
  bundle.digest = digestOf(canonicalJson(bundle));
  return bundle;
}

/**
 * Append what happened. A bundle whose state regresses is an error, not a new state.
 *
 * @param {object} bundle
 * @param {{receipts?: string[], observed?: object, verified?: boolean}} results
 */
export function appendResults(bundle, { receipts = [], observed = null, verified = false } = {}) {
  if (bundle?.state !== 'planned' && bundle?.state !== 'applied') throw new Error(`results cannot be appended to a ${bundle?.state ?? 'missing'} bundle`);
  return {
    ...bundle,
    state: verified ? 'verified' : 'applied',
    receipts: [...(bundle.receipts ?? []), ...(Array.isArray(receipts) ? receipts : []).filter(isText)],
    observed: isObject(observed) ? observed : bundle.observed,
  };
}

/**
 * Whether a reviewer can decide from the bundle alone.
 *
 * @param {object} bundle
 */
export function checkBundle(bundle) {
  const missing = [];
  if (!isText(bundle?.contract?.commit)) missing.push('the contract commit');
  if (!isText(bundle?.target?.incarnation)) missing.push('the target incarnation');
  if (Object.keys(bundle?.before ?? {}).length === 0) missing.push('the before revisions');
  if (!isText(bundle?.authorization?.digest)) missing.push('the authorization scope');
  if ((bundle?.postconditions ?? []).length === 0) missing.push('the postconditions');
  if (bundle?.state === 'applied' && (bundle?.receipts ?? []).length === 0) missing.push('the receipts for an applied bundle');
  return { reviewable: missing.length === 0, missing, state: bundle?.state ?? null };
}

/**
 * Promote a bundle to another environment.
 *
 * Promotion is a new intent: the target, the mappings and the authorization are re-established, so
 * an approval for the environment that already ran cannot carry over.
 *
 * @param {object} bundle
 * @param {{target?: object, mappings?: object, authorization?: object, revisions?: object}} input
 */
export function promote(bundle, { target = null, mappings = {}, authorization = null, revisions = {} } = {}) {
  const rejected = [];
  if (!isObject(target) || !isText(target.incarnation)) rejected.push({ reason: 'the promotion target has no incarnation, so it is not identified' });
  else if (target.incarnation === bundle?.target?.incarnation) rejected.push({ reason: 'the promotion target is the target this bundle already ran against' });
  if (!isObject(authorization) || !isText(authorization.digest)) rejected.push({ reason: 'promotion needs its own authorization; the bundle of another target is not one' });
  if ((bundle?.delta?.lossy ?? false) === true) rejected.push({ reason: 'a lossy bundle cannot justify replacing an object in another environment' });

  const rawIds = (Array.isArray(bundle?.delta?.changes) ? bundle.delta.changes : [])
    // Only a reference carries an environment-local id. Filtering on the value alone rejected
    // every bundle with a numeric functional field (`quantity: 42`) as an id from another tenant.
    .filter((change) => change?.class === 'reference')
    .map((change) => change.after)
    .filter((value) => typeof value === 'string' && (/^[0-9]+$/.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)));
  if (rawIds.length > 0) rejected.push({ reason: `${rawIds.join(', ')} are environment-local ids, not logical references` });

  const unresolved = (bundle?.delta?.changes ?? [])
    .filter((change) => change.class === 'reference')
    .map((change) => change.after)
    .filter((ref) => typeof ref === 'string' && !(mappings ?? {})[ref])
    .map((ref) => ({ ref, reason: `unmapped in ${target?.incarnation ?? 'the promotion target'}` }));

  if (rejected.length > 0) return { promoted: false, rejected, unresolved, intent: null };
  return {
    promoted: true,
    rejected: [],
    unresolved,
    intent: {
      target: { identity: target.identity ?? null, incarnation: target.incarnation },
      mappings: { ...mappings },
      authorization: { digest: authorization.digest, scope: authorization.scope ?? null },
      revisions: { ...revisions },
      isNewIntent: true,
    },
  };
}
