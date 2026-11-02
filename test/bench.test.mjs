import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DEFAULT_MINE_TARGET, listCandidates, mineTasks, patchStats } from '../packages/bench/src/mine.mjs';
import { isTestPath } from '../src/testing/paths.mjs';
import { ensureGit } from './fixture.mjs';
import { detectTestRunner } from '../src/testing/runners.mjs';
import { resolveVaultDir } from '../src/testing/vault.mjs';
import {
  parseCargoTestOutput,
  parseGoTestJson,
  parseJunitXml,
  parseTapOutput,
  parseVitestJson,
  readReports,
} from '../src/testing/parsers.mjs';
import {
  CORPUS_KIND,
  CORPUS_SCHEMA_VERSION,
  buildCorpusDocument,
  verifyCorpusDocument,
  writeCorpusDocument,
} from '../src/measure/corpus.mjs';
import { gradeWorkspace } from '../packages/bench/src/grade.mjs';
import { extractPatchFiles } from '../src/testing/patches.mjs';
import { spawnBounded } from '../src/sys/proc.mjs';
import { BUILTIN_ARMS, materialiseArm, parseArmSpec } from '../packages/bench/src/arms.mjs';
import { adapterIsolation, agentEnv, loadAdapters, parseAdapterUsage } from '../packages/bench/src/adapters.mjs';
import { regradeRun, runBench } from '../packages/bench/src/run.mjs';
import { prepareIsolatedWorkspace } from '../packages/bench/src/workspace.mjs';
import { buildBenchReport } from '../packages/bench/src/report.mjs';
import { formatReportMarkdown } from '../packages/bench/src/render.mjs';
import { loadRunRecords } from '../src/measure/records.mjs';
import {
  computeRunCost,
  computeRunQuality,
  evaluateRunRecord,
  isRunResolved,
  loadPrices,
} from '../src/measure/metrics.mjs';
import {
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  MIN_PAIRD_TASKS,
  NON_INFERIORITY_MARGIN,
  bootstrapArmCi,
  compareArms,
  holmAdjust,
  mcnemarTest,
  signTest,
  wilcoxonSignedRank,
} from '../src/measure/stats.mjs';
import {
  CANARY_ALPHA,
  DEFAULT_CANARY_SIZE,
  DEL_R_TOLERANCE,
  ablateBench,
  ablateSectionInWorkspace,
  formatAblationMarkdown,
  isDeletionCandidate,
  listAblationSections,
  parseAblationArmName,
  parseCoreSections,
  removeCoreSectionFromBody,
  removeTopSectionFromBody,
  shouldEscalateCanary,
  slugifyHeading,
} from '../packages/bench/src/ablate.mjs';
import {
  CALIBRATION_HARNESSES,
  PROBES,
  appendLedgerEntry,
  extractTranscriptCommands,
  formatProbesMarkdown,
  gradeProbe,
  loadProbeRecords,
  prepareProbeWorkspace,
  readLedgerEntries,
  runBenchProbes,
} from '../packages/bench/src/probes.mjs';
import { git } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BIN = resolve(ROOT, 'bin', 'simt.mjs');
const exec = promisify(execFile);
const tempDirs = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function scratch(prefix = 'simt-bench-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 16 << 20,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

test('isTestPath classifies test paths across node, vitest, pytest, go, rust, gradle and maven', () => {
  assert.equal(isTestPath('test/resolve.test.mjs'), true);
  assert.equal(isTestPath('tests/unit/api.spec.ts'), true);
  assert.equal(isTestPath('spec/models/user_spec.rb'), true);
  assert.equal(isTestPath('src/components/__tests__/Button.tsx'), true);
  assert.equal(isTestPath('src/math.test.ts'), true);
  assert.equal(isTestPath('pkg/auth/token_test.go'), true);
  assert.equal(isTestPath('tests/api.rs'), true);
  assert.equal(isTestPath('src/test_parser.py'), true);
  assert.equal(isTestPath('src/test/kotlin/com/example/ApiTest.kt'), true);
  assert.equal(isTestPath('src/test/java/com/example/ApiTests.java'), true);

  assert.equal(isTestPath('src/resolve/resolve.mjs'), false);
  assert.equal(isTestPath('pkg/auth/token.go'), false);
  assert.equal(isTestPath('src/lib.rs'), false);
  assert.equal(isTestPath('src/main/kotlin/com/example/Api.kt'), false);
  assert.equal(isTestPath('README.md'), false);
});

test('parseTapOutput extracts leaf passed and failed test ids with suite hierarchy', () => {
  const sample = [
    'TAP version 13',
    '# Subtest: resolve',
    '    # Subtest: matchesGlob leading **',
    '    ok 1 - matchesGlob leading **',
    '      ---',
    '      duration_ms: 0.2',
    "      type: 'test'",
    '      ...',
    '    # Subtest: tokenize',
    '    not ok 2 - tokenize',
    '      ---',
    '      duration_ms: 0.4',
    "      type: 'test'",
    '      ...',
    '    1..2',
    'not ok 1 - resolve',
    '  ---',
    '  duration_ms: 0.9',
    "  type: 'suite'",
    '  ...',
    '# Subtest: standalone leaf',
    'ok 2 - standalone leaf',
    '  ---',
    '  duration_ms: 0.1',
    "  type: 'test'",
    '  ...',
    '1..2',
  ].join('\n');

  const parsed = parseTapOutput(sample);
  assert.deepEqual(parsed.passed, ['resolve > matchesGlob leading **', 'standalone leaf']);
  assert.deepEqual(parsed.failed, ['resolve > tokenize']);
});

test('parseVitestJson extracts passed and failed assertion ids from vitest json output', () => {
  const sample = JSON.stringify({
    numTotalTests: 2,
    testResults: [
      {
        name: '/repo/test/math.test.ts',
        assertionResults: [
          { ancestorTitles: ['math', 'add'], title: 'adds positives', status: 'passed' },
          { ancestorTitles: ['math', 'add'], title: 'handles negatives', status: 'failed' },
          { ancestorTitles: ['math'], title: 'skipped one', status: 'skipped' },
        ],
      },
    ],
  });

  const parsed = parseVitestJson(sample);
  assert.deepEqual(parsed.passed, ['math > add > adds positives']);
  assert.deepEqual(parsed.failed, ['math > add > handles negatives']);
});

test('parseJunitXml extracts passed and failed testcases for pytest, gradle and maven', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="suite" tests="3" failures="1" errors="0" skipped="1">
    <testcase classname="com.example.CalcTest" name="addsTwoNumbers" time="0.01"/>
    <testcase classname="com.example.CalcTest" name="dividesByZero" time="0.02">
      <failure message="expected ArithmeticException">stack</failure>
    </testcase>
    <testcase classname="com.example.CalcTest" name="ignoredCase" time="0.00">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;

  const parsed = parseJunitXml(xml);
  assert.deepEqual(parsed.passed, ['com.example.CalcTest > addsTwoNumbers']);
  assert.deepEqual(parsed.failed, ['com.example.CalcTest > dividesByZero']);
});

