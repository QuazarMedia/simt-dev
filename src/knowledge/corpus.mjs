// A scoped corpus: the sections of the files a repository declared, as data.
//
// The corpus is derived - it lives under `.simt/local/`, it is built from
// the tracked files inside one declared scope, and nothing in it is authored. Five rules keep
// it honest, and each one is a failure that has already shipped somewhere:
//
//   * Policy decides before the bytes are read. A denied path is a row in the inventory and is
//     never handed to the reader, so private content cannot reach a unit, a log or a shared
//     view by being read first and filtered afterwards.
//   * A symlink is not a source. It is labelled and not followed: its target is outside the
//     paths the repository declared, and following one is how a corpus reads /etc.
//   * The inventory is exhaustive. Every candidate is a row, including the refused ones, so an
//     unchanged file cannot quietly survive a scope exclusion - the reason sits next to the
//     path that stopped being indexed.
//   * Reuse is keyed by (path, content digest, policy digest), and only for a file this build
//     still indexes. A stale cache therefore cannot resurrect content the declaration stopped
//     including, and an incremental build produces the same corpus as a cold one.
//   * A `.meta.json` beside a document is that document's metadata read with it, not a source
//     of its own. Indexing the sidecar made the corpus cite metadata as if it were content.
//
// Ranges stay bytes, because the section extractor stores bytes and a corpus that mixes
// characters with bytes cites a different span on every non-ASCII document.
//
// Revisions are labelled `committed:`, `staged:` or `worktree:` with Git's own blob id. The
// overlay reader next door keeps two states because its rows come from staged blobs and the
// working tree and it never reads HEAD; a corpus needs the third, so the label is derived here
// from the three blob ids rather than widening that reader's vocabulary.

import { createHash } from 'node:crypto';

import { normalizePath, resolveScope } from '../work/artifacts.mjs';
import { mayIndex } from '../work/trust.mjs';
import { describeArtifact, resolveRefs } from './lineage.mjs';
import { digestOf } from './observations.mjs';
import { extractDocument } from './sections.mjs';

// Version 2 added artifacts, claims and lineage. A corpus is derived, so an old one is
// rebuilt rather than migrated: the version says what the file holds, not when it was written.
export const CORPUS_SCHEMA_VERSION = 2;

/** Where a corpus is derived to. Git-ignored with the rest of `.simt/`. */
export const CORPUS_DIR = '.simt/local/corpus';

/** Every state a candidate can end in. Each one is a row, never a silent skip. */
const SOURCE_STATES = Object.freeze([
  'indexed',
  'outside',
  'denied',
  'symlink',
  'ignored',
  'untracked',
  'too-large',
  'generated',
  'sidecar',
  'unsupported',
  'missing',
]);

export const CORPUS_DEFAULTS = Object.freeze({ maxBytes: 256 * 1024, maxFiles: 2000, unitBytes: 4096 });

/** A path the corpus never reads, whatever a declaration says. */
export const ALWAYS_DENIED = Object.freeze(['.git', '.simt', 'node_modules']);

const PREFIX = Object.freeze({ committed: 'committed:', staged: 'staged:', 'working-tree': 'worktree:' });

