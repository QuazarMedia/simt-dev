// Repository-mode queries: rank and citation lookup over a built corpus (WK05).
//
// The doors already know how to rank units and explain a claim; what they lacked was a way
// to ask a repository directly. This module supplies the data those functions need from the
// corpus `knowledge build` wrote, and nothing else: no filesystem, no clock, no network, so
// the same corpus and question give the same answer on every machine.
//
// Three rules keep the answer honest:
//
//   * Authority is a named basis, never a guess. A section of a reviewed document outranks a
//     declared one, which outranks bare evidence, and every hit says which basis it carries.
//     A section is evidence even in a reviewed document: only a claim marker is a reviewed
//     fact, and ranking does not upgrade it.
//   * Scope and permission filter before scoring, through the same `rank` the file door
//     uses. A wrong-scope unit is excluded by name, an unplaceable one stays a separate
//     class, and nothing is inferred from the query's spelling.
//   * A citation is the unit's own byte range and revision label. An answer that cannot say
//     where it came from, and from which revision, is not an answer a maintainer can open.

import { cmp } from '../util/sort.mjs';
import { EDGE_KINDS } from './claims.mjs';
import { rank, rankEligibility } from './rank.mjs';

/** The declared authority bases, in the order ranking prefers them. */
const AUTHORITY_LEVELS = Object.freeze({ reviewed: 3, declared: 2, evidence: 1 });

const isText = (value) => typeof value === 'string' && value.length > 0;
const unitKey = (unit) => JSON.stringify([unit.path, unit.id]);
const sectionMatches = (unit, id) =>
  unit.id === id || unit.artifact === id || (isText(unit.anchor) && `${unit.path}#${unit.anchor}` === id);

/** The authority basis a unit carries: its artifact's declared metadata, or bare evidence. */
function basisOf(artifact) {
  return artifact?.declared === true && isText(artifact.authority) ? artifact.authority : 'evidence';
}

/** The citation a unit answers with: where it sits, and which revision it was read from. */
export function citationOf(unit, artifact) {
  return {
    artifact: unit.artifact,
    path: unit.path,
    anchor: unit.anchor,
    title: unit.title,
    lineStart: unit.lineStart,
    lineEnd: unit.lineEnd,
    byteStart: unit.byteStart,
    byteEnd: unit.byteEnd,
    revision: unit.revision,
    provenance: unit.provenance,
    authorityBasis: basisOf(artifact),
    scope: artifact?.scope ?? null,
    language: artifact?.language ?? null,
  };
}

/** The corpus units in the shape `rank` scores, with the artifact's declared metadata joined. */
function rankableUnits(corpus, byPath) {
  return (corpus?.units ?? []).map((unit) => {
    const artifact = byPath.get(unit.path);
    const basis = basisOf(artifact);
    return {
      id: unit.id,
      path: unit.path,
      text: unit.text,
      headings: unit.headings,
      label: unit.path?.split('/').at(-1)?.replace(/\.[^.]+$/, ''),
      permission: unit.permission,
      language: artifact?.language ?? null,
      kind: artifact?.type ?? null,
      scope: artifact?.scope ?? null,
      authority: AUTHORITY_LEVELS[basis] ?? AUTHORITY_LEVELS.evidence,
      evidence: Array.isArray(artifact?.claims) ? artifact.claims.length : 0,
    };
  });
}

/**
 * Rank one scope's corpus, with citations joined onto every hit.
 *
 * `exact` is the plain citation lookup: a question that names a unit id, an artifact id or a
 * path is answered with that unit's citation even where lexical coverage is weak. It is a
 * lookup, not a score, so it carries no rank and does not displace one.
 *
 * @param {object} corpus the stored corpus document
 * @param {{query?: string, scope?: object, permissions?: string[]|null, limit?: number, retrieval?: 'v1'|'v2'}} [options]
 * @returns {object}
 */
