// `simt verify plan | status` — what is missing, and whether the obligations are closed.
//
// Plan 4's third door (W20, W29). Both read one document and neither invokes anything:
//
//   * `plan` answers which declared capability would discharge the most unmet obligation
//     inside the stated constraints, and stops rather than looping when nothing admissible
//     remains. Every offer it returns is `suggested` with `executed: false`.
//   * `status` answers closure over the obligations and evidence the document records. A
//     missing or unreachable verifier is never a pass, and a closure that claims the remote
//     scope needs its reviewed contract.

import { EXIT, fail, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { planNext } from '../verify/next.mjs';
import { closureReport } from '../verify/closure.mjs';
import { readJsonDocument } from './doc-input.mjs';

const USAGE = `run: ${CLI} verify plan --input <file>  |  ${CLI} verify status --input <file>`;

/**
 * @param {object} doc
 * @returns {object}
 */
export function verifyPlanFacts(doc) {
  return {
    ok: true,
    command: 'verify plan',
    plan: planNext({
      obligations: Array.isArray(doc.obligations) ? doc.obligations : [],
      capabilities: Array.isArray(doc.capabilities) ? doc.capabilities : [],
      constraints: doc.constraints ?? {},
      history: Array.isArray(doc.history) ? doc.history : [],
    }),
  };
}

/**
 * @param {object} doc
 * @returns {object}
 */
export function verifyStatusFacts(doc) {
  try {
    return { ok: true, command: 'verify status', report: closureReport({ ...doc }) };
  } catch (error) {
    // `closureReport` refuses a schema version or a scope it does not know rather than
    // guessing, and the refusal is the answer: the document is the caller's to fix.
    return { error: error.message };
  }
}

export async function verifyCommand(sub, args, flags) {
  if (args.length > 0) return fail(`unknown verify ${sub} argument ${args[0]}`, EXIT.USAGE, USAGE);
  const read = await readJsonDocument(flags, 'input');
  if (read.error !== undefined) return fail(read.error, EXIT.USAGE, USAGE);
  const payload = sub === 'plan' ? verifyPlanFacts(read.doc) : verifyStatusFacts(read.doc);
  if (payload.error !== undefined) return fail(payload.error, EXIT.FAIL, 'a document of obligations, capabilities and constraints');
  present(payload, () => (sub === 'plan' ? renderPlan(payload.plan) : renderStatus(payload.report)), flags);
  return EXIT.OK;
}

function renderPlan(plan) {
  const lines = [`unmet      ${plan.unmet.length}`];
  for (const offer of plan.offers) {
    lines.push(`offer      ${offer.id.padEnd(20)}${offer.covers.join(', ')}  basis=${offer.basis}  score=${offer.score.toFixed(3)}`);
  }
  for (const entry of plan.excluded) lines.push(`excluded   ${entry.id ?? '(malformed)'}  ${entry.reason}`);
  if (plan.stop !== null) {
    lines.push(`stop       ${plan.stop.detail}`);
    lines.push(`remedy     ${plan.stop.remedy}`);
  }
  lines.push('executed   0: a plan suggests observations and invokes none');
  return lines.join('\n');
}

function renderStatus(report) {
  const lines = [`verdict    ${report.verdict}`, `scope      ${report.scope}`, `coverage   ${report.coverage.passed}/${report.coverage.required} required`];
  for (const check of report.unresolved) lines.push(`unresolved ${check.id.padEnd(24)}${check.state}`);
  for (const reason of report.reasons) lines.push(`reason     ${reason}`);
  return lines.join('\n');
}
