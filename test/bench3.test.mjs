import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DEFAULT_MINE_TARGET, listCandidates, mineTasks, patchStats } from '../src/bench/mine.mjs';
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
import { gradeWorkspace } from '../src/bench/grade.mjs';
import { extractPatchFiles } from '../src/testing/patches.mjs';
import { spawnBounded } from '../src/sys/proc.mjs';
import { BUILTIN_ARMS, materialiseArm, parseArmSpec } from '../src/bench/arms.mjs';
import { adapterIsolation, agentEnv, loadAdapters, parseAdapterUsage } from '../src/bench/adapters.mjs';
import { regradeRun, runBench } from '../src/bench/run.mjs';
import { prepareIsolatedWorkspace } from '../src/bench/workspace.mjs';
import { buildBenchReport } from '../src/bench/report.mjs';
import { formatReportMarkdown } from '../src/bench/render.mjs';
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
} from '../src/bench/ablate.mjs';
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

  // Stored records are summarised per harness: pooling a violator run into a gold
  // summary reported compliance for a measurement never taken (review 0003 Q59).
  const violated = await runBenchProbes(repo, {
    apply: false,
    arms: ['bare'],
    harness: 'violator',
  });
  assert.equal(violated.arms.length, 1);
  const bareSummary = violated.arms.find((a) => a.arm === 'bare');
  assert.equal(bareSummary.total, 12);
  assert.equal(bareSummary.passed, 0);
  assert.equal(bareSummary.complianceRate, 0);

  const goldSummary = await runBenchProbes(repo, {
    apply: false,
    arms: ['bare', 'current'],
    harness: 'gold',
  });
  assert.equal(goldSummary.probeCount, 12);
  assert.equal(goldSummary.arms.length, 1, 'no bare record was produced by the gold harness');
  const currentSummary = goldSummary.arms.find((a) => a.arm === 'current');
  assert.equal(currentSummary.total, 12);
  assert.equal(currentSummary.passed, 12);
  assert.equal(currentSummary.complianceRate, 1.0);

  const md = formatProbesMarkdown(goldSummary);
  assert.match(md, /\| current \| 12 \| 12 \| 100\.0% \| grader calibration \|/);
  assert.equal(bareSummary.measured, false);
  assert.equal(currentSummary.measured, false);
  assert.match(md, /\| p01-unrelated-failing-test \| Validation \| ADR-006 \|/);

  // 4. CLI `simt bench probes` preview and `--json`.
  const cliJson = await runCli(['bench', 'probes', '--root', repo, '--json']);
  assert.equal(cliJson.code, 0, cliJson.stderr);
  const payload = JSON.parse(cliJson.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'bench probes');
  assert.equal(payload.probeCount, 12);
  assert.equal(payload.arms.length, 1);

  // 5. A non-built-in harness runs a real agent in the probe workspace, and its record
  // says so; the scripted harnesses stay calibration (review 0003 Q49).
  const probeAdapters = {
    fake: {
      id: 'fake',
      kind: 'cli',
      bin: process.execPath,
      args: ['-e', 'process.stdout.write("")'],
      format: 'json',
      isolation: 'env',
      env: [],
      fields: {},
    },
  };
  await runBenchProbes(repo, {
    apply: true,
    arms: ['current'],
    harness: 'fake',
    probes: ['p01-unrelated-failing-test'],
    reps: 1,
    adapters: probeAdapters,
  });
  const agentRecord = (await loadProbeRecords(repo)).find((r) => r.harness === 'fake');
  assert.ok(agentRecord, 'the agent-backed probe wrote a record');
  assert.equal(agentRecord.measured, true);
  assert.equal(agentRecord.isolation, 'env');
  assert.equal(CALIBRATION_HARNESSES.has('gold'), true);
  assert.equal(CALIBRATION_HARNESSES.has('claude'), false);

  await assert.rejects(
    () => runBenchProbes(repo, { apply: true, harness: 'nope', adapters: {} }),
    /unknown probe harness/,
  );

  // 6. `--yes` with no `--harness` refuses instead of defaulting to the gold oracle.
  const missingHarness = await runCli(['bench', 'probes', '--root', repo, '--yes']);
  assert.equal(missingHarness.code, 2);
  assert.match(missingHarness.stderr, /explicit --harness/);
});

test('bench process control: a deadline kills the process group and settles in time', async () => {
  const started = Date.now();
  const outcome = await spawnBounded(
    process.execPath,
    [
      '-e',
      "const { spawn } = require('node:child_process'); spawn('sleep', ['30'], { stdio: 'ignore' }); setInterval(() => {}, 1000);",
    ],
    { timeoutMs: 300 },
  );
  const elapsed = Date.now() - started;
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.code, 124);
  assert.ok(elapsed < 5000, `the deadline settled in ${elapsed} ms, not the grandchild's 30 s`);
  assert.ok(outcome.wallMs < 5000);
  assert.equal(outcome.spawnError, null);

  const missing = await spawnBounded('/nonexistent/agent-for-q47', [], { timeoutMs: 1000 });
  assert.equal(missing.code, 1);
  assert.ok(missing.spawnError);
});

test('bench isolation: an agent inherits the baseline and its adapter keys, never the vault or the operator HOME', () => {
  const base = {
    PATH: '/usr/bin',
    LANG: 'en_US.UTF-8',
    HOME: '/home/operator',
    SIMT_DEV_VAULT_DIR: '/answer/key',
    XDG_CACHE_HOME: '/home/operator/.cache',
    ANTHROPIC_API_KEY: 'adapter-key',
    UNRELATED_SECRET: 'nope',
    NODE_TEST_CONTEXT: 'child-v8',
  };
  const env = agentEnv({ env: ['ANTHROPIC_API_KEY'], isolation: 'env' }, { home: '/slot', base });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.ANTHROPIC_API_KEY, 'adapter-key');
  assert.equal(env.HOME, '/slot');
  assert.equal(env.SIMT_DEV_VAULT_DIR, undefined);
  assert.equal(env.XDG_CACHE_HOME, undefined);
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(env.NODE_TEST_CONTEXT, undefined);
  assert.equal(env.SIMT_DEV_WORKSPACE, 'off');

  assert.equal(adapterIsolation({ isolation: 'env' }), 'env');
  assert.equal(adapterIsolation({ isolation: 'none' }), 'none');
  assert.equal(adapterIsolation({}), 'none');
  assert.equal(adapterIsolation({ isolation: 'imaginary' }), 'none');
});

test('bench brief arm delivers the assembled packet as a prompt prefix, not an unread file', async () => {
  const repo = await scratch('simt-q49-brief-');
  await writeFile(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'brief-fixture', version: '1.0.0', type: 'module' }, null, 2)}\n`,
  );
  await git(['init', '-q', '.'], { cwd: repo });
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-qm', 'chore: base'], { cwd: repo });

  const { promptPrefix } = await materialiseArm(
    repo,
    { name: 'brief' },
    { id: 't-q49', prompt: 'validate slice commit and run focused tests' },
  );
  assert.ok(promptPrefix.length > 0, 'the brief arm produced context');
  assert.match(promptPrefix, /validate slice commit/);
  assert.doesNotMatch(promptPrefix, /# Task Brief/);
  // The old arm wrote a file no harness was told to read; delivering means the bytes
  // travel in the prompt, and nothing is left behind (review 0003 Q49).
  assert.equal(existsSync(join(repo, '.simt', 'local', 'brief.md')), false);
});