test('parseGoTestJson extracts leaf test pass and fail events and ignores package summaries', () => {
  const stream = [
    JSON.stringify({ Action: 'run', Package: 'example.com/calc', Test: 'TestAdd' }),
    JSON.stringify({ Action: 'pass', Package: 'example.com/calc', Test: 'TestAdd' }),
    JSON.stringify({ Action: 'run', Package: 'example.com/calc', Test: 'TestSub' }),
    JSON.stringify({ Action: 'fail', Package: 'example.com/calc', Test: 'TestSub' }),
    JSON.stringify({ Action: 'fail', Package: 'example.com/calc' }),
  ].join('\n');

  const parsed = parseGoTestJson(stream);
  assert.deepEqual(parsed.passed, ['example.com/calc > TestAdd']);
  assert.deepEqual(parsed.failed, ['example.com/calc > TestSub']);
});

test('parseCargoTestOutput extracts passed and failed tests and ignores skipped and summary lines', () => {
  const stream = [
    '   Compiling calc v0.1.0',
    'running 3 tests',
    'test tests::adds ... ok',
    'test tests::divides ... FAILED',
    'test tests::slow ... ignored',
    'test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out',
    '',
    'running 1 test',
    'test src/lib.rs - add (line 4) ... ok',
    'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
  ].join('\n');

  const parsed = parseCargoTestOutput(stream);
  assert.deepEqual(parsed.passed, ['src/lib.rs - add (line 4)', 'tests::adds']);
  assert.deepEqual(parsed.failed, ['tests::divides']);
});

