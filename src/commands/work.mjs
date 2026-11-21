// `simt work inspect` — what this repository's work consists of, and what can validate it.
//
// Plan 4's first read-only door (W20). Every fact here is derived from the tree and the
// manifest, and nothing is executed: `detectFacets` reads paths, `probeLocal` reads which
// gates are declared and which runner files exist, and `capabilityCards` turns those into five
// answers that keep "declared", "available" and "authorized" apart. A knowledge-only
// repository must therefore report that no software test is runnable rather than inventing
// one, which is the failure this door exists to prevent.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT, fail, note, present, writeMode } from '../output/index.mjs';
import { CLI, MANIFEST_FILE, MANIFEST_LEGACY } from '../name.mjs';
import { commandRoot } from '../repo-root.mjs';
import { detectFacets } from '../work/facets.mjs';
import { capabilityCards, probeLocal } from '../work/capabilities.mjs';
import { readWork } from '../work/effective.mjs';
import { normalizePath } from '../work/artifacts.mjs';
import { proposeScope } from '../work/setup.mjs';
import { loadManifest, manifestPath } from '../manifest/schema.mjs';
import { writeManifest } from '../projection/manifest.mjs';
import { commitJournal, journaledRemoveFile, journaledWriteFile } from '../journal.mjs';
import { diffField, emitDiffs, readBefore } from '../diff.mjs';
import { buildCapsule, checkResume, duplicateEffects, reopenFor } from '../coordination/handoff.mjs';
import { schedule } from '../coordination/workgraph.mjs';
import { scheduleLocal } from '../coordination/local-tracker.mjs';
import { localHandoff, localResume } from '../coordination/local-handoff.mjs';
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
/** The top directory the sample's first document sits in, or `.` when it sits at the root. */
function suggestedDir(facets) {
  const evidence = facets.artifactKinds.find((row) => row.kind === 'document')?.evidence ?? [];
  const first = evidence.find((path) => !path.includes('#'));
  if (first === undefined) return '.';
  const [head, ...rest] = first.split('/');
  return rest.length === 0 ? '.' : head;
}

/** A scope id a reader can act on: the directory it would own, as one word. */
function suggestedId(facets) {
  return suggestedDir(facets).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || '<name>';
}

/** The kind a scope defaults to, read from the same sample the inspection reports. */
function defaultKind(facets, path) {
  const documents = facets.artifactKinds.find((row) => row.kind === 'document');
  if (documents === undefined) return 'source';
  const dir = typeof path === 'string' ? normalizePath(path) : null;
  if (dir === null || dir === '') return 'document';
  return documents.evidence.some((entry) => entry === dir || entry.startsWith(`${dir}/`)) ? 'document' : 'source';
}

