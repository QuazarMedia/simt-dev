// What the stored index is, and whether it still describes the tree (ADR-201).
//
// Freshness is a state, not a boolean. The three answers this module can give a
// caller are not interchangeable: `cold` is "no build has vouched for a tree",
// `stale` is "the build saw a different tree", and `unknown` is "this process
// cannot compare them". The boolean `isIndexStale` is kept for the callers whose
// only decision is whether to rebuild; a caller that reports to a person reads
// the state, because reporting an uncomparable cache as current is the defect
// this split exists for.
//
// The module is separate from `store.mjs` because the walk and its provenance
// together crossed the file ceiling (ADR-005); it imports the tree listing and
// the format, and the store does not import it back.

import { readBuildMeta, treeDigest } from './persist.mjs';
import { SCHEMA_V } from './persist.mjs';
import { ensureIndexSupport, lsFiles } from './store.mjs';

/**
 * Whether the stored index still describes the current tracked tree.
 *
 * One `git ls-files -s` and one meta read: no blob is re-read, so the check
 * costs ~100 ms and every read path can afford it.
 *
 * @returns {Promise<{state: 'cold'|'current'|'stale'|'unknown'|'busy', stored?: string, current?: string, reason?: string, code?: string}>}
 */
export async function indexFreshness(root) {
  await ensureIndexSupport();
  const { meta, error } = await readBuildMeta(root);
  if (error) {
    const busy = error.code === 'INDEX_BUSY';
    return {
      state: busy ? 'busy' : 'unknown',
      code: error.code ?? 'INDEX_READ',
      reason: error.message ?? String(error),
    };
  }
  const stored = meta.tree ?? '';
  if (stored === '') return { state: 'cold' };
  let listed;
  try {
    listed = await lsFiles(root);
  } catch (error) {
    return { state: 'unknown', code: 'GIT_UNREADABLE', reason: `git could not list the index: ${error.message}` };
  }
  const current = treeDigest(listed);
  if (current === stored) return { state: 'current', stored, current };
  return { state: 'stale', stored, current };
}

/** True only when the index is known to be stale; use `indexFreshness` when unknown matters. */
export async function isIndexStale(root) {
  return (await indexFreshness(root)).state === 'stale';
}

/**
 * The provenance a retrieval result is answered from.
 *
 * `index` names the build, tree, inputs and resolution stamps; `overlay` says
 * whether working-tree rows were merged into this answer (the handle never
 * merges one, so it is the overlay's own caller that can say yes); `rows` names
 * the git index as the basis - staged blobs, which equal committed content only
 * when the worktree is clean.
 */
export async function readBasis(root) {
  const basis = {
    index: {
      schema: SCHEMA_V,
      available: false,
      build: '',
      tree: '',
      inputs: '',
      resolution: '',
    },
    overlay: { applied: false },
    rows: { source: 'git-index', label: 'staged' },
  };
  let read;
  try {
    read = await readBuildMeta(root);
  } catch (error) {
    return { ...basis, index: { ...basis.index, error: error?.code ?? 'INDEX_READ' } };
  }
  if (read.error) return { ...basis, index: { ...basis.index, error: read.error.code ?? 'INDEX_READ' } };
  return {
    ...basis,
    index: {
      ...basis.index,
      available: Boolean(read.meta.build),
      build: read.meta.build ?? '',
      tree: read.meta.tree ?? '',
      inputs: read.meta.inputs ?? '',
      resolution: read.meta.resolution ?? '',
    },
  };
}
