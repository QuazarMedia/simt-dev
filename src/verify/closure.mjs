// Closure reports (W29): what is complete, under which schema, with what evidence.
//
// "Complete" is the word a reader trusts without checking, so it is the word this module spends
// its rules on. Four failures shaped them:
//
//   * a required eight-check closure reported 6/8 as progress, and progress was read as done;
//   * an obligation whose live verifier could not be reached was recorded as passed because the
//     local half had passed, which is a claim about a target nobody contacted;
//   * a remote-only task was closed by inventing a code diff to attach to the receipt set,
//     because the closure format assumed one existed;
//   * a new completion rule shipped in the same field old consumers were already reading.
//
// So completion is unanimous over the obligations that are actually required, an unavailable
// state is never a pass, a remote-only closure carries its reviewed contract and receipts and
// explicitly no diff, and the semantic version is part of the output: `simt.closure/1` keeps the
// `complete`/`checks` contract old consumers were built against, and `simt.closure/2` adds the
// verdict, the completion kind and the unresolved list beside it.
//
// The module reads no clock and no filesystem; every fact arrives as a record.

export const CLOSURE_SCHEMA_VERSION = 2;

/** The two completion shapes a caller may ask for. */
export const CLOSURE_SCHEMAS = Object.freeze({ 1: 'simt.closure/1', 2: 'simt.closure/2' });

/** The scopes a closure may be reported for. */
export const CLOSURE_SCOPES = Object.freeze(['source', 'remote', 'both']);

/**
 * How bad each result state is when several records describe one obligation.
 *
 * `pass` is a floor, not a default: one record saying the live verifier was unreachable makes
 * the obligation unreachable, whatever another record says. A waiver outranks `not-applicable`
 * because a waived obligation is still owed, just excused.
 */
const PRECEDENCE = new Map([
  ['pass', 0],
  ['not-applicable', 1],
  ['waived', 2],
  ['unknown', 3],
  ['not-run', 4],
  ['unavailable', 5],
  ['fail', 6],
]);

const STATE_REASON = {
  fail: 'the obligation was observed to fail',
  unavailable: 'unavailable evidence is not a pass: the verifier could not be reached',
  'not-run': 'the obligation was never checked',
  unknown: 'the evidence does not settle the obligation',
  waived: 'a waiver is a reviewed excuse, not a pass',
  'not-applicable': 'the obligation does not apply to this subject',
};

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const worse = (a, b) => ((PRECEDENCE.get(b) ?? 3) > (PRECEDENCE.get(a) ?? 3) ? b : a);

/**
 * The state of one obligation, across every record that mentions it.
 *
 * @param {object} obligation
 * @param {object[]} evidence
 */
export function resolveObligationState(obligation, evidence = []) {
  const id = obligation?.id;
  let state = isText(obligation?.state) ? obligation.state : 'unknown';
  for (const record of Array.isArray(evidence) ? evidence : []) {
    if (!isObject(record)) continue;
    if (record.obligation !== id && record.id !== id) continue;
    state = worse(state, isText(record.state) ? record.state : 'unknown');
  }
  return state;
}

/**
 * Report closure for a change or a remote task.
 *
 * @param {object} input
 * @returns {object}
 */
