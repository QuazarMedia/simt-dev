// Locating a registry source: the body a node points at.
//
// The registry declares `sources: [{repo, path, bytes, role}]`. Resolving one used
// to mean exactly one thing - join the workspace root onto `repo` and `path`. That
// is the only definition that works in the SIMT checkout and the only definition
// that works nowhere else, which is how `skills install` ended up refusing in a
// perfectly ordinary single-repo clone.
//
// The second location is the one nobody wrote down: **the repository being operated
// on is itself a location for a declared source**. Someone who cloned only
// one repository has its body on disk at `.agents/skills/slice-commit`
// with no workspace anywhere. The registry entry is satisfied by that file.
//
// Bytes are what make this safe rather than hopeful. Every source declares its size,
// and `graph lint` already verifies every declared size against the file on disk. So
// a candidate location is accepted only when the measured size equals the declared
// size. That also settles variant selection without a guess: the repo holding 5048
// bytes of `slice-commit` is holding the `web` variant, whatever its stack tags say.
//
// Two rules keep this from becoming a way to install the wrong body:
//
//   1. A workspace location wins over a repo location. The canonical body beats the
//      incidental copy.
//   2. Content decides identity, never location. A repo-relative candidate whose
//      bytes do not match is not a degraded match, it is a different file, and it is
//      rejected rather than installed.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { measureSkill } from '../graph/load.mjs';

/**
 * Every place a declared source can legitimately be.
 *
 * @returns {{path: string, how: 'workspace'|'repo'}[]}
 */
export function candidateLocations(source, { workspaceRoot = null, root = null } = {}) {
  const out = [];
  if (workspaceRoot) out.push({ path: join(workspaceRoot, source.repo, source.path), how: 'workspace' });
  if (root) out.push({ path: join(root, source.path), how: 'repo' });
  return out;
}

/**
 * Find the file that satisfies a declared source.
 *
 * @returns {Promise<{path: string|null, how: string|null, bytes: number|null,
 *                    reason: string|null, candidates: {path:string, how:string, bytes:number}[]}>}
 */
export async function locateSource(source, options = {}) {
  const candidates = candidateLocations(source, options);
  const measured = [];

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    let size;
    try {
      size = (await measureSkill(candidate.path)).bytes;
    } catch {
      // A directory with no SKILL.md, or an unreadable path: not this source.
      continue;
    }
    measured.push({ ...candidate, bytes: size });
    // Declared bytes are the identity check. No declared bytes means the registry
    // has nothing to verify against, so a size match cannot be claimed.
    if (typeof source.bytes === 'number' && size === source.bytes) {
      return { path: candidate.path, how: candidate.how, bytes: size, reason: null, candidates: measured };
    }
  }

  return {
    path: null,
    how: null,
    bytes: null,
    reason: measured.length === 0 ? 'no candidate location exists' : 'no candidate has the declared size',
    candidates: measured,
  };
}

/**
 * Which declared source, if any, this repo already holds.
 *
 * This is a real signal rather than a fallback: a repo that carries 5048 bytes of
 * `slice-commit` is carrying the `web` variant, and its own contents are a better
 * answer than its stack tags. It is also what makes a single-repo clone work at all,
 * since such a clone's `package.json` usually says nothing that distinguishes the two
 * variants.
 *
 * @returns {Promise<{source: object, how: string, path: string, bytes: number}|null>}
 */
export async function sourceHeldLocally(skill, root, { workspaceRoot = null } = {}) {
  if (!root) return null;
  const held = [];
  for (const source of skill.sources ?? []) {
    // Only the repo-relative location is in play here; a workspace hit is the
    // workspace's business, not this repo's.
    const found = await locateSource(source, { root });
    if (found.path) held.push({ source, how: found.how, path: found.path, bytes: found.bytes });
  }
  // Two different declared sources both satisfied by this one repo means the
  // registry and the repo disagree; the caller refuses rather than picking.
  if (held.length !== 1) return held.length === 0 ? null : { ambiguous: true, held };
  return held[0];
}