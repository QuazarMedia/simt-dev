// The benchmark report, as data.
//
// A report used to be a summary shape plus prose, assembled by the same function, so a
// caller that wanted the numbers had to accept the table as well. The builder now answers
// one document — `{reportSchema, experiment, strata, arms, comparisons, exclusions,
// warnings}` — and `render.mjs` turns it into markdown (review 0003 Q78).
//
// Two exclusions are distinguished because they mean different things: a record whose run
// errored measured nothing, and a record that was filtered out was never a candidate. A
// corrupt file is a warning, not an exclusion: the file is not a measurement, and calling
// it one would report a run nobody made.
import { resolve } from 'node:path';

import { evaluateRunRecord, loadPrices } from './metrics.mjs';
import { readRunRecords } from './records.mjs';
import { formatReportMarkdown } from './render.mjs';
import {
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  bootstrapArmCi,
  collapseArmByTask,
  compareArms,
  summarizeRows,
} from './stats.mjs';

/** The report's own schema stamp: a consumer can refuse a document it does not know. */
const REPORT_SCHEMA = 'simt.bench.report/2';

/** The experiment a record was produced under, as one sortable string. */
function experimentKey(record) {
  const experiment = record?.experiment;
  if (typeof experiment === 'string') return experiment;
  if (experiment && typeof experiment === 'object') {
    const parts = [
      experiment.simtVersion ?? '-',
      experiment.rulesDigest ?? '-',
      experiment.corpusDigest ?? '-',
      experiment.adapterVersion ?? '-',
    ];
    return parts.join('/');
  }
  return '';
}

/**
 * Build the complete benchmark report for `root`.
 *
 * Arms are grouped by (harness, model, arm, experiment): pooling the `gold` and `noop`
 * harness runs of the same arm name into one row hid what each harness actually did
 * (review 0003 Q46). A `--compare` across two groups that differ in harness, model or
 * experiment is refused unless `crossGroup` is set.
 *
 * @param {string} root
 * @param {{arms?: string[], harness?: string, model?: string, compare?: string[]|null,
 *   prices?: object|null, samples?: number, seed?: number, crossGroup?: boolean}} [options]
 * @returns {Promise<object>}
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
  const { records: rawRecords, warnings } = await readRunRecords(resolvedRoot);

  const armFilterSet = new Set(filterArms);
  const filtered = rawRecords.filter((record) => {
    if (armFilterSet.size > 0 && !armFilterSet.has(record.arm)) return false;
    if (filterHarness && record.harness !== filterHarness) return false;
    if (filterModel && record.model !== filterModel) return false;
    return true;
  });

  // A run that errored produced no measurement: averaging its zero tokens, zero diff and
  // unresolved verdict into an arm reports a result nobody observed (review 0003 Q47).
  const errored = filtered.filter((record) => record.status === 'error');
  const notRun = filtered.filter((record) => record.status === 'planned');
  const evaluated = filtered
    .filter((record) => record.status !== 'error' && record.status !== 'planned')
    .map((record) => evaluateRunRecord(record, prices));

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
      experiment: key.split('|').slice(3).join('|'),
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

  // A stratum is a property of the task, so the same arm can answer differently on small
  // and large changes. Pooling them into one number is how a small-task gain reads as a
  // general one.
  const byStratum = new Map();
  for (const row of evaluated) {
    const key = `${row.stratum}|${row.harness}|${row.model}|${row.arm}`;
    const list = byStratum.get(key) ?? [];
    list.push(row);
    byStratum.set(key, list);
  }
  const strata = [...byStratum.keys()].sort().map((key) => {
    const [stratum, harness, model, arm] = key.split('|');
    const rows = byStratum.get(key);
    const summary = summarizeRows(collapseArmByTask(rows));
    return {
      stratum,
      arm,
      harness,
      model,
      runs: rows.length,
      tasks: new Set(rows.map((row) => row.task)).size,
      R: summary.R,
      Q: summary.Q,
      C: summary.C,
      CPI: summary.CPI,
    };
  });

  let comparison = null;
  if (compare) {
    if (!Array.isArray(compare) || compare.length !== 2 || !compare[0] || !compare[1]) {
      throw new Error('--compare requires two arm names: --compare <arm-a> <arm-b>');
    }
    const [armA, armB] = compare;
    const pick = (name) => {
      const matches = groupKeys.filter((key) => key.split('|')[2] === name);
      if (matches.length === 0) throw new Error(`arm "${name}" has no stored benchmark runs`);
      if (matches.length > 1) {
        const listing = matches
          .map((key) => {
            const [harness, model, arm] = key.split('|');
            return `${arm} (harness: ${harness}, model: ${model})`;
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

  const experiment = {
    records: evaluated.length,
    experiments: [...new Set(evaluated.map((row) => row.experiment).filter((key) => key !== ''))].sort(),
    seeds: [...new Set(rawRecords.map((record) => record?.experiment?.seed).filter((value) => value != null))],
  };

  const report = {
    reportSchema: REPORT_SCHEMA,
    root: resolvedRoot,
    pricesLoaded: prices !== null,
    runCount: evaluated.length,
    excluded: errored.length,
    exclusions: errored.map((record) => ({
      task: record.task ?? null,
      arm: record.arm ?? null,
      harness: record.harness ?? null,
      model: record.model ?? null,
      rep: record.rep ?? null,
      status: record.status,
      error: record.error ?? null,
    })),
    notRun: notRun.length,
    warnings,
    experiment,
    strata,
    arms,
    comparisons: comparison ? [comparison] : [],
    comparison,
  };

  return { ...report, markdown: formatReportMarkdown(report) };
}
