import { realpath } from 'node:fs/promises';

import { gitPaths } from '../sys/git.mjs';
import { cmp } from '../util/sort.mjs';
import { bindSymbols, BINDING_VERSION, symbolNodePaths } from './bind.mjs';
import { createImportResolver, extract, resolveImports } from './extract.mjs';
import { readCochange, readLiveSnapshot, readNarrowBindings } from './graph-read.mjs';
import { buildOverlay, filterAllowed, readWorktreeFile, revisionOf } from './overlay.mjs';
import { gitIndexStamp, treeDigest } from './persist.mjs';
import {
  BLOB_CAP, blobSizes, blobTexts, buildFieldedFtsBodies, buildFtsBodies,
  langOf, lsFiles, packageOf, readEmbeddings,
} from './store.mjs';

const ENV_NAME = /^\.env(?:\.|$)/u;
const FAST_UNSAFE = /(?:^|\/)(?:\.|\.\.|\.env(?:\.[^/]*)?)(?:\/|$)/u;
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

export function candidatePaths(changes, policy) {
  return filterAllowed(changes.filter(({ path }) => safePath(path) && (policy?.allows?.(path) ?? true)), policy).allowed;
}

export function readWorktreeState(root) {
  return Promise.all([lsFiles(root), worktreeChanges(root)]);
}