export function closureReport({
  version = CLOSURE_SCHEMA_VERSION,
  scope = 'source',
  obligations = [],
  evidence = [],
  required = null,
  contract = null,
  changes = [],
  receipts = [],
  outcomeDigest = null,
  sha = null,
  documentedBlock = null,
} = {}) {
  if (CLOSURE_SCHEMAS[version] === undefined) throw new Error(`closure schema version ${JSON.stringify(version)} is not one of ${Object.keys(CLOSURE_SCHEMAS).join(', ')}`);
  if (!CLOSURE_SCOPES.includes(scope)) throw new Error(`closure scope ${JSON.stringify(scope)} is not one of ${CLOSURE_SCOPES.join(', ')}`);

  const list = (Array.isArray(obligations) ? obligations : []).filter((obligation) => isObject(obligation) && isText(obligation.id));
  const receiptList = (Array.isArray(receipts) ? receipts : []).filter((receipt) => isText(receipt) || isObject(receipt));
  const changed = (Array.isArray(changes) ? changes : []).filter(isText);
  const inScope = (obligation) => scope === 'both' || scope === 'remote' || (obligation.basis ?? 'local') === 'local';

  const requiredIds =
    required === null
      ? new Set(list.filter((obligation) => obligation.severity !== 'advisory' && obligation.required !== false && inScope(obligation)).map((obligation) => obligation.id))
      : new Set((Array.isArray(required) ? required : []).filter(isText));

  const checks = list
    .map((obligation) => {
      const state = resolveObligationState(obligation, evidence);
      return {
        id: obligation.id,
        state,
        required: requiredIds.has(obligation.id),
        basis: obligation.basis ?? 'local',
        reason: STATE_REASON[state] ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const requiredChecks = checks.filter((check) => check.required);
  const passed = requiredChecks.filter((check) => check.state === 'pass').length;
  const unresolved = requiredChecks.filter((check) => check.state !== 'pass');

  const reasons = [];
  let complete = requiredChecks.length > 0 && unresolved.length === 0;
  if (requiredChecks.length === 0) reasons.push('no obligation is required for this closure, so nothing has been shown complete');
  if (unresolved.length > 0) reasons.push(`${unresolved.length} of ${requiredChecks.length} required obligation(s) are unresolved: ${unresolved.map((check) => check.id).join(', ')}`);

  // A local change may document an external block without claiming the remote part is done.
  // The block is reported, and it blocks only a closure that claims the remote scope.
  const externalBlocked = checks.filter((check) => {
    const obligation = list.find((entry) => entry.id === check.id);
    return check.state !== 'pass' && obligation?.external === true;
  });
  const documented = externalBlocked.length > 0 && isObject(documentedBlock) && isText(documentedBlock.ref);
  if (documented) reasons.push(`external block documented at ${documentedBlock.ref}`);
  if (externalBlocked.length > 0 && (scope === 'remote' || scope === 'both')) {
    complete = false;
    reasons.push(`the closure claims the remote scope, and ${externalBlocked.length} external obligation(s) are unresolved`);
  }

  const remoteOnly = changed.length === 0 && (scope === 'remote' || scope === 'both');
  if (complete && remoteOnly) {
    if (!isObject(contract) || contract.reviewed !== true) {
      complete = false;
      reasons.push('a remote-only closure needs a reviewed contract commit; a local tree is not evidence about a target');
    }
  }

  const optedIn = isObject(contract) && contract.optedIn === true;
  if (complete && optedIn && outcomeDigest === null && receiptList.length === 0) {
    complete = false;
    reasons.push('an opted-in contract records completion with an outcome digest or a receipt set; neither is present');
  }

  if (complete) reasons.push(remoteOnly ? 'remote-only completion: no code diff is claimed' : 'source closure: every required obligation passed');
  if (remoteOnly && complete) reasons.push('the reviewed contract commit and the receipt set are the completion record; no diff is fabricated');

  const verdict = complete ? 'COMPLETE' : 'BLOCK';
  const coverage = { required: requiredChecks.length, passed, total: checks.length };
  const completion = complete
    ? {
        kind: remoteOnly ? 'remote' : 'source',
        contract: isObject(contract) ? { commit: contract.commit ?? null, digest: contract.digest ?? null, reviewed: contract.reviewed === true } : null,
        receipts: receiptList,
        // Never synthesized: a remote-only closure has no code diff, and one invented to make
        // the report look like a code closure is a false claim about what changed.
        codeDiff: null,
      }
    : null;

  if (version === 1) {
    // The shape old consumers were built against: `complete`, the counts, the sha. Adding
    // `verdict` or `completion` here would change the contract they parse, so v1 keeps the
    // fields it always had - the new semantics are only in v2.
    return { schema: CLOSURE_SCHEMAS[1], version: 1, complete, sha, checks: { passed, total: requiredChecks.length } };
  }

  return {
    schema: CLOSURE_SCHEMAS[2],
    version: 2,
    verdict,
    complete,
    scope,
    completion,
    coverage,
    checks,
    unresolved: unresolved.map((check) => ({ id: check.id, state: check.state, reason: check.reason })),
    blocked: { external: externalBlocked.map((check) => check.id).sort(), documentedAt: documented ? documentedBlock.ref : null },
    changed,
    sha,
    outcomeDigest,
    reasons,
  };
}
