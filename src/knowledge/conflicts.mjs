// Contradictions among structured claims, and the obligation each one leaves behind.
//
// "These two documents disagree" is only useful if the tool can say *why*. Two rates of
// 19 % and 21 % for Germany in 2024 contradict each other; a German rate and a French one do
// not; a 2023 rate and a 2024 rate do not; `19` and `0.19` cannot be compared without a unit
// conversion nobody declared. Reporting all five as "conflict" trains a reader to ignore the
// report, and reporting none of them certifies prose nobody read.
//
// So a pair of claims is compared on four axes in a fixed order - type, unit, scope, period,
// then value within a declared tolerance - and every pair gets a verdict, including `same`.
// A disagreement whose scope or period cannot be established is `indeterminate`, which is a
// question for a person, not a finding about the world.
//
// What this module does not do is read prose. There is no natural-language detector here;
// its absence is reported in the result, next to a `certifies: false` that says a clean
// machine finding set is not a statement about the document.

import { SCOPE_FIELDS } from './validity.mjs';

export const CONFLICT_SCHEMA_VERSION = 1;

/** Every verdict a pair can receive. Only `contradiction` is a finding about the world. */
export const CONFLICT_VERDICTS = Object.freeze([
  'same',
  'contradiction',
  'different-scope',
  'different-period',
  'different-unit',
  'incomparable',
  'indeterminate',
]);

/** An open interval end, so a claim without a `validTo` still compares. */
const OPEN_END = '9999-12-31';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const normalise = (value) => String(value ?? '').normalize('NFKC').trim();

const unitOf = (record) => (isText(record?.unit) ? normalise(record.unit).toLowerCase() : '');

/**
 * Compare the scopes two claims declare.
 *
 * A dimension both declare and disagree on is a difference, not a contradiction. A dimension
 * one declares and the other leaves open is unknown: the open one might be about the same
 * population, and guessing either way is how a false conflict or a false clearance happens.
 */
function scopeRelation(left, right) {
  const a = isObject(left) ? left : {};
  const b = isObject(right) ? right : {};
  let unknown = false;
  for (const key of SCOPE_FIELDS) {
    if (isText(a[key]) && isText(b[key])) {
      if (normalise(a[key]) !== normalise(b[key])) return { state: 'different', key };
      continue;
    }
    if (isText(a[key]) !== isText(b[key])) unknown = true;
  }
  return { state: unknown ? 'unknown' : 'same' };
}

/** Whether two effective intervals share a day. Missing starts are unknown, not infinite. */
function periodRelation(left, right) {
  const a = isObject(left) ? left : {};
  const b = isObject(right) ? right : {};
  if (!isDay(a.validFrom) || !isDay(b.validFrom)) return { state: 'unknown' };
  const endA = isDay(a.validTo) ? a.validTo : OPEN_END;
  const endB = isDay(b.validTo) ? b.validTo : OPEN_END;
  return { state: a.validFrom < endB && b.validFrom < endA ? 'overlap' : 'disjoint' };
}

function valuesAgree(left, right, tolerance) {
  if (left.type === 'number') return Math.abs(left.value - right.value) <= tolerance;
  if (left.type === 'string') return normalise(left.value) === normalise(right.value);
  return left.value === right.value;
}

/**
 * The tolerance a question declares. Only numbers have one, and its default is zero: a tool
 * that invented a tolerance would be deciding how much a rate may drift.
 */
function toleranceFor(tolerances, subject, predicate) {
  const entry = (Array.isArray(tolerances) ? tolerances : []).find(
    (candidate) => isObject(candidate) && normalise(candidate.subject) === subject && normalise(candidate.predicate) === predicate,
  );
  return entry !== undefined && Number.isFinite(entry.absolute) && entry.absolute >= 0 ? entry.absolute : 0;
}

