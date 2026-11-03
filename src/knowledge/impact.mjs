// Evidence-grounded impact: what a change reaches, what it leaves unknown, and the negative
// precedent worth reading beside the successful example.
//
// "These files import the one you edited" is the code answer, and it stops where the work
// stops being code. A rate source reaches a claim, the requirement document built from it,
// the design note, the recipe, the graduated helper, the test that verifies it and the remote
// object the recipe affects - and none of those are an import. So the walk runs over the
// typed graph from the claims slice and the receipts from the derivation slice, and it
// reports three things a reader needs and one it does not:
//
//   * What is reached. Bucketed by what it is, because "affected" is not actionable without
//     the kind.
//   * What is reachable only through an unreviewed edge. Named separately, never counted in
//     the answer: a proposal is not a dependency yet.
//   * What is unknown. A ref the graph does not hold, a node whose scope the question cannot
//     place, an output with no receipt. A report that omits these looks complete.
//   * Not a proof. The return says `complete` and `conservative` explicitly, so a truncated
//     walk cannot be read as "nothing else".
//
// The counterexamples are lessons, and they are filtered twice: by tenant (a lesson from
// another tenant is never an instruction) and by scope, then diversified by lineage so one
// assertion copied into three lessons is one piece of evidence, not three.

import { impact as graphImpact } from './claims.mjs';
import { regenerationCandidates } from './derivations.mjs';
import { satisfiesScope } from './validity.mjs';

export const IMPACT_SCHEMA_VERSION = 1;

/** The walk stops at a fixed count: an unbounded report is not an answer a reader can use. */
export const IMPACT_LIMIT = 64;

/** The buckets a report separates, in the order a reader should consider them. */
export const IMPACT_BUCKETS = Object.freeze(['claims', 'artifacts', 'recipes', 'helpers', 'tests', 'remoteObjects', 'sources', 'other']);

const BUCKET_OF = new Map([
  ['claim', 'claims'],
  ['document', 'artifacts'],
  ['dataset', 'artifacts'],
  ['tdd', 'artifacts'],
  ['recipe', 'recipes'],
  ['helper', 'helpers'],
  ['test', 'tests'],
  ['remote-object', 'remoteObjects'],
  ['source', 'sources'],
]);

