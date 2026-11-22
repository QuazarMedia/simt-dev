import { realpath } from 'node:fs/promises';

import { CLI } from '../name.mjs';
import { readChanges } from '../sys/changes.mjs';
import { git } from '../sys/git.mjs';
import { langOf } from '../index/store.mjs';
import { importEdges } from '../index/gate.mjs';
import { isContractPath } from '../index/impact.mjs';
import { isTestPath } from '../testing/paths.mjs';
import { resolveScope } from '../work/artifacts.mjs';
import { mayIndex } from '../work/trust.mjs';
import { readProcedure } from '../verify/procedures.mjs';
import { buildClaimGraph, EDGE_KINDS } from './claims.mjs';
import { collectCorpus, readLocalBytes } from './collect.mjs';
import { ALWAYS_DENIED } from './corpus.mjs';
import { readReceipt, regenerationCandidates, toolRef } from './derivations.mjs';
import { impactReport } from './impact.mjs';
import { KNOWLEDGE_DIR } from './inputs.mjs';
import { resolveRefs } from './lineage.mjs';
import { digestOf } from './observations.mjs';
import { corpusDocument } from './query.mjs';

const RECEIPTS = `${KNOWLEDGE_DIR}/derivations.json`;
const failure = (path, reason) => ({ ref: path, reason });

function safeLocalPath(path) {
  return typeof path === 'string' && !path.includes('\\') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..' && !/^(?:\.env(?:\.|$)|\.ssh$|\.gnupg$)/u.test(part));
}

function addAnchor(anchors, path, anchor) {
  if (!anchors.has(path)) anchors.set(path, new Set());
  anchors.get(path).add(anchor);
}

async function readDerivations({ root, tracked, aliases, changed, permitted, unknown }) {
  const listed = await git(root, ['ls-files', '-z', '--', RECEIPTS]);
  const raw = listed === '' ? null : await readLocalBytes(root, RECEIPTS);
  let document = {};
  if (listed !== '') {
    try {
      document = JSON.parse(raw?.toString('utf8') ?? '');
      if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error();
    } catch {
      unknown.push(failure(RECEIPTS, 'unreadable-derivation-receipts'));
      return null;
    }
  }
  const receipts = [];
  const changes = new Map();
  const observed = [];
  for (const path of changed) {
    const digest = aliases.has(path) ? undefined : tracked.get(path)?.digest;
    changes.set(path, { ref: path, digest });
  }
  for (const entry of Array.isArray(document.receipts) ? document.receipts : []) {
    const { receipt } = readReceipt(entry);
    if (!receipt) {
      unknown.push(failure(RECEIPTS, 'invalid-derivation-receipt'));
      continue;
    }
    const output = receipt.output.path;
    if (!permitted(output)) continue;
    if ([...receipt.inputs.map(({ ref }) => ref), ...receipt.tools.map(({ id }) => id)]
      .some((path) => !permitted(path))) {
      unknown.push(failure(output, 'receipt-dependency-outside-scope'));
      continue;
    }
    receipts.push(receipt);
    const bytes = tracked.has(output) ? await readLocalBytes(root, output) : null;
    if (bytes !== null) observed.push({ path: output, digest: digestOf(bytes.toString('utf8')) });
    for (const tool of receipt.tools) {
      if (changes.has(tool.id)) changes.set(toolRef(tool), { ...changes.get(tool.id), ref: toolRef(tool) });
    }
  }
  const outputs = [...new Set([
    ...(Array.isArray(document.outputs) ? document.outputs.filter(permitted) : []),
    ...[...tracked.values()].filter((entry) => entry.state === 'generated').map((entry) => entry.path),
  ])];
  return { receipts, outputs, changes: [...changes.values()], observed };
}

