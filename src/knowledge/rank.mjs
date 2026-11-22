// Authority-aware ranking: prefer evidence that applies over the page everybody links to.
//
// A lexical score answers "which text talks about this" and nothing else. A hub page that
// mentions every term, a copy of the source that mentions them again, and an obsolete page
// that used to be right all rank above the one current source, and the reader has no way to
// see why. So the order is decided in three passes, and each pass is explainable:
//
//   * Filter first. A unit whose permission the query does not hold, or whose declared scope
//     conflicts with the question, is out before it is scored. A unit with no scope where the
//     question names one is `unknown-scope`: a separate result class, because dropping it
//     silently and ranking it as if it applied are both wrong.
//   * Score in named parts. Lexical coverage, declared authority, evidence count and a
//     penalty for derived copies, stale lineage and boilerplate hubs. `scoreFrom` recomputes
//     the total from the parts, so a report can be checked rather than believed.
//   * Break ties visibly. Equal totals fall back to authority, then lexical coverage, then
//     path and id, and both hits name the values the fallback compared.
//
// A heavily linked obsolete page can still be retrieved - it may be the only thing that
// discusses the question - but it carries the `obsolete` or `boilerplate-hub` label and a
// penalty, so it cannot quietly outrank the source that applies.

import { fieldProximity, fieldQueryTerms, fieldTokens, queryPairs, scoreFieldRows } from '../index/bm25f.mjs';
import { smoothedIdf } from '../index/lexical.mjs';
import { cmp } from '../util/sort.mjs';
import { extractClaims } from './claims.mjs';
import { satisfiesScope } from './validity.mjs';

export const RANK_SCHEMA_VERSION = 1;

/** The weights a total is made of. Exported so a report can name them. */
export const RANK_WEIGHTS = Object.freeze({ lexical: 100, authority: 10, evidence: 5 });

/** What each label costs. A stale copy loses to a fresh original at equal lexical coverage. */
export const PENALTIES = Object.freeze({ derived: 20, stale: 25, hub: 10 });

/** Links below this are normal for a page; above it the excess is a hub penalty. */
const HUB_FLOOR = 20;

const TOKEN = /[\p{L}\p{N}]+/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

const isText = (value) => typeof value === 'string' && value.length > 0;

/**
 * The query terms, folded once.
 *
 * NFKC then lower case, and a CJK run becomes single characters: a Japanese term has no
 * spaces to split on, so a run kept whole would never match a shorter one. Latin runs stay
 * whole, so `rate` does not match `rates` by accident.
 */
export function queryTerms(text) {
  const out = new Set();
  for (const run of String(text ?? '').normalize('NFKC').toLowerCase().match(TOKEN) ?? []) {
    if (CJK.test(run)) for (const char of run) out.add(char);
    else out.add(run);
  }
  return [...out];
}

/** The share of query terms a unit's own text carries. */
function coverage(terms, text) {
  if (terms.length === 0) return 0;
  const haystack = new Set((String(text ?? '').normalize('NFKC').toLowerCase().match(TOKEN) ?? []).flatMap((run) => (CJK.test(run) ? [...run] : [run])));
  let hits = 0;
  for (const term of terms) if (haystack.has(term)) hits += 1;
  return hits / terms.length;
}

function lexicalCoverage(unit, terms) {
  const text = `${Array.isArray(unit.headings) ? unit.headings.join(' ') : ''} ${unit.text ?? ''}`;
  const body = coverage(terms, text);
  if (!isText(unit.label)) return body;
  const label = coverage(terms, unit.label);
  // An incidental mention can match every term in a long section. Give the source's
  // own name equal weight so it can compete with sections that merely refer to it.
  return (body + label) / 2;
}

const KNOWLEDGE_FIELDS = ['label', 'headings', 'claims', 'body'];
const KNOWLEDGE_WEIGHTS = [10, 2.5, 6, 1];

function claimText(unit) {
  const claims = Array.isArray(unit.claims) ? unit.claims : extractClaims(unit.text).claims;
  return claims.flatMap((claim) => typeof claim === 'string' ? [claim]
    : [claim?.id, claim?.subject, claim?.predicate, claim?.value, claim?.unit]
      .filter((field) => typeof field === 'string' || typeof field === 'number')).join(' ');
}

function knowledgeFields(unit, ref) {
  return {
    ref,
    label: fieldTokens(unit.label),
    headings: fieldTokens(Array.isArray(unit.headings) ? unit.headings.join(' ') : ''),
    claims: fieldTokens(claimText(unit)),
    body: fieldTokens(unit.text),
  };
}

