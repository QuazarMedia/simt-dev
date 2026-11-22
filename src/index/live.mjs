import { realpath } from 'node:fs/promises';

import { gitPaths } from '../sys/git.mjs';
import { cmp } from '../util/sort.mjs';
import { bindSymbols, symbolNodePaths } from './bind.mjs';
import { createImportResolver, extract, resolveImports } from './extract.mjs';
import { readCochange, readLiveSnapshot } from './graph-read.mjs';
import { buildOverlay, filterAllowed, readWorktreeFile, revisionOf } from './overlay.mjs';
import { treeDigest } from './persist.mjs';
import {
  BLOB_CAP, blobSizes, blobTexts, buildFieldedFtsBodies, buildFtsBodies,
  langOf, lsFiles, packageOf, readEmbeddings,
} from './store.mjs';

const ENV_NAME = /^\.env(?:\.|$)/u;
function safePath(path) {
  return path.split('/').every((part) => part && part !== '..' && part !== '.' && !ENV_NAME.test(part));
}

async function worktreeChanges(root) {
  const records = await gitPaths(root, ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames'], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const changes = new Map();
  for (const record of records) {
    const path = record.slice(3);
    const status = record.slice(0, 2);
    const deleted = status[1] === 'D' || status === 'D ';
    if (!deleted || !changes.has(path)) changes.set(path, { path, status: deleted ? 'deleted' : 'modified' });
  }
  return [...changes.values()];

}

function candidatePaths(changes, policy) {
  return filterAllowed(changes.filter(({ path }) => safePath(path)), policy).allowed;
}

/** For readers that only need to identify a live path, with no content reads. */
export async function livePaths(root, { policy } = {}) {
  const [listed, dirty] = await Promise.all([lsFiles(root), worktreeChanges(root)]);
  const paths = new Set(candidatePaths(listed, policy).map(({ path }) => path));
  for (const change of candidatePaths(dirty, policy)) {
    if (change.status === 'deleted') paths.delete(change.path);
    else paths.add(change.path);
  }
  return [...paths].sort(cmp);
}

function parseFile(root, path, body, file, options) {
  const pulled = extract(path, body, file.lang, { references: options.binding });
  const { imports, symbols, ...bindings } = pulled;
  return {
    file: { ...file, imports, ...bindings, resolution: 'builtin' },
    symbols,
    fts: options.text ? buildFtsBodies(path, symbols, body, root) : [],
    fielded: options.fielded ? buildFieldedFtsBodies(path, symbols, body, root) : [],
  };
}

function keyed(rows, field) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row[field];
    const prior = grouped.get(key);
    if (prior) prior.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

function edgeKey({ src, kind, dst }) {
  return JSON.stringify([src, kind, dst]);
}

/**
 * Reconcile cached staged blobs and dirty files without writing the index.
 * Callers on a latency-sensitive surface can refuse the transient cold build.
 */
export async function loadLiveGraph(root, options = {}) {
  const { build = true, text = false, fielded = false, nativeLexical = false, binding = false, embed = false, cochange = false, policy, retainTargets = [] } = options;
  const gitState = Promise.all([lsFiles(root), worktreeChanges(root)]);
  const snapshotState = nativeLexical ? gitState.then(([listed, dirty]) => readLiveSnapshot(root, {
    text, fielded: false, binding, tree: treeDigest(listed),
    bindingEdits: dirty.some(({ path }) => langOf(path, root) !== ''),
  })) : readLiveSnapshot(root, { text, fielded, binding });
  const [snapshot, [listed, changes], embeddings, changesets] = await Promise.all([
    snapshotState, gitState, embed ? readEmbeddings(root) : [], cochange ? readCochange(root) : [],
  ]);
  const result = { files: [], symbols: [], edges: [], fts: [], fieldedRows: [], embeddings: [] };
  if (snapshot.error || (!build && !snapshot.meta.build)) {
    return { ...result, cold: true, broken: Boolean(snapshot.error), indexError: snapshot.error ?? null };
  }

  const base = new Map(candidatePaths(snapshot.files, policy).map((file) => [file.path, file]));
  const eligible = candidatePaths(listed, policy);
  const staged = new Map(eligible.map((file) => [file.path, file]));
  const allowed = candidatePaths(changes, policy);
  const reads = new Map();
  let canonicalRoot;
  const overlay = await buildOverlay({
    changes: allowed,
    read: async (path) => {
      canonicalRoot ??= await realpath(root);
      const bytes = await readWorktreeFile(canonicalRoot, path, BLOB_CAP);
      if (bytes === null) return null;
      const body = bytes.toString('utf8');
      reads.set(path, body);
      return body;
    },
  });
  const tombstones = new Set(overlay.tombstones.map(({ path }) => path));
  const overlayNodes = new Map(overlay.nodes.map((node) => [node.source, node]));
  const problems = new Set(overlay.unreadable);
  const paths = new Set([...staged.keys(), ...overlayNodes.keys()]);
  for (const path of tombstones) paths.delete(path);
  const mismatched = treeDigest(listed) !== snapshot.meta.tree;
  const stagedChanges = eligible.filter((file) => !tombstones.has(file.path) && !reads.has(file.path) && !problems.has(file.path)
    && (file.blob !== base.get(file.path)?.blob || (fielded && snapshot.meta.fts_fields !== '1')));
  const allowedBlobs = build ? stagedChanges.filter(({ path, mode }) => mode.startsWith('100') && (text || fielded || langOf(path, root))) : [];
  const sizes = await blobSizes(root, allowedBlobs.map(({ blob }) => blob));
  const blobBodies = await blobTexts(root, allowedBlobs.filter(({ blob }) => sizes.get(blob) <= BLOB_CAP).map(({ blob }) => blob));
  const symbolRows = keyed(snapshot.symbols, 'path');
  const legacyRows = keyed(snapshot.fts, 'ref');
  const fieldRows = keyed(snapshot.fieldedRows, 'ref');
  const cachedEdges = keyed(snapshot.edges, 'src');
  const packageCache = new Map();
  const changedPathSet = paths.size !== base.size || [...paths].some((path) => !base.has(path));
  const resolvePaths = new Set([...paths, ...retainTargets]);
  const resolveImport = createImportResolver(resolvePaths);
  const dirtyCode = [...overlayNodes.keys(), ...problems, ...stagedChanges
    .filter(({ path, blob }) => blob !== base.get(path)?.blob).map(({ path }) => path)]
    .some((path) => base.get(path)?.lang || langOf(path, root));
  const rebind = binding && (dirtyCode || (changedPathSet && !nativeLexical) || !snapshot.binding?.bindingCoverage);
  const canRebind = rebind && (dirtyCode || !nativeLexical || mismatched);
  const evidence = [];
  for (const path of [...paths].sort(cmp)) {
    const old = base.get(path);
    const entry = staged.get(path);
    const node = overlayNodes.get(path);
    const body = reads.get(path) ?? blobBodies.get(entry?.blob);
    const stagedSame = entry && entry.blob === old?.blob;
    const lang = old?.lang || langOf(path, root);
    const missingRead = problems.has(path) || (!stagedSame && !node && body === undefined && lang && entry?.mode !== '120000');
    if (missingRead) problems.add(path);
    const file = {
      path, lang, blob: node ? null : entry?.blob ?? null,
      bytes: body === undefined ? old?.bytes ?? sizes.get(entry?.blob) ?? 0 : Buffer.byteLength(body),
      pkg: old?.pkg ?? await packageOf(root, path, packageCache),
      provenance: node ? 'worktree' : 'committed',
      revision: node?.revision ?? (entry ? revisionOf('staged', entry.blob) : null),
    };
    const kept = stagedSame && entry.mode.startsWith('100') && !node && !missingRead;
    const regenerated = body !== undefined && !kept ? parseFile(root, path, body, file, { text, fielded, binding }) : null;
    const cachedSymbols = symbolRows.get(path) ?? [];
    const selected = regenerated ?? (kept ? {
      file: old, symbols: cachedSymbols, fts: legacyRows.get(path) ?? [],
      fielded: fielded && body !== undefined ? buildFieldedFtsBodies(path, cachedSymbols, body, root) : fieldRows.get(path) ?? [],
    } : null);
    result.files.push(file);
    if (!selected) continue;
    result.symbols.push(...selected.symbols);
    result.fts.push(...selected.fts);
    result.fieldedRows.push(...selected.fielded);
    if (canRebind) {
      const { bindings, ...source } = selected.file;
      evidence.push(bindings ? { ...source, ...JSON.parse(bindings) } : source);
    }
    const useCached = !regenerated && (!changedPathSet && retainTargets.length === 0 || selected.file.resolution === 'adapter');
    const edges = useCached ? cachedEdges.get(path) ?? [] : resolveImports(path, selected.file.imports ?? [], resolvePaths, lang, resolveImport);
    result.edges.push(...edges.map((edge) => ({ ...edge, provenance: node ? 'worktree' : 'committed' })));
  }
  if (embed) result.embeddings = embeddings.filter(({ path }) => paths.has(path) && !reads.has(path)
    && !problems.has(path) && staged.get(path)?.blob === base.get(path)?.blob);
  let symbolGraph = snapshot.binding;
  if (canRebind) {
    const { ownerRows, bindingCoverage, unresolved } = bindSymbols(evidence, result.symbols);
    const fromCache = new Map((snapshot.binding?.edges ?? []).map((edge) => [edgeKey(edge), edge]));
    const edges = [...ownerRows].flatMap(([path, owner]) => owner.edges.map((edge) => {
      const old = fromCache.get(edgeKey(edge));
      const live = reads.has(path) || !old || old.viaBarrels.join('\0') !== edge.viaBarrels.join('\0')
        || old.lines.join('\0') !== edge.lines.join('\0');
      return { path, ...edge, provenance: live ? 'worktree' : 'committed' };
    }));
    symbolGraph = { edges, bindingCoverage, unresolved };
  } else if (symbolGraph) {
    const nodes = base.size === snapshot.files.length && !changedPathSet ? null : symbolNodePaths(paths, symbolGraph.edges);
    symbolGraph.edges = symbolGraph.edges.filter(({ src, dst }) => !nodes || (nodes.has(src) && nodes.has(dst)))
      .map((row) => ({ ...row, provenance: 'committed' }));
    symbolGraph.unresolved = symbolGraph.unresolved.filter(({ path }) => paths.has(path));
  }
  const stale = problems.size > 0 || (!build && mismatched);
  return {
    ...result, symbolGraph, stale,
    cochange: changesets.filter(({ src, dst }) => paths.has(src) && paths.has(dst)),
    nativeLexical: nativeLexical && snapshot.meta.fts_fields === '1',
    freshness: { state: stale ? 'stale' : 'current', base: snapshot.meta.build ? mismatched ? 'stale' : 'current' : 'cold' },
    basis: {
      index: { build: snapshot.meta.build ?? null, tree: snapshot.meta.tree ?? null },
      overlay: { applied: overlay.nodes.length > 0 || tombstones.size > 0, revision: overlay.revision,
        readPaths: overlay.readPaths, unreadable: [...problems].sort(cmp) },
    },
  };
}
