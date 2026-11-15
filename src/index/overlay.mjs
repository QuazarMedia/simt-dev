// The working-tree overlay: typed graph rows for edits the index has not seen.
//
// The index is a cache of staged blobs. That is exactly what makes it safe - `git
// ls-files -s` can rebuild it - and exactly why it cannot answer for a file somebody is
// editing right now. The overlay is the second layer: rows built from the working tree,
// merged over the staged rows at read time and never written into the cache.
//
// Three properties keep the two layers from becoming one:
//
//   * A label nobody can forge. Staged revisions are `staged:<digest>`, working-tree ones
//     are `worktree:<digest>`, and a row whose provenance and revision disagree is refused.
//     An overlay digest that could be spelled like a blob would be indistinguishable from
//     one in every later report.
//   * Permission and ignore filters run before the read. A denied path is never opened, so
//     its contents cannot reach a row, a vector, a diagnostic or a summary - a filter that
//     ran after extraction would already have the bytes.
//   * Merge, not mutation. A tombstone removes a base row; an overlay row shadows one with
//     the same key; the base is an input and is returned unmodified. A rename converges
//     because it is a delete and an add, and the delete names the old path.
//
// Two backends store the merged rows - JSON lines and SQLite - and they are one semantics:
// the same rows written through either read back identical, in a deterministic order.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { digestOf } from '../knowledge/observations.mjs';
import { resolveScope } from '../work/artifacts.mjs';

export const OVERLAY_SCHEMA_VERSION = 1;

/** Where a row came from. The two are never interchangeable. */
export const PROVENANCES = Object.freeze(['staged', 'working-tree']);

/** How much the row is trusted, mirroring the assurance vocabulary. */
export const TRUST_LEVELS = Object.freeze(['observed', 'proposed', 'reviewed']);

/** Paths the overlay may never read, whatever a caller asks for. */
const ALWAYS_DENIED = Object.freeze(['.git', '.simt', 'node_modules']);

const STAGED_PREFIX = 'staged:';
const WORKTREE_PREFIX = 'worktree:';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;

// One spelling of a digest across both lineages: the observation model owns it.
export { digestOf };

/**
 * The revision label for a row.
 *
 * @param {'staged'|'working-tree'} provenance
 * @param {string} digest
 * @returns {string}
 */
export function revisionOf(provenance, digest) {
  if (provenance === 'staged') return `${STAGED_PREFIX}${digest}`;
  if (provenance === 'working-tree') return `${WORKTREE_PREFIX}${digest}`;
  throw new Error(`provenance must be one of ${PROVENANCES.join(', ')}, not ${JSON.stringify(provenance)}`);
}

/** Whether a revision was produced by the staged blob layer. */
export function isStagedRevision(revision) {
  return typeof revision === 'string' && revision.startsWith(STAGED_PREFIX);
}

/** Whether a revision was produced by the working tree. */
export function isWorktreeRevision(revision) {
  return typeof revision === 'string' && revision.startsWith(WORKTREE_PREFIX);
}

/**
 * One node row, validated.
 *
 * The provenance/revision agreement is the check this slice exists for: a working-tree row
 * labelled `staged:` is refused rather than silently counted as a cached blob.
 *
 * @returns {{node?: object, problems?: string[]}}
 */
export function readNode(input = {}) {
  const source = isObject(input) ? input : {};
  const problems = [];
  for (const key of ['key', 'kind', 'source']) if (!isText(source[key])) problems.push(`${key} must be a non-empty string`);
  if (!PROVENANCES.includes(source.provenance)) problems.push(`provenance must be one of ${PROVENANCES.join(', ')}`);
  if (!TRUST_LEVELS.includes(source.trust)) problems.push(`trust must be one of ${TRUST_LEVELS.join(', ')}`);
  if (PROVENANCES.includes(source.provenance)) {
    const expected = source.provenance === 'staged' ? STAGED_PREFIX : WORKTREE_PREFIX;
    if (!isText(source.revision) || !source.revision.startsWith(expected)) {
      problems.push(`revision must start with ${expected} for a ${source.provenance} row, not ${JSON.stringify(source.revision)}`);
    }
  }
  if (source.scope !== undefined && source.scope !== null && !isText(source.scope)) problems.push('scope must be a non-empty string or null');
  if (source.name !== undefined && source.name !== null && typeof source.name !== 'string') problems.push('name must be a string when given');
  if (source.line !== undefined && source.line !== null && !Number.isInteger(source.line)) problems.push('line must be an integer when given');
  if (source.props !== undefined && source.props !== null && !isObject(source.props)) problems.push('props must be an object when given');
  if (problems.length > 0) return { problems };
  return { node: normaliseNode(source) };
}

