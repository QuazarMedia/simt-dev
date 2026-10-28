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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { STATE_DIR } from './name.mjs';

/** Where the claims live, in every repository: beside the index and the ledger. */
export const LEASE_FILE = join(STATE_DIR, 'leases.json');

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
 * The repository-relative name of a path this tool may lease, or null when it is not
 * inside the repository at all.
 *
 * Relative to the root and slash-normalised, because that is the spelling the file
 * holds and the one a payload's absolute `file_path` has to become before the two can
 * be compared. The root itself leases nothing — there is no edit that "is" the
 * repository — so it answers null like a path that escapes it.
 */
export function leasePathFor(root, input) {
  const rel = relative(resolve(root), resolve(root, String(input ?? '')));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join('/');
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
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { path, leases: [], error: null };
    return { path, leases: [], error: `${LEASE_FILE} could not be read (${error.message})` };
  }
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
  await writeFile(path, body, 'utf8');
  return path;
}
