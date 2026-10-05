// Run the gates a repo declares for a hook event.
//
// Design commitments, all of them load-bearing:
//
//   Fail closed, never fail open. A gate that cannot run is a failure, not a
//   skip. simt-space removed tests from pre-commit because they were slow, and
//   the documented consequence was that authors reached for --no-verify. A
//   dispatcher that skips what it cannot do reproduces exactly that.
//
//   Never weaken a control to make a hook pass. If a gate fails, the gate
//   fails. There is no "warn and continue" mode, and no gate can be downgraded
//   from inside the hook - only from the manifest, where a reviewer sees it.
//
//   Format and lint are staged-only. (ADR-004) Formatting the whole working
//   tree from a pre-commit hook would rewrite files the author did not stage and
//   did not ask to change.
//
//   Report what did not run. The summary names every gate, its disposition and
//   its reason, so "passed" can never be mistaken for "only some of it passed".

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { GATES } from './gates.mjs';
import { resolveGate } from './resolve.mjs';

const exec = promisify(execFile);

/** Gates that are known but not required for the event to pass. */
export const DEFAULT_EVENTS = { 'pre-commit': 'preCommit', 'pre-push': 'prePush' };

/**
 * @param {string} event 'pre-commit' | 'pre-push'
 * @param {object} ctx
 * @param {string} ctx.root
 * @param {object} ctx.manifest parsed simt-dev.json, or null
 * @returns {Promise<{event: string, gates: object[], failed: boolean}>}
 */
export async function runGates(event, { root, manifest }) {
  const key = DEFAULT_EVENTS[event];
  if (key === undefined) {
    return { event, gates: [], failed: true, error: `unknown hook event ${event}` };
  }

  const declared = manifest?.gates?.[key];
  if (!Array.isArray(declared) || declared.length === 0) {
    return {
      event,
      gates: [],
      failed: false,
      note: `simt-dev.json declares no gates.${key}; nothing to run. That is allowed - a repo may run its checks in CI instead - but declare the intent rather than leaving it empty by accident.`,
    };
  }

  const pkg = await readPkg(root);
  const staged = event === 'pre-commit' ? await stagedFiles(root) : [];
  const commands = manifest?.gates?.commands;
  const results = [];

  for (const name of declared) {
    const gate = GATES[name];
    if (gate === undefined) {
      results.push({
        name,
        status: 'failed',
        detail: `unknown gate; the shared dispatcher knows: ${Object.keys(GATES).sort().join(', ')}`,
        remedy: `remove "${name}" from simt-dev.json gates.${key}`,
        adr: null,
      });
      continue;
    }

    const resolution = await resolveGate(gate, { root, pkg, staged, commands });
    if (!resolution.ok) {
      results.push({
        name,
        status: 'failed',
        detail: resolution.reason,
        remedy: resolution.remedy,
        adr: gate.adr,
      });
      continue;
    }
    if (resolution.argv === null) {
      results.push({ name, status: 'skipped', detail: resolution.detail, adr: gate.adr, exitCode: null });
      continue;
    }

    const outcome = await run(resolution.argv, root);
    results.push({
      name,
      status: outcome.code === 0 ? 'passed' : 'failed',
      detail: `${resolution.detail}${outcome.code === 0 ? '' : `: exit ${outcome.code}`}`,
      output: outcome.code === 0 ? '' : tail(outcome.stderr || outcome.stdout),
      adr: gate.adr,
      exitCode: outcome.code,
    });
  }

  // A formatter that rewrote staged files must re-stage them, or the commit
  // records the unformatted bytes while the working tree holds the formatted
  // ones. This is the one case where the hook mutates the index on purpose.
  if (results.some((r) => r.name === 'format' && r.status === 'passed')) {
    const changed = await restage(root);
    if (changed) results.push({ name: 'restage', status: 'passed', detail: 're-staged files the formatter rewrote', adr: null, exitCode: 0 });
  }

  return { event, gates: results, failed: results.some((r) => r.status === 'failed') };
}

async function run(argv, cwd) {
  try {
    const { stdout, stderr } = await exec(argv[0], argv.slice(1), { cwd, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message ?? error) };
  }
}

async function readPkg(root) {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Staged paths, or [] when git cannot answer (an unborn branch, for instance). */
export async function stagedFiles(root) {
  try {
    const { stdout } = await exec('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: root });
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function restage(root) {
  try {
    const { stdout: before } = await exec('git', ['diff', '--cached', '--name-only'], { cwd: root });
    const files = before.split('\n').map((s) => s.trim()).filter(Boolean);
    if (files.length === 0) return false;
    await exec('git', ['add', '--', ...files], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

/** Last few lines of output, for a failure a human or agent has to act on. */
function tail(text, lines = 12) {
  const parts = String(text).trimEnd().split('\n');
  return parts.slice(-lines).join('\n');
}

export const __internals = { tail, basename };