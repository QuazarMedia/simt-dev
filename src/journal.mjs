// The write journal and `undo` (plan 0003 R49, entry kinds review 0003 Q22).
//
// Every write a command performs is recorded as one entry in the run's set:
// `file` entries hold the pre-run bytes as base64 with the pre-run permission
// bits (binary-safe, unlike the version-1 utf8 spelling), and `git-config`
// entries hold one config key's before and after values, so `undo` restores
// the routing a run changed as well as the bytes. `commitJournal` folds each
// path and each key to a single entry — first before, last after — and `undo`
// restores entries in reverse, skipping the ones already at their pre-run
// state so a crashed undo resumes instead of refusing its own progress. The
// write-ahead marker records that intent; verification still precedes any
// restore on a fresh undo, so a refusal changes nothing.
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

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { STATE_DIR } from './name.mjs';
import { LOCAL_DIR } from './state.mjs';

const exec = promisify(execFile);

const JOURNAL_DIR = join(LOCAL_DIR, 'journal');
const JOURNAL_DIR_LEGACY = '.simt/journal';
const SET_SUFFIX = '.json';
const UNDONE_SUFFIX = '.undone.json';
/** A crashed `undo` leaves its intent behind under this suffix; the next undo
 * of the same set resumes it instead of starting over (review 0003 Q22). A
 * marker is history, not a set, so the set listing excludes it. */
const UNDOING_SUFFIX = '.undoing.json';
/** Sets that predate entry kinds store `beforeBytes` as utf8 text and carry no
 * `kind`; they are still restorable, through the legacy branch of the restore
 * below. `commitJournal` only writes version 2. */
const SET_VERSION = 2;

function digest(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
}

function rel(root, path) {
  return relative(root, path).split(sep).join('/');
}

/**
 * Read the current bytes and permission bits of a path, or null when it does
 * not exist. Any other failure propagates: an unreadable file is fail-closed,
 * not treated as absent.
 */
