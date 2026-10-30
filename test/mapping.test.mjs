// Test mapping (R24, ADR-092).
//
// A test edge is an import, a conventional file beside the test, or a coverage
// record that names both. A stem unique somewhere else is left unmatched.
// Co-change is a separate kind and stays out of the default answer.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isTestPath } from '../src/bench/mine.mjs';
import { git } from './fixture.mjs';
import {
  cochangeEdges,
  importsOf,
  parseCoverage,
  parseGoCover,
  parseJacoco,
  parseLcov,
  scriptSpecifiers,
  testEdges,
  testsFor,
} from '../src/index/tests.mjs';
import { testsCommand } from '../src/commands/tests.mjs';

const FILES = [
  'src/keep.mjs',
  'src/other.mjs',
  'src/index/map.mjs',
  'src/commands/map.mjs',
  'src/a.go',
  'src/a_test.go',
  'src/main/java/app/Foo.java',
  'src/test/java/app/FooTest.java',
  'pkg/widget.py',
  'pkg/test_widget.py',
  'test/keep.test.mjs',
];

test('an import from a test file is a test edge, and a split import still counts', () => {
  const text = "import {\n  keep,\n} from '../src/keep.mjs';\nexport function nope() {}\nimport { other } from '../src/other.mjs';\nconst late = await import('../src/keep.mjs');\n";
  assert.deepEqual(scriptSpecifiers(text), ['../src/keep.mjs', '../src/other.mjs']);
  const resolved = importsOf('test/keep.test.mjs', text, 'javascript', new Set(FILES));
  const edges = testEdges({ files: FILES, imports: resolved });
  assert.deepEqual(testsFor('src/keep.mjs', edges), ['test/keep.test.mjs']);
  assert.deepEqual(testsFor('src/other.mjs', edges), ['test/keep.test.mjs']);
});

test('a name is an edge only for the conventional file beside the test', () => {
  const edges = testEdges({
    files: [...FILES, 'test/hooks.test.mjs', 'src/commands/hooks.mjs'],
    imports: [],
  });
  assert.deepEqual(testsFor('src/a.go', edges), ['src/a_test.go']);
  assert.deepEqual(testsFor('src/main/java/app/Foo.java', edges), ['src/test/java/app/FooTest.java']);
  assert.deepEqual(testsFor('pkg/widget.py', edges), ['pkg/test_widget.py']);
  assert.deepEqual(testsFor('src/index/map.mjs', edges), []);
  assert.deepEqual(testsFor('src/commands/hooks.mjs', edges), []);
});

test('coverage names both sides, and a go profile uses the package test', () => {
  assert.deepEqual(parseLcov('TN:\nSF:src/nope.mjs\nend_of_record\nTN:test/keep.test.mjs\nSF:src/keep.mjs\nend_of_record\n'), [
    { test: 'test/keep.test.mjs', source: 'src/keep.mjs' },
  ]);
  assert.deepEqual(parseJacoco('<report><class name="app.FooTest"/><sourcefile name="Foo.java"/></report>'), [
    { test: 'FooTest', source: 'Foo.java' },
  ]);
  assert.deepEqual(parseCoverage('{"files":{"pkg/widget.py":{"contexts":{"test_widget":{}}}}}'), [
    { test: 'test_widget', source: 'pkg/widget.py' },
  ]);
  assert.deepEqual(parseGoCover('mode: set\nsrc/a.go:1.1,2.2 1 1\nsrc/a.go:3.1,4.2 1 0\n'), [
    { test: '', source: 'src/a.go' },
  ]);
  const edges = testEdges({
    files: FILES,
    coverage: [
      'TN:test/keep.test.mjs\nSF:src/keep.mjs\nend_of_record\n',
      'mode: set\nsrc/a.go:1.1,2.2 1 1\n',
    ],
  });
  assert.ok(testsFor('src/keep.mjs', edges).includes('test/keep.test.mjs'));
  assert.deepEqual(testsFor('src/a.go', edges), ['src/a_test.go']);
});

test('co-change ignores a wide commit and a pair seen once', () => {
  const edges = cochangeEdges([
    ['test/keep.test.mjs', 'src/keep.mjs'],
    ['test/keep.test.mjs', 'src/keep.mjs', 'src/other.mjs'],
    ['t1.test.mjs', 't2.test.mjs', 't3.test.mjs', 't4.test.mjs', 't5.test.mjs', 't6.test.mjs', 'src/keep.mjs'],
  ]);
  assert.deepEqual(edges, [{ src: 'test/keep.test.mjs', dst: 'src/keep.mjs', kind: 'cochange', weight: 2 }]);
  const all = testEdges({
    files: ['test/check.test.mjs', 'src/keep.mjs'],
    commits: [
      ['test/check.test.mjs', 'src/keep.mjs'],
      ['test/check.test.mjs', 'src/keep.mjs'],
    ],
  });
  assert.deepEqual(testsFor('src/keep.mjs', all), []);
  assert.deepEqual(testsFor('src/keep.mjs', all, { cochange: true }), ['test/check.test.mjs']);
});

