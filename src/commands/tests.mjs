// `simt tests [path]` lists the tests that exercise a file (ADR-092).
//
// Imports combine the staged graph with current edits. Coverage is read from
// named reports, and optional co-change uses the bounded history miner.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { buildCochange } from '../index/cochange.mjs';
import { readCochangeBasis } from '../index/graph-read.mjs';
import { loadLiveGraph } from '../index/live.mjs';
import { parseCoverage, testEdges, testsFor } from '../index/tests.mjs';
import { commandRoot } from '../repo-root.mjs';
import { isTestPath } from '../testing/paths.mjs';

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
  if (flags.precise === true || flags.conservative === true) {
    return fail('change selection flags need the gate', EXIT.USAGE, `run: ${CLI} tests --run --changed`);
  }
  if (args.length > 1) return fail(`unknown tests argument ${args[1]}`, EXIT.USAGE, `run: ${CLI} tests [path]`);
  const root = commandRoot(flags);
  const target = args[0];
  const withHistory = flags.cochange === true || !target;
  let graph;
  try {
    graph = await loadLiveGraph(root, { cochange: withHistory });
    if (graph.broken) throw new Error(graph.indexError?.message ?? 'the index cannot be read');
  } catch (error) {
    return fail(`could not map tests in this repository (${error.message})`, EXIT.UNSUPPORTED, 'run this inside a git repository');
  }
  const { files, edges: imports } = graph;
  const paths = new Set(files.map((file) => file.path));
  if (target && !paths.has(target)) {
    return fail(`not in the index: ${target}`, EXIT.USAGE, `pass a path ${CLI} index knows`);
  }
  const [reports, partners] = await Promise.all([
    coverageTexts(root),
    withHistory ? livePartners(root, paths, graph.cochange) : [],
  ]);
  const direct = testEdges({ files, imports, coverage: reports }, { root });
  const coupled = partners.filter(({ src, dst }) => !isTestPath(src, root) && isTestPath(dst, root));
  if (!target) return summarise(root, flags, direct.length, coupled.length);
  const cochange = flags.cochange === true ? coupled.filter(({ src }) => src === target) : null;
  const tests = [...new Set([...testsFor(target, direct), ...(cochange ?? []).map(({ dst }) => dst)])];
  const payload = { ok: true, command: 'tests', root, path: target, tests, ...(cochange ? { cochange } : {}) };
  if (isJson(flags)) {
    emitJson(payload);
    return EXIT.OK;
  }
  const lines = [`tests    ${tests.length}`, ...tests];
  emit(lines.join('\n'));
  return EXIT.OK;
}

async function livePartners(root, paths, cached) {
  const history = await buildCochange(root, await readCochangeBasis(root), paths);
  return history?.rows ?? cached ?? [];
}

function summarise(root, flags, test, cochange) {
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
