import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { SPEC_PATHS } from '../commands/spec.mjs';
import { loadCorpus, RULE_DIRS } from '../commands/why.mjs';
import { decisionsDir } from '../decisions/dir.mjs';
import { loadDecisions } from '../decisions/index.mjs';
import { registryLocation } from '../graph/load.mjs';
import { digestOf } from '../knowledge/observations.mjs';
import { LESSONS_DIR } from '../memory/lessons.mjs';
import { MANIFEST_FILE, MANIFEST_LEGACY } from '../name.mjs';
import { packageVersion } from '../package-version.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { cmp } from '../util/sort.mjs';
import { eligibleSkillScopes, resolveToken, scopeHits, sourceRoots } from './govern.mjs';
import { CODEOWNERS_PATHS, ownersOf } from './impact.mjs';
import { candidatePaths } from './live.mjs';
import { readSqliteBatch, readSqliteRows } from './persist.mjs';

import { GOVERNANCE_BASIS_KEY } from './governance-persist.mjs';
const DECISION_FILE = /^ADR-\d{3,}-.*\.md$/iu;
const MARKDOWN = /\.mdc?$/u;

export const BASIS_SQL = `select value from meta where key = '${GOVERNANCE_BASIS_KEY}'`;
export const RELATION_SQL = `select e.src, e.kind as relation, e.dst, n.kind, n.id, n.detail, n.superseded_by as supersededBy
  from governance_edges e join governance_nodes n on n.key = e.src
  where (e.kind = 'governs_path' and e.dst in (select value from json_each(?)))
     or (e.kind = 'governs_command' and ?)`;

async function matchingFiles(root, dir, pattern) {
  const folder = join(root, dir);
  const names = await readdir(folder).catch(() => []);
  return names.filter((name) => pattern.test(name)).map((name) => join(folder, name));
}

async function metadata(path) {
  try {
    const info = await stat(path);
    return [path, info.size, info.mtimeMs, info.ctimeMs];
  } catch {
    return [path, null];
  }
}

export async function governanceInputState(root, { trackedPaths = null, cachedSignals = null } = {}) {
  root = await realpath(root);
  const [dir, registry, signals] = await Promise.all([
    decisionsDir(root),
    registryLocation({ root }),
    Array.isArray(cachedSignals) ? cachedSignals : fingerprint(root, { trackedPaths }).then((fp) => fp.signals),
  ]);
  const sources = [
    ...[MANIFEST_FILE, MANIFEST_LEGACY, ...CODEOWNERS_PATHS].map((path) => join(root, path)),
    ...(registry.where ? [registry.where] : []),
    ...(await Promise.all([
      matchingFiles(root, dir, DECISION_FILE),
      ...[...RULE_DIRS, LESSONS_DIR].map((path) => matchingFiles(root, path, MARKDOWN)),
    ])).flat(),
  ].sort(cmp);
  const revisions = [];
  for (let start = 0; start < sources.length; start += 64) {
    revisions.push(...await Promise.all(sources.slice(start, start + 64).map(metadata)));
  }
  return { dir, revisions, signals };
}

export async function governanceBasis(root, ctx, inputState) {
  const { dir, revisions, signals } = inputState ?? await governanceInputState(root);
  const files = ctx.filesList ?? (ctx.filesSorted ? [...ctx.files] : [...ctx.files].sort(cmp));
  const basis = digestOf(JSON.stringify([1, packageVersion(), new Date().toISOString().slice(0, 10), dir,
    revisions, files, [...ctx.commands].sort(cmp), [...signals].sort(cmp)]));
  return { basis, dir, signals };
}

async function ownersText(root) {
  for (const path of CODEOWNERS_PATHS) {
    const body = await readFile(join(root, path), 'utf8').catch(() => null);
    if (body !== null) return body;
  }
  return '';
}

