import { isTestPath } from '../testing/paths.mjs';
import { cmp } from '../util/sort.mjs';
import { FIELD_RESULT_LIMIT, fieldQueryTerms, fieldSearchStatement, scoreFtsBm25F } from './bm25f.mjs';
import { resolveEntityAnchors } from './entities.mjs';
import { collectFileTerms } from './lexical.mjs';
import { readSqliteBatch } from './persist.mjs';
import { readGraph, searchFtsBm25F } from './store.mjs';

const LIMITS = Object.freeze({ sources: 3, terms: 6, margin: 0.35, original: 0.7 });
const EXPANSION_WEIGHT = 0.3;
const byScore = (a, b) => b.score - a.score || cmp(a.path, b.path);
const round = (value) => Math.round(value * 1e6) / 1e6;

function feedbackSources(ranking, edges, documents) {
  const paths = new Set(ranking.map(({ path }) => path));
  const incoming = new Map();
  for (const { src, dst } of edges) {
    if (src === dst || !paths.has(dst)) continue;
    const callers = incoming.get(dst) ?? new Set();
    callers.add(src);
    incoming.set(dst, callers);
  }
  const hub = Math.max(8, Math.ceil(Math.sqrt(documents)));
  return ranking.filter(({ path, score }) =>
    score > 0 && !isTestPath(path) && (incoming.get(path)?.size ?? 0) < hub).slice(0, LIMITS.sources);
}

function bo1(tf, collectionFrequency, documents) {
  const lambda = collectionFrequency / documents;
  return tf * Math.log2(1 + 1 / lambda) + Math.log2(1 + lambda);
}

function scoreTerms(task, sources, evidence, method) {
  const original = new Set(fieldQueryTerms(task));
  const candidates = new Map();
  for (const { path, score } of sources) {
    const terms = evidence.files.get(path) ?? new Map();
    const length = [...terms.values()].reduce((sum, tf) => sum + tf, 0);
    for (const [term, tf] of [...terms].sort(([a], [b]) => cmp(a, b))) {
      const statistics = evidence.terms.get(term);
      if (original.has(term) || [...term].length < 3 || tf <= 0
        || !statistics || statistics.cf <= 0 || statistics.df < 2 || statistics.df / evidence.documents > 0.2) continue;
      const entry = candidates.get(term) ?? { term, sources: [], tf: 0, score: 0 };
      entry.sources.push(path);
      entry.tf += tf;
      if (method === 'rm3-lite') entry.score += score * tf / length;
      candidates.set(term, entry);
    }
  }
  if (method === 'bo1') {
    for (const entry of candidates.values()) entry.score = bo1(entry.tf, evidence.terms.get(entry.term).cf, evidence.documents);
  }
  const top = [...candidates.values()].sort((a, b) => b.score - a.score || cmp(a.term, b.term)).slice(0, LIMITS.terms);
  const total = top.reduce((sum, { score }) => sum + score, 0);
  return top.map(({ term, score, sources }) => ({
    term, score, weight: EXPANSION_WEIGHT * score / total, sources: sources.sort(cmp),
  }));
}

function interpolate(original, expansion, channels) {
  const rows = new Map();
  function add(ranking, weight, signal) {
    const best = ranking.reduce((score, row) => Math.max(score, row.score), 0);
    if (best <= 0) return;
    for (const row of ranking) {
      const entry = rows.get(row.path) ?? { path: row.path, kind: row.kind, original: 0, feedback: 0 };
      entry[signal] += weight * row.score / best;
      rows.set(row.path, entry);
    }
  }
  add(original, LIMITS.original, 'original');
  for (const [index, { weight }] of expansion.entries()) add(channels[index], weight, 'feedback');
  return [...rows.values()].map(({ path, kind, original, feedback }) => {
    const primary = round(original);
    const added = round(feedback);
    return { path, kind, score: primary + added, original: primary, feedback: added };
  })
    .sort(byScore).slice(0, FIELD_RESULT_LIMIT);
}

