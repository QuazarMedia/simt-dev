// The Board's data: plan rows plus the worktree and lease readers the CLI already uses.
//
// The plan reader owns tracker parsing, the lease reader owns claims, and the local
// worktree directory owns presence. This module joins their answers; it does not parse a
// tracker or a lease file a second time, so the board cannot drift from `plan` or `lease`.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { activeLeases, readLeases } from '../lease.mjs';
import { planBoardSlices, planNext, planStatus } from '../plan/index.mjs';
import { LOCAL_DIR } from '../state.mjs';

async function listWorktrees(root) {
  try {
    const entries = await readdir(join(root, LOCAL_DIR, 'worktrees'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ id: entry.name, path: `${LOCAL_DIR}/worktrees/${entry.name}` }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

async function readBriefs(root, slices) {
  const briefs = {};
  await Promise.all(
    slices.map(async (slice) => {
      try {
        briefs[slice.id] = await readFile(
          join(root, LOCAL_DIR, 'briefs', `${slice.id.toLowerCase()}.md`),
          'utf8',
        );
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }),
  );
  return briefs;
}

/**
 * The board's one payload.
 *
 * `plan` and `next` are the doors' own answers, not re-rendered copies. The remaining
 * fields are the readers the CLI calls for worktrees, claims and briefs. A lease-reader
 * failure is reported beside an empty chip list rather than hidden; the plan/next failure
 * is the payload's refusal.
 */
export async function boardPayload(root) {
  const [plan, next, sliceRows, leaseRead] = await Promise.all([
    planStatus(root),
    planNext(root),
    planBoardSlices(root),
    readLeases(root),
  ]);
  if (plan.error) return { ok: false, error: plan.error, remedy: plan.remedy };
  const slices = Array.isArray(sliceRows) ? sliceRows : [];
  const briefs = await readBriefs(root, slices);
  return {
    ok: true,
    command: 'board',
    root,
    // These are the doors' documents in their CLI envelopes, so a reader can compare
    // `payload.plan` with `plan status --json` without translating a second shape.
    plan: { schemaVersion: 1, ok: true, command: 'plan status', exitCode: 0, ...plan },
    next: { schemaVersion: 1, ok: true, command: 'plan next', exitCode: 0, ...next },
    slices,
    slicesError: Array.isArray(sliceRows) ? null : sliceRows.error,
    leases: activeLeases(leaseRead),
    leasesError: leaseRead.error,
    worktrees: await listWorktrees(root),
    briefs,
  };
}
