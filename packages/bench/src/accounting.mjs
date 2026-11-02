// Accounting for the metrics plan 0004 W04 requires to be reported separately.
//
// The failure this exists to prevent is one number hiding the thing it was meant to
// reveal: a knowledge gain cancelling a source regression, a local mock answering 200
// reading as remote correctness, human review minutes priced as model billing, and an
// underpowered experiment enabling a default because its mean moved.
//
// Every function here is pure and deterministic. A metric that is missing is null, never
// zero: a missing cost reported as $0 is the one error that makes an arm look cheap.
import { computeRunCost, computeRunQuality } from '../../../src/measure/metrics.mjs';
import {
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  bootstrapArmCi,
  mean,
  summarizeRows,
} from '../../../src/measure/stats.mjs';

/** The strata the plan names. A record's own `stratum` is used; these are the known ones. */
export const STRATA = ['source', 'knowledge', 'remote', 'ui'];

/** A canary is 30 tasks per stratum with three repetitions - evidence of nothing yet. */
export const CANARY_TASKS = 30;
export const CANARY_REPS = 3;

/** One-sided normal quantiles, so a sample-size estimate is a table rather than a solver. */
const Z = {
  0.01: 2.3263478740408408,
  0.025: 1.959963984540054,
  0.05: 1.6448536269514722,
  0.1: 1.2815515655446004,
  0.2: 0.8416212335729143,
  // 0.8 is the conventional *power*, whose quantile is the 0.2 tail point above.
  0.8: 0.8416212335729143,
  0.9: 1.2815515655446004,
};

const KNOWLEDGE_DIMENSIONS = ['entailment', 'scope', 'contradictions', 'completeness', 'structure'];
const REMOTE_DIMENSIONS = ['target', 'delta', 'postconditions', 'frame', 'convergence'];

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegative(value) {
  return finiteNumber(value) && value >= 0 ? value : null;
}

/**
 * Whether one run satisfied every required outcome predicate.
 *
 * `resolved` alone is the hidden-test verdict, and a run that passed hidden tests while
 * failing a declared gate or a hard constraint did not resolve the task. Evidence counts
 * only when it is current: a stale citation presented as support is the error the plan
 * calls evidence error, so it is excluded here rather than scored down.
 *
 * @param {object} record a stored run record
 * @returns {boolean}
 */
export function verifiedOutcome(record) {
  if (!record || record.status !== 'ok' || record.measured === false) return false;
  if (record.resolved !== true || record.gatesPassed !== true) return false;
  const hard = Array.isArray(record.hardConstraints) ? record.hardConstraints : [];
  if (hard.some((entry) => entry === false || entry?.passed === false)) return false;
  if (record.evidence && record.evidence.current === false) return false;
  return true;
}

function sampleSd(values) {
  if (values.length < 2) return null;
  const mu = mean(values);
  let acc = 0;
  for (const value of values) acc += (value - mu) * (value - mu);
  return Math.sqrt(acc / (values.length - 1));
}

/**
 * Verified resolution per stratum, clustered by task.
 *
 * Repeats of one task are not independent tasks, so the unit here is the task and its
 * reps are averaged into one row before the interval is drawn. Pooling strata is what the
 * plan forbids: a gain on small source tasks must not read as a gain on knowledge tasks.
 *
 * @param {object[]} records
 * @param {{prices?: object|null, samples?: number, seed?: number}} [options]
 */
export function stratify(records = [], { prices = null, samples = DEFAULT_BOOTSTRAP_SAMPLES, seed = DEFAULT_BOOTSTRAP_SEED } = {}) {
  const groups = new Map();
  for (const record of records) {
    if (!record || record.status !== 'ok' || record.measured === false) continue;
    const stratum = String(record.stratum ?? 'unknown');
    const list = groups.get(stratum) ?? [];
    list.push(record);
    groups.set(stratum, list);
  }

  const out = [];
  for (const stratum of [...groups.keys()].sort()) {
    const list = groups.get(stratum);
    const byTask = new Map();
    for (const record of list) {
      const key = String(record.task ?? '');
      const bucket = byTask.get(key) ?? [];
      bucket.push(record);
      byTask.set(key, bucket);
    }
    const rows = [...byTask.keys()].sort().map((task) => {
      const group = byTask.get(task);
      const costs = group.map((record) => computeRunCost(record, prices).usd);
      const costComplete = costs.every((value) => value !== null && value !== undefined);
      return {
        task,
        reps: group.length,
        R: mean(group.map((record) => (verifiedOutcome(record) ? 1 : 0))),
        Q: mean(group.map((record) => computeRunQuality(record))),
        C: costComplete ? mean(costs) : null,
        turns: 0,
        toolCalls: 0,
        input: 0,
        cacheRead: 0,
      };
    });
    const summary = summarizeRows(rows);
    out.push({
      stratum,
      arms: new Set(list.map((record) => record.arm)).size,
      tasks: rows.length,
      runs: list.length,
      reps: rows.length > 0 ? list.length / rows.length : 0,
      resolved: list.filter(verifiedOutcome).length,
      R_s: summary.R,
      Q: summary.Q,
      C: summary.C,
      CPI: summary.CPI,
      sd: sampleSd(rows.map((row) => row.R)),
      ci95: bootstrapArmCi(rows, { samples, seed }),
    });
  }
  return out;
}

