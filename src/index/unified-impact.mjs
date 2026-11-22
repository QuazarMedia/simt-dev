import { realpath } from 'node:fs/promises';

import { readLocalBytes } from '../knowledge/collect.mjs';
import { ALWAYS_DENIED } from '../knowledge/corpus.mjs';
import { readReceipt, regenerationCandidates, toolRef } from '../knowledge/derivations.mjs';
import { impactReport } from '../knowledge/impact.mjs';
import { KNOWLEDGE_DIR } from '../knowledge/inputs.mjs';
import { scopedImpact } from '../knowledge/local-impact.mjs';
import { readChanges } from '../sys/changes.mjs';
import { gitPaths } from '../sys/git.mjs';
import { selectLocalVerification } from '../verify/local-selection.mjs';
import { resolveScope } from '../work/artifacts.mjs';
import { readWork } from '../work/effective.mjs';
import { mayIndex } from '../work/trust.mjs';
import { impactTopology, isContractPath, traceImpact } from './impact.mjs';
import { loadLiveGraph } from './live.mjs';
import { langOf } from './store.mjs';

const GRAPH_INPUT = `${KNOWLEDGE_DIR}/impact.json`;
const DERIVATIONS_INPUT = `${KNOWLEDGE_DIR}/derivations.json`;

function pathChanges(files, diff) {
  const set = new Set(files);
  return {
    files: [...set].sort(),
    deleted: (diff?.deleted ?? []).filter((path) => set.has(path)),
    renames: (diff?.renames ?? []).filter(({ from, to }) => set.has(from) && set.has(to)),
  };
}

function externalFiles(root, work, files) {
  return files.filter((path) => {
    const lang = langOf(path, root);
    return ((lang && lang !== 'markdown') || isContractPath(path)) && resolveScope(work.scopes, path).error?.kind === 'none';
  });
}

async function readInput(root, path) {
  const bytes = await readLocalBytes(root, path, 64 * 1024);
  if (bytes === null) throw new Error(`cannot read ${path}`);
  return JSON.parse(bytes.toString('utf8'));
}

async function standaloneImpact(root, files) {
  const tracked = await gitPaths(root, ['ls-files', '--', GRAPH_INPUT, DERIVATIONS_INPUT]);
  if (!tracked.length) return null;
  const physical = await realpath(root);
  const targets = new Set(files);
  const doc = tracked.includes(GRAPH_INPUT) ? await readInput(physical, GRAPH_INPUT) : {};
  const graph = doc.graph ?? { nodes: doc.nodes ?? [], edges: doc.edges ?? [] };
  const refs = graph.nodes.filter(({ id, path }) => targets.has(path ?? id)).map(({ id }) => id);
  const derivations = tracked.includes(DERIVATIONS_INPUT) ? await readInput(physical, DERIVATIONS_INPUT) : doc.derivations;
  const changes = files.map((ref) => ({ ref }));
  if (derivations) {
    for (const row of derivations.receipts ?? []) {
      const { receipt } = readReceipt(row);
      for (const tool of receipt?.tools ?? []) {
        if (targets.has(tool.id)) changes.push({ ref: toolRef(tool) });
      }
    }
  }
  const basis = derivations ? { ...derivations, changes } : null;
  const report = impactReport({ graph, change: { refs, scopes: doc.change?.scopes ?? doc.scopes, tenant: doc.change?.tenant ?? doc.tenant },
    derivations: basis });
  if (!basis) return report;
  const { candidates, conflicts } = regenerationCandidates(basis);
  return { ...report, regeneration: { stale: candidates, conflicts, executed: false } };
}

async function scopeWithVerification({ root, work, scope, limit, diff, graph, external }) {
  const report = await scopedImpact({ root, work, scope, limit, diff, codeGraph: graph, external });
  if (report.error || !report.files.length) return report;
  const localFiles = report.files.filter((path) => resolveScope(work.scopes, path).scope === scope.id);
  const verification = await selectLocalVerification(root, {
    scopeId: scope.id, work, changes: pathChanges(localFiles, diff), extraPaths: report.affectedPaths,
    imports: graph?.edges,
  });
  return { ...report, verification };
}

export async function knowledgeForImpact(root, { files, graph, gone = [], changed = false }) {
  if (!files.length) return null;
  const work = await readWork(root);
  const diff = pathChanges(files, changed ? await readChanges(root) : { deleted: gone });
  const external = externalFiles(root, work, files);
  const scopes = [];
  const problems = [...work.problems.map(({ message, remedy }) => ({ message, remedy }))];
  for (const scope of work.scopes) {
    const report = await scopeWithVerification({ root, work, scope, diff, graph, external });
    if (report.error) problems.push({ scope: scope.id, message: report.error, remedy: report.remedy });
    else if (report.files.length) scopes.push(report);
  }
  let inputs = null;
  if (!work.declared) {
    try {
      inputs = await standaloneImpact(root, files);
    } catch (error) {
      problems.push({ message: error.message });
    }
  }
  return scopes.length || inputs || problems.length ? { scopes, inputs, problems } : null;
}

export async function scopedUnifiedImpact({ root, work, scope, limit }) {
  const diff = await readChanges(root);
  if (!diff.files.length) return scopedImpact({ root, work, scope, limit, diff });
  const external = externalFiles(root, work, diff.files);
  const candidates = new Set(external);
  const privatePaths = work.scopes.flatMap(({ tracker }) => tracker?.visibility === 'private' ? [tracker.path] : []);
  const deny = [...ALWAYS_DENIED, ...privatePaths];
  function allows(path) {
    if (path.split('/').some((part) => /^(?:\.ssh|\.gnupg)$/u.test(part)) || !mayIndex({ path, deniedPaths: deny }).indexed) return false;
    const owner = resolveScope(work.scopes, path);
    return !owner.ignored && (owner.scope === scope.id || candidates.has(path));
  }
  const graph = await loadLiveGraph(root, {
    retainTargets: [...diff.deleted, ...diff.renames.map(({ from }) => from)].filter(allows),
    policy: { deny, allows },
  });
  if (graph.broken) return scopedImpact({ root, work, scope, limit, diff });
  const report = await scopeWithVerification({ root, work, scope, limit, diff, graph, external });
  if (report.error || !report.files.length) return report;
  const targets = report.files.map((file) => ({ file, symbol: '' }));
  const code = traceImpact(impactTopology(graph, report.files), targets, { root });
  return { ...report, code: { targets, ...code } };
}

export function renderKnowledgeEvidence(report) {
  const knowledge = [];
  for (const [bucket, ids] of Object.entries(report.affected ?? {})) {
    for (const id of ids) knowledge.push(`knowledge ${bucket}  ${id}`);
  }
  for (const { output } of report.regeneration?.stale ?? []) knowledge.push(`regenerate  ${output}`);
  for (const { id } of report.verification?.obligations ?? []) knowledge.push(`verification  ${id}`);
  for (const { ref, reason } of report.unknown ?? []) knowledge.push(`knowledge unknown  ${ref}  ${reason}`);
  return knowledge;
}

export function renderKnowledgeBridge(bridge) {
  return [
    ...bridge.scopes.flatMap((report) => [`knowledge scope  ${report.scope}`, ...renderKnowledgeEvidence(report)]),
    ...(bridge.inputs ? renderKnowledgeEvidence(bridge.inputs) : []),
    ...bridge.problems.map(({ message }) => `knowledge unavailable  ${message}`),
  ];
}