/** Edges that name what an affected artifact leaves stale, rather than what depends on it. */
const EFFECT_EDGES = new Set(['affects-object']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;

const requiredScope = (scopes) => Object.entries(scopes ?? {}).filter(([, value]) => value !== undefined && value !== null);

/** A node's scope is its own, or the one its claim record declares. */
const scopeOfNode = (node) => (isObject(node) && node.scope !== undefined ? node.scope : isObject(node?.claim) ? node.claim.scope : undefined);

const byId = (a, b) => String(a.id ?? '').localeCompare(String(b.id ?? ''));

/**
 * The lessons that may be read beside this change: applicable, same tenant, one row per
 * independent lineage.
 *
 * A tenant-scoped lesson is never applied to a report that names no tenant: "this went wrong
 * in tenant B" is not advice for whoever is reading, and a report that cannot say whose
 * context it is in must not adopt one.
 *
 * @param {{lessons?: object[], scopes?: object, tenant?: string|null}} input
 */
export function lessonsFor({ lessons = [], scopes = {}, tenant = null } = {}) {
  const required = requiredScope(scopes);
  const excluded = [];
  const groups = new Map();

  for (const lesson of Array.isArray(lessons) ? lessons : []) {
    const id = lesson?.id ?? null;
    if (lesson?.kind !== 'failure' && lesson?.kind !== 'exemplar') {
      excluded.push({ id, reason: 'kind' });
      continue;
    }
    if (isText(lesson.tenant) && (!isText(tenant) || lesson.tenant !== tenant)) {
      excluded.push({ id, reason: 'tenant' });
      continue;
    }
    const relation = satisfiesScope(lesson.scope, required);
    if (relation === 'conflict') {
      excluded.push({ id, reason: 'scope-mismatch' });
      continue;
    }
    if (relation === 'unknown') {
      excluded.push({ id, reason: 'scope-missing' });
      continue;
    }
    const lineage = isText(lesson.lineage) ? lesson.lineage : `lesson:${String(id)}`;
    const key = `${lesson.kind}|${lineage}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lesson);
  }

  const exemplars = [];
  const counterexamples = [];
  for (const [key, group] of groups) {
    const [first] = [...group].sort(byId);
    const row = {
      id: first.id ?? null,
      lineage: key.slice(key.indexOf('|') + 1),
      // One lineage is one piece of evidence however many times it was written down.
      corroborating: 1,
      copies: group.length,
      text: first.text ?? '',
    };
    if (first.kind === 'exemplar') exemplars.push(row);
    else counterexamples.push(row);
  }

  return {
    exemplars: exemplars.sort(byId),
    counterexamples: counterexamples.sort(byId),
    excluded: excluded.sort(byId),
  };
}

/**
 * The impact of a change, over the typed graph and the derivation receipts.
 *
 * @param {{graph: {nodes: object[], edges: object[]}, change?: {refs?: string[], scopes?: object, tenant?: string|null}, derivations?: object|null, lessons?: object[], limits?: {nodes?: number}}} input
 * @returns {object}
 */
export function impactReport({ graph = null, change = {}, derivations = null, lessons = [], limits = {} } = {}) {
  if (!isObject(graph) || !Array.isArray(graph.nodes)) throw new Error('an impact report needs a claim graph with nodes');
  const refs = (Array.isArray(change.refs) ? change.refs : []).filter(isText);
  const required = requiredScope(change.scopes);
  const limit = Number.isInteger(limits.nodes) && limits.nodes >= 0 ? limits.nodes : IMPACT_LIMIT;

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const reached = new Set();
  const proposed = new Set();
  const unknown = [];
  const excluded = [];
  const cycles = new Set();
  const reasons = [];
  let truncated = false;

  for (const ref of refs) {
    if (!nodeById.has(ref)) {
      unknown.push({ ref, reason: 'not-in-graph' });
      continue;
    }
    // The walk counts the root among what it returns; the limit counts affected nodes.
    const reviewed = graphImpact(graph, ref, { limit: limit + 1 });
    if (reviewed.truncated) truncated = true;
    for (const id of reviewed.cycles) cycles.add(id);
    for (const id of reviewed.reachable) if (id !== ref) reached.add(id);

    // What only a proposed edge reaches is reported and not counted: an edge nobody reviewed
    // is a hypothesis about a dependency, not a dependency.
    const wide = graphImpact(graph, ref, { includeProposed: true, limit: limit + 1 });
    for (const id of wide.reachable) if (id !== ref && !reached.has(id)) proposed.add(id);
  }

  const filterScopes = (bucket) => {
    for (const id of [...bucket]) {
      const relation = satisfiesScope(scopeOfNode(nodeById.get(id)), required);
      if (relation === 'conflict') {
        excluded.push({ id, reason: 'scope-mismatch' });
        bucket.delete(id);
      } else if (relation === 'unknown') {
        unknown.push({ ref: id, reason: 'scope-missing' });
        bucket.delete(id);
      }
    }
  };

  filterScopes(reached);

  // An object a recipe writes is not a dependent of the source; it is what the recipe's
  // change leaves stale. So it is reached by one forward hop from an affected writer, and
  // only from a writer that survived the scope filter. Repeated until nothing new, because a
  // recipe may write more than one object and an object may be written by several recipes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (!EFFECT_EDGES.has(edge.kind) || !reached.has(edge.from) || reached.has(edge.to)) continue;
      if (edge.status === 'reviewed') {
        reached.add(edge.to);
        changed = true;
      } else if (edge.status === 'proposed' && !proposed.has(edge.to)) proposed.add(edge.to);
    }
  }

  filterScopes(reached);
  filterScopes(proposed);

  const derived = [];
  if (isObject(derivations)) {
    const report = regenerationCandidates(derivations);
    for (const candidate of report.candidates) derived.push(candidate.output);
    for (const conflict of report.conflicts) unknown.push({ ref: conflict.output, reason: 'generation-conflict' });
    for (const entry of report.unknown) unknown.push({ ref: entry.output, reason: 'no-generation-receipt' });
    if (report.minimalSafe === false) reasons.push('the generation receipts do not justify a minimal safe set');
    for (const output of derived) kinds.set(output, 'document');
  }

  const ids = [...new Set([...reached, ...derived])].sort();
  const shown = ids.slice(0, limit);
  if (ids.length > limit) truncated = true;

  const affected = Object.fromEntries(IMPACT_BUCKETS.map((bucket) => [bucket, []]));
  for (const id of shown) affected[BUCKET_OF.get(kinds.get(id)) ?? 'other'].push(id);

  if (truncated) reasons.push(`the walk stopped at ${limit} node(s), so anything beyond it is unreported rather than unaffected`);
  if (cycles.size > 0) reasons.push(`the dependency graph cycles through ${[...cycles].sort().join(', ')}`);
  if (unknown.length > 0) reasons.push(`${unknown.length} dependency is unknown, so the affected set is a floor rather than a list`);

  return {
    version: IMPACT_SCHEMA_VERSION,
    changed: refs,
    affected,
    proposed: [...proposed].sort(),
    unknown: unknown.sort((a, b) => String(a.ref).localeCompare(String(b.ref)) || a.reason.localeCompare(b.reason)),
    excluded: excluded.sort(byId),
    cycles: [...cycles].sort(),
    truncated,
    // A reader acts on this report, so it says whether it is finished and whether anything
    // in it needs verification before it is trusted.
    complete: !truncated && unknown.length === 0,
    conservative: truncated || unknown.length > 0,
    lessons: lessonsFor({ lessons, scopes: change.scopes ?? {}, tenant: change.tenant ?? null }),
    reasons,
  };
}
