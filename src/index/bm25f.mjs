import { tokenizeIdentifiers } from '../text/identifiers.mjs';
import { STOPWORDS } from '../text/tokens.mjs';
import { cmp } from '../util/sort.mjs';

export const BM25F_FIELDS = Object.freeze(['path_tokens', 'symbol_names', 'qual_names', 'signatures', 'headings', 'body']);
export const BM25F_WEIGHTS = Object.freeze([3, 10, 6, 3.5, 2.5, 1]);

export function fieldTokens(text) {
  return tokenizeIdentifiers(text).map(({ token }) => token.replaceAll('ς', 'σ')).join(' ');
}

export function fieldQueryTerms(task) {
  return [...new Set(fieldTokens(task).split(' ').filter((word) => word && !STOPWORDS.has(word)))].slice(0, 48);
}

export const PHRASE_WINDOW = 8;

export function queryPairs(task) {
  const words = fieldTokens(task).split(' ').filter((word) => word && !STOPWORDS.has(word)).slice(0, 48);
  const pairs = new Map();
  for (let index = 1; index < words.length && pairs.size < 8; index += 1) {
    const pair = [words[index - 1], words[index]];
    pairs.set(pair.join(' '), pair);
  }
  return [...pairs.values()];
}

export function fieldProximity(rows, pairs, { fields = BM25F_FIELDS } = {}) {
  const hits = new Map();
  if (!pairs.length) return hits;
  const vocabulary = new Set(pairs.flat());
  for (const row of rows) {
    const path = row.ref ?? row.path;
    const found = hits.get(path) ?? new Set();
    for (const field of fields) {
      if (!row[field] || found.size === pairs.length) continue;
      const previous = new Map();
      for (const [position, word] of row[field].split(' ').entries()) {
        if (!vocabulary.has(word)) continue;
        for (const [index, [left, right]] of pairs.entries()) {
          const other = word === left ? right : word === right ? left : null;
          const before = previous.get(other);
          if (before !== undefined && position - before <= PHRASE_WINDOW + 1) found.add(index);
        }
        previous.set(word, position);
      }
    }
    if (found.size) hits.set(path, found);
  }
  return hits;
}

export function ftsQuote(term) {
  return `"${String(term).replaceAll('"', '""')}"`;
}

/** Keep a file's best scoring section. Equal scores use path and then section order. */
export function bestFieldHits(rows, limit = 200) {
  const best = new Map();
  for (const row of rows) {
    const prior = best.get(row.path);
    if (!prior || row.score > prior.score) best.set(row.path, row);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || cmp(a.path, b.path)).slice(0, limit);
}

function sqliteIdf(documents, count) {
  const weight = Math.log((documents - count + 0.5) / (count + 0.5));
  return weight > 0 ? weight : 1e-6;
}

/** Weighted field frequencies with unweighted length normalization. */
export function scoreFieldRows(rows, terms, {
  columns = BM25F_FIELDS, weights = BM25F_WEIGHTS, fields = columns, idf = sqliteIdf,
} = {}) {
  const positions = new Map(terms.map((word, index) => [word, index]));
  const documentFrequency = new Uint32Array(terms.length);
  const active = columns.map((name) => fields.includes(name));
  let totalLength = 0;
  const docs = rows.map((row) => {
    const frequencies = new Float64Array(terms.length);
    let length = 0;
    for (let field = 0; field < columns.length; field += 1) {
      for (const word of (row[columns[field]] ?? '').split(' ')) {
        if (word === '') continue;
        length += 1;
        const index = active[field] ? positions.get(word) : undefined;
        if (index !== undefined) frequencies[index] += weights[field];
      }
    }
    for (let index = 0; index < terms.length; index += 1) {
      if (frequencies[index] > 0) documentFrequency[index] += 1;
    }
    totalLength += length;
    return { length, frequencies };
  });
  const average = totalLength / rows.length || 1;
  const rarity = Array.from(documentFrequency, (count) => idf(rows.length, count));
  return docs.map(({ length, frequencies }) => {
    const norm = 1.2 * (1 - 0.75 + 0.75 * length / average);
    let score = 0;
    for (let index = 0; index < terms.length; index += 1) {
      const frequency = frequencies[index];
      if (frequency > 0) score += rarity[index] * (frequency * 2.2) / (frequency + norm);
    }
    return score;
  });
}

/** Mirrors FTS5's weighted phrase frequencies and unweighted document lengths. */
export function scoreFtsBm25F(rows, task, { limit = FIELD_RESULT_LIMIT, fields = BM25F_FIELDS } = {}) {
  const terms = fieldQueryTerms(task);
  if (!terms.length || !rows.length) return [];
  const scores = scoreFieldRows(rows, terms, { fields });
  const hits = rows.flatMap((row, index) => scores[index] > 0
    ? [{ kind: row.kind ?? 'code', path: row.ref ?? row.path, score: scores[index] }] : []);
  return bestFieldHits(hits, limit);
}

export const FIELD_RESULT_LIMIT = 200;

/** Collapse sections in SQL before applying the path result cap. */
export function fieldSearchStatement(terms, fields = BM25F_FIELDS) {
  const phrases = terms.map(ftsQuote).join(' OR ');
  const match = fields === BM25F_FIELDS ? phrases : `{${fields.join(' ')}} : (${phrases})`;
  return [
    `with hits as materialized (
       select f.kind, substr(n.key, 6) as path, f.rowid as section,
         -bm25(fts, ${BM25F_WEIGHTS.join(', ')}) as score
       from fts f join nodes n on n.id = f.node_id
       where fts match ? and (select value from meta where key = 'fts_fields') = '1'
     ), ranked as (
       select kind, path, score, row_number() over (partition by path order by score desc, section) as position
       from hits
     )
     select kind, path, score from ranked where position = 1
     order by score desc, path asc limit ?`,
    [match, FIELD_RESULT_LIMIT],
  ];
}