export async function governanceSnapshot(root, ctx, { targets = ctx.files, basis } = {}) {
  const stamp = basis ?? await governanceBasis(root, ctx);
  const [{ decisions }, policy, owners] = await Promise.all([
    loadDecisions({ dir: join(root, stamp.dir) }), loadCorpus(root), ownersText(root),
  ]);
  const nodes = new Map();
  const edges = new Map();
  const tokens = new Map();
  function node(kind, id, detail, supersededBy = null) {
    const key = `${kind}:${id}`;
    if (!nodes.has(key)) nodes.set(key, { key, kind, id, detail, supersededBy });
    return key;
  }
  function edge(src, kind, dst) {
    edges.set(JSON.stringify([src, kind, dst]), { src, kind, dst });
  }
  for (const decision of decisions) {
    const src = node('decision', decision.id, decision.title, decision.supersededBy);
    if (decision.supersededBy) edge(`decision:${decision.supersededBy}`, 'supersedes', src);
    for (const { adr } of decision.supersedesRulings ?? []) {
      if (adr !== decision.id) edge(src, 'supersedes', `decision:${adr}`);
    }
    for (const token of decision.affects) {
      if (!tokens.has(token)) tokens.set(token, resolveToken(token, ctx));
      const resolved = tokens.get(token);
      if (resolved.kind === 'command') edge(src, 'governs_command', resolved.id);
      for (const path of resolved.paths ?? []) if (targets.has(path)) edge(src, 'governs_path', path);
    }
  }
  for (const skill of policy.skills) {
    const src = node('skill', skill.id, skill.detail);
    for (const signal of skill.stack ?? []) edge(src, 'applies_to_stack', signal);
  }
  for (const [kind, rows] of [['rule', policy.rules], ['gate', policy.gates], ['lesson', policy.lessons]]) {
    for (const { id, detail } of rows) node(kind, id, detail);
  }
  const scopes = { ...policy, skills: eligibleSkillScopes(policy.skills, { tree: [...ctx.files], repoSignals: stamp.signals }) };
  for (const path of targets) {
    for (const hit of scopeHits(path, scopes)) edge(node(hit.kind, hit.id, hit.detail), 'governs_path', path);
    if (owners) for (const owner of ownersOf(owners, path)) edge(node('owner', owner, 'CODEOWNERS'), 'governs_path', path);
  }
  return { basis: stamp.basis, nodes, edges: [...edges.values()] };
}

export async function prepareGovernance(root, listed) {
  const files = new Set(candidatePaths(listed).map(({ path }) => path));
  const ctx = { files, commands: new Set(SPEC_PATHS), roots: sourceRoots(files) };
  const [basis, cached] = await Promise.all([governanceBasis(root, ctx), readSqliteRows(root, BASIS_SQL)]);
  const snapshot = cached.rows[0]?.value === basis.basis ? null : await governanceSnapshot(root, ctx, { basis });
  return { snapshot, signals: basis.signals };
}

export async function readGovernance(root, ctx, targets, { includeCommands = false, observedBasis, preloaded = null } = {}) {
  const basis = observedBasis ?? await governanceBasis(root, ctx);
  if (preloaded && preloaded.basis === basis.basis && [...targets].every((t) => preloaded.targets.has(t)) && (!includeCommands || preloaded.includeCommands)) {
    const rows = preloaded.rows.filter(({ relation, dst }) =>
      (relation === 'governs_path' && targets.has(dst)) || (relation === 'governs_command' && includeCommands));
    return {
      basis: 'sqlite',
      nodes: new Map(rows.map(({ src, kind, id, detail, supersededBy }) => [src, { kind, id, detail, supersededBy }])),
      edges: rows.map(({ src, relation, dst }) => ({ src, kind: relation, dst })),
    };
  }
  const cached = await readSqliteBatch(root, [[BASIS_SQL], [RELATION_SQL, [JSON.stringify([...targets]), Number(includeCommands)]]]);
  const [metadata, rows] = cached.results ?? [[], []];
  if (!cached.error && metadata[0]?.value === basis.basis) return {
    basis: 'sqlite',
    nodes: new Map(rows.map(({ src, kind, id, detail, supersededBy }) => [src, { kind, id, detail, supersededBy }])),
    edges: rows.map(({ src, relation, dst }) => ({ src, kind: relation, dst })),
  };
  const snapshot = await governanceSnapshot(root, ctx, { targets, basis });
  return { ...snapshot, basis: 'worktree' };
}
