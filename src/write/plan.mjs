// One change record, and the one function that applies it.
//
// Fourteen writers hand-roll the same five steps: read the before bytes, decide create or
// update, write through the journal, commit the set, print the diff. They do not all do
// them in the same order, and the differences are defects rather than decisions - a
// writer that skipped the journal (the tracker, the lock, `skills compile`) could not be
// undone, and one that read the before bytes after writing produced a diff against
// itself.
//
// A change is data: what the path will hold, what it holds now, who owns it and why it
// changes. `applyPlan` is the only place that knows about journals, directories and
// `--yes`, so a writer states the change and nothing else.
//
// The record carries no `action` from the caller. Create, update, remove and unchanged
// are derived from `before` and `after`, because a writer that passes an action it
// computed by hand is the bug this replaces.
import { readFile, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { commitJournal, journaledRemoveFile, journaledWriteFile } from '../journal.mjs';
import { LOCAL_DIR } from '../state.mjs';
import { withWriteLock } from './lock.mjs';

/**
 * One change to one path.
 *
 * `kind: 'remove'` is a deletion, and `after` is then null. `owner` and `reason` are for
 * the report a person reads: which writer owns the file and why it is changing. `mode` is
 * permission bits for a file that must be executable, and rides on the same entry so
 * `undo` restores the mode it found.
 */
export function change({ path, kind = 'file', before, after, owner, reason, mode }) {
  if (kind !== 'file' && kind !== 'remove') throw new Error(`unknown change kind: ${kind}`);
  return {
    path,
    kind,
    before,
    after,
    owner: owner ?? null,
    reason: reason ?? null,
    mode,
    action: actionOf(kind, before, after),
  };
}

function actionOf(kind, before, after) {
  if (kind === 'remove') return before === null ? 'unchanged' : 'remove';
  if (before === after) return 'unchanged';
  if (before === null) return 'create';
  return 'update';
}

/**
 * A plan whose paths no longer hold the bytes it was built from.
 *
 * Thrown rather than returned: every writer treats a plan it cannot apply as a failed
 * command, and a result object each caller may or may not inspect is how a refusal turns
 * into a silent success.
 */
export class PlanConflict extends Error {
  constructor(conflicts) {
    const first = conflicts[0];
    const more = conflicts.length === 1 ? '' : ` (and ${conflicts.length - 1} more)`;
    super(
      `refusing to write: ${first.path} ${first.reason}${more}; re-run the command so it plans from the current bytes`,
    );
    this.name = 'PlanConflict';
    this.conflicts = conflicts;
  }
}

/** The changes that would do something, in the order the caller listed them. */
export function pending(changes) {
  return (changes ?? []).filter((c) => c.action !== 'unchanged');
}

/**
 * Apply the plan, or report it.
 *
 * Without `mode.apply` nothing touches the disk and the pending paths come back as
 * `pending`: a rehearsal and a real run answer the same question with the same plan, and
 * the only difference is whether the bytes moved. With it, every change is journaled into
 * one set under `label`, so `undo` restores the run rather than one file of it.
 *
 * A writer whose run is more than one plan - `init` writes a manifest, an identity and a
 * set of targets and commits once - passes its own `journal` and `commit: false`. The
 * entries land in the caller's set, so the run stays one undoable step rather than one
 * step per plan.
 */
export async function applyPlan(root, changes, { mode, label, journal: shared, commit = true } = {}) {
  const todo = pending(changes);
  if (todo.length === 0) return { applied: false, written: [], pending: [], journal: [], conflicts: [] };
  if (!mode?.apply) return { applied: false, written: [], pending: todo.map((c) => c.path), journal: [], conflicts: [] };

  const work = async () => {
    // The plan's `before` is a claim about the disk, and the disk can move between the read
    // that built it and this write. Verifying it ONCE, before the first effect, means a
    // stale plan refuses as a whole: writing the changes whose paths still matched and
    // reporting the rest is a half-applied plan nobody asked for.
    const conflicts = await verifyBefore(root, todo);
    if (conflicts.length > 0) throw new PlanConflict(conflicts);
    return await applyVerified(root, todo, { label, shared, commit });
  };
  // A nested plan shares its caller's run, so the caller's lock already covers it; taking
  // it again would be this process blocking on itself.
  if (shared !== undefined) return await work();
  return await withWriteLock(root, work);
}

/** The state of one plan path, as the before-image check needs to see it. */
async function inspect(path) {
  const info = await stat(path).catch((error) => {
    // ENOTDIR: an ancestor is a file, so the path itself does not exist. Treating it as
    // unreadable would refuse the plan at verification instead of at the write that
    // cannot make the directory.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (info === null) return { kind: 'absent', text: null };
  if (!info.isFile()) return { kind: 'not-a-file', text: null };
  return { kind: 'file', text: await readFile(path, 'utf8') };
}

/**
 * Every pending change the disk no longer agrees with, or none.
 *
 * A missing file where the plan expected bytes is a conflict, not a create: the plan was
 * built to UPDATE something, and recreating it would resurrect a file the user deleted.
 */
async function verifyBefore(root, todo) {
  const conflicts = [];
  for (const c of todo) {
    const path = isAbsolute(c.path) ? c.path : join(root, c.path);
    const current = await inspect(path);
    if (c.before === null) {
      if (current.kind !== 'absent') conflicts.push({ path: c.path, reason: 'appeared after the plan was made' });
      continue;
    }
    if (current.kind === 'absent') {
      conflicts.push({ path: c.path, reason: 'was removed after the plan was made' });
      continue;
    }
    if (current.kind !== 'file') {
      conflicts.push({ path: c.path, reason: 'is not a regular file any more' });
      continue;
    }
    if (current.text !== c.before) conflicts.push({ path: c.path, reason: 'changed after the plan was made' });
  }
  return conflicts;
}

/**
 * The intent a crash would otherwise lose: what this run is about to change, written
 * before the first effect. The journal set commits after the writes, so the window between
 * the first write and that commit is the one where a crash leaves applied effects and no
 * record. The marker is removed once the set is committed; a marker on disk therefore
 * names a run that did not finish.
 */
async function writeIntent(root, label, todo) {
  const dir = join(root, LOCAL_DIR, 'journal');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}-${String(label ?? 'write').replace(/[^\w.-]+/g, '-')}-${process.pid}.pending`;
  const path = join(dir, name);
  const body = { command: label ?? null, pid: process.pid, at: new Date().toISOString(), paths: todo.map((c) => c.path) };
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return path;
}

async function applyVerified(root, todo, { label, shared, commit }) {
  const journal = shared ?? [];
  const first = journal.length;
  const intent = commit ? await writeIntent(root, label, todo) : null;
  try {
    for (const c of todo) {
      const path = isAbsolute(c.path) ? c.path : join(root, c.path);
      if (c.kind === 'remove') await journaledRemoveFile(root, journal, path);
      else await journaledWriteFile(root, journal, path, c.after, c.mode === undefined ? {} : { mode: c.mode });
    }
  } catch (error) {
    // What landed is still undoable: the entries recorded before the failure are folded
    // into a set rather than left in a marker that only says what was intended.
    if (commit && journal.length > first) await commitJournal(root, label, journal.slice(first)).catch(() => {});
    throw error;
  } finally {
    if (intent !== null) await unlink(intent).catch(() => {});
  }
  if (commit && journal.length > first) await commitJournal(root, label, journal);
  return { applied: true, written: todo.map((c) => c.path), pending: [], journal, conflicts: [] };
}
