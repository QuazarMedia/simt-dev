// Who a change reaches (ADR-096).
//
// Reverse dependents, the tests that import them, the owners a CODEOWNERS
// line names, and another repository that references a contract this change
// touches. The walk stops at a fixed count: an unbounded report is not an
// answer a reader can use.

import { isTestPath } from '../testing/paths.mjs';
import { symbolKey, symbolNodePaths } from './bind.mjs';
import { coverage } from './coverage.mjs';
import { createImportResolver } from './extract.mjs';
import { cmp } from '../util/sort.mjs';

export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
const IMPACT_LIMIT = 64;
const HUB_DEGREE_THRESHOLD = 32;
const DEGREE_POWER = 0.55;
const RELATIONS = new Set(['calls_symbol', 'refs_symbol', 'imports_symbol', 'reexports_symbol', 'inherits']);
const TIERS = ['direct', 'transitive', 'hubMediated'];

const CONTRACT_EXT = new Set(['json', 'yaml', 'yml']);

/**
 * Non-test files that import `file`, directly or through other files, and the
 * tests that import that closure. Past the limit, the rest is reported as
 * truncated rather than dropped silently; past `maxHop` hops, so is the rest.
 *
 * @param {string} file
 * @param {{src: string, dst: string, kind?: string}[]} imports
 * @param {number} [limit]
 * @param {number|null} [maxHop] a direct importer is hop 1; null walks to the count limit
 */
export function dependents(file, imports, limit = IMPACT_LIMIT, maxHop = null) {
  const reverse = new Map();
  for (const edge of imports) {
    if (edge.kind && edge.kind !== 'import') continue;
    const list = reverse.get(edge.dst);
    if (list) list.push(edge.src);
    else reverse.set(edge.dst, [edge.src]);
  }
  const importers = [];
  // A capped walk reports its own tests: the uncapped answer comes from `coverage` over
  // the full closure, and a cap that left it alone would cut importers at one depth
  // and tests at none - the same channel disagreement `coverage` exists to prevent.
  const hopTests = new Set();
  const seen = new Set([file]);
  const queue = [[file, 0]];
  let truncated = false;
  while (queue.length > 0) {
    const [current, hop] = queue.shift();
    const nextHop = hop + 1;
    const next = reverse.get(current);
    if (!next) continue;
    for (const src of next) {
      if (seen.has(src)) continue;
      seen.add(src);
      if (isTestPath(src)) {
        if (maxHop !== null) {
          if (nextHop > maxHop) truncated = true;
          else hopTests.add(src);
        }
        continue;
      }
      // A cap reached with importers still to report is truncation, not absence:
      // the reader must be told the list stops because it was asked to.
      if (maxHop !== null && nextHop > maxHop) {
        truncated = true;
        continue;
      }
      if (importers.length >= limit) {
        truncated = true;
        continue;
      }
      importers.push(src);
      queue.push([src, nextHop]);
    }
  }
  importers.sort();
  const tests = maxHop === null ? coverage({ imports }, [file]).filter((path) => path !== file) : [...hopTests].sort();
  const shown = tests.length > limit ? tests.slice(0, limit) : tests;
  if (tests.length > limit) truncated = true;
  return { importers, tests: shown, truncated };
}

/** Files that export `name`. A private symbol is not an export. */
export function filesExporting(name, symbols) {
  const found = new Set();
  for (const symbol of symbols) {
    if (symbol.exported && symbol.name === name) found.add(symbol.path);
  }
  return [...found].sort();
}

function connect(graph, key, node) {
  let neighbors = graph.get(key);
  if (!neighbors) graph.set(key, neighbors = new Set());
  neighbors.add(node);
}