test('detectTestRunner selects the native runner for each ecosystem', async () => {
  const nodeRepo = await scratch('simt-runner-node-');
  await writeFile(join(nodeRepo, 'package.json'), '{"name":"n"}\n');
  const nodeRunner = await detectTestRunner(nodeRepo, ['test/a.test.mjs']);
  assert.equal(nodeRunner.runner, 'node-test');
  assert.equal(nodeRunner.displayCmd, 'node --test test/a.test.mjs');

  const vitestRepo = await scratch('simt-runner-vitest-');
  await writeFile(
    join(vitestRepo, 'package.json'),
    JSON.stringify({ name: 'v', devDependencies: { vitest: '^2.0.0' } }),
  );
  const vitestRunner = await detectTestRunner(vitestRepo, ['test/a.test.ts']);
  assert.equal(vitestRunner.runner, 'vitest');
  assert.equal(vitestRunner.displayCmd, 'vitest run --reporter=json test/a.test.ts');

  const cargoRepo = await scratch('simt-runner-cargo-');
  await writeFile(join(cargoRepo, 'Cargo.toml'), '[package]\nname = "c"\n');
  const cargoRunner = await detectTestRunner(cargoRepo, ['tests/api.rs']);
  assert.equal(cargoRunner.runner, 'cargo-test');
  assert.equal(cargoRunner.displayCmd, 'cargo test --test api');

  // An inline unit test cannot be selected as a file, so the crate's binary runs.
  const cargoUnitRunner = await detectTestRunner(cargoRepo, ['src/lib.rs']);
  assert.equal(cargoUnitRunner.displayCmd, 'cargo test');

  const goRepo = await scratch('simt-runner-go-');
  await writeFile(join(goRepo, 'go.mod'), 'module example.com/m\n');
  const goRunner = await detectTestRunner(goRepo, ['pkg/foo/foo_test.go']);
  assert.equal(goRunner.runner, 'go-test');
  assert.equal(goRunner.displayCmd, 'go test -json ./pkg/foo');

  const pyRepo = await scratch('simt-runner-py-');
  await writeFile(join(pyRepo, 'pyproject.toml'), '[project]\nname = "p"\n');
  const pyRunner = await detectTestRunner(pyRepo, ['tests/test_app.py']);
  assert.equal(pyRunner.runner, 'pytest');
  assert.equal(pyRunner.displayCmd, 'pytest tests/test_app.py');

  const gradleRepo = await scratch('simt-runner-gradle-');
  await writeFile(join(gradleRepo, 'build.gradle.kts'), 'plugins {}\n');
  const gradleRunner = await detectTestRunner(gradleRepo, ['src/test/kotlin/AppTest.kt']);
  assert.equal(gradleRunner.runner, 'gradle');
  assert.equal(gradleRunner.displayCmd, './gradlew test --tests *AppTest*');

  const mavenRepo = await scratch('simt-runner-maven-');
  await writeFile(join(mavenRepo, 'pom.xml'), '<project/>\n');
  const mavenRunner = await detectTestRunner(mavenRepo, ['src/test/java/AppTest.java']);
  assert.equal(mavenRunner.runner, 'maven');
  assert.equal(mavenRunner.displayCmd, 'mvn test -Dtest=AppTest');
});

test('patchStats counts added and removed lines without counting diff headers', () => {
  const diff = [
    'diff --git a/src/a.mjs b/src/a.mjs',
    '--- a/src/a.mjs',
    '+++ b/src/a.mjs',
    '@@ -1,2 +1,3 @@',
    '-const oldVal = 1;',
    '+const newVal = 2;',
    '+const extra = 3;',
  ].join('\n');
  assert.deepEqual(patchStats(diff, 1), { files: 1, linesAdded: 2, linesRemoved: 1 });
});

