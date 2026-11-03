// Independent verification, convergence and frame checks (W35).
//
// The mutation response is not the result. The failures this module is built around:
//
//   * an HTTP 202 read as success, so a job that never finished closed a task;
//   * a job that reported success while the object content was wrong;
//   * an eventually consistent target read once and called stable;
//   * a timeout reported as passed because the desired object happened to look right earlier;
//   * an unrelated object being changed while the desired one was correct, and nobody noticing;
//   * two channels behind the same cache presented as independent.
//
// A pass is only ever over a named observation: target, incarnation and revision. Anything less is
// `unknown`, which is a real result and not a failure to report.

import { canonicalJson } from '../util/canonical.mjs';

/** What an observation can conclude. */
export const OBSERVATION_VERDICTS = Object.freeze(['pass', 'fail', 'incomplete', 'unknown']);

/** Where the evidence came from, in assurance terms. */
export const ASSURANCE = Object.freeze(['independent', 'correlated']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether two read channels are independent.
 *
 * Two channels reading the same cache or the same replica lag are one channel with two names.
 */
export function channelIndependence(channels = []) {
  const list = (Array.isArray(channels) ? channels : []).filter((channel) => isObject(channel));
  if (list.length < 2) return { assurance: 'correlated', reason: 'fewer than two channels were declared' };
  // A channel that declares no backing cannot prove it is a second reading. Falling back to the
  // name made two differently named clients over one cache look independent, which is the exact
  // failure this function exists to catch.
  const undeclared = list.filter((channel) => !isText(channel.backing));
  if (undeclared.length > 0) {
    return { assurance: 'correlated', reason: 'a channel declares no backing store, so independence cannot be claimed' };
  }
  const backings = new Set(list.map((channel) => channel.backing));
  if (backings.size < list.length) return { assurance: 'correlated', reason: 'two declared channels share a backing store, so they are one reading' };
  return { assurance: 'independent', reason: 'the channels do not share a backing store' };
}

/**
 * The state of an asynchronous job, from its own identity rather than its first response.
 */
export function jobState(job = null) {
  if (!isObject(job)) return 'unknown';
  const status = String(job.state ?? job.status ?? '').toLowerCase();
  if (['succeeded', 'success', 'completed', 'done', '200', '201'].includes(status)) return 'succeeded';
  if (['failed', 'error', 'cancelled', '500'].includes(status)) return 'failed';
  if (['pending', 'accepted', 'queued', 'running', '202'].includes(status)) return 'pending';
  return 'unknown';
}

const holds = (entry, snapshot) => {
  const field = isObject(entry) ? entry.field : null;
  const expect = isObject(entry) ? entry.expect : entry;
  if (!isText(field) || !isObject(snapshot) || !isObject(snapshot.fields)) return false;
  // An absent field is not a satisfied one: `undefined` on both sides compared equal, so a
  // postcondition could pass on a field the object never carried.
  if (!Object.prototype.hasOwnProperty.call(snapshot.fields, field)) return false;
  return canonicalJson(snapshot.fields[field]) === canonicalJson(expect);
};

/**
 * Verify the intended result over stable observations.
 *
 * @param {object} input
 */
export function verifyOutcome({
  postconditions = [],
  frames = [],
  object = null,
  channels = [],
  job = null,
  stabilityWindow = 0,
  elapsed = 0,
  stableReads = 1,
  requiredReads = 1,
  timedOut = false,
} = {}) {
  const observed = isObject(object)
    ? { target: object.target ?? object.namespace ?? null, incarnation: object.incarnation ?? null, revision: object.revision ?? null }
    : null;
  const assurance = channelIndependence(channels).assurance;
  const result = (verdict, reasons, extra = {}) => ({ verdict, reasons, assurance, observed, ...extra });

  if (timedOut) return result('unknown', ['the observation window closed before a stable reading; the outcome remains unknown, not passed']);
  const state = jobState(job);
  if (job !== null && state === 'pending') return result('incomplete', ['the job has not reached a terminal state; an accepted request is not a result']);
  if (job !== null && state === 'failed') return result('fail', ['the job failed']);
  if (job !== null && state === 'unknown') return result('unknown', ['the job state could not be read']);

  if (!isObject(object)) return result('unknown', ['no object was read back, so no postcondition can be checked']);
  if (!isText(observed.incarnation) || !isText(observed.revision)) {
    return result('unknown', ['the observation does not name an incarnation and revision, so it cannot be current evidence about anything']);
  }

  const required = Array.isArray(postconditions) ? postconditions : [];
  const framesRequired = Array.isArray(frames) ? frames : [];

  const failedPostconditions = required.filter((entry) => !holds(entry, object)).map((entry) => (isObject(entry) ? entry.field : String(entry)));
  if (failedPostconditions.length > 0) return result('fail', [`the target does not hold the intended result: ${failedPostconditions.join(', ')}`], { failed: failedPostconditions });

  const brokenFrames = framesRequired.filter((entry) => !holds(entry, object)).map((entry) => (isObject(entry) ? entry.field : String(entry)));
  if (brokenFrames.length > 0) {
    return result('fail', [`frame condition violated: ${brokenFrames.join(', ')} was expected to stay unchanged`], { failed: brokenFrames });
  }

  if (elapsed < stabilityWindow) {
    return result('incomplete', [`the observation has not been stable for the declared ${stabilityWindow}ms window`]);
  }
  if (stableReads < requiredReads) {
    return result('incomplete', [`${stableReads} stable read(s), ${requiredReads} required`]);
  }

  return result('pass', [assurance === 'correlated' ? 'the result holds, on correlated channels: this is not independent confirmation' : 'the result holds on independent channels']);
}
