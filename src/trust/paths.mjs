// What counts as "inside this repository" (ADR-205).
//
// Four boundaries took repository-supplied paths and each decided containment its own
// way. Three of them compared strings (`relative(root, path).startsWith('..')`), which is
// a statement about spelling: `repo/link -> /etc` is inside the repository by that check
// and a write through it lands in `/etc`. The journal refused `../x` and accepted the
// link; the skill lookup joined a registry path and measured whatever it found; the
// federation gate compared a requested root with the server's ground the same lexical
// way; and the index imported a parser by name from the repository's own manifest.
//
// Containment is a filesystem question, so it is answered by the filesystem: resolve the
// root and the target through every link (realpath), and compare the resolved pair. A
// target that does not exist yet - the normal case for a write - is resolved through its
// nearest existing ancestor, because that is the part a link can redirect.
//
// The answer is deliberately conservative. A path that cannot be resolved (EACCES, ELOOP)
// is NOT inside: a check that cannot prove containment must not claim it.

import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** The filesystem's answer for a path that may not exist yet. */
async function canonical(path) {
  const target = resolve(String(path));
  const missing = [];
  let cursor = target;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return missing.length === 0 ? real : join(real, ...missing.slice().reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') return { unresolved: error.code ?? 'EIO' };
      const parent = resolve(cursor, '..');
      if (parent === cursor) return { unresolved: 'ENOENT' };
      missing.push(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
}

/** The synchronous form, for callers whose contract is a synchronous boolean. */
function canonicalSync(path) {
  const target = resolve(String(path));
  const missing = [];
  let cursor = target;
  for (;;) {
    try {
      const real = realpathSync(cursor);
      return missing.length === 0 ? real : join(real, ...missing.slice().reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') return { unresolved: error.code ?? 'EIO' };
      const parent = resolve(cursor, '..');
      if (parent === cursor) return { unresolved: 'ENOENT' };
      missing.push(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
}

function contained(root, target) {
  if (root.unresolved !== undefined) return { ok: false, reason: `the root could not be resolved (${root.unresolved})` };
  if (target.unresolved !== undefined) return { ok: false, reason: `the path could not be resolved (${target.unresolved})` };
  const rel = relative(root, target);
  if (rel === '') return { ok: true, reason: null };
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'it resolves outside the repository (a link can point out)' };
  }
  return { ok: true, reason: null };
}

/**
 * Whether `target` is the root or beneath it, after resolving every link.
 *
 * @param {string} root
 * @param {string} target
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function within(root, target) {
  const [a, b] = await Promise.all([canonical(root), canonical(target)]);
  return contained(a, b);
}

/** The same answer without awaiting, for a caller that is already synchronous. */
export function withinSync(root, target) {
  return contained(canonicalSync(root), canonicalSync(target));
}

/**
 * Throw unless `target` is inside `root`.
 *
 * The message names the operation and keeps the wording the journal's callers and tests
 * already know ("... outside the repository"), then adds why a lexical check is not the
 * same claim.
 *
 * @param {string} root
 * @param {string} target
 * @param {string} what e.g. 'write', 'copy', 'removal', 'link'
 */
export async function assertWithin(root, target, what) {
  const check = await within(root, target);
  if (check.ok) return;
  throw new Error(`journal refuses a ${what} outside the repository: ${target} (${check.reason})`);
}

/** The synchronous twin, for a caller whose own signature is synchronous. */
export function assertWithinSync(root, target, what) {
  const check = withinSync(root, target);
  if (check.ok) return;
  throw new Error(`journal refuses a ${what} outside the repository: ${target} (${check.reason})`);
}
