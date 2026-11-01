// Statistical estimators over task-level rows.
//
// Every estimator here is deterministic: the bootstrap draws come from a seeded PRNG and
// the exact tests enumerate rather than sample, so a report a pull request diffs is the
// same report on the next machine (plan 0004 P1).
//
// Reps of a task are not independent tasks. Pairing happens at the task level only: the
// old run-level pairing paired (task, rep) records whenever both arms shared a key, so one
// task with ten reps produced ten "paired runs" and an inflated p-value (review 0003 Q46).
export const DEFAULT_BOOTSTRAP_SAMPLES = 1000;
export const DEFAULT_BOOTSTRAP_SEED = 0x51772026;

/** Deterministic 32-bit PRNG (Mulberry32). */
function createRng(seed = DEFAULT_BOOTSTRAP_SEED) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The mean of a list, or 0 for an empty one. */
export function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * Aggregate task rows into one arm's summary metrics.
 *
 * `C` is null when any row's cost is missing — a partial cost must not read as a complete
 * one. `CPI` is total cost divided by resolved outcomes, and is undefined when none
 * resolve, never zero and never a favourable finite score (plan 0004 §1).
 *
 * @param {object[]} rows
 * @returns {{R: number, Q: number, C: number|null, CPI: number|null, turns: number,
 *   toolCalls: number, cacheHitRatio: number}}
 */
export function summarizeRows(rows) {
  if (rows.length === 0) {
    return { R: 0, Q: 0, C: null, CPI: null, turns: 0, toolCalls: 0, cacheHitRatio: 0 };
  }
  const R = mean(rows.map((row) => row.R));
  const Q = mean(rows.map((row) => row.Q));
  const costComplete = rows.every((row) => row.C !== null && row.C !== undefined);
  const C = costComplete ? mean(rows.map((row) => row.C)) : null;
  const turns = mean(rows.map((row) => row.turns));
  const toolCalls = mean(rows.map((row) => row.toolCalls));
  let totalInput = 0;
  let totalCacheRead = 0;
  for (const row of rows) {
    totalInput += row.input;
    totalCacheRead += row.cacheRead;
  }
  const cacheHitRatio = totalInput + totalCacheRead > 0 ? totalCacheRead / (totalInput + totalCacheRead) : 0;

  let totalCost = 0;
  let resolvedCount = 0;
  for (const row of rows) {
    const reps = Number(row.reps ?? 1);
    totalCost += (row.C ?? 0) * reps;
    resolvedCount += row.R * reps;
  }
  const CPI = costComplete && resolvedCount > 0 ? totalCost / resolvedCount : null;

  return { R, Q, C, CPI, turns, toolCalls, cacheHitRatio };
}

/**
 * Group one arm's evaluated runs by task, so multi-repetition tasks form one task unit
 * for task-level means and bootstrap resampling.
 *
 * @param {object[]} evaluatedRuns
 * @returns {object[]} rows sorted by task
 */
export function collapseArmByTask(evaluatedRuns) {
  const byTask = new Map();
  for (const run of evaluatedRuns) {
    const list = byTask.get(run.task) ?? [];
    list.push(run);
    byTask.set(run.task, list);
  }
  const tasks = [...byTask.keys()].sort();
  return tasks.map((task) => {
    const group = byTask.get(task);
    const R = mean(group.map((row) => row.R));
    const Q = mean(group.map((row) => row.Q));
    const costComplete = group.every((row) => row.C !== null && row.C !== undefined);
    const C = costComplete ? mean(group.map((row) => row.C)) : null;
    const turns = mean(group.map((row) => row.turns));
    const toolCalls = mean(group.map((row) => row.toolCalls));
    const input = mean(group.map((row) => row.input));
    const cacheWrite = mean(group.map((row) => row.cacheWrite));
    const cacheRead = mean(group.map((row) => row.cacheRead));
    const output = mean(group.map((row) => row.output));
    const cacheHitRatio = input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0;
    return {
      task,
      stratum: group[0]?.stratum ?? 'unknown',
      reps: group.length,
      R,
      Q,
      C,
      turns,
      toolCalls,
      input,
      cacheWrite,
      cacheRead,
      output,
      cacheHitRatio,
    };
  });
}

