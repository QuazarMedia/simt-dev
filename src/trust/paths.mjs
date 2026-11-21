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
//
// One resolver and one check, synchronous on purpose. The calls are two `realpath` calls
// on paths a command already touched, so there is no I/O to overlap and no reason for an
// async twin: a second loop is a second answer waiting to drift, which is the defect this
// module exists to end.

import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The filesystem's answer for a path that may not exist yet. */
function canonical(path) {
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
  // `..cache` is a child whose name starts with two dots; only `..` and `../x` leave.
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: 'it resolves outside the repository (a link can point out)' };
  }
  return { ok: true, reason: null };
}

/**
 * Whether `target` is the root or beneath it, after resolving every link.
 *
 * @param {string} root
 * @param {string} target
 * @returns {{ok: boolean, reason: string|null}}
 */
export function within(root, target) {
  return contained(canonical(root), canonical(target));
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
export function assertWithin(root, target, what) {
  const check = within(root, target);
  if (check.ok) return;
  throw new Error(`journal refuses a ${what} outside the repository: ${target} (${check.reason})`);
}
