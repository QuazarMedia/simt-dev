import { cmp } from '../util/sort.mjs';
import { symbolKey, symbolNodePaths } from './bind.mjs';
import { BM25F_FIELDS, fieldQueryTerms, scoreFtsBm25F } from './bm25f.mjs';
import { directionalGraph, expandDirectional } from './directional.mjs';
import { exactEntityCandidates, searchEntityCandidates } from './entities.mjs';
import { conceptualPartners } from './lexical.mjs';
import { rrfFuse } from './map.mjs';
import { searchWithFeedback } from './prf.mjs';
import { searchFtsBm25F } from './store.mjs';
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

// Exported so the scale harness can time the graph and coupling phases in
// isolation (plan 0006 V02); they are the engine's own walk, not a proxy.
export function structuralHits({ nodes, byName, links }, paths, anchors, lexical) {
  const seeds = [];
  for (const { path, matches: hits } of anchors.slice(0, SEED_CAP)) {
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
    if (paths.has(path) && !best.has(path)) best.set(path, { path, score, witness });
  }
  return [...best.values()].sort(byScore).slice(0, LIMIT);
}

export function couplingHits(rows, changes, anchors, paths) {
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
  for (const { path, source, score } of conceptualPartners(rows, sources)) record(path, 'conceptual', score, source);
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

export async function rankMapV2(root, graph, task, { explain = false, queryVector = null, coupling = true, structure = null, exactOnly = false, feedbackEnabled = true, directional = true } = {}) {
  const paths = new Set(graph.files.map(({ path }) => path));
  if (!task.trim()) {
    const structural = centrality(paths, graph.edges);
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
  const changed = new Set(overlayRows.map(({ ref }) => ref));
  const valid = ({ path }) => paths.has(path) && !changed.has(path);
  const ranking = graph.nativeLexical ? original.filter(valid) : original;
  const feedback = feedbackEnabled
    ? await searchWithFeedback(root, task, { ranking, graph, anchors: entities.anchors, fts })
    : { ranking, reason: 'disabled', expansion: [] };
  const exact = entities.candidates.filter(({ tier, path }) => tier <= 2 && paths.has(path));
  const matched = new Set(entities.candidates.filter(({ tier }) => tier <= 3).map(({ path }) => path));
  const phrases = new Map(entities.candidates.map(({ path, phrase, components }) => [path, { phrase, score: components.proximity }]));
  const primary = feedback.ranking.filter(valid);
  const local = scoreFtsBm25F(overlayRows, task);
  const lexical = [primary, local].flatMap((rows) => {
    const high = rows[0]?.score || 1;
    return rows.filter(({ path }) => paths.has(path)).map((row) => ({
      ...row, score: row.score / high + (phrases.get(row.path)?.score ?? 0), phrase: phrases.get(row.path)?.phrase ?? [],
    }));
  }).sort(byScore).slice(0, LIMIT);
  const changes = [...(graph.cochange ?? []), ...graph.edges.filter(({ kind }) => kind === 'cochange')].sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst));
  const lists = [
    { id: 'entity', weight: 3, items: exact },
    { id: 'bm25f', weight: 2, items: lexical },
    { id: 'directional', weight: 1, items: directional ? structuralHits(structure ?? prepareMapStructure(graph), paths, exact, lexical) : [] },
    { id: 'coupling', weight: 0.6, items: coupling ? couplingHits(fts ?? overlayRows, changes, exact.length ? exact : lexical, paths) : [] },
  ];
  if (queryVector && graph.embeddings?.length) {
    const embedded = rankByCosine(graph.embeddings, queryVector).filter(({ path }) => paths.has(path));
    lists.push({ id: 'embedding', weight: 1.5, items: embedded.slice(0, LIMIT) });
  }
  if (lists.every(({ items }) => items.length === 0)) lists.push({ id: 'centrality', weight: 1, items: centrality(paths, graph.edges) });
  const tier = new Map(exact.map(({ path, tier: value }) => [path, value]));
  const ranked = rrfFuse(lists).map((row) => ({ ...row, resolver: Number(matched.has(row.path)) }))
    .sort((a, b) => (tier.get(a.path) ?? 3) - (tier.get(b.path) ?? 3) || b.rank - a.rank || cmp(a.path, b.path));
  return {
    ranked,
    matched: matched.size,
    evidence: explain ? explainRanks(ranked, lists, matchedFields(fts ?? overlayRows, task, new Set(ranked.map(({ path }) => path)))) : [],
    feedback: { reason: feedback.reason, expansion: feedback.expansion },
  };
}
