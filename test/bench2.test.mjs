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

  // 3. Brief arm delivers the assembled packet as prompt context, not a file nothing reads
  //    (review 0003 Q49).
  const briefSpec = await parseArmSpec('brief');
  const briefWs = await prepareIsolatedWorkspace(repo, baseSha, briefSpec, {
    id: 't-1',
    prompt: 'validate slice commit and run focused tests',
  });
  tempDirs.push(briefWs.slotDir);
  assert.match(briefWs.promptPrefix, /validate slice commit and run focused tests/);
  assert.equal(existsSync(join(briefWs.workDir, '.simt', 'local', 'brief.md')), false);

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
    assert.equal(run.schemaVersion, 2);
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

  // A built-in harness scripts the workspace instead of driving an agent, so its
  // records calibrate the grader and never claim a measurement (review 0003 Q49).
  for (const run of [...goldResult.runs, ...noopResult.runs]) {
    assert.equal(run.measured, false);
    assert.equal(run.isolation, 'none');
  }

  // 3. Re-grading stored gold and noop runs reproduces their grades identically.
  const regradedAll = await regradeRun(repo, 'all', { apply: true, vaultRoot });
  assert.equal(regradedAll.regraded, 3);
  assert.equal(regradedAll.reproducedCount, 3);
  assert.equal(regradedAll.allReproduced, true);

  // An agent adapter does claim a measurement, with the isolation it actually provided.
  const fakeAdapters = {
    fake: {
      id: 'fake',
      kind: 'cli',
      bin: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({usage:{input_tokens:1,output_tokens:1},total_cost_usd:0}))'],
      format: 'json',
      isolation: 'env',
      env: [],
      fields: { input: ['usage.input_tokens'], output: ['usage.output_tokens'], costUsd: ['total_cost_usd'] },
    },
  };
  const agentResult = await runBench(repo, {
    apply: true,
    arms: ['current'],
    harness: 'fake',
    reps: 1,
    vaultRoot,
    adapters: fakeAdapters,
  });
  assert.equal(agentResult.runs[0].measured, true);
  assert.equal(agentResult.runs[0].isolation, 'env');

  // A run that cannot start is one error record, not a lost batch (review 0003 Q47).
  const brokenAdapters = {
    broken: {
      id: 'broken',
      kind: 'cli',
      bin: '/nonexistent/agent-for-q47',
      args: [],
      format: 'json',
      isolation: 'env',
      env: [],
      fields: {},
    },
  };
  const broken = await runBench(repo, {
    apply: true,
    arms: ['current'],
    harness: 'broken',
    reps: 1,
    vaultRoot,
    adapters: brokenAdapters,
  });
  assert.equal(broken.runs.length, 1);
  assert.equal(broken.runs[0].status, 'error');
  assert.match(broken.runs[0].error, /agent-for-q47|ENOENT/);

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