async function readOrNull(path) {
  try {
    const [bytes, st] = await Promise.all([readFile(path), stat(path)]);
    return { bytes, mode: st.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** A `file` entry: the pre-run bytes as base64 (binary-safe, unlike the
 * version-1 utf8 spelling) with the pre-run permission bits, so `undo`
 * restores both. Removals carry `afterDigest: null` and are re-created. */
function fileEntry(path, before, after) {
  return {
    kind: 'file',
    path,
    beforeDigest: before === null ? null : digest(before.bytes),
    afterDigest: after === null ? null : digest(after),
    beforeBytes: before === null ? null : before.bytes.toString('base64'),
    modeBefore: before === null ? null : before.mode,
  };
}

/**
 * Write a repo file and record the write in the run's set.
 *
 * @param {string} root the repository root; paths outside it are refused
 * @param {Array} acc the run's set, created by the caller and committed once
 * @param {string} path absolute path to write
 * @param {string} text the bytes to write
 * @param {{mode?: number}} [opts] permission bits to set after the write, recorded
 *   in the entry — a shim written then chmodded is one change, not two, and
 *   `undo` must restore the mode the run found, not just the bytes
 */
export async function journaledWriteFile(root, acc, path, text, { mode } = {}) {
  if (relative(root, path).startsWith('..')) {
    throw new Error(`journal refuses a write outside the repository: ${path}`);
  }
  const before = await readOrNull(path);
  // Internal state is written, not recorded — see the module header.
  const internal = rel(root, path) === STATE_DIR || rel(root, path).startsWith(`${STATE_DIR}/`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  if (mode !== undefined) await chmod(path, mode);
  if (!internal) {
    acc.push(fileEntry(rel(root, path), before, Buffer.from(text, 'utf8')));
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
    if (prev !== null && after !== null && prev.bytes.equals(after.bytes)) continue;
    acc.push(fileEntry(path, prev, after === null ? null : after.bytes));
  }
  // Files the copy removed (an overwrite that drops a name) are removals.
  for (const [path, prev] of before) {
    acc.push(fileEntry(path, prev, null));
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
    acc.push(fileEntry(rel(root, path), before, null));
  }
}

/** Read one git config value in a repo, or null when unset. */
export async function readGitValue(root, key) {
  try {
    const { stdout } = await exec('git', ['config', '--get', key], { cwd: root });
    return stdout.replace(/\n$/, '');
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
}

/**
 * Set (or, with `value: null`, unset) one git config key and record it as a
 * `git-config` entry, so `undo` restores the routing a run changed — a shim
 * without its `core.hooksPath` is a hook that no longer runs (review 0003
 * Q22). A set to the value already there records nothing: there is no state
 * to restore.
 *
 * @returns {Promise<object|null>} the entry, or null when nothing changed
 */
export async function journaledGitConfig(root, acc, key, value) {
  if (typeof key !== 'string' || key === '' || /[\s]/.test(key)) {
    throw new Error(`journal refuses an unparsable git config key: ${key}`);
  }
  const before = await readGitValue(root, key);
  if (before === value) return null;
  if (value === null) {
    await exec('git', ['config', '--unset', key], { cwd: root });
  } else {
    await exec('git', ['config', key, value], { cwd: root });
  }
  const entry = { kind: 'git-config', key, before, after: value };
  acc.push(entry);
  return entry;
}

/**
 * Add the journal directory to .gitignore, mirroring `ignoreIdentity`: match on
 * the exact line, never append a duplicate. Called by commitJournal so every
 * writer command is covered at once rather than each one remembering.
 * Exported so `doctor --fix` repairs a missing entry with the same bytes a
 * writer would have left (plan 0003 R47).
 */
/**
 * The .gitignore bytes `ignoreJournal` would write for `text`, or null when
 * `text` already ignores machine-local state. One owner for the line
 * spelling: `ignoreJournal` writes it, `journalHygiene` reads whether it is
 * there, and `doctor --fix --diff` previews it — all through this function so
 * the three cannot disagree about what counts as ignored (plan 0003 R50).
 *
 * The ignored line is the whole local area (review 0003 Q19), not just the
 * journal: every machine-local write lives under it, and one line covers them.
 */
export function journalIgnoreNext(text) {
  const line = `${LOCAL_DIR}/`;
  const legacy = `${JOURNAL_DIR_LEGACY}/`;
  const lines = text.split('\n').map((l) => l.trim());
  if (lines.includes(line) || lines.includes(legacy)) return null;
  const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
  return `${text}${prefix}\n# Write journal for \`simt undo\`. Local state, never shared.\n${line}\n`;
}

export async function ignoreJournal(root, journal = null) {
  const ignorePath = join(root, '.gitignore');
  let text;
  try {
    text = await readFile(ignorePath, 'utf8');
  } catch {
    text = '';
  }
  const next = journalIgnoreNext(text);
  if (next === null) return;
  // A caller-supplied journal records the edit so `undo` restores it (R47);
  // without one the write stays unrecorded, as `commitJournal` needs it.
  if (journal) await journaledWriteFile(root, journal, ignorePath, next);
  else await writeFile(ignorePath, next);
}

function setName(command, at) {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${command}-${process.pid}.json`;
}

/**
 * Fold one run's entries so each path (each config key) appears once: the
 * first before, the last after. Two writes to one path used to refuse `undo`
 * outright, although the run's net effect is a single restore. A create
 * followed by a removal in the same run is no change at all and folds away;
 * unequal ghosts — a removal folded with a write — fold to the write's after
 * with the removal's before.
 */
function coalesceEntries(acc) {
  const order = [];
  const folded = new Map();
  for (const entry of acc) {
    const slot = entry.kind === 'git-config' ? `\0${entry.key}` : entry.path;
    const prev = folded.get(slot);
    if (prev === undefined) {
      order.push(slot);
      folded.set(slot, entry);
      continue;
    }
    if (entry.kind === 'git-config') {
      folded.set(slot, { ...entry, before: prev.before });
    } else {
      folded.set(slot, { ...entry, beforeDigest: prev.beforeDigest, beforeBytes: prev.beforeBytes, modeBefore: prev.modeBefore });
    }
  }
  return order.map((slot) => folded.get(slot)).filter((entry) => {
    if (entry.kind === 'git-config') return entry.before !== entry.after;
    // Created then removed (or set back byte-for-byte, mode aside): nothing to restore.
    return entry.beforeDigest !== null || entry.afterDigest !== null;
  });
}

/**
 * Persist a run's set. Writes nothing when the run changed nothing, so the
 * last set on disk is always the last run that wrote.
 *
 * @returns {Promise<string|null>} the set id (file name), or null
 */
export async function commitJournal(root, command, acc, { at = Date.now() } = {}) {
  const entries = coalesceEntries(acc);
  if (entries.length === 0) return null;
  await ignoreJournal(root);
  const dir = join(root, JOURNAL_DIR);
  await mkdir(dir, { recursive: true });
  const id = setName(command, at);
  const body = `${JSON.stringify({ version: SET_VERSION, command, at, entries }, null, 2)}\n`;
  const tmp = join(dir, `${id}.tmp-${process.pid}`);
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, join(dir, id));
  return id;
}

/**
 * The `journal-unignored` finding's facts (plan 0003 R47): the sets on disk and
 * whether .gitignore names the directory. One owner for the line spelling —
 * `ignoreJournal` writes it, this reads it — so the two cannot disagree about
 * what counts as ignored.
 */
export async function journalHygiene(root) {
  const sets = await listJournalSets(root);
  if (sets.length === 0) return { sets, ignored: true };
  let text;
  try {
    text = await readFile(join(root, '.gitignore'), 'utf8');
  } catch {
    text = '';
  }
  const lines = text.split('\n').map((l) => l.trim());
  return { sets, ignored: lines.includes(`${LOCAL_DIR}/`) || lines.includes(`${JOURNAL_DIR_LEGACY}/`) };
}

/** Set ids newest-first, undone sets excluded. */
export async function listJournalSets(root) {
  // The pre-move directory is a fallback for one release (review 0003 Q19).
  let names;
  try {
    names = await readdir(join(root, JOURNAL_DIR));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      names = await readdir(join(root, JOURNAL_DIR_LEGACY));
    } catch (legacyError) {
      if (legacyError.code === 'ENOENT') return [];
      throw legacyError;
    }
  }
  // An undone set ends in `.undone.json`, which itself ends in `.json` — the
  // suffix test alone would list history as current and `undo` would restore
  // the same set twice. Exclude the undone (and the crash markers, which are
  // intent, not sets) first.
  return names
    .filter((n) => n.endsWith(SET_SUFFIX) && !n.endsWith(UNDONE_SUFFIX) && !n.endsWith(UNDOING_SUFFIX))
    .sort()
    .reverse();
}

/** The directory holding set `id`, preferring the post-move one. */
async function journalDirFor(root, id) {
  try {
    await stat(join(root, JOURNAL_DIR, id));
    return JOURNAL_DIR;
  } catch {
    return JOURNAL_DIR_LEGACY;
  }
}

export async function readJournalSet(root, id) {
  const dir = await journalDirFor(root, id);
  const raw = await readFile(join(root, dir, id), 'utf8');
  const set = JSON.parse(raw);
  if (set.version !== SET_VERSION) {
    // Version 1 stored `beforeBytes` as utf8 text and knew no kinds: read it
    // through the legacy branch of the restore rather than refusing history.
    return { ...set, entries: set.entries.map((e) => ({ ...e, kind: e.kind ?? 'file-legacy' })) };
  }
  return set;
}

/** The pre-run bytes of an entry as a string, for previews and diffs. */
export function beforeText(entry) {
  if (entry.kind === 'git-config' || entry.beforeBytes === null || entry.beforeBytes === undefined) return entry.before ?? null;
  if (entry.kind === 'file-legacy') return entry.beforeBytes;
  return Buffer.from(entry.beforeBytes, 'base64').toString('utf8');
}

/** The display name of an entry: a path for files, the key for config. */
export function entryLabel(entry) {
  return entry.kind === 'git-config' ? `git config ${entry.key}` : entry.path;
}

/** The digest of a file's current bytes, or null when absent. */
function currentDigest(state) {
  return state === null ? null : digest(state.bytes);
}

/**
 * Whether an entry is already at its pre-run state — restored by an earlier
 * attempt, or hand-set back to exactly what the run found. Restoring it again
 * would be a no-op write, so a resumed undo skips it instead of refusing it.
 */
async function alreadyRestored(root, entry) {
  if (entry.kind === 'git-config') {
    return (await readGitValue(root, entry.key)) === entry.before;
  }
  const state = await readOrNull(join(root, entry.path));
  return currentDigest(state) === entry.beforeDigest;
}

/** Whether an entry is still at the state the run left: the precondition for
 * restoring it. Anything else is somebody's edit, and the undo is refused. */
async function untouchedSince(root, entry) {
  if (entry.kind === 'git-config') {
    return (await readGitValue(root, entry.key)) === entry.after;
  }
  const state = await readOrNull(join(root, entry.path));
  return currentDigest(state) === entry.afterDigest;
}

function entryBytes(entry) {
  if (entry.beforeBytes === null) return null;
  if (entry.kind === 'file-legacy') return Buffer.from(entry.beforeBytes, 'utf8');
  return Buffer.from(entry.beforeBytes, 'base64');
}

/** Restore one entry: bytes and permission bits for files, the value for config. */
async function restoreEntry(root, entry) {
  if (entry.kind === 'git-config') {
    await exec('git', entry.before === null ? ['config', '--unset', entry.key] : ['config', entry.key, entry.before], {
      cwd: root,
    });
    return;
  }
  const abs = join(root, entry.path);
  if (entry.afterDigest === null) {
    // The run removed this path: re-create it with its pre-run bytes.
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, entryBytes(entry));
  } else if (entry.beforeDigest === null) {
    // The run created this path: remove it.
    await unlink(abs);
  } else {
    await writeFile(abs, entryBytes(entry));
  }
  if (entry.modeBefore !== null && entry.modeBefore !== undefined) {
    await chmod(abs, entry.modeBefore);
  }
}

/**
 * Restore one set: verify every entry is untouched since, then restore all in
 * reverse — later writes in the run unwind first, so overlapping restores land
 * in pre-run order.
 *
 * The intent lands on disk before the first restore (the write-ahead marker),
 * so a crash mid-undo is resumable: entries already at their pre-run state
 * are skipped, the rest are verified against the run's after-state and
 * restored, and anything at neither refuses the whole undo. Verification
 * still precedes any restore when there is no marker, so a refusal on a fresh
 * undo changes nothing.
 *
 * @returns {Promise<{restored: string[], resumed: boolean}|{refused: {path: string, detail: string}}>}
 */
async function undoJournalSet(root, id) {
  const set = await readJournalSet(root, id);
  const dir = await journalDirFor(root, id);
  const marker = join(root, dir, `${id}${UNDOING_SUFFIX}`);
  const resumed = (await readOrNull(marker)) !== null;
  for (const entry of set.entries) {
    if (await alreadyRestored(root, entry)) continue;
    if (!(await untouchedSince(root, entry))) {
      const label = entryLabel(entry);
      return {
        refused: {
          path: label,
          detail:
            entry.kind === 'git-config'
              ? `git config ${entry.key} changed after the journaled write`
              : (await readOrNull(join(root, entry.path))) === null
                ? 'the file was deleted after the journaled write'
                : 'the file changed after the journaled write',
        },
      };
    }
  }
  // The marker is the intent, written before anything is restored: a crash
  // from here on resumes instead of refusing the files already done.
  const tmp = `${marker}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, set: id, at: Date.now() }, null, 2)}\n`, 'utf8');
  await rename(tmp, marker);
  const restored = [];
  for (const entry of [...set.entries].reverse()) {
    if (await alreadyRestored(root, entry)) continue;
    await restoreEntry(root, entry);
    restored.push(entryLabel(entry));
  }
  await unlink(marker);
  await rename(join(root, dir, id), join(root, dir, id.replace(/\.json$/, UNDONE_SUFFIX)));
  return { restored, resumed };
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
