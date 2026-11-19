// The Python runner's handoff, exercised rather than detected (review 0005 PR06).
//
// Detection and parsing were tested; `buildExec` was not, and it threw `CLI is not
// defined` the moment a valid test path reached it. The gate command is the public
// caller, so the regression is pinned there and in the unit below it.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { gateCommand } from '../src/commands/gate.mjs';
import { cleanupReports } from '../src/testing/parsers.mjs';
import { detectTestRunner } from '../src/testing/runners.mjs';
import { CLI } from '../src/name.mjs';
import { git, keepTemp } from './fixture.mjs';

const run = promisify(execFile);

async function pythonRepo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-pytest-'));
  keepTemp(root);
  await git(['init', '-q', '-b', 'main', '.'], { cwd: root });
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "p"\n');
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, 'tests', 'test_app.py'), 'def test_ok():\n    assert True\n');
  await git(['add', '-A'], { cwd: root });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base'], { cwd: root });
  return root;
}

/** A pytest that succeeds, on PATH, and writes the report path it was handed. */
async function stubPytest(dir) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'pytest');
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    --junitxml=*) report="${arg#--junitxml=}";;',
      '  esac',
      'done',
      'if [ -n "$report" ]; then',
      '  printf \'%s\' \'<testsuites><testsuite name="t"><testcase classname="tests.test_app" name="test_ok"/></testsuite></testsuites>\' > "$report"',
      'fi',
      'echo "1 passed"',
      'exit 0',
      '',
    ].join('\n'),
  );
  await chmod(path, 0o755);
  return dir;
}

test('a Python run names a report path this process owns', async () => {
  const root = await pythonRepo();
  const runner = await detectTestRunner(root, ['tests/test_app.py']);
  const built = runner.buildExec(root);
  assert.equal(built.cmd, 'pytest');
  const flag = built.args.find((arg) => arg.startsWith('--junitxml='));
  assert.ok(flag, 'the run was not given a report path');
  const report = flag.slice('--junitxml='.length);
  assert.equal(dirname(report), tmpdir(), 'the report belongs to the run, not to the sources');
  assert.ok(basename(report).startsWith(`${CLI}-junit-${process.pid}-`), `unowned report name: ${report}`);
  assert.deepEqual(built.reportPaths, [report]);
});

test('cleanup removes only a report this process created', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simt-cleanup-'));
  keepTemp(dir);
  const root = await pythonRepo();
  const built = (await detectTestRunner(root, ['tests/test_app.py'])).buildExec(root);
  const own = built.reportPaths[0];
  const foreign = join(tmpdir(), `someone-else-${process.pid}.xml`);
  await writeFile(own, '<testsuites/>');
  await writeFile(foreign, '<testsuites/>');
  await cleanupReports([own, foreign]);
  assert.equal(await readFile(own, 'utf8').catch(() => null), null, 'the report this run made is gone');
  assert.equal(await readFile(foreign, 'utf8'), '<testsuites/>', 'a temp file this process did not name is not ours to delete');
});

test('the focused gate runs pytest for a Python test, and exits with its verdict', async () => {
  const root = await pythonRepo();
  const stub = await stubPytest(join(root, '..', `${basename(root)}-bin`));
  keepTemp(stub);
  const path = process.env.PATH;
  process.env.PATH = `${stub}:${path}`;
  try {
    const result = await run(process.execPath, [join(process.cwd(), 'bin', 'simt.mjs'), 'gate', 'tests/test_app.py', '--json', '--root', root], {
      cwd: root,
      maxBuffer: 32 << 20,
    }).then(
      (out) => ({ code: 0, stdout: out.stdout, stderr: out.stderr }),
      (error) => ({ code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.deepEqual(
      payload.runs.map((r) => r.command),
      ['pytest tests/test_app.py'],
      'the gate did not reach the Python runner',
    );
  } finally {
    process.env.PATH = path;
  }
});

test('the gate command itself reaches the runner without throwing', async () => {
  const root = await pythonRepo();
  const stub = await stubPytest(join(root, '..', `${basename(root)}-bin2`));
  keepTemp(stub);
  const path = process.env.PATH;
  process.env.PATH = `${stub}:${path}`;
  try {
    // In-process, where a thrown `CLI is not defined` surfaces as a rejection rather than
    // an exit code the shell test above would report as an ordinary failure.
    assert.equal(await gateCommand(['tests/test_app.py'], { root }), 0);
  } finally {
    process.env.PATH = path;
  }
});
