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

import { EXIT, fail, present, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { commandRoot } from '../repo-root.mjs';
import { selectLocalVerification } from '../verify/local-selection.mjs';
import { localVerificationStatus, runLocalVerification } from '../verify/local-run.mjs';
import { planNext } from '../verify/next.mjs';
import { closureReport } from '../verify/closure.mjs';
import { checkVerifyRun, selectVerification } from '../verify/select.mjs';
import { readJsonDocument } from './doc-input.mjs';

const USAGE = `run: ${CLI} verify plan --input <file>  |  ${CLI} verify select --input <file>  |  ${CLI} verify status --input <file>`;

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
export function verifySelectFacts(doc) {
  const selection = selectVerification({
    changed: Array.isArray(doc.changed) ? doc.changed : [],
    imports: Array.isArray(doc.imports) ? doc.imports : [],
    closure: Array.isArray(doc.closure) ? doc.closure : null,
    typed: Array.isArray(doc.typed) ? doc.typed : [],
    validators: Array.isArray(doc.validators) ? doc.validators : [],
    scope: Array.isArray(doc.scope) ? doc.scope : [],
  });
  // The policy answer a Git hook needs before anything executes. Nothing is invoked here.
  return {
    ok: true,
    command: 'verify select',
    selection,
    run: checkVerifyRun({ invocation: doc.invocation === 'git-hook' ? 'git-hook' : 'cli', selected: selection.selected }),
  };
}

export function verifyStatusFacts(doc) {
  try {
    return { ok: true, command: 'verify status', report: closureReport({ ...doc }) };
  } catch (error) {
    // `closureReport` refuses a schema version or a scope it does not know rather than
    // guessing, and the refusal is the answer: the document is the caller's to fix.
    return { error: error.message };
  }
}

const LIST_FIELDS = {
  plan: ['obligations', 'capabilities', 'history'],
  select: ['changed', 'imports', 'typed', 'validators', 'scope'],
  status: [],
};

/**
 * The fields a command reads, and the shape a present value must have.
 *
 * The adapters default an absent field to an empty list, which is right; defaulting a
 * present field to one is not, and `{"changed": "a\nb"}` became "nothing changed" and
 * an OK no-op. A request that is empty is legitimate; a request whose
 * field is the wrong type is not evidence of anything.
 */
function inputProblems(sub, doc) {
  const problems = [];
  for (const field of LIST_FIELDS[sub] ?? []) {
    if (doc[field] !== undefined && !Array.isArray(doc[field])) {
      problems.push(`${field} must be a list`);
    }
  }
  if (sub === 'select' && doc.closure !== undefined && doc.closure !== null && !Array.isArray(doc.closure)) {
    problems.push('closure must be a list or null');
  }
  if (sub === 'select' && doc.invocation !== undefined && typeof doc.invocation !== 'string') {
    problems.push('invocation must be a string');
  }
  if (sub === 'plan' && doc.constraints !== undefined && (doc.constraints === null || typeof doc.constraints !== 'object' || Array.isArray(doc.constraints))) {
    problems.push('constraints must be an object');
  }
  return problems;
}

export async function verifyCommand(sub, args, flags) {
  if (args.length > 0) return fail(`unknown verify ${sub} argument ${args[0]}`, EXIT.USAGE, USAGE);
  if (sub === 'run' || flags.changed || flags.staged || flags.scope !== undefined) {
    return localCommand(sub, flags);
  }
  const read = await readJsonDocument(flags, 'input');
  if (read.error !== undefined) return fail(read.error, EXIT.USAGE, USAGE);
  const problems = inputProblems(sub, read.doc);
  if (problems.length > 0) {
    return fail(`malformed ${sub} input (${problems.join('; ')})`, EXIT.USAGE, 'fix the field, or omit it to mean an empty list');
  }
  const payload = sub === 'plan' ? verifyPlanFacts(read.doc) : sub === 'select' ? verifySelectFacts(read.doc) : verifyStatusFacts(read.doc);
  if (payload.error !== undefined) return fail(payload.error, EXIT.FAIL, 'a document of obligations, capabilities and constraints');
  present(payload, () => (sub === 'plan' ? renderPlan(payload.plan) : sub === 'select' ? renderSelect(payload) : renderStatus(payload.report)), flags);
  return EXIT.OK;
}

async function localCommand(sub, flags) {
  const usage = `run: ${CLI} verify ${sub} ${sub === 'select' ? '(--changed | --staged)' : '--changed'} --scope <id>`;
  if (typeof flags.scope !== 'string' || flags.scope === '' ||
      Boolean(flags.changed) === Boolean(flags.staged) ||
      (sub !== 'select' && flags.staged === true) || (sub !== 'status' && flags.input !== undefined)) {
    return fail(`verify ${sub} needs one supported diff mode and a scope`, EXIT.USAGE, usage);
  }
  try {
    const local = await selectLocalVerification(commandRoot(flags), { scopeId: flags.scope, staged: flags.staged === true });
    if (local.error !== undefined) return fail(local.error, EXIT.CONFIG, local.remedy);
    const { selectedChecks, ...result } = local;
    if (sub === 'select') {
      const payload = { ok: true, command: 'verify select', ...result, run: checkVerifyRun({ selected: local.selection.selected }) };
      present(payload, () => renderSelect(payload), flags);
      return EXIT.OK;
    }
    if (sub === 'run') {
      const mode = writeMode(flags);
      const execution = await runLocalVerification(local, { apply: mode.apply });
      const ok = !execution.receipts.some(({ outcome }) => outcome !== 'pass');
      const payload = { ok, command: 'verify run', scope: local.scope, dryRun: !mode.apply, ...execution };
      present(payload, () => renderLocalRun(payload), flags);
      return ok ? EXIT.OK : EXIT.FAIL;
    }
    let attestations = [];
    if (flags.input !== undefined) {
      const read = await readJsonDocument(flags, 'input');
      if (read.error !== undefined) return fail(read.error, EXIT.USAGE, usage);
      if (!Array.isArray(read.doc.attestations)) return fail('attestations must be a list', EXIT.USAGE, usage);
      attestations = read.doc.attestations;
    }
    const status = await localVerificationStatus(local, attestations);
    const payload = { ok: true, command: 'verify status', scope: local.scope, basis: local.basis, ...status };
    present(payload, () => renderLocalStatus(payload), flags);
    return EXIT.OK;
  } catch (error) {
    return fail(`could not ${sub} scoped verification: ${error.message.split('\n')[0]}`, EXIT.FAIL, usage);
  }
}

function renderLocalRun(payload) {
  const lines = [`scope      ${payload.scope}`];
  for (const check of payload.planned) lines.push(`plan       ${check.id}  ${check.covers.length} obligation(s)`);
  for (const receipt of payload.receipts) lines.push(`receipt    ${receipt.evidence.summary}`);
  for (const pending of payload.unverified) lines.push(`unverified ${pending.obligation}  ${pending.reason}`);
  for (const entry of payload.pending) lines.push(`unmapped   ${entry.path}  ${entry.reason}`);
  if (payload.dryRun) lines.push(`preview    run ${CLI} verify run --changed --scope ${payload.scope} --yes to execute`);
  return lines.join('\n');
}

function renderLocalStatus(payload) {
  const lines = [`scope      ${payload.scope} (${payload.basis})`,
    `structure  ${payload.structuralGreen ? 'verified' : 'unverified'}`,
    `verdict    ${payload.verified ? 'verified' : 'open'}`];
  for (const result of payload.results) lines.push(`${result.state.padEnd(16)} ${result.id}  ${result.basis}`);
  for (const entry of payload.pending) lines.push(`unmapped   ${entry.path}  ${entry.reason}`);
  return lines.join('\n');
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

function renderSelect(payload) {
  const { selection, run } = payload;
  const lines = [`status     ${selection.status}${selection.claimsGreen ? '' : ' (not a green claim)'}`];
  for (const name of ['source', 'document', 'remote']) {
    lines.push(`selected   ${name.padEnd(9)}${selection.counts[name]}`);
  }
  for (const entry of selection.plan) {
    lines.push(`plan       ${entry.id.padEnd(24)}${entry.class.padEnd(9)}${entry.basis}${entry.environment ? `  env=${entry.environment}` : ''}`);
  }
  if (payload.scope !== undefined) {
    lines.push(`scope      ${payload.scope} (${payload.basis})`);
    for (const check of payload.checks) {
      if (!check.available) lines.push(`unavailable ${check.id}  ${check.reason}`);
    }
    for (const entry of payload.pending) lines.push(`unmapped    ${entry.path}  ${entry.reason}`);
    for (const entry of payload.renames) lines.push(`rename      ${entry.from} -> ${entry.to}`);
    for (const path of payload.deleted) lines.push(`deleted     ${path}`);
  }
  for (const entry of selection.unverified) lines.push(`unverified ${entry.obligation}  ${entry.reason}`);
  if (selection.environment.length > 0) lines.push(`environment ${selection.environment.join(', ')}`);
  lines.push(`run        ${run.ok ? 'permitted' : `refused: ${run.code}`}${run.detail ? `  ${run.detail}` : ''}`);
  lines.push('executed   0: a selection names checks and invokes none');
  return lines.join('\n');
}

function renderStatus(report) {
  const lines = [`verdict    ${report.verdict}`, `scope      ${report.scope}`, `coverage   ${report.coverage.passed}/${report.coverage.required} required`];
  for (const check of report.unresolved) lines.push(`unresolved ${check.id.padEnd(24)}${check.state}`);
  for (const reason of report.reasons) lines.push(`reason     ${reason}`);
  return lines.join('\n');
}
