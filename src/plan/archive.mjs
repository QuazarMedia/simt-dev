// Archiving a finished plan or review.
//
// A tracker that stays in the directory it was written in keeps answering `plan next` and
// keeps being counted as live work; the recursive read in `plan/index.mjs` exists so a
// finished document is still counted, which is a different thing from being unfinished.
// The move is a command rather than a hand `git mv` because the status line beside it is
// part of the same claim: "every row is done" written by hand drifts from the rows the
// moment one is reopened.
//
// Research documents are not archived. They are notes, they have no satisfying state and
// no rows to be finished, and a command that moved them would be a command that guessed
// what "done" means for a document nobody tracks.
import { mkdir, readFile, rename } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import { CLI } from '../name.mjs';
import { commitJournal, journaledRemoveFile, journaledWriteFile } from '../journal.mjs';
import { loadPlanState } from './index.mjs';

const PLAN_OR_REVIEW = /^#\s+(Plan|Review)\s+\d+/i;

function rel(root, path) {
  return relative(root, path).split(sep).join('/');
}

function isArchived(path) {
  return path.split(sep).includes('archive');
}

function exists(path) {
  return readFile(path, 'utf8').then(() => true, () => false);
}

function today(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Rows that are not yet at or past the state that satisfies a dependency.
 *
 * The same rule `plan status` measures itself by: done is a position in the state order,
 * so a tracker that renames its states still knows which rows are finished.
 */
function unfinishedRows(rows, format) {
  const from = format.order.findIndex((id) => format.satisfies.has(id));
  if (from < 0) return rows;
  return rows.filter((row) => format.order.indexOf(format.readState(row.stateRaw)) < from);
}

function countsOf(rows, format) {
  const counts = new Map();
  for (const row of rows) {
    const state = format.readState(row.stateRaw);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const display = new Map(format.order.map((id, index) => [id, format.stateNames[index] ?? id]));
  const parts = [];
  for (const id of format.order) {
    if (!counts.has(id)) continue;
    parts.push(`${counts.get(id)} ${display.get(id) ?? id}`);
  }
  for (const [id, count] of counts) {
    if (!display.has(id)) parts.push(`${count} ${id}`);
  }
  return { counts, text: parts.join(', ') };
}

/** The document's own first heading, which is what says whether it is a plan or research. */
function titleOf(text) {
  for (const line of text.split('\n')) {
    if (/^#\s+/.test(line)) return line.trim();
  }
  return '';
}

/**
 * Put the closure on the status line the document already has, or add one under its title.
 *
 * Replacing the whole line rather than editing inside it is deliberate: the fields that
 * used to follow a status (a baseline, a re-verification commit) describe the work as it
 * was while it was open, and carrying them into a closed line is how an archived document
 * ends up claiming it is still being re-verified.
 */
function withStatus(text, line) {
  const lines = text.split('\n');
  const existing = lines.findIndex((entry) => /^Status:/.test(entry));
  if (existing >= 0) {
    lines[existing] = line;
    return { text: lines.join('\n'), inserted: false };
  }
  const heading = lines.findIndex((entry) => /^#\s+/.test(entry));
  if (heading < 0) {
    lines.unshift(line, '');
  } else if (lines[heading + 1] === '') {
    lines.splice(heading + 2, 0, line);
  } else {
    lines.splice(heading + 1, 0, '', line);
  }
  return { text: lines.join('\n'), inserted: true };
}

/**
 * Archive one document by a row it tracks, or by its own file name.
 *
 * `dryRun` is the default: the status line and the destination are returned before
 * anything moves, because the move is the part a reader cannot easily undo by eye.
 *
 * @param {string} root
 * @param {string} id a row id, or the document's name
 * @param {{dryRun?: boolean, force?: boolean, at?: number}} [options]
 */
export async function planArchive(root, id, { dryRun = true, force = false, at = Date.now() } = {}) {
  if (!id) return { root, error: 'plan archive needs a slice id or a document name', remedy: `run: ${CLI} plan status` };
  const loaded = await loadPlanState(root);
  if (loaded.error) return { root, error: loaded.error, remedy: loaded.remedy };
  const { slices, docs, format } = loaded;

  const byRow = slices.filter((slice) => slice.id === id);
  const byName = docs.filter((doc) => doc.name === id || doc.name.startsWith(`${id}-`));
  const hits = byRow.length > 0 ? byRow : byName;
  if (hits.length === 0) {
    return { root, id, error: `no tracked document or slice named ${id}`, remedy: `run: ${CLI} plan status` };
  }
  const docPaths = new Set(hits.map((hit) => hit.doc?.path ?? hit.path));
  if (docPaths.size > 1) {
    return {
      root,
      id,
      error: `${id} names ${docPaths.size} documents: ${hits.map((hit) => hit.doc?.name ?? hit.name).join(', ')}`,
      remedy: `run: ${CLI} plan status`,
    };
  }
  const doc = hits[0].doc ?? hits[0];

  if (isArchived(doc.path)) {
    return {
      root,
      id,
      doc: doc.name,
      error: `${doc.name} is already in an archive directory`,
      remedy: 'nothing to do: an archived document is already closed',
    };
  }
  if (!PLAN_OR_REVIEW.test(titleOf(doc.text))) {
    return {
      root,
      id,
      doc: doc.name,
      error: `${doc.name} is neither a plan nor a review (title: ${titleOf(doc.text) || '(none)'})`,
      remedy: 'nothing to do: research documents are not tracked work and are not archived',
    };
  }

  const rows = slices.filter((slice) => slice.docPath === doc.path);
  const unfinished = unfinishedRows(rows, format);
  if (unfinished.length > 0 && !force) {
    return {
      root,
      id,
      doc: doc.name,
      error: `${doc.name} has ${unfinished.length} unfinished row(s): ${unfinished.slice(0, 6).map((row) => row.id).join(', ')}`,
      remedy: `finish them, or archive anyway with: ${CLI} plan archive ${id} --force --yes`,
      unfinished: unfinished.length,
    };
  }

  const { text: countsText } = countsOf(rows, format);
  const status = `Status: **closed** — ${rows.length} row(s): ${countsText || 'no rows'} · ${today(at)}`;
  const rewritten = withStatus(doc.text, status);

  const dir = dirname(doc.path);
  const target = join(dir, 'archive', basename(doc.path));
  if (await exists(target)) {
    return {
      root,
      id,
      doc: doc.name,
      error: `${rel(root, target)} already exists`,
      remedy: 'nothing to do: an archived copy of this document is already there',
    };
  }

  if (!dryRun) {
    const journal = [];
    await mkdir(dirname(target), { recursive: true });
    // The new path first, then the old one: a crash between the two leaves both copies,
    // which a reader can see and finish, where the other order leaves neither.
    await journaledWriteFile(root, journal, target, rewritten.text);
    await journaledRemoveFile(root, journal, doc.path);
    await commitJournal(root, 'plan', journal);
  }

  return {
    root,
    id,
    doc: doc.name,
    from: rel(root, doc.path),
    to: rel(root, target),
    rows: rows.length,
    counts: Object.fromEntries([...countsOf(rows, format).counts].map(([state, count]) => [state, count])),
    unfinished: unfinished.length,
    status,
    statusInserted: rewritten.inserted,
    dryRun,
    changed: !dryRun,
    remedy: dryRun ? `run: ${CLI} plan archive ${id} --yes` : null,
  };
}