/**
 * Coverage V: requirements with current admissible evidence over all requirements.
 *
 * Unknown, unavailable, waived and unrun obligations stay in the denominator and are
 * counted by name, because a waived obligation is visible work, not completed work.
 *
 * @param {{state?: string}[]} obligations
 */
export function coverage(obligations = []) {
  const counts = { evidenced: 0, unknown: 0, unavailable: 0, waived: 0, unrun: 0 };
  for (const obligation of obligations) {
    const state = String(obligation?.state ?? 'unknown');
    if (!(state in counts)) throw new Error(`unknown obligation state "${state}"; expected one of ${Object.keys(counts).join(', ')}`);
    counts[state] += 1;
  }
  const denominator = obligations.length;
  return { numerator: counts.evidenced, denominator, V: denominator === 0 ? null : counts.evidenced / denominator, ...counts };
}

/**
 * Knowledge quality Q_k, as separate rubric dimensions.
 *
 * The score is a descriptive mean of the dimensions that were graded, and it is null when
 * a hard failure exists: the plan forbids a weighted average overriding one, so the
 * failure is reported instead of being averaged away.
 *
 * @param {object|null} knowledge
 */
export function knowledgeQuality(knowledge) {
  const dimensions = {};
  for (const key of KNOWLEDGE_DIMENSIONS) dimensions[key] = nonNegativeOrNull(knowledge?.[key]);
  const graded = Object.values(dimensions).filter((value) => value !== null);
  const hardFailure = knowledge?.hardFailure ?? null;
  return {
    dimensions,
    graded: graded.length,
    score: hardFailure !== null || graded.length === 0 ? null : mean(graded),
    hardFailure,
  };
}

/**
 * Remote correctness Q_r, as separate dimensions, with local mock success kept apart.
 *
 * A mock that answers the expected status is evidence about the mock. When a run has only
 * that, its score is null and `localMockOnly` says why, rather than reporting the mock as
 * a remote verification.
 *
 * @param {object|null} remote
 */
export function remoteCorrectness(remote) {
  const dimensions = {};
  for (const key of REMOTE_DIMENSIONS) dimensions[key] = nonNegativeOrNull(remote?.[key]);
  const graded = Object.values(dimensions).filter((value) => value !== null);
  const hardFailure = remote?.hardFailure ?? null;
  const localMockOnly = remote?.localMockOnly === true || remote?.localMock === true;
  return {
    dimensions,
    graded: graded.length,
    score: hardFailure !== null || localMockOnly || graded.length === 0 ? null : mean(graded),
    hardFailure,
    localMockOnly,
  };
}

function nonNegativeOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

/** Q_k and Q_r means across records that carry a `quality` block. */
export function summarizeQuality(records = []) {
  const knowledge = [];
  const remote = [];
  let knowledgeHardFailures = 0;
  let remoteHardFailures = 0;
  let remoteLocalMockOnly = 0;
  for (const record of records) {
    const quality = record?.quality;
    if (!quality) continue;
    if (quality.knowledge) {
      const k = knowledgeQuality(quality.knowledge);
      if (k.hardFailure !== null) knowledgeHardFailures += 1;
      if (k.score !== null) knowledge.push(k);
    }
    if (quality.remote) {
      const r = remoteCorrectness(quality.remote);
      if (r.hardFailure !== null) remoteHardFailures += 1;
      if (r.localMockOnly) remoteLocalMockOnly += 1;
      if (r.score !== null) remote.push(r);
    }
  }
  const dimensionMeans = (entries, keys) => {
    const out = {};
    for (const key of keys) {
      const values = entries.map((entry) => entry.dimensions[key]).filter((value) => value !== null);
      out[key] = values.length === 0 ? null : mean(values);
    }
    return out;
  };
  return {
    knowledge: {
      graded: knowledge.length,
      hardFailures: knowledgeHardFailures,
      dimensions: dimensionMeans(knowledge, KNOWLEDGE_DIMENSIONS),
    },
    remote: {
      graded: remote.length,
      hardFailures: remoteHardFailures,
      localMockOnly: remoteLocalMockOnly,
      dimensions: dimensionMeans(remote, REMOTE_DIMENSIONS),
    },
  };
}

