import { stat } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';

import { symbolKey, symbolNodePaths } from '../index/bind.mjs';
import { withImportDatabase } from '../index/import-database.mjs';
import { readWorktreeFile } from '../index/overlay.mjs';
import { matchesGlob } from '../resolve/resolve.mjs';
import { cmp } from '../util/sort.mjs';
import { cyclicComponents } from '../util/components.mjs';
import { adjacency, shortestPath, sourceImports } from './graph-checks.mjs';

function cycles({ edges }, policy) {
  const excluded = (path) => (policy.exclude ?? []).some((glob) => matchesGlob(path, glob));
  const neighbors = adjacency(edges.filter(({ src, dst }) => !excluded(src) && !excluded(dst)));
  return cyclicComponents(neighbors).sort(([a], [b]) => cmp(a, b)).map((component) => {
    const members = new Set(component);
    const internal = new Map(component.map((path) => [path, neighbors.get(path).filter((dst) => members.has(dst))]));
    const file = component[0];
    const witness = shortestPath(internal, file, file);
    return { file, status: 'import-cycle', detail: witness.join(' -> '), witness,
      remedy: 'remove an import in this cycle or list a legacy path under limits.graph.cycles.exclude in simt.json' };
  });
}

async function brokenImports({ root, files, allEdges }) {
  const results = [];
  const sources = new Map();
  for (const { src, dst } of allEdges) {
    if (files.has(dst) || !/^\.\.?\//u.test(dst)) continue;
    const specifier = dst;
    const clean = specifier.split(/[?#]/u)[0];
    const relative = normalize(join(dirname(src), clean));
    if (relative === '..' || relative.startsWith('../')) continue;
    // Generated outputs may be ignored by Git while still satisfying a literal import.
    if (files.has(relative) || await stat(join(root, relative)).then(() => true, () => false)) continue;
    if (!sources.has(src)) sources.set(src, await sourceImports(root, src, files.get(src)));
    const origin = sources.get(src).find(({ spec }) => spec === specifier);
    if (!origin?.line) continue;
    results.push({ file: src, status: 'broken-relative-import', line: origin.line, specifier,
      detail: `line ${origin.line} imports ${JSON.stringify(specifier)}, which resolves to no file`,
      remedy: 'correct the relative import or restore its target' });
  }
  return results;
}

function entrypointTargets(value) {
  if (typeof value === 'string') return value.startsWith('./') ? [value.slice(2)] : [];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(entrypointTargets);
}

async function entrypoints({ root, files }, declared) {
  const paths = new Set(declared);
  for (const file of new Set(['package.json', ...[...files.keys()].filter((path) => basename(path) === 'package.json')])) {
    const text = await readWorktreeFile(root, file, 1024 * 1024).catch(() => null);
    if (text === null) continue;
    let metadata;
    try {
      metadata = JSON.parse(text.toString('utf8'));
    } catch {
      continue;
    }
    for (const target of entrypointTargets(metadata?.exports)) paths.add(join(dirname(file), target));
  }
  return [...paths];
}

const bindings = new Set(['imports_symbol', 'refs_symbol', 'reexports_symbol', 'calls_symbol', 'inherits']);
const minCoverage = 0.90;

async function deadExports(graph, declared) {
  const globs = await entrypoints(graph, declared);
  const remedy = 'declare public entrypoints under limits.graph.entrypoints in simt.json';
  if (!globs.length) {
    return [{ file: 'simt.json', status: 'graph-coverage-warn', detail: 'dead-export analysis requires explicit entrypoints', remedy }];
  }
  const { files, symbols, symbolGraph } = graph;
  const edges = symbolGraph?.edges ?? [];
  const coverage = symbolGraph?.bindingCoverage ?? {};
  const owners = symbolNodePaths(files.keys(), edges);
  const languages = new Set();
  const candidates = [];
  for (const { path, name, line, exported } of symbols) {
    if (!exported || globs.some((glob) => matchesGlob(path, glob))) continue;
    const lang = files.get(path);
    languages.add(lang);
    const key = symbolKey(path, name, line);
    if ((coverage[lang]?.ratio ?? 0) >= minCoverage && owners.has(key)) candidates.push({ key, path, name, line });
  }
  const findings = [...languages].filter((lang) => (coverage[lang]?.ratio ?? 0) < minCoverage).sort().map((lang) => ({
    file: 'simt.json', status: 'graph-coverage-warn',
    detail: `dead-export analysis skipped for ${lang}: binding coverage ${coverage[lang]?.ratio ?? 'unavailable'} is below ${minCoverage}`,
    remedy: 'resolve unsupported or unresolved imports before relying on export coverage',
  }));
  if (!candidates.length) return findings;
  const used = new Set(edges.filter(({ kind, src, dst }) => bindings.has(kind) && owners.get(src) !== owners.get(dst))
    .map(({ dst }) => dst));
  const unused = await withImportDatabase([], (db) => db.prepare(`
    with used as (select value as key from json_each(?))
    select candidate.value as row from json_each(?) as candidate
    where json_extract(candidate.value, '$.key') not in (select key from used)
  `).all(JSON.stringify([...used]), JSON.stringify(candidates)));
  for (const { row } of unused) {
    const { path, name, line } = JSON.parse(row);
    findings.push({ file: path, status: 'dead-export', line, detail: `${name} at line ${line} has no observed importer`,
      remedy: `remove the export if unused or ${remedy}` });
  }
  return findings;
}

function hubWarnings({ edges }, policy) {
  const counts = new Map();
  function count(path, side) {
    if (!counts.has(path)) counts.set(path, { in: 0, out: 0 });
    counts.get(path)[side] += 1;
  }
  for (const { src, dst } of edges) {
    count(src, 'out');
    count(dst, 'in');
  }
  return [...counts.keys()].sort().flatMap((file) => ['in', 'out'].flatMap((side) => {
    const maximum = side === 'in' ? policy.maxFanIn : policy.maxFanOut;
    const actual = counts.get(file)[side];
    if (maximum === undefined || actual <= maximum) return [];
    return [{ file, status: `hub-fan${side}-warn`, detail: `fan-${side} ${actual} exceeds ${maximum}`,
      remedy: 'narrow the module dependencies or adjust the hub budget in simt.json' }];
  }));
}

export async function graphInvariantFindings(graph, policy) {
  const findings = [];
  if (policy.cycles) findings.push(...cycles(graph, policy.cycles));
  if (policy.brokenImports) findings.push(...await brokenImports(graph));
  if (policy.deadExports) findings.push(...await deadExports(graph, policy.entrypoints ?? []));
  if (policy.maxFanIn !== undefined || policy.maxFanOut !== undefined) findings.push(...hubWarnings(graph, policy));
  return findings;
}
