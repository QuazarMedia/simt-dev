// simt-dev hooks install | status | run
//
// Three commands with one shared body. `install` writes the shims and points
// core.hooksPath at them; `status` reports what is installed and what would
// run; `run` is the entry point the shim itself execs.
//
// Installing is the only mutating command, it is idempotent, and it refuses to
// clobber an existing core.hooksPath without --yes. The estate has four
// incompatible conventions and one of them (simt-app) points at a directory
// whose pre-push is 0 bytes, so overwriting silently would be the worst
// available outcome. simt-space keeps its hook in the DEFAULT location, which
// core.hooksPath being unset does not reveal, so a foreign hook is found by
// asking git rather than by reading config.

import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { EXIT, emit, emitJson, fail, isJson, note } from '../output/index.mjs';
import { MANIFEST, readManifest } from '../projection/manifest.mjs';
import { EVENTS, HOOKS_DIR, HOOKS_PATH_KEY, fileFor, renderShim } from '../hooks/shim.mjs';
import { readHooksPath, readHooksState } from '../compare/hooksstate.mjs';
import { GATES } from '../hooks/gates.mjs';
import { knownGates } from '../hooks/resolve.mjs';
import { runGates } from '../hooks/dispatcher.mjs';

const exec = promisify(execFile);

export async function hooksCommand(sub, args, flags) {
  const root = flags.root ?? args[0] ?? process.cwd();
  if (sub === 'install') return installHooks(root, flags);
  if (sub === 'status') return hooksStatus(root, flags);
  if (sub === 'run') return runHook(args, flags);
  return fail(`unknown hooks subcommand ${sub}`, EXIT.USAGE, 'run: simt-dev hooks status');
}

/** The shim execs this; the event name is baked into the shim, so it is arg 0. */
async function runHook(args, flags) {
  const event = args[0];
  const root = flags.root ?? process.cwd();
  if (!EVENTS.includes(event)) {
    return fail(`unknown hook event ${event}`, EXIT.USAGE, `known events: ${EVENTS.join(', ')}`);
  }
  const { manifest, exists, error } = await readManifest(root);
  if (error) return fail(`${MANIFEST}: ${error}`, EXIT.CONFIG);
  if (!exists) {
    return fail(`${root} has no ${MANIFEST}; the hook cannot know its gate list`, EXIT.CONFIG, `run: simt-dev init --root ${root}`);
  }

  const result = await runGates(event, { root, manifest });
  if (result.error) return fail(result.error, EXIT.USAGE);

  if (isJson(flags)) {
    emitJson({ ok: !result.failed, command: 'hooks run', root, ...result });
    return result.failed ? EXIT.FAIL : EXIT.OK;
  }

  for (const n of result.notes ?? []) note(`note     ${n}`);
  const lines = [`hooks    ${event}`, `gates    ${(manifest.gates[GATE_KEY[event]] ?? []).join(', ') || '(none declared)'}`];
  for (const g of result.gates) {
    lines.push(`${g.status.toUpperCase().padEnd(8)} ${g.name.padEnd(20)} ${g.detail}${g.adr ? `  [${g.adr}]` : ''}`);
    if (g.remedy) lines.push(`        remedy: ${g.remedy}`);
    if (g.output) lines.push(...g.output.split('\n').map((l) => `        ${l}`));
  }
  lines.push(result.failed ? 'BLOCKED  at least one gate failed' : 'PASSED');
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return result.failed ? EXIT.FAIL : EXIT.OK;
}

const GATE_KEY = { 'pre-commit': 'preCommit', 'pre-push': 'prePush' };

function gateCount(manifest, event) {
  return (manifest?.gates?.[GATE_KEY[event]] ?? []).length;
}

/**
 * Whether a missing shim for this event is a defect.
 *
 * A repo that declares no gate for an event has no reason to want a shim for it,
 * so its absence is the correct end state. A repo with NO manifest is different:
 * we do not know what it wants, so we cannot rule the shim out - absence of
 * knowledge is not a decision.
 */
function wantsShim(manifest, exists, event) {
  if (!exists) return true;
  return gateCount(manifest, event) > 0;
}

