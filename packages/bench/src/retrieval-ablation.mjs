import {
  DEFAULT_BOOTSTRAP_SAMPLES, DEFAULT_BOOTSTRAP_SEED, MIN_PAIRD_TASKS, pairedMeanCi,
} from '../../../src/measure/stats.mjs';
import { cmp } from '../../../src/util/sort.mjs';
import { publicRetrievalTask } from './multitask-corpus.mjs';
import {
  gradeGovernance, gradeImpact, gradePacket, gradeRanking, PACKET_BUDGETS, summarizeRetrieval,
  renderRetrievalSummary,
} from './retrieval-metrics.mjs';

const BASELINE = 'baseline-v1';
const FEATURES = ['bm25f-ident', 'guarded-prf', 'directional-graph', 'symbol-bind', 'decompose', 'submodular-pack', 'cochange'];
const arms = new Map([
  [BASELINE, []],
  ...FEATURES.map((feature) => [`+${feature}`, [feature]]),
  ['full-v2', FEATURES],
]);

export const RETRIEVAL_ARMS = Object.freeze([...arms.keys()]);

function gradeObservation(task, label, observation) {
  switch (task.stratum) {
    case 'lexical':
    case 'vocabulary-gap':
      if (!Array.isArray(observation.ranking)) throw new Error(`ranking missing for ${task.id}`);
      return gradeRanking(observation.ranking, label.files);
    case 'composite':
      return Object.fromEntries(PACKET_BUDGETS.flatMap((budget) => {
        const grade = gradePacket(observation.packets?.[budget], label, budget);
        return [
          [`minSubtaskCoverage@${budget}`, grade.minSubtaskCoverage],
          [`meanSubtaskRecall@${budget}`, grade.meanSubtaskRecall],
          [`facetCompleteness@${budget}`, grade.facetCompleteness],
          [`budgetFit@${budget}`, Number(grade.fits)],
        ];
      }));
    case 'impact-governance': {
      const { impact, governance } = observation;
      if (!Array.isArray(impact) || !Array.isArray(governance)) throw new Error(`structural observations missing for ${task.id}`);
      const { precision, recall } = gradeGovernance(governance, label.governance);
      return { ...gradeImpact(impact, label.impact), governancePrecision: precision, governanceRecall: recall };
    }
    default:
      throw new Error(`unknown retrieval stratum: ${task.stratum}`);
  }
}

function compareRetrieval(summary, baselineRows, candidateRows, options) {
  const baseline = new Map(baselineRows.map((row) => [row.id, row.metrics]));
  return summary.flatMap(({ stratum, metrics }) => Object.keys(metrics).map((metric) => {
    const lowerIsBetter = metric === 'hubNoiseRatio';
    const direction = lowerIsBetter ? -1 : 1;
    const deltas = [];
    let unpaired = 0;
    for (const { id, stratum: cohort, metrics: values } of candidateRows) {
      if (cohort !== stratum) continue;
      const before = baseline.get(id)?.[metric];
      const after = values[metric];
      if (Number.isFinite(before) && Number.isFinite(after)) deltas.push(direction * (after - before));
      else if (Number.isFinite(before) || Number.isFinite(after)) unpaired += 1;
    }
    const estimate = pairedMeanCi(deltas, options);
    const paired = deltas.length;
    const ci95 = estimate?.ci95 ?? null;
    let verdict = 'insufficient-tasks';
    if (unpaired > 0 || baselineRows.length !== options.taskCount || candidateRows.length !== options.taskCount) {
      verdict = 'incomplete';
    } else if (paired >= MIN_PAIRD_TASKS) {
      verdict = ci95[0] > 0 ? 'improved' : ci95[1] < 0 ? 'regressed' : 'inconclusive';
    }
    return { stratum, metric, paired, lowerIsBetter, favorableDelta: estimate?.mean ?? null, ci95, verdict };
  }));
}

