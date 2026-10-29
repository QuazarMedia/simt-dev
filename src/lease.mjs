// File leases: one path, one session, for the length of a TTL (plan 0003 R54,
// ADR-101).
//
// The data is deliberately dumb: one JSON file beside the index, absolute expiry
// timestamps, no lock. Sessions claim paths with `simt lease <paths>` and the
// pre-edit hook reads the same file to refuse an edit from anyone who is not the
// holder. Two writers racing loses one write rather than corrupting the file, and a
// lost write is a claim the next run re-makes — anything stronger would be a
// coordination system built around a file that a TTL already cleans up.
//
// What is NOT tolerated is an unreadable file: `readLeases` reports that as an error
// rather than answering "no leases", because a claim file that stopped parsing is the
// one state in which silently forgetting every holder would hand a routing-around
// path to the session that broke it. Which way that fails is the caller's decision —
// the hook refuses edits, the command refuses to write (ADR-101 rulings 4).

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { localRel, readStateFile } from './state.mjs';

/** Where the claims live, in every repository: beside the index and the ledger. */
export const LEASE_FILE = localRel('leases.json');
export const LEASE_FILE_LEGACY = '.simt/leases.json';

/** The schema the file is written with; a reader that does not know it refuses. */
const LEASE_SCHEMA = 1;

/**
 * How long a claim lives when the caller does not say.
 *
 * An hour: longer than one focused task step, short enough that a session which
 * crashed mid-edit does not hold a path for the rest of the day.
 */
export const DEFAULT_TTL_SECONDS = 3600;

/**
 * The one spelling a path has for lease matching: repository-relative, symlinks
 * resolved, case-folded when the repository's git compares case-insensitively, or
 * null when the path is not inside the repository at all.
 *
 * A payload that reaches a file through a symlinked directory spells it one way,
 * the claim recorded for the file spells it the other, and on a case-insensitive
 * volume the two spellings that differ in case are the same file (review 0003
 * Q16). Both sides of a comparison go through this, so a claim and an edit meet
 * in the same spelling whatever road each one took to get there.
 *
 * The real path of the deepest existing ancestor is joined with the remainder,
 * because `realpath` on a file that does not exist yet — the normal state of a
 * write payload — would refuse. The root itself leases nothing — there is no
 * edit that "is" the repository — so it answers null like a path that escapes it.
 */
export function canonicalLeasePath(root, input, { ignoreCase = false } = {}) {
  const base = resolve(root, String(input ?? ''));
  let anchor = base;
  while (anchor !== resolve(anchor, '..')) {
    if (existsSync(anchor)) break;
    anchor = dirname(anchor);
  }
  let realAnchor;
  try {
    realAnchor = realpathSync(anchor);
  } catch {
    realAnchor = anchor;
  }
  const rest = relative(anchor, base);
  const abs = rest === '' ? realAnchor : join(realAnchor, rest);
  let realRoot;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    realRoot = resolve(root);
  }
  const rel = relative(realRoot, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  const slashed = rel.split(sep).join('/');
  return ignoreCase ? slashed.toLowerCase() : slashed;
}

/**
 * Read the claims.
 *
 * Missing is `{ leases: [] }` — a repository that never leased anything is the
 * default state, not a failure. Everything else (permissions, a half-written file, a
 * hand edit that no longer parses) comes back as `error` with no leases, and the
 * caller decides which way that fails.
 *
 * @returns {Promise<{path: string, leases: object[], error: string|null}>}
 */
export async function readLeases(root) {
  const path = join(root, LEASE_FILE);
  // The pre-move path is a fallback for one release (review 0003 Q19).
  let text;
  try {
    ({ text } = await readStateFile(root, LEASE_FILE, [LEASE_FILE_LEGACY]));
  } catch (error) {
    return { path, leases: [], error: `${LEASE_FILE} could not be read (${error.message})` };
  }
  if (text === null) return { path, leases: [], error: null };
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.leases)) {
      return { path, leases: [], error: `${LEASE_FILE} is not a lease document (no leases array)` };
    }
    // A malformed entry is dropped rather than trusted: an expiry that is not a number
    // would otherwise live forever, which is the opposite of what a TTL promises.
    const leases = parsed.leases.filter(
      (l) => l !== null && typeof l === 'object' && typeof l.path === 'string' &&
        typeof l.session === 'string' && Number.isFinite(l.expiresAt),
    );
    return { path, leases, error: null };
  } catch (error) {
    return { path, leases: [], error: `${LEASE_FILE} is not valid JSON (${error.message})` };
  }
}

/**
 * The claims still live at `now`, sorted by path so two reads of the same file
 * answer in the same order.
 *
 * Expiry is evaluated by the reader, never swept: the hook that decides an edit is
 * the moment a TTL has to be honoured, and a sweeper would be a second process whose
 * absence would otherwise change nothing.
 */
export function activeLeases({ leases } = { leases: [] }, now = Date.now()) {
  return leases.filter((l) => l.expiresAt > now).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Replace the claim file wholesale, sorted by path for deterministic bytes.
 *
 * Not journaled for `undo`: the file is local coordination state like the check
 * cache, and restoring yesterday's holders would undo claims other sessions are
 * relying on right now.
 */
export async function writeLeases(root, leases) {
  const path = join(root, LEASE_FILE);
  const sorted = [...leases].sort((a, b) => a.path.localeCompare(b.path));
  const body = `${JSON.stringify({ schemaVersion: LEASE_SCHEMA, leases: sorted }, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  // Atomic against a concurrent writer and a concurrent reader: a half-written
  // claim file fails closed for every edit (review 0003 Q20).
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
  return path;
}

/** A lock is stale when its holder died holding it, not when it is merely slow. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 10_000;

/**
 * Run `fn` with the claim file held: an `O_EXCL` lockfile (stale ones reaped),
 * the read-modify-write re-done inside, the lock released afterwards.
 *
 * Twelve concurrent claims stored seven before this: every claimant read the
 * same file, each wrote back only what it had seen. Re-reading under the lock
 * closes that race (review 0003 Q20).
 */
export async function withLeaseLock(root, fn) {
  const lockPath = join(root, `${LEASE_FILE}.lock`);
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = await open(lockPath, 'wx');
      await fd.close();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const st = await stat(lockPath);
        stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`could not take the lease lock; remove ${lockPath} if no lease run is active`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
