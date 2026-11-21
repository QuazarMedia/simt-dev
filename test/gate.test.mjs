// Diff-aware gates (R16, ADR-094).
//
// A change selects the test files that import it, directly or through other
// files. Selection is asserted on a synthetic graph below, so the test does
// not duplicate the checkout's import graph and does not widen whenever an
// unrelated test gains an import. The end-to-end gate run is asserted on a
// real fixture repository.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { gateCommand } from '../src/commands/gate.mjs';
import { detectTestRunner, nodeCommand } from '../src/testing/runners.mjs';
import { selectTests } from '../src/index/gate.mjs';
import { capture } from './fixture.mjs';

const exec = promisify(execFile);

test('selection follows importers and stops at a test that does not reach the change', () => {
  const imports = [
    { src: 'src/mid.mjs', dst: 'src/keep.mjs', kind: 'import' },
    { src: 'test/keep.test.mjs', dst: 'src/mid.mjs', kind: 'import' },
    { src: 'test/other.test.mjs', dst: 'src/other.mjs', kind: 'import' },
    { src: 'src/keep.mjs', dst: 'src/mid.mjs', kind: 'import' },
  ];
  assert.deepEqual(selectTests(['src/keep.mjs'], imports), ['test/keep.test.mjs']);
  assert.deepEqual(selectTests(['test/keep.test.mjs'], imports), ['test/keep.test.mjs']);
  assert.deepEqual(selectTests(['src/lonely.mjs'], imports), []);
});

