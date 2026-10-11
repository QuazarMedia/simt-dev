// Read a repo's hook routing and shim state without changing anything.
//
// This is the read half of what `simt-dev hooks status` does inline. It is a separate
// module because two callers need it - `hooks status` and `simt-dev compare` - and a
// second implementation of "is this shim current?" would be exactly the
// duplicated-source-of-truth problem the tool exists to remove. `compare` reads it
// for N repos, so it must not shell out per repo per event.

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { CHAIN_MARKER, EVENTS, HOOKS_DIR, HOOKS_PATH_KEY, fileFor, renderShim } from '../hooks/shim.mjs';
import { foreignHooks, resolveHooksDir } from '../hooks/where.mjs';

const exec = promisify(execFile);

/**
 * The chained shim at `path`, read back out of the file itself.
 *
 * Content, for the reason given on `CHAIN_MARKER`: the file is named after the
 * repository's hook, so the name is exactly the thing that cannot identify it.
 *
 * The target is parsed out of the file rather than remembered from install time
 * because the only authority on what a shim does is the shim. A re-install has to
 * render the identical bytes, and rendering them from a remembered target would let
 * the two drift the moment a repository moved.
 *
 * @param {string} path
 * @returns {Promise<{event:string, target:string}|null>}
 */
export async function readChainedShim(path) {
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  if (!content.includes(CHAIN_MARKER)) return null;
  const target = /^TARGET='(.+)'$/m.exec(content);
  const event = /^# simt-dev does not gate (\S+),/m.exec(content);
  if (!target || !event) return null;
  return { event: event[1], target: target[1] };
}

/** Whether this file is a chained shim this tool wrote. */
async function isChainedShim(path) {
  return (await readChainedShim(path)) !== null;
}

/** `core.hooksPath`, or null when unset or the repo is not a git repo. */
export async function readHooksPath(root) {
  try {
    const { stdout } = await exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root });
    const value = stdout.trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

/**
 * One shim's state. A shim that differs from what this simt-dev generates is
 * `stale`: the gates it enforces are from another version, so it cannot be
 * assumed to know about a gate added since.
 */
export async function describeShim(path) {
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return { present: false, executable: false, stale: false };
  }
  let info;
  try {
    info = await stat(path);
  } catch {
    return { present: false, executable: false, stale: false };
  }
  let stale = true;
  try {
    stale = content !== renderShim(basename(path));
  } catch {
    stale = true;
  }
  return { present: true, executable: (info.mode & 0o111) !== 0, stale };
}

/**
 * @param {string} root
 * @param {{declaresGate?: (event:string)=>boolean}} [options] a missing shim is
 *   only a problem when the repo has a gate that shim would enforce.
 * @returns {Promise<{current:string|null, routed:boolean, complete:boolean,
 *                    installed:object[], foreign:object[], liveDir:string|null,
 *                    problems:string[]}>}
 */
export async function readHooksState(root, options = {}) {
  const declaresGate = options.declaresGate ?? (() => true);
  const current = await readHooksPath(root);
  const installed = [];
  for (const event of EVENTS) {
    installed.push({ event, ...(await describeShim(join(root, fileFor(event)))) });
  }

  // What git runs right now, which is not the same question as "is a simt-dev
  // shim installed". Before this existed the tool read an unset core.hooksPath
  // as "no hooks" and reported a live hand-written hook as not installed.
  const where = await resolveHooksDir(root);
  const live = where.how === 'not-a-repo' ? [] : await foreignHooks(root);
  // A shim is also called `pre-commit`, so the name cannot tell ours from a
  // hand-written one. Only the bytes can.
  const foreign = [];
  const chained = [];
  for (const hook of live) {
    if (EVENTS.includes(hook.event) && !(await describeShim(hook.path)).stale) continue;
    // A chained shim is ours too, and its name says nothing: `post-commit` is what the
    // repository called its own hook, and the shim exists under that name precisely so
    // git finds it. Reading it as foreign would make every re-install refuse with "this
    // repo already runs hooks simt did not write" - a shim this tool wrote, refusing
    // itself. Identity is content, the same rule as the dispatcher shim above.
    const chain = await readChainedShim(hook.path);
    if (chain) {
      chained.push({ ...chain, path: hook.path });
      continue;
    }
    foreign.push(hook);
  }

  const problems = [];
  for (const i of installed) {
    if (!declaresGate(i.event)) continue;
    if (!i.present) problems.push(`${i.event} not installed`);
    else if (!i.executable) problems.push(`${i.event} is not executable`);
    else if (i.stale) problems.push(`${i.event} differs from this simt-dev; reinstall`);
  }
  for (const f of foreign) {
    problems.push(`git runs ${f.event} at ${f.path} (${f.bytes} bytes), which is not a simt-dev shim`);
  }

  return {
    current,
    routed: current === HOOKS_DIR,
    // Complete means routed AND every shim present, executable and current. A repo
    // can route correctly while a shim is missing, which looks installed and is not.
    complete: current === HOOKS_DIR && problems.length === 0,
    installed,
    foreign,
    // The chained shims this repo is already running, read back off disk. `install`
    // re-renders them from here so a second run keeps maintaining them rather than
    // quietly forgetting them; without this field the set of things install maintains
    // would depend on whether the operator happened to run it twice.
    chained,
    liveDir: where.dir,
    problems,
  };
}

export { HOOKS_DIR, HOOKS_PATH_KEY };