test('mineTasks validates RED and GOLD twice, drops non-RED commits, and writes deterministic tasks and vault patches', async () => {
  const repo = await scratch('simt-mine-repo-');
  const vaultEnv = await scratch('simt-mine-vault-');
  const env = { ...process.env, SIMT_DEV_VAULT_DIR: vaultEnv };

  await git(['init', '-q', '.'], { cwd: repo });
  await writeFile(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'fixture-repo', type: 'module' }, null, 2)}\n`,
  );
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'test'), { recursive: true });
  await writeFile(
    join(repo, 'src', 'calc.mjs'),
    [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      'export function multiply(_a, _b) {',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(repo, 'test', 'calc.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/calc.mjs';",
      '',
      "test('calc: add sums two integers', () => {",
      '  assert.equal(add(2, 3), 5);',
      '});',
      '',
    ].join('\n'),
  );
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-qm', 'chore: initial calculator'], { cwd: repo });

  // Commit 2: valid task (adds multiply + failing test on BASE that passes on GOLD).
  await writeFile(
    join(repo, 'src', 'calc.mjs'),
    [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      'export function multiply(a, b) {',
      '  return a * b;',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(repo, 'test', 'calc.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add, multiply } from '../src/calc.mjs';",
      '',
      "test('calc: add sums two integers', () => {",
      '  assert.equal(add(2, 3), 5);',
      '});',
      '',
      "test('calc: multiply multiplies two integers', () => {",
      '  assert.equal(multiply(4, 5), 20);',
      '});',
      '',
    ].join('\n'),
  );
  await git(['add', '-A'], { cwd: repo });
  await git(
    ['commit', '-qm', 'feat(calc): add multiply helper\n\nAdds multiply(a, b) and unit test.'],
    { cwd: repo },
  );

  // Commit 3: touches both test and impl, but test passes on BASE (not RED -> must be skipped).
  await writeFile(
    join(repo, 'src', 'calc.mjs'),
    [
      '// comment-only refactor in impl',
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      'export function multiply(a, b) {',
      '  return a * b;',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(repo, 'test', 'calc.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add, multiply } from '../src/calc.mjs';",
      '',
      "test('calc: add sums two integers', () => {",
      '  assert.equal(add(2, 3), 5);',
      '  assert.equal(add(0, 0), 0);',
      '});',
      '',
      "test('calc: multiply multiplies two integers', () => {",
      '  assert.equal(multiply(4, 5), 20);',
      '});',
      '',
    ].join('\n'),
  );
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-qm', 'chore(calc): add zero assertion that already passes'], { cwd: repo });

  const candidates = await listCandidates(repo);
  assert.equal(candidates.ok, true);
  assert.equal(candidates.candidates.length, 2, 'both commits touch test and impl paths');

  // Preview mode (apply: false) writes nothing.
  const preview = await mineTasks(repo, { apply: false, env });
  assert.equal(preview.ok, true);
  assert.equal(preview.applied, false);
  assert.equal(existsSync(join(repo, '.simt', 'bench', 'tasks')), false);

  // Apply mode validates RED -> GOLD twice and keeps only commit 2.
  const firstRun = await mineTasks(repo, { apply: true, env });
  assert.equal(firstRun.ok, true);
  assert.equal(firstRun.tasks.length, 1);

  const [task] = firstRun.tasks;
  assert.equal(task.schemaVersion, 2);
  // 12 hex chars: the 7-char form could not disambiguate two tasks mined from
  // the same commit (review 0003 Q48); the committed corpus keeps its 7-char
  // ids and is covered by the corpus test below.
  assert.match(task.id, /^t-[0-9a-f]{12}-01$/);
  // Subject only: the body narrates the fix and would hand the agent the answer
  // (review 0003 Q49). The basis is recorded so a reader knows which it got.
  assert.equal(task.prompt, 'feat(calc): add multiply helper');
  assert.equal(task.promptBasis, 'subject');
  assert.equal(task.testCmd, 'node --test test/calc.test.mjs');
  assert.deepEqual(task.f2p, ['calc: multiply multiplies two integers']);
  assert.deepEqual(task.p2p, ['calc: add sums two integers']);
  assert.deepEqual(task.gold, { files: 1, linesAdded: 2, linesRemoved: 2 });
  assert.equal(task.vault, `vault/${task.id}`);

  const taskFile = join(repo, '.simt', 'bench', 'tasks', `${task.id}.json`);
  const bytesFirst = await readFile(taskFile, 'utf8');

  // Vault holds both patches outside the worktree, readable by its owner only.
  const vaultRoot = resolveVaultDir(repo, { env });
  const vaultDir = join(vaultRoot, task.id);
  assert.equal(existsSync(join(vaultDir, 'test.patch')), true);
  assert.equal(existsSync(join(vaultDir, 'gold.patch')), true);
  assert.equal((await stat(vaultRoot)).mode & 0o777, 0o700, 'the vault root is owner-only');
  assert.equal((await stat(vaultDir)).mode & 0o777, 0o700, 'a task vault is owner-only');

  // Re-running on identical history yields byte-identical task JSON.
  const secondRun = await mineTasks(repo, { apply: true, env });
  assert.equal(secondRun.ok, true);
  const bytesSecond = await readFile(taskFile, 'utf8');
  assert.equal(bytesSecond, bytesFirst);
});

test('simt-dev has at least 20 verified tasks in .simt/bench/tasks matching Appendix A schema', async () => {
  const tasksDir = join(ROOT, '.simt', 'bench', 'tasks');
  const files = (await readdir(tasksDir)).filter((f) => f.endsWith('.json')).sort();
  assert.ok(
    files.length >= DEFAULT_MINE_TARGET,
    `expected at least ${DEFAULT_MINE_TARGET} mined tasks in simt-dev, found ${files.length}`,
  );

  for (const file of files) {
    const raw = await readFile(join(tasksDir, file), 'utf8');
    const task = JSON.parse(raw);
    // v1 and v2 both read: a corpus mined before schema v2 is still a corpus this
    // reader accepts, and `simt bench mine` writes v2 from here on.
    assert.ok([1, 2].includes(task.schemaVersion), `${file}: no known schemaVersion (${task.schemaVersion})`);
    assert.equal(`${task.id}.json`, file, `${file}: id does not match filename`);
    assert.match(task.id, /^t-[0-9a-f]{7}-01$/);
    assert.match(task.base, /^[0-9a-f]{40}$/);
    assert.match(task.sourceCommit, /^[0-9a-f]{40}$/);
    assert.ok(task.id.startsWith(`t-${task.sourceCommit.slice(0, 7)}-`));
    assert.ok(typeof task.prompt === 'string' && task.prompt.length > 0);
    assert.match(task.testCmd, /^node --test /);
    assert.ok(Array.isArray(task.f2p) && task.f2p.length > 0, `${file}: f2p must be non-empty`);
    assert.ok(Array.isArray(task.p2p));
    assert.ok(typeof task.gold === 'object' && task.gold.files >= 1);
    assert.equal(task.vault, `vault/${task.id}`);
  }
});

// A two-commit calculator repo whose second commit is a valid mining task
// (adds multiply: RED on BASE, GOLD with the patch). Shared by the Q48 corpus
// tests so each stages the same history in one call.
async function calcRepo() {
  const repo = await scratch('simt-q48-repo-');
  await git(['init', '-q', '.'], { cwd: repo });
  await writeFile(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'fixture-repo', type: 'module' }, null, 2)}\n`,
  );
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'test'), { recursive: true });
  await writeFile(
    join(repo, 'src', 'calc.mjs'),
    ['export function add(a, b) {', '  return a + b;', '}', ''].join('\n'),
  );
  await writeFile(
    join(repo, 'test', 'calc.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/calc.mjs';",
      '',
      "test('calc: add sums two integers', () => {",
      '  assert.equal(add(2, 3), 5);',
      '});',
      '',
    ].join('\n'),
  );
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-qm', 'chore: initial calculator'], { cwd: repo });

  await writeFile(
    join(repo, 'src', 'calc.mjs'),
    [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      'export function multiply(a, b) {',
      '  return a * b;',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(repo, 'test', 'calc.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add, multiply } from '../src/calc.mjs';",
      '',
      "test('calc: add sums two integers', () => {",
      '  assert.equal(add(2, 3), 5);',
      '});',
      '',
      "test('calc: multiply multiplies two integers', () => {",
      '  assert.equal(multiply(4, 5), 20);',
      '});',
      '',
    ].join('\n'),
  );
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-qm', 'feat(calc): add multiply helper\n\nAdds multiply(a, b) and unit test.'], { cwd: repo });
  return repo;
}

