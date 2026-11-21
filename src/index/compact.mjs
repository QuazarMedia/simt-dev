// Compaction for output this tool itself produced (ADR-095).
//
// Failures stay whole: the name, the assertion and the location are in the
// block that is printed. Passing tests become a count. A stream that is not
// one of the known formats is left alone, because a summary of an unknown
// log is how a failure disappears.
//
// The reader lives in `testing/parsers.mjs`; this module only renders its
// structure. That is what keeps the gate, bench and the agent-facing view from
// disagreeing about which test passed.

import { parseTestReport } from '../testing/parsers.mjs';

/**
 * Compact a known test report, with an explicit status for the fallback.
 *
 * @param {string} text
 * @returns {{status: 'compacted'|'unavailable', format: string|null, text: string|null}}
 */
export function compactReport(text) {
  const report = parseTestReport(text);
  if (!report) return { status: 'unavailable', format: null, text: null };
  const lines = [`failed  ${report.failed.length}`];
  for (const failure of report.failures) lines.push(failure.detail);
  lines.push(`passed  ${report.passed.length}`);
  if (report.skipped > 0) lines.push(`skipped  ${report.skipped}`);
  return { status: 'compacted', format: report.format, text: lines.join('\n') };
}

/**
 * Compact a known test report. Returns null when the text is not one.
 *
 * Kept for callers that only need the rendered text; `compactReport` is the
 * shape that can say *why* it returned null.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function compactOutput(text) {
  return compactReport(text).text;
}
