// Which tests a change should run (ADR-094).
//
// A test is selected when an import reaches a changed file, directly or through
// other files. The walk follows importers, so a test that imports a module that
// imports the change is included, and a cycle cannot. Naming and co-change are
// not imports, so they are not a selection.

import { isTestPath } from '../testing/paths.mjs';
import { loadLiveGraph } from './live.mjs';
import { importsOf } from './tests.mjs';

/**
 * Test files that import one of `changed`, directly or through other files.
 * A changed file that is itself a test is included: the edit is the test.
 *
 * @param {Iterable<string>} changed
 * @param {{src: string, dst: string, kind?: string}[]} imports importer, then imported
 * @returns {string[]}
 */
export function selectTests(changed, imports, { root = null } = {}) {
  return [...reverseImportClosure(changed, imports)].filter((path) => isTestPath(path, root)).sort();
}

export function reverseImportClosure(changed, imports) {
  const reverse = new Map();
  for (const edge of imports) {
    if (edge.kind && edge.kind !== 'import') continue;
    const list = reverse.get(edge.dst);
    if (list) list.push(edge.src);
    else reverse.set(edge.dst, [edge.src]);
  }
  const seen = new Set();
  const queue = [];
  for (const file of changed) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    queue.push(file);
  }
  while (queue.length > 0) {
    const file = queue.pop();
    const importers = reverse.get(file);
    if (!importers) continue;
    for (const importer of importers) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }
  return seen;
}

/** Import edges for the texts the caller already read. One pass, no second parse. */
export function importEdges(entries) {
  const files = new Set(entries.map((entry) => entry.path));
  const imports = [];
  for (const entry of entries) {
    if (!entry.lang || !entry.text) continue;
    imports.push(...importsOf(entry.path, entry.text, entry.lang, files));
  }
  return imports;
}

/** Resolve live imports while retaining removed targets for the gate's diff. */
export async function readGateGraph(root, { gone, hunks }) {
  const graph = await loadLiveGraph(root, {
    retainTargets: [...gone],
    binding: hunks !== null,
    rangePaths: (hunks ?? []).filter(({ hunks: ranges }) => ranges.length).map(({ path }) => path),
  });
  if (graph.broken) throw new Error(graph.indexError?.message ?? 'the index cannot be read');
  return graph;
}