function percentilePair(sortedValues) {
  if (sortedValues.length === 0) return [0, 0];
  if (sortedValues.length === 1) return [sortedValues[0], sortedValues[0]];
  const loIdx = Math.floor(0.025 * (sortedValues.length - 1));
  const hiIdx = Math.ceil(0.975 * (sortedValues.length - 1));
  return [sortedValues[loIdx], sortedValues[hiIdx]];
}

/**
 * Paired bootstrap 95% confidence intervals over task rows.
 *
 * When any task's cost is missing the cost intervals are undefined, not degenerate:
 * dropping the undefined resamples quietly narrowed the interval to the tasks that
 * happened to price out (review 0003 Q46).
 *
 * @param {object[]} taskRows
 * @param {{samples?: number, seed?: number}} [options]
 */
export function bootstrapArmCi(taskRows, { samples = DEFAULT_BOOTSTRAP_SAMPLES, seed = DEFAULT_BOOTSTRAP_SEED } = {}) {
  const n = taskRows.length;
  const costComplete = taskRows.every((row) => row.C !== null && row.C !== undefined);
  if (n === 0) {
    return {
      R: [0, 0],
      Q: [0, 0],
      C: null,
      CPI: null,
      turns: [0, 0],
      toolCalls: [0, 0],
      cacheHitRatio: [0, 0],
    };
  }
  if (n === 1) {
    const summary = summarizeRows(taskRows);
    return {
      R: [summary.R, summary.R],
      Q: [summary.Q, summary.Q],
      C: summary.C === null ? null : [summary.C, summary.C],
      CPI: summary.CPI === null ? null : [summary.CPI, summary.CPI],
      turns: [summary.turns, summary.turns],
      toolCalls: [summary.toolCalls, summary.toolCalls],
      cacheHitRatio: [summary.cacheHitRatio, summary.cacheHitRatio],
    };
  }

  const rng = createRng(seed);
  const rValues = [];
  const qValues = [];
  const cValues = [];
  const cpiValues = [];
  const turnsValues = [];
  const toolsValues = [];
  const cacheValues = [];

  for (let b = 0; b < samples; b += 1) {
    const draw = new Array(n);
    for (let i = 0; i < n; i += 1) draw[i] = taskRows[Math.floor(rng() * n)];
    const summary = summarizeRows(draw);
    rValues.push(summary.R);
    qValues.push(summary.Q);
    if (costComplete) cValues.push(summary.C);
    if (summary.CPI !== null) cpiValues.push(summary.CPI);
    turnsValues.push(summary.turns);
    toolsValues.push(summary.toolCalls);
    cacheValues.push(summary.cacheHitRatio);
  }

  const numSort = (a, b) => a - b;
  rValues.sort(numSort);
  qValues.sort(numSort);
  cValues.sort(numSort);
  cpiValues.sort(numSort);
  turnsValues.sort(numSort);
  toolsValues.sort(numSort);
  cacheValues.sort(numSort);

  return {
    R: percentilePair(rValues),
    Q: percentilePair(qValues),
    C: costComplete ? percentilePair(cValues) : null,
    CPI: cpiValues.length > 0 ? percentilePair(cpiValues) : null,
    turns: percentilePair(turnsValues),
    toolCalls: percentilePair(toolsValues),
    cacheHitRatio: percentilePair(cacheValues),
  };
}

/**
 * Complementary error function, relative error below 1.5e-7 (Abramowitz & Stegun 7.1.26).
 */
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return x >= 0 ? poly : 2 - poly;
}

/** Two-sided exact binomial p-value for discordant counts (b, c) under p = 0.5. */
function exactBinomialTwoSided(b, c) {
  const m = b + c;
  if (m === 0) return 1;
  const k = Math.min(b, c);
  let term = Math.pow(0.5, m);
  let cdf = term;
  for (let j = 1; j <= k; j += 1) {
    term *= (m - j + 1) / j;
    cdf += term;
  }
  return Math.min(1, 2 * cdf);
}

