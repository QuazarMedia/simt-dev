// `simt tests [path]` lists the tests that exercise a file (ADR-092).
//
// Imports combine the staged graph with current edits. Coverage is read from
// named reports, and co-change uses the last 200 non-merge commits.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { loadLiveGraph } from '../index/live.mjs';
import { coverage } from '../index/coverage.mjs';
import { HISTORY, parseCoverage, testEdges } from '../index/tests.mjs';
import { commandRoot } from '../repo-root.mjs';
import { git } from '../sys/git.mjs';

const COVERAGE_PATHS = [
  'coverage/lcov.info',
  'lcov.info',
  'coverage/coverage-final.json',
  'coverage.json',
  'jacoco.xml',
  'build/reports/jacoco/test/jacocoTestReport.xml',
  'coverage.out',
  'cover.out',
];

export async function testsCommand(args, flags) {
  // `simt tests --run` is the gate's question - which of these the change reaches - asked
  // under the name that already means "tests". The handler is imported rather than
  // reimplemented: two selections that disagree is the defect this row exists to prevent,
  // and the gate keeps the sentence its own output makes about an empty selection.
  if (flags.run === true) return (await import('./gate.mjs')).gateCommand(args, flags);
  if (args.length > 1) return fail(`unknown tests argument ${args[1]}`, EXIT.USAGE, `run: ${CLI} tests [path]`);
  const root = commandRoot(flags);
  let graph;
  try {
    graph = await loadLiveGraph(root);
    if (graph.broken) throw new Error(graph.indexError?.message ?? 'the index cannot be read');
  } catch (error) {
    return fail(`could not map tests in this repository (${error.message})`, EXIT.UNSUPPORTED, 'run this inside a git repository');
  }
  const { files, edges: imports } = graph;
  const [reports, commits] = await Promise.all([coverageTexts(root), history(root)]);
  const paths = new Set(files.map((file) => file.path));
  const edges = testEdges({ files, imports, coverage: reports, commits }, { root });
  const target = args[0];
  if (!target) return summarise(root, flags, edges);
  if (!paths.has(target)) {
    return fail(`not in the index: ${target}`, EXIT.USAGE, `pass a path ${CLI} index knows`);
  }
  const tests = coverage({ files, imports, coverage: reports, commits }, [target], {
    root,
    transitive: false,
    cochange: flags.cochange === true,
  });
  const payload = { ok: true, command: 'tests', root, path: target, tests };
  if (isJson(flags)) {
    emitJson(payload);
    return EXIT.OK;
  }
  const lines = [`tests    ${tests.length}`, ...tests];
  emit(lines.join('\n'));
  return EXIT.OK;
}

function summarise(root, flags, edges) {
  let test = 0;
  let cochange = 0;
  for (const edge of edges) {
    if (edge.kind === 'test') test += 1;
    else if (edge.kind === 'cochange') cochange += 1;
  }
  const payload = { ok: true, command: 'tests', root, test, cochange };
  present(payload, () => `test      ${test}\ncochange  ${cochange}`, flags);
  return EXIT.OK;
}

async function coverageTexts(root) {
  const texts = [];
  for (const path of COVERAGE_PATHS) {
    try {
      const text = await readFile(join(root, path), 'utf8');
      if (parseCoverage(text).length > 0 || text.trim() !== '') texts.push(text);
    } catch {
      // Absent coverage is the usual case. It is not a failed map.
    }
  }
  return texts;
}

async function history(root) {
  let stdout = '';
  try {
    stdout = await git(root, ['log', '-n', String(HISTORY), '--no-merges', '--name-only', '--pretty=format:%x1e'], {
      maxBuffer: 16 << 20,
    });
  } catch {
    return [];
  }
  const commits = [];
  for (const block of stdout.split('\x1e')) {
    const paths = [];
    for (const line of block.split('\n')) {
      const path = line.trim();
      if (path) paths.push(path);
    }
    if (paths.length > 0) commits.push(paths);
  }
  return commits;
}