test('gate runs the importing test and leaves the other one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{ "scripts": { "test": "node --test" } }\n');
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
    await writeFile(join(root, 'src', 'other.mjs'), 'export const other = 1;\n');
    await writeFile(
      join(root, 'test', 'keep.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { keep } from '../src/keep.mjs';\ntest('keeps the value', () => { assert.equal(keep, 1); });\n",
    );
    await writeFile(
      join(root, 'test', 'other.test.mjs'),
      "import { test } from 'node:test';\nimport { other } from '../src/other.mjs';\ntest('other', () => { if (other !== 1) throw new Error('other'); });\n",
    );
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);

    const ran = await capture(() => gateCommand(['src/keep.mjs'], { root }));
    assert.equal(ran.code, 0);
    assert.match(ran.stdout, /^selected  1\n/);
    assert.match(ran.stdout, /test\/keep\.test\.mjs/);
    assert.equal(ran.stdout.includes('test/other.test.mjs'), false);

    const quiet = await capture(() => gateCommand([], { root, changed: true }));
    assert.equal(quiet.code, 0);
    assert.match(quiet.stdout, /selected  0/);

    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 2;\n');
    const diff = await capture(() => gateCommand([], { root, changed: true }));
    assert.equal(diff.code, 1);
    assert.match(diff.stdout, /keeps the value/);

    const bare = await mkdtemp(join(tmpdir(), 'idx-gate-'));
    const refused = await capture(() => gateCommand(['src/keep.mjs'], { root: bare }));
    assert.equal(refused.code, 5);
    const usage = await capture(() => gateCommand([], { root }));
    assert.equal(usage.code, 2);
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gate --changed sees a modified non-ASCII path (Q39)', async () => {
  // Without `-z`, `git diff --name-only` C-quotes the path and the quoted form
  // matches nothing in the index, so the change selects no tests.
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{ "scripts": { "test": "node --test" } }\n');
    await writeFile(join(root, 'src', 'ünï.mjs'), 'export const uni = 1;\n');
    await writeFile(
      join(root, 'test', 'uni.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { uni } from '../src/ünï.mjs';\ntest('uni', () => { assert.equal(uni, 1); });\n",
    );
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await writeFile(join(root, 'src', 'ünï.mjs'), 'export const uni = 2;\n');
    const diff = await capture(() => gateCommand([], { root, changed: true }));
    assert.equal(diff.code, 1, diff.stdout);
    assert.match(diff.stdout, /test\/uni\.test\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gate names a nonexistent path, and says the empty set out loud (Q40)', async () => {
  // The old answer for `gate no/such/file.mjs` was ok:true with no tests -
  // indistinguishable from "safe". A path that is neither tracked nor on disk
  // is a usage error; a tracked file with no importers says `nothing-selected`.
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'lonely.mjs'), 'export const lonely = 1;\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    const missing = await capture(() => gateCommand(['no/such/file.mjs'], { root }));
    assert.equal(missing.code, 2);
    assert.match(`${missing.stdout}${missing.stderr}`, /no such file: no\/such\/file\.mjs/);
    const empty = await capture(() => gateCommand(['src/lonely.mjs'], { root, json: true }));
    assert.equal(empty.code, 0, empty.stderr);
    const payload = JSON.parse(empty.stdout);
    assert.deepEqual(payload.selected, []);
    assert.deepEqual(payload.unmatched, []);
    assert.equal(payload.graph, 'resolved');
    assert.equal(payload.verdict, 'nothing-selected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gate reports an unresolvable language graph (Q40)', async () => {
  // One Kotlin edge, zero resolutions: the graph cannot see the language, and
  // the payload says so instead of letting `selected: []` look like safety.
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await git(['init', '-q', root]);
    const dir = join(root, 'src', 'main', 'kotlin', 'com', 'foo');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'Main.kt'), 'import com.foo.Missing\nfun main() = 1\n');
    await writeFile(join(dir, 'Util.kt'), 'fun util() = 1\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    const payload = JSON.parse(
      (await capture(() => gateCommand(['src/main/kotlin/com/foo/Util.kt'], { root, json: true }))).stdout,
    );
    assert.deepEqual(payload.selected, []);
    assert.equal(payload.graph, 'unresolved');
    assert.equal(payload.verdict, 'nothing-selected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a declared test.runner answers before the detection chain (PR11)', async () => {
  // A package whose runner no detector knows: the repository says how to run its tests,
  // and the gate must run exactly that argv with the selected files, from the package.
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{ "name": "custom" }\n');
    await writeFile(
      join(root, 'runner.mjs'),
      "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\n",
    );
    await writeFile(
      join(root, 'simt.json'),
      JSON.stringify({ test: { runner: { command: [process.execPath, 'runner.mjs', '--pick', '{files}'] } } }),
    );
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
    await writeFile(
      join(root, 'test', 'keep.test.mjs'),
      "import { test } from 'node:test';\nimport { keep } from '../src/keep.mjs';\ntest('k', () => { if (keep !== 1) throw new Error('k'); });\n",
    );
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);

    const ran = await capture(() => gateCommand(['src/keep.mjs'], { root }));
    assert.equal(ran.code, 0, `${ran.stdout}${ran.stderr}`);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'argv.json'), 'utf8')), ['--pick', 'test/keep.test.mjs']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an invalid test.runner is a named configuration error (PR11)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
    await writeFile(
      join(root, 'test', 'keep.test.mjs'),
      "import { test } from 'node:test';\nimport { keep } from '../src/keep.mjs';\ntest('k', () => { if (keep !== 1) throw new Error('k'); });\n",
    );
    await writeFile(join(root, 'simt.json'), JSON.stringify({ test: { runner: { command: 'npm test' } } }));
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    const refused = await capture(() => gateCommand(['src/keep.mjs'], { root }));
    assert.equal(refused.code, 2);
    assert.match(`${refused.stdout}${refused.stderr}`, /invalid test\.runner/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a runner whose declared tool is missing is unsupported, not failed (PR11)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
    await writeFile(
      join(root, 'test', 'keep.test.mjs'),
      "import { test } from 'node:test';\nimport { keep } from '../src/keep.mjs';\ntest('k', () => { if (keep !== 1) throw new Error('k'); });\n",
    );
    await writeFile(
      join(root, 'simt.json'),
      JSON.stringify({ test: { runner: { command: [process.execPath, '-e', '0'], requires: ['simt-not-installed-xyz'] } } }),
    );
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    const refused = await capture(() => gateCommand(['src/keep.mjs'], { root }));
    assert.equal(refused.code, 5);
    assert.match(`${refused.stdout}${refused.stderr}`, /simt-not-installed-xyz/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a SEA executable is never the Node a test child runs (PR11)', () => {
  assert.equal(nodeCommand({ execPath: '/opt/simt/bin/simt', sea: true }), 'node');
  assert.equal(nodeCommand({ execPath: '/opt/simt/bin/simt', sea: false }), 'node');
  assert.equal(nodeCommand({ execPath: '/usr/local/bin/node', sea: false }), '/usr/local/bin/node');
});

