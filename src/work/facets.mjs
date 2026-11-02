// Orthogonal work facets: what a repository produces, and how, without a stack taxonomy.
//
// The failure this module exists for is a knowledge repository whose only visualisation is
// a `.tsx` file acquiring the stack `[react]` and then being treated as an application:
// its documents stop being the product and its generated pages start being "code". Stack
// detection is not wrong - it answers a different question - so facets are additive. They
// name the kinds of artifact (`source`, `document`, `dataset`, `recipe`, `remote-object`),
// the activities (research, generate, validate, operate), where execution happens, and
// which verifications the repository can actually run, each with the paths that proved it.
//
// Facets never grant permission and never suppress a code check. A repository that has
// both documents and sources gets both obligations; the incidental `.tsx` adds a kind
// rather than replacing one. Ambiguity is reported instead of resolved: a Python file
// under `recipes/` is both a recipe and source, and collapsing it to either would drop an
// obligation the repository really has.
//
// This reads a bounded sample of the tree and nothing else: no manifest is written, no
// command runs, no network is opened.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { MANIFEST_FILE } from '../name.mjs';

/** Every kind of artifact this detector can name. */
export const ARTIFACT_KINDS = Object.freeze(['source', 'document', 'dataset', 'recipe', 'remote-object']);

/** The walk is bounded because a facet is a probe, not a scan (ADR-013). */
const MAX_PATHS = 200;
const MAX_DEPTH = 3;
const SKIP_DIRS = new Set(['node_modules', '.git', '.simt', '.simt-dev', 'dist', 'build', 'coverage', 'vendor']);

const DOCUMENT = /\.(md|mdx|html?)$/i;
const DATASET = /\.(csv|tsv|parquet|jsonl)$/i;
const SOURCE = /\.(mjs|cjs|js|ts|tsx|py|kt|kts|java|rb|go|rs|sh)$/i;
const RECIPE_DIR = /(^|\/)recipes\//;
const GENERATOR = /(^|\/)(scripts|generators?)\/|(^|\/)[^/]*(generate|render|export)[^/]*$/i;
const VALIDATOR = /(^|\/)(eval|checks?|validation)\/|(^|\/)[^/]*(validate|check|verify)[^/]*$/i;
const TEST_FILE = /(^|\/)(test|tests|spec)\/|\.(test|spec)\./i;

/** A bounded, deterministic walk of the working tree, returning forward-slash paths. */
async function walk(root, { limit = MAX_PATHS, depth = MAX_DEPTH } = {}) {
  const found = [];
  const queue = [{ dir: '', level: 0 }];
  while (queue.length > 0 && found.length < limit) {
    const { dir, level } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir === '' ? root : join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= limit) break;
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || level >= depth) continue;
        queue.push({ dir: rel, level: level + 1 });
      } else if (entry.isFile()) {
        found.push(rel);
      }
    }
  }
  return found;
}

/** Kinds implied by a path alone. Directory rules and extensions are independent. */
function kindsOf(path) {
  const kinds = [];
  if (DOCUMENT.test(path)) kinds.push('document');
  if (DATASET.test(path)) kinds.push('dataset');
  if (SOURCE.test(path)) kinds.push('source');
  if (RECIPE_DIR.test(path)) kinds.push('recipe');
  return kinds;
}

/** A recipe contract marker is content, so it is read for a bounded number of files. */
async function declaresMutation(root, path) {
  if (!/\.(md|py|mjs|js|ts)$/i.test(path)) return false;
  try {
    const text = await readFile(join(root, path), 'utf8');
    return /@mutates\b/.test(text) && /@not_idempotent\b|@idempotent\b/.test(text);
  } catch {
    return false;
  }
}

function add(map, key, evidence) {
  if (!map.has(key)) map.set(key, []);
  const list = map.get(key);
  if (!list.includes(evidence) && list.length < 5) list.push(evidence);
}

/**
 * Describe what a repository's work consists of.
 *
 * @returns {Promise<{artifactKinds: {kind: string, count: number, evidence: string[]}[], activities: {activity: string, evidence: string[]}[], executionLoci: {locus: string, evidence: string[]}[], capabilities: {capability: string, evidence: string[]}[], ambiguous: {path: string, candidates: string[]}[], truncated: boolean, configured: boolean}>}
 */
export async function detectFacets(root, options = {}) {
  const limit = options.limit ?? MAX_PATHS;
  const paths = await walk(root, { limit, depth: options.depth ?? MAX_DEPTH });
  const kinds = new Map();
  const counts = new Map();
  const ambiguous = [];

  for (const path of paths) {
    const candidates = kindsOf(path);
    if (candidates.length > 1) ambiguous.push({ path, candidates });
    for (const kind of candidates) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      add(kinds, kind, path);
    }
  }

  // `remote-object` is a declaration, not something a path can prove: only an explicit
  // work manifest says this repository operates objects it does not contain.
  const manifest = await readFile(join(root, MANIFEST_FILE), 'utf8').then(
    (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    () => null,
  );
  const targets = Array.isArray(manifest?.work?.targets) ? manifest.work.targets : [];
  if (targets.length > 0) {
    counts.set('remote-object', targets.length);
    add(kinds, 'remote-object', `${MANIFEST_FILE}#work.targets`);
  }

  const recipeEvidence = kinds.get('recipe') ?? [];
  const mutations = [];
  for (const path of recipeEvidence) if (await declaresMutation(root, path)) mutations.push(path);
  // A recipe that declares a mutation is the only evidence of `operate` a document tree
  // can carry. A recipe that does not is still a recipe; it is not yet an operation.
  if (mutations.length > 0) add(kinds, 'operate', mutations[0]);

  const activities = new Map();
  const documents = kinds.get('document') ?? [];
  if (documents.some((path) => /(^|\/)(sources?|research)\//i.test(path))) add(activities, 'research', documents.find((path) => /(^|\/)(sources?|research)\//i.test(path)));
  for (const path of paths) {
    if (GENERATOR.test(path) && !TEST_FILE.test(path)) add(activities, 'generate', path);
    if (VALIDATOR.test(path)) add(activities, 'validate', path);
  }
  for (const path of mutations) add(activities, 'operate', path);

  const capabilities = new Map();
  const testFile = paths.find((path) => TEST_FILE.test(path));
  if (testFile !== undefined) add(capabilities, 'source-tests', testFile);
  if (activities.has('validate')) add(capabilities, 'document-checks', activities.get('validate')[0]);
  if (recipeEvidence.length > 0) add(capabilities, 'recipe-runner', recipeEvidence[0]);

  const rows = (map) =>
    [...map.entries()]
      .filter(([key]) => ARTIFACT_KINDS.includes(key) || !['operate'].includes(key) || true)
      .map(([key, evidence]) => ({ key, evidence }));

  return {
    artifactKinds: [...counts.entries()]
      .filter(([kind]) => ARTIFACT_KINDS.includes(kind))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, count]) => ({ kind, count, evidence: kinds.get(kind) ?? [] })),
    activities: rows(activities).map(({ key, evidence }) => ({ activity: key, evidence })),
    executionLoci: [
      { locus: 'local', evidence: ['.'] },
      ...(targets.length > 0 ? [{ locus: 'remote', evidence: [`${MANIFEST_FILE}#work.targets`] }] : []),
    ],
    capabilities: rows(capabilities).map(({ key, evidence }) => ({ capability: key, evidence })),
    ambiguous,
    truncated: paths.length >= limit,
    configured: Array.isArray(manifest?.work?.targets),
  };
}
