// Which tests a change should run, from one place .
//
// Four callers used to answer this question four ways: `tests` walked the stored test
// edges directly, `gate` walked the import graph transitively over a re-read worktree,
// `impact` asked `dependents` which asked `selectTests`, and `brief` used the edges again.
// The answers disagreed — `simt tests src/index/persist.mjs` named one test where `simt
// gate` on the same file named dozens — and every disagreement was a reader trusting the
// wrong one.
//
// The two walks are not the same question, so they are not merged into one answer:
// `transitive` is the import closure over changed paths, and the direct walk is the test
// edges the index stores. Each caller keeps its default; what changes is that there is
// now one implementation of each.

import { reverseImportClosure, selectTests } from './gate.mjs';
import { impactTopology, traceImpact } from './impact.mjs';
import { targetsForHunks } from './impact-targets.mjs';
import { isTestPath } from '../testing/paths.mjs';
import { cmp } from '../util/sort.mjs';
import { testEdges, testsFor } from './tests.mjs';

/**
 * Tests that exercise `paths`.
 *
 * @param {{files?: {path: string}[]|string[], imports?: {src: string, dst: string, kind?: string}[],
 *   coverage?: string[], commits?: string[][]}} graph
 * @param {Iterable<string>} paths
 * @param {{transitive?: boolean, cochange?: boolean}} [options]
 *   `transitive` (default true) is the import closure; `cochange` adds files that land in
 *   the same commits, and is only ever on when a caller asked for it.
 * @returns {string[]}
 */
export function coverage(graph, paths, { transitive = true, cochange = false, root = null } = {}) {
  const changed = [...new Set([...paths].filter(Boolean))];
  const imports = graph.imports ?? [];
  if (transitive) {
    const selected = selectTests(changed, imports, { root });
    if (!cochange || graph.files === undefined) return selected;
    const edges = testEdges({
      files: graph.files,
      imports,
      coverage: graph.coverage ?? [],
      commits: graph.commits ?? [],
    }, { root });
    const found = new Set(selected);
    for (const path of changed) {
      for (const test of testsFor(path, edges, { cochange: true })) found.add(test);
    }
    return [...found].sort();
  }
  const edges = testEdges({
    files: graph.files ?? [],
    imports,
    coverage: graph.coverage ?? [],
    commits: graph.commits ?? [],
  });
  const found = new Set();
  for (const path of changed) {
    for (const test of testsFor(path, edges, { cochange })) found.add(test);
  }
  return [...found].sort();
}

const MIN_BINDING_COVERAGE = 0.9;

export function preciseCoverage(graph, paths, hunks, { root = null, fallbackReason = null } = {}) {
  const imports = graph.edges;
  const closure = reverseImportClosure(paths, imports);
  const conservative = [...closure].filter((path) => isTestPath(path, root)).sort(cmp);
  const fallback = (reason) => ({
    selected: conservative,
    selection: { mode: 'conservative', reason, hubMediatedSkipped: [], otherSkipped: 0 },
  });
  if (fallbackReason) return fallback(fallbackReason);
  const hunkPaths = new Set((hunks ?? []).map(({ path }) => path));
  if (hunkPaths.size !== paths.length || paths.some((path) => !hunkPaths.has(path))) {
    return fallback('complete Git hunk evidence is unavailable');
  }
  if (graph.stale) return fallback('some live graph observations are stale or unreadable');
  const targets = targetsForHunks(hunks, graph);
  if (targets.some(({ symbol }) => !symbol)) return fallback('the diff includes edits outside a single bound source scope per hunk');
  const changed = new Set(paths);
  const topology = impactTopology(graph);
  const reached = traceImpact(topology, targets, { root, limit: Infinity });
  const uncertain = graph.symbolGraph?.unresolved ?? [];
  const onPath = ({ path }) => closure.has(path);
  if (graph.symbolGraph?.starExports?.some((path) => closure.has(path))) return fallback('a star re-export is on the import path');
  if (reached.conservativeFallback || uncertain.some((row) => row.kind === 'dynamic-import' && onPath(row))) {
    return fallback('a dynamic or unresolved import is on the path');
  }
  const languages = new Set(graph.files.filter(onPath).map(({ lang }) => lang));
  if ([...languages].some((lang) => (reached.bindingCoverage[lang]?.ratio ?? 0) < MIN_BINDING_COVERAGE)) {
    return fallback('binding coverage is below 90% along the import path');
  }
  const selected = new Set(reached.tests);
  for (const { src, dst, kind } of imports) {
    if ((!kind || kind === 'import') && changed.has(dst) && isTestPath(src, root)) selected.add(src);
  }
  for (const path of paths) if (isTestPath(path, root)) selected.add(path);
  if (!selected.size && conservative.length) return fallback('the symbol graph did not prove any test');
  const fileReach = traceImpact(topology, paths.map((file) => ({ file })), { root, limit: Infinity });
  const omitted = new Set(conservative.filter((path) => !selected.has(path)));
  const skipped = fileReach.tiers.hubMediated.filter(({ path }) => omitted.has(path))
    .map(({ path }) => path).sort(cmp);
  return {
    selected: [...selected].sort(cmp),
    selection: {
      mode: 'precise',
      reason: null,
      hubMediatedSkipped: skipped,
      otherSkipped: omitted.size - skipped.length,
    },
  };
}
