import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DEFAULT_MINE_TARGET,
  detectTestRunner,
  isTestPath,
  listCandidates,
  mineTasks,
  parseGoTestJson,
  parseJunitXml,
  parseTapOutput,
  parseVitestJson,
  patchStats,
  resolveVaultDir,
} from '../src/bench/mine.mjs';
import { extractPatchFiles, gradeWorkspace } from '../src/bench/grade.mjs';
import {
  BUILTIN_ARMS,
  loadAdapters,
  materialiseArm,
  parseAdapterUsage,
  parseArmSpec,
  prepareIsolatedWorkspace,
  regradeRun,
  runBench,
} from '../src/bench/run.mjs';
import {
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  MIN_PAIRD_TASKS,
  NON_INFERIORITY_MARGIN,
  bootstrapArmCi,
  buildBenchReport,
  compareArms,
  computeRunCost,
  computeRunQuality,
  evaluateRunRecord,
  formatReportMarkdown,
  holmAdjust,
  isRunResolved,
  loadPrices,
  loadRunRecords,
  mcnemarTest,
  signTest,
  wilcoxonSignedRank,
} from '../src/bench/report.mjs';
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
} from '../src/bench/ablate.mjs';
import {
  PROBES,
  appendLedgerEntry,
  extractTranscriptCommands,
  formatProbesMarkdown,
  gradeProbe,
  loadProbeRecords,
  prepareProbeWorkspace,
  readLedgerEntries,
  runBenchProbes,
} from '../src/bench/probes.mjs';
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

