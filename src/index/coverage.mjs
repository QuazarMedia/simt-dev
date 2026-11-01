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

import { selectTests } from './gate.mjs';
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
export function coverage(graph, paths, { transitive = true, cochange = false } = {}) {
  const changed = [...new Set([...paths].filter(Boolean))];
  const imports = graph.imports ?? [];
  if (transitive) {
    const selected = selectTests(changed, imports);
    if (!cochange || graph.files === undefined) return selected;
    const edges = testEdges({
      files: graph.files,
      imports,
      coverage: graph.coverage ?? [],
      commits: graph.commits ?? [],
    });
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
