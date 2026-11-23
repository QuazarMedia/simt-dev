import { inferRetrievalIntent, kindPriorFor } from '../brief/kind.mjs';
import { isTestPath } from '../testing/paths.mjs';
import { cmp } from '../util/sort.mjs';
import { symbolKey, symbolNodePaths } from './bind.mjs';
import { BM25F_FIELDS, fieldQueryTerms, scoreFtsBm25F } from './bm25f.mjs';
import { directionalGraph, expandDirectional } from './directional.mjs';
import { exactEntityCandidates, searchEntityCandidates } from './entities.mjs';
import { conceptualPartners } from './lexical.mjs';
import { searchWithFeedback } from './prf.mjs';
import { nativeConceptualPartners, searchFtsBm25F } from './store.mjs';
import { rankByCosine } from './vectors.mjs';

const LIMIT = 30;
const SEED_CAP = 12;
const byScore = (a, b) => b.score - a.score || cmp(a.path, b.path);

function centrality(files, edges) {
  const inbound = new Map();
  const outgoing = new Map();
  function add(index, path, partner) {
    if (!index.has(path)) index.set(path, new Set());
    index.get(path).add(partner);
  }
  for (const { src, dst, kind } of edges) {
    if (kind !== 'import' || src === dst || !files.has(src) || !files.has(dst)) continue;
    add(inbound, dst, src);
    add(outgoing, src, dst);
  }
  return [...files].map((path) => {
    const sources = inbound.get(path) ?? new Set();
    const targets = outgoing.get(path) ?? new Set();
    let score = 0;
    for (const src of [...sources].sort(cmp)) score += 1 / outgoing.get(src).size;
    for (const dst of [...targets].sort(cmp)) score += 0.35 / inbound.get(dst).size;
    return { path, score: score / Math.log2(2 + sources.size + targets.size) };
  }).sort(byScore);
}

export function prepareMapStructure(graph) {
  const paths = graph.files.map(({ path }) => path);
  const edges = graph.symbolGraph?.edges ?? [];
  const nodes = symbolNodePaths(paths, edges);
  const byName = new Map();
  for (const symbol of graph.symbols) {
    const key = symbolKey(symbol.path, symbol.name, symbol.line);
    if (!nodes.has(key)) continue;
    const name = JSON.stringify([symbol.path, symbol.qualname ?? symbol.name]);
    const values = byName.get(name) ?? [];
    values.push(key);
    byName.set(name, values);
  }
  const cochange = [...(graph.cochange ?? []), ...graph.edges.filter(({ kind }) => kind === 'cochange')]
    .map(({ src, dst, weight }) => ({ src: 'file:' + src, dst: 'file:' + dst, kind: 'cochange', weight }));
  return { nodes, byName, links: directionalGraph([...edges, ...cochange]) };
}

function prepareSeededStructure(graph, seedPaths) {
  const edges = graph.symbolGraph?.edges ?? [];
  const cochange = [...(graph.cochange ?? []), ...graph.edges.filter(({ kind }) => kind === 'cochange')]
    .map(({ src, dst, weight }) => ({ src: 'file:' + src, dst: 'file:' + dst, kind: 'cochange', weight }));
  const allEdges = [...edges, ...cochange];

  const isSeedNode = (node) => {
    if (node.startsWith('file:')) return seedPaths.has(node.slice(5));
    if (node.startsWith('sym:')) {
      const hash = node.indexOf('#');
      return hash > 4 && seedPaths.has(node.slice(4, hash));
    }
    return false;
  };

  const hop1 = new Set();
  for (const { src, dst } of allEdges) {
    if (isSeedNode(src)) hop1.add(dst);
    if (isSeedNode(dst)) hop1.add(src);
  }
  const localEdges = [];
  const localPaths = new Set(seedPaths);
  const pathOfNode = (node) => {
    if (node.startsWith('file:')) return node.slice(5);
    if (node.startsWith('sym:')) {
      const hash = node.indexOf('#');
      return hash > 4 ? node.slice(4, hash) : null;
    }
    return null;
  };
  for (const edge of allEdges) {
    if (isSeedNode(edge.src) || isSeedNode(edge.dst) || hop1.has(edge.src) || hop1.has(edge.dst)) {
      localEdges.push(edge);
      const p1 = pathOfNode(edge.src);
      const p2 = pathOfNode(edge.dst);
      if (p1) localPaths.add(p1);
      if (p2) localPaths.add(p2);
    }
  }
  const nodes = symbolNodePaths([...localPaths], localEdges);
  const byName = new Map();
  for (const symbol of graph.symbols) {
    if (!seedPaths.has(symbol.path)) continue;
    const key = symbolKey(symbol.path, symbol.name, symbol.line);
    if (!nodes.has(key)) continue;
    const name = JSON.stringify([symbol.path, symbol.qualname ?? symbol.name]);
    const values = byName.get(name) ?? [];
    values.push(key);
    byName.set(name, values);
  }
  return { nodes, byName, links: directionalGraph(localEdges) };
}

