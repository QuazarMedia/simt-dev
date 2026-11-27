import { tokenizeIdentifiers } from '../text/identifiers.mjs';
import { STOPWORDS } from '../text/tokens.mjs';
import { cmp } from '../util/sort.mjs';

export const LEGACY_BM25F_FIELDS = Object.freeze([
  'path_tokens', 'symbol_names', 'qual_names', 'signatures', 'headings', 'body',
]);
export const LEGACY_BM25F_WEIGHTS = Object.freeze([3, 10, 6, 3.5, 2.5, 1]);
export const BM25F_FIELDS = Object.freeze([
  'path_tokens', 'symbol_names', 'qual_names', 'signatures', 'headings', 'body', 'invocations', 'string_literals',
]);
export const BM25F_WEIGHTS = Object.freeze([3, 10, 6, 3.5, 2.5, 1, 1.8, 2.2]);
export const BM25F_B = Object.freeze({
  path_tokens: 0.35,
  symbol_names: 0.35,
  qual_names: 0.40,
  signatures: 0.50,
  headings: 0.50,
  body: 0.75,
  invocations: 0.45,
  string_literals: 0.40,
});

export function fieldTokens(text) {
  return tokenizeIdentifiers(text).map(({ token }) => token.replaceAll('ς', 'σ')).join(' ');
}

export function fieldQueryTokenRoles(task) {
  const roles = new Map();
  for (const { token: raw, role } of tokenizeIdentifiers(task)) {
    const token = raw.replaceAll('ς', 'σ');
    if (!token || STOPWORDS.has(token)) continue;
    const prev = roles.get(token);
    if (!prev || role === 'exact') roles.set(token, role);
  }
  return [...roles.entries()].map(([token, role]) => ({ token, role })).slice(0, 48);
}

export function fieldQueryTerms(task) {
  return fieldQueryTokenRoles(task).map(({ token }) => token);
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

function bm25PlusIdf(documents, count) {
  return Math.log(1 + (documents - count + 0.5) / (count + 0.5));
}

/** Per-field Robertson-Zaragoza BM25F with exact/part identifier role boost. */
export function scoreFieldRows(rows, terms, {
  columns = BM25F_FIELDS, weights = BM25F_WEIGHTS, fields = columns,
  bParams = BM25F_B, roles = null, stats = null, idf = bm25PlusIdf,
} = {}) {
  const positions = new Map(terms.map((word, index) => [word, index]));
  const documentFrequency = new Uint32Array(terms.length);
  const active = columns.map((name) => fields.includes(name));
  const fieldB = columns.map((name) => bParams[name] ?? 0.75);
  const totalLengths = new Float64Array(columns.length);
  const docs = rows.map((row) => {
    const fieldLengths = new Float64Array(columns.length);
    const fieldTfs = Array.from({ length: columns.length }, () => new Float64Array(terms.length));
    const matched = new Uint8Array(terms.length);
    for (let field = 0; field < columns.length; field += 1) {
      let length = 0;
      for (const word of (row[columns[field]] ?? '').split(' ')) {
        if (word === '') continue;
        length += 1;
        const index = active[field] ? positions.get(word) : undefined;
        if (index !== undefined) {
          fieldTfs[field][index] += 1;
          matched[index] = 1;
        }
      }
      fieldLengths[field] = length;
      totalLengths[field] += length;
    }
    for (let index = 0; index < terms.length; index += 1) {
      if (matched[index]) documentFrequency[index] += 1;
    }
    return { fieldLengths, fieldTfs };
  });
  const docCount = stats?.N ?? rows.length;
  const avgdl = columns.map((name, field) => stats?.avgdl?.[name] ?? (totalLengths[field] / rows.length || 1));
  const rarity = Array.from({ length: terms.length }, (_, index) =>
    idf(docCount, stats?.df?.[index] ?? documentFrequency[index]));
  const k1 = 1.2;
  return docs.map(({ fieldLengths, fieldTfs }) => {
    let score = 0;
    for (let index = 0; index < terms.length; index += 1) {
      const roleMult = roles?.[index] === 'exact' ? 1.4 : 1.0;
      let tfNorm = 0;
      for (let field = 0; field < columns.length; field += 1) {
        if (!active[field]) continue;
        const tf = fieldTfs[field][index];
        if (tf <= 0) continue;
        const b = fieldB[field];
        const denom = (1 - b) + b * (fieldLengths[field] / (avgdl[field] || 1));
        tfNorm += weights[field] * roleMult * (tf / denom);
      }
      if (tfNorm > 0) score += rarity[index] * ((tfNorm * (k1 + 1)) / (tfNorm + k1));
    }
    return score;
  });
}

/** Score fielded rows with per-field BM25F and exact/part token roles. */
export function scoreFtsBm25F(rows, task, { limit = FIELD_RESULT_LIMIT, fields = BM25F_FIELDS, stats = null } = {}) {
  const tokenRoles = fieldQueryTokenRoles(task);
  if (!tokenRoles.length || !rows.length) return [];
  const terms = tokenRoles.map(({ token }) => token);
  const roles = tokenRoles.map(({ role }) => role);
  const scores = scoreFieldRows(rows, terms, { fields, roles, stats });
  const hits = rows.flatMap((row, index) => scores[index] > 0
    ? [{ kind: row.kind ?? 'code', path: row.ref ?? row.path, score: scores[index] }] : []);
  return bestFieldHits(hits, limit);
}

export const FIELD_RESULT_LIMIT = 200;

/** Fetch candidate fielded rows from SQLite for per-field BM25F rescoring. */
export function fieldCandidateStatement(terms, fields = BM25F_FIELDS, limit = 400, {
  columns = BM25F_FIELDS, weights = BM25F_WEIGHTS,
} = {}) {
  const phrases = terms.map(ftsQuote).join(' OR ');
  const activeFields = fields.filter((name) => columns.includes(name));
  const match = activeFields.length === columns.length ? phrases : `{${activeFields.join(' ')}} : (${phrases})`;
  return [
    `select f.kind, substr(n.key, 6) as ref,
       ${columns.map((field) => `f.${field}`).join(', ')}
     from fts f join nodes n on n.id = f.node_id
     where fts match ? and (select value from meta where key = 'fts_fields') = '1'
     order by -bm25(fts, ${weights.join(', ')}) desc, ref asc, f.rowid asc
     limit ?`,
    [match, limit],
  ];
}

/** Collapse sections in SQL before applying the path result cap. */
export function fieldSearchStatement(terms, fields = BM25F_FIELDS, {
  columns = BM25F_FIELDS, weights = BM25F_WEIGHTS,
} = {}) {
  const phrases = terms.map(ftsQuote).join(' OR ');
  const activeFields = fields.filter((name) => columns.includes(name));
  const match = activeFields.length === columns.length ? phrases : `{${activeFields.join(' ')}} : (${phrases})`;
  return [
    `with hits as materialized (
       select f.kind, substr(n.key, 6) as path, f.rowid as section,
         -bm25(fts, ${weights.join(', ')}) as score
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