/** For readers that only need to identify a live path, with no content reads. */
export async function livePaths(root, { policy } = {}) {
  const [listed, dirty] = await readWorktreeState(root);
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
  const { build = true, text = false, fielded = false, nativeLexical = false, binding = false,
    embed = false, cochange = false, policy, retainTargets = [], rangePaths = [],
    checkScope = false } = options;
  const useStampFast = Boolean(nativeLexical && !options.gitState);
  let snapshot;
  let listed = null;
  let changes;
  let embeddings;
  let changesets;
  let stampMatched = false;

  // A stamp git wrote within the last second can be a torn read, so it cannot vouch for the
  // tree; the snapshot's tree comparison then needs a real digest, and binding undefined
  // crashes node:sqlite. Unsafe (or absent) stamps take the slow path that computes one.
  const stamp = useStampFast ? await gitIndexStamp(root) : null;
  const fastStamp = stamp?.safe ? stamp.stamp : null;

  if (fastStamp !== null) {
    [snapshot, changes, embeddings, changesets] = await Promise.all([
      readLiveSnapshot(root, {
        text, fielded: false, binding, indexStat: fastStamp,
        bindingEdits: false, lightweight: true, rangePaths,
      }),
      worktreeChanges(root),
      embed ? readEmbeddings(root) : [],
      cochange ? readCochange(root) : [],
    ]);
    stampMatched = Boolean(fastStamp && !snapshot.error && snapshot.meta.build && snapshot.meta.git_index_stat === fastStamp);
  } else {
    const gitState = options.gitState ?? readWorktreeState(root);
    const snapshotState = binding || nativeLexical ? Promise.resolve(gitState).then(([l, dirty]) => {
      const dirtyCodeList = dirty.filter(({ path, status }) => status !== 'deleted' && langOf(path, root) !== '').map(({ path }) => path);
      const hasDeletedCode = dirty.some(({ path, status }) => status === 'deleted' && langOf(path, root) !== '');
      return readLiveSnapshot(root, {
        text, fielded: fielded && !nativeLexical, binding, tree: treeDigest(l),
        bindingEdits: dirtyCodeList.length > 0 || hasDeletedCode,
        dirtyPaths: hasDeletedCode ? [] : dirtyCodeList,
        lightweight: nativeLexical, rangePaths,
      });
    }) : readLiveSnapshot(root, { text, fielded });
    let gitPair;
    [snapshot, gitPair, embeddings, changesets] = await Promise.all([
      snapshotState, gitState, embed ? readEmbeddings(root) : [], cochange ? readCochange(root) : [],
    ]);
    [listed, changes] = gitPair;
  }

  const result = { files: [], symbols: [], edges: [], fts: [], fieldedRows: [], embeddings: [] };
  if (snapshot.error || (!build && !snapshot.meta.build)) {
    return { ...result, cold: true, broken: Boolean(snapshot.error), indexError: snapshot.error ?? null };
  }

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

  if (
    stampMatched && !text && !policy && retainTargets.length === 0 && rangePaths.length === 0 && !checkScope
    && tombstones.size === 0 && problems.size === 0 && overlayNodes.size <= 16
    && (!fielded || snapshot.meta.fts_fields === '1')
    && (!binding || snapshot.binding?.version === BINDING_VERSION)
  ) {
    let hasUnsafe = false;
    const matchedDirty = new Map();
    for (const row of snapshot.files) {
      if (FAST_UNSAFE.test(row.path)) { hasUnsafe = true; break; }
      if (overlayNodes.has(row.path)) matchedDirty.set(row.path, row);
    }
    const addedPaths = [...overlayNodes.keys()].filter((path) => !matchedDirty.has(path));
    const addedCode = addedPaths.some((path) => langOf(path, root) !== '');
    if (!hasUnsafe && !addedCode) {
      const packageCache = new Map();
      const parsedDirty = new Map();
      const dirtyCodePaths = [];
      for (const [path, node] of overlayNodes) {
        const old = matchedDirty.get(path);
        const body = reads.get(path);
        const lang = old?.lang || langOf(path, root);
        const file = {
          path, lang, blob: null, bytes: Buffer.byteLength(body),
          pkg: old?.pkg ?? await packageOf(root, path, packageCache),
          provenance: 'worktree', revision: node.revision,
        };
        const parsed = parseFile(root, path, body, file, { text: false, fielded, binding });
        parsedDirty.set(path, { file, parsed });
        if (lang) dirtyCodePaths.push(path);
      }

      const files = new Array(snapshot.files.length);
      for (let i = 0; i < snapshot.files.length; i += 1) {
        const row = snapshot.files[i];
        const dirtyEntry = parsedDirty.get(row.path);
        files[i] = dirtyEntry ? dirtyEntry.file : {
          path: row.path, lang: row.lang, blob: row.blob, bytes: row.bytes, pkg: row.pkg,
          provenance: 'committed', revision: `staged:${row.blob}`,
        };
      }
      if (addedPaths.length > 0) {
        for (const path of addedPaths) {
          const entry = parsedDirty.get(path).file;
          let lo = 0;
          let hi = files.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (cmp(files[mid].path, path) < 0) lo = mid + 1;
            else hi = mid;
          }
          files.splice(lo, 0, entry);
        }
      }

      let symbols = snapshot.symbols;
      let edges = snapshot.edges;
      const fieldedRows = [];
      if (parsedDirty.size > 0) {
        symbols = snapshot.symbols.filter(({ path }) => !parsedDirty.has(path));
        for (const { parsed } of parsedDirty.values()) {
          if (parsed.symbols.length) symbols.push(...parsed.symbols);
          if (parsed.fielded.length) fieldedRows.push(...parsed.fielded);
        }
        if (dirtyCodePaths.length > 0) {
          const pathSet = new Set(files.map(({ path }) => path));
          const resolveImport = createImportResolver(pathSet);
          edges = snapshot.edges.filter(({ src }) => !parsedDirty.has(src));
          for (const path of dirtyCodePaths) {
            const { file, parsed } = parsedDirty.get(path);
            for (const edge of resolveImports(path, parsed.file.imports ?? [], pathSet, file.lang, resolveImport)) {
              edges.push({ ...edge, provenance: 'worktree' });
            }
          }
        }
      }

      let symbolGraph = snapshot.binding;
      if (binding && dirtyCodePaths.length > 0 && symbolGraph) {
        const narrowScope = new Set(dirtyCodePaths);
        for (const { src, dst, kind } of snapshot.edges) {
          if (kind && kind !== 'import') continue;
          if (narrowScope.has(dst)) narrowScope.add(src);
          else if (narrowScope.has(src)) narrowScope.add(dst);
        }
        const needFromDb = [...narrowScope].filter((path) => !parsedDirty.has(path));
        const byPath = new Map();
        if (needFromDb.length > 0) {
          const needSet = new Set(needFromDb);
          for (const row of files) {
            if (needSet.has(row.path)) {
              byPath.set(row.path, row);
              if (byPath.size === needSet.size) break;
            }
          }
        }
        // For small narrow scopes (<= 8 untouched neighbours), parsing the local
        // files directly avoids spawning an extra sqlite3 process (~14 ms).
        let dbBindings = null;
        const parsedNeighbours = new Map();
        if (needFromDb.length > 0 && needFromDb.length <= 8) {
          try {
            const bodies = await Promise.all(needFromDb.map((path) => readFile(join(root, path), 'utf8')));
            for (let i = 0; i < needFromDb.length; i += 1) {
              const path = needFromDb[i];
              const row = byPath.get(path);
              if (!row) continue;
              parsedNeighbours.set(path, parseFile(root, path, bodies[i], row, { text: false, fielded: false, binding: true }).file);
            }
          } catch {
            parsedNeighbours.clear();
          }
        }
        if (needFromDb.length > 0 && parsedNeighbours.size < needFromDb.length) {
          dbBindings = await readNarrowBindings(root, needFromDb);
        }
        const evidence = [];
        for (const path of narrowScope) {
          const dirtyEntry = parsedDirty.get(path);
          if (dirtyEntry) {
            evidence.push(dirtyEntry.parsed.file);
          } else if (parsedNeighbours.has(path)) {
            evidence.push(parsedNeighbours.get(path));
          } else {
            const extra = dbBindings?.get(path);
            const row = byPath.get(path);
            if (row && extra) evidence.push({ ...row, ...extra });
          }
        }
        const scopeSymbols = symbols.filter(({ path }) => narrowScope.has(path));
        const { ownerRows } = bindSymbols(evidence, scopeSymbols);
        const keptEdges = symbolGraph.edges.filter(({ path }) => !narrowScope.has(path));
        const updatedEdges = [...ownerRows].flatMap(([path, owner]) =>
          owner.edges.map((edge) => ({ path, ...edge, provenance: reads.has(path) ? 'worktree' : 'committed' })));
        symbolGraph = { ...symbolGraph, edges: [...keptEdges, ...updatedEdges] };
      }

      return {
        files, symbols, edges, fts: [], fieldedRows,
        embeddings: embed ? embeddings.filter(({ path }) => !reads.has(path)) : [],
        symbolGraph, stale: false, ranges: new Map(),
        cochange: changesets,
        nativeLexical: nativeLexical && snapshot.meta.fts_fields === '1',
        freshness: { state: 'current', base: 'current' },
        basis: {
          index: { build: snapshot.meta.build ?? null, tree: snapshot.meta.tree ?? null },
          overlay: {
            applied: overlay.nodes.length > 0, revision: overlay.revision,
            readPaths: overlay.readPaths, unreadable: [],
          },
        },
      };
    }
  }

  if (listed === null) {
    listed = await lsFiles(root);
    const dirtyCodeList = changes.filter(({ path, status }) => status !== 'deleted' && langOf(path, root) !== '').map(({ path }) => path);
    const hasDeletedCode = changes.some(({ path, status }) => status === 'deleted' && langOf(path, root) !== '');
    if (binding && (dirtyCodeList.length > 0 || hasDeletedCode || treeDigest(listed) !== snapshot.meta.tree)) {
      snapshot = await readLiveSnapshot(root, {
        text, fielded: false, binding, tree: treeDigest(listed),
        bindingEdits: dirtyCodeList.length > 0 || hasDeletedCode,
        dirtyPaths: hasDeletedCode ? [] : dirtyCodeList,
        lightweight: true, rangePaths,
      });
    }
  }

  const base = new Map(candidatePaths(snapshot.files, policy).map((file) => [file.path, file]));
  const eligible = candidatePaths(listed, policy);
  const staged = new Map(eligible.map((file) => [file.path, file]));
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
  const dirtyCodePaths = [...new Set([...overlayNodes.keys(), ...problems, ...stagedChanges
    .filter(({ path, blob }) => blob !== base.get(path)?.blob).map(({ path }) => path)])]
    .filter((path) => base.get(path)?.lang || langOf(path, root));
  const dirtyCode = dirtyCodePaths.length > 0;
  const narrowRebind = Boolean(
    binding && nativeLexical && dirtyCode && !changedPathSet && !mismatched
    && problems.size === 0 && dirtyCodePaths.length <= 16
    && snapshot.binding?.version === BINDING_VERSION,
  );
  let narrowScope = null;
  if (narrowRebind) {
    narrowScope = new Set(dirtyCodePaths);
    for (const { src, dst, kind } of snapshot.edges) {
      if (kind && kind !== 'import') continue;
      if (narrowScope.has(dst)) narrowScope.add(src);
      else if (narrowScope.has(src)) narrowScope.add(dst);
    }
  }
  const canRebind = binding && !narrowRebind && (dirtyCode || (changedPathSet && !nativeLexical) || snapshot.binding?.version !== BINDING_VERSION);
  const evidence = [];
  const wantedRanges = new Set(rangePaths);
  const ranges = new Map();
  for (const path of [...paths].sort(cmp)) {
    const old = base.get(path);
    const entry = staged.get(path);
    const node = overlayNodes.get(path);
    const stagedBody = blobBodies.get(entry?.blob);
    const body = reads.get(path) ?? stagedBody ?? undefined;
    const stagedSame = entry && entry.blob === old?.blob;
    const lang = old?.lang || langOf(path, root);
    const missingRead = problems.has(path) || (!stagedSame && !node && stagedBody === undefined && lang && entry?.mode !== '120000');
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
    if (canRebind || (narrowRebind && narrowScope.has(path)) || wantedRanges.has(path)) {
      const { bindings, imports, ...source } = selected.file;
      const parsed = {
        ...source,
        imports: typeof imports === 'string' ? JSON.parse(imports) : imports ?? [],
        ...(bindings ? JSON.parse(bindings) : {}),
      };
      if (canRebind || (narrowRebind && narrowScope.has(path))) evidence.push(parsed);
      if (wantedRanges.has(path)) ranges.set(path, parsed.chunk?.scopes ?? []);
    }
    const useCached = !regenerated && (!changedPathSet && retainTargets.length === 0 || selected.file.resolution === 'adapter');
    const rawImports = selected.file.imports;
    const edges = useCached ? cachedEdges.get(path) ?? [] : resolveImports(path, typeof rawImports === 'string' ? JSON.parse(rawImports) : rawImports ?? [], resolvePaths, lang, resolveImport);
    result.edges.push(...edges.map((edge) => ({ ...edge, provenance: node ? 'worktree' : 'committed' })));
  }
  if (embed) result.embeddings = embeddings.filter(({ path }) => paths.has(path) && !reads.has(path)
    && !problems.has(path) && staged.get(path)?.blob === base.get(path)?.blob);
  let symbolGraph = snapshot.binding;
  if (canRebind) {
    const { ownerRows, bindingCoverage, unresolved, starExports } = bindSymbols(evidence, result.symbols);
    const fromCache = new Map((snapshot.binding?.edges ?? []).map((edge) => [edgeKey(edge), edge]));
    const edges = [...ownerRows].flatMap(([path, owner]) => owner.edges.map((edge) => {
      const old = fromCache.get(edgeKey(edge));
      const live = reads.has(path) || !old || old.viaBarrels.join('\0') !== edge.viaBarrels.join('\0')
        || old.lines.join('\0') !== edge.lines.join('\0');
      return { path, ...edge, provenance: live ? 'worktree' : 'committed' };
    }));
    symbolGraph = { edges, bindingCoverage, unresolved, starExports, version: BINDING_VERSION };
  } else if (narrowRebind && symbolGraph) {
    const scopeSymbols = result.symbols.filter(({ path }) => narrowScope.has(path));
    const { ownerRows } = bindSymbols(evidence, scopeSymbols);
    const keptEdges = symbolGraph.edges
      .filter(({ path }) => !narrowScope.has(path))
      .map((row) => ({ ...row, provenance: 'committed' }));
    const updatedEdges = [...ownerRows].flatMap(([path, owner]) =>
      owner.edges.map((edge) => ({ path, ...edge, provenance: reads.has(path) ? 'worktree' : 'committed' })));
    symbolGraph = { ...symbolGraph, edges: [...keptEdges, ...updatedEdges] };
  } else if (symbolGraph) {
    const nodes = base.size === snapshot.files.length && !changedPathSet ? null : symbolNodePaths(paths, symbolGraph.edges);
    symbolGraph.edges = symbolGraph.edges.filter(({ src, dst }) => !nodes || (nodes.has(src) && nodes.has(dst)))
      .map((row) => ({ ...row, provenance: 'committed' }));
    symbolGraph.unresolved = symbolGraph.unresolved.filter(({ path }) => paths.has(path));
    symbolGraph.starExports = symbolGraph.starExports.filter((path) => paths.has(path));
  }
  const stale = problems.size > 0 || (!build && mismatched);
  return {
    ...result, symbolGraph, stale, ranges,
    ...(checkScope ? { previousEdges: snapshot.edges } : {}),
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