/**
 * McNemar's test on paired binary resolution outcomes.
 *
 * @param {[number|boolean, number|boolean][]} pairs
 */
export function mcnemarTest(pairs) {
  let n11 = 0;
  let n10 = 0;
  let n01 = 0;
  let n00 = 0;

  for (const [a, b] of pairs) {
    const aRes = typeof a === 'number' ? a >= 0.5 : Boolean(a);
    const bRes = typeof b === 'number' ? b >= 0.5 : Boolean(b);
    if (aRes && bRes) n11 += 1;
    else if (aRes && !bRes) n10 += 1;
    else if (!aRes && bRes) n01 += 1;
    else n00 += 1;
  }

  const discordant = n10 + n01;
  const statistic = discordant > 0 ? ((n10 - n01) * (n10 - n01)) / discordant : 0;
  const pValue = exactBinomialTwoSided(n10, n01);
  const pValueAsymptotic = discordant > 0 ? erfc(Math.sqrt(statistic / 2)) : 1;

  return { n11, n10, n01, n00, b: n10, c: n01, statistic, pValue, pValueAsymptotic };
}

/**
 * Non-inferiority margin for resolution rate (plan 0004 §1): the candidate is
 * non-inferior only when the one-sided 95% lower bound of ΔR stays above -2 pp.
 */
export const NON_INFERIORITY_MARGIN = -0.02;

/**
 * Below this many paired tasks the two-sided exact sign test cannot reject at α = 0.05
 * (its smallest achievable p-value at n = 4 is 0.125), so the verdict is
 * `insufficient-tasks` instead of a p-value the sample cannot support.
 */
export const MIN_PAIRD_TASKS = 5;

/**
 * Exact two-sided sign test on paired outcomes.
 *
 * Zero differences carry no evidence and are excluded, mirroring the Wilcoxon treatment
 * of ties. This replaces McNemar on task means: the sign of a task-mean difference is the
 * paired discrete evidence, and it does not assume the 0/1 contingency McNemar requires.
 *
 * @param {[number, number][]} pairs
 */
export function signTest(pairs) {
  let plus = 0;
  let minus = 0;
  let zero = 0;
  for (const [a, b] of pairs) {
    const d = Number(b) - Number(a);
    if (d > 1e-12) plus += 1;
    else if (d < -1e-12) minus += 1;
    else zero += 1;
  }
  return {
    n: pairs.length,
    plus,
    minus,
    zero,
    statistic: Math.min(plus, minus),
    pValue: exactBinomialTwoSided(plus, minus),
  };
}

/**
 * Holm step-down p-value adjustment: conservative FWER control for the family of
 * comparisons tested in one run.
 *
 * @param {number[]} pValues raw p-values in any order
 * @returns {number[]} adjusted p-values in the original order, monotone and in [0, 1]
 */
export function holmAdjust(pValues) {
  if (pValues.length === 0) return [];
  const m = pValues.length;
  const indexed = pValues.map((p, i) => [i, Number(p)]).sort((a, b) => a[1] - b[1]);
  const adjusted = new Array(m);
  let runningMax = 0;
  for (let j = 0; j < m; j += 1) {
    runningMax = Math.max(runningMax, Math.min(1, indexed[j][1] * (m - j)));
    adjusted[indexed[j][0]] = runningMax;
  }
  return adjusted;
}

/**
 * Wilcoxon signed-rank test on paired numerical observations, with average ranks for
 * ties: exact two-sided permutation p-value for at most 20 non-zero differences, the
 * tie-adjusted normal approximation above that.
 *
 * @param {[number, number][]} pairs
 */
