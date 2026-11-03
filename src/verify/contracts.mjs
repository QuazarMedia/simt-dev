// Outcome contracts: what "done" means, kept apart from whether the command exited zero.
//
// A green runner says a process finished; it does not say the obligation holds. The failures
// this module exists to prevent are the ones where those two are read as the same sentence:
//
//   * an HTTP 200 whose postcondition failed, reported as a pass because the call succeeded;
//   * a formatter run that proves a file is well-formed, reported as proof that a claim is
//     entailed;
//   * a unit test with a mocked dependency, reported as proof that a live predicate holds;
//   * a waiver, which is a reviewed decision not to require the evidence, counted as evidence.
//
// So an obligation names its own subject, predicate, applicability, severity, verifier,
// required assurance and the dependency revisions the evidence was produced at; an
// observation is a claim about what happened, never the answer; and the evaluation can return
// `pass` only when the observation is about this predicate, at this assurance, on these
// revisions. Everything else is one of `fail`, `unknown`, `unavailable`, `not-run`,
// `not-applicable` or `waived`, and only `pass` counts towards completion.
//
// The result states are internal. They are not ADR-008 review verdicts: `pass` is not
// APPROVE, and this module never emits a verdict word.

import { satisfiesScope } from '../knowledge/validity.mjs';

export const CONTRACT_SCHEMA_VERSION = 1;

/** Every state a result can have. Only `pass` counts towards completion. */
export const RESULT_STATES = Object.freeze(['pass', 'fail', 'unknown', 'unavailable', 'not-run', 'not-applicable', 'waived']);

export const SEVERITIES = Object.freeze(['mandatory', 'advisory']);

/**
 * How close an observation is to the real predicate.
 *
 * A separate axis from the capability assurance levels (ADR-142), which say what backs a
 * claim about enforcement. These say how much of the world the check actually touched:
 * `simulated` is a double standing in, `executed` is the code under test, `live` is the
 * deployed subject answering. An observation never upgrades itself and never exceeds the
 * ceiling its verifier kind can reach.
 */
export const VERIFICATION_ASSURANCE = Object.freeze(['simulated', 'executed', 'live']);

export const PREDICATE_KINDS = Object.freeze(['behaviour', 'entailment', 'format', 'availability']);

/** The verifier kinds that can settle each predicate, and the most each can ever establish. */
const VERIFIERS = new Map([
  ['behaviour', ['unit-test', 'integration-test', 'live-probe', 'manual-review']],
  ['entailment', ['entailment-check', 'manual-review']],
  ['format', ['formatter', 'linter']],
  ['availability', ['live-probe', 'manual-review']],
]);

const VERIFIER_CEILING = new Map([
  ['unit-test', 'simulated'],
  ['integration-test', 'executed'],
  ['live-probe', 'live'],
  ['entailment-check', 'executed'],
  ['formatter', 'executed'],
  ['linter', 'executed'],
  ['manual-review', 'executed'],
]);

const ASSURANCE_RANK = new Map(VERIFICATION_ASSURANCE.map((level, index) => [level, index]));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;

const problem = (id, issue, remedy) => ({ id: id ?? null, problem: issue, remedy });

/**
 * Read a contract, and say what is wrong with it in terms of what to change.
 *
 * A malformed contract is not evaluated leniently: an obligation missing its verifier or its
 * pinned revision cannot be satisfied by anything, and pretending otherwise is how a report
 * reads complete while a check was never specified.
 */