/**
 * One edge row. Its revision is the one of the file it is owned by, so an edge can be date
 * stamped by the edit that produced it.
 *
 * @returns {{edge?: object, problems?: string[]}}
 */
export function readEdge(input = {}) {
  const source = isObject(input) ? input : {};
  const problems = [];
  for (const key of ['src', 'kind', 'dst']) if (!isText(source[key])) problems.push(`${key} must be a non-empty string`);
  if (!PROVENANCES.includes(source.provenance)) problems.push(`provenance must be one of ${PROVENANCES.join(', ')}`);
  if (!TRUST_LEVELS.includes(source.trust)) problems.push(`trust must be one of ${TRUST_LEVELS.join(', ')}`);
  if (PROVENANCES.includes(source.provenance)) {
    const expected = source.provenance === 'staged' ? STAGED_PREFIX : WORKTREE_PREFIX;
    if (!isText(source.revision) || !source.revision.startsWith(expected)) {
      problems.push(`revision must start with ${expected} for a ${source.provenance} edge`);
    }
  }
  if (source.scope !== undefined && source.scope !== null && !isText(source.scope)) problems.push('scope must be a non-empty string or null');
  if (source.weight !== undefined && source.weight !== null && !Number.isFinite(source.weight)) problems.push('weight must be a finite number when given');
  if (problems.length > 0) return { problems };
  return { edge: normaliseEdge(source) };
}

function normaliseNode(row) {
  return {
    key: row.key,
    kind: row.kind,
    source: row.source,
    revision: row.revision,
    scope: row.scope ?? null,
    provenance: row.provenance,
    trust: row.trust,
    name: row.name ?? null,
    line: Number.isInteger(row.line) ? row.line : null,
    props: row.props ?? {},
  };
}

function normaliseEdge(row) {
  return {
    src: row.src,
    kind: row.kind,
    dst: row.dst,
    revision: row.revision,
    scope: row.scope ?? null,
    provenance: row.provenance,
    trust: row.trust,
    weight: Number.isFinite(row.weight) ? row.weight : 1,
  };
}

const byKey = (a, b) => a.key.localeCompare(b.key);
const byEdge = (a, b) => `${a.src}\u0000${a.kind}\u0000${a.dst}`.localeCompare(`${b.src}\u0000${b.kind}\u0000${b.dst}`);

/** A prefix with a slash is a subtree; a bare name is that segment anywhere in the path. */
function under(path, prefix) {
  if (prefix.includes('/')) return path === prefix || path.startsWith(`${prefix}/`);
  return path.split('/').includes(prefix);
}

/**
 * Split candidate paths into the ones the overlay may read and the ones it may not.
 *
 * This runs before any read, which is the whole point: a deny list applied after extraction
 * has already had the bytes.
 *
 * @param {{path: string}[]} changes
 * @param {{deny?: string[], ignore?: string[]}} [policy]
 * @returns {{allowed: object[], denied: string[]}}
 */
export function filterAllowed(changes = [], { deny = [], ignore = [] } = {}) {
  const prefixes = [...ALWAYS_DENIED, ...(Array.isArray(deny) ? deny : []), ...(Array.isArray(ignore) ? ignore : [])].filter(isText);
  const allowed = [];
  const denied = [];
  const seen = new Set();
  for (const change of Array.isArray(changes) ? changes : []) {
    const path = change?.path;
    if (!isText(path) || seen.has(path)) continue;
    seen.add(path);
    if (prefixes.some((prefix) => under(path, prefix))) denied.push(path);
    else allowed.push(change);
  }
  return { allowed, denied: denied.sort() };
}

/**
 * Rows for the edits the index has not seen.
 *
 * A path that is deleted is never read - there is nothing to read - and becomes a tombstone.
 * A path that cannot be read is reported rather than silently skipped, because a missing
 * row and an unchanged row look the same to the merge.
 *
 * @param {{changes?: {path: string, status?: string, from?: string}[], read: (path: string) => Promise<string|null>, scopes?: object[], deny?: string[], ignore?: string[], edges?: {src: string, kind: string, dst: string}[]}} input
 * @returns {Promise<object>}
 */
