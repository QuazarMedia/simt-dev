// The markdown surface of a benchmark report.
//
// The report is data and its renderers are separate (review 0003 Q78): the builder used
// to assemble the table inside the same function that computed it, so a caller that
// wanted the numbers had to accept prose as well, and a second renderer meant editing the
// computation.
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
 * Render the report as the markdown table `simt bench report` prints, with the optional
 * comparison block.
 *
 * @param {object} report a report from `buildBenchReport`
 * @returns {string}
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

  if (report.excluded > 0) {
    lines.push('');
    lines.push(
      `${report.excluded} run record(s) excluded: the run errored or exceeded its deadline, so it recorded no measurement`,
    );
  }

  for (const warning of report.warnings ?? []) {
    lines.push('');
    lines.push(`warning: ${warning}`);
  }

  if (report.comparison) {
    const cmp = report.comparison;
    const d = cmp.deltas;
    lines.push('');
    lines.push(`### Comparison: \`${cmp.candidate}\` vs \`${cmp.baseline}\` (\`${cmp.candidate} - ${cmp.baseline}\`)`);
    lines.push('');
    lines.push('| Metric | Baseline | Candidate | Delta | 95% CI (Delta) | Test | Statistic | p-value |');
    lines.push('| --- | ---: | ---: | ---: | --- | --- | ---: | ---: |');

    const baseArm = report.arms.find((arm) => arm.arm === cmp.baseline);
    const candArm = report.arms.find((arm) => arm.arm === cmp.candidate);

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