test('isTestPath classifies test paths across node, vitest, pytest, go, gradle and maven', () => {
  assert.equal(isTestPath('test/resolve.test.mjs'), true);
  assert.equal(isTestPath('tests/unit/api.spec.ts'), true);
  assert.equal(isTestPath('spec/models/user_spec.rb'), true);
  assert.equal(isTestPath('src/components/__tests__/Button.tsx'), true);
  assert.equal(isTestPath('src/math.test.ts'), true);
  assert.equal(isTestPath('pkg/auth/token_test.go'), true);
  assert.equal(isTestPath('src/test_parser.py'), true);
  assert.equal(isTestPath('src/test/kotlin/com/example/ApiTest.kt'), true);
  assert.equal(isTestPath('src/test/java/com/example/ApiTests.java'), true);

  assert.equal(isTestPath('src/resolve/resolve.mjs'), false);
  assert.equal(isTestPath('pkg/auth/token.go'), false);
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
  assert.equal(task.schemaVersion, 1);
  assert.match(task.id, /^t-[0-9a-f]{7}-01$/);
  assert.equal(task.prompt, 'feat(calc): add multiply helper\n\nAdds multiply(a, b) and unit test.');
  assert.equal(task.testCmd, 'node --test test/calc.test.mjs');
  assert.deepEqual(task.f2p, ['calc: multiply multiplies two integers']);
  assert.deepEqual(task.p2p, ['calc: add sums two integers']);
  assert.deepEqual(task.gold, { files: 1, linesAdded: 2, linesRemoved: 2 });
  assert.equal(task.vault, `vault/${task.id}`);

  const taskFile = join(repo, '.simt', 'bench', 'tasks', `${task.id}.json`);
  const bytesFirst = await readFile(taskFile, 'utf8');

  // Vault holds both patches outside the worktree.
  const vaultDir = join(resolveVaultDir(repo, { env }), task.id);
  assert.equal(existsSync(join(vaultDir, 'test.patch')), true);
  assert.equal(existsSync(join(vaultDir, 'gold.patch')), true);

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
    assert.equal(task.schemaVersion, 1, `${file}: missing schemaVersion 1`);
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

test('CLI `simt bench mine` previews without --yes and supports --json', async () => {
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
  assert.ok(payload.candidates >= 20);
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

test('prepareIsolatedWorkspace creates a one-commit git export and materialiseArm handles bare, current, kernel, brief and custom arms', async () => {
  assert.deepEqual([...BUILTIN_ARMS].sort(), ['bare', 'brief', 'current', 'kernel']);

  const repo = await scratch('simt-arm-repo-');
  await git(['init', '-q', '.'], { cwd: repo });
  await writeFile(join(repo, 'package.json'), '{"name":"arm-test","type":"module"}\n');
  await writeFile(
    join(repo, 'AGENTS.md'),
    [
      '# Hand Header',
      '',
      '<!-- simt:begin -->',
      '<!-- simt:generated -->',
      '## Core',
      '- generated rule',
      '<!-- simt:end -->',
      '',
    ].join('\n'),
  );
  await mkdir(join(repo, '.githooks'), { recursive: true });
  await writeFile(join(repo, '.githooks', 'pre-commit'), '#!/bin/sh\n');
  await writeFile(join(repo, '.mcp.json'), '{"mcpServers":{}}\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-qm', 'base commit'], { cwd: repo });
  const baseSha = (await git(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

  // Add a second commit in `repo` so we can verify `git rev-list --all` in the export does NOT see it.
  await writeFile(join(repo, 'SECRET_FUTURE.txt'), 'future gold patch\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-qm', 'future commit'], { cwd: repo });
  const futureSha = (await git(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

  // 1. Bare arm strips regions, removes .githooks and .mcp.json, and has 1 commit in rev-list --all.
  const bareSpec = await parseArmSpec('bare');
  const bareWs = await prepareIsolatedWorkspace(repo, baseSha, bareSpec, { id: 't-1', prompt: 'test prompt' });
  tempDirs.push(bareWs.slotDir);

  const revList = (await git(['rev-list', '--all'], { cwd: bareWs.workDir })).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(revList.length, 1, 'isolated workspace must have exactly one commit in git rev-list --all');
  assert.equal(revList[0], bareWs.initialHead);

  // Attempting to inspect futureSha in the isolated workspace fails because object stores are not shared.
  await assert.rejects(() => git(['cat-file', '-e', futureSha], { cwd: bareWs.workDir }));

  const strippedAgents = await readFile(join(bareWs.workDir, 'AGENTS.md'), 'utf8');
  assert.equal(strippedAgents.includes('simt:begin'), false);
  assert.match(strippedAgents, /# Hand Header/);
  assert.equal(existsSync(join(bareWs.workDir, '.githooks')), false);
  assert.equal(existsSync(join(bareWs.workDir, '.mcp.json')), false);

  // 2. Kernel arm projects kernel rules and names the ones the region does not carry.
  const kernelSpec = await parseArmSpec('kernel');
  const kernelWs = await prepareIsolatedWorkspace(repo, baseSha, kernelSpec, { id: 't-1', prompt: 'test prompt' });
  tempDirs.push(kernelWs.slotDir);
  const kernelAgents = await readFile(join(kernelWs.workDir, 'AGENTS.md'), 'utf8');
  assert.match(kernelAgents, /## Rules not in this region/);

  // 3. Brief arm writes .simt/brief.md.
  const briefSpec = await parseArmSpec('brief');
  const briefWs = await prepareIsolatedWorkspace(repo, baseSha, briefSpec, {
    id: 't-1',
    prompt: 'validate slice commit and run focused tests',
  });
  tempDirs.push(briefWs.slotDir);
  assert.equal(existsSync(join(briefWs.workDir, '.simt', 'local', 'brief.md')), true);

  // 4. Custom arm file (--arm name=path/to/arm.json) writes/removes files and sets env.
  const armFile = join(repo, 'custom-arm.json');
  await writeFile(
    armFile,
    JSON.stringify({
      base: 'bare',
      write: { 'CUSTOM_RULE.md': '# Custom Arm\n' },
      remove: ['AGENTS.md'],
      env: { BENCH_CUSTOM_FLAG: 'enabled' },
    }),
  );
  const customSpec = await parseArmSpec(`my-arm=${armFile}`, repo);
  assert.equal(customSpec.name, 'my-arm');
  const customWs = await prepareIsolatedWorkspace(repo, baseSha, customSpec, { id: 't-1', prompt: 'p' });
  tempDirs.push(customWs.slotDir);
  assert.equal(existsSync(join(customWs.workDir, 'AGENTS.md')), false);
  assert.equal(await readFile(join(customWs.workDir, 'CUSTOM_RULE.md'), 'utf8'), '# Custom Arm\n');
  assert.equal(customWs.env.BENCH_CUSTOM_FLAG, 'enabled');

  // Direct materialiseArm call for coverage of in-place materialisation.
  const directDir = await scratch('simt-direct-arm-');
  await materialiseArm(directDir, customSpec, { id: 't-direct', prompt: 'p' });
  assert.equal(await readFile(join(directDir, 'CUSTOM_RULE.md'), 'utf8'), '# Custom Arm\n');
});

test('bench run: gold adapter resolves 100%, noop resolves 0%, and re-grading reproduces the stored grade exactly', async () => {
  const repo = await scratch('simt-run-repo-');
  const vaultEnv = await scratch('simt-run-vault-');
  const env = { ...process.env, SIMT_DEV_VAULT_DIR: vaultEnv };

  await git(['init', '-q', '.'], { cwd: repo });
  await writeFile(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'run-fixture', type: 'module' }, null, 2)}\n`,
  );
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'test'), { recursive: true });
  await writeFile(
    join(repo, 'src', 'math.mjs'),
    [
      'export function square(x) {',
      '  return x * x;',
      '}',
      '',
      'export function cube(_x) {',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(repo, 'test', 'math.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { square } from '../src/math.mjs';",
      '',
      "test('math: square', () => {",
      '  assert.equal(square(3), 9);',
      '});',
      '',
    ].join('\n'),
  );
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-qm', 'chore: base math'], { cwd: repo });

  await writeFile(
    join(repo, 'src', 'math.mjs'),
    [
      'export function square(x) {',
      '  return x * x;',
      '}',
      '',
      'export function cube(x) {',
      '  return x * x * x;',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(repo, 'test', 'math.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { square, cube } from '../src/math.mjs';",
      '',
      "test('math: square', () => {",
      '  assert.equal(square(3), 9);',
      '});',
      '',
      "test('math: cube', () => {",
      '  assert.equal(cube(3), 27);',
      '});',
      '',
    ].join('\n'),
  );
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-qm', 'feat(math): implement cube'], { cwd: repo });

  const mined = await mineTasks(repo, { apply: true, env });
  assert.equal(mined.ok, true);
  assert.equal(mined.tasks.length, 1);
  const vaultRoot = mined.vaultRoot;
  const [task] = mined.tasks;

  assert.deepEqual(extractPatchFiles('diff --git a/src/math.mjs b/src/math.mjs\n'), ['src/math.mjs']);

  // 1. Gold adapter resolves 100% (resolved: true, gatesPassed: true, outsideBlastRadius: 0).
  const goldResult = await runBench(repo, {
    apply: true,
    arms: ['bare', 'current'],
    harness: 'gold',
    reps: 1,
    vaultRoot,
  });
  assert.equal(goldResult.applied, true);
  assert.equal(goldResult.runs.length, 2);
  for (const run of goldResult.runs) {
    assert.equal(run.schemaVersion, 1);
    assert.equal(run.task, task.id);
    assert.equal(run.resolved, true, `gold adapter must resolve 100% (arm=${run.arm})`);
    assert.equal(run.gatesPassed, true);
    assert.deepEqual(run.diff, { files: 1, outsideBlastRadius: 0 });
    assert.equal(run.probe, null);
  }

  // 2. Noop adapter resolves 0% (resolved: false, gatesPassed: false, files: 0).
  const noopResult = await runBench(repo, {
    apply: true,
    arms: ['current'],
    harness: 'noop',
    reps: 1,
    vaultRoot,
  });
  assert.equal(noopResult.applied, true);
  assert.equal(noopResult.runs.length, 1);
  assert.equal(noopResult.runs[0].resolved, false, 'noop adapter must resolve 0%');
  assert.equal(noopResult.runs[0].gatesPassed, false);
  assert.deepEqual(noopResult.runs[0].diff, { files: 0, outsideBlastRadius: 0 });

  // 3. Re-grading stored gold and noop runs reproduces their grades identically.
  const regradedAll = await regradeRun(repo, 'all', { apply: true, vaultRoot });
  assert.equal(regradedAll.regraded, 3);
  assert.equal(regradedAll.reproducedCount, 3);
  assert.equal(regradedAll.allReproduced, true);

  // 4. Direct gradeWorkspace check: an agent that edits an unrelated file and tampers with
  //    the test file has its test file reset to initialHead and outsideBlastRadius = 1.
  const ws = await prepareIsolatedWorkspace(repo, task.base, await parseArmSpec('bare'), task);
  tempDirs.push(ws.slotDir);
  await writeFile(join(ws.workDir, 'UNRELATED.txt'), 'extra file outside blast radius\n');
  await writeFile(join(ws.workDir, 'test', 'math.test.mjs'), '// agent tried to erase tests\n');
  const tamperedGrade = await gradeWorkspace(ws.workDir, task, {
    vaultRoot,
    initialHead: ws.initialHead,
  });
  assert.equal(tamperedGrade.resolved, false);
  assert.deepEqual(tamperedGrade.diff, { files: 2, outsideBlastRadius: 2 });

  // 5. CLI `simt bench run` preview on simt-dev's mined tasks, plus execute (--yes) and --regrade on `repo`.
  const simtTasks = (await readdir(join(ROOT, '.simt', 'bench', 'tasks')))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const sampleTaskId = simtTasks[0].replace(/\.json$/, '');

  const cliPreview = await runCli([
    'bench',
    'run',
    '--root',
    ROOT,
    '--task',
    sampleTaskId,
    '--harness',
    'gold',
    '--reps',
    '1',
    '--json',
  ]);
  assert.equal(cliPreview.code, 0);
  const previewPayload = JSON.parse(cliPreview.stdout);
  assert.equal(previewPayload.ok, true);
  assert.equal(previewPayload.applied, false);
  assert.equal(previewPayload.runs.length, 1);

  const cliGold = await runCli(
    [
      'bench',
      'run',
      '--root',
      repo,
      '--task',
      task.id,
      '--harness',
      'gold',
      '--arm',
      'current',
      '--reps',
      '1',
      '--yes',
      '--json',
    ],
    { SIMT_DEV_VAULT_DIR: vaultEnv },
  );
  assert.equal(cliGold.code, 0, cliGold.stderr);
  const goldPayload = JSON.parse(cliGold.stdout);
  assert.equal(goldPayload.ok, true);
  assert.equal(goldPayload.applied, true);
  assert.equal(goldPayload.runs[0].resolved, true);

  const cliRegrade = await runCli(
    [
      'bench',
      'run',
      '--root',
      repo,
      '--regrade',
      'gold-current-r1',
      '--json',
    ],
    { SIMT_DEV_VAULT_DIR: vaultEnv },
  );
  assert.equal(cliRegrade.code, 0, cliRegrade.stderr);
  const regradePayload = JSON.parse(cliRegrade.stdout);
  assert.equal(regradePayload.allReproduced, true);
});

test('bench report (R03): cost model, quality Q, CPI, cache-hit ratio, McNemar, Wilcoxon and bootstrap CIs match hand computations', async () => {
  assert.equal(DEFAULT_BOOTSTRAP_SAMPLES, 1000);
  assert.equal(DEFAULT_BOOTSTRAP_SEED, 0x51772026);

  // 1. Hand computation of token cost from prices.json ({in, cache_write, cache_read, out} per 1M tokens).
  const prices = { in: 3.0, cache_write: 3.75, cache_read: 0.3, out: 15.0 };
  const sampleRun = {
    task: 't-1',
    arm: 'kernel',
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    rep: 1,
    resolved: true,
    gatesPassed: true,
    usage: {
      input: 100_000,      // 0.1M * 3.00 = 0.30
      cacheWrite: 40_000,  // 0.04M * 3.75 = 0.15
      cacheRead: 300_000,  // 0.3M * 0.30 = 0.09
      output: 10_000,      // 0.01M * 15.00 = 0.15
      turns: 4,
      toolCalls: 7,
    },
    costUsd: 9.99, // ignored when prices table is supplied
    diff: { files: 2, outsideBlastRadius: 0 },
    probe: null,
  };
  // Expected C = 0.30 + 0.15 + 0.09 + 0.15 = 0.69, source 'priced' (token table wins).
  const cost = computeRunCost(sampleRun, prices);
  assert.ok(Math.abs(cost.usd - 0.69) < 1e-12, `expected 0.69, got ${cost.usd}`);
  assert.equal(cost.source, 'priced');
  // Without prices.json, falls back to run.costUsd as a reported cost.
  assert.deepEqual(computeRunCost(sampleRun, null), { usd: 9.99, source: 'reported' });
  // No prices table and no reported cost: the cost is missing, not zero (Q46).
  assert.deepEqual(computeRunCost({ usage: { input: 1000, output: 500 }, costUsd: null }, null), {
    usd: null,
    source: 'missing',
  });

  // 2. Hand computation of R, Q and cacheHitRatio.
  assert.equal(isRunResolved(sampleRun), true);
  assert.equal(isRunResolved({ resolved: true, gatesPassed: false }), false);
  assert.equal(computeRunQuality(sampleRun), 1.0);

  // Partial quality: resolved=true (0.5), gatesPassed=false (0), probe=false (0), diff: 1 of 4 outside (0.1 * 0.75 = 0.075) -> 0.575.
  const partialQ = computeRunQuality({
    resolved: true,
    gatesPassed: false,
    probe: false,
    diff: { files: 4, outsideBlastRadius: 1 },
  });
  assert.ok(Math.abs(partialQ - 0.575) < 1e-12, `expected 0.575, got ${partialQ}`);

  const ev = evaluateRunRecord(sampleRun, prices);
  assert.equal(ev.R, 1);
  assert.equal(ev.Q, 1.0);
  assert.ok(Math.abs(ev.C - 0.69) < 1e-12);
  assert.equal(ev.costSource, 'priced');
  // cache_read / (input + cache_read) = 300_000 / (100_000 + 300_000) = 0.75
  assert.equal(ev.cacheHitRatio, 0.75);

  // 3. Hand computation of McNemar's test on 8 paired tasks:
  //    n11 = 2, n10 (b) = 0, n01 (c) = 6, n00 = 0.
  //    chi2 = (0 - 6)^2 / 6 = 6.0; exact two-sided binomial p = 2 * (0.5)^6 = 2/64 = 0.03125.
  const mcnemar = mcnemarTest([
    [1, 1],
    [1, 1],
    [0, 1],
    [0, 1],
    [0, 1],
    [0, 1],
    [0, 1],
    [0, 1],
  ]);
  assert.equal(mcnemar.n11, 2);
  assert.equal(mcnemar.b, 0);
  assert.equal(mcnemar.c, 6);
  assert.equal(mcnemar.n00, 0);
  assert.equal(mcnemar.statistic, 6.0);
  assert.equal(mcnemar.pValue, 0.03125);

  // 3b. Hand computation of the exact two-sided sign test on task-mean pairs.
  // 4 plus, 0 minus, 2 zero -> p = 2 * (0.5)^4 = 0.125; statistic = min(plus, minus) = 0.
  const sign = signTest([
    [0.0, 1.0],
    [0.0, 1.0],
    [0.0, 1.0],
    [0.5, 1.0],
    [1.0, 1.0],
    [0.0, 0.0],
  ]);
  assert.equal(sign.n, 6);
  assert.equal(sign.plus, 4);
  assert.equal(sign.minus, 0);
  assert.equal(sign.zero, 2);
  assert.equal(sign.statistic, 0);
  assert.ok(Math.abs(sign.pValue - 0.125) < 1e-12, `expected 0.125, got ${sign.pValue}`);
  // Mixed signs: 3 plus, 1 minus -> cdf = (1 + 4) / 16, p = 2 * 5/16 = 0.625.
  const signMixed = signTest([
    [0.0, 1.0],
    [0.0, 1.0],
    [0.5, 1.0],
    [0.5, 0.0],
  ]);
  assert.equal(signMixed.plus, 3);
  assert.equal(signMixed.minus, 1);
  assert.ok(Math.abs(signMixed.pValue - 0.625) < 1e-12, `expected 0.625, got ${signMixed.pValue}`);
  // All pairs equal: no evidence, p = 1.
  assert.equal(signTest([[1, 1], [1, 1]]).pValue, 1);
  // One paired task: the smallest attainable p is 0.5, never significant (Q46: a
  // single task with ten reps must not produce ten "independent" pairs).
  assert.equal(MIN_PAIRD_TASKS, 5);
  assert.equal(NON_INFERIORITY_MARGIN, -0.02);

  // 3c. Hand computation of the Holm step-down adjustment.
  // Family {0.01, 0.04, 0.03}: sorted 0.01, 0.03, 0.04.
  //   j=0: 3 * 0.01 = 0.03
  //   j=1: 2 * 0.03 = 0.06 -> running max 0.06
  //   j=2: 1 * 0.04 = 0.04 -> running max stays 0.06
  // Original order {0.01, 0.04, 0.03} -> {0.03, 0.06, 0.06}.
  const adjusted = holmAdjust([0.01, 0.04, 0.03]);
  assert.ok(Math.abs(adjusted[0] - 0.03) < 1e-12);
  assert.ok(Math.abs(adjusted[1] - 0.06) < 1e-12);
  assert.ok(Math.abs(adjusted[2] - 0.06) < 1e-12);
  // Clamped to 1 and monotone: {0.5, 0.5} -> {1, 1}.
  assert.deepEqual(holmAdjust([0.5, 0.5]), [1, 1]);
  assert.deepEqual(holmAdjust([]), []);

  // 4. Hand computation of Wilcoxon signed-rank test:
  //    Case A: 6 pairs where candidate is strictly cheaper on every task.
  //    Ranks 1..6 all negative -> wPlus = 0, wMinus = 21, statistic = 0, exact p = 2 / 64 = 0.03125.
  const wilcoxonAllNeg = wilcoxonSignedRank([
    [1.0, 0.9],
    [1.0, 0.8],
    [1.0, 0.7],
    [1.0, 0.6],
    [1.0, 0.5],
    [1.0, 0.4],
  ]);
  assert.equal(wilcoxonAllNeg.nonZero, 6);
  assert.equal(wilcoxonAllNeg.wPlus, 0);
  assert.equal(wilcoxonAllNeg.wMinus, 21);
  assert.equal(wilcoxonAllNeg.statistic, 0);
  assert.equal(wilcoxonAllNeg.pValue, 0.03125);

  //    Case B: 5 non-zero pairs with a tie: diffs = [-0.1, -0.1, +0.2, -0.3, -0.4].
  //    Ranks: 1.5, 1.5, 3, 4, 5 -> wPlus = 3, wMinus = 12, statistic = 3.
  //    Subsets of {1.5, 1.5, 3, 4, 5} with sum <= 3: {}, {1.5}, {1.5}, {1.5, 1.5}, {3} -> 5 of 32.
  //    Two-sided exact p = 2 * 5 / 32 = 0.3125.
  const wilcoxonTies = wilcoxonSignedRank([
    [1.0, 0.9],
    [1.0, 0.9],
    [1.0, 1.2],
    [1.0, 0.7],
    [1.0, 0.6],
  ]);
  assert.equal(wilcoxonTies.nonZero, 5);
  assert.equal(wilcoxonTies.wPlus, 3);
  assert.equal(wilcoxonTies.wMinus, 12);
  assert.equal(wilcoxonTies.statistic, 3);
  assert.equal(wilcoxonTies.pValue, 0.3125);

  // 5. End-to-end synthetic repository with .simt/bench/prices.json and 6 paired tasks across bare & kernel.
  const repo = await scratch('simt-report-repo-');
  const benchDir = join(repo, '.simt', 'bench');
  const bareDir = join(benchDir, 'runs', 'claude-bare-r1');
  const kernelDir = join(benchDir, 'runs', 'claude-kernel-r1');
  await mkdir(bareDir, { recursive: true });
  await mkdir(kernelDir, { recursive: true });

  await writeFile(
    join(benchDir, 'prices.json'),
    JSON.stringify({ in: 2.0, cache_write: 2.5, cache_read: 0.2, out: 10.0 }, null, 2),
  );
  const loadedPrices = await loadPrices(repo);
  assert.equal(loadedPrices.kind, 'flat');

  // 6 tasks:
  // - bare resolves 2 of 6 (t-1, t-2); kernel resolves all 6 (t-1..t-6).
  // - bare per-task usage: input=100_000 ($0.20), cacheWrite=0, cacheRead=100_000 ($0.02), output=(10_000 + i*1_000).
  // - kernel per-task usage: input=50_000 ($0.10), cacheWrite=0, cacheRead=150_000 ($0.03), output=(5_000 + i*500).
  for (let i = 1; i <= 6; i += 1) {
    const taskId = `t-000000${i}-01`;
    const bareResolved = i <= 2;
    await writeFile(
      join(bareDir, `${taskId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        task: taskId,
        arm: 'bare',
        harness: 'claude',
        model: 'sonnet',
        rep: 1,
        resolved: bareResolved,
        gatesPassed: true,
        usage: {
          input: 100_000,
          cacheWrite: 0,
          cacheRead: 100_000,
          output: 10_000 * i,
          turns: 6,
          toolCalls: 10,
        },
        costUsd: 0,
        diff: { files: 1, outsideBlastRadius: 0 },
        probe: null,
      }),
    );

    await writeFile(
      join(kernelDir, `${taskId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        task: taskId,
        arm: 'kernel',
        harness: 'claude',
        model: 'sonnet',
        rep: 1,
        resolved: true,
        gatesPassed: true,
        usage: {
          input: 50_000,
          cacheWrite: 0,
          cacheRead: 150_000,
          output: 5_000 * i,
          turns: 4,
          toolCalls: 6,
        },
        costUsd: 0,
        diff: { files: 1, outsideBlastRadius: 0 },
        probe: null,
      }),
    );
  }

  const rawRecords = await loadRunRecords(repo);
  assert.equal(rawRecords.length, 12);

  const report = await buildBenchReport(repo, { compare: ['bare', 'kernel'] });
  assert.equal(report.pricesLoaded, true);
  assert.equal(report.runCount, 12);
  assert.equal(report.arms.length, 2);

  const bareArm = report.arms.find((a) => a.arm === 'bare');
  const kernelArm = report.arms.find((a) => a.arm === 'kernel');

  // Hand-computed bare arm:
  // R = 2/6 = 1/3
  // Q: 2 tasks have Q=1.0, 4 tasks have Q=0.5 (gates=0.2 + probe=0.2 + hygiene=0.1) -> mean Q = (2*1.0 + 4*0.5)/6 = 4/6 = 2/3
  // C: input($0.20) + cacheRead($0.02) + mean output(35_000 * $10 / 1e6 = $0.35) = $0.57
  // CPI: total cost / resolved outcomes = 6 * 0.57 / 2 = 1.71 (plan 0004 §1)
  // cacheHitRatio: 600_000 / (600_000 + 600_000) = 0.5
  assert.ok(Math.abs(bareArm.R - 1 / 3) < 1e-12);
  assert.ok(Math.abs(bareArm.Q - 2 / 3) < 1e-12);
  assert.ok(Math.abs(bareArm.C - 0.57) < 1e-12);
  assert.ok(Math.abs(bareArm.CPI - 1.71) < 1e-12);
  assert.equal(bareArm.turns, 6);
  assert.equal(bareArm.toolCalls, 10);
  assert.equal(bareArm.cacheHitRatio, 0.5);

  // Hand-computed kernel arm:
  // R = 6/6 = 1.0
  // Q = 1.0
  // C: input($0.10) + cacheRead($0.03) + mean output(17_500 * $10 / 1e6 = $0.175) = $0.305
  // CPI: 6 * 0.305 / 6 = 0.305
  // cacheHitRatio: 900_000 / (300_000 + 900_000) = 0.75
  assert.equal(kernelArm.R, 1.0);
  assert.equal(kernelArm.Q, 1.0);
  assert.ok(Math.abs(kernelArm.C - 0.305) < 1e-12);
  assert.ok(Math.abs(kernelArm.CPI - 0.305) < 1e-12);
  assert.equal(kernelArm.turns, 4);
  assert.equal(kernelArm.toolCalls, 6);
  assert.equal(kernelArm.cacheHitRatio, 0.75);

  // Hand-computed comparison (kernel - bare):
  // dR = +2/3, dQ = +1/3, dC = -0.265, dCPI = 0.305 - 1.71 = -1.405, dTurns = -2, dToolCalls = -4, dCache = +0.25
  // Sign test on task-mean R: plus=4, minus=0, zero=2 -> statistic 0, p = 2 * (0.5)^4 = 0.125
  // (task-level pairing: six tasks, not six "runs")
  // Wilcoxon: all 6 tasks have kernel cheaper -> wPlus = 0, wMinus = 21, statistic = 0, pValue = 0.03125
  const cmp = report.comparison;
  assert.ok(cmp);
  assert.equal(cmp.pairedTasks, 6);
  assert.equal(cmp.pairedRuns, 6);
  assert.ok(Math.abs(cmp.deltas.R - 2 / 3) < 1e-12);
  assert.ok(Math.abs(cmp.deltas.Q - 1 / 3) < 1e-12);
  assert.ok(Math.abs(cmp.deltas.C - -0.265) < 1e-12);
  assert.ok(Math.abs(cmp.deltas.CPI - -1.405) < 1e-12);
  assert.equal(cmp.deltas.turns, -2);
  assert.equal(cmp.deltas.toolCalls, -4);
  assert.equal(cmp.deltas.cacheHitRatio, 0.25);
  assert.equal(cmp.rTest.plus, 4);
  assert.equal(cmp.rTest.minus, 0);
  assert.equal(cmp.rTest.statistic, 0);
  assert.ok(Math.abs(cmp.rTest.pValue - 0.125) < 1e-12);
  assert.equal(cmp.wilcoxon.statistic, 0);
  assert.equal(cmp.wilcoxon.pValue, 0.03125);
  // Non-inferiority: ΔR = +2/3 with a lower bound well above -2pp on 6 paired tasks.
  assert.equal(cmp.nonInferiority.margin, -0.02);
  assert.equal(cmp.nonInferiority.met, true);
  assert.equal(cmp.verdict, 'non-inferior');

  // Direct bootstrapArmCi and compareArms determinism check.
  const ciDirect = bootstrapArmCi([{ R: 1, Q: 1, C: 0.5, turns: 3, toolCalls: 4, input: 100, cacheRead: 300, cacheHitRatio: 0.75 }]);
  assert.deepEqual(ciDirect.R, [1, 1]);
  const cmpDirect = compareArms(
    'bare',
    rawRecords.filter((r) => r.arm === 'bare').map((r) => evaluateRunRecord(r, loadedPrices)),
    'kernel',
    rawRecords.filter((r) => r.arm === 'kernel').map((r) => evaluateRunRecord(r, loadedPrices)),
  );
  assert.deepEqual(cmpDirect.ci95, cmp.ci95);
  const md = formatReportMarkdown(report);
  assert.match(md, /\| bare \| claude \| sonnet \| 6 \| 6 \| 33\.3% \|/);
  assert.match(md, /\| kernel \| claude \| sonnet \| 6 \| 6 \| 100\.0% \|/);
  assert.match(md, /### Comparison: `kernel` vs `bare`/);
  assert.match(md, /\| Sign \| 0\.0000 \| 0\.1250 \|/);
  assert.match(md, /\| Wilcoxon \| 0\.0000 \| 0\.0313 \|/);
  assert.match(md, /Non-inferiority \(ΔR lower bound > -2\.0%\): /);
  assert.match(md, /— met/);
  assert.match(md, /Verdict: non-inferior \(6 paired tasks\)/);

  // 6. CLI `simt bench report --compare bare kernel` (two space-separated args and --json).
  const cliMd = await runCli(['bench', 'report', '--root', repo, '--compare', 'bare', 'kernel']);
  assert.equal(cliMd.code, 0, cliMd.stderr);
  assert.match(cliMd.stdout, /### Comparison: `kernel` vs `bare`/);

  const cliJson = await runCli([
    'bench',
    'report',
    '--root',
    repo,
    '--compare',
    'bare',
    'kernel',
    '--json',
  ]);
  assert.equal(cliJson.code, 0, cliJson.stderr);
  const jsonPayload = JSON.parse(cliJson.stdout);
  assert.equal(jsonPayload.ok, true);
  assert.equal(jsonPayload.command, 'bench report');
  assert.equal(jsonPayload.comparison.wilcoxon.pValue, 0.03125);
});

test('bench ablate (R04): leave-one-out section removal, 10-task canary with escalation, value-per-KB ranking and deletion candidates', async () => {
  assert.equal(DEFAULT_CANARY_SIZE, 10);
  assert.equal(CANARY_ALPHA, 0.05);
  assert.equal(DEL_R_TOLERANCE, 0.01);
  assert.equal(slugifyHeading('Code and review'), 'code-and-review');

  // 1. Parse core sections and list ablatable sections in a node repository.
  const repo = await scratch('simt-ablate-repo-');
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'ablate-repo', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2),
  );
  await git(['init', '-q', '.'], { cwd: repo });

  const sections = await listAblationSections(repo);
  const sectionIds = sections.map((s) => s.id);
  assert.ok(sectionIds.includes('core:truth'));
  assert.ok(sectionIds.includes('core:git'));
  assert.ok(sectionIds.includes('core:refactoring'));
  assert.ok(sectionIds.includes('core:validation'));
  assert.ok(sectionIds.includes('core:code-and-review'));
  assert.ok(sectionIds.includes('core:scope-of-these-rules'));
  assert.ok(sectionIds.includes('profile:node'));
  assert.ok(sectionIds.includes('process:intake-questions'));
  assert.ok(sectionIds.includes('process:slice-commit'));
  assert.ok(sectionIds.includes('process:test-gate'));
  for (const s of sections) {
    assert.ok(s.bytes > 0 && s.kb > 0, `section ${s.id} must have positive size`);
  }

  const coreParsed = parseCoreSections('Intro\n\n## Truth\n\n- A\n\n## Git\n\n- B\n');
  assert.equal(coreParsed.length, 2);
  assert.equal(
    removeCoreSectionFromBody('## Core\n\nIntro\n\n### Truth\n\n- A\n\n### Git\n\n- B\n', 'truth'),
    '## Core\n\nIntro\n\n### Git\n\n- B',
  );
  assert.equal(
    removeTopSectionFromBody('## Core\n\n- A\n\n## Stack: node\n\n- B\n\n## Process: slice-commit\n\n- C\n', 'Stack', 'node'),
    '## Core\n\n- A\n\n## Process: slice-commit\n\n- C',
  );

  // 2. Verify parseAblationArmName, parseArmSpec and materialiseArm remove the targeted section cleanly.
  assert.deepEqual(parseAblationArmName('no-core-git'), {
    name: 'no-core-git',
    kind: 'ablate',
    base: 'current',
    ablate: { kind: 'core', targetId: 'git', sectionId: 'core:git' },
  });
  assert.deepEqual(parseAblationArmName('no-profile-node'), {
    name: 'no-profile-node',
    kind: 'ablate',
    base: 'current',
    ablate: { kind: 'profile', targetId: 'node', sectionId: 'profile:node' },
  });
  assert.deepEqual(parseAblationArmName('no-process-slice-commit'), {
    name: 'no-process-slice-commit',
    kind: 'ablate',
    base: 'current',
    ablate: { kind: 'process', targetId: 'slice-commit', sectionId: 'process:slice-commit' },
  });
  assert.equal(parseAblationArmName('current'), null);

  const workCore = await scratch('simt-ablate-work-core-');
  await writeFile(join(workCore, 'package.json'), JSON.stringify({ name: 'w', version: '1.0.0' }));
  await materialiseArm(workCore, await parseArmSpec('no-core-git'));
  const agentsNoGit = await readFile(join(workCore, 'AGENTS.md'), 'utf8');
  assert.ok(!agentsNoGit.includes('### Git'), 'no-core-git must remove ### Git from AGENTS.md');
  assert.ok(agentsNoGit.includes('### Truth'), 'no-core-git must preserve other core sections');

  const workProfile = await scratch('simt-ablate-work-profile-');
  await writeFile(join(workProfile, 'package.json'), JSON.stringify({ name: 'w', version: '1.0.0' }));
  await ablateSectionInWorkspace(workProfile, { kind: 'profile', targetId: 'node', sectionId: 'profile:node' });
  const agentsNoNode = await readFile(join(workProfile, 'AGENTS.md'), 'utf8');
  assert.ok(!agentsNoNode.includes('## Stack: node'), 'no-profile-node must remove ## Stack: node from AGENTS.md');
  assert.equal(existsSync(join(workProfile, '.cursor', 'rules', 'simt-stack-node.mdc')), false);

  const workProcess = await scratch('simt-ablate-work-proc-');
  await writeFile(join(workProcess, 'package.json'), JSON.stringify({ name: 'w', version: '1.0.0' }));
  await ablateSectionInWorkspace(workProcess, {
    kind: 'process',
    targetId: 'slice-commit',
    sectionId: 'process:slice-commit',
  });
  const agentsNoSlice = await readFile(join(workProcess, 'AGENTS.md'), 'utf8');
  assert.ok(!agentsNoSlice.includes('## Process: slice-commit'), 'no-process-slice-commit must remove section from AGENTS.md');
  assert.equal(existsSync(join(workProcess, '.cursor', 'rules', 'slice-commit.mdc')), false);

  // 3. Canary escalation and deletion-candidate rules.
  assert.equal(isDeletionCandidate({ measured: true, dR: 0, dC: 0.05 }), true);
  assert.equal(isDeletionCandidate({ measured: true, dR: -0.05, dC: 0.02 }), true);
  assert.equal(isDeletionCandidate({ measured: true, dR: 0.2, dC: 0.05 }), false);
  assert.equal(isDeletionCandidate({ measured: false, dR: 0, dC: 0.05 }), false);

  // 4. Synthetic 12-task ablation suite (10 canary + 2 remaining tasks):
  //    - `core:truth` has a large positive ΔR on the 10 canary tasks (current resolves 10/10,
  //      no-core-truth resolves 2/10 -> McNemar b=0, c=8, p = 2/256 = 0.0078125 < 0.10),
  //      so it escalates to all 12 tasks and ranks #1 in value-per-KB.
  //    - `core:scope-of-these-rules` has ΔR = 0 (both resolve 10/10 on canary) and ΔC > 0
  //      (keeping the section costs more tokens than removing it), with non-significant canary
  //      delta so it stays at 10 tasks (`escalated: false`) and is flagged in `deletionCandidates`.
  const tasksDir = join(repo, '.simt', 'bench', 'tasks');
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    join(repo, '.simt', 'bench', 'prices.json'),
    JSON.stringify({ in: 3.0, cache_write: 3.75, cache_read: 0.3, out: 15.0 }, null, 2),
  );

  const taskIds = [];
  for (let i = 1; i <= 12; i += 1) {
    const id = `t-${String(i).padStart(7, '0')}-01`;
    taskIds.push(id);
    await writeFile(
      join(tasksDir, `${id}.json`),
      JSON.stringify({
        schemaVersion: 1,
        id,
        repo: 'ablate-repo',
        base: '0'.repeat(40),
        fix: '1'.repeat(40),
        category: 'bugfix',
        prompt: `Task ${i}`,
        testCmd: ['node', '--test'],
        testFiles: ['test/math.test.mjs'],
        failToPass: ['math'],
        passToPass: [],
        blastRadius: { files: 1, lines: 4 },
      }),
    );
  }

  const writeArmRun = async (arm, taskId, { resolved, input, output }) => {
    const dir = join(repo, '.simt', 'bench', 'runs', `claude-${arm}-r1`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${taskId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        task: taskId,
        arm,
        harness: 'claude',
        model: 'sonnet',
        rep: 1,
        resolved,
        gatesPassed: true,
        usage: { input, cacheWrite: 0, cacheRead: 100_000, output, turns: 4, toolCalls: 5 },
        costUsd: 0,
        diff: { files: 1, outsideBlastRadius: 0 },
        probe: null,
      }),
    );
  };

  // Populate stored runs for `current` (all 12 tasks), `no-core-truth` (12 tasks),
  // and `no-core-scope-of-these-rules` (10 canary tasks).
  for (let i = 0; i < 12; i += 1) {
    const id = taskIds[i];
    // `current` resolves all 12 tasks, input = 100_000, output = 10_000.
    await writeArmRun('current', id, { resolved: true, input: 100_000, output: 10_000 });
    // `no-core-truth` resolves only the first 2 tasks (ΔR = +10/12 = +0.8333) and uses more output tokens when failing.
    await writeArmRun('no-core-truth', id, {
      resolved: i < 2,
      input: 100_000,
      output: i < 2 ? 10_000 : 25_000,
    });
  }
  for (let i = 0; i < 10; i += 1) {
    const id = taskIds[i];
    // Removing `core:scope-of-these-rules` still resolves 10/10 (ΔR = 0), and uses slightly
    // fewer input tokens (98_000 vs 100_000) so keeping the section has ΔC > 0 ($+0.006/task),
    // with small noise so Wilcoxon on canary is non-significant (does not escalate).
    await writeArmRun('no-core-scope-of-these-rules', id, {
      resolved: true,
      input: i % 2 === 0 ? 95_000 : 103_000,
      output: 10_000,
    });
  }

  const ablate1 = await ablateBench(repo, {
    apply: false,
    sections: sections.filter((s) => s.id === 'core:truth' || s.id === 'core:scope-of-these-rules'),
  });
  const ablate2 = await ablateBench(repo, {
    apply: false,
    sections: sections.filter((s) => s.id === 'core:truth' || s.id === 'core:scope-of-these-rules'),
  });

  // Reproducibility: running `ablateBench` twice produces identical rankings and CIs.
  assert.deepEqual(ablate1.ranking, ablate2.ranking);
  assert.deepEqual(ablate1.sections, ablate2.sections);
  assert.deepEqual(ablate1.deletionCandidates, ablate2.deletionCandidates);

  const truthEntry = ablate1.sections.find((s) => s.id === 'core:truth');
  const scopeEntry = ablate1.sections.find((s) => s.id === 'core:scope-of-these-rules');
  assert.ok(truthEntry && scopeEntry);

  assert.equal(truthEntry.escalated, true, 'significant canary delta on core:truth must escalate to full suite');
  assert.equal(truthEntry.tasks, 12);
  assert.ok(Math.abs(truthEntry.dR - 10 / 12) < 1e-12);
  assert.ok(truthEntry.valuePerKb > 0);
  assert.equal(Array.isArray(truthEntry.ci95.dR), true);
  assert.equal(truthEntry.ci95.dR.length, 2);
  assert.equal(truthEntry.deletionCandidate, false);

  assert.equal(shouldEscalateCanary({ pairedTasks: 0 }), false);
  assert.equal(scopeEntry.escalated, false, 'non-significant canary delta must stop at 10-task canary');
  assert.equal(scopeEntry.tasks, 10);
  assert.equal(scopeEntry.dR, 0);
  assert.ok(scopeEntry.dC > 0, 'keeping core:scope-of-these-rules costs net positive tokens');
  assert.equal(scopeEntry.deletionCandidate, true);
  assert.deepEqual(ablate1.deletionCandidates, ['core:scope-of-these-rules']);
  assert.equal(ablate1.ranking[0].id, 'core:truth');

  const md = formatAblationMarkdown(ablate1);
  assert.match(md, /\| 1 \| core:truth \|/);
  assert.match(md, /DELETE CANDIDATE/);
  assert.match(md, /core:scope-of-these-rules/);

  // Verify apply: true invokes the canary runner on 10 tasks first and escalates only significant arms to the remaining 2 tasks.
  const runnerCalls = [];
  const appliedAblate = await ablateBench(repo, {
    apply: true,
    harness: 'claude',
    sections: sections.filter((s) => s.id === 'core:truth' || s.id === 'core:scope-of-these-rules'),
    runner: async (_root, opts) => {
      runnerCalls.push({ arms: opts.arms, tasks: opts.tasks });
    },
  });
  assert.equal(appliedAblate.applied, true);
  assert.equal(runnerCalls.length, 2);
  assert.equal(runnerCalls[0].tasks.length, 10);
  assert.deepEqual(runnerCalls[0].arms, ['current', 'no-core-truth', 'no-core-scope-of-these-rules']);
  assert.equal(runnerCalls[1].tasks.length, 2);
  assert.deepEqual(runnerCalls[1].arms, ['current', 'no-core-truth']);
  assert.equal(existsSync(join(repo, '.simt', 'local', 'bench', 'ablation.json')), true);

  // 5. CLI `simt bench ablate` preview and `--json` output.
  const cliJson = await runCli(['bench', 'ablate', '--root', repo, '--json']);
  assert.equal(cliJson.code, 0, cliJson.stderr);
  const payload = JSON.parse(cliJson.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'bench ablate');
  assert.equal(payload.canaryTasks, 10);
  assert.equal(payload.totalTasks, 12);
  assert.ok(payload.deletionCandidates.includes('core:scope-of-these-rules'));
  assert.equal(payload.ranking[0].id, 'core:truth');
});

test('bench probes (R05): 12 synthetic compliance probes each pass on compliance, fail on violation, and report compliance per arm', async () => {
  assert.equal(PROBES.length, 12, 'R05 requires exactly 12 compliance probes');

  // 1. Verify each of the 12 probes has a deterministic grader that passes on comply() and fails on violate().
  for (const probe of PROBES) {
    // Compliant run
    const wsComply = await prepareProbeWorkspace(probe);
    tempDirs.push(wsComply.slotDir);
    const complyOut = await probe.comply(wsComply.workDir, wsComply);
    const complyGrade = await gradeProbe(probe.id, {
      workDir: wsComply.workDir,
      slotDir: wsComply.slotDir,
      initialHead: wsComply.initialHead,
      commands: complyOut.commands,
      stdout: complyOut.stdout,
    });
    assert.equal(
      complyGrade.passed,
      true,
      `probe ${probe.id} must pass on compliant action (${complyGrade.reason})`,
    );

    // Violating run
    const wsViolate = await prepareProbeWorkspace(probe);
    tempDirs.push(wsViolate.slotDir);
    const violateOut = await probe.violate(wsViolate.workDir, wsViolate);
    const violateGrade = await gradeProbe(probe.id, {
      workDir: wsViolate.workDir,
      slotDir: wsViolate.slotDir,
      initialHead: wsViolate.initialHead,
      commands: violateOut.commands,
      stdout: violateOut.stdout,
    });
    assert.equal(
      violateGrade.passed,
      false,
      `probe ${probe.id} must fail on rule violation`,
    );
    assert.ok(violateGrade.reason.length > 0, `probe ${probe.id} must state a failure reason`);
  }

  // 2. Verify ledger helper and transcript command extraction directly.
  const ledgerScratch = await scratch('simt-probe-ledger-');
  await git(['init', '-q', '.'], { cwd: ledgerScratch });
  await writeFile(join(ledgerScratch, 'README.md'), '# test\n');
  await git(['add', 'README.md'], { cwd: ledgerScratch });
  await appendLedgerEntry(ledgerScratch, { cmd: 'node --test test/a.test.mjs', exit: 0 });
  const ledgerEntries = await readLedgerEntries(ledgerScratch);
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0].cmd, 'node --test test/a.test.mjs');
  const cmds = extractTranscriptCommands({
    commands: ['git status'],
    stdout: '$ npm run lint\nall good',
    ledger: ledgerEntries,
  });
  assert.deepEqual(cmds, ['git status', 'node --test test/a.test.mjs', 'npm run lint']);

  // 3. Run probes across two arms (`bare` with `violator` and `current` with `gold`) and verify per-arm compliance.
  const repo = await scratch('simt-probes-repo-');
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'probes-repo', version: '1.0.0' }));
  await git(['init', '-q', '.'], { cwd: repo });

  await runBenchProbes(repo, {
    apply: true,
    arms: ['bare'],
    harness: 'violator',
    reps: 1,
  });
  await runBenchProbes(repo, {
    apply: true,
    arms: ['current'],
    harness: 'gold',
    reps: 1,
  });

  const stored = await loadProbeRecords(repo);
  assert.equal(stored.length, 24);

  const summary = await runBenchProbes(repo, {
    apply: false,
    arms: ['bare', 'current'],
  });
  assert.equal(summary.probeCount, 12);
  assert.equal(summary.arms.length, 2);

  const bareSummary = summary.arms.find((a) => a.arm === 'bare');
  const currentSummary = summary.arms.find((a) => a.arm === 'current');
  assert.equal(bareSummary.total, 12);
  assert.equal(bareSummary.passed, 0);
  assert.equal(bareSummary.complianceRate, 0);
  assert.equal(currentSummary.total, 12);
  assert.equal(currentSummary.passed, 12);
  assert.equal(currentSummary.complianceRate, 1.0);

  const md = formatProbesMarkdown(summary);
  assert.match(md, /\| bare \| 12 \| 0 \| 0\.0% \|/);
  assert.match(md, /\| current \| 12 \| 12 \| 100\.0% \|/);
  assert.match(md, /\| p01-unrelated-failing-test \| Validation \| ADR-006 \|/);

  // 4. CLI `simt bench probes` preview and `--json`.
  const cliJson = await runCli(['bench', 'probes', '--root', repo, '--json']);
  assert.equal(cliJson.code, 0, cliJson.stderr);
  const payload = JSON.parse(cliJson.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'bench probes');
  assert.equal(payload.probeCount, 12);
  assert.equal(payload.arms.length, 2);
});




