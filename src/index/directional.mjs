import { cmp } from '../util/sort.mjs';

const RELATIONS = Object.freeze({
  contains: ['contains', 0.9, 'enclosed_by', 0.9],
  sibling: ['sibling', 0.9, 'sibling', 0.9],
  calls_symbol: ['calls_symbol', 0.35, 'called_by', 0.85],
  imports_symbol: ['imports_symbol', 0.35, 'imported_by_symbol', 0.85],
  inherits: ['inherits', 0.75, 'inherited_by', 0.75],
  implements: ['implements', 0.75, 'implemented_by', 0.75],
  cochange: ['cochange', 0.6, 'cochange', 0.6],
});

export const MAX_HOPS = 2;
export const HOP_CAP = 24;
const DEGREE_POWER = 0.55;

function byArc(a, b) {
  return cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind);
}

function byRank(a, b) {
  return b.score - a.score || cmp(a.node, b.node);
}

/** Prepare both directions once, retaining the edge kind used by each traversal. */
export function directionalGraph(edges) {
  const arcs = new Map();
  function add(src, dst, kind, weight) {
    if (src === dst || weight <= 0) return;
    const id = JSON.stringify([src, dst, kind]);
    const old = arcs.get(id);
    if (!old || old.weight < weight) arcs.set(id, { src, dst, kind, weight });
  }
  for (const edge of edges) {
    if (!edge.src || !edge.dst || !Object.hasOwn(RELATIONS, edge.kind)) continue;
    const [forward, downstream, reverse, upstream] = RELATIONS[edge.kind];
    const strength = edge.kind === 'cochange' ? Math.min(1, Math.max(0, Number(edge.weight ?? 1))) : 1;
    if (!Number.isFinite(strength)) continue;
    add(edge.src, edge.dst, forward, downstream * strength);
    add(edge.dst, edge.src, reverse, upstream * strength);
  }
  const outgoing = new Map();
  const inbound = new Map();
  for (const arc of [...arcs.values()].sort(byArc)) {
    const from = outgoing.get(arc.src);
    if (from) from.push(arc);
    else outgoing.set(arc.src, [arc]);
    const sources = inbound.get(arc.dst);
    if (sources) sources.add(arc.src);
    else inbound.set(arc.dst, new Set([arc.src]));
  }
  const degree = new Map([...inbound].map(([node, sources]) => [node, sources.size]));
  return { outgoing, degree };
}

function preferWitness(a, b) {
  return b === undefined || a.weight > b.weight
    || (a.weight === b.weight && cmp(a.key, b.key) < 0);
}

/**
 * Spread positive lexical evidence across two bounded frontiers.
 * The activation is a sum, while the witness follows its strongest contribution.
 */
export function expandDirectional(graph, seeds) {
  const starts = new Map();
  for (const { node, score, exact = false } of seeds) {
    if (!node || !Number.isFinite(score) || score <= 0) continue;
    const adjusted = exact ? score : score / Math.log2(2 + (graph.degree.get(node) ?? 0));
    if ((starts.get(node)?.score ?? 0) < adjusted) {
      starts.set(node, { node, score: adjusted, witness: { seed: node, weight: adjusted, steps: [], key: node } });
    }
  }
  let frontier = [...starts.values()].sort(byRank);
  const found = new Map();
  for (let hop = 1; hop <= MAX_HOPS && frontier.length; hop += 1) {
    const next = new Map();
    for (const entry of frontier) {
      for (const arc of graph.outgoing.get(entry.node) ?? []) {
        if (starts.has(arc.dst) || entry.witness.steps.some(({ src }) => src === arc.dst)) continue;
        const attenuation = arc.weight / Math.max(1, graph.degree.get(arc.dst) ?? 0) ** DEGREE_POWER;
        const candidate = next.get(arc.dst) ?? { node: arc.dst, score: 0 };
        candidate.score += entry.score * attenuation;
        const weight = entry.witness.weight * attenuation;
        const key = JSON.stringify([entry.witness.key, arc.kind, arc.dst]);
        const witness = { seed: entry.witness.seed, weight, key };
        if (preferWitness(witness, candidate.witness)) candidate.witness = { ...witness, steps: [...entry.witness.steps, arc] };
        next.set(arc.dst, candidate);
      }
    }
    frontier = [...next.values()].sort(byRank).slice(0, HOP_CAP);
    for (const entry of frontier) {
      const previous = found.get(entry.node);
      const witness = preferWitness(entry.witness, previous?.witness) ? entry.witness : previous.witness;
      found.set(entry.node, { node: entry.node, score: (previous?.score ?? 0) + entry.score, witness });
    }
  }
  return [...found.values()].sort(byRank).map(({ node, score, witness: { seed, weight, steps } }) => ({
    node, score, witness: { seed, weight, steps },
  }));
}