export function rankCorpus(
  corpus,
  { query = '', scope = {}, permissions = null, limit = 10, retrieval = 'v1', sdm = false, qppFusion = false } = {},
) {
  const byPath = new Map((corpus?.artifacts ?? []).map((artifact) => [artifact.path, artifact]));
  const units = rankableUnits(corpus, byPath);
  const report = rank(units, { query, scope, permissions, limit: Infinity, retrieval, sdm, qppFusion });
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;

  const byId = new Map((corpus?.units ?? []).map((unit) => [unitKey(unit), unit]));
  // Apply the limit to sources so a long document cannot fill the answer with its own sections.
  const bestByPath = new Map();
  for (const hit of report.ranked) {
    if (bestByPath.size >= cap) break;
    if (!bestByPath.has(hit.path)) bestByPath.set(hit.path, hit);
  }
  const ranked = [...bestByPath.values()].map((hit) => {
    const unit = byId.get(unitKey(hit));
    const artifact = unit === undefined ? undefined : byPath.get(unit.path);
    return {
      ...hit,
      authorityBasis: unit === undefined ? null : basisOf(artifact),
      citation: unit === undefined ? null : citationOf(unit, artifact),
    };
  });

  const wanted = String(query).trim();
  const exact = [];
  if (wanted !== '') {
    const classify = rankEligibility({ scope, permissions });
    for (const candidate of units) {
      if (classify(candidate) !== null) continue;
      const unit = byId.get(unitKey(candidate));
      const artifact = byPath.get(unit.path);
      const named = sectionMatches(unit, wanted) || unit.path === wanted || artifact?.id === wanted;
      if (named && !exact.some((entry) => entry.id === unit.id && entry.citation.path === unit.path)) {
        exact.push({ id: unit.id, citation: citationOf(unit, artifact) });
      }
    }
    exact.sort((a, b) => retrieval === 'v2'
      ? cmp(String(a.id), String(b.id)) || cmp(a.citation.path, b.citation.path)
      : String(a.id).localeCompare(String(b.id)));
  }

  const reasons = [];
  if (ranked.length === 0) {
    if (report.excluded.length > 0) reasons.push(`${report.excluded.length} unit(s) were excluded by scope or permission before scoring`);
    if (report.unknownScope.length > 0) reasons.push(`${report.unknownScope.length} matching unit(s) state no scope, so they cannot be ranked as if they applied`);
    if (reasons.length === 0) reasons.push('no indexed section carries the query terms; try the exact id, or rebuild after adding the source');
  }

  return {
    ...report,
    ranked,
    scope: corpus?.scope ?? null,
    where: { ...scope },
    exact: exact.slice(0, cap),
    reasons,
  };
}

/**
 * The claim document `knowledge why` reads, assembled from the corpus.
 *
 * Edges come only from what the documents declared: a resolved, non-proposed source
 * reference is a dependency, and it is reviewed exactly when its document is. A reference
 * that did not resolve at build time is a finding there, not an edge invented here.
 *
 * @param {object} corpus
 * @returns {{claims: object[], artifacts: object[], edges: object[], authority: object[]}}
 */
export function corpusDocument(corpus) {
  const artifacts = corpus?.artifacts ?? [];
  const claims = artifacts.flatMap((artifact) => (Array.isArray(artifact.claims) ? artifact.claims : []));
  const idOfPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.id]));
  const known = new Set([...idOfPath.values(), ...claims.map((claim) => claim.id)]);

  const edges = [];
  for (const artifact of artifacts) {
    for (const ref of Array.isArray(artifact.sources) ? artifact.sources : []) {
      if (ref.exists !== true || ref.anchorFound !== true || ref.proposed === true) continue;
      const to = idOfPath.get(ref.path);
      if (to === undefined) continue;
      edges.push({
        from: artifact.id,
        to,
        kind: EDGE_KINDS.includes(ref.type) ? ref.type : 'derived-from',
        status: artifact.authority === 'reviewed' ? 'reviewed' : 'proposed',
      });
    }
  }
  for (const claim of claims) {
    for (const ref of Array.isArray(claim.evidence) ? claim.evidence : []) {
      // Evidence naming a node the corpus does not hold stays on the claim as a reference;
      // an edge to an invented node would report a chain as complete.
      if (!known.has(ref) || ref === claim.id) continue;
      edges.push({ from: claim.id, to: ref, kind: 'derived-from', status: claim.status === 'reviewed' ? 'reviewed' : 'proposed' });
    }
  }

  return {
    claims,
    artifacts: artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.type, path: artifact.path, scope: artifact.scope })),
    edges,
    // No authority order is declared by a corpus; a conflict set stays a conflict set.
    authority: [],
  };
}

/**
 * What an id names in the corpus: a claim, a section, an artifact, or nothing.
 *
 * @param {object} corpus
 * @param {string} id
 * @returns {{kind: 'claim'|'section'|'artifact', claim?: object, unit?: object, artifact: object}|null}
 */
export function citationFor(corpus, id) {
  const artifacts = corpus?.artifacts ?? [];
  const units = corpus?.units ?? [];
  for (const artifact of artifacts) {
    const claim = (Array.isArray(artifact.claims) ? artifact.claims : []).find((record) => record.id === id);
    if (claim !== undefined) return { kind: 'claim', claim, artifact };
  }
  const unit = units.find((record) => sectionMatches(record, id));
  if (unit !== undefined) {
    const artifact = artifacts.find((record) => record.path === unit.path);
    if (artifact !== undefined) return { kind: 'section', unit, artifact };
  }
  const artifact = artifacts.find((record) => record.id === id || record.path === id);
  if (artifact !== undefined) {
    const first = units.find((record) => record.path === artifact.path);
    return { kind: 'artifact', artifact, unit: first };
  }
  return null;
}