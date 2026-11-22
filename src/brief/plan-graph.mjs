import { stronglyConnected } from '../coordination/workgraph.mjs';
import { symbolNodePaths } from '../index/bind.mjs';
import { createEntityResolver } from '../index/entities.mjs';
import { cmp } from '../util/sort.mjs';
import { maskPrompt } from './decompose.mjs';

const SEQUENCE = /\b(before|after)\s+(?:task\s+|t)(\d+)\b/giu;
const NAMED_SEQUENCE = /\b(before|after)\s+(?:(?:updating|editing|changing|fixing|checking|documenting|implementing)\s+)?(\u0001+|[\p{L}\p{N}_$.-]+)/giu;
const SYMBOL_DEPENDENCY = new Set(['calls_symbol', 'refs_symbol', 'imports_symbol', 'inherits', 'reexports_symbol']);
const byId = (a, b) => a - b;

export function subtaskPaths(task) {
  return new Set([
    ...(task.anchors ?? []).map(({ path }) => path),
    ...(task.files ?? []).map((file) => typeof file === 'string' ? file : file.path),
  ].filter(Boolean));
}

function orderedGroups(ids, dependencies) {
  const before = new Map(ids.map((id) => [id, []]));
  for (const edge of dependencies) before.get(edge.after).push(edge.before);
  const cycles = stronglyConnected(ids.map((id) => ({
    id: String(id), dependsOn: before.get(id).map(String),
  }))).map((component) => component.map(Number).sort(byId));
  cycles.sort((a, b) => a[0] - b[0]);
  const owners = new Map(cycles.flatMap((group) => group.map((id) => [id, group[0]])));
  const pending = new Map(cycles.map((group) => [group[0], group]));
  for (const id of ids) {
    if (!owners.has(id)) {
      owners.set(id, id);
      pending.set(id, [id]);
    }
  }
  const groups = [];
  while (pending.size) {
    const ready = [...pending.keys()].sort(byId).find((group) => pending.get(group).every((id) =>
      before.get(id).every((prior) => owners.get(prior) === group || !pending.has(owners.get(prior)))));
    groups.push(pending.get(ready));
    pending.delete(ready);
  }
  return { order: groups.flat(), groups, cycles };
}

/** Show the declared and observed dependencies without turning them into execution. */
export function orderSubtasks(tasks, graph) {
  const resolve = createEntityResolver(graph);
  const ids = tasks.map(({ id }) => id);
  const known = new Set(ids);
  const edges = new Map();
  const owners = new Map();
  const original = new Map();
  for (const task of tasks) {
    for (const { id: clauseId } of task.clauses ?? []) original.set(clauseId, task.id);
    for (const path of subtaskPaths(task)) {
      const members = owners.get(path) ?? new Set();
      members.add(task.id);
      owners.set(path, members);
    }
  }
  function add(before, after, witness) {
    if (before === after || !known.has(before) || !known.has(after)) return;
    const key = before + ':' + after;
    const row = edges.get(key) ?? { before, after, witnesses: new Map() };
    row.witnesses.set(JSON.stringify(witness), witness);
    edges.set(key, row);
  }

  for (const [index, task] of tasks.entries()) {
    for (const clause of task.clauses ?? []) {
      if (clause.sequence === 'then' || clause.sequence === 'next') {
        add(tasks[index - 1]?.id, task.id, { kind: 'sequence', marker: clause.sequence });
      } else if (clause.sequence === 'first' || clause.sequence === 'finally') {
        const related = clause.sequence === 'first' ? ids.slice(index + 1) : ids.slice(0, index);
        for (const id of related) {
          const [from, to] = clause.sequence === 'first' ? [task.id, id] : [id, task.id];
          add(from, to, { kind: 'sequence', marker: clause.sequence });
        }
      }
      const { masked } = maskPrompt(clause.text);
      for (const [, marker, ordinal] of masked.matchAll(SEQUENCE)) {
        const other = original.get(Number(ordinal)) ?? Number(ordinal);
        const [from, to] = marker.toLowerCase() === 'after' ? [other, task.id] : [task.id, other];
        add(from, to, { kind: 'sequence', marker: marker.toLowerCase() });
      }
      for (const match of masked.matchAll(NAMED_SEQUENCE)) {
        const { index } = match;
        const marker = match[1].toLowerCase();
        const length = match[2].length;
        const end = index + match[0].length;
        const source = clause.text.slice(end - length, end);
        const found = new Set([...resolve(source).keys()].flatMap((path) => [...(owners.get(path) ?? [])]));
        found.delete(task.id);
        if (found.size !== 1) continue;
        const other = [...found][0];
        const [from, to] = marker === 'after' ? [other, task.id] : [task.id, other];
        add(from, to, { kind: 'sequence', marker, subject: source });
      }
    }
  }
  function connect(caller, dependency, witness) {
    for (const producer of owners.get(dependency) ?? []) {
      for (const consumer of owners.get(caller) ?? []) add(producer, consumer, witness);
    }
  }
  for (const { kind, src, dst } of graph.edges ?? []) {
    if (kind === 'import' && src !== dst) connect(src, dst, { kind, src, dst });
  }
  const symbolEdges = graph.symbolGraph?.edges ?? [];
  const paths = (graph.files ?? []).map((file) => typeof file === 'string' ? file : file.path);
  const nodes = symbolNodePaths(paths, symbolEdges);
  for (const { kind, src, dst } of symbolEdges) {
    if (SYMBOL_DEPENDENCY.has(kind) && nodes.get(src) !== nodes.get(dst)) {
      connect(nodes.get(src), nodes.get(dst), { kind, src, dst });
    }
  }
  const dependencies = [...edges.values()].sort((a, b) => byId(a.before, b.before) || byId(a.after, b.after))
    .map(({ before, after, witnesses }) => ({
      before, after, witnesses: [...witnesses].sort(([a], [b]) => cmp(a, b)).map(([, witness]) => witness),
    }));
  return { dependencies, ...orderedGroups(ids, dependencies) };
}