async function localEdges({ root, candidates, paths, aliases, scopeAllows, unknown, codeGraph }) {
  const entries = [];
  const procedures = [];
  const nodes = [];
  const codeKinds = new Map();
  for (const row of candidates) {
    const path = row.path;
    if (!row.tracked || row.symlink || !scopeAllows(path)) continue;
    const lang = langOf(path, root);
    const contract = isContractPath(path);
    const artifact = paths.get(path);
    if (lang === '' && !contract && artifact?.type !== 'procedure') continue;
    const bytes = await readLocalBytes(root, path);
    if (bytes === null) continue;
    const text = bytes.toString('utf8');
    if (contract || (lang !== '' && lang !== 'markdown')) {
      if (!codeGraph && lang) entries.push({ path, text, lang });
      codeKinds.set(path, contract ? 'source' : isTestPath(path, root) ? 'test' : 'helper');
      if (!artifact) {
        const node = { id: path, path, kind: codeKinds.get(path) };
        nodes.push(node);
        paths.set(path, node);
      }
    }
    const record = readProcedure(text, { path });
    if (record.id !== null) procedures.push(record);
  }
  const byProcedure = new Map();
  for (const record of procedures) {
    if (byProcedure.has(record.id)) {
      byProcedure.set(record.id, null);
      unknown.push(failure(record.path, 'duplicate-procedure-id'));
    } else byProcedure.set(record.id, paths.get(record.path)?.id);
  }
  // Import resolution also emits external dependency names. The scoped graph only has local nodes.
  const imports = codeGraph ? codeGraph.edges.filter(({ kind }) => kind === 'import') : importEdges(entries);
  const edges = imports.flatMap(({ src, dst }) => {
    const source = paths.get(src);
    const target = paths.get(dst);
    return source && target ? [{ from: source.id, to: target.id, basis: 'code-import' }] : [];
  });
  for (const record of procedures) {
    for (const called of record.calls) {
      const to = byProcedure.get(called);
      if (to) edges.push({ from: paths.get(record.path).id, to, basis: 'procedure-call' });
      else unknown.push(failure(record.path, 'unresolved-procedure-call'));
    }
    for (const imported of record.imports) {
      const to = paths.get(aliases.get(imported) ?? imported)?.id;
      if (to) edges.push({ from: paths.get(record.path).id, to, basis: 'procedure-import' });
      else unknown.push(failure(record.path, 'unresolved-procedure-import'));
    }
  }
  return { nodes, edges, codeKinds };
}

