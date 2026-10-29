// Compaction of this tool's own test output (R18, ADR-095).
//
// Each fixture is one format the runner can emit. The failing test's name,
// assertion and location have to be in the compact text. The passing test's
// name does not: it is a count. Anything else is not compacted.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { gateCommand } from '../src/commands/gate.mjs';
import { compactOutput } from '../src/index/compact.mjs';

const exec = promisify(execFile);

test('tap keeps the failure and counts the pass', () => {
  const text = [
    'TAP version 13',
    '# Subtest: the suite',
    'ok 1 - the suite',
    '  ---',
    "  type: 'suite'",
    '  ...',
    '# Subtest: adds the value',
    'ok 2 - adds the value',
    '  ---',
    "  type: 'test'",
    '  ...',
    '# Subtest: rejects the value',
    'not ok 3 - rejects the value',
    '  ---',
    "  type: 'test'",
    "  location: '/tmp/src/a.test.mjs:8:3'",
    '  error: |-',
    '    expected 2',
    '  ...',
  ].join('\n');
  const compact = compactOutput(text);
  assert.match(compact, /rejects the value/);
  assert.match(compact, /expected 2/);
  assert.match(compact, /\/tmp\/src\/a\.test\.mjs:8:3/);
  assert.equal(compact.includes('adds the value'), false);
  assert.equal(compact.includes('the suite'), false);
  assert.match(compact, /failed  1/);
  assert.match(compact, /passed  1/);
});

test('junit xml keeps the failure and counts the pass', () => {
  const text = [
    '<testsuite tests="2" failures="1">',
    '  <testcase classname="app.FooTest" name="adds"/>',
    '  <testcase classname="app.FooTest" name="rejects">',
    '    <failure message="expected 2 but was 1" type="AssertionError">expected 2 but was 1',
    '      at app.FooTest.rejects(FooTest.java:18)</failure>',
    '  </testcase>',
    '</testsuite>',
  ].join('\n');
  const compact = compactOutput(text);
  assert.match(compact, /app\.FooTest > rejects/);
  assert.match(compact, /expected 2 but was 1/);
  assert.match(compact, /FooTest\.java:18/);
  assert.equal(compact.includes('FooTest > adds'), false);
  assert.match(compact, /passed  1/);
});

test('pytest junit keeps the file and the line', () => {
  const text = [
    '<testsuite>',
    '  <testcase classname="tests.test_app" name="test_adds" file="tests/test_app.py" line="4"/>',
    '  <testcase classname="tests.test_app" name="test_rejects" file="tests/test_app.py" line="9">',
    '    <failure message="AssertionError: expected 2">tests/test_app.py:11: AssertionError: expected 2</failure>',
    '  </testcase>',
    '</testsuite>',
  ].join('\n');
  const compact = compactOutput(text);
  assert.match(compact, /tests\.test_app > test_rejects/);
  assert.match(compact, /AssertionError: expected 2/);
  assert.match(compact, /tests\/test_app\.py:9/);
  assert.equal(compact.includes('test_adds'), false);
});

test('vitest and jest json keep the failure message and the location', () => {
  const text = JSON.stringify({
    testResults: [
      {
        name: 'src/a.test.ts',
        assertionResults: [
          { ancestorTitles: ['keep'], title: 'adds', fullName: 'keep adds', status: 'passed', failureMessages: [] },
          {
            ancestorTitles: ['keep'],
            title: 'rejects',
            fullName: 'keep rejects',
            status: 'failed',
            failureMessages: ['AssertionError: expected 2\n    at src/a.test.ts:12:5'],
            location: { line: 12, column: 5 },
          },
        ],
      },
    ],
  });
  const compact = compactOutput(text);
  assert.match(compact, /keep > rejects/);
  assert.match(compact, /AssertionError: expected 2/);
  assert.match(compact, /src\/a\.test\.ts:12:5/);
  assert.equal(compact.includes('keep > adds'), false);
  assert.match(compact, /passed  1/);
});

test('go test json keeps the failing output and counts the pass', () => {
  const events = [
    { Action: 'run', Package: 'example.com/pkg', Test: 'TestAdds' },
    { Action: 'output', Package: 'example.com/pkg', Test: 'TestAdds', Output: '=== RUN   TestAdds\n' },
    { Action: 'pass', Package: 'example.com/pkg', Test: 'TestAdds' },
    { Action: 'run', Package: 'example.com/pkg', Test: 'TestRejects' },
    { Action: 'output', Package: 'example.com/pkg', Test: 'TestRejects', Output: '--- FAIL: TestRejects (0.00s)\n' },
    { Action: 'output', Package: 'example.com/pkg', Test: 'TestRejects', Output: '    foo_test.go:18: expected 2\n' },
    { Action: 'fail', Package: 'example.com/pkg', Test: 'TestRejects' },
  ];
  const compact = compactOutput(events.map((event) => JSON.stringify(event)).join('\n'));
  assert.match(compact, /example\.com\/pkg > TestRejects/);
  assert.match(compact, /foo_test\.go:18/);
  assert.match(compact, /expected 2/);
  assert.equal(compact.includes('TestAdds'), false);
  assert.match(compact, /passed  1/);
});

test('a log that is not a test report is left alone', () => {
  assert.equal(compactOutput('make: *** [test] Error 1\n'), null);
  assert.equal(compactOutput(''), null);
});

test('gate prints the failure, counts the pass, and keeps the raw log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-compact-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{ "scripts": { "test": "node --test" } }\n');
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 2;\n');
    await writeFile(
      join(root, 'test', 'keep.test.mjs'),
      [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { keep } from '../src/keep.mjs';",
        "test('adds the value', () => { assert.equal(typeof keep, 'number'); });",
        "test('rejects the value', () => { assert.equal(keep, 1); });",
        '',
      ].join('\n'),
    );
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    const ran = await capture(() => gateCommand(['src/keep.mjs'], { root }));
    assert.equal(ran.code, 1);
    assert.match(ran.stdout, /rejects the value/);
    assert.match(ran.stdout, /2 !== 1/);
    assert.match(ran.stdout, /keep\.test\.mjs:\d+:\d+/);
    assert.equal(ran.stdout.includes('adds the value'), false);
    assert.match(ran.stdout, /passed  1/);
    const raw = /raw  (\.simt\/local\/gate\/gate-\d+\.log)/.exec(ran.stdout);
    assert.ok(raw, ran.stdout);
    const log = await readFile(join(root, raw[1]), 'utf8');
    assert.match(log, /adds the value/);
    assert.match(log, /rejects the value/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function git(args) {
  return exec('git', ['-c', 'user.name=simt-dev tests', '-c', 'user.email=tests@example.com', '-c', 'commit.gpgsign=false', ...args], { maxBuffer: 16 << 20 });
}

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
