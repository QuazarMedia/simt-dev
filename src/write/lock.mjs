// One writer at a time, per repository.
//
// Two `simt init`s, or an `init` and a `sync`, can plan from the same before-images and
// then interleave their writes: each verified its own plan, and the second overwrites what
// the first just wrote. A lock cannot make planning atomic, but it makes the window
// between "these are the bytes I read" and "these are the bytes I wrote" hold one writer,
// which is what the before-image check needs to mean anything.
//
// The lock is a file under the local state directory, so it is visible to `git status`
// never and to `simt undo` never. A holder that died leaves it behind; a lock whose pid no
// longer exists, or that is older than the ceiling, is stale and is taken.

import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CLI } from '../name.mjs';
import { LOCAL_DIR } from '../state.mjs';

const LOCK_REL = join(LOCAL_DIR, 'write.lock');
const STALE_MS = 120_000;
const POLL_MS = 25;

/** The path of the lock a repository holds while a writer applies a plan. */
export function lockPath(root) {
  return join(root, LOCK_REL);
}

/** Raised when another live process holds the repository's write lock. */
export class WriteBusy extends Error {}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists and belongs to someone else.
    return error.code === 'EPERM';
  }
}

async function stale(path) {
  let holder;
  try {
    holder = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // Unreadable is abandoned: a holder that cannot finish writing its own record is not
    // going to release the lock.
    return true;
  }
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return true;
  if (holder.pid === process.pid) return false;
  if (!alive(holder.pid)) return true;
  const at = Date.parse(holder.at);
  return !Number.isFinite(at) || Date.now() - at > STALE_MS;
}

/**
 * Run `fn` while holding the repository's write lock, or refuse.
 *
 * @param {string} root
 * @param {() => Promise<any>} fn
 * @param {{waitMs?: number}} [options] how long to wait for a live holder before refusing
 * @returns {Promise<any>}
 */
export async function withWriteLock(root, fn, { waitMs = 10_000 } = {}) {
  const path = lockPath(root);
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  const candidate = `${path}.${process.pid}.${randomUUID()}`;
  await writeFile(candidate, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  try {
    for (;;) {
      try {
        // Publish ownership and its bytes together. Creating an empty lock before
        // writing its owner lets a concurrent writer reap the live lock as corrupt.
        await link(candidate, path);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await stale(path)) {
          await unlink(path).catch(() => {});
          continue;
        }
        if (Date.now() >= deadline) throw new WriteBusy(`another ${CLI} process is writing this repository; retry when it finishes`);
        await new Promise((settle) => setTimeout(settle, POLL_MS));
      }
    }
    try {
      return await fn();
    } finally {
      await unlink(path).catch(() => {});
    }
  } finally {
    await unlink(candidate).catch(() => {});
  }
}
