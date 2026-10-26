// Shared rule sets, vendored into the repository that uses them.
//
// A pack is one answer to a question fourteen repositories kept asking separately:
// "several repositories share one set of rules, and it must change in one place."
// What a pack is NOT is a remote fetch. The content lives in the adopting
// repository at `.simt/packs/<name>/`, and the manifest records a digest of
// it. Reading it from anywhere else would make the rendered region depend on a
// path that does not resolve in the receiving repository - which is the single
// failure this whole tool exists to prevent, and it would be introduced by the
// feature meant to remove duplication.
//
// `graph/skills.graph.json` is deliberately not part of a pack. ADR-061 ruled
// the registry to be workspace data; a second source for it would need its own
// resolution ruling, and inventing one here would be how that gets settled by
// accident.

import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { readManifest } from './projection/manifest.mjs';
import { CLI, MANIFEST_FILE } from './name.mjs';

/** Where a pack's files live, relative to a repository root. */
export const PACK_DIR = '.simt/packs';

// A pack name is a directory name under `PACK_DIR`, and it ends up in a path the
// tool builds from manifest content. Restricted to the characters a directory
// name can hold without escaping, so a hand-edited manifest cannot point the
// reader's renderer at something outside the repository.
const NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * @returns {string|null} the name if it is usable, else why it is not.
 *
 * Exported because `pack lint` refuses the same names the resolver refuses:
 * a second copy of the pattern would drift exactly when a pack needed it most.
 */
export function packNameProblem(name) {
  if (typeof name !== 'string' || name.length === 0) return 'a pack name must be a non-empty string';
  if (!NAME.test(name)) return `\`${name}\` is not a usable pack name: lowercase letters, digits, dot, dash and underscore`;
  if (name === '.' || name === '..') return `\`${name}\` is not a usable pack name`;
  return null;
}

/**
 * The digest of one pack directory: every file, relative path and bytes, in
 * sorted path order. Same shape as the rule provenance digest on purpose - a
 * reader who has seen one digest in a manifest has seen the other.
 *
 * The paths are pack-relative, so a pack moved to another repository hashes the
 * same. That is the property that makes the digest a statement about CONTENT
 * rather than about where the reader happens to keep it.
 *
 * `exclude` names pack-relative files the digest does not cover. It exists for the
 * one file that must not be covered: a pack's bench summary records the digest of
 * the bytes it was measured at, so a digest that covered the summary could never
 * equal the digest the summary records - writing the measurement would change it.
 * The manifest pin covers every byte; the summary binds to everything but itself.
 *
 * @returns {Promise<string>} 40 hex chars, or `''` for a directory that is not there.
 */
export async function packDigest(dir, { exclude = [] } = {}) {
  const files = [];
  const excluded = new Set(exclude);
  const walk = async (d, prefix = '') => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(d, entry.name), rel);
      else if (entry.isFile() && !excluded.has(rel)) files.push(rel);
    }
  };
  await walk(dir);
  files.sort();

  const hash = createHash('sha256');
  for (const rel of files) {
    const bytes = await readFile(join(dir, rel));
    hash.update(`${rel}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, 40);
}

/**
 * Resolve the packs a repository declares, and report the ones it cannot use.
 *
 * A declared pack with no directory, or whose bytes no longer match the digest,
 * is a finding rather than a silent omission: a repo whose region renders
 * without half its rules is a repo whose reader was told something false, and the
 * next `sync` would overwrite the truth on disk with the shorter region.
 *
 * `present` and `ok` are separate questions on purpose. A pack whose bytes do not
 * match its pin is still PROJECTED - otherwise the remedy the finding names,
 * `sync --yes`, would delete every rule the pack carries, which is the opposite of
 * what a reader who ran the remedy meant. What is questioned is the pin, and the
 * gate stays red until it is re-recorded; what is missing is the directory, and
 * there is nothing to project.
 *
 * The remedy is `git checkout -- <dir>`, because the pack is vendored: git has
 * the bytes this manifest's digest names. `sync` cannot help - it would render
 * the region without the pack and call it current - so the remedy does not name
 * it as the repair and does name it as the thing to run afterwards.
 *
 * @returns {Promise<{packs: {name: string, dir: string, source: string, version: string, digest: string, declared: string, ok: boolean}[], findings: {file: string, status: string, detail: string, remedy: string}[]}>}
 */
export async function resolvePacks(root) {
  const findings = [];
  const packs = [];
  const { manifest, exists, error } = await readManifest(root);
  if (!exists || error !== null || manifest === null) return { packs, findings };

  const declared = Array.isArray(manifest.packs) ? manifest.packs : [];
  const seen = new Set();

  for (const entry of declared) {
    const name = entry?.name;
    const problem = packNameProblem(name);
    if (problem !== null) {
      findings.push({
        file: MANIFEST_FILE,
        status: 'pack-name-invalid',
        detail: problem,
        remedy: `correct or remove the entry, then: ${CLI} sync --yes`,
      });
      continue;
    }
    if (seen.has(name)) {
      findings.push({
        file: MANIFEST_FILE,
        status: 'pack-declared-twice',
        detail: `pack \`${name}\` is declared twice; the second declaration is read as the first`,
        remedy: `remove the duplicate entry, then: ${CLI} sync --yes`,
      });
      continue;
    }
    seen.add(name);

    const dir = join(root, PACK_DIR, name);
    const source = typeof entry.source === 'string' ? entry.source : null;
    const version = typeof entry.version === 'string' ? entry.version : null;
    let present = false;
    try {
      present = (await stat(dir)).isDirectory();
    } catch {
      present = false;
    }
    if (!present) {
      findings.push({
        file: `${PACK_DIR}/${name}`,
        status: 'pack-missing',
        detail: `the manifest declares pack \`${name}\`, and there is no directory for it; every rule it carries is missing from this repository's projection`,
        remedy: `restore it with: git checkout -- ${PACK_DIR}/${name}  (or remove the declaration, then: ${CLI} sync --yes)`,
      });
      packs.push({ name, dir, source, version, digest: '', declared: '', present: false, ok: false });
      continue;
    }

    const digest = await packDigest(dir);
    const declaredDigest = typeof entry.digest === 'string' ? entry.digest : null;
    // An absent digest is not a mismatch. A pack someone vendored and has not
    // pinned yet still carries its rules, and refusing to project them would make
    // the tool refuse a repository for a field it has always treated as optional.
    // It is reported, because "pinned to nothing" is not a fact about the content.
    let ok = true;
    if (declaredDigest === null) {
      findings.push({
        file: MANIFEST_FILE,
        status: 'pack-unpinned',
        detail: `pack \`${name}\` has no digest, so nothing records which bytes it was declared at`,
        remedy: `record \`${digest}\` as its digest, then: ${CLI} sync --yes`,
      });
    } else if (declaredDigest !== digest) {
      ok = false;
      findings.push({
        file: `${PACK_DIR}/${name}`,
        status: 'pack-digest-mismatch',
        detail: `pack \`${name}\` is pinned to ${declaredDigest} and its bytes digest to ${digest}`,
        remedy: `restore the pinned bytes with: git checkout -- ${PACK_DIR}/${name}  (or update the digest to ${digest}, then: ${CLI} sync --yes)`,
      });
    }
    packs.push({ name, dir, source, version, digest, declared: declaredDigest ?? digest, present: true, ok });
  }

  return { packs, findings };
}