export async function buildOverlay({ changes = [], read, scopes = [], deny = [], ignore = [], edges = [] } = {}) {
  if (typeof read !== 'function') throw new Error('buildOverlay needs a read(path) function; a walk without one cannot know what a file says');
  const { allowed, denied } = filterAllowed(changes, { deny, ignore });
  const nodes = [];
  const problems = [];
  const unreadable = [];
  const readPaths = [];
  const tombstones = [];
  const revisions = new Map();

  for (const change of allowed) {
    const status = change.status ?? 'modified';
    if (status === 'deleted' || change.from !== undefined) {
      const path = status === 'deleted' ? change.path : change.from;
      if (isText(path)) tombstones.push({ key: `file:${path}`, path });
      if (status === 'deleted') continue;
    }
    let text;
    try {
      text = await read(change.path);
    } catch {
      text = null;
    }
    readPaths.push(change.path);
    if (typeof text !== 'string') {
      unreadable.push(change.path);
      continue;
    }
    const resolved = scopes.length > 0 ? resolveScope(scopes, change.path) : { scope: null };
    if (resolved.error?.kind === 'conflict') {
      problems.push(`${change.path} is claimed by ${resolved.error.candidates.join(' and ')}, so its scope is unresolved`);
    }
    const revision = revisionOf('working-tree', digestOf(text));
    revisions.set(change.path, revision);
    const readNodeResult = readNode({
      key: `file:${change.path}`,
      kind: 'file',
      source: change.path,
      revision,
      scope: resolved.scope ?? null,
      provenance: 'working-tree',
      trust: 'observed',
    });
    if (readNodeResult.problems) problems.push(...readNodeResult.problems);
    else nodes.push(readNodeResult.node);
  }

  const edgeRows = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!isObject(edge) || !isText(edge.src) || !isText(edge.kind) || !isText(edge.dst)) {
      problems.push('an edge needs src, kind and dst');
      continue;
    }
    // An edge whose endpoint was denied would name a path the overlay may not mention.
    if (denied.includes(edge.src) || denied.includes(edge.dst)) continue;
    const revision = revisions.get(edge.src);
    if (revision === undefined) {
      problems.push(`edge ${edge.src} -${edge.kind}-> ${edge.dst} belongs to no file the overlay read`);
      continue;
    }
    const readEdgeResult = readEdge({ ...edge, revision, provenance: 'working-tree', trust: 'proposed' });
    if (readEdgeResult.problems) problems.push(...readEdgeResult.problems);
    else edgeRows.push(readEdgeResult.edge);
  }

  nodes.sort(byKey);
  edgeRows.sort(byEdge);
  const fingerprint = digestOf(nodes.map((node) => `${node.source} ${node.revision}`).join('\n'));

  return {
    version: OVERLAY_SCHEMA_VERSION,
    revision: revisionOf('working-tree', fingerprint),
    nodes,
    edges: edgeRows,
    tombstones: tombstones.sort((a, b) => a.key.localeCompare(b.key)),
    denied,
    unreadable: unreadable.sort(),
    readPaths,
    problems,
  };
}

/**
 * The staged rows with the working tree laid over them.
 *
 * A tombstone removes the file's node and every row whose source is that file, which is what
 * makes a delete converge. An overlay row shadows a base row with the same key. The base is
 * never modified: it is a cache, and a read must not write to it.
 *
 * @param {{nodes?: object[], edges?: object[]}} base
 * @param {object} overlay
 * @returns {{nodes: object[], edges: object[], shadowed: string[]}}
 */
export function mergeOverlay(base = {}, overlay = {}) {
  const dead = new Set((overlay.tombstones ?? []).flatMap((tombstone) => [tombstone.key, `file:${tombstone.path}`]));
  const baseNodes = (Array.isArray(base.nodes) ? base.nodes : []).filter((node) => !dead.has(node.key) && !dead.has(`file:${node.source}`));
  const baseEdges = (Array.isArray(base.edges) ? base.edges : []).filter((edge) => !dead.has(`file:${edge.src}`) && !dead.has(`file:${edge.dst}`));
  const overlayNodes = Array.isArray(overlay.nodes) ? overlay.nodes : [];
  const overlayEdges = Array.isArray(overlay.edges) ? overlay.edges : [];
  const overlayKeys = new Set(overlayNodes.map((node) => node.key));
  const shadowed = baseNodes.filter((node) => overlayKeys.has(node.key)).map((node) => node.key).sort();

  const nodes = [...baseNodes.filter((node) => !overlayKeys.has(node.key)), ...overlayNodes].map(normaliseNode).sort(byKey);
  const edges = [...baseEdges, ...overlayEdges]
    .filter((edge, index, all) => all.findIndex((other) => other.src === edge.src && other.kind === edge.kind && other.dst === edge.dst) === index)
    .map(normaliseEdge)
    .sort(byEdge);
  return { nodes, edges, shadowed };
}

/** Rows in the order both backends write and read them, so two runs compare byte for byte. */
function ordered(rows = {}) {
  return {
    nodes: [...(Array.isArray(rows.nodes) ? rows.nodes : [])].map(normaliseNode).sort(byKey),
    edges: [...(Array.isArray(rows.edges) ? rows.edges : [])].map(normaliseEdge).sort(byEdge),
  };
}

