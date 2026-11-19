// Where a gate runs, and whether it is allowed to.
//
// `check` and the dispatcher both answer this question, and they used to answer it with
// their own copy of a prefix test on the resolved string. Two copies disagree the day one
// of them learns about symlinks, and the reader learns about it in the wrong order: the
// check passes, the commit fails. One function, called by both, is the only way the
// finding and the run cannot contradict each other.

import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** The one remedy this condition has, shared so the finding and the gate say the same words. */
export function gateCwdRemedy(name) {
  return `point gates.cwd["${name}"] at a directory in this repository, or remove it to run the gate at the root`;
}

function inside(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * Resolve a declared `gates.cwd` entry for one gate.
 *
 * Containment is checked on the resolved path and again on the canonical one: `..` gets
 * past a string test, and a symlink inside the repository that points outside gets past
 * both the string and the resolved-path test. A directory the repository cannot name is
 * not a directory this gate may run in.
 *
 * @param {string} root repository root, already absolute
 * @param {unknown} declared the manifest's `gates.cwd[name]`, or undefined
 * @param {string} name the gate, for the message
 * @returns {Promise<{ok: true, path: string, declared: string|null}
 *   | {ok: false, status: string, detail: string, remedy: string}>}
 */
export async function resolveGateCwd(root, declared, name) {
  if (declared === undefined || declared === null) return { ok: true, path: root, declared: null };
  const text = String(declared);
  const resolved = resolve(root, text);
  const remedy = gateCwdRemedy(name);
  if (!inside(root, resolved)) {
    return {
      ok: false,
      status: 'gate-cwd-outside',
      detail: `gates.cwd["${name}"] is ${text}, which resolves outside the repository`,
      remedy,
    };
  }
  const entry = await stat(resolved).catch(() => null);
  if (!entry?.isDirectory()) {
    return {
      ok: false,
      status: 'gate-cwd-missing',
      detail: `gates.cwd["${name}"] is ${text}, which is not a directory in this repository`,
      remedy,
    };
  }
  const [canonicalRoot, canonical] = await Promise.all([
    realpath(root).catch(() => root),
    realpath(resolved).catch(() => null),
  ]);
  if (canonical === null || !inside(canonicalRoot, canonical)) {
    return {
      ok: false,
      status: 'gate-cwd-outside',
      detail: `gates.cwd["${name}"] is ${text}, which resolves outside the repository through a link`,
      remedy,
    };
  }
  return { ok: true, path: resolved, declared: text };
}