// Exported so the scale harness can time the graph and coupling phases in
// isolation; they are the engine's own walk, not a proxy.
export function structuralHits({ nodes, byName, links }, paths, anchors, lexical) {
  const seeds = [];
  const seedPaths = new Set();
  for (const { path, matches: hits } of anchors.slice(0, SEED_CAP)) {
    seedPaths.add(path);
    const keys = new Set(hits.flatMap((hit) => byName.get(JSON.stringify([path, hit.matched])) ?? []));
    if (keys.size === 1) seeds.push({ node: [...keys][0], score: 1, exact: true });
    else seeds.push({ node: `file:${path}`, score: 1, exact: true });
  }
  const max = lexical[0]?.score ?? 0;
  for (const { path, score } of lexical.slice(0, Math.max(0, SEED_CAP - seeds.length))) {
    if (max > 0) seeds.push({ node: `file:${path}`, score: 0.65 * score / max });
  }
  const ranked = expandDirectional(links, seeds);
  const best = new Map();
  for (const { node, score, witness } of ranked) {
    const path = nodes.get(node);
    if (paths.has(path) && !seedPaths.has(path) && !best.has(path)) best.set(path, { path, score, witness });
  }
  return [...best.values()].sort(byScore).slice(0, LIMIT);
}

export function couplingHits(rows, changes, anchors, paths, precomputedPartners = null) {
  const sources = new Set(anchors.slice(0, 3).map(({ path }) => path));
  if (!sources.size) return [];
  const best = new Map();
  function record(path, kind, score, anchor) {
    if (!paths.has(path) || sources.has(path) || score <= 0) return;
    const row = best.get(path) ?? { path, conceptual: 0, evolutionary: 0 };
    if (score > row[kind]) {
      row[kind] = score;
      row[`${kind}From`] = anchor;
    }
    best.set(path, row);
  }
  for (const { src, dst, weight } of changes) {
    if (!(weight > 0)) continue;
    if (sources.has(src)) record(dst, 'evolutionary', Math.min(1, weight), src);
    if (sources.has(dst)) record(src, 'evolutionary', Math.min(1, weight), dst);
  }
  const partners = precomputedPartners ?? conceptualPartners(rows, sources);
  for (const { path, source, score } of partners) record(path, 'conceptual', score, source);
  return [...best.values()].map((row) => ({ ...row, score: row.conceptual + row.evolutionary })).sort(byScore).slice(0, LIMIT);
}

function matchedFields(rows, task, paths) {
  const terms = new Set(fieldQueryTerms(task));
  const result = new Map();
  for (const row of rows) {
    if (!paths.has(row.ref)) continue;
    const found = result.get(row.ref) ?? new Set();
    for (const field of BM25F_FIELDS) {
      if (!found.has(field) && row[field]?.split(' ').some((term) => terms.has(term))) found.add(field);
    }
    result.set(row.ref, found);
  }
  return result;
}

function explainRanks(ranked, lists, fields) {
  const evidence = new Map(ranked.map(({ path, rank }) => [path, { path, rank, channels: {} }]));
  for (const { id, weight, items } of lists) {
    for (const [index, { path, ...row }] of items.entries()) {
      const entry = evidence.get(path);
      if (!entry) continue;
      entry.channels[id] = {
        rank: index + 1, weight, ...row,
        ...(id === 'bm25f' ? { matchedFields: BM25F_FIELDS.filter((field) => fields.get(path)?.has(field)) } : {}),
      };
    }
  }
  return [...evidence.values()];
}

