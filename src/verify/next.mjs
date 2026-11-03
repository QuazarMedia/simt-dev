// Missing proof: the next question worth asking, and the point at which there is not one.
//
// When an obligation is unresolved, the failure mode is not ignorance — it is browsing. A
// reader re-reads what they already have, or dumps a whole target, because every action looks
// equally likely to help. This module answers the narrower question: of the capabilities this
// repository has declared, which one would discharge the most of what is missing, and at what
// price?
//
// The rules exist to keep that answer honest:
//
//   * Constraints are applied before ranking. A read the network forbids, an actor the caller
//     does not hold, or a cost above the budget is not a low-ranked option; it is not an
//     option, and it says which constraint removed it.
//   * Rankings use measured rates only when there are measurements. Without a denominator the
//     result says `basis: 'ordinal'` and `probability: null`; a number invented to make a
//     ranking look quantitative is worse than an ordinal estimate that admits what it is.
//   * A rank orders suggestions. Nothing here invokes a read, opens a socket or writes a
//     record: every offer is `status: 'suggested'` and `executed: false`, and stays that way
//     until a caller acts on it deliberately.
//   * When nothing admissible remains, the result stops. It names the obligation and the
//     missing capability or decision, and carries `retry: false` — a planner that returns the
//     same three options forever is how a loop starts.

export const NEXT_SCHEMA_VERSION = 1;

/** What a caller may be missing when no admissible action exists. */
export const MISSING_KINDS = Object.freeze(['capability', 'decision']);

/** A result state that still owes proof. `waived` and `not-applicable` are settled otherwise. */
const UNMET_STATES = new Set(['fail', 'unknown', 'unavailable', 'not-run']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Whether a declared capability claims to discharge this obligation. */
function discharges(capability, obligation) {
  const named = Array.isArray(capability.obligations) ? capability.obligations : null;
  const all = capability.coverage === 'all';
  if (named === null && !all) return false;
  if (named !== null && !named.includes(obligation.id)) return false;
  const kinds = Array.isArray(capability.predicateKinds) ? capability.predicateKinds : null;
  if (kinds !== null && obligation.predicate !== null && !kinds.includes(obligation.predicate)) return false;
  return true;
}

/**
 * Plan the next observation.
 *
 * @param {{obligations?: object[], capabilities?: object[], constraints?: object, history?: object[]}} input
 * @returns {object}
 */
export function planNext({ obligations = [], capabilities = [], constraints = {}, history = [] } = {}) {
  const unmet = (Array.isArray(obligations) ? obligations : [])
    .filter((obligation) => obligation !== null && typeof obligation === 'object' && isText(obligation.id) && UNMET_STATES.has(obligation.state))
    .map((obligation) => ({
      id: obligation.id,
      state: obligation.state,
      predicate: isText(obligation.predicate?.kind) ? obligation.predicate.kind : isText(obligation.predicate) ? obligation.predicate : null,
      requiresDecision: obligation.requiresDecision === true,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const measured = new Map();
  for (const record of Array.isArray(history) ? history : []) {
    if (record === null || typeof record !== 'object' || !isText(record.capability)) continue;
    const attempts = Math.max(0, Math.floor(Number(record.attempts) || 0));
    const successes = Math.max(0, Math.floor(Number(record.successes) || 0));
    // A rate with no denominator is not a measurement; it is not kept.
    if (attempts > 0) measured.set(record.capability, { attempts, successes: Math.min(successes, attempts) });
  }

  const excluded = [];
  const admissible = [];
  for (const capability of Array.isArray(capabilities) ? capabilities : []) {
    if (capability === null || typeof capability !== 'object' || !isText(capability.id)) {
      excluded.push({ id: null, reason: 'malformed' });
      continue;
    }
    if (capability.supported === false) {
      excluded.push({ id: capability.id, reason: 'unsupported' });
      continue;
    }
    if (capability.requiresNetwork === true && constraints.network === false) {
      excluded.push({ id: capability.id, reason: 'network' });
      continue;
    }
    if (isText(capability.requiresActor) && !(Array.isArray(constraints.actors) ? constraints.actors : []).includes(capability.requiresActor)) {
      excluded.push({ id: capability.id, reason: 'actor' });
      continue;
    }
    const cost = Number.isFinite(capability.cost) ? capability.cost : null;
    const budget = Number.isFinite(constraints.budget) ? constraints.budget : null;
    if (cost !== null && budget !== null && cost > budget) {
      excluded.push({ id: capability.id, reason: 'budget' });
      continue;
    }
    const covers = unmet.filter((obligation) => discharges(capability, obligation));
    if (covers.length === 0) {
      excluded.push({ id: capability.id, reason: unmet.length === 0 ? 'nothing-missing' : 'does-not-discharge' });
      continue;
    }
    admissible.push({ capability, covers, cost });
  }

  const offers = admissible
    .map(({ capability, covers, cost }) => {
      const expectedCoverage = unmet.length === 0 ? 0 : covers.length / unmet.length;
      const discrimination = Number.isFinite(capability.discrimination) ? clamp(capability.discrimination, 0, 1) : 0.5;
      const latency = Number.isFinite(capability.latency) ? Math.max(0.5, capability.latency) : 3;
      // An unknown cost is not free and not fatal: it is the neutral middle, labelled below.
      const priced = cost === null ? 2 : Math.max(0.5, cost);
      const record = measured.get(capability.id) ?? null;
      return {
        id: capability.id,
        kind: isText(capability.kind) ? capability.kind : 'unspecified',
        covers: covers.map((obligation) => obligation.id),
        obligation: covers[0].id,
        expectedCoverage,
        discrimination,
        latency,
        cost,
        latencyBasis: Number.isFinite(capability.latency) ? 'declared' : 'estimated',
        costBasis: cost === null ? 'unknown' : 'declared',
        // A rate appears only with its denominator, and only when the denominator exists.
        basis: record === null ? 'ordinal' : 'measured',
        probability: record === null ? null : record.successes / record.attempts,
        attempts: record === null ? null : record.attempts,
        score: (expectedCoverage * discrimination) / (latency * priced),
        status: 'suggested',
        executed: false,
        requiresInvocation: true,
      };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const covered = new Set(offers.flatMap((offer) => offer.covers));
  const uncovered = unmet.filter((obligation) => !covered.has(obligation.id));
  const stop =
    uncovered.length === 0
      ? null
      : {
          reason: 'no-admissible-action',
          retry: false,
          detail: `${uncovered.length} unresolved obligation(s) have no admissible action: ${uncovered.map((obligation) => obligation.id).join(', ')}`,
          missing: uncovered.map((obligation) => ({
            obligation: obligation.id,
            kind: obligation.requiresDecision ? 'decision' : 'capability',
            detail: obligation.requiresDecision
              ? 'no capability can settle this: it needs a decision a person makes'
              : `no declared capability discharges ${obligation.id} within the stated constraints`,
          })),
          remedy: 'declare a capability that can discharge it, relax a constraint, or record the decision that settles it',
        };

  return {
    version: NEXT_SCHEMA_VERSION,
    unmet,
    offers,
    excluded: excluded.sort((a, b) => String(a.id).localeCompare(String(b.id)) || a.reason.localeCompare(b.reason)),
    stop,
    invoked: false,
  };
}
