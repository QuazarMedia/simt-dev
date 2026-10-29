// Machine-local state lives here, not in the tree (review 0003 Q19).
//
// Everything this tool writes for itself — the ledger, the check cache, the
// index, leases, the journal, briefs, gate logs, bench runs — used to live
// directly under `.simt/`, so `simt check` changed the tree id its own
// evidence was measured against, and a slice worktree landed in the main
// checkout as an embedded gitlink. The fix is one directory: local state
// goes under `.simt/local/`, which is ignored and excluded from the tree,
// while committed content (`packs/`, `bin/`, `bench/tasks/`, profiles) stays
// where it was.
//
// Readers try the new path first and fall back to the old one for one
// release, so a repository whose state predates the move keeps working until
// the next write migrates it. Writers always write the new path.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { STATE_DIR } from './name.mjs';

/** The ignored directory every machine-local write goes under. */
export const LOCAL_DIR = join(STATE_DIR, 'local');

/** A machine-local path, relative to the repository root. */
export function localRel(...parts) {
  return join(LOCAL_DIR, ...parts);
}

/**
 * Where a machine-local file is read from: the new path first, then each
 * legacy path in order. Writers use only the first entry.
 */
function readCandidates(root, rel, legacy = []) {
  return [join(root, rel), ...legacy.map((l) => join(root, l))];
}

/** The first readable candidate, or null when none exists. */
export async function readStateFile(root, rel, legacy = []) {
  for (const path of readCandidates(root, rel, legacy)) {
    try {
      return { text: await readFile(path, 'utf8'), path };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { text: null, path: join(root, rel) };
}

/**
 * Every machine-local path the tree id must exclude: the whole local area
 * plus the legacy paths a pre-move checkout may still carry, so an old
 * `check.json` or worktree can neither change the id nor be committed.
 */
export const TREE_EXCLUDES = [
  LOCAL_DIR,
  join(STATE_DIR, 'ledger.jsonl'),
  join(STATE_DIR, 'lessons.jsonl'),
  join(STATE_DIR, 'leases.json'),
  join(STATE_DIR, 'check.json'),
  join(STATE_DIR, 'index.sqlite'),
  join(STATE_DIR, 'index.jsonl'),
  join(STATE_DIR, 'brief.md'),
  join(STATE_DIR, 'journal'),
  join(STATE_DIR, 'worktrees'),
  join(STATE_DIR, 'gate'),
  join(STATE_DIR, 'distilled'),
  join(STATE_DIR, 'reviews'),
  join(STATE_DIR, 'proposals'),
  join(STATE_DIR, 'compiled'),
  join(STATE_DIR, 'critic-labels.jsonl'),
  join(STATE_DIR, 'bench', 'runs'),
  join(STATE_DIR, 'bench', 'vault'),
  join(STATE_DIR, 'bench', 'prices.json'),
  join(STATE_DIR, 'bench', 'ablation.json'),
  join(STATE_DIR, 'bench', 'probes'),
];