/** Git's blob identity for bytes, so a corpus row can be compared with `git rev-parse`. */
export function blobIdOf(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

/**
 * The provenance of a source and its revision label.
 *
 * The three states are distinguished by blob identity: bytes equal to HEAD's are committed,
 * bytes equal to the index's but not HEAD's are staged, anything else is the working tree.
 * An untracked file has neither ids and is the working tree by definition.
 *
 * @param {{head?: string|null, index?: string|null, worktree?: string|null}} input
 * @returns {{provenance: 'committed'|'staged'|'working-tree', revision: string|null}}
 */
export function revisionOfSource({ head = null, index = null, worktree = null } = {}) {
  if (worktree === null) return { provenance: 'working-tree', revision: null };
  if (worktree === head) return { provenance: 'committed', revision: `${PREFIX.committed}${worktree}` };
  if (worktree === index) return { provenance: 'staged', revision: `${PREFIX.staged}${worktree}` };
  return { provenance: 'working-tree', revision: `${PREFIX['working-tree']}${worktree}` };
}

/**
 * A digest of the policy decisions, so a policy change invalidates every reuse.
 *
 * The order of the lists is sorted first: two declarations that deny the same paths in a
 * different order are one policy, and a digest that disagreed would rebuild for no reason.
 *
 * @param {{deny?: string[], maxBytes?: number, unitBytes?: number}} policy
 * @returns {string}
 */
export function policyDigest(policy = {}) {
  const deny = [...new Set(Array.isArray(policy.deny) ? policy.deny : [])].sort();
  // The identity map is part of the policy: it decides what a unit is cited as, so a map that
  // changed under an unchanged file must rebuild rather than reuse the old ids.
  const identities = Object.entries(policy.identities ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return digestOf(JSON.stringify({ deny, identities, maxBytes: policy.maxBytes ?? CORPUS_DEFAULTS.maxBytes, unitBytes: policy.unitBytes ?? CORPUS_DEFAULTS.unitBytes }));
}

/** A file that says it is generated is indexed from its source, never from the output. */
function generatedReason(text) {
  const head = text.slice(0, 2000).toLowerCase();
  return head.includes('generated') && head.includes('do not edit')
    ? 'the file says it is generated; index what generates it, not the output'
    : null;
}

function unitRow({ artifact, scope, path, unit, sourceDigest, provenance, revision, offset = { bytes: 0, lines: 0 } }) {
  return {
    id: unit.id,
    // The id comes from the artifact, not from the path: a declared id is what survives a move.
    // A document with no heading has an empty anchor, and `id#` cites a fragment that does not
    // exist, so the unit cites the artifact itself.
    artifact: unit.anchor === '' ? artifact : `${artifact}#${unit.anchor}`,
    scope: scope.id,
    path,
    anchor: unit.anchor,
    title: unit.title,
    headings: unit.headings,
    // The extractor ran on the body, so its ranges are shifted back onto the file.
    lineStart: unit.lineStart + offset.lines,
    lineEnd: unit.lineEnd + offset.lines,
    byteStart: unit.byteStart + offset.bytes,
    byteEnd: unit.byteEnd + offset.bytes,
    bytes: unit.bytes,
    digest: unit.digest,
    text: unit.text,
    sourceDigest,
    provenance,
    revision,
    basis: 'section',
    // A section is evidence: it supports an answer, and it is not a reviewed fact.
    authority: 'evidence',
  };
}

/**
 * The corpus one scope yields, and the reason for every candidate it did not index.
 *
 * `read` returns the file's bytes or null; bytes rather than text, because Git's blob identity
 * is computed over bytes and a decoded string is not the same digest. Nothing here touches the
 * filesystem, the clock or the network: the same candidates, policy and previous corpus give
 * the same result on every machine.
 *
 * @param {{scope: object, candidates?: object[], policy?: object, previous?: object|null, read?: Function}} input
 * @returns {Promise<object>}
 */
export async function buildCorpus({ scope = {}, scopes = null, candidates = [], policy = {}, previous = null, read = async () => null, sidecar = async () => null, identities = {} } = {}) {
  const deny = Array.isArray(policy.deny) ? policy.deny : [];
  const maxBytes = Number.isFinite(policy.maxBytes) ? policy.maxBytes : CORPUS_DEFAULTS.maxBytes;
  const unitBytes = Number.isFinite(policy.unitBytes) ? policy.unitBytes : CORPUS_DEFAULTS.unitBytes;
  const declared = Array.isArray(scopes) && scopes.length > 0 ? scopes : [scope];
  const identityMap = policy.identities ?? identities;
  const policyId = policyDigest({ deny, identities: identityMap, maxBytes, unitBytes });

  const priorSources = new Map((Array.isArray(previous?.inventory) ? previous.inventory : []).map((row) => [row.path, row]));
  // A previous unit is only a candidate for reuse under the policy that produced it. Any
  // other policy re-reads the file, which is what keeps a stale cache from surviving a
  // declaration change.
  const priorUnits = new Map();
  if (previous?.policy === policyId) {
    for (const unit of Array.isArray(previous?.units) ? previous.units : []) {
      const list = priorUnits.get(unit.path) ?? [];
      list.push(unit);
      priorUnits.set(unit.path, list);
    }
  }

  const inventory = [];
  const units = [];
  const artifacts = [];
  const problems = [];
  let reused = 0;

  for (const candidate of [...candidates].sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
    const path = normalizePath(candidate.path);
    if (path === null) {
      inventory.push({ path: String(candidate.path), state: 'outside', reason: `${candidate.path} is not a repository-relative path` });
      continue;
    }
    // Denial is answered from the path alone, before the reader is reached.
    const allowed = mayIndex({ path, deniedPaths: deny.length > 0 ? deny : ALWAYS_DENIED });
    if (!allowed.indexed) {
      inventory.push({ path, state: 'denied', reason: allowed.reason });
      continue;
    }
    if (candidate.symlink === true) {
      inventory.push({ path, state: 'symlink', reason: 'a symlink is not a source; its target is not a path this scope declared' });
      continue;
    }
    const owned = resolveScope(declared, path);
    if (owned.scope !== scope.id) {
      const conflict = owned.error?.kind === 'conflict' ? `claimed by ${owned.error.candidates.join(' and ')}` : owned.scope === null ? 'unclaimed' : `owned by ${owned.scope}`;
      inventory.push({ path, state: 'outside', reason: `${path} is ${conflict}` });
      continue;
    }
    if (owned.ignored === true) {
      inventory.push({ path, state: 'ignored', reason: `the scope ignores ${JSON.stringify(owned.pattern)}` });
      continue;
    }
    if (candidate.gitIgnored === true) {
      inventory.push({ path, state: 'ignored', reason: 'Git ignores this path, and ingestion defaults to tracked files' });
      continue;
    }
    if (candidate.tracked === false) {
      inventory.push({ path, state: 'untracked', reason: 'ingestion defaults to tracked files; commit it, or scope the path it belongs to' });
      continue;
    }
    // A sidecar is metadata for the document beside it, and the reader above already folds it
    // in. Indexing it as a document of its own would put the metadata in the corpus as content,
    // with an anchor and a digest that answer a question the file never made a claim about.
    if (path.endsWith('.meta.json')) {
      inventory.push({ path, state: 'sidecar', reason: `${path} is the metadata sidecar of ${path.slice(0, -'.meta.json'.length)}, and is read with it rather than indexed` });
      continue;
    }
    if (Number.isFinite(candidate.bytes) && candidate.bytes > maxBytes) {
      inventory.push({ path, state: 'too-large', reason: `${candidate.bytes} bytes exceeds the ${maxBytes}-byte bound this build reads` });
      continue;
    }

    const body = await read(path);
    if (body === null) {
      inventory.push({ path, state: 'missing', reason: 'the file was listed and could not be read; it may have been deleted or moved since the walk' });
      continue;
    }
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const text = bytes.toString('utf8');
    const sourceDigest = digestOf(text);
    const worktree = blobIdOf(bytes);
    const { provenance, revision } = revisionOfSource({ head: candidate.headBlob ?? null, index: candidate.indexBlob ?? null, worktree });
    const row = { path, digest: sourceDigest, bytes: bytes.length, provenance, revision };

    const generated = generatedReason(text);
    if (generated !== null) {
      inventory.push({ path, state: 'generated', reason: generated, ...row });
      continue;
    }

    const described = describeArtifact({ path, text, scopes: declared, identities: identityMap, sidecar: await sidecar(path) });
    const doc = extractDocument(described.body, { path, unitBytes });
    if (doc.unindexed !== null) {
      inventory.push({ path, state: 'unsupported', reason: doc.unindexed.reason, ...row });
      continue;
    }
    problems.push(...described.problems);
    const base = described.artifact.id;

    const reusable = priorUnits.get(path);
    const sameBlob = reusable !== undefined && reusable.length > 0 && reusable[0].sourceDigest === sourceDigest;
    const own = sameBlob
      ? reusable.map((unit) => ({ ...unit, scope: scope.id, provenance, revision }))
      : doc.units.map((unit) => unitRow({ artifact: base, scope, path, unit, sourceDigest, provenance, revision, offset: described.offset }));
    if (sameBlob) reused += 1;

    artifacts.push({ ...described.artifact, sources: described.refs, digest: sourceDigest, bytes: bytes.length, provenance, revision, sections: doc.sections.length, units: own.length });
    units.push(...own);
    inventory.push({ path, state: 'indexed', sections: doc.sections.length, units: own.length, artifact: base, ...row });
  }

  // Two documents that resolve to one id are reported, not merged: a shared id without an
  // explicit multi-representation declaration makes every citation of it ambiguous.
  const byId = new Map();
  for (const artifact of artifacts) {
    const list = byId.get(artifact.id) ?? [];
    list.push(artifact.path);
    byId.set(artifact.id, list);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    for (const path of list) {
      problems.push({ code: 'duplicate-id', path, field: 'id', message: `id \`${id}\` is produced by ${list.join(', ')}`, remedy: 'give each document its own id, or map the shared id to one path in .simt/knowledge/identities.json' });
    }
  }

  // References resolve against what this build indexes, after the loop: a document may point at
  // a section of a file that comes later in the same build.
  const anchors = new Map(artifacts.map((artifact) => [artifact.path, new Set()]));
  for (const unit of units) {
    const set = anchors.get(unit.path);
    if (set !== undefined && unit.anchor !== '') set.add(unit.anchor);
  }
  const paths = new Set(artifacts.map((artifact) => artifact.path));
  for (const artifact of artifacts) {
    const resolved = resolveRefs(artifact.sources, { paths, anchorsOf: (path) => anchors.get(path) ?? new Set() });
    artifact.sources = resolved.sources;
    problems.push(...resolved.problems);
  }

  // A rename is a digest this build indexes under a path the last build did not have, and a
  // path the last build indexed that is now gone. It is recorded, not resolved: the artifact id
  // is still the path, and only an explicit rename map makes a moved document one id.
  const present = new Set(inventory.map((row) => row.path));
  const vanished = new Map();
  for (const row of priorSources.values()) {
    if (row.state !== 'indexed' || present.has(row.path) || typeof row.digest !== 'string') continue;
    const list = vanished.get(row.digest) ?? [];
    list.push(row.path);
    vanished.set(row.digest, list);
  }
  const claimed = new Set();
  for (const row of inventory) {
    if (row.state !== 'indexed' || priorSources.has(row.path)) continue;
    const from = (vanished.get(row.digest) ?? []).slice().sort().find((path) => !claimed.has(path));
    if (from === undefined) continue;
    claimed.add(from);
    row.renamedFrom = from;
  }

  const counts = {
    candidates: candidates.length,
    ...Object.fromEntries(SOURCE_STATES.map((state) => [state, 0])),
    units: units.length,
    artifacts: artifacts.length,
    claims: artifacts.reduce((total, artifact) => total + artifact.claims.length, 0),
  };
  for (const row of inventory) counts[row.state] += 1;

  // `reused` is reported beside the corpus, not inside it: it is a property of this build, and
  // a corpus that recorded it would differ from the cold build it is supposed to equal.
  return {
    schema: CORPUS_SCHEMA_VERSION,
    scope: scope.id,
    policy: policyId,
    counts,
    inventory,
    artifacts,
    units,
    problems,
    reused,
  };
}
