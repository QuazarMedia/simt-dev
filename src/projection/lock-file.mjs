// Which file is the lock, in one place.
//
// A lock may live under the current name or the name it had before ADR-110. Three
// readers used to answer that question separately: the frozen check, the plan's
// "is there a previous lock" comparison, and the variant fold. They could disagree
// about which file they had read, and the variant fold could return no winners from a
// lock the frozen check was treating as damaged.
//
// This module only locates and reads the bytes. Interpreting them belongs to the
// reader: `readLock` validates the document, `readLockedVariants` takes its `variants`
// map, and the plan compares the raw text.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LOCK_FILE, LOCK_LEGACY } from '../name.mjs';

/**
 * The bytes of the repository's lock, from the current name or the legacy one.
 *
 * The current name wins when both exist. A missing lock is `text: null`, not an
 * error; anything else that prevents reading it is thrown so a caller can decide
 * whether damage is a missing lock.
 *
 * @param {string} root
 * @returns {Promise<{text: string|null, name: string|null, path: string}>}
 */
export async function readLockText(root) {
  for (const name of [LOCK_FILE, LOCK_LEGACY]) {
    const path = join(root, name);
    try {
      return { text: await readFile(path, 'utf8'), name, path };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  return { text: null, name: null, path: join(root, LOCK_FILE) };
}