async function readFeedback(root, paths) {
  const { results, error } = await readSqliteBatch(root, [
    ['select count(*) as documents from lexical_files'],
    [`select s.path, ft.term, ft.tf, ts.df, ts.cf
      from sources s join file_terms ft on ft.source_id = s.id join term_stats ts on ts.term = ft.term
      where s.kind = 'blob' and s.path in (select value from json_each(?))
      order by s.path, ft.term`, [JSON.stringify(paths)]],
  ]);
  const files = new Map();
  const terms = new Map();
  for (const { path, term, tf, df, cf } of results?.[1] ?? []) {
    const counts = files.get(path) ?? new Map();
    counts.set(term, tf);
    files.set(path, counts);
    terms.set(term, { df, cf });
  }
  return { documents: results?.[0]?.[0]?.documents ?? 0, files, terms, error };
}

function overlayFeedback(fts, paths) {
  const all = collectFileTerms(fts);
  const files = new Map(paths.filter((path) => all.has(path)).map((path) => [path, all.get(path)]));
  const terms = new Map([...new Set([...files.values()].flatMap((counts) => [...counts.keys()]))]
    .map((term) => [term, { df: 0, cf: 0 }]));
  for (const counts of all.values()) {
    for (const [term, tf] of counts) {
      const stats = terms.get(term);
      if (!stats) continue;
      stats.df += 1;
      stats.cf += tf;
    }
  }
  return { documents: all.size, files, terms, error: fts.error ?? null };
}

function hasTier1Anchor(anchors) {
  for (const hits of anchors.values()) {
    if (hits.some(({ kind, quoted }) => kind === 'path' || kind === 'suffix' || kind === 'qualified-symbol' || quoted === true)) {
      return true;
    }
  }
  return false;
}

/** Execute only after the caller has built or supplied a fielded index. */
export async function searchWithFeedback(root, task, {
  ranking, graph, anchors, fts, method = 'bo1',
} = {}) {
  if (method !== 'bo1' && method !== 'rm3-lite') throw new Error(`unknown feedback method: ${method}`);
  const original = ranking ?? await searchFtsBm25F(root, task, { fts });
  const unchanged = (reason, error = null) => ({ ranking: original, expansion: [], reason, error });
  if (original.error) return unchanged('index-unavailable', original.error);
  if (original.length < 2 || original[0].score <= 0) return unchanged('insufficient-results');
  const margin = (original[0].score - original[1].score) / original[0].score;
  if (margin >= LIMITS.margin) return unchanged('confident-top1');

  const index = graph ?? await readGraph(root);
  const graphError = index.files.error ?? index.symbols.error ?? index.edges.error;
  if (graphError) return unchanged('index-unavailable', graphError);
  const resolvedAnchors = anchors ?? resolveEntityAnchors(task, index);
  const bareSymbolQuery = resolvedAnchors.size > 0 && String(task ?? '').trim().split(/\s+/).length === 1;
  if (hasTier1Anchor(resolvedAnchors) || bareSymbolQuery) return unchanged('exact-anchor');
  const sources = feedbackSources(original, index.edges, index.files.length);
  if (!sources.length) return unchanged('no-feedback-sources');
  const paths = sources.map(({ path }) => path);
  const evidence = fts === undefined ? await readFeedback(root, paths) : overlayFeedback(fts, paths);
  if (evidence.error) return unchanged('index-unavailable', evidence.error);
  const expansion = scoreTerms(task, sources, evidence, method);
  if (!expansion.length) return unchanged('no-feedback-terms');

  const { results, error } = fts === undefined
    ? await readSqliteBatch(root, expansion.map(({ term }) => fieldSearchStatement([term])))
    : { results: expansion.map(({ term }) => scoreFtsBm25F(fts, term)), error: null };
  if (!results || error) return unchanged('index-unavailable', error);
  return { ranking: interpolate(original, expansion, results), expansion, reason: null, error: null };
}
