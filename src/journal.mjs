// The write journal and `undo` (plan 0003 R49).
//
// Every repo-file write a command performs records {path, beforeDigest,
// afterDigest, beforeBytes}, grouped per command run as one set in
// `.simt/journal/`. `undo` restores the last set, but only when every file in
// it is untouched since — a file whose current bytes no longer match its
// afterDigest refuses the whole undo, naming the file, and nothing is restored.
//
// Three deliberate boundaries, each a failure this module refuses to be:
//
//   - The plan row says `.simt-dev/journal/`, which predates the STATE_DIR
//     rename (the same stale spelling survives in bench/probes.mjs comments).
//     The journal lives under STATE_DIR like every other per-repo state.
//   - Nothing under `.simt/` is journaled. The journal recording itself is
//     recursion; the ledger, index and candidates are evidence and caches, and
//     restoring those to an earlier byte-shape would corrupt R17 rather than
//     repair anything. `journaledWriteFile` performs those writes unrecorded.
//   - Only regular files. Symlinks carry no bytes for beforeBytes to hold, and
//     the record shape is file bytes — pointer changes are reported by the
//     command as before and are not undone. Removals are journaled as entries
//     with afterDigest null (the run deleted the path; undo re-creates it).
//     Writes outside the repository (`shared install` into $HOME, `plugin`
//     into --out) are never journaled: undo must not reach past the repo root.
//     Commands that span the boundary (`shared install` edits the repo manifest
//     as part of a $HOME write) and multi-root runs (`bench`, `compare` write
//     into several repos at once) are excluded as a unit — a set belongs to one
//     repo, and restoring half a command would lie about the other half.
//
// A set file is written atomically (tmp + rename) and only when non-empty, so
// the last set on disk is always the last run that changed something. An undone
// set is renamed to `.undone.json` rather than deleted: the history survives,
// a second `undo` naturally targets the set before it, and the untouched-check
// refuses when the two sets overlap on a file the first undo already restored.

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import { STATE_DIR } from './name.mjs';

const JOURNAL_DIR = join(STATE_DIR, 'journal');
const SET_SUFFIX = '.json';
const UNDONE_SUFFIX = '.undone.json';

function digest(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
}

function rel(root, path) {
  return relative(root, path).split(sep).join('/');
}

/**
 * Read the current bytes of a path, or null when it does not exist. Any other
 * failure propagates: an unreadable file is fail-closed, not treated as absent.
 */