export async function runRetrievalAblation({
  tasks, gold, files = {}, evaluate, selected = RETRIEVAL_ARMS,
  samples = DEFAULT_BOOTSTRAP_SAMPLES, seed = DEFAULT_BOOTSTRAP_SEED,
}) {
  if (!Array.isArray(tasks) || tasks.length === 0 || !gold || typeof evaluate !== 'function') {
    throw new Error('retrieval ablation requires public tasks, gold and a local evaluator');
  }
  if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('bootstrap samples must be a positive integer');
  for (const name of selected) if (!arms.has(name)) throw new Error(`unknown retrieval arm: ${name}`);
  const taskOrder = [...tasks].sort((a, b) => cmp(a.id, b.id));
  const ids = new Set();
  for (const { id } of taskOrder) {
    if (typeof id !== 'string' || ids.has(id) || !Object.hasOwn(gold, id)) throw new Error(`invalid paired task ID: ${id}`);
    ids.add(id);
  }
  const entries = Object.entries(files).sort(([a], [b]) => cmp(a, b));
  const ordered = Object.freeze(Object.fromEntries(entries));
  const permuted = Object.freeze(Object.fromEntries([...entries].reverse()));
  const results = [];
  let baselineRows;
  for (const name of RETRIEVAL_ARMS.filter((arm) => arm === BASELINE || selected.includes(arm))) {
    const rows = [];
    const options = { arm: name, features: Object.freeze([...arms.get(name)]), budgets: PACKET_BUDGETS };
    for (const task of taskOrder) {
      const descriptor = publicRetrievalTask(task);
      const first = await evaluate({ ...options, task: structuredClone(descriptor), files: ordered });
      const bytes = JSON.stringify(first);
      const repeat = await evaluate({ ...options, task: structuredClone(descriptor), files: ordered });
      const reordered = await evaluate({ ...options, task: structuredClone(descriptor), files: permuted });
      if (bytes !== JSON.stringify(repeat) || bytes !== JSON.stringify(reordered)) {
        throw new Error(`non-deterministic retrieval: ${name} on ${task.id}`);
      }
      if (first != null) rows.push({ id: task.id, stratum: task.stratum, metrics: gradeObservation(task, gold[task.id], first) });
    }
    if (name === BASELINE) baselineRows = rows;
    const summary = summarizeRetrieval(rows);
    results.push({
      name,
      observed: rows.length,
      missing: taskOrder.length - rows.length,
      summary,
      comparisons: name === BASELINE ? [] : compareRetrieval(summary, baselineRows, rows, { samples, seed, taskCount: taskOrder.length }),
    });
  }
  return { tasks: taskOrder.length, samples, seed, arms: results };
}

/** A replay grades previously observed engine output without loading an agent harness. */
export function replayRetrievalAblation({ tasks, gold, files, observations }, { selected } = {}) {
  if (!observations || typeof observations !== 'object' || Array.isArray(observations)) {
    throw new Error('retrieval replay requires observations keyed by arm and task ID');
  }
  return runRetrievalAblation({
    tasks, gold, files, selected,
    evaluate: ({ task, arm }) => observations[arm]?.[task.id] ?? null,
  });
}

export function renderRetrievalAblation(report) {
  const lines = [
    `Retrieval ablation over ${report.tasks} tasks and ${report.samples} bootstrap resamples`,
    '',
    '| Arm | Observed | Missing |',
    '| --- | ---: | ---: |',
  ];
  for (const arm of report.arms) lines.push(`| ${arm.name} | ${arm.observed} | ${arm.missing} |`);
  lines.push('', '| Arm | Stratum | Metric | Paired | Favorable delta | 95% CI | Verdict |',
    '| --- | --- | --- | ---: | ---: | --- | --- |');
  const number = (value) => value === null ? '—' : value.toFixed(6);
  for (const arm of report.arms) {
    for (const row of arm.comparisons) {
      const { stratum, metric, paired, favorableDelta, ci95, verdict } = row;
      const interval = ci95?.map(number).join(' to ') ?? '—';
      lines.push(`| ${arm.name} | ${stratum} | ${metric} | ${paired} | ${number(favorableDelta)} | ${interval} | ${verdict} |`);
    }
  }
  const baseline = report.arms.find(({ name }) => name === BASELINE);
  if (baseline?.summary.length) lines.push('', 'Baseline scores', '', renderRetrievalSummary(baseline.summary));
  return lines.join('\n');
}
