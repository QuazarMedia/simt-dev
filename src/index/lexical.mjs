import { INDEX_STOP, STOPWORDS } from '../text/tokens.mjs';
import { cmp } from '../util/sort.mjs';
import { BM25F_FIELDS, fieldQueryTerms } from './bm25f.mjs';

export const SIGNATURE_TERMS = 40;

export function smoothedIdf(documents, frequency) {
  if (frequency < 0 || documents < frequency) throw new RangeError('invalid document frequency');
  return Math.log1p((documents - frequency + 0.5) / (frequency + 0.5));
}

/** Section boundaries do not turn one file into several lexical documents. */
export function collectFileTerms(sections) {
  const files = new Map();
  for (const row of sections) {
    const path = row.ref ?? row.path;
    const terms = files.get(path) ?? new Map();
    for (const field of BM25F_FIELDS) {
      if (!row[field]) continue;
      for (const term of row[field].split(' ')) {
        if (term && !STOPWORDS.has(term) && !INDEX_STOP.has(term)) {
          terms.set(term, (terms.get(term) ?? 0) + 1);
        }
      }
    }
    files.set(path, terms);
  }
  return files;
}

function termWeight(term, tf, { documents, terms }) {
  return Math.log1p(tf) * smoothedIdf(documents, terms.get(term)?.df ?? 0);
}

export function topFileSignature(counts, stats, { limit = SIGNATURE_TERMS } = {}) {
  return [...counts].map(([term, tf]) => ({ term, weight: termWeight(term, tf, stats) }))
    .sort((a, b) => b.weight - a.weight || cmp(a.term, b.term)).slice(0, limit);
}

export function rankByLexicalTerms(files, task, stats) {
  const terms = fieldQueryTerms(task).sort(cmp);
  const candidates = [];
  for (const [path, counts] of files) {
    const matches = terms.filter((term) => counts.has(term)).map((term) => ({
      term, weight: termWeight(term, counts.get(term), stats),
    }));
    const score = matches.reduce((sum, { weight }) => sum + weight, 0);
    if (score > 0) candidates.push({ path, score, matches });
  }
  return candidates.sort((a, b) => b.score - a.score || cmp(a.path, b.path));
}

/** Accumulating in term order keeps floating-point ties independent of file order. */
export function sparseTfIdfCosine(first, second) {
  const order = (a, b) => cmp(a.term, b.term);
  const a = [...first].sort(order);
  const b = [...second].sort(order);
  const weights = new Map(b.map(({ term, weight }) => [term, weight]));
  const dot = a.reduce((sum, { term, weight }) => sum + weight * (weights.get(term) ?? 0), 0);
  const norm = (rows) => Math.sqrt(rows.reduce((sum, { weight }) => sum + weight * weight, 0));
  const denominator = norm(a) * norm(b);
  return denominator > 0 ? Math.min(1, dot / denominator) : 0;
}

export function* conceptualPartners(rows, sources, { exclude = new Set() } = {}) {
  const files = collectFileTerms(rows);
  const frequencies = new Map();
  for (const terms of files.values()) {
    for (const term of terms.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  const stats = { documents: files.size, terms: new Map([...frequencies].map(([term, df]) => [term, { df }])) };
  const signatures = [...sources].sort(cmp).map((path) => [path, topFileSignature(files.get(path) ?? [], stats)]);
  const vocabulary = new Set(signatures.flatMap(([, signature]) => signature.map(({ term }) => term)));
  if (!vocabulary.size) return;
  for (const [path, counts] of files) {
    if (sources.has(path) || exclude.has(path) || [...counts.keys()].every((term) => !vocabulary.has(term))) continue;
    const signature = topFileSignature(counts, stats);
    for (const [source, anchor] of signatures) {
      const score = sparseTfIdfCosine(anchor, signature);
      if (score > 0) yield { path, source, score };
    }
  }
}