export function readContract(input = {}) {
  const raw = Array.isArray(input) ? input : Array.isArray(input?.obligations) ? input.obligations : null;
  const errors = [];
  const obligations = [];
  const seen = new Set();

  if (raw === null) {
    errors.push(problem(null, 'a contract needs an obligations array', 'pass { obligations: [...] }, one entry per obligation this change must satisfy'));
    return { version: CONTRACT_SCHEMA_VERSION, obligations, errors };
  }

  for (const item of raw) {
    if (!isObject(item)) {
      errors.push(problem(null, 'an obligation must be an object', 'write each obligation as { id, subject, predicate, severity, verifier, assurance }'));
      continue;
    }
    const id = item.id;
    if (!isText(id)) {
      errors.push(problem(null, 'an obligation has no id', 'give each obligation a stable id so an observation can be matched to it'));
      continue;
    }
    if (seen.has(id)) {
      errors.push(problem(id, `the id ${id} is used more than once`, 'rename one of them: an id identifies exactly one obligation'));
      continue;
    }
    // Recorded here, not on success: a duplicate is a duplicate whether or not the first
    // entry describing that id was itself valid.
    seen.add(id);
    if (!isText(item.subject)) {
      errors.push(problem(id, 'the obligation names no subject selector', 'name the file, artifact or object the obligation is about'));
      continue;
    }
    const predicate = item.predicate;
    if (!isObject(predicate) || !PREDICATE_KINDS.includes(predicate.kind) || !isText(predicate.statement)) {
      errors.push(problem(id, `the predicate must be one of ${PREDICATE_KINDS.join(', ')} with a statement`, 'state what must be true, not which command to run'));
      continue;
    }
    if (!SEVERITIES.includes(item.severity)) {
      errors.push(problem(id, `severity ${JSON.stringify(item.severity)} is not one of ${SEVERITIES.join(', ')}`, 'mark the obligation mandatory or advisory'));
      continue;
    }
    const verifier = item.verifier;
    if (!isObject(verifier) || !VERIFIER_CEILING.has(verifier.kind) || !isText(verifier.ref)) {
      errors.push(problem(id, 'the obligation names no verifier', `name a verifier (${[...VERIFIER_CEILING.keys()].join(', ')}) and the check that runs it`));
      continue;
    }
    if (!VERIFICATION_ASSURANCE.includes(item.assurance)) {
      errors.push(problem(id, `assurance ${JSON.stringify(item.assurance)} is not one of ${VERIFICATION_ASSURANCE.join(', ')}`, 'state how close the evidence must be to the real predicate'));
      continue;
    }
    const dependencies = Array.isArray(item.dependencies) ? item.dependencies : [];
    const badDependency = dependencies.find((dependency) => !isObject(dependency) || !isText(dependency.ref) || !isText(dependency.revision));
    if (badDependency !== undefined) {
      errors.push(problem(id, 'a dependency has no ref or no revision', 'pin the revision the evidence was produced at; an unpinned dependency cannot show what was tested'));
      continue;
    }
    obligations.push({
      id,
      subject: item.subject,
      predicate: { kind: predicate.kind, statement: predicate.statement },
      applicability: isObject(item.applicability) ? item.applicability : {},
      severity: item.severity,
      verifier: { kind: verifier.kind, ref: verifier.ref },
      assurance: item.assurance,
      dependencies: dependencies.map((dependency) => ({ ref: dependency.ref, revision: dependency.revision })),
    });
  }

  return { version: CONTRACT_SCHEMA_VERSION, obligations, errors };
}

const row = (obligation, state, reasons, extra = {}) => ({
  id: obligation.id,
  subject: obligation.subject,
  severity: obligation.severity,
  predicate: obligation.predicate,
  required: obligation.assurance,
  state,
  countsAsPass: state === 'pass',
  reasons,
  ...extra,
});

const unresolved = (obligation, state, reason, remedy) => row(obligation, state, [reason], { remedy });

/**
 * Evaluate one obligation against one observation.
 *
 * @param {object} obligation a row from `readContract`
 * @param {object|undefined} observation what the verifier reported
 * @param {{revisions?: Record<string, string>}} [options]
 */
