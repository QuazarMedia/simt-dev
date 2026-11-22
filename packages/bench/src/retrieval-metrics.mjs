import { performance } from 'node:perf_hooks';

import { mean } from '../../../src/measure/stats.mjs';
import { cmp } from '../../../src/util/sort.mjs';

export const PACKET_BUDGETS = Object.freeze([1024, 2048, 4096]);

const ratio = (hits, count) => count === 0 ? null : hits / count;
const unique = (items = []) => [...new Set(items)];
const countMatching = (items, expected) => items.filter((item) => expected.has(item)).length;
const average = (values) => {
  const measured = values.filter((value) => value !== null);
  return measured.length ? mean(measured) : null;
};

export function gradeRanking(ranking, relevant) {
  const order = unique(ranking);
  const gold = new Set(relevant);
  const first = order.findIndex((item) => gold.has(item));
  let dcg = 0;
  let ideal = 0;
  for (let rank = 0; rank < 10; rank += 1) {
    const discount = 1 / Math.log2(rank + 2);
    if (gold.has(order[rank])) dcg += discount;
    if (rank < gold.size) ideal += discount;
  }
  return {
    recallAt5: ratio(countMatching(order.slice(0, 5), gold), gold.size),
    recallAt10: ratio(countMatching(order.slice(0, 10), gold), gold.size),
    reciprocalRank: gold.size === 0 ? null : first === -1 ? 0 : 1 / (first + 1),
    ndcgAt10: ratio(dcg, ideal),
  };
}

function expectedFacets({ subtasks = [], excludes = [] }) {
  const expected = new Map();
  for (const subtask of subtasks) {
    for (const [facet, ids] of Object.entries(subtask.facets ?? {})) {
      if (ids.length === 0) continue;
      const matches = expected.get(facet) ?? new Set();
      for (const id of ids) matches.add(id);
      expected.set(facet, matches);
    }
  }
  if (excludes.length > 0) {
    expected.set('CAUTIONS', new Set([...(expected.get('CAUTIONS') ?? []), ...excludes]));
  }
  return expected;
}

/** The grader receives only evidence present in the final rendered packet. */
export function gradePacket(packet, gold, budget) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('packet budget must be a non-negative integer');
  if (typeof packet?.text !== 'string') throw new Error('packet must contain rendered text');
  const bytes = Buffer.byteLength(packet.text, 'utf8');
  const fits = bytes <= budget;
  // An oversized result is unusable under the requested budget. Counting a
  // prefix here could credit a partial line or evidence the user never received.
  const files = new Set(fits ? packet.files : []);
  const facets = fits ? packet.facets ?? {} : {};
  const subtaskRecall = (gold.subtasks ?? []).map((task) => {
    const targets = unique(task.files);
    return ratio(countMatching(targets, files), targets.length);
  });
  const expected = expectedFacets(gold);
  const coveredFacets = [...expected.keys()].sort(cmp).filter((facet) =>
    unique(facets[facet]).some((id) => expected.get(facet).has(id)));
  const observedSubtasks = subtaskRecall.filter((value) => value !== null);
  return {
    bytes,
    fits,
    subtaskRecall,
    minSubtaskCoverage: observedSubtasks.length ? Math.min(...observedSubtasks) : null,
    meanSubtaskRecall: average(subtaskRecall),
    facetCompleteness: ratio(coveredFacets.length, expected.size),
    coveredFacets,
  };
}

export function gradeImpact(ranking, { dependents = [], cochange = [], hubOnly = [] } = {}) {
  const order = unique(ranking);
  const gold = new Set([...dependents, ...cochange]);
  const hub = new Set(hubOnly.filter((item) => !gold.has(item)));
  const top = order.slice(0, 10);
  return {
    precisionAt10: ratio(countMatching(top, gold), top.length),
    recallFull: ratio(countMatching(order, gold), gold.size),
    hubNoiseRatio: ratio(countMatching(order, hub), order.length),
  };
}

export function gradeGovernance(result, relevant) {
  const order = unique(result);
  const gold = new Set(relevant);
  const hits = countMatching(order, gold);
  return { precision: ratio(hits, order.length), recall: ratio(hits, gold.size) };
}

export function summarizeLatency(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('latency samples must be finite and non-negative');
  }
  if (!sorted.length) return { samples: 0, p50Ms: null, p95Ms: null };
  const midpoint = (sorted.length - 1) / 2;
  return {
    samples: sorted.length,
    p50Ms: (sorted[Math.floor(midpoint)] + sorted[Math.ceil(midpoint)]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

/** Prepare a cold fixture per sample. Warm samples reuse one primed fixture. */
export async function measureRetrievalLatency({
  prepare, run, dispose = async () => {}, samples = 20, now = () => performance.now(),
}) {
  if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('latency sample count must be a positive integer');
  const cold = [];
  const warm = [];
  async function measure(repo, output) {
    const started = now();
    await run(repo);
    output.push(now() - started);
  }
  for (let index = 0; index < samples; index += 1) {
    const repo = await prepare();
    try {
      await measure(repo, cold);
    } finally {
      await dispose(repo);
    }
  }
  const repo = await prepare();
  try {
    await run(repo);
    for (let index = 0; index < samples; index += 1) await measure(repo, warm);
  } finally {
    await dispose(repo);
  }
  return { cold: summarizeLatency(cold), warm: summarizeLatency(warm) };
}

/** Reports preserve task weighting and make unknown denominators explicit. */
export function summarizeRetrieval(rows) {
  const strata = new Map();
  for (const row of [...rows].sort((a, b) => cmp(a.id, b.id))) {
    const cohort = strata.get(row.stratum) ?? [];
    cohort.push(row.metrics);
    strata.set(row.stratum, cohort);
  }
  return [...strata].sort(([left], [right]) => cmp(left, right)).map(([stratum, cohort]) => {
    const keys = unique(cohort.flatMap(Object.keys)).sort(cmp);
    const metrics = Object.fromEntries(keys.map((key) => {
      const values = cohort.map((row) => row[key]).filter(Number.isFinite);
      return [key, { value: average(values), measured: values.length }];
    }));
    return { stratum, tasks: cohort.length, metrics };
  });
}

export function renderRetrievalSummary(summary) {
  const lines = ['| Stratum | Tasks | Metric | Mean | Measured |', '| --- | ---: | --- | ---: | ---: |'];
  for (const { stratum, tasks, metrics } of summary) {
    for (const [name, { value, measured }] of Object.entries(metrics)) {
      lines.push(`| ${stratum} | ${tasks} | ${name} | ${value === null ? '—' : value.toFixed(6)} | ${measured} |`);
    }
  }
  return lines.join('\n');
}