function nextStep({ work, facets, validators }) {
  // A file that does not parse is the first problem: everything below it is a guess about
  // a declaration nobody can read, and naming the scope first would send the reader to a
  // key they cannot save.
  if (work.manifestProblems.length > 0) return { step: `fix ${MANIFEST_FILE}`, remedy: work.manifestProblems[0] };
  const expected = facets.artifactKinds.some((row) => row.kind === 'document') ? 'document' : 'source';
  const declareOne = {
    step: 'declare one scope, so what this repository produces is a declaration rather than a guess',
    // The remedy is a command, not a snippet: an instruction a reader cannot run is a second
    // problem stacked on the first.
    remedy: `run: ${CLI} work setup --scope ${suggestedId(facets)} --path ${suggestedDir(facets)} --kind ${expected}`,
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

const SETUP_USAGE = `run: ${CLI} work setup --scope <id> --path <dir> --kind <kind> [--validator "<command>"]`;

/** The line a reader can paste: the scope, spelled with the flags this command takes. */
function applyCommand(scope) {
  const validator = scope.validators?.[0];
  const declared = validator === undefined ? '' : ` --validator ${JSON.stringify(validator)}`;
  return `run: ${CLI} work setup --scope ${scope.id} --path ${scope.paths[0]} --kind ${scope.kind}${declared} --yes`;
}

/** The legacy name this apply retires, or `null` when there is nothing to retire. */
function legacyManifest(root) {
  const fresh = join(root, MANIFEST_FILE);
  return existsSync(join(root, MANIFEST_LEGACY)) && !existsSync(fresh) ? MANIFEST_LEGACY : null;
}

const reason = (error) => String(error?.message ?? error).split('\n')[0];

/**
 * One scope, previewed and then written by the manifest's own writer.
 *
 * A preview writes nothing at all - no manifest, no journal, no git config - so the diff it
 * shows is exactly the byte change the apply makes. The second apply finds the scope it
 * would add and changes nothing, which is what makes the command safe to re-run.
 */
export async function workSetupCommand(args, flags) {
  if (args.length > 0) return fail(`unknown work setup argument ${args[0]}`, EXIT.USAGE, SETUP_USAGE);
  const root = commandRoot(flags);
  const mode = writeMode(flags);
  const loaded = await loadManifest(root);
  if (loaded.exists && loaded.manifest === null) {
    return fail(`${MANIFEST_FILE}: ${loaded.problems[0] ?? 'unparseable'}`, EXIT.CONFIG, `fix ${MANIFEST_FILE}, then rerun: ${SETUP_USAGE.replace('run: ', '')}`);
  }
  const manifest = loaded.manifest ?? {};
  const facets = await detectFacets(root);
  const kind = typeof flags.kind === 'string' && flags.kind !== '' ? flags.kind : defaultKind(facets, flags.path);
  const proposal = proposeScope({ manifest, scope: flags.scope, path: flags.path, kind, validator: flags.validator });
  if (proposal.error !== undefined) return fail(proposal.error, EXIT.USAGE, proposal.remedy);

  const before = await readBefore(await manifestPath(root));
  const after = proposal.changed ? proposal.text : before;
  const diffs = flags.diff === true ? [{ path: MANIFEST_FILE, before, after }] : [];
  const retired = proposal.changed ? legacyManifest(root) : null;
  const apply = proposal.changed ? applyCommand(proposal.scope) : null;
  const payload = {
    ok: true,
    command: 'work setup',
    root,
    manifest: MANIFEST_FILE,
    retired,
    dryRun: !mode.apply,
    changed: proposal.changed,
    written: false,
    scope: proposal.scope,
    // The exact bytes the apply writes: a preview is only a preview if a reader can compare
    // this against the file afterwards.
    next: after,
    ...diffField(diffs, flags),
    remedy: apply !== null && !mode.apply ? apply : null,
  };

  if (mode.apply && proposal.changed) {
    const journal = [];
    // `writeManifest` retires a legacy `simt-dev.json` by renaming it, and a rename outside
    // the journal is one `undo` cannot put back: it would delete `simt.json` and leave the
    // repository with no manifest at all. So the retirement is journaled first, as a create
    // of the new name and a removal of the old, before the writer finds anything to move.
    if (retired !== null) {
      const bytes = readFileSync(join(root, MANIFEST_LEGACY), 'utf8');
      await journaledWriteFile(root, journal, join(root, MANIFEST_FILE), bytes);
      await journaledRemoveFile(root, journal, join(root, MANIFEST_LEGACY));
    }
    try {
      await writeManifest(root, proposal.next, journal);
    } catch (error) {
      return fail(`${MANIFEST_FILE} could not be written: ${reason(error)}`, EXIT.FAIL, `nothing was recorded: fix the reason, then rerun ${applyCommand(proposal.scope).replace('run: ', '')}`);
    }
    let set = null;
    try {
      set = await commitJournal(root, 'work setup', journal);
    } catch (error) {
      return fail(`${MANIFEST_FILE} is written, but its journal set is not: ${reason(error)}`, EXIT.FAIL, `the scope stands; ${CLI} undo cannot reverse this write, so edit the file by hand if it has to go`);
    }
    payload.written = true;
    note(`wrote    ${MANIFEST_FILE}`);
    if (retired !== null) note(`retired  ${retired}  (${MANIFEST_FILE} replaces it; ${CLI} undo restores both)`);
    if (set !== null) note(`journal  ${set}  (${CLI} undo restores it)`);
  }
  present(payload, () => renderSetup(payload), flags);
  emitDiffs(diffs, flags);
  return EXIT.OK;
}

function renderSetup(payload) {
  const lines = [
    `manifest   ${payload.manifest}`,
    `scope      ${payload.scope.id}  ${payload.scope.kind ?? 'any'}  ${payload.scope.paths.join(', ')}`,
  ];
  for (const command of payload.scope.validators ?? []) lines.push(`validator  ${command}`);
  if (payload.retired !== null) lines.push(`retires    ${payload.retired}`);
  if (!payload.changed) lines.push('unchanged  this scope is already declared; nothing to write');
  else lines.push(payload.written ? 'wrote      one scope' : 'would add  one scope (preview: no bytes written)');
  if (payload.remedy !== null) lines.push(`apply      ${payload.remedy}`);
  return lines.join('\n');
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

export async function workScheduleCommand(args, flags) {
  if (flags.scope === undefined && flags.public !== true) return documentDoor('schedule', args, flags, workScheduleFacts);
  const usage = `run: ${CLI} work schedule --scope <id> [--public]`;
  if (args.length > 0 || typeof flags.scope !== 'string' || flags.scope === '' || flags.input !== undefined) {
    return fail('tracker scheduling needs a scope without an explicit input', EXIT.USAGE, usage);
  }
  try {
    const result = await scheduleLocal(commandRoot(flags), flags.scope, { publicOnly: flags.public === true });
    if (result.error !== undefined) return fail(result.error, EXIT.CONFIG, result.remedy);
    const payload = { ok: true, command: 'work schedule', ...result };
    present(payload, () => renderSchedule(payload), flags);
    return EXIT.OK;
  } catch (error) {
    return fail(`could not read the configured tracker: ${error.message.split('\n')[0]}`, EXIT.FAIL, usage);
  }
}
export const workHandoffCommand = (args, flags) => flags.scope === undefined
  ? documentDoor('handoff', args, flags, workHandoffFacts)
  : localHandoffDoor('handoff', args, flags);
export const workResumeCommand = (args, flags) => flags.scope === undefined
  ? documentDoor('resume', args, flags, workResumeFacts)
  : localHandoffDoor('resume', args, flags);

async function localHandoffDoor(sub, args, flags) {
  const creating = sub === 'handoff';
  const usage = `run: ${CLI} work ${sub} --scope <id> ${creating ? '--task <id>' : '--input <capsule>'}`;
  if (args.length > 0 || typeof flags.scope !== 'string' || flags.scope === '' ||
      (creating ? typeof flags.task !== 'string' || flags.input !== undefined
        : flags.task !== undefined || typeof flags.input !== 'string')) return fail('invalid local handoff arguments', EXIT.USAGE, usage);
  try {
    const root = commandRoot(flags);
    let result;
    if (creating) result = await localHandoff(root, flags.scope, flags.task, flags.session);
    else {
      const read = await readJsonDocument(flags, 'input');
      if (read.error !== undefined) return fail(read.error, EXIT.USAGE, usage);
      result = await localResume(root, flags.scope, read.doc.capsule ?? read.doc, flags.session);
    }
    if (result.error !== undefined) return fail(result.error, EXIT.FAIL, result.remedy ?? usage);
    const payload = { ok: true, command: `work ${sub}`, ...result };
    present(payload, () => renderWork(payload), flags);
    return EXIT.OK;
  } catch (error) {
    return fail(`could not ${sub} local work: ${error.message.split('\n')[0]}`, EXIT.FAIL, usage);
  }
}
export const workGraduateCommand = (args, flags) => documentDoor('graduate', args, flags, workGraduateFacts);

function renderWork(payload) {
  if (payload.command === 'work schedule') return renderSchedule(payload);
  if (payload.command === 'work handoff') return renderHandoff(payload);
  if (payload.command === 'work resume') return renderResume(payload);
  return renderGraduate(payload);
}

function renderSchedule(payload) {
  const lines = [`dispatch   ${payload.dispatch.length === 0 ? 'none' : payload.dispatch.join(', ')}`];
  if (payload.withheld) lines.push('tracker    private');
  for (const entry of payload.serialized ?? []) lines.push(`serialized ${entry.id}  ${entry.resource === null ? 'capacity' : `after ${entry.after.join(', ')} on ${entry.resource}`}`);
  for (const entry of payload.limited ?? []) lines.push(`limited    ${entry.id}  ${entry.reason}`);
  for (const component of payload.cycle ?? []) lines.push(`cycle      ${component.reason}`);
  for (const entry of payload.waiting ?? []) lines.push(`waiting    ${entry.id}  ${entry.missing.join(', ')}`);
  for (const entry of payload.problems ?? []) lines.push(`problem    ${entry.code}  ${entry.id ?? entry.source ?? ''}`);
  return lines.join('\n');
}

function renderHandoff(payload) {
  const lines = [`capsule    ${payload.capsule.digest}`, `goal       ${payload.capsule.goal}`,
    payload.capsule.local === undefined ? `target     ${payload.capsule.target.incarnation}` : `scope      ${payload.capsule.local.scope}`];
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
  for (const id of payload.reopened.retained ?? []) lines.push(`retained   ${id}`);
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
