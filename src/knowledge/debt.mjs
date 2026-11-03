// Value-of-information and knowledge-debt reports (W47).
//
// Maintenance should go where missing evidence costs the most. The failures this module exists to
// prevent:
//
//   * a cosmetic orphan outranking a stale source that obligations depend on;
//   * a score whose components nobody can see, so a rank change cannot be explained;
//   * a probability invented for a frequency nobody measured;
//   * confidential queries leaking through an aggregate;
//   * a cold-start report presented as if usage had been observed.

/** The declared weights. Changing one is a reviewable change, not a tuning knob. */
export const DEFAULT_WEIGHTS = Object.freeze({ obligations: 3, criticality: 2, queries: 1, effort: 1 });

const CRITICALITY = Object.freeze({ low: 1, normal: 2, high: 4, critical: 8 });
const QUERY_CAP = 10;

const isText = (value) => typeof value === 'string' && value.length > 0;

/**
 * One item of knowledge debt.
 *
 * @param {object} input
 */
export function debtItem({
  id = null,
  kind = 'stale',
  affectedObligations = 0,
  criticality = 'normal',
  queries = 0,
  effort = 1,
  confidential = false,
} = {}) {
  if (!isText(id)) throw new Error('a debt item needs an id');
  return {
    id,
    kind,
    affectedObligations: Math.max(0, Number(affectedObligations) || 0),
    criticality: CRITICALITY[criticality] === undefined ? 'normal' : criticality,
    queries: Math.max(0, Number(queries) || 0),
    effort: Math.max(1, Number(effort) || 1),
    confidential: confidential === true,
    coldStart: (Number(queries) || 0) === 0,
  };
}

/**
 * The score, with its components, so a rank is explainable.
 *
 * No probability is computed anywhere: a frequency nobody measured is capped and counted, not
 * turned into a likelihood.
 *
 * @param {object} item
 * @param {object} weights
 */
export function score(item, weights = DEFAULT_WEIGHTS) {
  const components = {
    obligations: (item.affectedObligations ?? 0) * (weights.obligations ?? 0),
    criticality: (CRITICALITY[item.criticality] ?? CRITICALITY.normal) * (weights.criticality ?? 0),
    queries: Math.min(item.queries ?? 0, QUERY_CAP) * (weights.queries ?? 0),
  };
  const gross = components.obligations + components.criticality + components.queries;
  const total = gross / Math.max(1, (item.effort ?? 1) * (weights.effort ?? 1));
  return { total: Number(total.toFixed(4)), components, effort: item.effort ?? 1 };
}

/**
 * Rank the debt, highest first, ties by id so two runs agree.
 *
 * @param {object[]} items
 * @param {{weights?: object}} options
 */
export function rank(items = [], { weights = DEFAULT_WEIGHTS } = {}) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => isText(item?.id))
    .map((item) => {
      const computed = score(item, weights);
      return {
        ...item,
        score: computed.total,
        components: computed.components,
        reasons: [
          `${item.affectedObligations} obligation(s) affected`,
          `criticality ${item.criticality}`,
          `${item.queries} recorded query/queries${item.coldStart ? ' (cold start: none recorded)' : ''}`,
          `refresh effort ${item.effort}`,
        ],
      };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * What changes when one weight moves, and why.
 *
 * @param {object[]} items
 * @param {{weights?: object, field?: string, to?: number}} input
 */
export function weightSensitivity(items = [], { weights = DEFAULT_WEIGHTS, field = null, to = null } = {}) {
  if (!isText(field) || !Number.isFinite(to)) throw new Error('a sensitivity report needs the weight field and its new value');
  const before = rank(items, { weights }).map((entry) => entry.id);
  const after = rank(items, { weights: { ...weights, [field]: to } }).map((entry) => entry.id);
  const moved = before
    .map((id, index) => ({ id, before: index + 1, after: after.indexOf(id) + 1 }))
    .filter((entry) => entry.before !== entry.after);
  return {
    before,
    after,
    moved,
    explanation: moved.length === 0 ? `changing ${field} to ${to} moves nothing` : `changing ${field} from ${weights[field]} to ${to} moves ${moved.map((entry) => entry.id).join(', ')}`,
  };
}

/**
 * The estate-level view, which never includes a confidential item's contribution.
 *
 * @param {object[]} items
 * @param {{weights?: object}} options
 */
export function aggregate(items = [], { weights = DEFAULT_WEIGHTS } = {}) {
  const ranked = rank(items, { weights });
  const visible = ranked.filter((entry) => entry.confidential !== true);
  return {
    items: visible.length,
    confidentialExcluded: ranked.length - visible.length,
    totalDebt: Number(visible.reduce((sum, entry) => sum + entry.score, 0).toFixed(4)),
    reason: 'a confidential item is counted for its owner and never in an estate aggregate',
  };
}

/**
 * Whether the report has anything to rank, and which items are cold-start.
 *
 * @param {object[]} items
 */
export function coldStart(items = []) {
  const list = (Array.isArray(items) ? items : []).filter((item) => isText(item?.id));
  const labelled = list.filter((item) => item.coldStart === true || (item.queries ?? 0) === 0).map((item) => item.id);
  return {
    cold: list.length > 0 && labelled.length === list.length,
    labelled: labelled.sort(),
    reason: labelled.length === 0 ? null : 'no query frequency is recorded for these items, so their rank rests on obligations and criticality alone',
  };
}
