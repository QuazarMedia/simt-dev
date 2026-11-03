// Bitemporal validity: what a claim asserted, when it was true, and when the tool knew it.
//
// Two clocks, not one. A rate published in 2020 and corrected in 2024 was 16 % for those
// years and is 20 % for them now - the effective interval did not move, the recording did.
// Collapsing the two into "the current document" is how a retroactive correction silently
// rewrites history, and how a query about 2021 answers with what happens to be published
// today.
//
// Authority is a declared partial order, never a recency rule. Two claims in force at once
// with nothing ranking them are a conflict set, because "the newest source wins" is an
// assumption about the world dressed as a resolution. A claim that cannot be placed - no
// effective start, or a scope the query requires and the claim does not state - makes the
// answer unknown rather than silently absent: it might have been the one that applied.
//
// No function here reads a clock. `asOf` and `knownAt` are arguments, and a caller that
// wants today passes today; that is what keeps a projected byte string stable across runs.

import { CLAIMS_SCHEMA_VERSION } from './claims.mjs';

/** The scope dimensions a claim can be restricted to. */
export const SCOPE_FIELDS = Object.freeze(['jurisdiction', 'product', 'version', 'population']);

/** The states an answer can be in. Nothing here is a pass. */
export const APPLICABILITY_RESULTS = Object.freeze(['applicable', 'conflict', 'unknown', 'none', 'empty']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;

/** Days only: a timestamp would make the answer depend on a timezone nobody declared. */
const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * One claim's validity, validated.
 *
 * `validFrom` is required: an open start is not "always was true", it is a claim whose
 * history nobody recorded, and the query has to be able to say so.
 *
 * @returns {{applicability?: object, problems?: string[]}}
 */
export function readApplicability(input = {}) {
  const source = isObject(input) ? input : {};
  const problems = [];
  const day = (key, required) => {
    const value = source[key];
    if (value === undefined || value === null) {
      if (required) problems.push(`${key} must be an ISO date (YYYY-MM-DD)`);
      return null;
    }
    if (!isDay(value)) {
      problems.push(`${key} must be an ISO date (YYYY-MM-DD), not ${JSON.stringify(value)}`);
      return null;
    }
    return value;
  };

  const validFrom = day('validFrom', true);
  const validTo = day('validTo', false);
  const recordedFrom = day('recordedFrom', true);
  const recordedTo = day('recordedTo', false);
  if (validFrom !== null && validTo !== null && validTo <= validFrom) {
    problems.push(`validTo (${validTo}) must be after validFrom (${validFrom}); the effective interval is half-open`);
  }
  if (recordedFrom !== null && recordedTo !== null && recordedTo <= recordedFrom) {
    problems.push(`recordedTo (${recordedTo}) must be after recordedFrom (${recordedFrom}); the recording interval is half-open`);
  }

  const scope = source.scope ?? {};
  if (!isObject(scope)) problems.push('scope must be an object');
  else {
    for (const [key, value] of Object.entries(scope)) {
      if (!SCOPE_FIELDS.includes(key)) problems.push(`scope.${key} is not one of ${SCOPE_FIELDS.join(', ')}`);
      else if (!isText(value)) problems.push(`scope.${key} must be a non-empty string when given`);
    }
  }

  const revision = source.revision ?? null;
  if (revision !== null && !isText(revision)) problems.push('revision must be a non-empty string when given');

  const supersedes = source.supersedes ?? [];
  if (!Array.isArray(supersedes) || !supersedes.every(isText)) problems.push('supersedes must be a list of claim ids');

  if (problems.length > 0) return { problems };
  return {
    applicability: {
      validFrom,
      validTo,
      recordedFrom,
      recordedTo,
      revision,
      scope: { ...scope },
      supersedes: [...supersedes],
    },
  };
}

/** Whether the declared authority order says `from` outranks `to`, transitively. */
function dominates(authority, from, to) {
  const outranksOf = (id) => {
    const entry = authority.find((candidate) => isObject(candidate) && candidate.id === id);
    return Array.isArray(entry?.outranks) ? entry.outranks.filter(isText) : [];
  };
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    for (const next of outranksOf(queue.shift())) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/** The claims nothing else outranks. A cycle leaves none, which is a conflict, not a pick. */
function maximal(ids, authority) {
  const dominated = new Set();
  for (const from of ids) for (const to of ids) if (from !== to && dominates(authority, from, to)) dominated.add(to);
  return ids.filter((id) => !dominated.has(id));
}

function assess(record, { asOf, knownAt, required }) {
  const applicability = record?.applicability;
  if (!isObject(applicability)) return { state: 'unknown', reason: 'no-applicability' };
  if (!isText(applicability.recordedFrom)) return { state: 'unknown', reason: 'no-recording-date' };
  if (applicability.recordedFrom > knownAt) return { state: 'excluded', reason: 'not-known' };
  if (isText(applicability.recordedTo) && applicability.recordedTo <= knownAt) return { state: 'excluded', reason: 'recording-closed' };
  if (!isText(applicability.validFrom)) return { state: 'unknown', reason: 'no-effective-start' };
  if (applicability.validFrom > asOf) return { state: 'excluded', reason: 'not-yet' };
  if (isText(applicability.validTo) && applicability.validTo <= asOf) return { state: 'excluded', reason: 'expired' };

  const scope = isObject(applicability.scope) ? applicability.scope : {};
  for (const [key, entry] of Object.entries(required)) {
    if (!isText(scope[key])) return { state: 'unknown', reason: `scope-missing:${key}` };
    if (scope[key] !== entry.value) return { state: 'excluded', reason: `scope-mismatch:${key}` };
  }
  return { state: 'applicable' };
}

/**
 * What applied, at a time, according to what was known at another.
 *
 * @param {object[]} claims records carrying `applicability` (see `readApplicability`)
 * @param {{subject: string, predicate: string, asOf: string, knownAt: string, scope?: object, authority?: {id: string, outranks: string[]}[], revision?: string|null}} options
 * @returns {object}
 */
export function applicableClaims(claims = [], options = {}) {
  const { subject, predicate, asOf, knownAt, scope = {}, authority = [], revision = null } = options;
  // A query without a question is a request for "the" claim, which is how latest-wins gets
  // in; a query without both times cannot be answered bitemporally at all.
  if (!isText(subject) || !isText(predicate)) throw new Error('a validity query needs a subject and a predicate');
  if (!isDay(asOf)) throw new Error('asOf must be an ISO date (YYYY-MM-DD): a claim set is not an answer without a time');
  if (!isDay(knownAt)) throw new Error('knownAt must be an ISO date (YYYY-MM-DD): what was true is not what was known');

  const required = Object.fromEntries(
    Object.entries(scope)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, { value }]),
  );

  const rows = (Array.isArray(claims) ? claims : [])
    .filter((record) => isObject(record) && record.subject === subject && record.predicate === predicate)
    .map((record) => ({ record, ...assess(record, { asOf, knownAt, required }) }));

  const unknown = rows.filter((row) => row.state === 'unknown').map((row) => ({ id: row.record.id, reason: row.reason }));
  const excluded = rows.filter((row) => row.state === 'excluded').map((row) => ({ id: row.record.id, reason: row.reason }));
  const inForce = rows.filter((row) => row.state === 'applicable').map((row) => row.record);

  // Explicit supersession is a statement about replacement, and it is applied before
  // authority: a repealed claim is not in the running to be outranked.
  const superseded = new Set(inForce.flatMap((record) => (Array.isArray(record.applicability?.supersedes) ? record.applicability.supersedes : [])));
  const mutual = inForce.length > 0 && inForce.every((record) => superseded.has(record.id));
  const remaining = mutual ? [] : inForce.filter((record) => !superseded.has(record.id));

  const ids = remaining.map((record) => record.id);
  const winners = maximal(ids, authority).sort();
  const byId = new Map(remaining.map((record) => [record.id, record]));
  const resolved = winners.map((id) => byId.get(id));

  let result;
  const reasons = [];
  if (mutual) {
    result = 'conflict';
    reasons.push(`${inForce.length} claims in force each supersede another; replacement with no survivor is a conflict`);
  } else if (unknown.length > 0) {
    result = 'unknown';
    reasons.push(`${unknown.length} claim(s) cannot be placed at ${asOf}, so the answer is incomplete rather than settled`);
  } else if (rows.length === 0) {
    result = 'empty';
    reasons.push(`no claim states ${subject} ${predicate}`);
  } else if (remaining.length === 0) {
    // Claims exist and none is in force: that is an answer, and it is `none`, not a
    // conflict among an empty set.
    result = 'none';
    reasons.push(`claims state ${subject} ${predicate} but none applies at ${asOf} knowing what was known at ${knownAt}`);
  } else if (resolved.length === 0) {
    result = 'conflict';
    reasons.push('the declared authority order leaves no claim unranked; a cycle is not a winner');
  } else if (resolved.length === 1 && remaining.length === 1) {
    result = 'applicable';
    reasons.push(`one claim applies at ${asOf} and nothing supersedes or outranks it`);
  } else if (resolved.length === 1) {
    result = 'applicable';
    reasons.push(`${remaining.length} claims apply at ${asOf} and the declared order leaves one of them unranked`);
  } else if (resolved.length > 1) {
    result = 'conflict';
    reasons.push(`${resolved.length} claims apply at ${asOf} and no declared order ranks them: a conflict set, not the newest`);
  } else {
    result = 'none';
    reasons.push(`claims state ${subject} ${predicate} but none applies at ${asOf} knowing what was known at ${knownAt}`);
  }

  return {
    version: CLAIMS_SCHEMA_VERSION,
    question: { subject, predicate },
    asOf,
    knownAt,
    scope: { ...Object.fromEntries(Object.entries(required).map(([key, entry]) => [key, entry.value])) },
    revision,
    result,
    claims: result === 'unknown' ? [] : resolved,
    tentative: result === 'unknown' ? resolved : [],
    unknown,
    excluded,
    reasons,
  };
}