const OVERLAY_DDL = `
create table if not exists overlay_nodes(
  key text primary key, kind text, source text, revision text, scope text,
  provenance text, trust text, name text, line integer, props text
);
create table if not exists overlay_edges(
  src text, kind text, dst text, revision text, scope text, provenance text,
  trust text, weight real,
  primary key(src, kind, dst)
);
`;

/**
 * A JSON-lines backend: one row per line, node rows before edge rows, both sorted.
 *
 * @param {string} file
 */
export function jsonlBackend(file) {
  return {
    async write(rows = {}) {
      const { nodes, edges } = ordered(rows);
      const lines = [
        ...nodes.map((node) => JSON.stringify({ row: 'node', ...node })),
        ...edges.map((edge) => JSON.stringify({ row: 'edge', ...edge })),
      ];
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
    },
    async read() {
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        // A missing overlay is empty. An existing file that cannot be read is not: the
        // SQLite backend reports that as corruption, and the two backends are one
        // semantics (A21).
        if (error.code === 'ENOENT') return { nodes: [], edges: [] };
        return {
          nodes: [],
          edges: [],
          error: { code: 'INDEX_CORRUPT', message: `overlay ${file}: ${error?.message ?? error}` },
        };
      }
      const nodes = [];
      const edges = [];
      text.split('\n').forEach((line, index) => {
        if (line.trim() === '') return;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          throw new Error(`${file}:${index + 1} is not a JSON row`);
        }
        if (entry.row === 'node') {
          const read = readNode(entry);
          if (read.problems) throw new Error(`${file}:${index + 1} is not a node row: ${read.problems.join('; ')}`);
          nodes.push(read.node);
        } else if (entry.row === 'edge') {
          const read = readEdge(entry);
          if (read.problems) throw new Error(`${file}:${index + 1} is not an edge row: ${read.problems.join('; ')}`);
          edges.push(read.edge);
        } else {
          throw new Error(`${file}:${index + 1} names no row kind`);
        }
      });
      return { nodes: nodes.sort(byKey), edges: edges.sort(byEdge) };
    },
  };
}

/**
 * A SQLite backend with the same rows and the same order.
 *
 * `node:sqlite` is imported where it is used, so a caller that only merges rows does not
 * pay for the floor check and a Node without it fails at the one backend that needs it.
 *
 * @param {string} file
 */
export function sqliteBackend(file) {
  return {
    async write(rows = {}) {
      const { DatabaseSync } = await import('node:sqlite');
      const { nodes, edges } = ordered(rows);
      await mkdir(dirname(file), { recursive: true });
      const db = new DatabaseSync(file);
      try {
        db.exec(OVERLAY_DDL);
        db.exec('begin immediate');
        db.exec('delete from overlay_nodes');
        db.exec('delete from overlay_edges');
        const addNode = db.prepare(`insert into overlay_nodes(key, kind, source, revision, scope, provenance, trust, name, line, props)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const node of nodes) addNode.run(node.key, node.kind, node.source, node.revision, node.scope, node.provenance, node.trust, node.name, node.line, JSON.stringify(node.props));
        const addEdge = db.prepare(`insert into overlay_edges(src, kind, dst, revision, scope, provenance, trust, weight)
          values (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const edge of edges) addEdge.run(edge.src, edge.kind, edge.dst, edge.revision, edge.scope, edge.provenance, edge.trust, edge.weight);
        db.exec('commit');
      } catch (error) {
        try {
          db.exec('rollback');
        } catch {
          // The transaction was never open; the original error is the one to report.
        }
        throw error;
      } finally {
        db.close();
      }
    },
    async read() {
      // Before the open, because `new DatabaseSync(file)` creates the file: a missing
      // overlay would then be "corrupt" (no tables) rather than simply absent.
      if (!existsSync(file)) return { nodes: [], edges: [] };
      const { DatabaseSync } = await import('node:sqlite');
      let db;
      try {
        db = new DatabaseSync(file);
        const nodes = db
          .prepare('select key, kind, source, revision, scope, provenance, trust, name, line, props from overlay_nodes order by key')
          .all()
          .map((row) => normaliseNode({ ...row, props: row.props === null ? {} : JSON.parse(row.props) }));
        const edges = db
          .prepare('select src, kind, dst, revision, scope, provenance, trust, weight from overlay_edges order by src, kind, dst')
          .all()
          .map(normaliseEdge);
        return { nodes, edges };
      } catch (error) {
        // A file that exists and cannot be read is not an empty overlay: reporting both
        // as empty let a truncated database read as "no edits".
        return {
          nodes: [],
          edges: [],
          error: { code: 'INDEX_CORRUPT', message: `overlay ${file}: ${error?.message ?? error}` },
        };
      } finally {
        db?.close();
      }
    },
  };
}