/** Prepare topology once for every target in a change set. */
export function impactTopology(graph, retained = []) {
  const languages = new Map(graph.files.map(({ path, lang }) => [path, lang]));
  const files = new Set([...languages.keys(), ...retained]);
  const resolve = createImportResolver(files);
  const binding = graph.symbolGraph;
  const edges = binding?.edges ?? [];
  const nodes = symbolNodePaths(files, edges);
  const callers = new Map();
  const moduleUses = new Map();
  const imports = new Map();
  const outgoing = new Map();
  const uncertain = new Map();
  const fallback = new Set();
  let unknownDynamic = false;
  for (const row of binding?.unresolved ?? []) {
    if (row.kind === 'dynamic-import' || row.kind === 'file-import') {
      const target = resolve(row.path, row.spec, languages.get(row.path));
      if (target) {
        connect(imports, target, row.path);
        connect(outgoing, row.path, target);
        connect(uncertain, target, row.path);
      } else if (row.kind === 'dynamic-import' && !row.spec) unknownDynamic = true;
    } else {
      fallback.add(row.path);
    }
  }
  for (const { src, dst, kind } of graph.edges) {
    if ((kind && kind !== 'import') || !files.has(dst)) continue;
    connect(imports, dst, src);
    connect(outgoing, src, dst);
    if (fallback.has(src) || !binding?.bindingCoverage?.[languages.get(src)]) connect(uncertain, dst, src);
  }
  for (const { src, dst, kind } of edges) {
    if (!RELATIONS.has(kind) || !nodes.has(src) || !nodes.has(dst)) continue;
    connect(callers, dst, src);
    if (src.startsWith('file:') && (kind === 'calls_symbol' || kind === 'refs_symbol')) {
      connect(moduleUses, dst, src);
    }
  }
  return {
    nodes, imports, callers, moduleUses, uncertain, unknownDynamic,
    bindingCoverage: binding?.bindingCoverage ?? {},
    isHub: (path) => Math.max(imports.get(path)?.size ?? 0, outgoing.get(path)?.size ?? 0) > HUB_DEGREE_THRESHOLD,
  };
}

function byStrength(a, b) {
  return b.impactScore - a.impactScore || a.hop - b.hop;
}

function byImpact(a, b) {
  return a.tier - b.tier || byStrength(a, b) || cmp(a.path, b.path);
}

export function traceImpact(topology, targets, { root = null, limit = IMPACT_LIMIT, maxHop = null } = {}) {
  const { nodes, imports, callers, moduleUses, uncertain, bindingCoverage, unknownDynamic, isHub } = topology;
  const seeds = new Set(targets.map(({ file }) => file));
  const best = new Map();
  const states = [new Map(), new Map()];
  const queue = [];
  let conservativeFallback = unknownDynamic && targets.some(({ symbol }) => symbol);
  // A row at the hop cap still has outgoing edges: the walk stops by depth, so
  // `truncated` must say it was cut, not that the list is whole.
  let depthCut = false;
  function enqueue(node, path, hop, throughHub, impactScore) {
    const row = { node, path, hop, throughHub, impactScore, tier: throughHub ? 2 : hop === 1 ? 0 : 1 };
    const previous = best.get(path);
    if (hop && !seeds.has(path) && (!previous || byImpact(row, previous) < 0)) best.set(path, row);
    const state = states[Number(throughHub)];
    const old = state.get(node);
    if (old && byStrength(old, row) <= 0) return;
    state.set(node, row);
    queue.push(row);
  }
  for (const { file, symbol, lines = [] } of targets) {
    const keys = symbol ? lines.map((line) => symbolKey(file, symbol, line)).filter((key) => nodes.has(key)) : [];
    if (!keys.length) {
      conservativeFallback ||= Boolean(symbol);
      enqueue(file, file, 0, false, 1);
    } else {
      for (const key of keys) enqueue(key, file, 0, false, 1);
    }
  }
  for (const row of queue) {
    const { node, path, hop, throughHub, impactScore } = row;
    if (states[Number(throughHub)].get(node) !== row) continue;
    if (maxHop !== null && hop >= maxHop) {
      const outgoing = (node === path
        ? (imports.get(path)?.size ?? 0)
        : (callers.get(node)?.size ?? 0)) + (uncertain.get(path)?.size ?? 0);
      if (outgoing > 0) depthCut = true;
      continue;
    }
    const mediated = throughHub || (hop > 0 && isHub(path));
    const score = impactScore / Math.max(1, imports.get(path)?.size ?? 0) ** DEGREE_POWER;
    if (node === path) {
      for (const src of imports.get(path) ?? []) enqueue(src, src, hop + 1, mediated, score);
      continue;
    }
    for (const src of callers.get(node) ?? []) {
      const owner = nodes.get(src);
      const nextHop = hop + Number(owner !== path);
      enqueue(src, owner, nextHop, mediated, score);
      // A module-level expression can initialize an export without a bound
      // caller symbol. Preserve downstream tests through that specific module.
      if (owner !== path && moduleUses.get(node)?.has(src) && imports.get(owner)?.size) {
        conservativeFallback = true;
        enqueue(owner, owner, nextHop, mediated, score);
      }
    }
    for (const src of uncertain.get(path) ?? []) {
      conservativeFallback = true;
      enqueue(src, src, hop + 1, mediated, score);
    }
  }
  const tiers = Object.fromEntries(TIERS.map((tier) => [tier, []]));
  const importers = [];
  const tests = [];
  let truncated = false;
  let suppressedHubMediated = 0;
  for (const { path, hop, tier, impactScore } of [...best.values()].sort(byImpact)) {
    const list = isTestPath(path, root) ? tests : importers;
    if (list.length >= limit) {
      truncated = true;
      if (tier === 2) suppressedHubMediated += 1;
      continue;
    }
    list.push(path);
    tiers[TIERS[tier]].push({ path, hop, impactScore });
  }
  return { importers, tests, truncated: truncated || depthCut, tiers, suppressedHubMediated, bindingCoverage, conservativeFallback };
}