function fieldedKnowledgeScores(units, query, terms) {
  if (!terms.length || !units.length) return [];
  const rows = units.map(knowledgeFields);
  const scores = scoreFieldRows(rows, terms, { columns: KNOWLEDGE_FIELDS, weights: KNOWLEDGE_WEIGHTS, idf: smoothedIdf });
  const top = scores.reduce((best, score) => Math.max(best, score), 0);
  if (top === 0) return scores;
  const pairs = queryPairs(query);
  const proximity = fieldProximity(rows, pairs, { fields: KNOWLEDGE_FIELDS });
  const combined = scores.map((score, row) => score / top + (pairs.length ? 0.15 * (proximity.get(row)?.size ?? 0) / pairs.length : 0));
  const highest = combined.reduce((best, score) => Math.max(best, score), 0);
  return combined.map((score) => Math.round(score / highest * 1e6) / 1e6);
}

function matchesFielded(unit, terms) {
  const fields = knowledgeFields(unit, null);
  const tokens = new Set(KNOWLEDGE_FIELDS.flatMap((field) => fields[field].split(' ')));
  return terms.some((term) => tokens.has(term));
}

/** Apply the same scope and permission rules to scored and exact lookup. */
export function rankEligibility({ scope = {}, permissions = null } = {}) {
  const required = Object.entries(scope ?? {}).filter(([, value]) => value !== undefined && value !== null);
  const allowed = Array.isArray(permissions) ? new Set(permissions) : null;
  return (unit) => {
    if (allowed !== null && isText(unit.permission) && !allowed.has(unit.permission)) return 'permission';
    const relation = satisfiesScope(unit.scope, required);
    return relation === 'conflict' ? 'scope-mismatch' : relation === 'unknown' ? 'unknown-scope' : null;
  };
}

/**
 * The total, from its parts.
 *
 * One function, used by the scorer and by every explanation, so a recomputation cannot
 * disagree with the score it is explaining.
 */
export function scoreFrom(components) {
  return (
    components.lexical * RANK_WEIGHTS.lexical +
    components.authority * RANK_WEIGHTS.authority +
    components.evidence * RANK_WEIGHTS.evidence -
    components.penalty
  );
}

function labelsOf(unit, hubPenalty) {
  const labels = [];
  if (unit.derived === true) labels.push('derived-copy');
  if (unit.stale === true) labels.push('obsolete');
  if (hubPenalty > 0) labels.push('boilerplate-hub');
  for (const conflict of Array.isArray(unit.conflictsWith) ? unit.conflictsWith : []) {
    if (conflict?.kind === 'contradicts') labels.push('conflicting');
    if (conflict?.kind === 'supersedes') labels.push('obsolete');
  }
  return [...new Set(labels)];
}

function scoreOf(unit, lexical, maxAuthority) {
  const authority = Math.min(1, Math.max(0, Number(unit.authority) || 0) / maxAuthority);
  const evidence = Math.min(1, Math.max(0, Number(unit.evidence) || 0) / 3);
  const links = Math.max(0, Number(unit.links) || 0);
  const hubPenalty = links > HUB_FLOOR ? Math.min(PENALTIES.hub, (links - HUB_FLOOR) / 10) : 0;
  const penalty =
    (unit.derived === true ? PENALTIES.derived : 0) + (unit.stale === true ? PENALTIES.stale : 0) + hubPenalty;
  const components = { lexical, authority, evidence, penalty };
  return {
    id: unit.id ?? null,
    path: unit.path ?? null,
    language: unit.language ?? null,
    kind: unit.kind ?? null,
    labels: labelsOf(unit, hubPenalty),
    components,
    score: scoreFrom(components),
  };
}

/** Score first, then authority, then coverage, then path and id: the whole order is data. */
function compare(a, b, compareText) {
  return (
    b.score - a.score ||
    b.components.authority - a.components.authority ||
    b.components.lexical - a.components.lexical ||
    compareText(String(a.path ?? ''), String(b.path ?? '')) ||
    compareText(String(a.id ?? ''), String(b.id ?? ''))
  );
}

const publicHit = (hit) => ({
  id: hit.id,
  path: hit.path,
  language: hit.language,
  kind: hit.kind,
  score: hit.score,
  components: hit.components,
  labels: hit.labels,
  authority: hit.components.authority,
});

/**
 * Rank the units a question may use.
 *
 * @param {{id?: string, path?: string, kind?: string, language?: string, text?: string, headings?: string[], label?: string, scope?: object|null, authority?: number, evidence?: number, links?: number, derived?: boolean, stale?: boolean, permission?: string, conflictsWith?: {id: string, kind: string}[]}[]} units
 * @param {{query?: string, scope?: object, permissions?: string[]|null, limit?: number, retrieval?: 'v1'|'v2'}} [options]
 * @returns {object}
 */
