// `simt tests [path]` lists the tests that exercise a file (R24, ADR-092).
//
// The index already stores imports, but a test import that spans lines is not
// one of them. Test files are read back from their blobs, once, in a single
// batch. Coverage is read only from a fixed list of paths. History is the last
// 200 non-merge commits, which is a map and not the whole changelog.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { isTestPath } from '../bench/mine.mjs';
import { blobTexts, isIndexStale, langOf, readEdges, readFiles, reindex } from '../index/store.mjs';
import { HISTORY, importsOf, parseCoverage, testEdges, testsFor } from '../index/tests.mjs';

const exec = promisify(execFile);

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
  if (args.length > 1) return fail(`unknown tests argument ${args[1]}`, EXIT.USAGE, `run: ${CLI} tests [path]`);
  const root = flags.root ?? process.cwd();
  const loaded = await loadFiles(root);
  if (loaded.error) return loaded.error;
  const { files } = loaded;
  const [stored, texts, coverage, commits] = await Promise.all([
    readEdges(root),
    testBlobs(root, files),
    coverageTexts(root),
    history(root),
  ]);
  const paths = new Set(files.map((file) => file.path));
  const imports = stored.filter((edge) => edge.kind === 'import');
  for (const file of files) {
    if (!isTestPath(file.path)) continue;
    const text = texts.get(file.blob);
    if (!text) continue;
    imports.push(...importsOf(file.path, text, langOf(file.path), paths));
  }
  const edges = testEdges({ files, imports, coverage, commits });
  const target = args[0];
  if (!target) return summarise(root, flags, edges);
  if (!paths.has(target)) {
    return fail(`not in the index: ${target}`, EXIT.USAGE, `pass a path ${CLI} index knows`);
  }
  const tests = testsFor(target, edges, { cochange: flags.cochange === true });
  const payload = { ok: true, command: 'tests', root, path: target, tests };
  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  const lines = [`tests    ${tests.length}`, ...tests];
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
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
  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  emit(`test      ${test}\ncochange  ${cochange}`, { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

async function loadFiles(root) {
  let files = await readFiles(root);
  // An empty index has nothing to answer from; a stale one has yesterday's
  // tree (review 0003 Q42). Either way the refresh is incremental, so a
  // current repository pays for one `git ls-files -s`, not a rebuild.
  if (files.length === 0 || (await isIndexStale(root))) {
    try {
      await reindex(root);
    } catch (error) {
      return {
        error: fail(
          `could not map tests in this repository (${error.message})`,
          EXIT.UNSUPPORTED,
          'run this inside a git repository',
        ),
      };
    }
    files = await readFiles(root);
  }
  return { files };
}

async function testBlobs(root, files) {
  const blobs = [];
  for (const file of files) {
    if (isTestPath(file.path) && file.blob) blobs.push(file.blob);
  }
  return blobTexts(root, blobs).catch(() => new Map());
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
    ({ stdout } = await exec('git', ['log', '-n', String(HISTORY), '--no-merges', '--name-only', '--pretty=format:%x1e'], {
      cwd: root,
      maxBuffer: 16 << 20,
    }));
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
