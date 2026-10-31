// Cost model, paired statistical tests and report generator (`simt bench report`, R03).
//
// Reads stored run records from `.simt-dev/bench/runs/` and optional token pricing
// from `.simt-dev/bench/prices.json` (per million tokens: `{in, cache_write, cache_read, out}`).
// Never performs network lookups. All statistical estimators (paired bootstrap 95% CIs,
// exact sign test on task-mean R, Wilcoxon signed-rank test on task-mean C) are
// deterministic. Reps of a task are not independent tasks: pairing happens at the
// task level only (plan 0004 §1, review 0003 Q46).

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { LOCAL_DIR } from '../state.mjs';

export const DEFAULT_BOOTSTRAP_SAMPLES = 1000;
export const DEFAULT_BOOTSTRAP_SEED = 0x51772026;

/**
 * Deterministic 32-bit PRNG (Mulberry32) so bootstrap confidence intervals are
 * byte-identical across machines and invocations (Principle P1).
 */
function createRng(seed = DEFAULT_BOOTSTRAP_SEED) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizePriceEntry(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON object with {in, cache_write, cache_read, out}`);
  }
  const pIn = Number(raw.in ?? raw.input ?? 0);
  const pCw = Number(raw.cache_write ?? raw.cacheWrite ?? 0);
  const pCr = Number(raw.cache_read ?? raw.cacheRead ?? 0);
  const pOut = Number(raw.out ?? raw.output ?? 0);
  for (const [k, v] of [
    ['in', pIn],
    ['cache_write', pCw],
    ['cache_read', pCr],
    ['out', pOut],
  ]) {
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`${label}.${k} must be a non-negative number`);
    }
  }
  return {
    in: pIn,
    cache_write: pCw,
    cache_read: pCr,
    out: pOut,
  };
}

function isFlatPriceObject(obj) {
  return (
    'in' in obj ||
    'input' in obj ||
    'cache_write' in obj ||
    'cacheWrite' in obj ||
    'cache_read' in obj ||
    'cacheRead' in obj ||
    'out' in obj ||
    'output' in obj
  );
}

/**
 * Load `.simt-dev/bench/prices.json` if present.
 * Supports either a flat `{in, cache_write, cache_read, out}` object (prices per 1M tokens)
 * or a map keyed by model/harness name with an optional `"default"` entry.
 */
export async function loadPrices(root) {
  // The pre-move path is a fallback for one release (review 0003 Q19).
  const pricesPath = join(resolve(root), LOCAL_DIR, 'bench', 'prices.json');
  const legacyPath = join(resolve(root), '.simt', 'bench', 'prices.json');
  let rawText;
  try {
    rawText = await readFile(pricesPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      try {
        rawText = await readFile(legacyPath, 'utf8');
      } catch (legacyError) {
        if (legacyError && legacyError.code === 'ENOENT') return null;
        throw legacyError;
      }
    } else throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`invalid JSON in ${pricesPath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${pricesPath} must be a JSON object`);
  }

  if (isFlatPriceObject(parsed)) {
    return { kind: 'flat', entry: normalizePriceEntry(parsed, pricesPath) };
  }

  const entries = {};
  for (const [key, val] of Object.entries(parsed)) {
    entries[key] = normalizePriceEntry(val, `${pricesPath}[${JSON.stringify(key)}]`);
  }
  return { kind: 'map', entries };
}

function resolvePriceEntry(prices, run) {
  if (!prices) return null;
  if (prices.kind === 'flat') return normalizePriceEntry(prices.entry, 'prices');
  if (prices.kind === 'map') {
    const entry =
      (run?.model && prices.entries[run.model]) ||
      (run?.harness && prices.entries[run.harness]) ||
      prices.entries.default ||
      null;
    return entry ? normalizePriceEntry(entry, 'prices') : null;
  }
  if (isFlatPriceObject(prices)) {
    return normalizePriceEntry(prices, 'prices');
  }
  const entry =
    (run?.model && prices[run.model]) ||
    (run?.harness && prices[run.harness]) ||
    prices.default ||
    null;
  return entry ? normalizePriceEntry(entry, 'prices') : null;
}

/**
 * Compute billed cost in USD for a single run record.
 *
 * Returns `{ usd, source }` where `usd` is null when the cost is unknown — a missing
 * cost must not read as a zero cost (review 0003 Q46: the claude run with usage but no
 * prices reported `C $0.0000 | CPI $0.0000`). `source` is:
 *   'priced'   — computed from the token prices table
 *   'reported' — the harness reported `costUsd` directly
 *   'missing'  — no prices table and no reported cost; `usd` is null
 */
export function computeRunCost(run, prices = null) {
  const usage = run?.usage ?? {};
  const input = Number(usage.input ?? 0);
  const cacheWrite = Number(usage.cacheWrite ?? usage.cache_write ?? 0);
  const cacheRead = Number(usage.cacheRead ?? usage.cache_read ?? 0);
  const output = Number(usage.output ?? 0);
  const totalTokens = input + cacheWrite + cacheRead + output;

  const entry = resolvePriceEntry(prices, run);
  if (entry) {
    if (totalTokens === 0 && Number(run?.costUsd ?? 0) > 0) {
      return { usd: Number(run.costUsd), source: 'reported' };
    }
    return {
      usd:
        (input * entry.in +
          cacheWrite * entry.cache_write +
          cacheRead * entry.cache_read +
          output * entry.out) /
        1_000_000,
      source: 'priced',
    };
  }
  const reported = run?.costUsd;
  if (typeof reported === 'number' && Number.isFinite(reported)) {
    return { usd: reported, source: 'reported' };
  }
  return { usd: null, source: 'missing' };
}

/**
 * Whether a run attempt counts as resolved for R: hidden tests pass AND declared gates pass.
 */
export function isRunResolved(run) {
  return Boolean(run?.resolved && (run?.gatesPassed ?? true));
}

/**
 * Compute quality score Q in [0, 1] for a run record:
 *   0.5 * hiddenTests + 0.2 * gates + 0.2 * probe + 0.1 * diffHygiene
 */
export function computeRunQuality(run) {
  const testsScore = run?.resolved ? 1 : 0;
  const gatesScore = (run?.gatesPassed ?? true) ? 1 : 0;

  let probeScore = 1;
  if (run?.probe !== null && run?.probe !== undefined) {
    if (typeof run.probe === 'boolean') {
      probeScore = run.probe ? 1 : 0;
    } else if (typeof run.probe === 'number' && Number.isFinite(run.probe)) {
      probeScore = Math.max(0, Math.min(1, run.probe));
    } else if (typeof run.probe === 'object') {
      probeScore = run.probe.passed ? 1 : 0;
    }
  }

  const files = Number(run?.diff?.files ?? 0);
  const outside = Number(run?.diff?.outsideBlastRadius ?? 0);
  let hygieneScore = 1;
  if (outside > 0) {
    hygieneScore = files > 0 ? Math.max(0, Math.min(1, (files - outside) / files)) : 0;
  }

  return (5 * testsScore + 2 * gatesScore + 2 * probeScore + hygieneScore) / 10;
}

/**
 * Evaluate per-run derived metrics used by arm aggregation and paired tests.
 */
export function evaluateRunRecord(run, prices = null) {
  const usage = run?.usage ?? {};
  const input = Number(usage.input ?? 0);
  const cacheWrite = Number(usage.cacheWrite ?? usage.cache_write ?? 0);
  const cacheRead = Number(usage.cacheRead ?? usage.cache_read ?? 0);
  const output = Number(usage.output ?? 0);
  const turns = Number(usage.turns ?? 0);
  const toolCalls = Number(usage.toolCalls ?? usage.tool_calls ?? 0);
  const R = isRunResolved(run) ? 1 : 0;
  const Q = computeRunQuality(run);
  const cost = computeRunCost(run, prices);
  const cacheDenom = input + cacheRead;
  const cacheHitRatio = cacheDenom > 0 ? cacheRead / cacheDenom : 0;

  return {
    task: String(run?.task ?? ''),
    arm: String(run?.arm ?? 'default'),
    harness: String(run?.harness ?? ''),
    model: String(run?.model ?? ''),
    experiment: String(run?.experiment ?? ''),
    rep: Number(run?.rep ?? 1),
    R,
    Q,
    C: cost.usd,
    costSource: cost.source,
    turns,
    toolCalls,
    input,
    cacheWrite,
    cacheRead,
    output,
    cacheHitRatio,
  };
}

function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Aggregate a list of task-level (or run-level) metric rows into arm summary metrics.
 *
 * `C` is null when any row's cost is missing — a partial cost must not read as a
 * complete one. `CPI` is total cost divided by resolved outcomes (plan 0004 §1:
 * "undefined when none resolve, never zero or a favourable finite score").
 */
function summarizeRows(rows) {
  if (rows.length === 0) {
    return {
      R: 0,
      Q: 0,
      C: null,
      CPI: null,
      turns: 0,
      toolCalls: 0,
      cacheHitRatio: 0,
    };
  }
  const R = mean(rows.map((r) => r.R));
  const Q = mean(rows.map((r) => r.Q));
  const costComplete = rows.every((r) => r.C !== null && r.C !== undefined);
  const C = costComplete ? mean(rows.map((r) => r.C)) : null;
  const turns = mean(rows.map((r) => r.turns));
  const toolCalls = mean(rows.map((r) => r.toolCalls));
  let totalInput = 0;
  let totalCacheRead = 0;
  for (const r of rows) {
    totalInput += r.input;
    totalCacheRead += r.cacheRead;
  }
  const cacheHitRatio =
    totalInput + totalCacheRead > 0 ? totalCacheRead / (totalInput + totalCacheRead) : 0;

  let totalCost = 0;
  let resolvedCount = 0;
  for (const r of rows) {
    const reps = Number(r.reps ?? 1);
    totalCost += (r.C ?? 0) * reps;
    resolvedCount += r.R * reps;
  }
  const CPI = costComplete && resolvedCount > 0 ? totalCost / resolvedCount : null;

  return { R, Q, C, CPI, turns, toolCalls, cacheHitRatio };
}

/**
 * Group evaluated runs for one arm by task so multi-repetition tasks form one task unit
 * for task-level means and bootstrap resampling.
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
    const R = mean(group.map((r) => r.R));
    const Q = mean(group.map((r) => r.Q));
    const costComplete = group.every((r) => r.C !== null && r.C !== undefined);
    const C = costComplete ? mean(group.map((r) => r.C)) : null;
    const turns = mean(group.map((r) => r.turns));
    const toolCalls = mean(group.map((r) => r.toolCalls));
    const input = mean(group.map((r) => r.input));
    const cacheWrite = mean(group.map((r) => r.cacheWrite));
    const cacheRead = mean(group.map((r) => r.cacheRead));
    const output = mean(group.map((r) => r.output));
    const cacheHitRatio = input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0;
    return {
      task,
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
 */
export function bootstrapArmCi(
  taskRows,
  { samples = DEFAULT_BOOTSTRAP_SAMPLES, seed = DEFAULT_BOOTSTRAP_SEED } = {},
) {
  const n = taskRows.length;
  // When any task's cost is missing the cost CIs are undefined, not degenerate:
  // dropping the undefined resamples (the old behaviour) quietly narrowed the
  // interval to the tasks that happened to price out (review 0003 Q46).
  const costComplete = taskRows.every((r) => r.C !== null && r.C !== undefined);
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
    const s = summarizeRows(taskRows);
    return {
      R: [s.R, s.R],
      Q: [s.Q, s.Q],
      C: s.C === null ? null : [s.C, s.C],
      CPI: s.CPI === null ? null : [s.CPI, s.CPI],
      turns: [s.turns, s.turns],
      toolCalls: [s.toolCalls, s.toolCalls],
      cacheHitRatio: [s.cacheHitRatio, s.cacheHitRatio],
    };
  }

  const rng = createRng(seed);
  const rArr = [];
  const qArr = [];
  const cArr = [];
  const cpiArr = [];
  const turnsArr = [];
  const toolsArr = [];
  const cacheArr = [];

  for (let b = 0; b < samples; b += 1) {
    const draw = new Array(n);
    for (let i = 0; i < n; i += 1) {
      draw[i] = taskRows[Math.floor(rng() * n)];
    }
    const s = summarizeRows(draw);
    rArr.push(s.R);
    qArr.push(s.Q);
    if (costComplete) cArr.push(s.C);
    if (s.CPI !== null) cpiArr.push(s.CPI);
    turnsArr.push(s.turns);
    toolsArr.push(s.toolCalls);
    cacheArr.push(s.cacheHitRatio);
  }

  const numSort = (a, b) => a - b;
  rArr.sort(numSort);
  qArr.sort(numSort);
  cArr.sort(numSort);
  cpiArr.sort(numSort);
  turnsArr.sort(numSort);
  toolsArr.sort(numSort);
  cacheArr.sort(numSort);

  return {
    R: percentilePair(rArr),
    Q: percentilePair(qArr),
    C: costComplete ? percentilePair(cArr) : null,
    CPI: cpiArr.length > 0 ? percentilePair(cpiArr) : null,
    turns: percentilePair(turnsArr),
    toolCalls: percentilePair(toolsArr),
    cacheHitRatio: percentilePair(cacheArr),
  };
}

/**
 * Complementary error function erfc(x) for normal/chi-square tail probabilities.
 * Maximum relative error < 1.5e-7 (Abramowitz & Stegun 7.1.26).
 */
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const poly = (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-z * z);
  return x >= 0 ? poly : 2 - poly;
}

/**
 * Two-sided exact binomial p-value for discordant counts (b, c) under p = 0.5.
 */
function exactBinomialTwoSided(b, c) {
  const m = b + c;
  if (m === 0) return 1;
  const k = Math.min(b, c);
  // Sum_{j=0..k} C(m, j) * 0.5^m computed recurrence-style to avoid overflow.
  let term = Math.pow(0.5, m);
  let cdf = term;
  for (let j = 1; j <= k; j += 1) {
    term *= (m - j + 1) / j;
    cdf += term;
  }
  return Math.min(1, 2 * cdf);
}

/**
 * McNemar's test on paired binary resolution outcomes (armA vs armB).
 *
 * Contingency counts:
 *   n11: both resolved
 *   n10 (b): armA resolved, armB did not
 *   n01 (c): armA did not, armB resolved
 *   n00: neither resolved
 *
 * Statistic: (b - c)^2 / (b + c) (0 when b + c === 0).
 * pValue: exact two-sided binomial test on discordant pairs (b, c).
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

  return {
    n11,
    n10,
    n01,
    n00,
    b: n10,
    c: n01,
    statistic,
    pValue,
    pValueAsymptotic,
  };
}

/**
 * Non-inferiority margin for resolution rate (plan 0004 §1): the candidate is
 * non-inferior only when the one-sided 95% lower bound of ΔR stays above -2 pp.
 */
export const NON_INFERIORITY_MARGIN = -0.02;

/**
 * Below this many paired tasks the two-sided exact sign test cannot reject at α = 0.05
 * (its smallest achievable p-value at n = 4 is 0.125), so the verdict is
 * `insufficient-tasks` instead of a p-value the sample cannot support (review 0003 Q46).
 */
export const MIN_PAIRD_TASKS = 5;

/**
 * Exact two-sided sign test on paired task-mean outcomes (armA, armB).
 * Zero differences carry no evidence and are excluded, mirroring the Wilcoxon
 * treatment of ties. This replaces McNemar on task means: the sign of a task-mean
 * difference is the paired discrete evidence, and it does not assume the 0/1
 * contingency McNemar requires.
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
 * comparisons (ablation sections, rule-variant slots) tested in one run.
 *
 * @param {number[]} pValues raw p-values of the family, in any order
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
 * Wilcoxon signed-rank test on paired numerical observations (armA, armB),
 * evaluating differences d_i = b_i - a_i.
 *
 * Uses average ranks for ties. For n_r <= 20 non-zero differences, computes the exact
 * two-sided sign-permutation p-value over the assigned ranks; for n_r > 20, uses the
 * tie-adjusted normal approximation.
 */
export function wilcoxonSignedRank(pairs) {
  const diffs = [];
  for (const [a, b] of pairs) {
    const d = Number(b) - Number(a);
    if (Math.abs(d) > 1e-12) {
      diffs.push({ d, abs: Math.abs(d), sign: d > 0 ? 1 : -1 });
    }
  }

  const n = pairs.length;
  const nonZero = diffs.length;
  if (nonZero === 0) {
    return {
      n,
      nonZero: 0,
      wPlus: 0,
      wMinus: 0,
      statistic: 0,
      pValue: 1,
    };
  }

  diffs.sort((x, y) => x.abs - y.abs);

  const ranks = new Array(nonZero);
  const tieGroups = [];
  let i = 0;
  while (i < nonZero) {
    let j = i + 1;
    while (j < nonZero && Math.abs(diffs[j].abs - diffs[i].abs) <= 1e-12) {
      j += 1;
    }
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) {
      ranks[k] = avgRank;
    }
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
    // Exact two-sided permutation distribution over the 2^nonZero sign assignments.
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
    for (const t of tieGroups) {
      tieCorrection += t * t * t - t;
    }
    const variance =
      (nonZero * (nonZero + 1) * (2 * nonZero + 1) - 0.5 * tieCorrection) / 24;
    const z = variance > 0 ? Math.abs(wPlus - meanW) / Math.sqrt(variance) : 0;
    pValue = erfc(z / Math.SQRT2);
  }

  return {
    n,
    nonZero,
    wPlus,
    wMinus,
    statistic,
    pValue,
  };
}

/**
 * Pair two arms at the task level and compute deltas, paired bootstrap 95% CIs,
 * an exact sign test on task-mean R, a Wilcoxon signed-rank test on task-mean C,
 * and a one-sided non-inferiority verdict (plan 0004 §1, review 0003 Q46).
 *
 * Reps of a task are not independent tasks: the old run-level pairing paired
 * (task, rep) records when both arms shared the same keys, so one task with ten
 * reps produced ten "paired runs" and an inflated p-value. Pairing is now at the
 * task level only; `pairedRuns` survives as a descriptive count.
 *
 * `verdict`:
 *   'insufficient-tasks' — fewer than MIN_PAIRD_TASKS paired tasks
 *   'non-inferior'       — one-sided 95% lower bound of ΔR above NON_INFERIORITY_MARGIN
 *   'inferior'           — two-sided 95% CI of ΔR entirely below 0
 *   'inconclusive'       — otherwise (CI too wide to decide)
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
  const sharedTasks = [...tasksA.keys()].filter((t) => tasksB.has(t)).sort();

  const pairedTasks = sharedTasks.map((task) => ({
    task,
    a: tasksA.get(task),
    b: tasksB.get(task),
  }));

  const rPairs = pairedTasks.map((p) => [p.a.R, p.b.R]);
  const cPairs = pairedTasks
    .filter((p) => p.a.C !== null && p.b.C !== null)
    .map((p) => [p.a.C, p.b.C]);

  const sumA = summarizeRows(pairedTasks.map((p) => p.a));
  const sumB = summarizeRows(pairedTasks.map((p) => p.b));

  const deltas = {
    R: sumB.R - sumA.R,
    Q: sumB.Q - sumA.Q,
    C: sumB.C !== null && sumA.C !== null ? sumB.C - sumA.C : null,
    CPI: sumB.CPI !== null && sumA.CPI !== null ? sumB.CPI - sumA.CPI : null,
    cpiRatio:
      sumB.CPI !== null && sumA.CPI !== null && sumA.CPI > 0 ? sumB.CPI / sumA.CPI : null,
    turns: sumB.turns - sumA.turns,
    toolCalls: sumB.toolCalls - sumA.toolCalls,
    cacheHitRatio: sumB.cacheHitRatio - sumA.cacheHitRatio,
  };

  // Paired bootstrap 95% CIs on deltas (B - A).
  const n = pairedTasks.length;
  const costComplete =
    pairedTasks.every((p) => p.a.C !== null && p.a.C !== undefined) &&
    pairedTasks.every((p) => p.b.C !== null && p.b.C !== undefined);
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
    (sum, p) => sum + Math.min(Number(p.a.reps ?? 1), Number(p.b.reps ?? 1)),
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
    nonInferiority: {
      margin: NON_INFERIORITY_MARGIN,
      bound,
      met,
    },
    verdict,
  };
}

/**
 * Load all stored run records under `.simt/local/bench/runs/`.
 */
export async function loadRunRecords(root) {
  // The pre-move directory is a fallback for one release (review 0003 Q19).
  const runsRoot = join(resolve(root), LOCAL_DIR, 'bench', 'runs');
  let entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => null);
  let base = runsRoot;
  if (entries === null) {
    base = join(resolve(root), '.simt', 'bench', 'runs');
    entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  }
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  const records = [];
  for (const entry of sortedEntries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(base, entry.name);
    if (entry.isDirectory()) {
      const files = (await readdir(fullPath).catch(() => []))
        .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
        .sort();
      for (const file of files) {
        const record = JSON.parse(await readFile(join(fullPath, file), 'utf8'));
        records.push(record);
      }
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      const record = JSON.parse(await readFile(fullPath, 'utf8'));
      records.push(record);
    }
  }
  return records;
}

function fmtPct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtSignedPct(v) {
  const sign = v > 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function fmtUsd(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  return `$${v.toFixed(4)}`;
}

function fmtSignedUsd(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  const sign = v > 0 ? '+' : '';
  return `${sign}$${v.toFixed(4)}`;
}

function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  return v.toFixed(digits);
}

function fmtSignedNum(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}`;
}

/**
 * Render the markdown table for `simt bench report` (and optional `--compare a b` delta block).
 */
export function formatReportMarkdown(report) {
  const lines = [
    '| Arm | Harness | Model | Tasks | Runs | R | 95% CI (R) | Q | C ($) | CPI ($) | Turns | Tool calls | Cache hit |',
    '| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const arm of report.arms) {
    const rCi = `[${fmtPct(arm.ci95.R[0])}, ${fmtPct(arm.ci95.R[1])}]`;
    lines.push(
      `| ${arm.arm} | ${arm.harness} | ${arm.model} | ${arm.tasks} | ${arm.runs} | ${fmtPct(arm.R)} | ${rCi} | ${fmtNum(arm.Q, 3)} | ${fmtUsd(arm.C)} | ${fmtUsd(arm.CPI)} | ${fmtNum(arm.turns, 2)} | ${fmtNum(arm.toolCalls, 2)} | ${fmtPct(arm.cacheHitRatio)} |`,
    );
  }

  if (report.comparison) {
    const cmp = report.comparison;
    const d = cmp.deltas;
    lines.push('');
    lines.push(`### Comparison: \`${cmp.candidate}\` vs \`${cmp.baseline}\` (\`${cmp.candidate} - ${cmp.baseline}\`)`);
    lines.push('');
    lines.push('| Metric | Baseline | Candidate | Delta | 95% CI (Delta) | Test | Statistic | p-value |');
    lines.push('| --- | ---: | ---: | ---: | --- | --- | ---: | ---: |');

    const baseArm = report.arms.find((a) => a.arm === cmp.baseline);
    const candArm = report.arms.find((a) => a.arm === cmp.candidate);

    lines.push(
      `| R | ${baseArm ? fmtPct(baseArm.R) : 'n/a'} | ${candArm ? fmtPct(candArm.R) : 'n/a'} | ${fmtSignedPct(d.R)} | [${fmtSignedPct(cmp.ci95.R[0])}, ${fmtSignedPct(cmp.ci95.R[1])}] | Sign | ${fmtNum(cmp.rTest.statistic, 4)} | ${fmtNum(cmp.rTest.pValue, 4)} |`,
    );
    lines.push(
      `| Q | ${baseArm ? fmtNum(baseArm.Q, 3) : 'n/a'} | ${candArm ? fmtNum(candArm.Q, 3) : 'n/a'} | ${fmtSignedNum(d.Q, 3)} | [${fmtSignedNum(cmp.ci95.Q[0], 3)}, ${fmtSignedNum(cmp.ci95.Q[1], 3)}] | — | — | — |`,
    );
    lines.push(
      `| C ($) | ${baseArm ? fmtUsd(baseArm.C) : 'n/a'} | ${candArm ? fmtUsd(candArm.C) : 'n/a'} | ${fmtSignedUsd(d.C)} | ${cmp.ci95.C ? `[${fmtSignedUsd(cmp.ci95.C[0])}, ${fmtSignedUsd(cmp.ci95.C[1])}]` : 'n/a'} | Wilcoxon | ${fmtNum(cmp.wilcoxon.statistic, 4)} | ${fmtNum(cmp.wilcoxon.pValue, 4)} |`,
    );
    lines.push(
      `| CPI ($) | ${baseArm ? fmtUsd(baseArm.CPI) : 'n/a'} | ${candArm ? fmtUsd(candArm.CPI) : 'n/a'} | ${fmtSignedUsd(d.CPI)} | ${cmp.ci95.CPI ? `[${fmtSignedUsd(cmp.ci95.CPI[0])}, ${fmtSignedUsd(cmp.ci95.CPI[1])}]` : 'n/a'} | — | — | — |`,
    );
    lines.push(
      `| Turns | ${baseArm ? fmtNum(baseArm.turns, 2) : 'n/a'} | ${candArm ? fmtNum(candArm.turns, 2) : 'n/a'} | ${fmtSignedNum(d.turns, 2)} | [${fmtSignedNum(cmp.ci95.turns[0], 2)}, ${fmtSignedNum(cmp.ci95.turns[1], 2)}] | — | — | — |`,
    );
    lines.push(
      `| Tool calls | ${baseArm ? fmtNum(baseArm.toolCalls, 2) : 'n/a'} | ${candArm ? fmtNum(candArm.toolCalls, 2) : 'n/a'} | ${fmtSignedNum(d.toolCalls, 2)} | [${fmtSignedNum(cmp.ci95.toolCalls[0], 2)}, ${fmtSignedNum(cmp.ci95.toolCalls[1], 2)}] | — | — | — |`,
    );
    lines.push(
      `| Cache hit | ${baseArm ? fmtPct(baseArm.cacheHitRatio) : 'n/a'} | ${candArm ? fmtPct(candArm.cacheHitRatio) : 'n/a'} | ${fmtSignedPct(d.cacheHitRatio)} | [${fmtSignedPct(cmp.ci95.cacheHitRatio[0])}, ${fmtSignedPct(cmp.ci95.cacheHitRatio[1])}] | — | — | — |`,
    );
    lines.push('');
    lines.push(
      `Non-inferiority (ΔR lower bound > ${fmtSignedPct(cmp.nonInferiority.margin)}): ${fmtSignedPct(cmp.nonInferiority.bound)} — ${cmp.nonInferiority.met === true ? 'met' : cmp.nonInferiority.met === false ? 'not met' : 'not assessable'}`,
    );
    lines.push(`Verdict: ${cmp.verdict} (${cmp.pairedTasks} paired tasks)`);
  }

  return lines.join('\n');
}

/**
 * Build the complete benchmark report for `root`.
 *
 * Arms are grouped by (harness, model, arm, experiment): pooling the `gold` and
 * `noop` harness runs of the same arm name into one row hid what each harness
 * actually did (review 0003 Q46). A `--compare` across two groups that differ in
 * harness, model or experiment is refused unless `crossGroup` is set.
 */
export async function buildBenchReport(
  root,
  {
    arms: filterArms = [],
    harness: filterHarness,
    model: filterModel,
    compare = null,
    prices: customPrices,
    samples = DEFAULT_BOOTSTRAP_SAMPLES,
    seed = DEFAULT_BOOTSTRAP_SEED,
    crossGroup = false,
  } = {},
) {
  const resolvedRoot = resolve(root);
  const prices = customPrices !== undefined ? customPrices : await loadPrices(resolvedRoot);
  const rawRecords = await loadRunRecords(resolvedRoot);

  const armFilterSet = new Set(filterArms);
  const filtered = rawRecords.filter((rec) => {
    if (armFilterSet.size > 0 && !armFilterSet.has(rec.arm)) return false;
    if (filterHarness && rec.harness !== filterHarness) return false;
    if (filterModel && rec.model !== filterModel) return false;
    return true;
  });

  const evaluated = filtered.map((rec) => evaluateRunRecord(rec, prices));
  const byGroup = new Map();
  for (const row of evaluated) {
    const key = `${row.harness}|${row.model}|${row.arm}|${row.experiment}`;
    const list = byGroup.get(key) ?? [];
    list.push(row);
    byGroup.set(key, list);
  }

  const groupKeys = [...byGroup.keys()].sort();
  const arms = groupKeys.map((key) => {
    const [harness, model, armName] = key.split('|');
    const runs = byGroup.get(key);
    const taskRows = collapseArmByTask(runs);
    const summary = summarizeRows(taskRows);
    const ci95 = bootstrapArmCi(taskRows, { samples, seed });
    return {
      arm: armName,
      harness,
      model,
      tasks: taskRows.length,
      runs: runs.length,
      R: summary.R,
      Q: summary.Q,
      C: summary.C,
      CPI: summary.CPI,
      turns: summary.turns,
      toolCalls: summary.toolCalls,
      cacheHitRatio: summary.cacheHitRatio,
      ci95,
    };
  });

  let comparison = null;
  if (compare) {
    if (!Array.isArray(compare) || compare.length !== 2 || !compare[0] || !compare[1]) {
      throw new Error('--compare requires two arm names: --compare <arm-a> <arm-b>');
    }
    const [armA, armB] = compare;
    const pick = (name) => {
      const matches = groupKeys.filter((k) => k.split('|')[2] === name);
      if (matches.length === 0) {
        throw new Error(`arm "${name}" has no stored benchmark runs`);
      }
      if (matches.length > 1) {
        const listing = matches
          .map((k) => {
            const [h, m, a] = k.split('|');
            return `${a} (harness: ${h}, model: ${m})`;
          })
          .join('; ');
        throw new Error(
          `arm "${name}" is ambiguous — groups: ${listing}; filter with --harness/--model or disambiguate the arm name`,
        );
      }
      return { runs: byGroup.get(matches[0]), groupKey: matches[0] };
    };
    const a = pick(armA);
    const b = pick(armB);
    const ga = a.groupKey.split('|');
    const gb = b.groupKey.split('|');
    const crosses = ga[0] !== gb[0] || ga[1] !== gb[1] || ga[3] !== gb[3];
    if (crosses && !crossGroup) {
      throw new Error(
        `comparing "${armA}" and "${armB}" crosses groups (harness/model differ); pass crossGroup to compare across groups anyway`,
      );
    }
    comparison = compareArms(armA, a.runs, armB, b.runs, { samples, seed });
  }

  const report = {
    root: resolvedRoot,
    pricesLoaded: prices !== null,
    runCount: evaluated.length,
    arms,
    comparison,
  };

  return {
    ...report,
    markdown: formatReportMarkdown(report),
  };
}
