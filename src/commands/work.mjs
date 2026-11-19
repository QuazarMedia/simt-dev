// `simt work inspect` — what this repository's work consists of, and what can validate it.
//
// Plan 4's first read-only door (W20). Every fact here is derived from the tree and the
// manifest, and nothing is executed: `detectFacets` reads paths, `probeLocal` reads which
// gates are declared and which runner files exist, and `capabilityCards` turns those into five
// answers that keep "declared", "available" and "authorized" apart. A knowledge-only
// repository must therefore report that no software test is runnable rather than inventing
// one, which is the failure this door exists to prevent.

import { EXIT, fail, present } from '../output/index.mjs';
import { CLI, MANIFEST_FILE } from '../name.mjs';
import { commandRoot } from '../repo-root.mjs';
import { detectFacets } from '../work/facets.mjs';
import { capabilityCards, probeLocal } from '../work/capabilities.mjs';
import { WORK_VERSION } from '../work/config.mjs';
import { readWork } from '../work/effective.mjs';
import { buildCapsule, checkResume, duplicateEffects, reopenFor } from '../coordination/handoff.mjs';
import { schedule } from '../coordination/workgraph.mjs';
import { proposeGraduation, promotionReady } from '../memory/graduation.mjs';
import { readJsonDocument } from './doc-input.mjs';

const USAGE = `run: ${CLI} work inspect`;

/**
 * The facts the door reports, and the same facts the MCP tool returns.
 *
 * @param {string} root
 * @returns {Promise<object>}
 */
/**
 * The next thing a maintainer can do, in one step.
 *
 * An inspection that ends at "no work declaration" is a wall; the plan's first requirement
 * is that an unconfigured repository reports a small actionable next step instead. The
 * remedy names the file the maintainer owns and the command that reads it again - both
 * exist in this build, which is the only kind of instruction a door may give.
 */
function nextStep({ work, facets, validators }) {
  // A file that does not parse is the first problem: everything below it is a guess about
  // a declaration nobody can read, and naming the scope first would send the reader to a
  // key they cannot save.
  if (work.manifestProblems.length > 0) return { step: `fix ${MANIFEST_FILE}`, remedy: work.manifestProblems[0] };
  const expected = facets.artifactKinds.some((row) => row.kind === 'document') ? 'document' : 'source';
  const declareOne = {
    step: 'declare one scope, so what this repository produces is a declaration rather than a guess',
    remedy: `add "work": {"version": ${WORK_VERSION}, "scopes": [{"id": "<name>", "paths": ["<directory>"], "kind": "${expected}"}]} to ${MANIFEST_FILE}, then run: ${CLI} work inspect`,
  };
  if (!work.declared) return declareOne;
  if (!work.ok) {
    const first = work.problems[0];
    return { step: `fix ${first.path}`, remedy: `${first.message}; ${first.remedy}` };
  }
  // A declaration that names no scope is the same wall as none at all: version 2 alone
  // says nothing about which paths this repository owns.
  if (work.scopes.length === 0) return declareOne;
  // A validator whose file is missing outranks a scope that declares none: the repository
  // asked for this check, and the one action that makes the card honest is to land the file
  // or drop the claim.
  const missing = (Array.isArray(validators) ? validators : []).filter((entry) => entry.installed === false);
  if (missing.length > 0) {
    const first = missing[0];
    const files = (first.files ?? []).filter((file) => file.exists === false).map((file) => `\`${file.path}\``).join(', ') || 'the file it names';
    return {
      step: `${first.command} names ${files}, which this repository does not have`,
      remedy: `add ${files} or remove the validator from the scope in ${MANIFEST_FILE}, then run: ${CLI} work inspect`,
    };
  }
  const unscoped = work.scopes.filter((scope) => scope.validators.length === 0);
  if (unscoped.length > 0) {
    const ids = unscoped.map((scope) => `\`${scope.id}\``).join(', ');
    return {
      step: `scope ${ids} declares no validator`,
      remedy: `add "validators": ["<command>"] to the scope in ${MANIFEST_FILE}, or run a repository command and record its result as evidence`,
    };
  }
  return null;
}

export async function workInspectFacts(root) {
  const [work, facets, local] = await Promise.all([readWork(root), detectFacets(root), probeLocal(root)]);
  return {
    ok: true,
    command: 'work inspect',
    root,
    facets,
    scopes: work.scopes,
    validators: local.validators,
    // An invalid declaration is not a declaration, so the cards are told there is none: a
    // capability the repository claimed in a shape the parser refused was never a claim.
    capabilities: capabilityCards({
      work: work.ok && work.declared ? { version: work.version, scopes: work.scopes, targets: work.targets, adapters: work.adapters } : null,
      local,
    }),
    work: { declared: work.declared, ok: work.ok, version: work.version, problems: work.problems },
    manifestProblems: work.manifestProblems,
    next: nextStep({ work, facets, validators: local.validators }),
  };
}