test('the vault is keyed on the root commit, so a clone at another path resolves the same vault', async () => {
  const src = await calcRepo();
  const parent = await scratch('simt-q48-clone-parent-');
  // Clone under a different parent but the same basename: the identity the vault
  // is keyed on must be the history, not the checkout path.
  const clone = join(parent, basename(src));
  await git(['clone', '-q', src, clone]);

  const env = { ...process.env };
  assert.equal(resolveVaultDir(clone, { env }), resolveVaultDir(src, { env }));

  // The key is the basename plus the root commit's prefix, not the absolute path.
  assert.match(basename(resolveVaultDir(src, { env })), /-.+-root-[0-9a-f]{8}$/);
});

test('a re-mine is append-only: pre-existing tasks survive, and only --replace deletes them', async () => {
  const repo = await calcRepo();
  const vaultEnv = await scratch('simt-q48-vault-');
  const env = { ...process.env, SIMT_DEV_VAULT_DIR: vaultEnv };
  const tasksDir = join(repo, '.simt', 'bench', 'tasks');

  const first = await mineTasks(repo, { apply: true, env });
  assert.equal(first.ok, true);
  assert.equal(first.tasks.length, 1);
  const realId = first.tasks[0].id;

  // A task from an older history the current mine does not reproduce.
  const staleId = 't-deadbeef0001-01';
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    join(tasksDir, `${staleId}.json`),
    `${JSON.stringify({ schemaVersion: 1, id: staleId, sourceCommit: 'd'.repeat(40) }, null, 2)}\n`,
  );

  // Default (append-only): the stale task survives the re-mine.
  const second = await mineTasks(repo, { apply: true, env });
  assert.equal(second.ok, true);
  assert.equal(existsSync(join(tasksDir, `${staleId}.json`)), true);
  assert.equal(existsSync(join(tasksDir, `${realId}.json`)), true);

  // --replace: the stale task is deleted, the reproduced task is kept.
  const third = await mineTasks(repo, { apply: true, env, replace: true });
  assert.equal(third.ok, true);
  assert.equal(existsSync(join(tasksDir, `${staleId}.json`)), false);
  assert.equal(existsSync(join(tasksDir, `${realId}.json`)), true);
});

