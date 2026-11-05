// The `hooks status` report: what git runs now, what would run, and every problem
// between the two. Extracted from the command so the installer and the report do not
// share a file they do not share a question with.

import { repoContext } from '../context.mjs';
import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { HOOKS_DIR } from '../hooks/shim.mjs';
import { readHooksState, wantsShim } from '../compare/hooksstate.mjs';
import { gateNames, getGate } from '../hooks/gates.mjs';
import { CLI } from '../name.mjs';
import { MANIFEST_FILE } from '../name.mjs';

async function hooksStatus(root, flags, ctx = repoContext(root)) {
  const { manifest, exists, error } = await ctx.manifest();
  if (error) return fail(`${MANIFEST_FILE}: ${error}`, EXIT.CONFIG);

  const state = await readHooksState(root, { declaresGate: (e) => wantsShim(manifest, exists, e) });
  const current = state.current;
  const installed = state.installed;
  const commands = exists ? (manifest?.gates?.commands ?? {}) : {};

  // Collected before the JSON branch so both surfaces answer the same question.
  // This used to be computed only for the text report, and the JSON branch wrote
  // `ok: true` and returned EXIT.OK regardless: a `--json` caller asking whether
  // its hooks are wired up was told yes while the same command in a terminal
  // exited 1. Under `--json` the document IS the report, so a problem that the
  // text path lists has to be in the document and has to move the exit code.
  const problems = collectProblems({ exists, current, installed, manifest, foreign: state.foreign });
  const code = problems.length > 0 ? EXIT.FAIL : EXIT.OK;

  if (isJson(flags)) {
    emitJson({
      ok: code === EXIT.OK,
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
      problems,
    });
    return code;
  }

  const lines = [
    `repo     ${root}`,
    `hooks    ${current ?? '(unset)'}  ${current === HOOKS_DIR ? '(simt-dev)' : current === null ? `(git default: ${state.liveDir})` : '(another routing)'}`,
    `manifest ${exists ? `${MANIFEST_FILE} present` : `${MANIFEST_FILE} MISSING - run: ${CLI} init`}`,
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
        const known = getGate(name, commands);
        // A declared command wins for every kind, so the status must say so too —
        // printing "run script" for a gate the dispatcher will shell out to `./gradlew`
        // for is the same one-question-two-answers defect ADR-018 was written about.
        const declared = typeof commands[name] === 'string' && commands[name].trim() !== '';
        const shape = !known
          ? 'UNKNOWN GATE - this hook will fail'
          : declared
            ? `run ${commands[name]}`
            : `run ${known.kind}`;
        lines.push(`  ${key.padEnd(10)} ${name.padEnd(20)} ${shape}${known ? `  [${known.adr}]` : ''}`);
      }
    }
    const undeclared = [...Object.keys(commands)].filter(
      (c) => ![...(manifest?.gates?.preCommit ?? []), ...(manifest?.gates?.prePush ?? [])].includes(c),
    );
    if (undeclared.length > 0) {
      lines.push('', `declared but never run: ${undeclared.join(', ')}`);
    }
    const unknown = [...(manifest?.gates?.preCommit ?? []), ...(manifest?.gates?.prePush ?? [])].filter((n) => !getGate(n, commands));
    if (unknown.length > 0) {
      lines.push('', `unknown gates (the hook will fail): ${unknown.join(', ')}`);
      lines.push(`known gates: ${gateNames().join(', ')}`);
    }
  }
  if (problems.length > 0) {
    lines.push('', 'problems:');
    for (const p of problems) lines.push(`  ${p}`);
  }
  emit(lines.join('\n'));
  return code;
}

function collectProblems({ exists, current, installed, manifest, foreign = [] }) {
  const problems = [];
  if (!exists) problems.push(`no ${MANIFEST_FILE}; gates are undeclared`);
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
        const gate = getGate(name, manifest?.gates?.commands);
        if (!gate) problems.push(`gate "${name}" in ${key} is not a known gate`);
        else if (gate.kind === 'command' && !manifest?.gates?.commands?.[name]) {
          problems.push(`gate "${name}" in ${key} is a command gate with no declared command; the hook will fail`);
        }
      }
    }
  }
  return problems;
}

export { hooksStatus };
