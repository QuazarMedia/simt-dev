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

/** Mirrors FTS5's weighted phrase frequencies and unweighted document lengths. */
export function scoreFtsBm25F(rows, task, { limit = 200 } = {}) {
  const terms = fieldQueryTerms(task);
  if (!terms.length || !rows.length) return [];
  const positions = new Map(terms.map((word, index) => [word, index]));
  const documentFrequency = new Uint32Array(terms.length);
  let totalLength = 0;
  const docs = rows.map((row) => {
    const frequencies = new Float64Array(terms.length);
    let length = 0;
    for (let field = 0; field < BM25F_FIELDS.length; field += 1) {
      const tokens = (row[BM25F_FIELDS[field]] ?? '').split(' ');
      for (const word of tokens) {
        if (word === '') continue;
        length += 1;
        const index = positions.get(word);
        if (index !== undefined) frequencies[index] += BM25F_WEIGHTS[field];
      }
    }
    for (let index = 0; index < terms.length; index += 1) {
      if (frequencies[index] > 0) documentFrequency[index] += 1;
    }
    totalLength += length;
    return { row, length, frequencies };
  });
  const average = totalLength / rows.length || 1;
  const idf = Array.from(documentFrequency, (count) => {
    const weight = Math.log((rows.length - count + 0.5) / (count + 0.5));
    return weight > 0 ? weight : 1e-6;
  });
  const hits = [];
  for (const { row, length, frequencies } of docs) {
    const norm = 1.2 * (1 - 0.75 + 0.75 * length / average);
    let score = 0;
    for (let index = 0; index < terms.length; index += 1) {
      const frequency = frequencies[index];
      if (frequency > 0) score += idf[index] * (frequency * 2.2) / (frequency + norm);
    }
    if (score > 0) hits.push({ kind: row.kind ?? 'code', path: row.ref ?? row.path, score });
  }
  return bestFieldHits(hits, limit);
}