/**
 * Total cost, reported as components.
 *
 * Dollars convert only when every dollar component was reported; seconds, retries and
 * minutes stay in their own units and are never priced here. `missing` names what would
 * have to be reported to close the total, so a caller never guesses.
 *
 * @param {object} [parts]
 */
export function costComponents(parts = {}) {
  const components = {
    modelUsd: nonNegative(parts.modelUsd),
    toolUsd: nonNegative(parts.toolUsd),
    remoteUsd: nonNegative(parts.remoteUsd),
    wallTimeSeconds: nonNegative(parts.wallTimeSeconds),
    retries: nonNegative(parts.retries),
    remoteSeconds: nonNegative(parts.remoteSeconds),
    humanReviewMinutes: nonNegative(parts.humanReviewMinutes),
  };
  const dollars = ['modelUsd', 'toolUsd', 'remoteUsd'];
  const missing = dollars.filter((key) => components[key] === null);
  const totalUsd = missing.length === 0 ? dollars.reduce((sum, key) => sum + components[key], 0) : null;
  return { components, totalUsd, missing };
}

/** Cost across records: model billing by source of the number, the rest summed where reported. */
export function aggregateCost(records = [], prices = null) {
  const priced = [];
  const reported = [];
  let missingModel = 0;
  const sums = { toolUsd: 0, remoteUsd: 0, wallTimeSeconds: 0, retries: 0, remoteSeconds: 0, humanReviewMinutes: 0 };
  const reportedCounts = { toolUsd: 0, remoteUsd: 0, wallTimeSeconds: 0, retries: 0, remoteSeconds: 0, humanReviewMinutes: 0 };

  for (const record of records) {
    const cost = computeRunCost(record, prices);
    if (cost.usd === null) missingModel += 1;
    else if (cost.source === 'priced') priced.push(cost.usd);
    else reported.push(cost.usd);
    for (const key of Object.keys(sums)) {
      const value = record?.cost?.[key];
      if (finiteNumber(value) && value >= 0) {
        sums[key] += value;
        reportedCounts[key] += 1;
      }
    }
  }

  const total = (list) => (list.length === 0 ? null : list.reduce((sum, value) => sum + value, 0));
  const component = (key) => (reportedCounts[key] === 0 ? null : sums[key]);
  return {
    modelBilling: { priced: priced.length, reported: reported.length, missing: missingModel, usd: missingModel > 0 ? null : total([...priced, ...reported]) },
    components: {
      toolUsd: component('toolUsd'),
      remoteUsd: component('remoteUsd'),
      wallTimeSeconds: component('wallTimeSeconds'),
      retries: component('retries'),
      remoteSeconds: component('remoteSeconds'),
      humanReviewMinutes: component('humanReviewMinutes'),
    },
    reportedCounts,
  };
}

/**
 * Tasks a two-sided mean comparison needs, from a pilot standard deviation.
 *
 * `n = ((z_alpha + z_power) * sd / delta)^2`. The delta is the effect worth detecting, so
 * a two-point resolution margin is passed as 0.02 rather than chosen here.
 *
 * @param {{sd: number, delta: number, alpha?: number, power?: number}} input
 */
export function plannedSampleSize({ sd, delta, alpha = 0.05, power = 0.8 } = {}) {
  if (!finiteNumber(sd) || sd <= 0) throw new Error('plannedSampleSize needs a positive pilot sd');
  if (!finiteNumber(delta) || delta <= 0) throw new Error('plannedSampleSize needs a positive delta');
  if (!(alpha in Z)) throw new Error(`no normal quantile for alpha ${alpha}; known: ${Object.keys(Z).join(', ')}`);
  if (!(power in Z)) throw new Error(`no normal quantile for power ${power}; known: ${Object.keys(Z).join(', ')}`);
  return Math.ceil((((Z[alpha] + Z[power]) * sd) / delta) ** 2);
}

