// The lock records the two digests a frozen check compares (ADR-086).
//
// Input is everything the projection reads that a repository can change, plus the
// digest of what this package ships. Output is the region body. An output that moves
// while the input does not is a renderer that is not a function of its inputs, and
// that is the failure `--frozen` exists to catch. An input that moves is a stale
// lock: the projection changed because the repository did, and the lock was not
// rewritten.

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readLockedVariants } from '../kernel/variants.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { LOCK_FILE, LOCK_LEGACY } from '../name.mjs';
import { desiredRegion, provenanceDigest, LOCAL_PROFILE_DIR } from './rules.mjs';
import { readManifest } from './manifest.mjs';

/** Manifest keys that change what the region contains. Anything else in the file is
 *  the repository's own notes, and hashing it would make a comment fail the lock. */
const MANIFEST_KEYS = ['mode', 'budget', 'shared', 'surfaces', 'gates'];

/**
 * The lock this repository's projection should have.
 *
 * @param {string} root
 * @param {object} [flags] the same flags `sync` rendered with, so the output is the
 *   body that was written and not a body for a different set of surfaces
 * @param {object} [manifest] the manifest to digest, in place of the one on disk. A
 *   writer that is about to write a manifest (a fresh `init`) passes it here so the
 *   lock records the state the repo will have, not the state it has (Q29).
 */
export async function computeLock(root, flags = {}, manifest = undefined) {
  const variants =
    flags?.variants !== undefined ? flags.variants : await readLockedVariants(root);
  const desired = await desiredRegion(root, { ...flags, variants });
  const inputs = await inputDigest(root, variants, manifest);
  const outputs = createHash('sha256').update(desired.body).digest('hex');
  const hasVariants =
    variants && typeof variants === 'object' && Object.keys(variants).length > 0;
  return hasVariants ? { inputs, outputs, variants } : { inputs, outputs };
}

/**
 * Record locked variant winners in `simt.lock.json` alongside updated digests.
 */
export async function writeLockVariants(root, nextVariants, flags = {}) {
  const existing = await readLockedVariants(root);
  const merged = { ...existing, ...(nextVariants ?? {}) };
  const lock = await computeLock(root, { ...flags, variants: merged });
  await writeFile(join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return lock;
}

/** Read a lock, or null when the file is not there. A file that does not parse is an
 *  error the caller reports, not a missing lock: absence and damage are different
 *  repairs. A lock under the legacy name is a lock (ADR-110): it is read until the
 *  next write migrates it, and a permission failure on the new name is not an excuse
 *  to fall back to an older file. */
export async function readLock(root) {
  let text = null;
  for (const name of [LOCK_FILE, LOCK_LEGACY]) {
    try {
      text = await readFile(join(root, name), 'utf8');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (text === null) return { lock: null, error: null };
  try {
    const lock = JSON.parse(text);
    if (typeof lock?.inputs !== 'string' || typeof lock?.outputs !== 'string') {
      return { lock: null, error: 'must be an object with inputs and outputs' };
    }
    if (
      lock.variants !== undefined &&
      (typeof lock.variants !== 'object' || lock.variants === null || Array.isArray(lock.variants))
    ) {
      return { lock: null, error: 'variants must be an object' };
    }
    return { lock, error: null };
  } catch (error) {
    return { lock: null, error: error.message };
  }
}

async function inputDigest(root, variants = {}, manifest = undefined) {
  const hash = createHash('sha256');
  hash.update(`provenance:${await provenanceDigest()}\n`);
  const { stack, facts } = await fingerprint(root);
  hash.update(`signals:${JSON.stringify({ stack, facts })}\n`);
  const owned = {};
  if (manifest === undefined) manifest = (await readManifest(root)).manifest;
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
  const variantKeys =
    variants && typeof variants === 'object' ? Object.keys(variants).sort() : [];
  if (variantKeys.length > 0) {
    const winners = {};
    for (const key of variantKeys) {
      const entry = variants[key];
      winners[key] =
        typeof entry === 'string' ? entry : (entry?.winner ?? entry?.variant ?? null);
    }
    hash.update(`variants:${JSON.stringify(winners)}\n`);
  }
  return hash.digest('hex');
}
