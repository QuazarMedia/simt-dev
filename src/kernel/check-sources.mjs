import { realpath } from 'node:fs/promises';

import { createImportResolver } from '../index/extract.mjs';
import { readSourceLineFacts } from '../index/graph-read.mjs';
import { candidatePaths } from '../index/live.mjs';
import { readWorktreeFile } from '../index/overlay.mjs';
import { sourceLineFacts } from '../index/source-lines.mjs';
import { cmp } from '../util/sort.mjs';

export function changedNeighborhood(changes, graph) {
  const dirty = new Set(changes.map(({ path }) => path));
  const removed = new Set(changes.filter(({ status }) => status === 'deleted').map(({ path }) => path));
  const resolveRemoved = createImportResolver(removed);
  const files = new Map(graph.files.map(({ path, lang }) => [path, lang]));
  const scope = new Set(dirty);
  for (const edges of [graph.edges, graph.previousEdges ?? []]) {
    for (const { kind, src, dst } of edges) {
      if (kind !== 'import') continue;
      if (dirty.has(src) && files.has(dst)) scope.add(dst);
      if (dirty.has(dst) || (!files.has(dst) && removed.size && resolveRemoved(src, dst, files.get(src)))) scope.add(src);
    }
  }
  return scope;
}

export async function readCheckSources(root, [staged, changes], includes) {
  const files = new Map(candidatePaths(staged).filter(({ mode }) => mode.startsWith('100'))
    .map(({ path, blob }) => [path, blob]));
  for (const { path, status } of candidatePaths(changes)) {
    if (status === 'deleted') files.delete(path);
    else files.set(path, null);
  }
  const selected = [...files.keys()].filter(includes).sort(cmp);
  if (!selected.length) return [];
  const records = await readSourceLineFacts(root);
  let base;
  const facts = [];
  for (const file of selected) {
    const saved = records.get(file);
    if (saved?.blob === files.get(file)) {
      facts.push({ file, lines: saved.lines, generated: Boolean(saved.generated) });
      continue;
    }
    base ??= await realpath(root);
    const bytes = await readWorktreeFile(base, file).catch(() => null);
    facts.push({ file, ...sourceLineFacts(bytes?.toString('utf8') ?? null) });
  }
  return facts;
}