/** The four axes, in the order that decides which verdict a reader gets. */
function compare(left, right, tolerance) {
  if (left.type !== right.type) {
    return { verdict: 'incomparable', obligation: 'type:align', reason: `a ${left.type} and a ${right.type} cannot be compared` };
  }
  if (unitOf(left) !== unitOf(right)) {
    return { verdict: 'different-unit', obligation: 'unit:align', reason: `units ${JSON.stringify(left.unit ?? null)} and ${JSON.stringify(right.unit ?? null)} need a declared conversion` };
  }

  const scope = scopeRelation(left.applicability?.scope, right.applicability?.scope);
  if (scope.state === 'different') {
    return { verdict: 'different-scope', obligation: null, reason: `scope.${scope.key} differs, so these are claims about different populations` };
  }

  const period = periodRelation(left.applicability, right.applicability);
  if (period.state === 'disjoint') {
    return { verdict: 'different-period', obligation: null, reason: 'the effective intervals do not overlap, so these are successive claims' };
  }

  if (valuesAgree(left, right, tolerance)) {
    return { verdict: 'same', obligation: null, reason: tolerance > 0 ? `values agree within the declared tolerance of ${tolerance}` : 'values are identical' };
  }
  if (scope.state === 'unknown') {
    return { verdict: 'indeterminate', obligation: 'scope:establish', reason: 'the values differ but one claim leaves a scope dimension the other declares open' };
  }
  if (period.state === 'unknown') {
    return { verdict: 'indeterminate', obligation: 'date:establish', reason: 'the values differ but an effective start is missing, so the claims may be successive' };
  }
  return { verdict: 'contradiction', obligation: 'resolve:value', reason: 'both are in force for the same scope and their values differ' };
}

/** The declaration that says who settles a question, and what depends on it. */
function policyFor(policies, subject, predicate) {
  const entry = (Array.isArray(policies) ? policies : []).find(
    (candidate) => isObject(candidate) && normalise(candidate.subject) === subject && normalise(candidate.predicate) === predicate,
  );
  return entry === undefined ? null : entry;
}

/**
 * Every pair of claims about one question, with a verdict and, where a person is needed,
 * the obligations that follow.
 *
 * @param {object[]} claims
 * @param {{tolerances?: {subject: string, predicate: string, absolute: number}[], policies?: {subject: string, predicate: string, owner?: string, outputs?: string[], decisionBy?: string}[]}} [options]
 * @returns {object}
 */
export function findConflicts(claims = [], { tolerances = [], policies = [] } = {}) {
  const groups = new Map();
  const skipped = [];

  for (const record of Array.isArray(claims) ? claims : []) {
    if (!isObject(record) || !isText(record.subject) || !isText(record.predicate) || !isText(record.type) || record.value === undefined) {
      skipped.push({ id: record?.id ?? null, reason: 'a claim needs a subject, a predicate, a type and a value to be compared' });
      continue;
    }
    const key = `${normalise(record.subject)}|${normalise(record.predicate)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const findings = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const left = group[i];
        const right = group[j];
        const subject = normalise(left.subject);
        const predicate = normalise(left.predicate);
        const verdict = compare(left, right, toleranceFor(tolerances, subject, predicate));
        const unresolved = verdict.verdict === 'contradiction' || verdict.verdict === 'indeterminate';
        const policy = policyFor(policies, subject, predicate);
        const owner = isText(policy?.owner) ? policy.owner : null;
        const outputs = Array.isArray(policy?.outputs) ? policy.outputs.filter(isText) : [];
        const obligations = [];
        if (verdict.obligation !== null) obligations.push(verdict.obligation);
        if (unresolved && owner === null) obligations.push('owner:assign');
        if (unresolved && outputs.length === 0) obligations.push('outputs:identify');

        findings.push({
          subject,
          predicate,
          claims: [left.id, right.id].sort(),
          verdict: verdict.verdict,
          reason: verdict.reason,
          owner,
          outputs,
          decisionBy: isText(policy?.decisionBy) ? policy.decisionBy : null,
          obligations,
        });
      }
    }
  }

  const verdicts = Object.fromEntries(CONFLICT_VERDICTS.map((verdict) => [verdict, 0]));
  for (const finding of findings) verdicts[finding.verdict] += 1;

  return {
    version: CONFLICT_SCHEMA_VERSION,
    groups: [...groups.keys()],
    findings,
    pairs: findings.length,
    verdicts,
    conflicts: verdicts.contradiction,
    skipped,
    prose: { detector: 'natural-language', status: 'not-installed', assessed: 0 },
    // A machine finding set is a statement about declared claims. It is not a statement
    // that the documents are consistent, and no style or confidence field on a claim can
    // make it one.
    certifies: false,
  };
}
