import { join } from 'node:path';

import { IMPLEMENTED } from '../commands/index.mjs';
import { CLI } from '../name.mjs';
import { gitText } from '../sys/git.mjs';
import { cmp } from '../util/sort.mjs';
import { CITATIONS_BASIS_SQL, CITATIONS_PATH_SQL, readUnindexedCitations } from './commit-citations.mjs';
import { scriptSpecifiers } from './extract.mjs';
import { sortHits } from './govern.mjs';
import { governanceBasis, readGovernance } from './governance-store.mjs';
import { readStagedImports } from './graph-read.mjs';
import { withImportDatabase } from './import-database.mjs';
import { loadLiveGraph } from './live.mjs';
import { readSqliteBatch } from './persist.mjs';

const LIMIT = 64;
const MODULE_EXTENSIONS = ['mjs', 'js', 'ts', 'cjs', 'mts', 'cts'];

const COMMAND_WALK = `with recursive walk(target, path, depth, visited) as (
  select value, value, 0, json_array(value) from json_each(?)
  union all
  select walk.target, i.src, walk.depth + 1, json_insert(walk.visited, '$[#]', i.src)
  from walk join imports i on i.dst = walk.path
  where walk.depth < 2 and not exists(select 1 from json_each(walk.visited) where value = i.src)
)
select target, path, depth, visited from walk order by depth, visited`;

function entrypoints(command, ctx) {
  const exact = command.replaceAll(' ', '-');
  const loader = Object.hasOwn(IMPLEMENTED, command) ? IMPLEMENTED[command] : null;
  const modules = loader ? scriptSpecifiers(String(loader)).filter((spec) => /^\.\/[\w-]+\.[cm]?[jt]s$/u.test(spec)) : [];
  const matches = [];
  for (const root of ctx.roots) {
    const candidates = modules.length ? modules : MODULE_EXTENSIONS.map((suffix) => `${exact}.${suffix}`);
    for (const module of candidates) {
      const path = join(root, 'commands', module);
      if (ctx.files.has(path)) matches.push(path);
    }
  }
  return matches;
}

async function citationsFor(root, paths) {
  const [head, cached] = await Promise.all([
    gitText(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true }),
    readSqliteBatch(root, [[CITATIONS_BASIS_SQL], [CITATIONS_PATH_SQL, [JSON.stringify(paths)]]]),
  ]);
  const [meta, rows] = cached.results ?? [[], []];
  if (!head) return [];
  if (!cached.error && meta[0]?.value === head) return rows;
  return readUnindexedCitations(root, paths);
}

function recordsByPath(snapshot) {
  const paths = new Map();
  for (const { kind, src, dst } of snapshot.edges) {
    if (kind !== 'governs_path') continue;
    const rows = paths.get(dst) ?? [];
    rows.push(snapshot.nodes.get(src));
    paths.set(dst, rows);
  }
  return paths;
}

function addWitness(witnesses, record, path, witness) {
  const key = JSON.stringify([record.kind, record.id, path]);
  if (!witnesses.has(key)) witnesses.set(key, { kind: record.kind, id: record.id, detail: record.detail, path, witness });
}

export async function explainGovernance(root, paths, ctx, { tree, graph, inputState } = {}) {
  const requested = [...new Set(paths)].sort(cmp);
  const [staged, commits, observedBasis] = await Promise.all([
    tree === undefined ? null : readStagedImports(root, tree, requested), citationsFor(root, requested),
    governanceBasis(root, ctx, inputState),
  ]);
  const imports = staged ?? (graph ?? await loadLiveGraph(root, { retainTargets: requested })).edges;
  const wanted = new Set(requested);
  const edges = imports.filter(({ src, dst }) => ctx.files.has(src) && ctx.files.has(dst));
  const dependencies = edges.filter(({ src, dst, kind }) => wanted.has(src) && src !== dst && (!kind || kind === 'import'));
  const routes = new Map();
  for (const command of [...ctx.commands].sort((a, b) => a.length - b.length || cmp(a, b))) {
    for (const file of entrypoints(command, ctx)) if (!routes.has(file)) routes.set(file, command);
  }
  const governors = new Set([...requested, ...dependencies.map(({ dst }) => dst), ...routes.keys()]);
  const [snapshot, pathsToEntrypoints] = await Promise.all([
    readGovernance(root, ctx, governors, { includeCommands: true, observedBasis }),
    withImportDatabase(edges, (db) => db.prepare(COMMAND_WALK).all(JSON.stringify(requested))),
  ]);
  const byPath = recordsByPath(snapshot);
  const byCommand = new Map();
  for (const [file, command] of routes) {
    const rows = (byPath.get(file) ?? []).filter(({ kind, supersededBy }) => kind === 'decision' && !supersededBy);
    byCommand.set(file, rows.map((record) => ({ record, command })));
  }
  for (const { kind, src, dst } of snapshot.edges) {
    if (kind !== 'governs_command') continue;
    const record = snapshot.nodes.get(src);
    if (record.supersededBy) continue;
    for (const file of entrypoints(dst, ctx)) {
      const rows = byCommand.get(file) ?? [];
      rows.push({ record, command: dst });
      byCommand.set(file, rows);
    }
  }
  const result = { direct: [], command: [], inherited: [], historical: [] };
  const current = new Map();
  const historical = new Map();
  for (const path of requested) {
    const records = byPath.get(path) ?? [];
    const items = records.filter(({ supersededBy }) => !supersededBy);
    const retired = records.filter(({ supersededBy }) => supersededBy);
    current.set(path, sortHits(items).map(({ kind, id, detail }) => ({ kind, id, detail })));
    historical.set(path, sortHits(retired).map(({ kind, id, detail, supersededBy }) => ({ kind, id, detail, supersededBy })));
    for (const record of items) result.direct.push({ kind: record.kind, id: record.id, detail: record.detail, path, witness: [path] });
  }
  const commandWitness = new Map();
  for (const { target, path, visited } of pathsToEntrypoints) {
    for (const { record, command } of byCommand.get(path) ?? []) {
      addWitness(commandWitness, record, target, [`${CLI} ${command}`, ...JSON.parse(visited).reverse()]);
    }
  }
  result.command = [...commandWitness.values()];
  const inherited = new Map();
  for (const { src, dst } of dependencies.sort((a, b) => cmp(a.dst, b.dst))) {
    for (const record of byPath.get(dst) ?? []) {
      if (record.kind === 'decision' && !record.supersededBy) addWitness(inherited, record, src, [src, dst]);
    }
  }
  result.inherited = [...inherited.values()];
  result.historical = commits.map(({ adr, path, sha }) => ({ kind: 'decision', id: adr, path, sha, witness: [path, sha, adr] }));
  let truncated = false;
  for (const [tier, rows] of Object.entries(result)) {
    rows.sort((a, b) => a.witness.length - b.witness.length || cmp(a.path, b.path) || cmp(a.id, b.id)
      || cmp(JSON.stringify(a.witness), JSON.stringify(b.witness)));
    if (rows.length > LIMIT) truncated = true;
    result[tier] = rows.slice(0, LIMIT);
  }
  return { basis: snapshot.basis, graphBasis: staged ? 'staged' : 'worktree', current, historical, witnesses: result, truncated };
}