export function evaluateObligation(obligation, observation, { revisions = {} } = {}) {
  if (!isObject(observation)) {
    return unresolved(obligation, 'not-run', 'no observation was recorded for this obligation', 'run the named verifier and record what it observed');
  }

  if (isObject(observation.waiver)) {
    const waiver = observation.waiver;
    if (!isText(waiver.reviewer) || !isText(waiver.reviewedAt) || !isText(waiver.reason)) {
      return unresolved(obligation, 'unknown', 'the waiver is not a reviewed decision', 'record who reviewed the waiver, when, and why; an unreviewed waiver is not a waiver');
    }
    return row(obligation, 'waived', [`waived by ${waiver.reviewer} on ${waiver.reviewedAt}: ${waiver.reason}`], { waiver });
  }

  // `evaluateObligation` is exported, so it must also accept an obligation that did not come
  // through `readContract`; a missing applicability is "no scope required", never a crash.
  const requiredScope = Object.entries(isObject(obligation.applicability) ? obligation.applicability : {}).filter(([, value]) => value !== undefined && value !== null);
  if (requiredScope.length > 0) {
    if (observation.applies === false) {
      const evidence = observation.applicabilityEvidence;
      // "Does not apply" is a finding, and a finding needs its evidence.
      if (!isObject(evidence) || evidence.kind !== 'predicate' || !isText(evidence.digest)) {
        return unresolved(obligation, 'unknown', 'the observation says the predicate does not apply but carries no predicate evidence', 'record the evidence that the predicate is inapplicable, or apply the obligation');
      }
      return row(obligation, 'not-applicable', ['the predicate was shown not to apply to this subject'], { evidence });
    }
    if (observation.applies !== true) {
      return unresolved(obligation, 'unknown', 'the observation does not say whether the predicate applies', 'state applicability in the observation: nothing else can be concluded without it');
    }
    const relation = satisfiesScope(observation.scope, requiredScope);
    if (relation === 'conflict') {
      return unresolved(obligation, 'unknown', 'the observation was made in a scope the obligation does not cover', 're-run the verifier in the obligation\'s scope');
    }
    if (relation === 'unknown') {
      return unresolved(obligation, 'unknown', 'the observation does not state the scope it was made in', 'record the scope on the observation');
    }
  }

  for (const dependency of Array.isArray(obligation.dependencies) ? obligation.dependencies : []) {
    const observed = Array.isArray(observation.dependencies) ? observation.dependencies.find((entry) => entry?.ref === dependency.ref) : undefined;
    if (!isObject(observed) || !isText(observed.revision)) {
      return unresolved(obligation, 'unknown', `the observation does not report ${dependency.ref}`, `record the revision of ${dependency.ref} the verifier ran against`);
    }
    if (observed.revision !== dependency.revision) {
      return unresolved(obligation, 'unknown', `${dependency.ref} was tested at ${observed.revision}, the obligation pins ${dependency.revision}`, `re-run the verifier against ${dependency.revision}`);
    }
    if (revisions[dependency.ref] !== undefined && revisions[dependency.ref] !== dependency.revision) {
      return unresolved(obligation, 'unknown', `${dependency.ref} has moved to ${revisions[dependency.ref]} since the obligation was written`, `re-pin the obligation and re-run the verifier against ${revisions[dependency.ref]}`);
    }
  }

  const observedVerifier = isObject(observation.verifier) ? observation.verifier : undefined;
  if (observedVerifier !== undefined && (observedVerifier.kind !== obligation.verifier.kind || observedVerifier.ref !== obligation.verifier.ref)) {
    return unresolved(
      obligation,
      'unknown',
      `the observation came from ${observedVerifier.kind} ${observedVerifier.ref}, the obligation names ${obligation.verifier.kind} ${obligation.verifier.ref}`,
      `run ${obligation.verifier.kind} ${obligation.verifier.ref}, or change the obligation to name the check that exists`,
    );
  }

  const accepted = VERIFIERS.get(obligation.predicate.kind) ?? [];
  if (!accepted.includes(obligation.verifier.kind)) {
    return unresolved(obligation, 'unknown', `a ${obligation.verifier.kind} run cannot settle a ${obligation.predicate.kind} predicate`, `use one of ${accepted.join(', ')} for this predicate`);
  }

  if (observation.postcondition === 'failed') {
    return row(obligation, 'fail', ['the postcondition was observed to fail' + (observation.transport === 'ok' ? ' even though the transport succeeded' : '')], { remedy: 'fix the predicate, or the observation is confirming a failure that needs a change' });
  }
  if (observation.state === 'pass' && observation.postcondition !== 'passed') {
    return unresolved(obligation, 'unknown', `${observation.transport ?? 'the runner'} reported success, but the postcondition was not evaluated`, 'evaluate the postcondition; a successful command is not a satisfied obligation');
  }

  const ceiling = VERIFIER_CEILING.get(observation.verifier?.kind ?? obligation.verifier.kind);
  const claimed = observation.assurance;
  if (!VERIFICATION_ASSURANCE.includes(claimed)) {
    return unresolved(obligation, 'unknown', 'the observation does not state its assurance', `state one of ${VERIFICATION_ASSURANCE.join(', ')}`);
  }
  const effective = ASSURANCE_RANK.get(claimed) > ASSURANCE_RANK.get(ceiling) ? ceiling : claimed;
  if (ASSURANCE_RANK.get(effective) < ASSURANCE_RANK.get(obligation.assurance)) {
    return unresolved(obligation, 'unknown', `${observation.verifier?.kind ?? obligation.verifier.kind} evidence reaches ${effective}; the obligation requires ${obligation.assurance}`, `verifiy at ${obligation.assurance} assurance, or lower the requirement with a review`);
  }

  if (!['pass', 'fail', 'unknown', 'unavailable'].includes(observation.state)) {
    return unresolved(obligation, 'unknown', `${JSON.stringify(observation.state)} is not a result an observation can report`, `report one of pass, fail, unknown or unavailable`);
  }
  const extra = { assurance: effective };
  if (effective !== claimed) extra.reasons?.(null); // no-op guard: reasons are carried in the row
  const reasons = effective !== claimed ? [`the claimed ${claimed} assurance is capped at ${effective} by ${observation.verifier?.kind ?? obligation.verifier.kind}`] : [];
  const result = row(obligation, observation.state, reasons, extra);
  if (observation.state !== 'pass') result.remedy = observation.state === 'fail' ? 'fix the predicate the verifier exercised' : 'the verifier could not decide; supply the evidence it lacked';
  return result;
}