export async function scopedImpact({ root, work, scope, limit, diff, codeGraph = null, external = [] }) {
  diff ??= await readChanges(root);
  const deniedPaths = [...ALWAYS_DENIED, ...work.scopes.flatMap(({ tracker }) => tracker?.visibility === 'private' ? [tracker.path] : [])];
  const scopeAllows = (path) => {
    if (!safeLocalPath(path)) return false;
    const owner = resolveScope(work.scopes, path);
    return owner.scope === scope.id && owner.ignored !== true && mayIndex({ path, deniedPaths }).indexed;
  };
  const externalPaths = new Set(external.filter((path) => safeLocalPath(path) && mayIndex({ path, deniedPaths }).indexed
    && resolveScope(work.scopes, path).error?.kind === 'none'));
  const scopedChanges = diff.files.filter(scopeAllows);
  const aliases = new Map(diff.renames.filter(({ from, to }) => scopeAllows(from) && scopeAllows(to)).map(({ from, to }) => [from, to]));
  const empty = () => ({ scope: scope.id, status: 'nothing-changed', files: [], renames: [], excludedCount: diff.files.length,
    ...impactReport({ graph: { nodes: [], edges: [] } }) });
  if (!scopedChanges.length && !externalPaths.size) {
    return empty();
  }
  const loaded = await collectCorpus({ root, work, scope });
  if (loaded.error) return loaded;
  const { corpus, candidates, truncated } = loaded;
  const physicalRoot = await realpath(root);
  const unknown = corpus.problems.filter((entry) => !['proposed-link', 'unresolved-source', 'uncertain-anchor'].includes(entry.code))
    .map((entry) => failure(entry.path, entry.code));
  const permittedCorpus = { ...corpus, artifacts: corpus.artifacts.filter((artifact) => scopeAllows(artifact.path)) };
  const doc = corpusDocument(permittedCorpus);
  const paths = new Map(permittedCorpus.artifacts.map((artifact) => [artifact.path, artifact]));
  const externalNodes = [...externalPaths].map((path) => ({ id: path, path, kind: 'source' }));
  for (const node of externalNodes) paths.set(node.path, node);
  const local = await localEdges({ root: physicalRoot, candidates, paths, aliases, scopeAllows, unknown, codeGraph });
  const anchors = new Map();
  for (const { path, anchor } of corpus.units) addAnchor(anchors, path, anchor);
  for (const { path, name } of codeGraph?.symbols ?? []) addAnchor(anchors, path, name);
  const subjects = new Set(paths.keys());
  const documentedIds = new Set([...doc.artifacts, ...doc.claims].map(({ id }) => id));
  const linkedExternal = new Set();
  const edges = [];
  for (const artifact of permittedCorpus.artifacts) {
    const { sources, problems } = resolveRefs(artifact.sources.map((ref) => ({ ...ref, path: aliases.get(ref.path) ?? ref.path })), {
      paths: subjects, anchorsOf: (path) => anchors.get(path) ?? new Set(),
    });
    unknown.push(...problems.filter(({ code }) => code !== 'proposed-link').map(({ path, code }) => failure(path, code)));
    for (const ref of sources) {
      const { path } = ref;
      const target = paths.get(path);
      if (!target || !ref.anchorFound) continue;
      if (externalPaths.has(path)) linkedExternal.add(path);
      edges.push({
        from: artifact.id, to: target.id, basis: 'document-citation',
        kind: EDGE_KINDS.includes(ref.type) ? ref.type : 'derived-from',
        status: ref.proposed || artifact.authority !== 'reviewed' ? 'proposed' : 'reviewed',
      });
    }
    for (const claim of artifact.claims) {
      edges.push({ from: artifact.id, to: claim.id, basis: 'claim-source', kind: 'supports', status: claim.status });
      for (const ref of claim.evidence) {
        const [named, fragment] = subjects.has(ref) ? [ref] : ref.split('#', 2);
        const path = aliases.get(named) ?? named;
        const target = paths.get(path);
        if (!target || (target.id === ref && documentedIds.has(ref)) || (fragment && !anchors.get(path)?.has(fragment))) continue;
        if (externalPaths.has(path)) linkedExternal.add(path);
        edges.push({ from: claim.id, to: target.id, basis: 'claim-source', kind: 'derived-from', status: claim.status });
      }
    }
  }
  edges.push(...local.edges.map((edge) => ({ ...edge, kind: 'imports-context', status: 'reviewed' })));
  const graph = buildClaimGraph({
    ...doc,
    artifacts: [...doc.artifacts.map((node) => ({
      ...node,
      kind: node.kind === 'procedure' ? 'recipe'
        : local.codeKinds.get(node.path) ?? (node.kind === 'requirement' ? 'document' : node.kind),
    })), ...local.nodes, ...externalNodes],
    edges: [...doc.edges.filter((edge) => doc.claims.some((claim) => claim.id === edge.from)), ...edges],
  });
  const tracked = new Map(corpus.inventory.filter((entry) => !['untracked', 'ignored', 'symlink', 'denied'].includes(entry.state)).map((entry) => [entry.path, entry]));
  for (const path of externalPaths) {
    const bytes = await readLocalBytes(physicalRoot, path);
    if (bytes !== null) tracked.set(path, { path, state: 'tracked', digest: digestOf(bytes.toString('utf8')) });
  }
  const derivations = await readDerivations({ root: physicalRoot, tracked, aliases, changed: [...scopedChanges, ...externalPaths],
    permitted: (path) => scopeAllows(path) || externalPaths.has(path), unknown });
  for (const receipt of derivations?.receipts ?? []) {
    for (const path of [...receipt.inputs.map(({ ref }) => ref), ...receipt.tools.map(({ id }) => id)]) {
      if (externalPaths.has(path)) linkedExternal.add(path);
    }
  }
  const changed = diff.files.filter((path) => scopeAllows(path) || linkedExternal.has(path));
  if (!changed.length) return empty();
  const refs = [...new Set(changed.map((path) => paths.get(aliases.get(path) ?? path)?.id ?? path))];
  const report = impactReport({ graph, change: { refs }, derivations, limits: { nodes: Number(limit ?? undefined) } });
  const derivationReport = derivations === null ? null : regenerationCandidates(derivations);
  const pathsById = new Map([...paths.values()].map(({ id, path }) => [id, path]));
  const affectedPaths = [...new Set(Object.values(report.affected).flat().map((id) => pathsById.get(id) ?? (tracked.has(id) ? id : null)).filter(Boolean))].sort();
  report.unknown.push(...unknown, ...graph.problems.map(() => failure(scope.id, 'invalid-dependency-edge')));
  if (truncated) report.unknown.push(failure(scope.id, 'inventory-bound'));
  report.unknown.sort((a, b) => a.ref.localeCompare(b.ref) || a.reason.localeCompare(b.reason));
  report.complete = report.complete && report.unknown.length === 0;
  report.conservative = !report.complete;
  return {
    ...report, scope: scope.id, files: changed, affectedPaths, renames: [...aliases].map(([from, to]) => ({ from, to })),
    excludedCount: diff.files.length - changed.length,
    dependencies: edges.filter((edge) =>
      refs.includes(edge.from) || refs.includes(edge.to) ||
      Object.values(report.affected).some((bucket) => bucket.includes(edge.from)) ||
      report.proposed.includes(edge.from)),
    reviewHelpers: edges.filter((edge) => edge.basis === 'procedure-import' && refs.includes(edge.from))
      .map((edge) => edge.to).sort(),
    regeneration: derivationReport === null ? null : {
      stale: derivationReport.candidates.map((entry) => ({
        ...entry, generator: derivations.receipts.find((receipt) => receipt.id === entry.receipt)?.generator ?? null,
      })),
      conflicts: derivationReport.conflicts, executed: false,
    },
    remedy: report.complete ? null : `review the missing references and run ${CLI} knowledge impact --changed --scope ${scope.id} again`,
  };
}
