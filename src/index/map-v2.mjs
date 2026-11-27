import { inferRetrievalIntent, isMetaDocPath, kindPriorFor } from '../brief/kind.mjs';
import { isTestPath } from '../testing/paths.mjs';
import { cmp } from '../util/sort.mjs';
import { symbolKey, symbolNodePaths } from './bind.mjs';
import { BM25F_FIELDS, fieldQueryTerms, scoreFtsBm25F } from './bm25f.mjs';
import { directionalGraph, expandDirectional } from './directional.mjs';
import { exactEntityCandidates, searchEntityCandidates } from './entities.mjs';
import { searchCommitIr } from './graph-read.mjs';
import { conceptualPartners } from './lexical.mjs';
import { rankByFileGraph } from './map.mjs';
import { searchWithFeedback } from './prf.mjs';
import { nativeConceptualPartners, searchFtsBm25FBundle } from './store.mjs';
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
  const edgeLists = cochange.length ? [edges, cochange] : [edges];

  const fileSeeds = new Set([...seedPaths].map((p) => 'file:' + p));
  const isSeedNode = (node) => {
    if (fileSeeds.has(node)) return true;
    if (node.charCodeAt(0) === 115 && node.startsWith('sym:')) {
      const hash = node.indexOf('#', 4);
      return hash > 4 && seedPaths.has(node.slice(4, hash));
    }
    return false;
  };

  const hop1 = new Set();
  for (const list of edgeLists) {
    for (let i = 0; i < list.length; i += 1) {
      const { src, dst } = list[i];
      if (isSeedNode(src)) hop1.add(dst);
      if (isSeedNode(dst)) hop1.add(src);
    }
  }
  const localEdges = [];
  const localPaths = new Set(seedPaths);
  const pathOfNode = (node) => {
    const c = node.charCodeAt(0);
    if (c === 102 && node.startsWith('file:')) return node.slice(5);
    if (c === 115 && node.startsWith('sym:')) {
      const hash = node.indexOf('#', 4);
      return hash > 4 ? node.slice(4, hash) : null;
    }
    return null;
  };
  for (const list of edgeLists) {
    for (let i = 0; i < list.length; i += 1) {
      const edge = list[i];
      if (hop1.has(edge.src) || hop1.has(edge.dst) || isSeedNode(edge.src) || isSeedNode(edge.dst)) {
        localEdges.push(edge);
        const p1 = pathOfNode(edge.src);
        const p2 = pathOfNode(edge.dst);
        if (p1) localPaths.add(p1);
        if (p2) localPaths.add(p2);
      }
    }
  }
  // Lightweight snapshots omit per-symbol `contains` edges from SQLite (they are
  // 1:1 with `graph.symbols`); synthesize them for `localPaths` so 2-hop sibling
  // walks preserve exact parity with the full symbol graph.
  const haveContains = new Set();
  for (const edge of localEdges) {
    if (edge.kind === 'contains') haveContains.add(`${edge.src}\0${edge.dst}`);
  }
  for (const symbol of graph.symbols) {
    if (!localPaths.has(symbol.path)) continue;
    const src = `file:${symbol.path}`;
    const dst = symbolKey(symbol.path, symbol.name, symbol.line);
    const id = `${src}\0${dst}`;
    if (!haveContains.has(id)) {
      haveContains.add(id);
      localEdges.push({ src, dst, kind: 'contains', path: symbol.path });
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

function fastPathTokens(segment) {
  const tokens = [];
  for (const raw of segment.split(/[^a-zA-Z0-9]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower.length >= 2) tokens.push(singularize(lower));
    const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
    if (parts.length > 1) {
      for (const part of parts) if (part.length >= 2) tokens.push(singularize(part));
    }
  }
  return tokens;
}

function stemBoosts(task, paths, allowPath = null, { excludeMetaDocs = false } = {}) {
  const raw = String(task ?? '');
  const scopeMatch = raw.trim().match(/^[a-z]+\(([^)]+)\):/i);
  const scopeTokens = scopeMatch
    ? scopeMatch[1].toLowerCase().split(/[,/.\s_-]+/).filter((t) => t.length >= 2).map(singularize)
    : [];
  const scopeSet = new Set(scopeTokens);
  const queryTerms = new Set([
    ...scopeTokens,
    ...fieldQueryTerms(raw).map(singularize).filter((t) => t.length >= 3),
  ]);
  if (!queryTerms.size) return [];
  const paddedRefs = [];
  for (const match of raw.matchAll(/\b(?:plan|review|adr|decision)\s+(\d{1,4})\b/gi)) {
    paddedRefs.push(match[1].padStart(4, '0'));
  }
  const numericTerms = [...new Set([
    ...(raw.toLowerCase().match(/[a-z]*\d+[a-z0-9-]*/g) ?? []).filter((t) => t.length >= 3),
    ...paddedRefs,
  ])];
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefilterParts = [
    ...[...queryTerms].map((t) => escapeRe(t.length > 3 && t.endsWith('y') ? t.slice(0, -1) : t)),
    ...numericTerms.map(escapeRe),
  ];
  const prefilter = prefilterParts.length ? new RegExp(prefilterParts.join('|'), 'i') : null;

  const n = Math.max(1, paths.size);
  const cap = Math.max(3, Math.floor(n * 0.15));
  const common = (count) => count > cap || (n > 1 && count === n);

  const df = new Map();
  const numDf = new Map();
  const dirMatchCache = new Map();
  const dirFileCounts = new Map();
  const candidates = [];

  for (const path of paths) {
    const slash = path.lastIndexOf('/');
    const baseRaw = slash < 0 ? path : path.slice(slash + 1);
    const dot = baseRaw.lastIndexOf('.');
    const base = dot > 0 ? baseRaw.slice(0, dot) : baseRaw;
    const dir = slash < 0 ? '' : path.slice(0, slash);

    let dirInfo = dirMatchCache.get(dir);
    if (dirInfo === undefined) {
      const matched = [];
      let hasScopeDir = false;
      if (dir && (!prefilter || prefilter.test(dir))) {
        const seen = new Set();
        for (const token of fastPathTokens(dir)) {
          if (queryTerms.has(token) && !seen.has(token)) {
            seen.add(token);
            matched.push(token);
            if (scopeSet.has(token)) hasScopeDir = true;
          }
        }
      }
      dirInfo = { matched, hasScopeDir };
      dirMatchCache.set(dir, dirInfo);
    }
    const dirMatches = dirInfo.matched;
    const baseMayHit = !prefilter || prefilter.test(base);
    const numMayHit = numericTerms.length > 0 && (!prefilter || prefilter.test(path));

    let dirCanScore = false;
    if (dirMatches.length) {
      const nextCount = (dirFileCounts.get(dir) ?? 0) + 1;
      dirFileCounts.set(dir, nextCount);
      dirCanScore = dirInfo.hasScopeDir || nextCount <= cap;
      if (!dirCanScore && !baseMayHit && !numMayHit) {
        // Still record directory token DF up to cap + 1 so common() marks it common.
        if (nextCount === cap + 1) {
          for (const token of dirMatches) df.set(token, Math.max(df.get(token) ?? 0, nextCount));
        }
        continue;
      }
    }
    if (!baseMayHit && !dirCanScore && !numMayHit) continue;
    if (excludeMetaDocs && isMetaDocPath(path)) continue;
    if (allowPath && !allowPath(path)) continue;

    let stemMatches = null;
    if (baseMayHit) {
      for (const token of fastPathTokens(base)) {
        if (!queryTerms.has(token)) continue;
        if (!stemMatches) stemMatches = new Set();
        if (!stemMatches.has(token)) {
          stemMatches.add(token);
          df.set(token, (df.get(token) ?? 0) + 1);
        }
      }
    }

    let dirHit = false;
    if (dirCanScore) {
      for (const token of dirMatches) {
        if (!stemMatches?.has(token)) {
          df.set(token, (df.get(token) ?? 0) + 1);
          dirHit = true;
        }
      }
    }

    let lower = null;
    let numHit = false;
    if (numMayHit) {
      lower = path.toLowerCase();
      for (const token of numericTerms) {
        if (lower.includes(token)) {
          numDf.set(token, (numDf.get(token) ?? 0) + 1);
          numHit = true;
        }
      }
    }
    if (stemMatches || dirHit || numHit) {
      candidates.push({ path, baseLower: singularize(base.toLowerCase()), lower: numHit ? lower : null, stemMatches, dirMatches });
    }
  }

  const hits = [];
  for (const { path, baseLower, lower, stemMatches, dirMatches } of candidates) {
    let score = 0;
    if (stemMatches) {
      for (const token of stemMatches) {
        const count = df.get(token) ?? 0;
        if (!scopeSet.has(token) && common(count)) continue;
        const idf = Math.log(1 + n / (count + 0.5));
        const exactMult = baseLower === token ? 1.6 : 1.0;
        score += idf * exactMult * (scopeSet.has(token) ? 4.5 : 2.5);
      }
    }
    for (const token of dirMatches) {
      if (stemMatches?.has(token)) continue;
      const count = df.get(token) ?? 0;
      if (!scopeSet.has(token) && common(count)) continue;
      const idf = Math.log(1 + n / (count + 0.5));
      score += idf * (scopeSet.has(token) ? 4.8 : 1.2);
    }
    if (lower) {
      for (const token of numericTerms) {
        const count = numDf.get(token) ?? 0;
        if (count > 0 && count <= 3 && lower.includes(token)) score += 8.0;
      }
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
    const weighted = id === 'bm25f' || id === 'stem' || id === 'pagerank';
    const topScore = weighted ? (items[0]?.score ?? 0) : 0;
    for (let i = 0; i < items.length; i += 1) {
      const entry = items[i];
      const path = typeof entry === 'string' ? entry : entry?.path;
      if (!path) continue;
      const contrib = weighted && topScore > 0 && typeof entry?.score === 'number'
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
  preloadedBundle = null, commitIr = false, commitRows = null,
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
  const bundle = graph.nativeLexical && preloadedBundle
    ? preloadedBundle
    : await searchFtsBm25FBundle(root, task, { fts });
  const original = bundle.hits;
  const entityRows = graph.nativeLexical
    ? (overlayRows.length ? [...bundle.rows, ...overlayRows] : bundle.rows)
    : fts;
  const entities = exactOnly
    ? exactEntityCandidates(task, graph)
    : await searchEntityCandidates(root, task, { ...graph, fts: entityRows, stats: bundle.stats });
  const explicitTestAnchor = entities.candidates.some(({ tier, path }) => tier === 1 && isTestPath(path, root));
  const intent = inferRetrievalIntent(task, { includeTests: includeTests === true || explicitTestAnchor });
  const allowTests = includeTests !== undefined ? Boolean(includeTests) : (intent === 'tests' || explicitTestAnchor);
  const allowPath = allowTests
    ? (path) => allPaths.has(path)
    : (path) => allPaths.has(path) && !isTestPath(path, root);
  const paths = { has: allowPath, size: allPaths.size };

  const stems = stemBoosts(task, allPaths, allowPath, { excludeMetaDocs: intent !== 'docs' });
  const fileGraphAllow = intent === 'docs'
    ? allowPath
    : (path) => allowPath(path) && !isMetaDocPath(path);
  const fileGraph = rankByFileGraph({
    files: graph.files,
    edges: graph.edges,
    symbols: graph.symbols,
    task,
    allowPath: fileGraphAllow,
    limit: LIMIT,
  });
  const changed = new Set(overlayRows.map(({ ref }) => ref));
  const valid = ({ path }) => allowPath(path) && !changed.has(path);
  const ranking = graph.nativeLexical ? original.filter(valid) : original.filter(({ path }) => allowPath(path));
  const nonMetaRanking = intent === 'docs' ? ranking : ranking.filter(({ path }) => !isMetaDocPath(path));
  const feedbackInput = nonMetaRanking.length ? nonMetaRanking : ranking;
  const hasScope = /^[a-z]+\([^)]+\):/i.test(String(task ?? '').trim());
  const topLexPaths = new Set(feedbackInput.slice(0, 5).map(({ path }) => path));
  const directLexMatch = (hasScope && stems.length > 0) || (topLexPaths.size > 0 && (
    stems.slice(0, 5).some(({ path }) => topLexPaths.has(path))
    || fileGraph.resolver.slice(0, 5).some(({ path }) => topLexPaths.has(path))
  ));
  const feedback = feedbackEnabled && !directLexMatch
    ? await searchWithFeedback(root, task, { ranking: feedbackInput, graph, anchors: entities.anchors, fts })
    : { ranking, reason: directLexMatch ? 'direct-lexical' : 'disabled', expansion: [] };
  const exact = entities.candidates.filter(({ tier, path }) => tier <= 2 && allowPath(path));
  const matched = new Set(entities.candidates.filter(({ tier, path }) => tier <= 3 && allowPath(path)).map(({ path }) => path));
  const phrases = new Map(entities.candidates.map(({ path, phrase, components }) => [path, { phrase, score: components.proximity }]));
  const primary = feedback.ranking.filter(valid);
  const local = scoreFtsBm25F(overlayRows, task).filter(({ path }) => allowPath(path));
  const weightedRaw = [primary, local].flatMap((rows) =>
    rows.map((row) => {
      const prior = kindPriorFor(row.path, intent, isTestPath(row.path, root));
      return { row, prior, weighted: row.score * prior };
    }));
  const globalHigh = Math.max(
    ...weightedRaw.map(({ weighted }) => weighted),
    1e-9,
  );
  const lexical = weightedRaw.map(({ row, prior, weighted }) => {
    const phraseBonus = Math.min(0.20, (phrases.get(row.path)?.score ?? 0) * (0.20 / 0.75)) * prior;
    return {
      ...row,
      score: (weighted / globalHigh) * prior + phraseBonus,
      phrase: phrases.get(row.path)?.phrase ?? [],
    };
  }).sort(byScore).slice(0, LIMIT);
  const changes = [...(graph.cochange ?? []), ...graph.edges.filter(({ kind }) => kind === 'cochange')].sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst));
  const tier1 = exact.filter(({ tier: value }) => value === 1);
  const tier2 = exact.filter(({ tier: value }) => value === 2);
  const nonMeta = (rows) => {
    const kept = rows.filter(({ path }) => !isMetaDocPath(path));
    return kept.length ? kept : rows;
  };
  const couplingAnchors = nonMeta(exact.length ? exact : lexical);
  const couplingSources = new Set(couplingAnchors.slice(0, 3).map(({ path }) => path));
  const nativePartnersPromise = coupling && graph.nativeLexical && couplingSources.size
    ? nativeConceptualPartners(root, couplingSources)
    : null;
  const commitIrPromise = commitIr
    ? searchCommitIr(root, task, { rows: commitRows, allowPath, limit: LIMIT })
    : null;
  const seedPaths = new Set([
    ...exact.slice(0, SEED_CAP).map(({ path }) => path),
    ...lexical.slice(0, SEED_CAP).map(({ path }) => path),
  ]);
  const mapStructure = directional
    ? (structure ?? prepareSeededStructure(graph, seedPaths))
    : null;
  const [nativePartners, commitHits] = await Promise.all([
    nativePartnersPromise ?? Promise.resolve(null),
    commitIrPromise ?? Promise.resolve([]),
  ]);
  const stemWeight = hasScope ? 1.6 : 0.70;
  const lists = [
    { id: 'entity', weight: 3, items: tier1 },
    ...(tier2.length ? [{ id: 'entity', weight: 0.35, items: tier2 }] : []),
    { id: 'bm25f', weight: 2.35, items: lexical },
    ...(stems.length ? [{ id: 'stem', weight: stemWeight, items: stems }] : []),
    ...(fileGraph.resolver.length ? [{ id: 'resolver', weight: 0.65, items: fileGraph.resolver }] : []),
    ...(directional && fileGraph.pagerank.length ? [{ id: 'pagerank', weight: 0.30, items: fileGraph.pagerank }] : []),
    { id: 'directional', weight: 0.9, items: directional ? structuralHits(mapStructure, paths, exact, lexical) : [] },
    ...(commitHits.length ? [{ id: 'commit_ir', weight: 0.70, items: commitHits }] : []),
    { id: 'coupling', weight: 0.15, items: coupling ? couplingHits(fts ?? overlayRows, changes, couplingAnchors, paths, nativePartners) : [] },
  ];
  if (queryVector && graph.embeddings?.length) {
    const embedded = rankByCosine(graph.embeddings, queryVector).filter(({ path }) => paths.has(path));
    lists.push({ id: 'embedding', weight: 1.5, items: embedded.slice(0, LIMIT) });
  }
  if (lists.every(({ items }) => items.length === 0)) {
    const allowedSet = allowTests ? allPaths : new Set([...allPaths].filter(allowPath));
    lists.push({ id: 'centrality', weight: 1, items: centrality(allowedSet, graph.edges) });
  }
  const tier = new Map(exact.map(({ path, tier: value }) => [path, value]));
  const ranked = fuseChannels(lists).map((row) => ({ ...row, resolver: Number(matched.has(row.path)) }))
    .sort((a, b) => (tier.get(a.path) === 1 ? 1 : 2) - (tier.get(b.path) === 1 ? 1 : 2) || b.rank - a.rank || cmp(a.path, b.path));
  return {
    ranked,
    matched: matched.size,
    evidence: explain ? explainRanks(ranked, lists, matchedFields(entityRows ?? overlayRows, task, new Set(ranked.map(({ path }) => path)))) : [],
    feedback: { reason: feedback.reason, expansion: feedback.expansion },
  };
}