export function rank(units = [], { query = '', scope = {}, permissions = null, limit = 10, retrieval = 'v1' } = {}) {
  const fielded = retrieval === 'v2';
  const terms = fielded ? fieldQueryTerms(query) : queryTerms(query);
  const compareText = fielded ? cmp : (a, b) => a.localeCompare(b);
  const classify = rankEligibility({ scope, permissions });
  const eligible = [];
  const unknownScope = [];
  const excluded = [];

  for (const unit of Array.isArray(units) ? units : []) {
    const reason = classify(unit);
    if (reason === 'unknown-scope') {
      if (fielded ? matchesFielded(unit, terms) : lexicalCoverage(unit, terms) > 0) {
        unknownScope.push({ id: unit.id ?? null, path: unit.path ?? null, class: reason });
      }
      continue;
    }
    if (reason !== null) {
      excluded.push({ id: fielded ? null : unit.id ?? null, reason });
      continue;
    }
    eligible.push(unit);
  }

  const maxAuthority = eligible.reduce((top, unit) => Math.max(top, Number(unit.authority) || 0), 1);
  const lexical = fielded ? fieldedKnowledgeScores(eligible, query, terms) : eligible.map((unit) => lexicalCoverage(unit, terms));
  const scored = eligible.map((unit, index) => scoreOf(unit, lexical[index] ?? 0, maxAuthority))
    .filter((hit) => hit.components.lexical > 0).sort((a, b) => compare(a, b, compareText));
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : scored.length;
  const seen = new Set();
  const ranked = fielded ? scored.filter(({ path }) => {
    if (path == null) return true;
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  }) : scored;

  return {
    version: RANK_SCHEMA_VERSION,
    query,
    ranked: ranked.slice(0, cap).map(publicHit),
    unknownScope: unknownScope.sort((a, b) => compareText(String(a.path), String(b.path)) || (fielded ? cmp(String(a.id), String(b.id)) : 0)),
    excluded: fielded ? excluded.sort((a, b) => cmp(a.reason, b.reason)) : excluded,
    ...(fielded ? { retrieval } : {}),
    embeddings: 'off',
    weights: RANK_WEIGHTS,
  };
}

/**
 * Recall@k by hand-labelled query, reported per language and per artifact kind.
 *
 * The strata are not decoration: a pooled average is how a language with one query and no
 * hits disappears behind nine that found theirs. Every stratum carries its own denominator,
 * and a miss is listed with what was retrieved instead.
 *
 * @param {object[]} units
 * @param {{query: string, gold: string[], scope?: object, permissions?: string[]|null}[]} corpus
 * @param {{limit?: number, retrieval?: 'v1'|'v2'}} [options]
 */
export function evaluateRank(units = [], corpus = [], { limit = 10, retrieval = 'v1' } = {}) {
  const byId = new Map((Array.isArray(units) ? units : []).map((unit) => [unit.id, unit]));
  const strata = { byLanguage: new Map(), byKind: new Map() };
  const failures = [];
  let gold = 0;
  let hits = 0;

  const bump = (map, key, found) => {
    if (!map.has(key)) map.set(key, { key, queries: 0, gold: 0, hits: 0 });
    const row = map.get(key);
    row.gold += 1;
    if (found) row.hits += 1;
  };

  for (const entry of Array.isArray(corpus) ? corpus : []) {
    const result = rank(units, { query: entry.query, scope: entry.scope ?? {}, permissions: entry.permissions ?? null, limit, retrieval });
    const ranked = new Set(result.ranked.map((hit) => hit.id));
    const unplaceable = new Set(result.unknownScope.map((hit) => hit.id));
    const expected = Array.isArray(entry.gold) ? entry.gold : [];
    const found = expected.filter((id) => ranked.has(id));
    gold += expected.length;
    hits += found.length;
    const languages = new Set();
    const kinds = new Set();
    for (const id of expected) {
      const unit = byId.get(id);
      const language = unit?.language ?? 'unknown';
      const kind = unit?.kind ?? 'unknown';
      languages.add(language);
      kinds.add(kind);
      bump(strata.byLanguage, language, ranked.has(id));
      bump(strata.byKind, kind, ranked.has(id));
    }
    // One corpus entry is one query in each stratum it reaches, however many gold ids it
    // names; counting gold ids inflated the denominator a recall is read against (A46).
    for (const key of languages) strata.byLanguage.get(key).queries += 1;
    for (const key of kinds) strata.byKind.get(key).queries += 1;
    if (found.length < expected.length) {
      failures.push({
        query: entry.query,
        missed: expected.filter((id) => !ranked.has(id)),
        unplaceable: expected.filter((id) => unplaceable.has(id)),
        top: result.ranked.slice(0, 3).map((hit) => hit.id),
      });
    }
  }

  const rows = (map) =>
    [...map.values()].sort((a, b) => a.key.localeCompare(b.key)).map((row) => ({ ...row, recall: row.gold === 0 ? null : row.hits / row.gold }));

  return {
    version: RANK_SCHEMA_VERSION,
    queries: Array.isArray(corpus) ? corpus.length : 0,
    gold,
    hits,
    recallAt10: gold === 0 ? null : hits / gold,
    byLanguage: rows(strata.byLanguage),
    byKind: rows(strata.byKind),
    failures,
    embeddings: 'off',
  };
}