export function wilcoxonSignedRank(pairs) {
  const diffs = [];
  for (const [a, b] of pairs) {
    const d = Number(b) - Number(a);
    if (Math.abs(d) > 1e-12) diffs.push({ d, abs: Math.abs(d), sign: d > 0 ? 1 : -1 });
  }

  const n = pairs.length;
  const nonZero = diffs.length;
  if (nonZero === 0) {
    return { n, nonZero: 0, wPlus: 0, wMinus: 0, statistic: 0, pValue: 1 };
  }

  diffs.sort((x, y) => x.abs - y.abs);

  const ranks = new Array(nonZero);
  const tieGroups = [];
  let i = 0;
  while (i < nonZero) {
    let j = i + 1;
    while (j < nonZero && Math.abs(diffs[j].abs - diffs[i].abs) <= 1e-12) j += 1;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) ranks[k] = avgRank;
    const groupSize = j - i;
    if (groupSize > 1) tieGroups.push(groupSize);
    i = j;
  }

  let wPlus = 0;
  let wMinus = 0;
  for (let k = 0; k < nonZero; k += 1) {
    if (diffs[k].sign > 0) wPlus += ranks[k];
    else wMinus += ranks[k];
  }
  const statistic = Math.min(wPlus, wMinus);

  let pValue;
  if (nonZero <= 20) {
    const totalConfigurations = 1 << nonZero;
    const target = statistic + 1e-9;
    let tailCount = 0;
    for (let mask = 0; mask < totalConfigurations; mask += 1) {
      let sum = 0;
      for (let bit = 0; bit < nonZero; bit += 1) {
        if ((mask & (1 << bit)) !== 0) {
          sum += ranks[bit];
          if (sum > target) break;
        }
      }
      if (sum <= target) tailCount += 1;
    }
    pValue = Math.min(1, (2 * tailCount) / totalConfigurations);
  } else {
    const meanW = (nonZero * (nonZero + 1)) / 4;
    let tieCorrection = 0;
    for (const t of tieGroups) tieCorrection += t * t * t - t;
    const variance = (nonZero * (nonZero + 1) * (2 * nonZero + 1) - 0.5 * tieCorrection) / 24;
    const z = variance > 0 ? Math.abs(wPlus - meanW) / Math.sqrt(variance) : 0;
    pValue = erfc(z / Math.SQRT2);
  }

  return { n, nonZero, wPlus, wMinus, statistic, pValue };
}

/**
 * Pair two arms at the task level and compute deltas, paired bootstrap 95% CIs, an exact
 * sign test on task-mean R, a Wilcoxon signed-rank test on task-mean C, and a one-sided
 * non-inferiority verdict (plan 0004 §1, review 0003 Q46).
 *
 * `verdict`:
 *   'insufficient-tasks' — fewer than MIN_PAIRD_TASKS paired tasks
 *   'non-inferior'       — one-sided 95% lower bound of ΔR above NON_INFERIORITY_MARGIN
 *   'inferior'           — two-sided 95% CI of ΔR entirely below 0
 *   'inconclusive'       — otherwise (CI too wide to decide)
 *
 * @param {string} armAName
 * @param {object[]} armARuns
 * @param {string} armBName
 * @param {object[]} armBRuns
 * @param {{samples?: number, seed?: number}} [options]
 */
