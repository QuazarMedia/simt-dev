import { stronglyConnected } from '../coordination/workgraph.mjs';
import { symbolNodePaths } from '../index/bind.mjs';
import { createEntityResolver } from '../index/entities.mjs';
import { tokenizeIdentifiers } from '../text/identifiers.mjs';
import { STOPWORDS } from '../text/tokens.mjs';
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

const DUPLICATE_THRESHOLD = 0.8;
const SYMBOL_ANCHORS = new Set(['symbol', 'qualified-symbol']);

function setSorted(values, comparator = cmp) {
  return [...new Set(values)].sort(comparator);
}

function comparisonKey(task) {
  const anchors = setSorted(task.anchors.map(({ path, kind, matched }) =>
    JSON.stringify(SYMBOL_ANCHORS.has(kind) ? [path, matched] : [path])));
  const constraints = setSorted(task.constraints.map(({ kind, action, guard, condition, targets }) =>
    JSON.stringify(kind === 'condition' ? [kind, guard, condition] : [kind, action, setSorted(targets)])));
  return JSON.stringify([anchors, constraints, task.decisions, task.scopes, task.context]);
}

function tokenSet(query) {
  return new Set(tokenizeIdentifiers(query).map(({ token }) => token).filter((word) =>
    !STOPWORDS.has(word) && word !== 'please'));
}

function isNearDuplicate(first, second) {
  if (!first.size || !second.size) return false;
  let common = 0;
  for (const word of first) if (second.has(word)) common += 1;
  return common / (first.size + second.size - common) >= DUPLICATE_THRESHOLD;
}

function mergedTask(entries) {
  const [representative] = entries.map(({ task }) => task);
  if (entries.length === 1) return representative;
  const subjects = entries.map(({ task }) => task);
  const clauses = subjects.flatMap((task) => task.clauses).sort((a, b) => byId(a.id, b.id));
  const anchors = new Map();
  for (const anchor of subjects.flatMap((task) => task.anchors)) {
    const key = JSON.stringify([anchor.path, anchor.kind, anchor.matched]);
    const first = anchors.get(key);
    anchors.set(key, { ...anchor, clauseIds: setSorted([...(anchor.clauseIds ?? []), ...(first?.clauseIds ?? [])], byId) });
  }
  const files = new Map();
  for (const file of subjects.flatMap((task) => task.files ?? [])) {
    const path = typeof file === 'string' ? file : file.path;
    const previous = files.get(path);
    if (previous === undefined || (file.score ?? 0) > (previous.score ?? 0)) files.set(path, file);
  }
  const ids = setSorted(subjects.map(({ id }) => id), byId);
  return {
    ...representative, id: ids[0],
    mergedTaskIds: ids, clauseIds: clauses.map(({ id }) => id), clauses,
    anchors: [...anchors.values()].sort((a, b) => cmp(a.path, b.path) || cmp(a.kind, b.kind) || cmp(a.matched, b.matched)),
    files: [...files].sort(([a], [b]) => cmp(a, b)).map(([, file]) => file),
    constraints: subjects.flatMap((task) => task.constraints).sort((a, b) => byId(a.clauseId, b.clauseId)),
    cautions: setSorted(subjects.flatMap((task) => task.cautions)),
  };
}

/** Merge only when every member agrees on scope and passes the similarity bar. */
export function clusterSubtasks(tasks) {
  const candidates = tasks.map((task) => ({ task, key: comparisonKey(task), tokens: tokenSet(task.query) }));
  candidates.sort((a, b) => cmp(a.key, b.key) || cmp(a.task.query, b.task.query) || byId(a.task.id, b.task.id));
  const clusters = [];
  for (const candidate of candidates) {
    const group = clusters.find((entries) => entries[0].key === candidate.key
      && entries.every((entry) => isNearDuplicate(entry.tokens, candidate.tokens)));
    if (group) group.push(candidate);
    else clusters.push([candidate]);
  }
  return clusters.map(mergedTask).sort((a, b) => byId(a.id, b.id));
}

function addOwner(index, key, id) {
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(id);
}

/** Plan lanes from both explicit anchors and the files retrieved for each task. */
export function subtaskLanes(tasks) {
  const fileOwners = new Map();
  const symbolOwners = new Map();
  const pathsByTask = new Map();
  const neighbors = new Map(tasks.map(({ id }) => [id, new Set()]));
  for (const task of tasks) {
    const paths = subtaskPaths(task);
    pathsByTask.set(task.id, paths);
    for (const path of paths) addOwner(fileOwners, path, task.id);
    for (const { path, kind, matched } of task.anchors ?? []) {
      if (SYMBOL_ANCHORS.has(kind)) addOwner(symbolOwners, JSON.stringify([path, matched]), task.id);
    }
  }
  const pairs = new Map();
  function overlap(owners, label, convert) {
    for (const [key, ids] of owners) {
      const group = [...ids].sort(byId);
      for (const [index, from] of group.entries()) {
        for (const to of group.slice(index + 1)) {
          neighbors.get(from).add(to);
          neighbors.get(to).add(from);
          const labelKey = from + ':' + to;
          const pair = pairs.get(labelKey) ?? { tasks: [from, to], files: [], symbols: [] };
          pair[label].push(convert(key));
          pairs.set(labelKey, pair);
        }
      }
    }
  }
  overlap(fileOwners, 'files', (path) => path);
  overlap(symbolOwners, 'symbols', (key) => {
    const [path, name] = JSON.parse(key);
    return { path, name };
  });
  const overlaps = [...pairs.values()].sort((a, b) => byId(a.tasks[0], b.tasks[0]) || byId(a.tasks[1], b.tasks[1]))
    .map((row) => ({
      ...row, files: row.files.sort(cmp), symbols: row.symbols.sort((a, b) => cmp(a.path, b.path) || cmp(a.name, b.name)),
    }));
  const visited = new Set();
  const components = [];
  for (const { id } of tasks) {
    if (visited.has(id)) continue;
    const group = [id];
    visited.add(id);
    for (const member of group) {
      for (const neighbor of neighbors.get(member)) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        group.push(neighbor);
      }
    }
    group.sort(byId);
    const files = setSorted(group.flatMap((member) => [...pathsByTask.get(member)]));
    const members = new Set(group);
    const sharedFiles = setSorted(overlaps.filter(({ tasks: pair }) => members.has(pair[0])).flatMap((row) => row.files));
    const state = group.length > 1 ? 'coupled' : files.length ? 'independent' : 'unresolved';
    const key = JSON.stringify([files, tasks.filter((task) => members.has(task.id)).map(({ query }) => query).sort(cmp)]);
    components.push({ taskIds: group, state, files, sharedFiles, key });
  }
  const lanes = components.sort((a, b) => cmp(a.key, b.key)).map(({ key, ...lane }, index) => ({ id: index + 1, ...lane }));
  return {
    lanes,
    overlaps,
    lines: tasks.length > 1 ? [
      'Lanes  ' + lanes.map(({ id, taskIds, state }) =>
        'L' + id + ' ' + taskIds.map((task) => 'T' + task).join(',') + ' ' + state).join(' | '),
      ...(overlaps.length ? ['Shared files  ' + setSorted(overlaps.flatMap(({ files }) => files)).join(', ')] : []),
    ] : [],
  };
}
