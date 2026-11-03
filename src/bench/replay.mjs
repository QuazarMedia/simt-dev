// Counterfactual replay and metamorphic checks (W45).
//
// A single gold output is too narrow to test generality: the same logic run against a renamed id,
// a reordered event list, a converted unit or another effective date should be recognisably the
// same answer or a deliberately different one. The failures this module exists to prevent:
//
//   * an invariant invented from model agreement, which is not an invariant;
//   * a reordered unrelated event changing the result, or a relevant one not changing it;
//   * an under-covered trace replayed as if it proved something;
//   * an offline replay reported as a live acceptance run.

import { canonicalJson } from '../util/canonical.mjs';

/** The relations a contract may declare. Nothing outside this list is applied. */
export const RELATIONS = Object.freeze(['rename-invariance', 'unit-preserving', 'read-channel-equivalence', 'idempotent-repetition', 'effective-date-divergence']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fieldsOf = (observation) => (isObject(observation?.fields) ? observation.fields : {});

/**
 * Whether a trace carries enough to replay at all.
 *
 * A trace with no observation is a plan, and a plan cannot be replayed.
 *
 * @param {{intent?: object, observations?: object[], events?: object[]}} trace
 */
export function replayable(trace = {}) {
  const missing = [];
  if (!isText(trace?.intent?.digest)) missing.push('the intent digest');
  if (!Array.isArray(trace?.observations) || trace.observations.length === 0) missing.push('at least one observation');
  if (!Array.isArray(trace?.events) || trace.events.length === 0) missing.push('the event sequence');
  return { replayable: missing.length === 0, missing, reason: missing.length === 0 ? null : `the trace is not replayable; it is missing: ${missing.join(', ')}` };
}

/** Renamed or reordered ids must not change the semantic result. */
export function renameInvariant({ before = null, after = null } = {}) {
  if (!isObject(before) || !isObject(after)) return { holds: false, reason: 'two observations are needed to compare' };
  const holds = canonicalJson(fieldsOf(before)) === canonicalJson(fieldsOf(after));
  return { holds, reason: holds ? 'the semantic fields are unchanged' : 'a semantic field changed, so this was not a rename or a reorder' };
}

/** A unit conversion must preserve the value it expresses. */
export function unitPreserving({ before = null, after = null, field = null, convert = null } = {}) {
  if (!isText(field) || typeof convert !== 'function') return { holds: false, reason: 'a field and its conversion are needed' };
  const expected = fieldsOf(before)[field];
  const converted = convert(fieldsOf(after)[field]);
  const holds = canonicalJson(expected) === canonicalJson(converted);
  return { holds, reason: holds ? `${field} is preserved under the conversion` : `${field} is not preserved: ${JSON.stringify(expected)} against ${JSON.stringify(converted)}` };
}

/** Two independent channels answering one question must agree. */
export function channelEquivalent({ answers = [] } = {}) {
  const list = Array.isArray(answers) ? answers : [];
  if (list.length < 2) return { holds: false, reason: 'two answers from independent channels are needed' };
  const holds = list.every((answer) => canonicalJson(answer) === canonicalJson(list[0]));
  return { holds, reason: holds ? 'the channels agree' : 'the channels disagree, so neither can be treated as the answer' };
}

/** Repetition is only a relation where the contract promises it. */
export function idempotent({ once = null, repeated = null } = {}) {
  const holds = canonicalJson(once) === canonicalJson(repeated);
  return { holds, reason: holds ? 'applying the step twice equals applying it once' : 'the repetition changed the result, so the contract does not promise idempotence here' };
}

/** A difference across effective dates is intended only where the date governs the field. */
export function dateDivergence({ before = null, after = null, allowedFields = [] } = {}) {
  if (!isText(before?.effectiveDate) || !isText(after?.effectiveDate) || before.effectiveDate === after.effectiveDate) {
    return { holds: false, reason: 'two different effective dates are needed' };
  }
  const allowed = new Set(Array.isArray(allowedFields) ? allowedFields : []);
  const keys = [...new Set([...Object.keys(fieldsOf(before)), ...Object.keys(fieldsOf(after))])];
  const changed = keys.filter((field) => canonicalJson(fieldsOf(before)[field]) !== canonicalJson(fieldsOf(after)[field]));
  const unexpected = changed.filter((field) => !allowed.has(field));
  return unexpected.length === 0
    ? { holds: true, reason: 'the differences are confined to the fields the effective date governs' }
    : { holds: false, reason: `${unexpected.join(', ')} changed but is not governed by the effective date` };
}

/**
 * Apply the declared relations to one baseline and one variant.
 *
 * Only declared relations run: a relation nobody named is not evidence, and an undeclared one is
 * reported rather than assumed.
 *
 * @param {{before?: object, after?: object, relations?: string[], options?: object}} input
 */
export function metamorphic({ before = null, after = null, relations = [], options = {} } = {}) {
  const results = (Array.isArray(relations) ? relations : []).map((relation) => {
    if (!RELATIONS.includes(relation)) return { relation, holds: false, reason: `${relation} is not a declared relation` };
    const args = { before, after, ...(options?.[relation] ?? {}) };
    const check =
      relation === 'rename-invariance'
        ? renameInvariant(args)
        : relation === 'unit-preserving'
          ? unitPreserving(args)
          : relation === 'read-channel-equivalence'
            ? channelEquivalent(args)
            : relation === 'idempotent-repetition'
              ? idempotent(args)
              : dateDivergence(args);
    return { relation, ...check };
  });
  const violations = results.filter((result) => !result.holds).map((result) => ({ relation: result.relation, reason: result.reason }));
  return { holds: violations.length === 0, results, violations };
}

/**
 * What an offline replay can be reported as.
 *
 * It measures logic robustness against a changed world; it is not a live acceptance run, and the
 * two are never averaged into one number.
 */
export function offline() {
  return { measures: 'logic-robustness', liveAcceptance: false, reason: 'an offline replay compares logic against a changed input; it says nothing about a live target' };
}