function singularize(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function stemBoosts(task, paths) {
  const scopeMatch = String(task ?? '').trim().match(/^[a-z]+\(([^)]+)\):/i);
  const scopeTokens = scopeMatch
    ? scopeMatch[1].toLowerCase().split(/[,/.\s_-]+/).filter((t) => t.length >= 2).map(singularize)
    : [];
  const queryStems = new Set([
    ...scopeTokens,
    ...fieldQueryTerms(task).map(singularize).filter((t) => t.length >= 6),
  ]);
  if (!queryStems.size) return [];
  const scopeSet = new Set(scopeTokens);
  const stemsByPath = new Map();
  const df = new Map();
  for (const path of paths) {
    const base = (path.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
    const tokens = new Set(fieldQueryTerms(base).map(singularize));
    stemsByPath.set(path, tokens);
    for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const n = Math.max(1, paths.size);
  const hits = [];
  for (const [path, tokens] of stemsByPath) {
    let score = 0;
    for (const token of tokens) {
      if (!queryStems.has(token)) continue;
      const idf = Math.log(1 + n / ((df.get(token) ?? 0) + 0.5));
      score += idf * (scopeSet.has(token) ? 2.0 : 1.0);
    }
    if (score > 0) hits.push({ path, score });
  }
  return hits.sort(byScore).slice(0, LIMIT);
}

function fuseChannels(lists, k = 40) {
  const fused = new Map();
  const bestScore = new Map();
  for (const { id, items = [], weight = 1 } of lists) {
    if (!Array.isArray(items) || weight <= 0 || !items.length) continue;
    const topScore = id === 'bm25f' ? (items[0]?.score ?? 0) : 0;
    for (let i = 0; i < items.length; i += 1) {
      const entry = items[i];
      const path = typeof entry === 'string' ? entry : entry?.path;
      if (!path) continue;
      const contrib = id === 'bm25f' && topScore > 0 && typeof entry?.score === 'number'
        ? weight * (0.35 / (k + i + 1) + 0.65 * (entry.score / topScore) / (k + 1))
        : weight / (k + i + 1);
      fused.set(path, (fused.get(path) ?? 0) + contrib);
      if (typeof entry === 'object' && typeof entry?.score === 'number') {
        bestScore.set(path, Math.max(bestScore.get(path) ?? 0, entry.score));
      }
    }
  }
  return [...fused.entries()]
    .map(([path, rank]) => ({ path, rank, score: bestScore.get(path) ?? 0 }))
    .sort((a, b) => (a.rank !== b.rank ? (a.rank < b.rank ? 1 : -1) : cmp(a.path, b.path)));
}

export async function rankMapV2(root, graph, task, {
  explain = false, queryVector = null, coupling = true, structure = null,
  exactOnly = false, feedbackEnabled = true, directional = true, includeTests = undefined,
} = {}) {
  const allPaths = new Set(graph.files.map(({ path }) => path));
  if (!task.trim()) {
    const nonTestPaths = new Set([...allPaths].filter((path) => includeTests === true || !isTestPath(path, root)));
    const structural = centrality(nonTestPaths, graph.edges);
    const ranked = structural.map((row) => ({ ...row, rank: row.score, resolver: 0 }));
    const evidence = explain ? explainRanks(ranked, [{ id: 'centrality', weight: 1, items: structural }], new Map()) : [];
    return { ranked, evidence, matched: 0, feedback: null };
  }
  const fts = graph.nativeLexical ? undefined : graph.fieldedRows;
  const overlayRows = graph.nativeLexical ? graph.fieldedRows : [];
  const [entities, original] = await Promise.all([
    exactOnly ? exactEntityCandidates(task, graph) : searchEntityCandidates(root, task, { ...graph, fts }),
    searchFtsBm25F(root, task, { fts }),
  ]);
  const explicitTestAnchor = [...entities.anchors.keys()].some((path) => isTestPath(path, root));
  const intent = inferRetrievalIntent(task, { includeTests: includeTests === true || explicitTestAnchor });
  const allowTests = includeTests !== undefined ? Boolean(includeTests) : (intent === 'tests' || explicitTestAnchor);
  const paths = allowTests ? allPaths : new Set([...allPaths].filter((path) => !isTestPath(path, root)));

  const changed = new Set(overlayRows.map(({ ref }) => ref));
  const valid = ({ path }) => paths.has(path) && !changed.has(path);
  const ranking = graph.nativeLexical ? original.filter(valid) : original.filter(({ path }) => paths.has(path));
  const feedback = feedbackEnabled
    ? await searchWithFeedback(root, task, { ranking, graph, anchors: entities.anchors, fts })
    : { ranking, reason: 'disabled', expansion: [] };
  const exact = entities.candidates.filter(({ tier, path }) => tier <= 2 && paths.has(path));
  const matched = new Set(entities.candidates.filter(({ tier, path }) => tier <= 3 && paths.has(path)).map(({ path }) => path));
  const phrases = new Map(entities.candidates.map(({ path, phrase, components }) => [path, { phrase, score: components.proximity }]));
  const primary = feedback.ranking.filter(valid);
  const local = scoreFtsBm25F(overlayRows, task).filter(({ path }) => paths.has(path));
  const globalHigh = Math.max(primary[0]?.score ?? 0, local[0]?.score ?? 0, 1e-9);
  const lexical = [primary, local].flatMap((rows) =>
    rows.map((row) => {
      const prior = kindPriorFor(row.path, intent, isTestPath(row.path, root));
      const phraseBonus = Math.min(0.20, (phrases.get(row.path)?.score ?? 0) * (0.20 / 0.75));
      return {
        ...row,
        score: (row.score / globalHigh) * prior + phraseBonus,
        phrase: phrases.get(row.path)?.phrase ?? [],
      };
    })).sort(byScore).slice(0, LIMIT);
  const stems = stemBoosts(task, paths);
  const changes = [...(graph.cochange ?? []), ...graph.edges.filter(({ kind }) => kind === 'cochange')].sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst));
  const tier1 = exact.filter(({ tier: value }) => value === 1);
  const tier2 = exact.filter(({ tier: value }) => value === 2);
  const couplingAnchors = exact.length ? exact : lexical;
  const couplingSources = new Set(couplingAnchors.slice(0, 3).map(({ path }) => path));
  const nativePartners = coupling && graph.nativeLexical && couplingSources.size
    ? await nativeConceptualPartners(root, couplingSources)
    : null;
  const seedPaths = new Set([
    ...exact.slice(0, SEED_CAP).map(({ path }) => path),
    ...lexical.slice(0, SEED_CAP).map(({ path }) => path),
  ]);
  const mapStructure = directional
    ? (structure ?? prepareSeededStructure(graph, seedPaths))
    : null;
  const lists = [
    { id: 'entity', weight: 3, items: tier1 },
    ...(tier2.length ? [{ id: 'entity', weight: 1.0, items: tier2 }] : []),
    { id: 'bm25f', weight: 2.0, items: lexical },
    ...(stems.length ? [{ id: 'stem', weight: 1.2, items: stems }] : []),
    { id: 'directional', weight: 0.9, items: directional ? structuralHits(mapStructure, paths, exact, lexical) : [] },
    { id: 'coupling', weight: 0.45, items: coupling ? couplingHits(fts ?? overlayRows, changes, couplingAnchors, paths, nativePartners) : [] },
  ];
  if (queryVector && graph.embeddings?.length) {
    const embedded = rankByCosine(graph.embeddings, queryVector).filter(({ path }) => paths.has(path));
    lists.push({ id: 'embedding', weight: 1.5, items: embedded.slice(0, LIMIT) });
  }
  if (lists.every(({ items }) => items.length === 0)) lists.push({ id: 'centrality', weight: 1, items: centrality(paths, graph.edges) });
  const tier = new Map(exact.map(({ path, tier: value }) => [path, value]));
  const ranked = fuseChannels(lists).map((row) => ({ ...row, resolver: Number(matched.has(row.path)) }))
    .sort((a, b) => (tier.get(a.path) === 1 ? 1 : 2) - (tier.get(b.path) === 1 ? 1 : 2) || b.rank - a.rank || cmp(a.path, b.path));
  return {
    ranked,
    matched: matched.size,
    evidence: explain ? explainRanks(ranked, lists, matchedFields(fts ?? overlayRows, task, new Set(ranked.map(({ path }) => path)))) : [],
    feedback: { reason: feedback.reason, expansion: feedback.expansion },
  };
}
