// Obligation-aware incremental gate selection (W27).
//
// `simt gate --changed` already answers a code question: which tests import this file, directly
// or through others. That answer is right, and this module does not change it — the source
// closure is the same call, so a repository that opts into nothing sees the same selection it
// saw yesterday.
//
// What it adds is the other half of a change. A modified requirement document, template, claim
// or recipe has no importer, and running the whole suite because of that is not caution: it is
// an unaffordable gate that gets skipped. So a typed obligation names the validators that can
// discharge it, and selection becomes:
//
//   * mandatory validators first, because a mandatory check is not a candidate;
//   * a greedy set cover over what remains, by uncovered obligations per unit cost, only among
//     validators that could discharge them;
//   * independence preserved: an obligation that needs two independent validators does not
//     accept two from the same provider, however cheap the pair is;
//   * an unknown dependency expands to the scope the repository declared for it — a prefix, not
//     the full suite — and the expansion is reported as an expansion.
//
// The status is the part a reader acts on. `no-op` on a clean diff, `ok` when something was
// selected, and `unverified` when a non-empty change has no admissible validator: the last one
// is never rendered as a green verification, because "nothing ran" and "everything passed" are
// the two answers this module exists to keep apart.

import { coverage } from '../index/coverage.mjs';

export const SELECTION_SCHEMA_VERSION = 1;

/** The only statuses a selection may report. `unverified` is not a pass. */
export const SELECTION_STATUSES = Object.freeze(['no-op', 'ok', 'unverified']);

