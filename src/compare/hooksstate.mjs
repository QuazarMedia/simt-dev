// Read a repo's hook routing and shim state without changing anything.
//
// This is the read half of what `simt hooks status` does inline. It is a separate
// module because two callers need it - `hooks status` and `simt compare` - and a
// second implementation of "is this shim current?" would be exactly the
// duplicated-source-of-truth problem the tool exists to remove. `compare` reads it
// for N repos, so it must not shell out per repo per event.

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { EVENTS, HOOKS_DIR, HOOKS_PATH_KEY, fileFor, renderShim } from '../hooks/shim.mjs';

const exec = promisify(execFile);

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
 * @returns {Promise<{current:string|null, routed:boolean, complete:boolean,
 *                    installed:object[], problems:string[]}>}
 */
export async function readHooksState(root) {
  const current = await readHooksPath(root);
  const installed = [];
  for (const event of EVENTS) {
    installed.push({ event, ...(await describeShim(join(root, fileFor(event)))) });
  }

  const problems = [];
  for (const i of installed) {
    if (!i.present) problems.push(`${i.event} not installed`);
    else if (!i.executable) problems.push(`${i.event} is not executable`);
    else if (i.stale) problems.push(`${i.event} differs from this simt-dev; reinstall`);
  }

  return {
    current,
    routed: current === HOOKS_DIR,
    // Complete means routed AND every shim present, executable and current. A repo
    // can route correctly while a shim is missing, which looks installed and is not.
    complete: current === HOOKS_DIR && problems.length === 0,
    installed,
    problems,
  };
}

export { HOOKS_DIR, HOOKS_PATH_KEY };