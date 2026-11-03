// `simt work inspect` — what this repository's work consists of, and what can validate it.
//
// Plan 4's first read-only door (W20). Every fact here is derived from the tree and the
// manifest, and nothing is executed: `detectFacets` reads paths, `probeLocal` reads which
// gates are declared and which runner files exist, and `capabilityCards` turns those into five
// answers that keep "declared", "available" and "authorized" apart. A knowledge-only
// repository must therefore report that no software test is runnable rather than inventing
// one, which is the failure this door exists to prevent.

import { EXIT, fail, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { commandRoot } from '../repo-root.mjs';
import { loadManifest } from '../manifest/schema.mjs';
import { detectFacets } from '../work/facets.mjs';
import { capabilityCards, probeLocal } from '../work/capabilities.mjs';
import { validateWork } from '../work/config.mjs';
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
export async function workInspectFacts(root) {
  const { manifest } = await loadManifest(root).catch(() => ({ manifest: null }));
  const declared = manifest?.work ?? null;
  const [facets, local] = await Promise.all([detectFacets(root), probeLocal(root)]);
  return {
    ok: true,
    command: 'work inspect',
    root,
    facets,
    capabilities: capabilityCards({ work: declared, local }),
    work:
      declared === null
        ? { declared: false, ok: true, problems: [] }
        : { declared: true, ...validateWork(declared) },
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
    lines.push(`work       declared, ${payload.work.ok ? 'valid' : `${payload.work.problems.length} problem(s)`}`);
  } else {
    lines.push('work       no work declaration; the facts above come from paths and the manifest alone');
  }
  for (const problem of payload.work.problems) lines.push(`problem    ${problem.path}  ${problem.message}`);
  if (payload.facets.truncated) lines.push('truncated  1');
  return lines.join('\n');
}