async function readOrNull(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Write a repo file and record the write in the run's set.
 *
 * @param {string} root the repository root; paths outside it are refused
 * @param {Array} acc the run's set, created by the caller and committed once
 * @param {string} path absolute path to write
 * @param {string} text the bytes to write
 */
export async function journaledWriteFile(root, acc, path, text) {
  if (relative(root, path).startsWith('..')) {
    throw new Error(`journal refuses a write outside the repository: ${path}`);
  }
  const before = await readOrNull(path);
  // Internal state is written, not recorded — see the module header.
  const internal = rel(root, path) === STATE_DIR || rel(root, path).startsWith(`${STATE_DIR}/`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  if (!internal) {
    acc.push({
      path: rel(root, path),
      beforeDigest: before === null ? null : digest(before),
      afterDigest: digest(Buffer.from(text, 'utf8')),
      beforeBytes: before === null ? null : before.toString('utf8'),
    });
  }
}

/** List every regular file under a directory, absolute paths. Missing dir → []. */
async function treeFiles(dir) {
  let st;
  try {
    st = await stat(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!st.isDirectory()) return [dir];
  const out = [];
  for (const name of await readdir(dir)) {
    out.push(...(await treeFiles(join(dir, name))));
  }
  return out;
}

/**
 * Copy a skill source tree into the repo and record every file landed, so
 * `undo` removes what the copy created and restores what it overwrote. The
 * before-snapshot is taken first: a `cp` that overwrites in place would
 * otherwise destroy the bytes the entry needs.
 */
export async function journaledCopyDir(root, acc, src, dest) {
  if (relative(root, dest).startsWith('..')) {
    throw new Error(`journal refuses a copy outside the repository: ${dest}`);
  }
  const before = new Map();
  for (const abs of await treeFiles(dest)) {
    before.set(rel(root, abs), await readOrNull(abs));
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  for (const abs of await treeFiles(dest)) {
    const path = rel(root, abs);
    const prev = before.get(path) ?? null;
    before.delete(path);
    const after = await readOrNull(abs);
    if (prev !== null && after !== null && prev.equals(after)) continue;
    acc.push({
      path,
      beforeDigest: prev === null ? null : digest(prev),
      afterDigest: digest(after),
      beforeBytes: prev === null ? null : prev.toString('utf8'),
    });
  }
  // Files the copy removed (an overwrite that drops a name) are removals.
  for (const [path, prev] of before) {
    acc.push({
      path,
      beforeDigest: digest(prev),
      afterDigest: null,
      beforeBytes: prev.toString('utf8'),
    });
  }
}

/**
 * Remove a repo file and record the removal: undo re-creates the path with its
 * pre-run bytes, provided nothing has appeared there since. Removing what is
 * already absent records nothing — there is no state to restore.
 */
export async function journaledRemoveFile(root, acc, path) {
  if (relative(root, path).startsWith('..')) {
    throw new Error(`journal refuses a removal outside the repository: ${path}`);
  }
  const before = await readOrNull(path);
  if (before === null) return;
  const internal = rel(root, path) === STATE_DIR || rel(root, path).startsWith(`${STATE_DIR}/`);
  await unlink(path);
  if (!internal) {
    acc.push({
      path: rel(root, path),
      beforeDigest: digest(before),
      afterDigest: null,
      beforeBytes: before.toString('utf8'),
    });
  }
}

/**
 * Add the journal directory to .gitignore, mirroring `ignoreIdentity`: match on
 * the exact line, never append a duplicate. Called by commitJournal so every
 * writer command is covered at once rather than each one remembering.
 */
async function ignoreJournal(root) {
  const ignorePath = join(root, '.gitignore');
  let text;
  try {
    text = await readFile(ignorePath, 'utf8');
  } catch {
    text = '';
  }
  const line = `${JOURNAL_DIR}/`;
  if (text.split('\n').map((l) => l.trim()).includes(line)) return;
  const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
  await writeFile(ignorePath, `${text}${prefix}\n# Write journal for \`simt undo\`. Local state, never shared.\n${line}\n`);
}

function setName(command, at) {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${command}-${process.pid}.json`;
}

/**
 * Persist a run's set. Writes nothing when the run changed nothing, so the
 * last set on disk is always the last run that wrote.
 *
 * @returns {Promise<string|null>} the set id (file name), or null
 */
export async function commitJournal(root, command, acc, { at = Date.now() } = {}) {
  if (acc.length === 0) return null;
  await ignoreJournal(root);
  const dir = join(root, JOURNAL_DIR);
  await mkdir(dir, { recursive: true });
  const id = setName(command, at);
  const body = `${JSON.stringify({ version: 1, command, at, entries: acc }, null, 2)}\n`;
  const tmp = join(dir, `${id}.tmp-${process.pid}`);
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, join(dir, id));
  return id;
}

/** Set ids newest-first, undone sets excluded. */
export async function listJournalSets(root) {
  let names;
  try {
    names = await readdir(join(root, JOURNAL_DIR));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  // An undone set ends in `.undone.json`, which itself ends in `.json` — the
  // suffix test alone would list history as current and `undo` would restore
  // the same set twice. Exclude the undone first.
  return names.filter((n) => n.endsWith(SET_SUFFIX) && !n.endsWith(UNDONE_SUFFIX)).sort().reverse();
}

export async function readJournalSet(root, id) {
  const raw = await readFile(join(root, JOURNAL_DIR, id), 'utf8');
  return JSON.parse(raw);
}

/**
 * Restore one set: verify every file is untouched since, then restore all.
 * Verification precedes any restore, so a refusal changes nothing.
 *
 * @returns {Promise<{restored: string[]}|{refused: {path: string, detail: string}}>}
 */
async function undoJournalSet(root, id) {
  const set = await readJournalSet(root, id);
  for (const entry of set.entries) {
    const abs = join(root, entry.path);
    const bytes = await readOrNull(abs);
    const now = bytes === null ? null : digest(bytes);
    if (now !== entry.afterDigest) {
      return {
        refused: {
          path: entry.path,
          detail:
            bytes === null
              ? 'the file was deleted after the journaled write'
              : 'the file changed after the journaled write',
        },
      };
    }
  }
  const restored = [];
  for (const entry of set.entries) {
    const abs = join(root, entry.path);
    if (entry.afterDigest === null) {
      // The run removed this path: re-create it with its pre-run bytes.
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, entry.beforeBytes, 'utf8');
    } else if (entry.beforeBytes === null) {
      // The run created this path: remove it.
      await unlink(abs);
    } else {
      await writeFile(abs, entry.beforeBytes, 'utf8');
    }
    restored.push(entry.path);
  }
  await rename(join(root, JOURNAL_DIR, id), join(root, JOURNAL_DIR, id.replace(/\.json$/, UNDONE_SUFFIX)));
  return { restored };
}

/**
 * Restore the most recent set that has not been undone.
 *
 * @returns {Promise<{empty: true}|{set: string, restored: string[]}|{set: string, refused: {path: string, detail: string}}>}
 */
export async function undoLastJournalSet(root) {
  const [id] = await listJournalSets(root);
  if (!id) return { empty: true };
  const result = await undoJournalSet(root, id);
  return { set: id, ...result };
}