/**
 * The last matching CODEOWNERS pattern wins, which is the rule the file is
 * read under. A pattern with no slash matches the file name in any directory.
 *
 * @param {string} text
 * @param {string} file
 * @returns {string[]}
 */
export function ownersOf(text, file) {
  let owners = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    if (!pattern || !matchPattern(pattern, file)) continue;
    owners = parts.slice(1).filter((part) => part.startsWith('@') || part.includes('@'));
  }
  return owners;
}

/** A path that is a contract by name: OpenAPI, or a JSON Schema file. */
export function isContractPath(file) {
  const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'openapi.json' || base === 'openapi.yaml' || base === 'openapi.yml') return true;
  if (base.endsWith('.schema.json')) return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return CONTRACT_EXT.has(base.slice(dot + 1)) && base.includes('schema');
}

/**
 * Contracts this change can reach: the file itself, a dependent, or a contract
 * whose text names the file or the export.
 *
 * @param {{path: string, text: string}[]} contracts
 * @param {{file: string, symbol: string, importers: string[]}} target
 */
export function relatedContracts(contracts, { file, symbol, importers }) {
  const reached = new Set([file, ...importers]);
  const related = [];
  for (const contract of contracts) {
    if (reached.has(contract.path) || names(contract.text, file, symbol)) related.push(contract.path);
  }
  related.sort();
  return related;
}

/**
 * Files in other repositories whose text contains a contract path. The path
 * has to include a directory, so a bare filename is not a reference.
 *
 * @param {string[]} contracts repo-relative contract paths
 * @param {string} repoName the repository that owns the contracts
 * @param {{repo: string, path: string, text: string}[]} files
 * @param {number} [limit]
 */
export function contractReferences(contracts, repoName, files, limit = IMPACT_LIMIT) {
  const needles = [];
  for (const contract of contracts) {
    if (!contract.includes('/')) continue;
    needles.push({ contract, needle: contract });
    if (repoName) needles.push({ contract, needle: `${repoName}/${contract}` });
  }
  const found = [];
  let truncated = false;
  const seen = new Set();
  for (const file of files) {
    for (const item of needles) {
      if (!file.text.includes(item.needle)) continue;
      const key = `${file.repo}\0${file.path}\0${item.contract}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (found.length >= limit) {
        truncated = true;
        continue;
      }
      found.push({ repo: file.repo, path: file.path, contract: item.contract });
    }
  }
  found.sort((a, b) => cmp(a.repo, b.repo) || cmp(a.path, b.path) || cmp(a.contract, b.contract));
  return { references: found, truncated };
}

function names(text, file, symbol) {
  if (file && text.includes(file)) return true;
  if (!symbol) return false;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

function matchPattern(pattern, file) {
  let pat = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  const directory = pat.endsWith('/');
  if (directory) pat = pat.slice(0, -1);
  if (pat === '') return false;
  if (!pat.includes('/')) {
    if (directory) return file === pat || file.startsWith(`${pat}/`) || file.split('/').includes(pat);
    const base = file.slice(file.lastIndexOf('/') + 1);
    return glob(pat, base);
  }
  if (directory) return file === pat || file.startsWith(`${pat}/`);
  return glob(pat, file);
}

function glob(pattern, text) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*');
  return new RegExp(`^${body}$`).test(text);
}

