// The lock records the two digests a frozen check compares (ADR-086).
//
// Input is everything the projection reads that a repository can change, plus the
// digest of what this package ships. Output is the region body. An output that moves
// while the input does not is a renderer that is not a function of its inputs, and
// that is the failure `--frozen` exists to catch. An input that moves is a stale
// lock: the projection changed because the repository did, and the lock was not
// rewritten.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { fingerprint } from '../resolve/fingerprint.mjs';
import { desiredRegion, provenanceDigest, LOCAL_PROFILE_DIR } from './rules.mjs';
import { readManifest } from './manifest.mjs';

export const LOCK_FILE = 'simt-dev.lock.json';

/** Manifest keys that change what the region contains. Anything else in the file is
 *  the repository's own notes, and hashing it would make a comment fail the lock. */
const MANIFEST_KEYS = ['mode', 'budget', 'shared', 'surfaces', 'gates'];

/**
 * The lock this repository's projection should have.
 *
 * @param {string} root
 * @param {object} [flags] the same flags `sync` rendered with, so the output is the
 *   body that was written and not a body for a different set of surfaces
 */
export async function computeLock(root, flags = {}) {
  const desired = await desiredRegion(root, flags);
  return {
    inputs: await inputDigest(root),
    outputs: createHash('sha256').update(desired.body).digest('hex'),
  };
}

/** Read a lock, or null when the file is not there. A file that does not parse is an
 *  error the caller reports, not a missing lock: absence and damage are different
 *  repairs. */
export async function readLock(root) {
  let text;
  try {
    text = await readFile(join(root, LOCK_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { lock: null, error: null };
    throw error;
  }
  try {
    const lock = JSON.parse(text);
    if (typeof lock?.inputs !== 'string' || typeof lock?.outputs !== 'string') {
      return { lock: null, error: 'must be an object with inputs and outputs' };
    }
    return { lock, error: null };
  } catch (error) {
    return { lock: null, error: error.message };
  }
}

async function inputDigest(root) {
  const hash = createHash('sha256');
  hash.update(`provenance:${await provenanceDigest()}\n`);
  const { stack, facts } = await fingerprint(root);
  hash.update(`signals:${JSON.stringify({ stack, facts })}\n`);
  const { manifest } = await readManifest(root);
  const owned = {};
  if (manifest && typeof manifest === 'object') {
    for (const key of MANIFEST_KEYS) {
      if (manifest[key] !== undefined) owned[key] = manifest[key];
    }
  }
  hash.update(`manifest:${JSON.stringify(owned)}\n`);
  let names = [];
  try {
    names = (await readdir(join(root, LOCAL_PROFILE_DIR))).filter((n) => n.endsWith('.md')).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const name of names) {
    const bytes = await readFile(join(root, LOCAL_PROFILE_DIR, name));
    hash.update(`profile:${name}:${bytes.length}:`);
    hash.update(bytes);
  }
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8');
    const scripts = JSON.parse(raw).scripts ?? {};
    hash.update(`scripts:${JSON.stringify(scripts)}\n`);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return hash.digest('hex');
}