test('a uv project runs pytest through uv (PR11)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "p"\n');
    await writeFile(join(root, 'uv.lock'), 'version = 1\n');
    const runner = await detectTestRunner(root, ['tests/test_app.py']);
    const built = runner.buildExec(root);
    assert.equal(built.cmd, 'uv');
    assert.deepEqual(built.args.slice(0, 2), ['run', 'pytest']);
    assert.deepEqual(runner.requires, ['uv']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "scripts": { "test": "node --test" } }\n');
  await writeFile(join(root, 'README.md'), 'read me\n');
  await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
  await writeFile(
    join(root, 'test', 'keep.test.mjs'),
    "import { test } from 'node:test';\nimport { keep } from '../src/keep.mjs';\ntest('k', () => { if (keep !== 1) throw new Error('k'); });\n",
  );
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

test('gate --changed reports a rename as one change, with both names (PR13)', async () => {
  const root = await fixtureRepo();
  try {
    await git(['-C', root, 'mv', 'src/keep.mjs', 'src/renamed.mjs']);
    await writeFile(
      join(root, 'test', 'keep.test.mjs'),
      "import { test } from 'node:test';\nimport { keep } from '../src/renamed.mjs';\ntest('k', () => { if (keep !== 1) throw new Error('k'); });\n",
    );
    const payload = JSON.parse(
      (await capture(() => gateCommand([], { root, changed: true, json: true }))).stdout,
    );
    assert.deepEqual(payload.renames, [{ from: 'src/keep.mjs', to: 'src/renamed.mjs' }]);
    assert.ok(payload.selected.includes('test/keep.test.mjs'), 'the renamed module still selects its test');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gate --strict refuses an unproven selection and names what it could not prove (PR13)', async () => {
  const root = await fixtureRepo();
  try {
    // A code change with no reachable test: the default answer stays compatible
    // (nothing-selected, exit 0), and strict says the truth instead.
    await writeFile(join(root, 'src', 'lonely.mjs'), 'export const lonely = 1;\n');
    const quiet = await capture(() => gateCommand(['src/lonely.mjs'], { root }));
    assert.equal(quiet.code, 0);
    const strict = await capture(() => gateCommand(['src/lonely.mjs'], { root, strict: true, json: true }));
    assert.equal(strict.code, 1);
    assert.equal(JSON.parse(strict.stdout).verdict, 'unproven-selection');

    // A docs-only change is the one empty selection that is the whole truth.
    await rm(join(root, 'src', 'lonely.mjs'));
    await writeFile(join(root, 'README.md'), 'read me again\n');
    const docs = await capture(() => gateCommand([], { root, changed: true, strict: true }));
    assert.equal(docs.code, 0, docs.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gate --strict fails when the runner never mentions the files it was given (PR13)', async () => {
  // A runner that ignores its selector exits 0 having run nothing. The old report
  // called that a pass; strict checks what the runner said it ran.
  const root = await fixtureRepo();
  try {
    await writeFile(
      join(root, 'simt.json'),
      JSON.stringify({ test: { runner: { command: [process.execPath, '-e', 'console.log("ok")', '{files}'] } } }),
    );
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 2;\n');
    const lenient = await capture(() => gateCommand(['src/keep.mjs'], { root }));
    assert.equal(lenient.code, 0, 'the compatibility answer is the runner exit code');
    const strict = await capture(() => gateCommand(['src/keep.mjs'], { root, strict: true, json: true }));
    assert.equal(strict.code, 1);
    const payload = JSON.parse(strict.stdout);
    assert.deepEqual(payload.runs[0].unproven, ['test/keep.test.mjs']);
    assert.equal(payload.runs[0].compact, 'unavailable', 'a non-report stays raw and says so');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('focused selection and the full suite deliberately disagree (PR33)', async () => {
  // The focused gate runs the importing test only. The same repository's full test
  // command still runs the unrelated failing test. They must not be made to agree:
  // a focused run is evidence about the change, not a replacement for the whole suite.
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{ "scripts": { "test": "node --test" } }\n');
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
    await writeFile(join(root, 'src', 'other.mjs'), 'export const other = 1;\n');
    await writeFile(
      join(root, 'test', 'keep.test.mjs'),
      "import { test } from 'node:test';\nimport { keep } from '../src/keep.mjs';\ntest('focused keep', () => { if (keep !== 1) throw new Error('keep'); });\n",
    );
    await writeFile(
      join(root, 'test', 'other.test.mjs'),
      "import { test } from 'node:test';\nimport { other } from '../src/other.mjs';\ntest('failing other', () => { if (other === 1) throw new Error('other'); });\n",
    );
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);

    const focused = await capture(() => gateCommand(['src/keep.mjs'], { root }));
    assert.equal(focused.code, 0, focused.stdout);
    assert.match(focused.stdout, /test\/keep\.test\.mjs/);
    assert.match(focused.stdout, /passed  1/);
    assert.equal(focused.stdout.includes('failing other'), false);

    let fullCode = 0;
    let fullText = '';
    // This test itself runs under `node --test`; a child that inherits
    // NODE_TEST_CONTEXT reports to the parent and exits 0 regardless of failures.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('NODE_TEST')) delete env[key];
    }
    try {
      const out = await exec('node', ['--test'], { cwd: root, env, maxBuffer: 16 << 20 });
      fullText = `${out.stdout}${out.stderr}`;
    } catch (error) {
      fullCode = error.code;
      fullText = `${error.stdout}${error.stderr}`;
    }
    assert.equal(fullCode, 1);
    assert.match(fullText, /failing other/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a nested Gradle package is attributed and runs from its own marker (PR33)', async () => {
  // The workspace projection reads `build.gradle`; the index and gate used to have a
  // different marker table, which attributed this source to the repository root and ran
  // its tests from there. One shared table makes the package boundary agree.
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'apps', 'web', 'src'), { recursive: true });
    await mkdir(join(root, 'apps', 'web', 'test'), { recursive: true });
    await writeFile(join(root, 'apps', 'web', 'build.gradle'), 'plugins { id "java" }\n');
    await writeFile(join(root, 'apps', 'web', 'src', 'keep.mjs'), 'export const keep = 1;\n');
    await writeFile(
      join(root, 'apps', 'web', 'test', 'keep.test.mjs'),
      "import { test } from 'node:test';\nimport { keep } from '../src/keep.mjs';\ntest('k', () => { if (keep !== 1) throw new Error('k'); });\n",
    );
    await writeFile(
      join(root, 'simt.json'),
      JSON.stringify({
        test: {
          runner: {
            command: [
              process.execPath,
              '-e',
              "require('fs').writeFileSync('cwd.txt', process.cwd())",
            ],
          },
        },
      }),
    );
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);

    const payload = JSON.parse(
      (await capture(() => gateCommand(['apps/web/src/keep.mjs'], { root, json: true }))).stdout,
    );
    assert.equal(payload.code, 0, payload.runs?.[0]?.stderr);
    assert.equal(payload.runs[0].package, 'apps/web');
    assert.equal(await readFile(join(root, 'apps', 'web', 'cwd.txt'), 'utf8'), await realpath(join(root, 'apps', 'web')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function git(args) {
  return exec('git', ['-c', 'user.name=simt-dev tests', '-c', 'user.email=tests@example.com', '-c', 'commit.gpgsign=false', ...args], { maxBuffer: 16 << 20 });
}


test('a hung runner is bounded by a deadline (PR14)', async () => {
  const root = await fixtureRepo();
  process.env.SIMT_GATE_TIMEOUT_MS = '300';
  try {
    await writeFile(
      join(root, 'simt.json'),
      JSON.stringify({ test: { runner: { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] } } }),
    );
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 2;\n');
    const payload = JSON.parse((await capture(() => gateCommand(['src/keep.mjs'], { root, json: true }))).stdout);
    assert.equal(payload.runs[0].timedOut, true);
    assert.equal(payload.code, 124, 'a deadline is a failure, not a pass');
  } finally {
    delete process.env.SIMT_GATE_TIMEOUT_MS;
    await rm(root, { recursive: true, force: true });
  }
});

test('a report the runner writes is read and then removed (PR14)', async () => {
  const root = await fixtureRepo();
  try {
    await writeFile(
      join(root, 'run.mjs'),
      "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync(process.argv[2], '<testsuites><testsuite name=\"t\"><testcase classname=\"t\" name=\"k\"/></testsuite></testsuites>');\n",
    );
    await writeFile(
      join(root, 'simt.json'),
      JSON.stringify({ test: { runner: { command: [process.execPath, 'run.mjs', '{report}'], report: 'junit', reportPath: 'report.xml' } } }),
    );
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 3;\n');
    const payload = JSON.parse((await capture(() => gateCommand(['src/keep.mjs'], { root, json: true }))).stdout);
    assert.equal(payload.code, 0, payload.runs?.[0]?.stderr);
    assert.deepEqual(payload.runs[0].passed, ['t > k']);
    assert.equal(payload.runs[0].compact, 'compacted');
    assert.equal(payload.runs[0].reportFormat, 'junit');
    assert.equal(existsSync(join(root, 'report.xml')), false, 'the report belongs to the run and is cleaned up');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
