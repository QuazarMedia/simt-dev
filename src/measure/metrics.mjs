// Derived per-run metrics: what a record costs, and how good it is.
//
// Split from the statistics beside it (review 0003 Q78): a metric is a function of one
// record, a statistical test is a function of a population of them, and a reader looking
// for the cost model should not have to open the bootstrap.
//
// The cost model distinguishes three answers because a missing cost must never read as a
// zero cost: `priced` from the token table, `reported` by the harness, `missing` when
// neither exists (review 0003 Q46).
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { LOCAL_DIR } from '../state.mjs';

function normalizePriceEntry(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON object with {in, cache_write, cache_read, out}`);
  }
  const pIn = Number(raw.in ?? raw.input ?? 0);
  const pCw = Number(raw.cache_write ?? raw.cacheWrite ?? 0);
  const pCr = Number(raw.cache_read ?? raw.cacheRead ?? 0);
  const pOut = Number(raw.out ?? raw.output ?? 0);
  for (const [key, value] of [
    ['in', pIn],
    ['cache_write', pCw],
    ['cache_read', pCr],
    ['out', pOut],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label}.${key} must be a non-negative number`);
    }
  }
  return { in: pIn, cache_write: pCw, cache_read: pCr, out: pOut };
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
 * Load `.simt/local/bench/prices.json` if present.
 *
 * Supports either a flat `{in, cache_write, cache_read, out}` object (prices per 1M
 * tokens) or a map keyed by model/harness name with an optional `"default"` entry.
 *
 * @param {string} root
 * @returns {Promise<null|{kind: 'flat'|'map', entry?: object, entries?: object}>}
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
  for (const [key, value] of Object.entries(parsed)) {
    entries[key] = normalizePriceEntry(value, `${pricesPath}[${JSON.stringify(key)}]`);
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
    (run?.model && prices[run.model]) || (run?.harness && prices[run.harness]) || prices.default || null;
  return entry ? normalizePriceEntry(entry, 'prices') : null;
}

/**
 * Compute billed cost in USD for a single run record.
 *
 * Returns `{usd, source}` where `usd` is null when the cost is unknown: an arm whose
 * prices are absent must not report a free run.
 *
 * @param {object} run
 * @param {object|null} [prices]
 * @returns {{usd: number|null, source: 'priced'|'reported'|'missing'}}
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
        (input * entry.in + cacheWrite * entry.cache_write + cacheRead * entry.cache_read + output * entry.out) /
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

/** Whether a run attempt counts as resolved: hidden tests pass AND declared gates pass. */
export function isRunResolved(run) {
  return Boolean(run?.resolved && (run?.gatesPassed ?? true));
}

/**
 * Quality score Q in [0, 1]: 0.5 hidden tests + 0.2 gates + 0.2 probe + 0.1 diff hygiene.
 *
 * @param {object} run
 * @returns {number}
 */
export function computeRunQuality(run) {
  const testsScore = run?.resolved ? 1 : 0;
  const gatesScore = (run?.gatesPassed ?? true) ? 1 : 0;

  let probeScore = 1;
  if (run?.probe !== null && run?.probe !== undefined) {
    if (typeof run.probe === 'boolean') probeScore = run.probe ? 1 : 0;
    else if (typeof run.probe === 'number' && Number.isFinite(run.probe)) {
      probeScore = Math.max(0, Math.min(1, run.probe));
    } else if (typeof run.probe === 'object') probeScore = run.probe.passed ? 1 : 0;
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
 * Evaluate one record into the row an arm aggregation and a paired test consume.
 *
 * @param {object} run
 * @param {object|null} [prices]
 * @returns {object}
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
  // A v2 experiment is the conditions, a v1 experiment was a label. Both reduce to one
  // string, so grouping by experiment keeps working across a stored corpus.
  const experiment = run?.experiment;
  const experimentKey =
    typeof experiment === 'string'
      ? experiment
      : experiment && typeof experiment === 'object'
        ? [experiment.simtVersion ?? '-', experiment.rulesDigest ?? '-', experiment.corpusDigest ?? '-'].join('/')
        : '';

  return {
    task: String(run?.task ?? ''),
    stratum: String(run?.stratum ?? 'unknown'),
    arm: String(run?.arm ?? 'default'),
    harness: String(run?.harness ?? ''),
    model: String(run?.model ?? ''),
    experiment: experimentKey,
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