test('readReports walks a JUnit report directory, so the Gradle and Maven graders read every XML', async () => {
  const root = await scratch('simt-q48-junit-');
  const results = join(root, 'build', 'test-results', 'test');
  await mkdir(results, { recursive: true });
  await writeFile(
    join(results, 'TEST-com.example.CalcTest.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="CalcTest" tests="2" failures="1">
  <testcase classname="com.example.CalcTest" name="addsTwoNumbers" time="0.01"/>
  <testcase classname="com.example.CalcTest" name="dividesByZero" time="0.02">
    <failure message="expected ArithmeticException"/>
  </testcase>
</testsuite>`,
  );
  await writeFile(
    join(results, 'TEST-com.example.MathTest.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="MathTest" tests="1" failures="0">
  <testcase classname="com.example.MathTest" name="roundsHalfUp" time="0.01"/>
</testsuite>`,
  );
  // A non-XML artifact in the same directory must be ignored.
  await writeFile(join(results, 'binary-output.bin'), 'not xml');

  const text = await readReports([results]);
  const parsed = parseJunitXml(text);
  assert.deepEqual(parsed.passed, ['com.example.CalcTest > addsTwoNumbers', 'com.example.MathTest > roundsHalfUp']);
  assert.deepEqual(parsed.failed, ['com.example.CalcTest > dividesByZero']);

  // A single report file is still read; a missing path contributes nothing.
  const single = join(root, 'single.xml');
  await writeFile(single, '<testsuite><testcase classname="c" name="t"/></testsuite>');
  assert.match(await readReports([single, join(root, 'absent.xml')]), /<testcase classname="c" name="t"\/>/);
  assert.equal(await readReports([join(root, 'absent-dir')]), '');
});

test('a 12-char id that already holds a different commit is a collision, refused without --replace', async () => {
  const repo = await calcRepo();
  const vaultEnv = await scratch('simt-q48-vault-');
  const env = { ...process.env, SIMT_DEV_VAULT_DIR: vaultEnv };
  const tasksDir = join(repo, '.simt', 'bench', 'tasks');

  const first = await mineTasks(repo, { apply: true, env });
  assert.equal(first.ok, true);
  const [task] = first.tasks;
  assert.match(task.id, /^t-[0-9a-f]{12}-01$/);

  // The same id now holds a task from a different commit: the 12-char prefix
  // collided, and guessing which corpus the reader wants is worse than refusing.
  const taskPath = join(tasksDir, `${task.id}.json`);
  const prior = JSON.parse(await readFile(taskPath, 'utf8'));
  prior.sourceCommit = 'e'.repeat(40);
  await writeFile(taskPath, `${JSON.stringify(prior, null, 2)}\n`);

  const collided = await mineTasks(repo, { apply: true, env });
  assert.equal(collided.ok, false);
  assert.match(collided.error, /id collision:/);
  assert.match(collided.error, /--replace/);

  // --replace takes the corpus over: the file is rewritten from the current mine.
  const replaced = await mineTasks(repo, { apply: true, env, replace: true });
  assert.equal(replaced.ok, true);
  const after = JSON.parse(await readFile(taskPath, 'utf8'));
  assert.equal(after.sourceCommit, task.sourceCommit);
});

test('a sealed corpus export imports byte-for-byte, and a tampered seal is refused', async () => {
  const src = await calcRepo();
  const srcVault = await scratch('simt-q48-src-vault-');
  const srcEnv = { ...process.env, SIMT_DEV_VAULT_DIR: srcVault };

  const mined = await mineTasks(src, { apply: true, env: srcEnv });
  assert.equal(mined.ok, true);
  assert.equal(mined.tasks.length, 1);
  const [task] = mined.tasks;

  const doc = await buildCorpusDocument(src, { env: srcEnv });
  assert.equal(doc.kind, CORPUS_KIND);
  assert.equal(doc.schemaVersion, CORPUS_SCHEMA_VERSION);
  assert.equal(doc.taskCount, 1);
  assert.equal(verifyCorpusDocument(doc), null);

  // Deterministic: a second build of the same corpus seals to the same byte.
  const again = await buildCorpusDocument(src, { env: srcEnv });
  assert.equal(again.seal, doc.seal);

  // Import into a fresh root with its own vault: descriptors and both patches land.
  const dest = await scratch('simt-q48-dest-');
  const destVault = await scratch('simt-q48-dest-vault-');
  const destEnv = { ...process.env, SIMT_DEV_VAULT_DIR: destVault };
  const written = await writeCorpusDocument(dest, doc, { env: destEnv, apply: true });
  assert.equal(written.applied, true);
  assert.equal(written.tasks, 1);

  const imported = JSON.parse(await readFile(join(dest, '.simt', 'bench', 'tasks', `${task.id}.json`), 'utf8'));
  assert.equal(imported.sourceCommit, task.sourceCommit);
  // The vault is keyed <vaultBase>/<repo-id>/<task-id>/: the imported patches land
  // under the destination's own repo id, not the source's.
  assert.equal(existsSync(join(written.vaultRoot, task.id, 'test.patch')), true);
  assert.equal(existsSync(join(written.vaultRoot, task.id, 'gold.patch')), true);
  // The imported vault patch round-trips to the bytes the miner wrote.
  const srcVaultRoot = resolveVaultDir(src, { env: srcEnv });
  const srcPatch = await readFile(join(srcVaultRoot, task.id, 'test.patch'));
  const destPatch = await readFile(join(written.vaultRoot, task.id, 'test.patch'));
  assert.deepEqual(destPatch, srcPatch);

  // A dry-run import writes nothing.
  const dryDest = await scratch('simt-q48-dry-');
  const dry = await writeCorpusDocument(dryDest, doc, { env: destEnv, apply: false });
  assert.equal(dry.applied, false);
  assert.equal(existsSync(join(dryDest, '.simt', 'bench', 'tasks')), false);

  // Tampering with any payload byte breaks the seal.
  const tampered = structuredClone(doc);
  tampered.tasks[0].task.prompt = 'tampered';
  assert.match(verifyCorpusDocument(tampered), /seal mismatch/);
  assert.match(verifyCorpusDocument(null), /not a corpus document/);
  assert.match(verifyCorpusDocument({ kind: 'other' }), /unexpected kind/);
});

test('CLI `simt bench mine` previews without --yes and supports --json', async () => {
  await ensureGit(ROOT);
  const { code, stdout } = await runCli(['bench', 'mine', '--root', ROOT]);
  assert.equal(code, 0);
  assert.match(stdout, /mode\s+preview/);
  assert.match(stdout, /remedy\s+run: simt bench mine --yes/);

  const jsonRes = await runCli(['bench', 'mine', '--root', ROOT, '--json']);
  assert.equal(jsonRes.code, 0);
  const payload = JSON.parse(jsonRes.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'bench mine');
  assert.equal(payload.applied, false);
  // The count belongs to the history, not to the contract: this repository's commit
  // count is an accident of when the test runs, and a source archive has one commit.
  assert.equal(typeof payload.candidates, 'number');
});

test('loadAdapters and parseAdapterUsage map usage across claude, codex, gemini, opencode, cursor and aider', async () => {
  const adapters = await loadAdapters();
  for (const id of ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'aider', 'gold', 'noop']) {
    assert.ok(adapters[id], `missing adapter definition for ${id}`);
  }

  const claudeOut = JSON.stringify({
    usage: {
      input_tokens: 1200,
      cache_creation_input_tokens: 400,
      cache_read_input_tokens: 3000,
      output_tokens: 350,
    },
    num_turns: 4,
    num_tool_calls: 6,
    total_cost_usd: 0.0425,
  });
  assert.deepEqual(parseAdapterUsage(adapters.claude, claudeOut), {
    usage: { input: 1200, cacheWrite: 400, cacheRead: 3000, output: 350, turns: 4, toolCalls: 6 },
    costUsd: 0.0425,
  });

  const codexOut = [
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 800, cached_input_tokens: 500, output_tokens: 150 },
    }),
    JSON.stringify({ type: 'item.completed', item: { type: 'tool_call' } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 900, cache_write_input_tokens: 100, cached_input_tokens: 700, output_tokens: 200 },
      cost_usd: 0.015,
    }),
  ].join('\n');
  assert.deepEqual(parseAdapterUsage(adapters.codex, codexOut), {
    usage: { input: 1700, cacheWrite: 100, cacheRead: 1200, output: 350, turns: 2, toolCalls: 2 },
    costUsd: 0.015,
  });

  const geminiOut = JSON.stringify({
    stats: {
      models: {
        'gemini-2.5-pro': { tokens: { prompt: 2100, cached: 900, candidates: 410 } },
      },
      turns: 3,
      tools: { totalCalls: 5 },
      totalCostUsd: 0.019,
    },
  });
  assert.deepEqual(parseAdapterUsage(adapters.gemini, geminiOut), {
    usage: { input: 2100, cacheWrite: 0, cacheRead: 900, output: 410, turns: 3, toolCalls: 5 },
    costUsd: 0.019,
  });

  const opencodeOut = [
    JSON.stringify({
      type: 'step_finish',
      part: { tokens: { input: 600, output: 120, cache: { read: 300, write: 50 } }, cost: 0.008 },
    }),
    JSON.stringify({ type: 'tool_use' }),
  ].join('\n');
  assert.deepEqual(parseAdapterUsage(adapters.opencode, opencodeOut), {
    usage: { input: 600, cacheWrite: 50, cacheRead: 300, output: 120, turns: 1, toolCalls: 1 },
    costUsd: 0.008,
  });

  const cursorOut = JSON.stringify({
    usage: { input: 1500, cacheWrite: 200, cacheRead: 1000, output: 250 },
    turns: 2,
    toolCalls: 3,
    costUsd: 0.021,
  });
  assert.deepEqual(parseAdapterUsage(adapters.cursor, cursorOut), {
    usage: { input: 1500, cacheWrite: 200, cacheRead: 1000, output: 250, turns: 2, toolCalls: 3 },
    costUsd: 0.021,
  });

  const aiderAnalytics = [
    JSON.stringify({ event: 'message_send', properties: { prompt_tokens: 1100, completion_tokens: 220, cost: 0.012 } }),
    JSON.stringify({ event: 'message_send', properties: { prompt_tokens: 900, completion_tokens: 180, cost: 0.009 } }),
  ].join('\n');
  assert.deepEqual(parseAdapterUsage(adapters.aider, '', aiderAnalytics), {
    usage: { input: 2000, cacheWrite: 0, cacheRead: 0, output: 400, turns: 2, toolCalls: 0 },
    costUsd: 0.021,
  });
});