/** The three classes a check belongs to, reported separately. */
export const CHECK_CLASSES = Object.freeze(['source', 'document', 'remote']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const byId = (a, b) => a.id.localeCompare(b.id);

/** Independence has to be declared. An unspecified provider is one provider, not many. */
const providerOf = (validator) => (isText(validator?.provider) ? validator.provider : 'unspecified');

/** A declared scope entry is a path prefix; a glob would be a second matching language. */
const inScope = (path, scope) => scope.some((prefix) => path === prefix || path.startsWith(prefix));

/**
 * Select the checks that prove what this change touched.
 *
 * @param {object} input
 * @returns {object}
 */
export function selectVerification({
  changed = [],
  imports = [],
  closure = null,
  typed = [],
  validators = [],
  scope = [],
} = {}) {
  const paths = [...new Set((Array.isArray(changed) ? changed : []).filter(isText))].sort();
  const pool = (Array.isArray(validators) ? validators : []).filter((validator) => isObject(validator) && isText(validator.id));
  const obligations = (Array.isArray(typed) ? typed : []).filter((entry) => isObject(entry) && isText(entry.id));
  const declaredScope = (Array.isArray(scope) ? scope : []).filter(isText);

  // The existing code selection, unchanged: the caller may hand in the closure it already
  // computed, and otherwise this is the same call the gate command makes.
  const source = new Set(Array.isArray(closure) ? closure : coverage({ imports }, paths));

  const plan = [];
  const reasons = [];
  const unverified = [];
  const chosen = new Set();
  const obligationIds = new Set(obligations.map((entry) => entry.id));
  const covered = new Map();

  const take = (validator, basis, obligation) => {
    if (chosen.has(validator.id)) return;
    chosen.add(validator.id);
    plan.push({
      id: validator.id,
      class: CHECK_CLASSES.includes(validator.class) ? validator.class : 'source',
      obligation: obligation ?? null,
      cost: Number.isFinite(validator.cost) ? validator.cost : 1,
      environment: isText(validator.environment) ? validator.environment : null,
      basis,
    });
    for (const id of Array.isArray(validator.covers) ? validator.covers : []) covered.set(id, (covered.get(id) ?? 0) + 1);
  };

  // Mandatory first: a mandatory validator is a floor, not a candidate for a cheaper choice.
  for (const validator of pool.filter((entry) => entry.mandatory === true).sort(byId)) {
    const obligation = (Array.isArray(validator.covers) ? validator.covers : []).find((id) => obligationIds.has(id)) ?? null;
    if (obligation !== null) take(validator, 'mandatory', obligation);
  }

  // Greedy cover of what is left, by uncovered obligations per unit cost. Ties fall to the id,
  // because an order that depends on array position is not reproducible across two runs.
  for (;;) {
    let best = null;
    for (const validator of pool) {
      if (chosen.has(validator.id)) continue;
      const gain = (Array.isArray(validator.covers) ? validator.covers : []).filter((id) => obligationIds.has(id) && !covered.has(id)).length;
      if (gain === 0) continue;
      const cost = Number.isFinite(validator.cost) && validator.cost > 0 ? validator.cost : 1;
      const score = gain / cost;
      if (best === null || score > best.score || (score === best.score && validator.id < best.validator.id)) best = { validator, score };
    }
    if (best === null) break;
    take(best.validator, 'cover', (Array.isArray(best.validator.covers) ? best.validator.covers : []).find((id) => obligationIds.has(id) && !covered.has(id)) ?? null);
  }

  for (const obligation of obligations) {
    if (obligation.needsIndependent === true) {
      const covering = () =>
        [...chosen]
          .map((id) => pool.find((validator) => validator.id === id))
          .filter((validator) => Array.isArray(validator?.covers) && validator.covers.includes(obligation.id));
      const providers = () => new Set(covering().map(providerOf));
      // The cover picks one validator per obligation; an independence requirement needs a
      // second from another provider, and taking only the cheapest would silently leave it
      // unmet while reporting `ok`.
      if (providers().size < 2) {
        const extra = pool
          .filter((validator) => !chosen.has(validator.id) && Array.isArray(validator.covers) && validator.covers.includes(obligation.id) && !providers().has(providerOf(validator)))
          .sort((a, b) => (Number.isFinite(a.cost) ? a.cost : 1) - (Number.isFinite(b.cost) ? b.cost : 1) || a.id.localeCompare(b.id))[0];
        if (extra !== undefined) take(extra, 'independence', obligation.id);
      }
      if (providers().size < 2) {
        unverified.push({ obligation: obligation.id, reason: 'insufficient-independent-validators' });
        continue;
      }
    }
    if (!covered.has(obligation.id)) {
      unverified.push({ obligation: obligation.id, reason: 'no-admissible-validator' });
    }
  }

  // A changed path no obligation claims is an unknown dependency. It expands to the declared
  // scope that covers it, and the expansion says so; it never expands to the whole suite.
  const claimedPaths = new Set(obligations.flatMap((entry) => (Array.isArray(entry.paths) ? entry.paths : [])));
  for (const path of paths) {
    if (claimedPaths.has(path)) continue;
    if (source.has(path)) continue;
    const scoped = pool.filter((validator) => Array.isArray(validator.scope) && inScope(path, validator.scope));
    if (scoped.length === 0) continue;
    for (const validator of scoped.sort(byId)) {
      if (!chosen.has(validator.id)) take(validator, 'scope-expansion', null);
    }
    reasons.push(`${path} has no declared obligation, so it expanded to ${scoped.map((validator) => validator.id).join(', ')}`);
  }

  const selected = Object.fromEntries(CHECK_CLASSES.map((name) => [name, []]));
  for (const id of source) selected.source.push(id);
  for (const entry of plan) selected[entry.class].push(entry.id);
  for (const name of CHECK_CLASSES) selected[name] = [...new Set(selected[name])].sort();

  const counts = { source: selected.source.length, document: selected.document.length, remote: selected.remote.length };
  const total = counts.source + counts.document + counts.remote;

  const optedIn = obligationIds.size > 0 || pool.some((validator) => validator.class !== 'source');
  const status = paths.length === 0 ? 'no-op' : optedIn && (unverified.length > 0 || total === 0) ? 'unverified' : 'ok';

  return {
    version: SELECTION_SCHEMA_VERSION,
    status,
    // Named so a caller cannot render `unverified` as a pass by reading the status loosely.
    claimsGreen: status === 'ok' && total > 0,
    changed: paths,
    selected,
    counts,
    plan: plan.sort((a, b) => a.id.localeCompare(b.id)),
    unverified: unverified.sort((a, b) => String(a.obligation).localeCompare(String(b.obligation))),
    environment: [...new Set(plan.map((entry) => entry.environment).filter(isText))].sort(),
    costs: { ...counts, total: plan.reduce((sum, entry) => sum + entry.cost, 0) },
    reasons,
  };
}

/**
 * Whether a verification run may execute what this selection holds.
 *
 * A Git hook runs on somebody's commit and must be quick and local; a remote validator belongs
 * to `simt verify run`, which a person invoked. The runner is the repository's own, always.
 *
 * @param {{invocation?: 'cli'|'git-hook', selected?: object}} input
 */
export function checkVerifyRun({ invocation = 'cli', selected = {} } = {}) {
  const remote = Array.isArray(selected?.remote) ? selected.remote : [];
  if (invocation === 'git-hook' && remote.length > 0) {
    return {
      ok: false,
      code: 'remote-from-hook',
      usesRepoRunner: true,
      detail: `a Git hook may not run remote validators: ${remote.join(', ')}`,
      // The remedy names where the read went, not a command: the executor is not this
      // package's, and a remedy citing a verb this binary cannot dispatch is a second problem.
      remedy: 'select and run them where a person invoked the check, not from a Git hook',
    };
  }
  return { ok: true, code: null, usesRepoRunner: true, executesRemote: invocation !== 'git-hook' && remote.length > 0, detail: null, remedy: null };
}