export async function workInspectCommand(args, flags) {
  if (args.length > 0) return fail(`unknown work inspect argument ${args[0]}`, EXIT.USAGE, USAGE);
  const payload = await workInspectFacts(commandRoot(flags));
  present(payload, () => render(payload), flags);
  return EXIT.OK;
}

/**
 * Which ready tasks can be dispatched together (W38).
 *
 * @param {object} doc
 * @returns {object}
 */
function workScheduleFacts(doc) {
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks : null;
  if (tasks === null) return { error: 'the document needs a tasks list' };
  return {
    ok: true,
    command: 'work schedule',
    ...schedule({
      tasks,
      evidence: doc.evidence ?? {},
      capacity: Number.isInteger(doc.capacity) ? doc.capacity : 2,
      spent: doc.spent ?? {},
    }),
  };
}

/**
 * A resume capsule, built from ids and provenance (W39).
 *
 * @param {object} doc
 * @returns {object}
 */
function workHandoffFacts(doc) {
  try {
    const capsule = buildCapsule(doc?.capsule ?? doc);
    return {
      ok: true,
      command: 'work handoff',
      capsule,
      resume: doc.context !== undefined ? checkResume(capsule, doc.context ?? {}) : null,
      duplicates: Array.isArray(doc.executed) ? duplicateEffects({ capsule, executed: doc.executed }) : null,
      reopened: doc.context?.target !== undefined ? reopenFor({ capsule, target: doc.context.target, revisions: doc.revisions ?? {} }) : null,
    };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Revalidate a capsule before a new session reuses it (W39).
 *
 * @param {object} doc
 * @returns {object}
 */
function workResumeFacts(doc) {
  const capsule = doc?.capsule;
  if (capsule === null || typeof capsule !== 'object') return { error: 'resume needs the capsule it is resuming' };
  return {
    ok: true,
    command: 'work resume',
    resume: checkResume(capsule, doc.context ?? {}),
    duplicates: duplicateEffects({ capsule, executed: Array.isArray(doc.executed) ? doc.executed : [] }),
    reopened: reopenFor({ capsule, target: doc.context?.target ?? null, revisions: doc.revisions ?? {} }),
  };
}

/**
 * Whether repeated traces can be proposed as a procedure (W44).
 *
 * @param {object} doc
 * @returns {object}
 */
function workGraduateFacts(doc) {
  const traces = Array.isArray(doc?.traces) ? doc.traces : null;
  if (traces === null) return { error: 'the document needs a traces list' };
  const proposed = proposeGraduation({ traces });
  const checks = doc.checks !== null && typeof doc.checks === 'object' ? doc.checks : {};
  const proposals = (proposed.proposals ?? []).map((proposal) => {
    const key = proposal.id ?? proposal.goal;
    const check = checks[key];
    return { ...proposal, promotion: check === undefined ? null : promotionReady({ proposal, heldOut: check.heldOut ?? null, failurePath: check.failurePath ?? null }) };
  });
  return { ok: true, command: 'work graduate', ...proposed, proposals };
}

async function documentDoor(sub, args, flags, facts) {
  const usage = `run: ${CLI} work ${sub} --input <file>`;
  if (args.length > 0) return fail(`unknown work ${sub} argument ${args[0]}`, EXIT.USAGE, usage);
  const read = await readJsonDocument(flags, 'input');
  if (read.error !== undefined) return fail(read.error, EXIT.USAGE, usage);
  const payload = facts(read.doc);
  if (payload.error !== undefined) return fail(payload.error, EXIT.FAIL, usage);
  present(payload, () => renderWork(payload), flags);
  return EXIT.OK;
}

export const workScheduleCommand = (args, flags) => documentDoor('schedule', args, flags, workScheduleFacts);
export const workHandoffCommand = (args, flags) => documentDoor('handoff', args, flags, workHandoffFacts);
export const workResumeCommand = (args, flags) => documentDoor('resume', args, flags, workResumeFacts);
export const workGraduateCommand = (args, flags) => documentDoor('graduate', args, flags, workGraduateFacts);

function renderWork(payload) {
  if (payload.command === 'work schedule') return renderSchedule(payload);
  if (payload.command === 'work handoff') return renderHandoff(payload);
  if (payload.command === 'work resume') return renderResume(payload);
  return renderGraduate(payload);
}

function renderSchedule(payload) {
  const lines = [`dispatch   ${payload.dispatch.length === 0 ? 'none' : payload.dispatch.join(', ')}`];
  for (const entry of payload.serialized) lines.push(`serialized ${entry.id}  ${entry.resource === null ? 'capacity' : `after ${entry.after.join(', ')} on ${entry.resource}`}`);
  for (const entry of payload.limited) lines.push(`limited    ${entry.id}  ${entry.reason}`);
  for (const component of payload.cycle) lines.push(`cycle      ${component.reason}`);
  if (payload.waiting.length > 0) lines.push(`waiting    ${payload.waiting.join(', ')}`);
  return lines.join('\n');
}

function renderHandoff(payload) {
  const lines = [`capsule    ${payload.capsule.digest}`, `goal       ${payload.capsule.goal}`, `target     ${payload.capsule.target.incarnation}`];
  for (const entry of payload.capsule.completed) lines.push(`done       ${entry.obligation}  ${entry.receipt ?? ''}`);
  for (const entry of payload.capsule.uncertainty) lines.push(`uncertain  ${entry.id}  ${entry.reason}`);
  lines.push(`excluded   ${payload.capsule.excluded.join(', ')}`);
  if (payload.resume !== null) lines.push(`resumable  ${payload.resume.resumable ? 'yes' : `no: ${payload.resume.failures.map((failure) => failure.reason).join('; ')}`}`);
  if (payload.duplicates !== null) lines.push(`duplicates ${payload.duplicates.safe ? 'none' : payload.duplicates.duplicates.join(', ')}`);
  for (const entry of payload.reopened?.reopened ?? []) lines.push(`reopened   ${entry.obligation}  ${entry.reason}`);
  return lines.join('\n');
}

function renderResume(payload) {
  const lines = [`resumable  ${payload.resume.resumable ? 'yes' : 'no'}`];
  for (const failure of payload.resume.failures) lines.push(`blocked    ${failure.check}  ${failure.reason}`);
  if (payload.duplicates.safe === false) lines.push(`duplicates ${payload.duplicates.duplicates.join(', ')}`);
  for (const entry of payload.reopened.reopened) lines.push(`reopened   ${entry.obligation}  ${entry.reason}`);
  return lines.join('\n');
}

function renderGraduate(payload) {
  const lines = [`traces     ${payload.traces ?? payload.clusters?.length ?? 0}`];
  lines.push(`proposals  ${payload.proposals.length}`);
  for (const proposal of payload.proposals) {
    lines.push(`${String(proposal.state).padEnd(22)} ${proposal.id ?? proposal.goal}`);
    for (const reason of proposal.reasons ?? []) lines.push(`           ${reason}`);
    if (proposal.promotion !== null && proposal.promotion !== undefined) {
      lines.push(`promotion  ${proposal.promotion.ready ? 'ready' : 'not ready'}${proposal.promotion.reason ? `: ${proposal.promotion.reason}` : ''}`);
    }
  }
  return lines.join('\n');
}

function render(payload) {
  const lines = [`root       ${payload.root}`];
  for (const facet of payload.facets.artifactKinds) lines.push(`artifact   ${facet.kind.padEnd(14)}${facet.count}`);
  for (const activity of payload.facets.activities) lines.push(`activity   ${activity.activity.padEnd(14)}${activity.evidence[0] ?? ''}`);
  for (const locus of payload.facets.executionLoci) lines.push(`locus      ${locus.locus}`);
  for (const card of payload.capabilities) {
    lines.push(`validation ${card.kind.padEnd(13)}${card.mode.padEnd(15)}${card.reason}`);
  }
  if (payload.work.declared) {
    lines.push(`work       declared, version ${payload.work.version}, ${payload.work.ok ? 'valid' : `${payload.work.problems.length} problem(s)`}`);
  } else {
    lines.push('work       no work declaration; the facts above come from paths and the manifest alone');
  }
  for (const scope of payload.facets.scopes) lines.push(`scope      ${scope.id.padEnd(14)}${(scope.kind ?? 'any').padEnd(14)}${scope.paths.join(', ')}`);
  for (const validator of payload.validators ?? []) {
    const state = validator.installed === true ? 'installed' : validator.installed === false ? 'MISSING' : 'unproven';
    lines.push(`validator  ${String(validator.scope ?? '-').padEnd(14)}${state.padEnd(12)}${validator.command}`);
  }
  for (const problem of payload.manifestProblems ?? []) lines.push(`manifest   ${problem}`);
  for (const problem of payload.work.problems) lines.push(`problem    ${problem.path}  ${problem.message}`);
  if (payload.facets.truncated) lines.push('truncated  1');
  if (payload.next !== null) {
    lines.push(`next       ${payload.next.step}`);
    lines.push(`           ${payload.next.remedy}`);
  }
  return lines.join('\n');
}
