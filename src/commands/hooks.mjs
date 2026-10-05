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
// available outcome.

import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { EXIT, emit, emitJson, fail, isJson, note } from '../output/index.mjs';
import { MANIFEST, readManifest } from '../projection/manifest.mjs';
import { EVENTS, HOOKS_DIR, HOOKS_PATH_KEY, fileFor, renderShim } from '../hooks/shim.mjs';
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
  const lines = [`hooks    ${event}`, `gates    ${(manifest.gates[gateKey(event)] ?? []).join(', ') || '(none declared)'}`];
  for (const g of result.gates) {
    lines.push(`${g.status.toUpperCase().padEnd(8)} ${g.name.padEnd(20)} ${g.detail}${g.adr ? `  [${g.adr}]` : ''}`);
    if (g.remedy) lines.push(`        remedy: ${g.remedy}`);
    if (g.output) lines.push(...g.output.split('\n').map((l) => `        ${l}`));
  }
  lines.push(result.failed ? 'BLOCKED  at least one gate failed' : 'PASSED');
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return result.failed ? EXIT.FAIL : EXIT.OK;
}

function gateKey(event) {
  return event === 'pre-commit' ? 'preCommit' : 'prePush';
}

async function installHooks(root, flags) {
  const { manifest, exists, error } = await readManifest(root);
  if (error) return fail(`${MANIFEST}: ${error}`, EXIT.CONFIG);
  if (!exists) {
    return fail(`${root} has no ${MANIFEST}; gates must be declared before hooks can run them`, EXIT.CONFIG, `run: simt-dev init --root ${root}`);
  }

  const current = await readHooksPath(root);
  const wants = HOOKS_DIR;
  const plan = [];
  for (const event of EVENTS) {
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

  // Refuse to take over an existing hooks path without explicit consent. This
  // is the case that matters: simt-app already points core.hooksPath at a
  // directory containing an unrelated LFS post-commit.
  const takeover = current !== null && current !== wants;
  if (takeover && !flags.yes) {
    if (isJson(flags)) {
      emitJson({ ok: false, command: 'hooks install', root, currentHooksPath: current, wouldSet: wants, takeover: true, plan, filesWritten: false });
      return EXIT.FAIL;
    }
    emit(
      [
        `repo     ${root}`,
        `existing ${HOOKS_PATH_KEY} = ${current}`,
        `plan     would set ${HOOKS_PATH_KEY} = ${wants}`,
        '',
        `BLOCKED  ${root} already routes git hooks to "${current}".`,
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
  for (const event of EVENTS) {
    const path = join(root, fileFor(event));
    await writeFile(path, renderShim(event));
    await chmod(path, 0o755);
  }
  await exec('git', ['config', HOOKS_PATH_KEY, wants], { cwd: root });

  const notes = [];
  if (takeover) notes.push(`replaced an existing core.${HOOKS_PATH_KEY} (${current}); the old hooks are still on disk, untouched`);

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

  const current = await readHooksPath(root);
  const installed = [];
  for (const event of EVENTS) {
    const path = join(root, fileFor(event));
    installed.push({ event, ...(await describeShim(path)) });
  }
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
      gates: exists
        ? {
            preCommit: manifest?.gates?.preCommit ?? [],
            prePush: manifest?.gates?.prePush ?? [],
            commands,
          }
        : null,
      problems: collectProblems({ exists, current, installed, manifest }),
    });
    return EXIT.OK;
  }

  const lines = [
    `repo     ${root}`,
    `hooks    ${current ?? '(unset)'}  ${current === HOOKS_DIR ? '(simt-dev)' : current === null ? '(none)' : '(another routing)'}`,
    `manifest ${exists ? `${MANIFEST} present` : `${MANIFEST} MISSING - run: simt-dev init`}`,
    '',
  ];
  for (const i of installed) {
    lines.push(`${(i.present ? 'PRESENT ' : 'ABSENT  ')} ${i.event.padEnd(12)} ${i.present ? `executable=${i.executable}` : 'not installed'}${i.stale ? '  STALE (content differs from this simt-dev)' : ''}`);
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
  const problems = collectProblems({ exists, current, installed, manifest });
  if (problems.length > 0) {
    lines.push('', 'problems:');
    for (const p of problems) lines.push(`  ${p}`);
  }
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return problems.length > 0 ? EXIT.FAIL : EXIT.OK;
}

function collectProblems({ exists, current, installed, manifest }) {
  const problems = [];
  if (!exists) problems.push(`no ${MANIFEST}; gates are undeclared`);
  if (current !== HOOKS_DIR) problems.push(`core.hooksPath is ${current ?? '(unset)'}, expected ${HOOKS_DIR}`);
  for (const i of installed) {
    if (!i.present) problems.push(`${i.event} not installed`);
    else if (!i.executable) problems.push(`${i.event} is not executable`);
    else if (i.stale) problems.push(`${i.event} differs from this simt-dev; reinstall`);
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

async function describeShim(path) {
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return { present: false, executable: false, stale: false };
  }
  const info = await stat(path);
  const event = basename(path);
  let stale = false;
  try {
    stale = content !== renderShim(event);
  } catch {
    stale = true;
  }
  return { present: true, executable: (info.mode & 0o111) !== 0, stale };
}

async function readHooksPath(root) {
  try {
    const { stdout } = await exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root });
    const value = stdout.trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
