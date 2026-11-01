// One change record, and the one function that applies it (review 0003 Q68).
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
import { isAbsolute, join } from 'node:path';

import { commitJournal, journaledRemoveFile, journaledWriteFile } from '../journal.mjs';

/**
 * One change to one path.
 *
 * `kind: 'remove'` is a deletion, and `after` is then null. `owner` and `reason` are for
 * the report a person reads: which writer owns the file and why it is changing.
 */
export function change({ path, kind = 'file', before, after, owner, reason }) {
  if (kind !== 'file' && kind !== 'remove') throw new Error(`unknown change kind: ${kind}`);
  return { path, kind, before, after, owner: owner ?? null, reason: reason ?? null, action: actionOf(kind, before, after) };
}

function actionOf(kind, before, after) {
  if (kind === 'remove') return before === null ? 'unchanged' : 'remove';
  if (before === after) return 'unchanged';
  if (before === null) return 'create';
  return 'update';
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
 */
export async function applyPlan(root, changes, { mode, label } = {}) {
  const todo = pending(changes);
  if (todo.length === 0) return { applied: false, written: [], pending: [], journal: [] };
  if (!mode?.apply) return { applied: false, written: [], pending: todo.map((c) => c.path), journal: [] };

  const journal = [];
  for (const c of todo) {
    const path = isAbsolute(c.path) ? c.path : join(root, c.path);
    if (c.kind === 'remove') await journaledRemoveFile(root, journal, path);
    else await journaledWriteFile(root, journal, path, c.after);
  }
  await commitJournal(root, label, journal);
  return { applied: true, written: todo.map((c) => c.path), pending: [], journal };
}
