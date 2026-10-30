// The one answer to "where are this repository's decision records" (review 0003 Q55).
//
// Before this, every reader hard-coded `docs/decisions` while detection already
// knew four spellings (`docs/decisions`, `docs/adr`, `docs/adrs`, `adr`), so a
// repository that kept its records under `docs/adr/` was fingerprinted correctly
// and then unread by every command. One resolution, every reader.
//
// Precedence is declaration first. A manifest `decisions.dir` names the directory
// relative to the repository root; without one, the first existing candidate
// wins; without any, the default is `docs/decisions`. The cutoff below answers
// the companion question — which records predate structured frontmatter — and it
// lives in the same config (`decisions.historicalCutoff`), never in code.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { readManifest } from '../projection/manifest.mjs';

/** Directory spellings a repository's decision records live under, in priority order. */
const DECISION_DIR_CANDIDATES = ['docs/decisions', 'docs/adr', 'docs/adrs', 'adr'];

/** The default when nothing is declared and nothing exists yet. */
const DEFAULT_DECISIONS_DIR = 'docs/decisions';

/**
 * The repository's own `decisions` manifest key, or null.
 *
 * Read with the manifest loader (so the legacy name resolves the same way for
 * this as for every other reader) and returned as-is: validation belongs to
 * the caller that knows what it needs.
 */
async function manifestDecisions(root) {
  try {
    const { manifest } = await readManifest(root);
    const decisions = manifest?.decisions;
    return decisions !== null && typeof decisions === 'object' && !Array.isArray(decisions) ? decisions : null;
  } catch {
    // An unreadable manifest is not evidence either way; detection decides.
    return null;
  }
}

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The relative decisions directory for this repository.
 *
 * @param {string} root repository root
 * @returns {Promise<string>} e.g. `docs/decisions`
 */
export async function decisionsDir(root) {
  const declared = await manifestDecisions(root);
  if (typeof declared?.dir === 'string' && declared.dir.trim() !== '') {
    return declared.dir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  }
  for (const candidate of DECISION_DIR_CANDIDATES) {
    if (await isDir(join(root, candidate))) return candidate;
  }
  return DEFAULT_DECISIONS_DIR;
}

/**
 * How many leading records predate structured frontmatter and are exempt from it.
 *
 * The package's own history is the only corpus with such records, and even it
 * declares the number in its own manifest rather than in code: a number in code
 * is a second answer the next record silently moves. Any other repository gets
 * zero unless it declares otherwise.
 *
 * @param {string} root repository root
 * @returns {Promise<number>}
 */
export async function decisionsCutoff(root) {
  const declared = await manifestDecisions(root);
  const value = declared?.historicalCutoff;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return 0;
}