test('simt tests lists the importing test and refuses a path the index does not have', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-tests-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
  await writeFile(join(root, 'test', 'keep.test.mjs'), "import { keep } from '../src/keep.mjs';\n");
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  const listed = await capture(() => testsCommand(['src/keep.mjs'], { root }));
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /test\/keep\.test\.mjs/);
  const missing = await capture(() => testsCommand(['src/nope.mjs'], { root }));
  assert.equal(missing.code, 2);
  const bare = await mkdtemp(join(tmpdir(), 'idx-tests-'));
  const refused = await capture(() => testsCommand([], { root: bare }));
  assert.equal(refused.code, 5);
  await rm(root, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
});

// Hand-labelled from the import lines in these tests, including a dynamic
// import(). A string that merely names a path is not a label.
const GOLD = {
  'src/agenthooks/decide.mjs': ['test/agenthooks.test.mjs'],
  'src/agenthooks/policy.mjs': ['test/agenthooks.test.mjs', 'test/lease.test.mjs'],
  'src/agenthooks/render.mjs': ['test/agenthooks.test.mjs', 'test/lessons.test.mjs'],
  'src/argv.mjs': ['test/help.test.mjs', 'test/unit.test.mjs', 'test/completions.test.mjs'],
  'src/bench/ablate.mjs': ['test/bench.test.mjs'],
  'src/bench/grade.mjs': ['test/bench.test.mjs'],
  'src/bench/mine.mjs': ['test/bench.test.mjs', 'test/mapping.test.mjs'],
  'src/bench/probes.mjs': ['test/bench.test.mjs'],
  'src/bench/report.mjs': ['test/bench.test.mjs'],
  'src/bench/run.mjs': ['test/bench.test.mjs'],
  'src/ci/dependabot.mjs': ['test/ci.test.mjs', 'test/naming.test.mjs'],
  'src/ci/workflow.mjs': ['test/ci.test.mjs', 'test/naming.test.mjs', 'test/binary.test.mjs', 'test/node-runner.test.mjs'],
  'src/commands/evidence.mjs': ['test/ledger.test.mjs'],
  'src/commands/help.mjs': ['test/naming.test.mjs'],
  'src/commands/hooks.mjs': ['test/ledger.test.mjs'],
  'src/commands/map.mjs': ['test/map.test.mjs'],
  'src/commands/repoindex.mjs': ['test/index.test.mjs'],
  'src/commands/skills.mjs': ['test/help.test.mjs'],
  'src/commands/skillsinstall.mjs': ['test/install.test.mjs'],
  'src/commands/tokens.mjs': ['test/tokens.test.mjs'],
  'src/commands/upgrade.mjs': ['test/upgrade.test.mjs'],
  'src/compare/discover.mjs': ['test/compare.test.mjs'],
  'src/compare/hooksstate.mjs': ['test/compare.test.mjs'],
  'src/compare/row.mjs': ['test/compare.test.mjs'],
  'src/decisions/index.mjs': ['test/leaks.mjs', 'test/rules.test.mjs', 'test/shipped.test.mjs', 'test/decide.test.mjs', 'test/decisions.test.mjs'],
  'src/graph/load.mjs': ['test/fixture.mjs', 'test/graph.test.mjs', 'test/install.test.mjs', 'test/compile.test.mjs'],
  'src/graph/spec.mjs': ['test/graphspec.test.mjs', 'test/compile.test.mjs', 'test/graph.test.mjs'],
  'src/graph/speccheck.mjs': ['test/graphspec.test.mjs'],
  'src/hooks/capability.mjs': ['test/hooks.test.mjs', 'test/init.test.mjs', 'test/install.test.mjs'],
  'src/hooks/dispatcher.mjs': ['test/hooks.test.mjs', 'test/ledger.test.mjs', 'test/lessons.test.mjs', 'test/secrets.test.mjs'],
};

const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', py: 'python', go: 'go', java: 'java', kt: 'kotlin',
};

test('precision on 30 labelled files is at least 0.8', async () => {
  assert.equal(Object.keys(GOLD).length, 30);
  const root = new URL('..', import.meta.url).pathname;
  const exec = promisify(execFile);
  const { stdout } = await exec('git', ['ls-files'], { cwd: root, maxBuffer: 8 << 20 });
  const files = stdout.split('\n').filter(Boolean);
  const paths = new Set(files);
  const imports = [];
  for (const file of files) {
    if (!isTestPath(file)) continue;
    const ext = file.slice(file.lastIndexOf('.') + 1);
    const text = await readFile(join(root, file), 'utf8');
    imports.push(...importsOf(file, text, LANG[ext] ?? '', paths));
  }
  const edges = testEdges({ files, imports });
  let hit = 0;
  let predicted = 0;
  for (const [source, gold] of Object.entries(GOLD)) {
    const got = testsFor(source, edges);
    const labelled = new Set(gold);
    hit += got.filter((testPath) => labelled.has(testPath)).length;
    predicted += got.length;
  }
  assert.ok(predicted > 0);
  assert.ok(hit / predicted >= 0.8, `precision ${hit / predicted} on ${predicted} predictions`);
});

async function capture(run) {
  const chunks = [];
  const errors = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    errors.push(String(chunk));
    return true;
  };
  try {
    const code = await run();
    return { code, stdout: chunks.join(''), stderr: errors.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}
