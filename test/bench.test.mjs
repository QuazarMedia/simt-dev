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
import { git } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BIN = resolve(ROOT, 'bin', 'simt-dev.mjs');
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
  assert.equal(existsSync(join(repo, '.simt-dev', 'bench', 'tasks')), false);

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

  const taskFile = join(repo, '.simt-dev', 'bench', 'tasks', `${task.id}.json`);
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

test('simt-dev has at least 20 verified tasks in .simt-dev/bench/tasks matching Appendix A schema', async () => {
  const tasksDir = join(ROOT, '.simt-dev', 'bench', 'tasks');
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

  // 2. Kernel arm projects kernel rules with Deferred rules index.
  const kernelSpec = await parseArmSpec('kernel');
  const kernelWs = await prepareIsolatedWorkspace(repo, baseSha, kernelSpec, { id: 't-1', prompt: 'test prompt' });
  tempDirs.push(kernelWs.slotDir);
  const kernelAgents = await readFile(join(kernelWs.workDir, 'AGENTS.md'), 'utf8');
  assert.match(kernelAgents, /## Deferred rules/);

  // 3. Brief arm writes .simt-dev/brief.md.
  const briefSpec = await parseArmSpec('brief');
  const briefWs = await prepareIsolatedWorkspace(repo, baseSha, briefSpec, {
    id: 't-1',
    prompt: 'validate slice commit and run focused tests',
  });
  tempDirs.push(briefWs.slotDir);
  assert.equal(existsSync(join(briefWs.workDir, '.simt-dev', 'brief.md')), true);

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
  const simtTasks = (await readdir(join(ROOT, '.simt-dev', 'bench', 'tasks')))
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