/**
 * Evaluate a whole contract.
 *
 * Completion is not a count and not a majority: every applicable mandatory obligation must
 * be `pass`, at its required assurance, on its pinned revisions. A waiver is reported and
 * never counted, and an advisory failure is reported without blocking.
 */
export function evaluateObligations(contractInput = {}, observations = [], options = {}) {
  const contract = readContract(contractInput);
  const byId = new Map((Array.isArray(observations) ? observations : []).filter((observation) => isText(observation?.id)).map((observation) => [observation.id, observation]));
  const errors = [...contract.errors];

  const known = new Set(contract.obligations.map((obligation) => obligation.id));
  for (const id of byId.keys()) {
    if (!known.has(id)) errors.push(problem(id, 'an observation names an obligation the contract does not have', 'add the obligation, or remove the observation: an observation with no requirement proves nothing'));
  }

  const rows = contract.obligations.map((obligation) => evaluateObligation(obligation, byId.get(obligation.id), options));
  const counts = Object.fromEntries(RESULT_STATES.map((state) => [state, 0]));
  for (const result of rows) counts[result.state] += 1;

  const mandatory = rows.filter((result) => result.severity === 'mandatory');
  const applicable = mandatory.filter((result) => result.state !== 'not-applicable');
  const complete = errors.length === 0 && applicable.every((result) => result.state === 'pass');
  const remedies = [...new Set([...errors.map((error) => error.remedy), ...rows.filter((result) => result.state !== 'pass' && result.state !== 'not-applicable').map((result) => result.remedy).filter(isText)])];

  return {
    version: CONTRACT_SCHEMA_VERSION,
    complete,
    blocked: errors.length > 0,
    counts,
    rows,
    errors,
    remedies,
    // Named so nobody mistakes this for a review: ADR-008 verdicts are a human judgement of
    // a diff, and no arrangement of observations produces one.
    review: 'not-a-review-verdict',
  };
}
