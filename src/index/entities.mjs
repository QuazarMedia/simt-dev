import { foldIdentifierText } from '../text/identifiers.mjs';
import { STOPWORDS } from '../text/tokens.mjs';
import { cmp } from '../util/sort.mjs';
import {
  BM25F_FIELDS, fieldProximity, fieldQueryTerms, ftsQuote, PHRASE_WINDOW, queryPairs,
} from './bm25f.mjs';
import { readSqliteBatch } from './persist.mjs';
import { readGraph, searchFtsBm25F } from './store.mjs';

const TERM = /\x60([^\x60\r\n]+)\x60|"([^"\r\n]+)"|(?:\.\/|\.{2}\/|\/)?[\p{L}\p{N}_$-]+(?:(?:[./]|::)[\p{L}\p{N}_$-]+)*/gu;
const METADATA = BM25F_FIELDS.filter((name) => name !== 'body');
const BODY = ['body'];

function queryEntities(task) {
  return [...new Set([...String(task ?? '').normalize('NFKC').matchAll(TERM)].map(([match, code, quoted]) =>
    (code ?? quoted ?? match).trim().replace(/^\.\//, '')))];
}

const entityKey = (value) => foldIdentifierText(value).toLowerCase();

function add(map, key, value) {
  const bucket = map.get(key) ?? [];
  bucket.push(value);
  map.set(key, bucket);
}

function entityDirectory(files, symbols) {
  const paths = new Map();
  const names = new Map();
  for (const path of new Set(files.map((file) => typeof file === 'string' ? file : file.path))) {
    const parts = entityKey(path).split('/');
    for (let index = 0; index < parts.length; index += 1) add(paths, parts.slice(index).join('/'), path);
  }
  for (const symbol of symbols) {
    if (!symbol.name || !symbol.path) continue;
    const qualified = symbol.qualname ?? symbol.qualifiedName;
    add(names, entityKey(symbol.name), { path: symbol.path, name: symbol.name, qualified: false });
    if (qualified && qualified !== symbol.name) {
      add(names, entityKey(qualified).replaceAll('::', '.'), { path: symbol.path, name: qualified, qualified: true });
    }
  }
  return { paths, names };
}

function selectByDirectory(paths, context, current) {
  const candidates = [...new Set(paths)];
  if (candidates.length < 2) return candidates[0];
  const scored = candidates.map((path) => {
    const slash = path.lastIndexOf('/');
    const terms = slash < 0 ? [] : fieldQueryTerms(path.slice(0, slash));
    return { path, score: terms.filter((word) => (context.get(word) ?? 0) > Number(current.has(word))).length };
  }).sort((a, b) => b.score - a.score || cmp(a.path, b.path));
  return scored[0].score > scored[1].score ? scored[0].path : undefined;
}

export function createEntityResolver({ files = [], symbols = [] } = {}) {
  const directory = entityDirectory(files, symbols);
  return (task, { context = '' } = {}) => resolveAnchors(task, directory, context);
}

export function resolveEntityAnchors(task, graph) {
  return createEntityResolver(graph)(task);
}

function resolveAnchors(task, { paths, names }, shared) {
  const terms = queryEntities(task);
  const contexts = terms.map((term) => new Set(fieldQueryTerms(term)));
  const context = new Map(fieldQueryTerms(shared).map((word) => [word, 1]));
  for (const words of contexts) {
    for (const word of words) context.set(word, (context.get(word) ?? 0) + 1);
  }
  const results = new Map();
  for (const [index, raw] of terms.entries()) {
    const key = entityKey(raw);
    const matching = paths.get(key) ?? [];
    const exact = matching.find((path) => path === raw);
    const exactFold = matching.filter((path) => entityKey(path) === key);
    const path = exact ?? selectByDirectory(exactFold.length ? exactFold : matching, context, contexts[index]);
    if (path) {
      const hits = results.get(path) ?? [];
      hits.push({ kind: entityKey(path) === key ? 'path' : 'suffix', query: raw, matched: path });
      results.set(path, hits);
    }

    if (STOPWORDS.has(key)) continue;
    const symbols = names.get(key.replaceAll('::', '.')) ?? [];
    const caseMatches = symbols.filter(({ name }) => name.replaceAll('::', '.') === raw.replaceAll('::', '.'));
    const candidates = caseMatches.length ? caseMatches : symbols;
    const target = selectByDirectory(candidates.map(({ path }) => path), context, contexts[index]);
    if (!target) continue;
    const hits = results.get(target) ?? [];
    for (const symbol of candidates.filter(({ path }) => path === target)) {
      const kind = symbol.qualified ? 'qualified-symbol' : 'symbol';
      if (!hits.some((hit) => hit.kind === kind && hit.query === raw && hit.matched === symbol.name)) {
        hits.push({ kind, query: raw, matched: symbol.name });
      }
    }
    results.set(target, hits);
  }
  return new Map([...results].sort(([a], [b]) => cmp(a, b)).map(([path, hits]) => [path,
    hits.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.query, b.query) || cmp(a.matched, b.matched)),
  ]));
}

const round = (value) => Math.round(value * 1e6) / 1e6;
const ANCHOR_POINTS = Object.freeze({ path: 4, suffix: 3, 'qualified-symbol': 2, symbol: 1.5 });

function normalizeHits(rows) {
  const highest = rows.reduce((top, row) => Math.max(top, row.score), 0);
  return new Map(rows.map(({ path, score }) => [path, highest > 0 ? score / highest : 0]));
}

function fuseEntitySignals(anchors, metadata, body, proximity, pairs) {
  const fieldsByPath = normalizeHits(metadata);
  const bodyByPath = normalizeHits(body);
  const paths = new Set([...anchors.keys(), ...fieldsByPath.keys(), ...bodyByPath.keys(), ...proximity.keys()]);
  return [...paths].map((path) => {
    const matches = anchors.get(path) ?? [];
    const pathScore = Math.max(0, ...matches.filter(({ kind }) => kind === 'path' || kind === 'suffix')
      .map(({ kind }) => ANCHOR_POINTS[kind]));
    const symbolScore = Math.max(0, ...matches.filter(({ kind }) => kind === 'symbol' || kind === 'qualified-symbol')
      .map(({ kind }) => ANCHOR_POINTS[kind]));
    const phrase = [...(proximity.get(path) ?? [])].sort((a, b) => a - b).map((index) => pairs[index]);
    const components = {
      path: pathScore, symbol: symbolScore,
      bm25f: round(fieldsByPath.get(path) ?? 0),
      proximity: round(pairs.length ? 0.75 * phrase.length / pairs.length : 0),
      section: round((bodyByPath.get(path) ?? 0) * 0.5),
    };
    const tier = pathScore ? 1 : symbolScore ? 2 : components.bm25f || components.proximity ? 3 : 4;
    const score = Object.values(components).reduce((total, value) => total + value, 0);
    return { path, tier, score, components, matches, phrase };
  }).sort((a, b) => a.tier - b.tier || b.score - a.score || cmp(a.path, b.path));
}

async function nativeProximity(root, pairs) {
  if (!pairs.length) return { hits: new Map(), error: null };
  const queries = pairs.map(([left, right]) => [
    `select distinct substr(n.key, 6) as path from fts f join nodes n on n.id = f.node_id
      where fts match ? and (select value from meta where key = 'fts_fields') = '1'`,
    [`NEAR(${ftsQuote(left)} ${ftsQuote(right)}, ${PHRASE_WINDOW})`],
  ]);
  const { results, error } = await readSqliteBatch(root, queries);
  const hits = new Map();
  for (const [index, rows] of (results ?? []).entries()) {
    for (const { path } of rows) {
      const matches = hits.get(path) ?? new Set();
      matches.add(index);
      hits.set(path, matches);
    }
  }
  return { hits, error };
}

export function exactEntityCandidates(task, graph) {
  const anchors = resolveEntityAnchors(task, graph);
  const candidates = fuseEntitySignals(anchors, [], [], new Map(), []);
  return { anchors, candidates };
}

/** Rank from an already-built index, or from explicit fielded rows for live overlays. */
export async function searchEntityCandidates(root, task, { files, symbols, fts } = {}) {
  const pairs = queryPairs(task);
  const [graph, metadata, body, proximity] = await Promise.all([
    files && symbols ? { files, symbols } : readGraph(root),
    searchFtsBm25F(root, task, { fts, fields: METADATA }),
    searchFtsBm25F(root, task, { fts, fields: BODY }),
    fts === undefined ? nativeProximity(root, pairs) : { hits: fieldProximity(fts, pairs), error: fts.error },
  ]);
  const anchors = resolveEntityAnchors(task, graph);
  return {
    anchors,
    candidates: fuseEntitySignals(anchors, metadata, body, proximity.hits, pairs),
    error: graph.files.error ?? graph.symbols.error ?? metadata.error ?? body.error ?? proximity.error ?? null,
  };
}
