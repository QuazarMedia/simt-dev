// Evaluation calibration and selective autonomy (W46).
//
// A judge that agrees with an expert on average is not a judge that may act alone. The failures
// this module exists to prevent:
//
//   * a false-accept ceiling declared after the numbers were seen;
//   * an underpowered or distribution-shifted scope enabled because the overall average looked
//     good;
//   * a hard privacy, security or effect constraint relaxed by an improved average;
//   * a judge's prompt, model or rubric changing without the calibration noticing.
//
// Autonomy is recommended only inside a declared scope, at a declared bar, on a lower confidence
// bound, with the hard constraints checked last so no score can outvote them.

import { digestOf } from '../knowledge/observations.mjs';
import { canonicalJson } from '../util/canonical.mjs';

/** What a scope may be allowed to do. */
export const AUTONOMY = Object.freeze(['autonomous', 'review-required', 'blocked']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The judge identity a calibration was measured against.
 *
 * A prompt, a model or a rubric change is a different judge, so it invalidates the measurement
 * rather than inheriting it.
 */
export function judgeDigest({ prompt = null, model = null, rubric = null } = {}) {
  return digestOf(canonicalJson({ prompt, model, rubric }));
}

/**
 * Declare the bar before measuring anything.
 *
 * @param {{scope?: string, capability?: string, falseAcceptCeiling?: number, minSamples?: number, judge?: object}} input
 */
export function preregister({ scope = null, capability = null, falseAcceptCeiling = null, minSamples = null, judge = null } = {}) {
  if (!isText(scope)) throw new Error('a preregistered bar needs the scope it applies to');
  if (!Number.isFinite(falseAcceptCeiling) || falseAcceptCeiling < 0 || falseAcceptCeiling > 1) throw new Error('a preregistered bar needs a false-accept ceiling between 0 and 1');
  if (!Number.isInteger(minSamples) || minSamples <= 0) throw new Error('a preregistered bar needs a sample size');
  return {
    scope,
    capability: isText(capability) ? capability : null,
    falseAcceptCeiling,
    minSamples,
    judgeDigest: isObject(judge) ? judgeDigest(judge) : null,
  };
}

/**
 * Compare a judge against blinded expert labels.
 *
 * @param {{pairs?: object[]}} input
 */
export function calibration({ pairs = [] } = {}) {
  const list = (Array.isArray(pairs) ? pairs : []).filter((pair) => isObject(pair) && ['accept', 'reject'].includes(pair.expert));
  const falseAccepts = list.filter((pair) => pair.model === 'accept' && pair.expert === 'reject').length;
  const disagreement = list.filter((pair) => isText(pair.expertA) && isText(pair.expertB) && pair.expertA !== pair.expertB).length;
  const byScope = {};
  for (const pair of list) {
    const scope = isText(pair.scope) ? pair.scope : 'unspecified';
    byScope[scope] ??= { samples: 0, falseAccepts: 0 };
    byScope[scope].samples += 1;
    if (pair.model === 'accept' && pair.expert === 'reject') byScope[scope].falseAccepts += 1;
  }
  return {
    samples: list.length,
    falseAccepts,
    falseAcceptRate: list.length === 0 ? 0 : falseAccepts / list.length,
    disagreement,
    byScope,
  };
}

/**
 * The lower confidence bound on the correct-decision rate (Wilson).
 *
 * A point estimate from a small sample is how an underpowered scope gets enabled; the bound is
 * what the ceiling is compared against.
 *
 * @param {{successes?: number, samples?: number, z?: number}} input
 */
export function lowerBound({ successes = 0, samples = 0, z = 1.64 } = {}) {
  if (!Number.isFinite(samples) || samples <= 0) return 0;
  const p = Math.max(0, Math.min(1, successes / samples));
  const n = samples;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, Math.min(1, (centre - margin) / denominator));
}

/**
 * Recommend autonomy for one scope, or refuse it.
 *
 * @param {object} input
 */
export function autonomy({ scope = null, capability = null, calibration: measured = null, prereg = null, judge = null, policy = {} } = {}) {
  if (!isObject(prereg) || !Number.isFinite(prereg.falseAcceptCeiling) || !Number.isInteger(prereg.minSamples)) {
    return { decision: 'blocked', bound: null, reason: 'no preregistered false-accept ceiling and sample size; a bar declared after the numbers is not a bar' };
  }
  if (prereg.scope !== scope || prereg.capability !== capability) {
    return { decision: 'blocked', bound: null, reason: 'the declared bar was registered for another scope or capability' };
  }
  if (isObject(judge) && isText(prereg.judgeDigest) && judgeDigest(judge) !== prereg.judgeDigest) {
    return { decision: 'review-required', bound: null, reason: 'the judge changed since the bar was registered, so the measurement is about a different judge' };
  }

  const samples = measured?.samples ?? 0;
  if (samples < prereg.minSamples) return { decision: 'review-required', bound: null, reason: `underpowered: ${samples} of ${prereg.minSamples} labelled samples` };

  const scoped = measured?.byScope?.[scope] ?? { samples: 0, falseAccepts: 0 };
  if (scoped.samples < prereg.minSamples) return { decision: 'review-required', bound: null, reason: `underpowered in ${scope}: ${scoped.samples} of ${prereg.minSamples}` };

  const bound = lowerBound({ successes: scoped.samples - scoped.falseAccepts, samples: scoped.samples });
  if (1 - bound > prereg.falseAcceptCeiling) {
    return { decision: 'review-required', bound, reason: `the lower bound on correct decisions is ${bound.toFixed(2)}, below the ceiling ${(1 - prereg.falseAcceptCeiling).toFixed(2)}` };
  }
  if ((policy?.hardConstraints ?? []).length > 0) {
    return { decision: 'review-required', bound, reason: 'a hard privacy, security or effect constraint keeps this class under review whatever the average says' };
  }
  return { decision: 'autonomous', bound, reason: 'the declared bar is met on a lower confidence bound, within this scope and capability' };
}