/** Per-stratum sample plan: what the pilot implies, and whether this run is still a canary. */
export function planSample(strataMetrics = [], { delta = 0.02, alpha = 0.05, power = 0.8 } = {}) {
  return strataMetrics.map((stratum) => {
    // A zero-variance pilot cannot be sized by the formula, and inventing a number for it
    // would be the same error as inventing a cost: the stratum is reported as unsized and
    // therefore unproven rather than as needing zero more tasks.
    const sized = stratum.sd !== null && stratum.sd > 0;
    const required = sized ? plannedSampleSize({ sd: stratum.sd, delta, alpha, power }) : null;
    return {
      stratum: stratum.stratum,
      tasks: stratum.tasks,
      reps: stratum.reps,
      sd: stratum.sd,
      required,
      shortfall: required === null ? null : Math.max(0, required - stratum.tasks),
      underpowered: required === null ? true : stratum.tasks < required,
      canary: stratum.tasks < CANARY_TASKS || stratum.reps < CANARY_REPS,
    };
  });
}

/**
 * Whether a comparison may enable a new default.
 *
 * Inconclusive, inferior, underpowered, regressed or stratum-losing evidence cannot. The
 * reasons are returned rather than a bare false: "no" with a list is actionable and "no"
 * alone invites someone to try again until the interval looks better.
 *
 * @param {object|null} comparison
 * @param {{plan?: object[]|null, regressions?: number, strataLosses?: string[]}} [options]
 */
export function defaultEligibility(comparison, { plan = null, regressions = 0, strataLosses = [] } = {}) {
  const reasons = [];
  if (!comparison) reasons.push('no-comparison');
  else if (comparison.verdict !== 'non-inferior') reasons.push(`verdict-${comparison.verdict}`);
  if (regressions > 0) reasons.push('regressions');
  if (Array.isArray(strataLosses) && strataLosses.length > 0) reasons.push('stratum-loss');
  const underpowered = (plan ?? []).filter((entry) => entry.underpowered).map((entry) => entry.stratum);
  if ((plan ?? []).length > 0 && underpowered.length > 0) reasons.push('underpowered');
  return { eligible: reasons.length === 0, reasons, underpowered };
}

/** The sentence a report carries so its reader knows what was measured and what was not. */
export function disclosureLine({ records = [], measured = [], strataMetrics = [], coverage: cov = null, exclusions = 0 } = {}) {
  const tasks = new Set(measured.map((record) => `${record.stratum}|${record.task}`)).size;
  const reps = tasks === 0 ? 0 : measured.length / tasks;
  const timeouts = records.filter((record) => record?.timeout === true || /timeout|deadline|timed out/i.test(String(record?.error ?? ''))).length;
  const underpowered = strataMetrics.filter((stratum) => stratum.tasks < CANARY_TASKS || stratum.reps < CANARY_REPS).length;
  const parts = [
    `${tasks} task(s) over ${strataMetrics.length} stratum(s)`,
    `${Number(reps.toFixed(2))} rep(s) per task`,
    `${exclusions} exclusion(s)`,
    `${timeouts} timeout(s)`,
    cov === null || cov.V === null ? 'coverage V not measured' : `coverage V ${(cov.V * 100).toFixed(1)}% (${cov.numerator}/${cov.denominator})`,
    underpowered === 0 ? 'every stratum past the 30-task canary' : `${underpowered} stratum(s) still a canary`,
    'intervals by task-level cluster bootstrap',
  ];
  return `Disclosure: ${parts.join('; ')}.`;
}

/**
 * The accounting block a benchmark report carries.
 *
 * @param {object[]} records
 * @param {{prices?: object|null, samples?: number, seed?: number, delta?: number, alpha?: number, power?: number, exclusions?: number}} [options]
 */
export function reportAccounting(
  records = [],
  { prices = null, samples = DEFAULT_BOOTSTRAP_SAMPLES, seed = DEFAULT_BOOTSTRAP_SEED, delta = 0.02, alpha = 0.05, power = 0.8, exclusions: declaredExclusions = null } = {},
) {
  const measured = records.filter((record) => record && record.status === 'ok' && record.measured !== false);
  // An error record is an exclusion even when the caller does not say so: the disclosure is
  // the reader's only way to tell a report over twelve tasks from one over ten and two
  // failures, and a default of zero would report the second as the first.
  const exclusions =
    declaredExclusions ?? records.filter((record) => record && record.status !== 'ok' && record.status !== 'planned').length;
  const strataMetrics = stratify(measured, { prices, samples, seed });
  const cov = coverage(records.flatMap((record) => (Array.isArray(record?.obligations) ? record.obligations : [])));
  const samplePlan = planSample(strataMetrics, { delta, alpha, power });
  return {
    strataMetrics,
    coverage: cov,
    quality: summarizeQuality(measured),
    cost: aggregateCost(measured, prices),
    samplePlan,
    disclosure: disclosureLine({ records, measured, strataMetrics, coverage: cov, exclusions }),
  };
}