async function installHooks(root, flags) {
  const { manifest, exists, error } = await readManifest(root);
  if (error) return fail(`${MANIFEST}: ${error}`, EXIT.CONFIG);
  if (!exists) {
    return fail(`${root} has no ${MANIFEST}; gates must be declared before hooks can run them`, EXIT.CONFIG, `run: simt-dev init --root ${root}`);
  }

  const state = await readHooksState(root, { declaresGate: (e) => wantsShim(manifest, exists, e) });
  const current = state.current;
  const wants = HOOKS_DIR;

  // Only install a shim for an event that declares at least one gate. A shim with
  // an empty gate list enforces nothing, yet merely existing it REPLACES whatever
  // git was running - so installing one over a working hand-written hook is a
  // downgrade dressed as an upgrade. `init` already says this in prose; install
  // has to agree, or the two commands describe different tools.
  const wanted = EVENTS.filter((e) => gateCount(manifest, e) > 0);
  if (wanted.length === 0) {
    if (isJson(flags)) {
      emitJson({ ok: false, command: 'hooks install', root, nothingToEnforce: true, filesWritten: false });
      return EXIT.FAIL;
    }
    emit(
      [
        `repo     ${root}`,
        '',
        `BLOCKED  ${root} declares no gate it can run, so there is nothing to enforce.`,
        '         Installing shims anyway would stop running whatever git runs now',
        '         and replace it with a gate that checks nothing.',
        'REMEDY  add the gates this repo can actually run to simt-dev.json, then re-run.',
      ].join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.FAIL;
  }

  const plan = [];
  for (const event of wanted) {
    const path = join(root, fileFor(event));
    const source = renderShim(event);
    const existing = await readIfExists(path);
    if (existing === source) {
      plan.push({ file: fileFor(event), action: 'unchanged' });
    } else {
      plan.push({ file: fileFor(event), action: existing === null ? 'created' : 'updated' });
    }
  }
  const pathAction = current === wants ? 'unchanged' : current === null ? 'created' : 'updated';

  // Refuse to take over routing git is already using without explicit consent.
  // Two cases, and the second one is the one that bites: core.hooksPath already
  // pointing elsewhere (simt-app points at a directory whose pre-push is 0 bytes),
  // and core.hooksPath being unset while a hook sits in the default location
  // (simt-space, 4 KB of real logic in .git/hooks/pre-commit). Reading unset as
  // "no hooks" is what let install replace a working gate with no warning.
  const takeover = (current !== null && current !== wants) || state.foreign.length > 0;
  if (takeover && !flags.yes) {
    const detail = state.foreign.length > 0
      ? state.foreign.map((f) => `  git runs ${f.event} at ${f.path} (${f.bytes} bytes)`)
      : [`  existing ${HOOKS_PATH_KEY} = ${current}`];
    if (isJson(flags)) {
      emitJson({ ok: false, command: 'hooks install', root, currentHooksPath: current, wouldSet: wants, takeover: true, foreign: state.foreign, plan, filesWritten: false });
      return EXIT.FAIL;
    }
    emit(
      [
        `repo     ${root}`,
        ...detail,
        `plan     would set ${HOOKS_PATH_KEY} = ${wants}`,
        '',
        `BLOCKED  ${root} already runs git hooks that simt-dev did not write.`,
        '         Taking over replaces that routing. Inspect the existing hooks first,',
        '         then re-run with --yes to accept, or set core.hooksPath yourself.',
      ].join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.FAIL;
  }

  if (flags.dryRun) {
    if (isJson(flags)) {
      emitJson({ ok: true, command: 'hooks install', root, dryRun: true, currentHooksPath: current, wouldSet: wants, plan, filesWritten: false });
      return EXIT.OK;
    }
    emit(renderPlan(root, current, wants, pathAction, plan, 'DRY-RUN  no files written', manifest), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  await mkdir(join(root, HOOKS_DIR), { recursive: true });
  for (const event of wanted) {
    const path = join(root, fileFor(event));
    await writeFile(path, renderShim(event));
    await chmod(path, 0o755);
  }
  await exec('git', ['config', HOOKS_PATH_KEY, wants], { cwd: root });

  const notes = [];
  if (state.foreign.length > 0) {
    for (const f of state.foreign) {
      notes.push(`stopped running ${f.event} at ${f.path} (${f.bytes} bytes); the file is still on disk, untouched`);
    }
  } else if (takeover) {
    notes.push(`replaced an existing core.${HOOKS_PATH_KEY} (${current}); the old hooks are still on disk, untouched`);
  }

  if (isJson(flags)) {
    emitJson({ ok: true, command: 'hooks install', root, hooksPath: wants, previousHooksPath: current, plan, filesWritten: true, notes });
    return EXIT.OK;
  }
  emit(renderPlan(root, current, wants, pathAction, plan, 'WROTE    shims and set core.hooksPath', manifest), { maxBytes: flags.maxBytes ?? 0 });
  for (const n of notes) note(`note     ${n}`);
  note(`note     never committed or pushed (ADR-001); review, then commit yourself`);
  return EXIT.OK;
}

function renderPlan(root, current, wants, pathAction, plan, headline, manifest) {
  const lines = [`repo     ${root}`, `${HOOKS_PATH_KEY.padEnd(15)} ${pathAction}  ${current ?? '(unset)'} -> ${wants}`, ''];
  for (const p of plan) lines.push(`${p.action.toUpperCase().padEnd(9)} ${p.file}`);
  lines.push('', headline);
  lines.push(`gates    preCommit = ${describeGates(manifest, 'preCommit')}`);
  lines.push(`         prePush   = ${describeGates(manifest, 'prePush')}`);
  return lines.join('\n');
}

function describeGates(manifest, key) {
  const list = manifest?.gates?.[key];
  if (!Array.isArray(list) || list.length === 0) return '(none declared)';
  return list.map((name) => {
    const gate = GATES[name];
    return gate ? name : `${name} (UNKNOWN - the hook will fail)`;
  }).join(', ');
}

async function hooksStatus(root, flags) {
  const { manifest, exists, error } = await readManifest(root);
  if (error) return fail(`${MANIFEST}: ${error}`, EXIT.CONFIG);

  const state = await readHooksState(root, { declaresGate: (e) => wantsShim(manifest, exists, e) });
  const current = state.current;
  const installed = state.installed;
  const commands = exists ? (manifest?.gates?.commands ?? {}) : {};

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'hooks status',
      root,
      hooksPath: current,
      expectedHooksPath: HOOKS_DIR,
      manifestPresent: exists,
      installed,
      // The machine-readable surface has to carry this too. An agent reading the
      // JSON never sees the text block, and a fact that exists only in prose is a
      // fact the tool did not actually report.
      hooksDir: state.liveDir,
      foreign: state.foreign,
      gates: exists
        ? {
            preCommit: manifest?.gates?.preCommit ?? [],
            prePush: manifest?.gates?.prePush ?? [],
            commands,
          }
        : null,
      problems: collectProblems({ exists, current, installed, manifest, foreign: state.foreign }),
    });
    return EXIT.OK;
  }

  const lines = [
    `repo     ${root}`,
    `hooks    ${current ?? '(unset)'}  ${current === HOOKS_DIR ? '(simt-dev)' : current === null ? `(git default: ${state.liveDir})` : '(another routing)'}`,
    `manifest ${exists ? `${MANIFEST} present` : `${MANIFEST} MISSING - run: simt-dev init`}`,
    '',
  ];
  for (const i of installed) {
    lines.push(`${(i.present ? 'PRESENT ' : 'ABSENT  ')} ${i.event.padEnd(12)} ${i.present ? `executable=${i.executable}` : 'not installed'}${i.stale ? '  STALE (content differs from this simt-dev)' : ''}`);
  }
  // An unset core.hooksPath means git falls back to .git/hooks, so "not
  // installed" above can sit next to a hook git is running right now. Say both.
  if (state.foreign.length > 0) {
    lines.push('', 'git runs these, and simt-dev did not write them:');
    for (const f of state.foreign) lines.push(`  ${f.event.padEnd(12)} ${f.path}  ${f.bytes} bytes`);
    lines.push('installing the shims stops running these; inspect them first.');
  }
  if (exists) {
    lines.push('', 'would run:');
    for (const key of ['preCommit', 'prePush']) {
      for (const name of manifest?.gates?.[key] ?? []) {
        const known = GATES[name];
        lines.push(`  ${key.padEnd(10)} ${name.padEnd(20)} ${known ? `run ${known.kind}  [${known.adr}]` : 'UNKNOWN GATE - this hook will fail'}`);
      }
    }
    const undeclared = [...Object.keys(commands)].filter(
      (c) => ![...(manifest?.gates?.preCommit ?? []), ...(manifest?.gates?.prePush ?? [])].includes(c),
    );
    if (undeclared.length > 0) {
      lines.push('', `declared but never run: ${undeclared.join(', ')}`);
    }
    const unknown = [...(manifest?.gates?.preCommit ?? []), ...(manifest?.gates?.prePush ?? [])].filter((n) => !GATES[n]);
    if (unknown.length > 0) {
      lines.push('', `unknown gates (the hook will fail): ${unknown.join(', ')}`);
      lines.push(`known gates: ${knownGates().join(', ')}`);
    }
  }
  const problems = collectProblems({ exists, current, installed, manifest, foreign: state.foreign });
  if (problems.length > 0) {
    lines.push('', 'problems:');
    for (const p of problems) lines.push(`  ${p}`);
  }
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return problems.length > 0 ? EXIT.FAIL : EXIT.OK;
}

function collectProblems({ exists, current, installed, manifest, foreign = [] }) {
  const problems = [];
  if (!exists) problems.push(`no ${MANIFEST}; gates are undeclared`);
  if (current !== HOOKS_DIR) problems.push(`core.hooksPath is ${current ?? '(unset)'}, expected ${HOOKS_DIR}`);
  for (const i of installed) {
    // A repo that declares no gate for an event has no reason to want a shim
    // for it, so its absence is the correct end state rather than a defect.
    if (!wantsShim(manifest, exists, i.event)) continue;
    if (!i.present) problems.push(`${i.event} not installed`);
    else if (!i.executable) problems.push(`${i.event} is not executable`);
    else if (i.stale) problems.push(`${i.event} differs from this simt-dev; reinstall`);
  }
  for (const f of foreign) {
    problems.push(`git runs ${f.event} at ${f.path} (${f.bytes} bytes), which is not a simt-dev shim`);
  }
  if (exists) {
    for (const key of ['preCommit', 'prePush']) {
      for (const name of manifest?.gates?.[key] ?? []) {
        if (!GATES[name]) problems.push(`gate "${name}" in ${key} is not a known gate`);
        else if (GATES[name].kind === 'command' && !manifest?.gates?.commands?.[name]) {
          problems.push(`gate "${name}" in ${key} is a command gate with no declared command; the hook will fail`);
        }
      }
    }
  }
  return problems;
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