export function compareArms(
  armAName,
  armARuns,
  armBName,
  armBRuns,
  { samples = DEFAULT_BOOTSTRAP_SAMPLES, seed = DEFAULT_BOOTSTRAP_SEED } = {},
) {
  const tasksA = new Map(collapseArmByTask(armARuns).map((row) => [row.task, row]));
  const tasksB = new Map(collapseArmByTask(armBRuns).map((row) => [row.task, row]));
  const sharedTasks = [...tasksA.keys()].filter((task) => tasksB.has(task)).sort();

  const pairedTasks = sharedTasks.map((task) => ({ task, a: tasksA.get(task), b: tasksB.get(task) }));

  const rPairs = pairedTasks.map((pair) => [pair.a.R, pair.b.R]);
  const cPairs = pairedTasks
    .filter((pair) => pair.a.C !== null && pair.b.C !== null)
    .map((pair) => [pair.a.C, pair.b.C]);

  const sumA = summarizeRows(pairedTasks.map((pair) => pair.a));
  const sumB = summarizeRows(pairedTasks.map((pair) => pair.b));

  const deltas = {
    R: sumB.R - sumA.R,
    Q: sumB.Q - sumA.Q,
    C: sumB.C !== null && sumA.C !== null ? sumB.C - sumA.C : null,
    CPI: sumB.CPI !== null && sumA.CPI !== null ? sumB.CPI - sumA.CPI : null,
    cpiRatio: sumB.CPI !== null && sumA.CPI !== null && sumA.CPI > 0 ? sumB.CPI / sumA.CPI : null,
    turns: sumB.turns - sumA.turns,
    toolCalls: sumB.toolCalls - sumA.toolCalls,
    cacheHitRatio: sumB.cacheHitRatio - sumA.cacheHitRatio,
  };

  const n = pairedTasks.length;
  const costComplete =
    pairedTasks.every((pair) => pair.a.C !== null && pair.a.C !== undefined) &&
    pairedTasks.every((pair) => pair.b.C !== null && pair.b.C !== undefined);
  let ci95;
  if (n <= 1) {
    ci95 = {
      R: [deltas.R, deltas.R],
      Q: [deltas.Q, deltas.Q],
      C: deltas.C === null ? null : [deltas.C, deltas.C],
      CPI: deltas.CPI === null ? null : [deltas.CPI, deltas.CPI],
      turns: [deltas.turns, deltas.turns],
      toolCalls: [deltas.toolCalls, deltas.toolCalls],
      cacheHitRatio: [deltas.cacheHitRatio, deltas.cacheHitRatio],
    };
  } else {
    const rng = createRng(seed);
    const dR = [];
    const dQ = [];
    const dC = [];
    const dCPI = [];
    const dTurns = [];
    const dTools = [];
    const dCache = [];

    for (let b = 0; b < samples; b += 1) {
      const drawA = new Array(n);
      const drawB = new Array(n);
      for (let i = 0; i < n; i += 1) {
        const pair = pairedTasks[Math.floor(rng() * n)];
        drawA[i] = pair.a;
        drawB[i] = pair.b;
      }
      const sA = summarizeRows(drawA);
      const sB = summarizeRows(drawB);
      dR.push(sB.R - sA.R);
      dQ.push(sB.Q - sA.Q);
      if (costComplete) dC.push(sB.C - sA.C);
      if (sB.CPI !== null && sA.CPI !== null) dCPI.push(sB.CPI - sA.CPI);
      dTurns.push(sB.turns - sA.turns);
      dTools.push(sB.toolCalls - sA.toolCalls);
      dCache.push(sB.cacheHitRatio - sA.cacheHitRatio);
    }

    const numSort = (x, y) => x - y;
    dR.sort(numSort);
    dQ.sort(numSort);
    dC.sort(numSort);
    dCPI.sort(numSort);
    dTurns.sort(numSort);
    dTools.sort(numSort);
    dCache.sort(numSort);

    ci95 = {
      R: percentilePair(dR),
      Q: percentilePair(dQ),
      C: costComplete ? percentilePair(dC) : null,
      CPI: dCPI.length > 0 ? percentilePair(dCPI) : null,
      turns: percentilePair(dTurns),
      toolCalls: percentilePair(dTools),
      cacheHitRatio: percentilePair(dCache),
    };
  }

  const rTest = signTest(rPairs);
  const pairedRuns = pairedTasks.reduce(
    (sum, pair) => sum + Math.min(Number(pair.a.reps ?? 1), Number(pair.b.reps ?? 1)),
    0,
  );

  const bound = ci95.R[0];
  const met = n < MIN_PAIRD_TASKS ? null : bound > NON_INFERIORITY_MARGIN;
  const verdict =
    n < MIN_PAIRD_TASKS
      ? 'insufficient-tasks'
      : bound > NON_INFERIORITY_MARGIN
        ? 'non-inferior'
        : ci95.R[1] < 0
          ? 'inferior'
          : 'inconclusive';

  return {
    baseline: armAName,
    candidate: armBName,
    pairedTasks: n,
    pairedRuns,
    deltas,
    ci95,
    rTest,
    wilcoxon: wilcoxonSignedRank(cPairs),
    nonInferiority: { margin: NON_INFERIORITY_MARGIN, bound, met },
    verdict,
  };
}
